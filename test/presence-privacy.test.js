// Privacidad de la presencia («en línea» / última vez visto).
//
// Desde v9 la presencia es un ajuste de privacidad más ('online'), con los
// mismos cinco modos que la foto: Todos / Contactos / Nadie / Solo… /
// Excepto…. La regla decide QUIÉN ve `online` y `lastSeen` en:
//   · GET /profile?username=…  (perfil del otro)
//   · GET /users               (lista de contactos con presencia)
// Sin permiso los campos NO viajan (el cliente pinta «Presencia no
// disponible» y nada delata la última conexión). Uno mismo siempre ve la
// propia presencia. El bloqueo siempre gana a la regla.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startServer, stop, api, register } = require('./helpers.js');

/* Registra y devuelve { status, json, cookie, id, username }. */
async function account(base, username) {
    const r = await register(base, username);
    r.id = r.json.user.id;
    r.username = r.json.user.username;
    return r;
}

/* ana y beto se hacen contactos (solicitud + aceptación). */
async function makeContacts(base, from, to) {
    await api(base, 'POST', '/contacts', { username: to.username }, from.cookie);
    await api(base, 'POST', '/contacts/respond', { username: from.username, accept: true }, to.cookie);
}

/* Ajusta la privacidad de presencia de `owner` conservando el resto. */
async function setOnlinePrivacy(base, owner, mode, users = []) {
    const self = await api(base, 'GET', `/profile?username=${owner.username}&me=${owner.username}`, null, owner.cookie);
    const privacy = { ...(self.json.privacy || {}), online: { mode, users } };
    const saved = await api(base, 'POST', '/profile', { username: owner.username, privacy }, owner.cookie);
    assert.equal(saved.status, 200, 'la privacidad de presencia se guarda');
}

const viewPresence = (base, viewer, target) =>
    api(base, 'GET', `/profile?username=${target.username}&me=${viewer.username}`, null, viewer.cookie);

test('por defecto solo los contactos ven la presencia (y lastSeen viaja con ella)', async () => {
    const srv = await startServer();
    try {
        const ana = await account(srv.base, 'ana');
        const beto = await account(srv.base, 'beto');
        const caro = await account(srv.base, 'caro');
        await makeContacts(srv.base, ana, beto);

        const propia = await viewPresence(srv.base, ana, ana);
        assert.equal(propia.json.online, false, 'uno mismo siempre ve su presencia');

        const contacto = await viewPresence(srv.base, beto, ana);
        assert.ok('online' in contacto.json, 'el contacto recibe online');
        assert.ok('lastSeen' in contacto.json, 'el contacto recibe lastSeen');

        const ajeno = await viewPresence(srv.base, caro, ana);
        assert.ok(!('online' in ajeno.json), 'un no-contacto no recibe online');
        assert.ok(!('lastSeen' in ajeno.json), 'un no-contacto no recibe lastSeen');

        // La lista de contactos también respeta la regla.
        const lista = await api(srv.base, 'GET', '/users', null, beto.cookie);
        const anaEntry = lista.json.users.find(u => u.username === 'ana');
        assert.ok('online' in anaEntry, 'el contacto ve la presencia en /users');
        const listaCaro = await api(srv.base, 'GET', '/users', null, caro.cookie);
        assert.ok(!listaCaro.json.users.some(u => u.username === 'ana'),
            'un no-contacto no aparece en la lista de contactos (no hay fuga)');
    } finally { await stop(srv); }
});

test('modo «Todos»: cualquier cuenta del servidor ve la presencia', async () => {
    const srv = await startServer();
    try {
        const ana = await account(srv.base, 'ana');
        const beto = await account(srv.base, 'beto');
        const caro = await account(srv.base, 'caro');
        await makeContacts(srv.base, ana, beto);
        await setOnlinePrivacy(srv.base, ana, 'server');

        const ajeno = await viewPresence(srv.base, caro, ana);
        assert.ok('online' in ajeno.json, 'un no-contacto ve la presencia con modo Todos');
        assert.ok('lastSeen' in ajeno.json, 'lastSeen viaja con el modo Todos');

        // También en la lista del contacto.
        const lista = await api(srv.base, 'GET', '/users', null, beto.cookie);
        assert.ok('online' in lista.json.users.find(u => u.username === 'ana'));
    } finally { await stop(srv); }
});

test('modo «Nadie»: ni los contactos ven la presencia', async () => {
    const srv = await startServer();
    try {
        const ana = await account(srv.base, 'ana');
        const beto = await account(srv.base, 'beto');
        await makeContacts(srv.base, ana, beto);
        await setOnlinePrivacy(srv.base, ana, 'nobody');

        const contacto = await viewPresence(srv.base, beto, ana);
        assert.ok(!('online' in contacto.json), 'el contacto NO recibe online');
        assert.ok(!('lastSeen' in contacto.json), 'el contacto NO recibe lastSeen');

        const propia = await viewPresence(srv.base, ana, ana);
        assert.ok('online' in propia.json, 'uno mismo sigue viendo su presencia');

        const lista = await api(srv.base, 'GET', '/users', null, beto.cookie);
        assert.ok(!('online' in lista.json.users.find(u => u.username === 'ana')),
            'la lista /users tampoco la entrega');
    } finally { await stop(srv); }
});

test('modo «Solo…»: solo el contacto elegido ve la presencia', async () => {
    const srv = await startServer();
    try {
        const ana = await account(srv.base, 'ana');
        const beto = await account(srv.base, 'beto');
        const caro = await account(srv.base, 'caro');
        await makeContacts(srv.base, ana, beto);
        await makeContacts(srv.base, ana, caro);
        await setOnlinePrivacy(srv.base, ana, 'only', ['beto']);

        const elegido = await viewPresence(srv.base, beto, ana);
        assert.ok('online' in elegido.json, 'el contacto elegido recibe la presencia');

        const resto = await viewPresence(srv.base, caro, ana);
        assert.ok(!('online' in resto.json), 'el otro contacto no la recibe');

        const listaBeto = await api(srv.base, 'GET', '/users', null, beto.cookie);
        assert.ok('online' in listaBeto.json.users.find(u => u.username === 'ana'));
        const listaCaro = await api(srv.base, 'GET', '/users', null, caro.cookie);
        assert.ok(!('online' in listaCaro.json.users.find(u => u.username === 'ana')));
    } finally { await stop(srv); }
});

test('modo «Excepto…»: todos los contactos menos el excluido', async () => {
    const srv = await startServer();
    try {
        const ana = await account(srv.base, 'ana');
        const beto = await account(srv.base, 'beto');
        const caro = await account(srv.base, 'caro');
        await makeContacts(srv.base, ana, beto);
        await makeContacts(srv.base, ana, caro);
        await setOnlinePrivacy(srv.base, ana, 'except', ['caro']);

        const dentro = await viewPresence(srv.base, beto, ana);
        assert.ok('online' in dentro.json, 'el contacto no excluido la ve');

        const fuera = await viewPresence(srv.base, caro, ana);
        assert.ok(!('online' in fuera.json), 'el contacto excluido NO la ve');
        assert.ok(!('lastSeen' in fuera.json), 'tampoco lastSeen');
    } finally { await stop(srv); }
});

test('el bloqueo gana: quien bloqueó a alguien no le entrega presencia ni con «Todos»', async () => {
    const srv = await startServer();
    try {
        const ana = await account(srv.base, 'ana');
        const beto = await account(srv.base, 'beto');
        await makeContacts(srv.base, ana, beto);
        await setOnlinePrivacy(srv.base, ana, 'server');
        // ana bloquea a beto
        await api(srv.base, 'POST', '/block', { target: 'beto' }, ana.cookie);

        const bloqueado = await viewPresence(srv.base, beto, ana);
        assert.ok(!('online' in bloqueado.json), 'el bloqueado no recibe la presencia');
    } finally { await stop(srv); }
});

test('la regla de presencia se guarda en la base y sobrevive al reinicio', async () => {
    const dataDir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'zlapy-presencia-'));
    const srv1 = await startServer({ dataDir });
    let ana;
    try {
        ana = await account(srv1.base, 'ana');
        await setOnlinePrivacy(srv1.base, ana, 'nobody');
    } finally { await stop(srv1); }

    const srv2 = await startServer({ dataDir });
    try {
        const beto = await account(srv2.base, 'beto');
        await makeContacts(srv2.base, ana, beto);
        const vista = await viewPresence(srv2.base, beto, ana);
        assert.ok(!('online' in vista.json), 'la regla «Nadie» sigue vigente tras reiniciar');
    } finally { await stop(srv2); }
});
