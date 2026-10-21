// Regresión: el canal de tiempo real (WebSocket) también acepta campos del
// perfil (nombre, nota y descripción). Si el cliente devuelve un texto que ya
// venía cifrado —porque el servidor se lo pintó así— el servidor debe
// conservarlo tal cual, sin volverlo a cifrar: si no, el texto original
// quedaría destruido para siempre.
//
// Aquí el límite de descripción es amplio (300), como en la configuración de
// producción: el sobre cifrado (~160 caracteres) cabe de sobra y antes de
// arreglarlo el servidor lo guardaba TAL CUAL, cifrado dos veces.
process.env.PROFILE_DESCRIPTION_CHAR_LIMIT = '300';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, stop, api, register, WsClient } = require('./helpers.js');

test('por WebSocket no se guarda un texto que vuelve cifrado', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const ws = new WsClient(srv.port, ana.cookie);
        await ws.connect();

        // El cliente guarda su perfil por el canal de tiempo real (el mismo
        // mensaje que transporta la matriz de privacidad).
        ws.send({ type: 'privacy', name: 'Nombre Real', desc: 'Hola' });
        await new Promise(r => setTimeout(r, 400));

        const raw = new Database(path.join(srv.dataDir, 'zlapy.db'), { readonly: true });
        const row = raw.prepare("SELECT bio FROM user_profiles WHERE bio LIKE 'PCE%'").get();
        raw.close();
        assert.ok(row && row.bio.startsWith('PCE'), 'la descripcion debe estar cifrada en disco');

        // El cliente le devuelve el texto cifrado: el servidor lo descarta.
        ws.send({ type: 'privacy', desc: row.bio });
        await new Promise(r => setTimeout(r, 400));
        ws.destroy();

        const profile = await api(srv.base, 'GET', '/profile?username=ana&me=ana', null, ana.cookie);
        assert.equal(profile.json.desc, 'Hola', 'no debe sobrescribirse la descripcion con un texto cifrado');
        assert.equal(profile.json.name, 'Nombre Real', 'no debe tocarse el nombre');
    } finally { await stop(srv); }
});
