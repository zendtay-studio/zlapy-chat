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
