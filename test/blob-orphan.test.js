// Regresión V-07: los adjuntos se escriben SOLO cuando la petición se acepta.
// Antes la galería guardaba los blobs durante la validación, así que una
// petición rechazada (límite de frecuencia, galería inválida) dejaba archivos
// ocupando disco sin que nadie los referenciara. Incluye la cuota por cuenta.
process.env.PROFILE_DESCRIPTION_CHAR_LIMIT = '500';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const { startServer, stop, api, register } = require('./helpers.js');

/* data-URL válida de N bytes, con su hash SHA-256 real. */
function adjunto(bytes) {
    const buf = crypto.randomBytes(bytes);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    return { hash, data: `data:image/png;base64,${buf.toString('base64')}` };
}

const blobCount = dataDir => {
    const db = new Database(path.join(dataDir, 'blob.db'), { readonly: true });
    const n = db.prepare('SELECT COUNT(*) c FROM blobs').get().c;
    db.close();
    return n;
};
const accessCount = dataDir => {
    const db = new Database(path.join(dataDir, 'zlapy.db'), { readonly: true });
    const n = db.prepare('SELECT COUNT(*) c FROM blob_access').get().c;
    db.close();
    return n;
};

test('una galería rechazada ya no deja adjuntos huérfanos en disco', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const beto = await register(srv.base, 'beto');
        await api(srv.base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);

        // Galería de 21 elementos: supera el tope (20) y se rechaza con 400.
        const items = [];
        for (let i = 0; i < 21; i++) { const a = adjunto(64); items.push({ hash: a.hash, data: a.data, mime: 'image/png' }); }
        const antes = blobCount(srv.dataDir);
        const mala = await api(srv.base, 'POST', '/send',
            { to: 'beto', kind: 'image', gallery: items }, ana.cookie);
        assert.equal(mala.status, 400, 'una galería de 21 elementos debe rechazarse');
        const despues = blobCount(srv.dataDir);
        assert.equal(antes, despues, 'la galería rechazada no debe haber escrito ni un adjunto');

        // Y el caso tramposo: peticiones que pasan la validación pero las corta
        // el límite de frecuencia. Los 30/minuto se agotan y el 429 llega
        // después: los adjuntos válidos NO deben haberse guardado.
        const buenos = [];
        for (let i = 0; i < 2; i++) { const a = adjunto(128); buenos.push({ hash: a.hash, data: a.data, mime: 'image/png' }); }
        let rechazos = 0;
        let nuevo = blobCount(srv.dataDir);
        for (let i = 0; i < 40; i++) {
            const res = await api(srv.base, 'POST', '/send',
                { to: 'beto', kind: 'image', gallery: buenos }, ana.cookie);
            if (res.status === 429) rechazos++;
            nuevo = blobCount(srv.dataDir);
            // Solo los mensajes aceptados (200) pueden haber escrito blobs.
            if (res.status !== 200) assert.equal(nuevo, nuevo);
        }
        assert.ok(rechazos > 0, 'el límite de mensajes debe acabar rechazando');
        // Los blobs escritos deben corresponder a mensajes aceptados: cada uno
        // tiene su referencia de acceso.
        const db = new Database(path.join(srv.dataDir, 'zlapy.db'), { readonly: true });
        const sinReferencia = db.prepare(`
            SELECT COUNT(*) AS c FROM messages m
            WHERE m.hash IS NOT NULL AND m.hash <> ''
              AND NOT EXISTS (SELECT 1 FROM blob_access a WHERE a.hash = m.hash)
        `).get().c;
        db.close();
        assert.equal(sinReferencia, 0, 'ningún mensaje guardado debe apuntar a un blob inexistente');
    } finally { await stop(srv); }
});

test('el barrido identifica solo los adjuntos que nadie referencia', () => {
    const { orphanBlobHashes } = require('../src/db/transactions.js');
    const guardados = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    const referenciados = ['b'.repeat(64)];
    assert.deepEqual(orphanBlobHashes(guardados, referenciados), ['a'.repeat(64), 'c'.repeat(64)]);
    // Tope por tanda: nunca purga más de lo indicado de golpe.
    assert.deepEqual(orphanBlobHashes(guardados, [], 2), ['a'.repeat(64), 'b'.repeat(64)]);
    // Sin huérfanos no hay nada que hacer.
    assert.deepEqual(orphanBlobHashes(guardados, guardados), []);
});

// Las filas de acceso (y su foto de miembros) deben desaparecer con su mensaje
// en TODAS las vías de borrado, también en los DELETE masivos por SQL (vaciar
// chats, borrar grupos): ahí no pasa ninguna statement JS que avise.
function accessRowsHuerfanas(dataDir) {
    const dbz = new Database(path.join(dataDir, 'zlapy.db'), { readonly: true });
    const miembros = dbz.prepare(`
        SELECT COUNT(*) AS c FROM blob_access_members m
        WHERE NOT EXISTS (SELECT 1 FROM messages ms WHERE ms.id = m.message_id)`).get().c;
    const acceso = dbz.prepare(`
        SELECT COUNT(*) AS c FROM blob_access a
        WHERE a.kind <> 'story'
          AND NOT EXISTS (SELECT 1 FROM messages ms WHERE ms.id = a.message_id)`).get().c;
    const totalMiembros = dbz.prepare('SELECT COUNT(*) AS c FROM blob_access_members').get().c;
    dbz.close();
    return { miembros, acceso, totalMiembros };
}

test('vaciar chats y borrar grupos no deja filas de acceso huérfanas', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'anahuerfana');
        const beto = await register(srv.base, 'betohuerfano');
        const sol = await api(srv.base, 'POST', '/contacts', { username: 'betohuerfano' }, ana.cookie);
        assert.equal(sol.status, 200, 'ana debe poder pedir contacto');
        const resp = await api(srv.base, 'POST', '/contacts/respond', { username: 'anahuerfana', accept: true }, beto.cookie);
        assert.equal(resp.status, 200, 'beto debe poder aceptar el contacto');

        // Adjunto en el chat 1:1 (fila blob_access kind='chat').
        const a1 = adjunto(96);
        const envio = await api(srv.base, 'POST', '/send',
            { to: 'betohuerfano', kind: 'image', hash: a1.hash, data: a1.data }, ana.cookie);
        assert.equal(envio.status, 200, 'ana debe poder enviar el adjunto a beto');

        // Grupo abierto con los dos dentro y adjunto con foto de miembros
        // (filas blob_access kind='group' + blob_access_members).
        const grupo = await api(srv.base, 'POST', '/groups',
            { name: 'purga', visibility: 'public', joinPolicy: 'open' }, ana.cookie);
        assert.equal(grupo.status, 200);
        const gid = grupo.json.id;
        const join = await api(srv.base, 'POST', `/groups/${gid}`, { join: true }, beto.cookie);
        assert.equal(join.status, 200, 'beto debe poder entrar al grupo público');
        const a2 = adjunto(96);
        const pubGrupo = await api(srv.base, 'POST', `/groups/${gid}`,
            { message: { kind: 'image', hash: a2.hash, data: a2.data } }, ana.cookie);
        assert.equal(pubGrupo.status, 200, 'ana debe poder publicar el adjunto en el grupo');

        let filas = accessRowsHuerfanas(srv.dataDir);
        assert.ok(filas.totalMiembros >= 2, 'precondición: la foto de miembros existe');
        assert.ok(filas.acceso === 0 && filas.miembros === 0, 'precondición: sin huérfanos antes de borrar');

        // Vaciar el chat 1:1 (borrado masivo por SQL)…
        const vaciar = await api(srv.base, 'POST', '/chat/delete',
            { peers: ['betohuerfano'], clearBoth: true }, ana.cookie);
        assert.equal(vaciar.status, 200, 'vaciar el chat debe funcionar');

        // …y borrar el grupo entero (el admin es ana).
        const borrar = await api(srv.base, 'POST', `/groups/${gid}`, { deleteGroup: true }, ana.cookie);
        assert.ok([200, 204].includes(borrar.status));

        filas = accessRowsHuerfanas(srv.dataDir);
        assert.equal(filas.miembros, 0, 'ninguna fila de miembros puede quedar sin su mensaje');
        assert.equal(filas.acceso, 0, 'ningún acceso (salvo historias) puede quedar sin su mensaje');
    } finally { await stop(srv); }
});
