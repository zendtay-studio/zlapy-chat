// El orden de la lista de chats lo manda el SERVIDOR (fijados primero, el más
// recientemente fijado por delante, luego por actividad). Antes lo decidía cada
// cliente con sus datos locales y la lista saltaba al entrar en un chat.
process.env.PROFILE_DESCRIPTION_CHAR_LIMIT = '500';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startServer, stop, api, register } = require('./helpers.js');

/* Cuentas conectadas: ana con beto y con carla. */
async function dosContactos(srv) {
    const ana = await register(srv.base, 'ordena');
    const beto = await register(srv.base, 'ordbeta');
    const carla = await register(srv.base, 'ordcarla');
    await api(srv.base, 'POST', '/contacts', { username: 'ordbeta' }, ana.cookie);
    await api(srv.base, 'POST', '/contacts/respond', { username: 'ordena', accept: true }, beto.cookie);
    await api(srv.base, 'POST', '/contacts', { username: 'ordcarla' }, ana.cookie);
    await api(srv.base, 'POST', '/contacts/respond', { username: 'ordena', accept: true }, carla.cookie);
    return { ana, beto, carla };
}

const lista = async (base, cookie) => {
    const r = await api(base, 'GET', '/chats/summary', undefined, cookie);
    assert.equal(r.status, 200);
    return r.json.chats;
};

test('la lista viene ordenada por el ultimo mensaje de cada chat', async () => {
    const srv = await startServer();
    try {
        const { ana, beto, carla } = await dosContactos(srv);
        // Primero habla con carla, luego con beto: beto queda mas reciente.
        await api(srv.base, 'POST', '/send', { to: 'ordcarla', kind: 'text', data: 'hola carla' }, ana.cookie);
        await new Promise(r => setTimeout(r, 20));
        await api(srv.base, 'POST', '/send', { to: 'ordbeta', kind: 'text', data: 'hola beto' }, ana.cookie);

        const chats = await lista(srv.base, ana.cookie);
        const dm = chats.filter(c => !c.group);
        const nombres = dm.map(c => c.peer);
        assert.equal(nombres[0], 'ordbeta', 'el chat con el mensaje mas reciente va primero');
        assert.ok(nombres.includes('ordcarla'), 'el otro chat sigue en la lista');
    } finally { await stop(srv); }
});

test('leer un chat NO cambia el orden de la lista', async () => {
    const srv = await startServer();
    try {
        const { ana, beto, carla } = await dosContactos(srv);
        await api(srv.base, 'POST', '/send', { to: 'ordcarla', kind: 'text', data: 'hola carla' }, ana.cookie);
        await new Promise(r => setTimeout(r, 20));
        await api(srv.base, 'POST', '/send', { to: 'ordbeta', kind: 'text', data: 'hola beto' }, ana.cookie);

        const antes = (await lista(srv.base, ana.cookie)).map(c => c.peer || c.group);
        // "Entrar" al chat antiguo: beto lee lo que ana le mando y manda
        // recibo de lectura (reescribe el resumen con status/readAt).
        const hist = await api(srv.base, 'POST', '/messages', { to: 'ordena' }, beto.cookie);
        const ids = (hist.json.messages || []).map(m => m.id);
        if (ids.length) await api(srv.base, 'POST', '/receipt', { status: 'read', ids }, beto.cookie);
        // Y ana descarga el historial tambien (como hace el cliente al abrir).
        await api(srv.base, 'POST', '/messages', { to: 'ordbeta' }, ana.cookie);

        const despues = (await lista(srv.base, ana.cookie)).map(c => c.peer || c.group);
        assert.deepEqual(despues, antes,
            'entrar y marcar leido no puede recolocar la lista (regresion del salto al entrar)');
    } finally { await stop(srv); }
});

test('los fijados van primero, el mas reciente por delante', async () => {
    const srv = await startServer();
    try {
        const { ana, beto, carla } = await dosContactos(srv);
        await api(srv.base, 'POST', '/send', { to: 'ordcarla', kind: 'text', data: 'hola carla' }, ana.cookie);
        await new Promise(r => setTimeout(r, 20));
        await api(srv.base, 'POST', '/send', { to: 'ordbeta', kind: 'text', data: 'hola beto' }, ana.cookie);

        // Sin fijos: beto (mas reciente) primero.
        let chats = await lista(srv.base, ana.cookie);
        assert.equal(chats.filter(c => !c.group)[0].peer, 'ordbeta');

        // Fijar a carla (chat mas antiguo): sube al tope.
        await api(srv.base, 'POST', '/chat/preferences', { targets: ['dm:ordcarla'], pinned: true }, ana.cookie);
        await new Promise(r => setTimeout(r, 20));
        chats = await lista(srv.base, ana.cookie);
        assert.equal(chats[0].peer, 'ordcarla', 'el fijado va primero aunque sea mas antiguo');
        assert.equal(chats[0].pinned, true);
        assert.ok(chats[0].pinnedAt > 0, 'la respuesta trae pinnedAt');

        // Fijar a beto despues: queda POR DELANTE de carla (pinned reciente).
        await api(srv.base, 'POST', '/chat/preferences', { targets: ['dm:ordbeta'], pinned: true }, ana.cookie);
        chats = await lista(srv.base, ana.cookie);
        assert.equal(chats[0].peer, 'ordbeta', 'el ultimo fijado va primero');
        assert.equal(chats[1].peer, 'ordcarla');
    } finally { await stop(srv); }
});

test('los grupos se ordenan igual y traen su estado', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ordgrupo');
        const beto = await register(srv.base, 'ordgb');
        const g1 = await api(srv.base, 'POST', '/groups', { name: 'grupo uno', visibility: 'public', joinPolicy: 'open' }, ana.cookie);
        assert.equal(g1.status, 200);
        const g2 = await api(srv.base, 'POST', '/groups', { name: 'grupo dos', visibility: 'public', joinPolicy: 'open' }, ana.cookie);
        const enGrupo = c => api(srv.base, 'POST', '/groups/' + c, { join: true }, beto.cookie);
        await enGrupo(g1.json.id);
        await enGrupo(g2.json.id);

        await api(srv.base, 'POST', '/groups/' + g1.json.id, { message: { kind: 'text', data: 'hola grupo uno' } }, ana.cookie);
        await new Promise(r => setTimeout(r, 20));
        await api(srv.base, 'POST', '/groups/' + g2.json.id, { message: { kind: 'text', data: 'hola grupo dos' } }, ana.cookie);

        const chats = await lista(srv.base, ana.cookie);
        const grupos = chats.filter(c => c.group);
        assert.equal(grupos.length, 2, 'los dos grupos estan en la respuesta');
        assert.equal(grupos[0].group, g2.json.id, 'el grupo con el ultimo mensaje va primero');
        assert.equal(grupos[0].groupName, 'grupo dos');
        assert.ok(grupos[0].last && grupos[0].last.ts > 0, 'trae el ultimo mensaje');
        assert.equal(grupos[0].pinned, false);
        assert.equal(grupos[0].archived, false);

        // Fijar el grupo antiguo: sube al tope de TODO (DMs incluidos).
        await api(srv.base, 'POST', '/chat/preferences', { targets: ['group:' + g1.json.id], pinned: true }, beto.cookie);
        const chatsBeto = await lista(srv.base, beto.cookie);
        assert.equal(chatsBeto[0].group, g1.json.id, 'el grupo fijado va primero');
    } finally { await stop(srv); }
});

test('dos peticiones seguidas devuelven el mismo orden (idempotente)', async () => {
    const srv = await startServer();
    try {
        const { ana } = await dosContactos(srv);
        await api(srv.base, 'POST', '/send', { to: 'ordcarla', kind: 'text', data: 'hola carla' }, ana.cookie);
        const uno = (await lista(srv.base, ana.cookie)).map(c => c.peer || c.group);
        const dos = (await lista(srv.base, ana.cookie)).map(c => c.peer || c.group);
        assert.deepEqual(dos, uno);
    } finally { await stop(srv); }
});
