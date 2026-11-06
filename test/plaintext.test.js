// Ningún dato de usuario debe quedar en TEXTO PLANO en el fichero de la base.
//
// Este test lee los BYTES CRUDOS de `zlapy.db` y de `blob.db` (con el
// servidor parado, para que no haya nada a medias en el WAL) y falla si
// encuentra textos que deberían estar cifrados: la foto de perfil, el fondo
// del chat, los colores de la apariencia, el nombre de un grupo, su código de
// invitación, el nombre de un par silenciado…
//
// Lo que SÍ queda en claro (y por diseño) son el nombre de usuario (es el
// login), los identificadores, los tiempos y los hashes de los adjuntos.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { startServer, stop, api, register } = require('./helpers.js');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/* Marca única: si aparece en los bytes de la base, está en claro. */
const MARCA = 'marca-unica-9f3c2a7b';

function bytesDeBase(dataDir, nombre) {
    const ruta = path.join(dataDir, nombre);
    if (!fs.existsSync(ruta)) return Buffer.alloc(0);
    return fs.readFileSync(ruta);
}

/* Todos los ficheros de la base: la principal y los del WAL (por si el
   servidor no llegó a consolidarlos). */
function ficherosDeBase(dataDir) {
    return ['zlapy.db', 'zlapy.db-wal', 'blob.db', 'blob.db-wal'];
}

test('nada de lo sensible queda en claro en el fichero de la base', async t => {
    // Directorio propio: el helper NO lo borra al parar (los bytes se
    // comprueban después).
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-plano-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const srv = await startServer({ dataDir });
    let grupoId = '';
    try {
        const ana = await register(srv.base, 'ana');
        const beto = await register(srv.base, 'beto');
        await api(srv.base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);

        // Foto de perfil, fondo y colores de la apariencia.
        const perfil = await api(srv.base, 'POST', '/profile', {
            name: `Nombre ${MARCA}`,
            desc: `Bio ${MARCA}`,
            avatar: PNG,
            chatAppearance: {
                wall: '#123456',
                sender: '#234567',
                receiver: '#345678',
                senderText: '#456789',
                receiverText: '#56789a',
                image: PNG,
                opacity: 30,
                blur: 0,
                fontSize: 15
            }
        }, ana.cookie);
        assert.equal(perfil.status, 200, JSON.stringify(perfil.json));

        // Grupo con nombre, descripción y avatar propios.
        const grupo = await api(srv.base, 'POST', '/groups', {
            name: `Grupo ${MARCA}`,
            description: `Descripcion ${MARCA}`,
            avatar: PNG
        }, ana.cookie);
        assert.equal(grupo.status, 200, JSON.stringify(grupo.json));
        grupoId = grupo.json.id;

        // Silenciar al otro: el nombre del par también va cifrado.
        await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'hola' }, ana.cookie);
        const prefs = await api(srv.base, 'POST', '/chat/prefs', { chat: 'beto', muted: true }, ana.cookie);
        assert.ok(prefs.status === 200 || prefs.status === 404, JSON.stringify(prefs.json));
    } finally {
        await stop(srv);
    }

    // Con el servidor parado, los ficheros están consolidados.
    assert.ok(bytesDeBase(srv.dataDir, 'zlapy.db').length > 0, 'la base debe existir');

    for (const nombre of ficherosDeBase(srv.dataDir)) {
        const texto = bytesDeBase(srv.dataDir, nombre).toString('latin1');
        assert.equal(texto.includes(MARCA), false,
            `la marca "${MARCA}" aparece en ${nombre}: hay texto en claro`);
        // La foto de perfil y el fondo (data-URL) tampoco pueden estar sueltos.
        assert.equal(texto.includes('data:image/png;base64,iVBORw0KGgo'), false,
            `hay una data-URL de imagen sin cifrar en ${nombre}`);
    }

    // Y las columnas que guardan esos datos están cifradas (o son una ref).
    const Database = require('better-sqlite3');
    const db = new Database(path.join(srv.dataDir, 'zlapy.db'), { readonly: true });
    const perfil = db.prepare('SELECT display_name, avatar_ref FROM user_profiles WHERE user_id = (SELECT id FROM users WHERE username = ?)').get('ana');
    assert.ok(perfil, 'debe existir el perfil');
    assert.match(perfil.display_name, /^PCE3:/, 'el nombre visible va cifrado con la clave del usuario');
    assert.match(perfil.avatar_ref, /^[a-f0-9]{64}$/, 'la foto es una referencia al blob cifrado');
    const grupoFila = db.prepare('SELECT name, description, invite_code FROM groups WHERE id = ?').get(grupoId);
    assert.match(grupoFila.name, /^PCE1v2:/, 'el nombre del grupo va cifrado');
    assert.match(grupoFila.description, /^PCE1v2:/, 'la descripción del grupo va cifrada');
    assert.match(grupoFila.invite_code, /^PCE1v2:/, 'el código de invitación va cifrado');
    const ajustes = db.prepare('SELECT wall, sender, receiver FROM user_chat_settings WHERE user_id = (SELECT id FROM users WHERE username = ?)').get('ana');
    assert.match(ajustes.wall, /^PCE1v2:/, 'los colores de la apariencia van cifrados');
    db.close();
});
