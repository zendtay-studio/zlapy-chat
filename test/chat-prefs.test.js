// Preferencias de la lista de chats (fijado, silencio, no leído) en el
// servidor y citas de respuesta resueltas por ID (la vista previa se
// actualiza al editar y desaparece al borrar).
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startServer, stop, api, register } = require('./helpers.js');

async function contactPair(base) {
    const ana = await register(base, 'ana');
    const beto = await register(base, 'beto');
    await api(base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
    await api(base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);
    return { ana, beto };
}

test('las preferencias de la lista de chats se guardan en el servidor y se recuperan', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await contactPair(srv.base);

        const initial = await api(srv.base, 'GET', '/chat/preferences', null, ana.cookie);
        assert.equal(initial.status, 200);
        assert.deepEqual(initial.json.prefs, {});

        const pinned = await api(srv.base, 'POST', '/chat/preferences', { targets: ['dm:beto'], pinned: true }, ana.cookie);
        assert.equal(pinned.status, 200);
        assert.equal(pinned.json.prefs['dm:beto'].pinned, true);

        // Cambia en "otro dispositivo": es la misma cuenta, así que lo ve.
        const other = await api(srv.base, 'GET', '/chat/preferences', null, ana.cookie);
        assert.equal(other.json.prefs['dm:beto'].pinned, true);

        // Otra cuenta no ve las preferencias de la primera.
        const foreign = await api(srv.base, 'GET', '/chat/preferences', null, beto.cookie);
        assert.equal(foreign.json.prefs['dm:beto'], undefined);
    } finally { await stop(srv); }
});

test('silenciar y marcar como no leído también viven en el servidor', async () => {
    const srv = await startServer();
    try {
        const { ana } = await contactPair(srv.base);
        const res = await api(srv.base, 'POST', '/chat/preferences', {
            targets: ['dm:beto'], muted: true, unread: true
        }, ana.cookie);
        assert.equal(res.status, 200);
        assert.equal(res.json.prefs['dm:beto'].muted, true);
        assert.equal(res.json.prefs['dm:beto'].unread, true);
        assert.ok(res.json.mutedPeers.includes('beto'));

        const read = await api(srv.base, 'GET', '/chat/preferences', null, ana.cookie);
        assert.equal(read.json.prefs['dm:beto'].muted, true);
    } finally { await stop(srv); }
});

test('un destino inválido no aplica NADA del bloque (todo o nada)', async () => {
    const srv = await startServer();
    try {
        const { ana } = await contactPair(srv.base);
        const res = await api(srv.base, 'POST', '/chat/preferences', {
            targets: ['dm:beto', 'dm:fantasma'], pinned: true
        }, ana.cookie);
        assert.equal(res.status, 400);
        const prefs = await api(srv.base, 'GET', '/chat/preferences', null, ana.cookie);
        assert.deepEqual(prefs.json.prefs, {}, 'no debe quedar nada aplicado');
    } finally { await stop(srv); }
});

test('no se pueden tocar conversaciones ajenas', async () => {
    const srv = await startServer();
    try {
        const { ana } = await contactPair(srv.base);
        const caro = await register(srv.base, 'caro');
        // caro no es contacto de ana: no puede fijarlo ni silenciarlo.
        const res = await api(srv.base, 'POST', '/chat/preferences', { targets: ['dm:ana'], pinned: true }, caro.cookie);
        assert.equal(res.status, 400);
        const prefs = await api(srv.base, 'GET', '/chat/preferences', null, caro.cookie);
        assert.deepEqual(prefs.json.prefs, {});
        // ana sí puede con beto.
        const ok = await api(srv.base, 'POST', '/chat/preferences', { targets: ['dm:beto'], pinned: true }, ana.cookie);
        assert.equal(ok.status, 200);
    } finally { await stop(srv); }
});

test('los grupos se pueden fijar y silenciar como cualquier chat', async () => {
    const srv = await startServer();
    try {
        const { ana } = await contactPair(srv.base);
        const group = await api(srv.base, 'POST', '/groups', { name: 'Equipo', visibility: 'public', joinPolicy: 'request' }, ana.cookie);
        assert.equal(group.status, 200);
        const gid = group.json.id;
        const res = await api(srv.base, 'POST', '/chat/preferences', { targets: ['group:' + gid], pinned: true, muted: true }, ana.cookie);
        assert.equal(res.status, 200);
        assert.equal(res.json.prefs['group:' + gid].pinned, true);
        assert.equal(res.json.prefs['group:' + gid].muted, true);
    } finally { await stop(srv); }
});

test('archivar un chat es una preferencia del servidor y se puede deshacer', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await contactPair(srv.base);
        const archived = await api(srv.base, 'POST', '/chat/preferences', { targets: ['dm:beto'], archived: true }, ana.cookie);
        assert.equal(archived.status, 200);
        assert.equal(archived.json.prefs['dm:beto'].archived, true);

        const read = await api(srv.base, 'GET', '/chat/preferences', null, ana.cookie);
        assert.equal(read.json.prefs['dm:beto'].archived, true, 'el chat archivado sigue archivado en el servidor');

        const back = await api(srv.base, 'POST', '/chat/preferences', { targets: ['dm:beto'], archived: false }, ana.cookie);
        assert.equal(back.status, 200);
        const after = await api(srv.base, 'GET', '/chat/preferences', null, ana.cookie);
        assert.equal(after.json.prefs['dm:beto'], undefined, 'al desarchivar desaparece la preferencia');
    } finally { await stop(srv); }
});

test('borrar varios chats de golpe es una sola operación', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await contactPair(srv.base);
        await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'hola' }, ana.cookie);
        const summary = await api(srv.base, 'GET', '/chats/summary', null, ana.cookie);
        assert.equal(summary.json.chats.length, 1);

        const del = await api(srv.base, 'POST', '/chat/delete', { peers: ['beto'] }, ana.cookie);
        assert.equal(del.status, 200);
        assert.deepEqual(del.json.deleted, ['beto']);
        const after = await api(srv.base, 'GET', '/chats/summary', null, ana.cookie);
        assert.equal(after.json.chats.length, 0, 'el chat borrado no debe seguir en la lista');

        // Un destino inválido no borra ninguno.
        await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'otra vez' }, ana.cookie);
        const bad = await api(srv.base, 'POST', '/chat/delete', { peers: ['beto', 'fantasma'] }, ana.cookie);
        assert.equal(bad.status, 404);
        const still = await api(srv.base, 'GET', '/chats/summary', null, ana.cookie);
        assert.equal(still.json.chats.length, 1, 'el bloque inválido no debe borrar nada');
    } finally { await stop(srv); }
});

test('la cita de respuesta se resuelve por ID: al editar cambia y al borrar desaparece', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await contactPair(srv.base);
        const original = await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'texto original' }, ana.cookie);
        assert.equal(original.json.ok, true);
        const originalId = original.json.message.id;

        // La cita solo lleva el ID: el servidor lo resuelve contra el mensaje real.
        const reply = await api(srv.base, 'POST', '/send', {
            to: 'beto', kind: 'text', data: 'y mi respuesta', reply: { id: originalId, preview: 'texto mentiroso' }
        }, ana.cookie);
        assert.equal(reply.json.ok, true);

        let page = await api(srv.base, 'POST', '/messages', { to: 'beto', limit: 20 }, ana.cookie);
        let replyMsg = page.json.messages.find(m => m.id === reply.json.message.id);
        assert.equal(replyMsg.reply.id, originalId);
        assert.equal(replyMsg.reply.preview, 'texto original', 'el preview sale del mensaje real, no del que envía el cliente');

        // Al editar el original, la cita muestra el texto nuevo.
        const edit = await api(srv.base, 'POST', '/msg/edit', { id: originalId, data: 'texto editado' }, ana.cookie);
        assert.equal(edit.status, 200);
        page = await api(srv.base, 'POST', '/messages', { to: 'beto', limit: 20 }, ana.cookie);
        replyMsg = page.json.messages.find(m => m.id === reply.json.message.id);
        assert.equal(replyMsg.reply.preview, 'texto editado');

        // Al borrarlo, la cita se queda sin vista previa.
        const del = await api(srv.base, 'POST', '/msg/delete', { id: originalId }, ana.cookie);
        assert.equal(del.status, 200);
        page = await api(srv.base, 'POST', '/messages', { to: 'beto', limit: 20 }, ana.cookie);
        replyMsg = page.json.messages.find(m => m.id === reply.json.message.id);
        assert.equal(replyMsg.reply.preview, '');
        assert.equal(replyMsg.reply.missing, true);
    } finally { await stop(srv); }
});

test('responder a una nota de estado se cita como nota (no como mensaje normal)', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await contactPair(srv.base);
        const reply = await api(srv.base, 'POST', '/send', {
            to: 'beto', kind: 'text', data: 'te contesto',
            reply: { kind: 'note', from: 'beto', text: 'nota de estado' }
        }, ana.cookie);
        assert.equal(reply.json.ok, true);
        const stored = reply.json.message.reply;
        assert.equal(stored.kind, 'note');
        assert.equal(stored.text, 'nota de estado');
        assert.equal(stored.preview, 'nota de estado');
    } finally { await stop(srv); }
});

test('vaciar un chat borra los mensajes DE VERDAD para los dos', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await contactPair(srv.base);
        await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'uno' }, ana.cookie);
        await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'dos' }, ana.cookie);
        await api(srv.base, 'POST', '/send', { from: 'beto', to: 'ana', kind: 'text', data: 'tres' }, beto.cookie);

        let pageA = await api(srv.base, 'POST', '/messages', { to: 'beto', limit: 50 }, ana.cookie);
        let pageB = await api(srv.base, 'POST', '/messages', { to: 'ana', limit: 50 }, beto.cookie);
        assert.equal(pageA.json.messages.length, 3);
        assert.equal(pageB.json.messages.length, 3);

        const cleared = await api(srv.base, 'POST', '/chat/delete', { to: 'beto', clearBoth: true }, ana.cookie);
        assert.equal(cleared.status, 200);
        assert.equal(cleared.json.scope, 'both');

        pageA = await api(srv.base, 'POST', '/messages', { to: 'beto', limit: 50 }, ana.cookie);
        pageB = await api(srv.base, 'POST', '/messages', { to: 'ana', limit: 50 }, beto.cookie);
        assert.equal(pageA.json.messages.length, 0, 'quien vacia el chat ya no ve los mensajes');
        assert.equal(pageB.json.messages.length, 0, 'la otra parte tampoco los ve');

        // Un mensaje nuevo es el unico que queda (los viejos no vuelven).
        await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'nuevo' }, ana.cookie);
        pageA = await api(srv.base, 'POST', '/messages', { to: 'beto', limit: 50 }, ana.cookie);
        pageB = await api(srv.base, 'POST', '/messages', { to: 'ana', limit: 50 }, beto.cookie);
        assert.deepEqual(pageA.json.messages.map(m => m.data), ['nuevo']);
        assert.deepEqual(pageB.json.messages.map(m => m.data), ['nuevo']);
    } finally { await stop(srv); }
});

test('al borrar un mensaje el contador de no leidos baja', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await contactPair(srv.base);
        // beto envia tres mensajes que ana no lee
        for (const texto of ['uno', 'dos', 'tres']) {
            const sent = await api(srv.base, 'POST', '/send', { from: 'beto', to: 'ana', kind: 'text', data: texto }, beto.cookie);
            assert.equal(sent.json.ok, true);
        }
        let summary = await api(srv.base, 'GET', '/chats/summary', null, ana.cookie);
        let chat = (summary.json.chats || []).find(c => c.peer === 'beto');
        assert.equal(chat.unread, 3, 'los tres mensajes cuentan como no leidos');

        // ana borra el ultimo: el contador baja a dos
        const page = await api(srv.base, 'POST', '/messages', { to: 'beto', limit: 20 }, ana.cookie);
        const last = (page.json.messages || []).find(m => m.data === 'tres');
        const removed = await api(srv.base, 'POST', '/msg/delete', { id: last.id }, ana.cookie);
        assert.equal(removed.status, 200);

        summary = await api(srv.base, 'GET', '/chats/summary', null, ana.cookie);
        chat = (summary.json.chats || []).find(c => c.peer === 'beto');
        assert.equal(chat.unread, 2, 'el mensaje borrado ya no cuenta como no leido');
    } finally { await stop(srv); }
});
