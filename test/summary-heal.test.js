// Regresión: al regenerar la clave de cifrado, los RESÚMENES (y el resto de
// tablas del usuario) se re-cifran con la clave ANTERIOR. La rotación instalaba
// la nueva y luego usaba `decryptForUser`, que ya solo conocía la nueva: esas
// filas quedaban cifradas con la clave vieja PARA SIEMPRE. Síntoma en la app:
// la lista de contactos salía sin vista previa y el chat al fondo (orden por
// actividad roto), mientras los grupos —que se reescribían al llegar mensajes—
// sí funcionaban. El resumen es una caché, así que además se reconstruye desde
// el último mensaje cuando su copia cifrada quedó ilegible.
process.env.PROFILE_DESCRIPTION_CHAR_LIMIT = '500';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const path = require('node:path');
const { startServer, stop, api, register } = require('./helpers.js');

const dbOf = srv => new Database(path.join(srv.dataDir, 'zlapy.db'), { readonly: true });

async function pareja(srv, a, b) {
    const uno = await register(srv.base, a);
    const dos = await register(srv.base, b);
    await api(srv.base, 'POST', '/contacts', { username: b }, uno.cookie);
    await api(srv.base, 'POST', '/contacts/respond', { username: a, accept: true }, dos.cookie);
    return { uno, dos };
}

test('rotar la clave deja los resúmenes legibles (antes quedaban ilegibles)', async () => {
    const srv = await startServer();
    try {
        const { uno, dos } = await pareja(srv, 'rotsum1', 'rotsum2');
        const envio = await api(srv.base, 'POST', '/send', { to: 'rotsum2', kind: 'text', data: 'mensaje con resumen' }, uno.cookie);
        assert.equal(envio.status, 200);

        // El resumen existe y se lee ANTES de rotar.
        let lista = await api(srv.base, 'GET', '/chats/summary', undefined, uno.cookie);
        let dm = lista.json.chats.filter(c => !c.group)[0];
        assert.ok(dm && dm.last && dm.last.text === 'mensaje con resumen', 'el resumen se lee antes de rotar');

        // Rotación (con contraseña, como pide el servidor).
        const regen = await api(srv.base, 'POST', '/account/regenerate-key', { password: 'pruebachat1' }, uno.cookie);
        assert.equal(regen.status, 200);

        // Y SIGUE leyéndose después: es la regresión exacta del fallo.
        lista = await api(srv.base, 'GET', '/chats/summary', undefined, uno.cookie);
        dm = lista.json.chats.filter(c => !c.group)[0];
        assert.ok(dm, 'el chat sigue en la lista');
        assert.ok(dm.last, 'el último mensaje sigue en el resumen tras rotar la clave');
        assert.equal(dm.last.text, 'mensaje con resumen');
        assert.ok(dm.last.ts > 0, 'y conserva su fecha (el orden por actividad funciona)');

        // El historial también, para no perder nada por el camino.
        const hist = await api(srv.base, 'POST', '/messages', { to: 'rotsum1' }, dos.cookie);
        assert.ok((hist.json.messages || []).some(m => m.data === 'mensaje con resumen'),
            'el mensaje sigue visible tras regenerar la clave');
    } finally { await stop(srv); }
});

test('un resumen ilegible se reconstruye desde los mensajes', async () => {
    const srv = await startServer();
    try {
        const { uno } = await pareja(srv, 'healsum1', 'healsum2');
        const envio = await api(srv.base, 'POST', '/send', { to: 'healsum2', kind: 'text', data: 'mensaje recuperable' }, uno.cookie);
        assert.equal(envio.status, 200);
        const idMensaje = envio.json.message && envio.json.message.id;

        // Se envenena la copia del resumen: un blob PCE3 que no descifra con
        // ninguna clave (como quedaban las filas tras el fallo de la rotación).
        const db = new Database(path.join(srv.dataDir, 'zlapy.db'));
        db.prepare('UPDATE summaries SET last_data = ? WHERE owner = (SELECT id FROM users WHERE username = ?)')
            .run('PCE3:' + 'ab'.repeat(48), 'healsum1');
        db.close();

        // Sin arreglo: el chat saldría sin vista previa y al fondo de la lista.
        const lista = await api(srv.base, 'GET', '/chats/summary', undefined, uno.cookie);
        const dm = lista.json.chats.filter(c => !c.group)[0];
        assert.ok(dm && dm.last, 'el resumen se reconstruye aunque su copia esté ilegible');
        assert.equal(dm.last.text, 'mensaje recuperable');
        assert.equal(dm.last.id, idMensaje, 'reconstruido desde el propio último mensaje');

        // Y queda reescrito: la siguiente lectura ya no tiene que sanarlo.
        const db2 = dbOf(srv);
        const guardado = db2.prepare('SELECT last_data FROM summaries WHERE owner = (SELECT id FROM users WHERE username = ?)').get('healsum1');
        db2.close();
        assert.ok(!String(guardado.last_data).startsWith('PCE3:abab'), 'el resumen quedó reescrito cifrado de verdad');
    } finally { await stop(srv); }
});

test('un grupo sin resumen legible también se reconstruye', async () => {
    const srv = await startServer();
    try {
        const uno = await register(srv.base, 'healg1');
        const dos = await register(srv.base, 'healg2');
        const grupo = await api(srv.base, 'POST', '/groups', { name: 'sanador', visibility: 'public', joinPolicy: 'open' }, uno.cookie);
        const gid = grupo.json.id;
        assert.equal((await api(srv.base, 'POST', `/groups/${gid}`, { join: true }, dos.cookie)).status, 200);
        await api(srv.base, 'POST', `/groups/${gid}`, { message: { kind: 'text', data: 'hola grupo' } }, uno.cookie);

        const db = new Database(path.join(srv.dataDir, 'zlapy.db'));
        db.prepare('UPDATE group_summaries SET last_data = ? WHERE gid = ?').run('PCE3:' + 'cd'.repeat(48), gid);
        db.close();

        const lista = await api(srv.base, 'GET', '/chats/summary', undefined, dos.cookie);
        const g = lista.json.chats.find(c => c.group === gid);
        assert.ok(g && g.last, 'el resumen del grupo se reconstruye');
        assert.equal(g.last.text, 'hola grupo');
    } finally { await stop(srv); }
});
