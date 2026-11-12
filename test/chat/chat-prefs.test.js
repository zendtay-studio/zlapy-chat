// Preferencias de la lista de chats (fijado, silencio, no leído) en el
// servidor y citas de respuesta resueltas por ID (la vista previa se
// actualiza al editar y desaparece al borrar).
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startServer, stop, api, register } = require('../helpers.js');

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

test('mensajes guardados aceptan y recuperan sus propias preferencias de chat', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'savedprefs');
        const update = await api(srv.base, 'POST', '/chat/preferences', {
            targets: ['saved'], pinned: true, muted: true, archived: true
        }, ana.cookie);
        assert.equal(update.status, 200);
        assert.deepEqual(update.json.prefs.saved, {
            pinned: true, pinnedAt: update.json.prefs.saved.pinnedAt,
            unread: false, archived: true, muted: true
        });
        assert.ok(update.json.prefs.saved.pinnedAt > 0);
        assert.ok(update.json.mutedPeers.includes('saved'));

        const read = await api(srv.base, 'GET', '/chat/preferences', null, ana.cookie);
        assert.equal(read.json.prefs.saved.pinned, true);
        assert.equal(read.json.prefs.saved.archived, true);
        assert.equal(read.json.prefs.saved.muted, true);
        assert.equal(read.json.prefs['dm:saved'], undefined);
    } finally { await stop(srv); }
});

test('borrar mensajes guardados vacía el historial propio', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'saveddelete');
        const sent = await api(srv.base, 'POST', '/send', {
            to: 'saveddelete', kind: 'text', data: 'nota privada'
        }, ana.cookie);
        assert.equal(sent.status, 200);

        const deleted = await api(srv.base, 'POST', '/chat/delete', {
            to: 'saveddelete', clearBoth: true
        }, ana.cookie);
        assert.equal(deleted.status, 200);

        const history = await api(srv.base, 'POST', '/messages', { to: 'saveddelete' }, ana.cookie);
        assert.equal(history.status, 200);
        assert.deepEqual(history.json.messages, []);
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

test('borrar un chat limpia también sus preferencias (fijado, archivado, no leído)', async () => {
    const srv = await startServer();
    try {
        const { ana } = await contactPair(srv.base);
        const set = await api(srv.base, 'POST', '/chat/preferences', {
            targets: ['dm:beto'], pinned: true, archived: true, unread: true
        }, ana.cookie);
        assert.equal(set.status, 200);

        const deleted = await api(srv.base, 'POST', '/chat/delete', { peers: ['beto'] }, ana.cookie);
        assert.equal(deleted.status, 200);

        const prefs = await api(srv.base, 'GET', '/chat/preferences', null, ana.cookie);
        assert.equal(prefs.json.prefs['dm:beto'], undefined, 'sin chat no deben quedar preferencias sueltas');
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

test('el ajuste de mantener archivados se guarda en la cuenta', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const initial = await api(srv.base, 'GET', '/account/chat-settings', null, ana.cookie);
        assert.equal(initial.status, 200);
        assert.equal(initial.json.keepArchived, false, 'apagado por defecto');

        const on = await api(srv.base, 'POST', '/account/chat-settings', { keepArchived: true }, ana.cookie);
        assert.equal(on.status, 200);
        const read = await api(srv.base, 'GET', '/account/chat-settings', null, ana.cookie);
        assert.equal(read.json.keepArchived, true, 'el ajuste persiste en la cuenta');

        const bad = await api(srv.base, 'POST', '/account/chat-settings', { keepArchived: 'sí' }, ana.cookie);
        assert.equal(bad.status, 400);
    } finally { await stop(srv); }
});

test('un mensaje nuevo desarchiva el chat salvo con mantener archivados', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await contactPair(srv.base);
        await api(srv.base, 'POST', '/chat/preferences', { targets: ['dm:beto'], archived: true }, ana.cookie);

        await api(srv.base, 'POST', '/send', { to: 'ana', kind: 'text', data: 'hola' }, beto.cookie);
        let prefs = await api(srv.base, 'GET', '/chat/preferences', null, ana.cookie);
        assert.equal(prefs.json.prefs['dm:beto'], undefined, 'el mensaje devuelve el chat a la lista');

        await api(srv.base, 'POST', '/account/chat-settings', { keepArchived: true }, ana.cookie);
        await api(srv.base, 'POST', '/chat/preferences', { targets: ['dm:beto'], archived: true }, ana.cookie);
        await api(srv.base, 'POST', '/send', { to: 'ana', kind: 'text', data: 'otra vez' }, beto.cookie);
        prefs = await api(srv.base, 'GET', '/chat/preferences', null, ana.cookie);
        assert.equal(prefs.json.prefs['dm:beto'].archived, true, 'con el ajuste activo sigue archivado');
    } finally { await stop(srv); }
});

test('al borrar la cuenta del contacto desaparecen sus chats archivados y silenciados', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await contactPair(srv.base);
        const set = await api(srv.base, 'POST', '/chat/preferences', {
            targets: ['dm:beto'], archived: true, muted: true
        }, ana.cookie);
        assert.equal(set.status, 200);
        assert.equal(set.json.prefs['dm:beto'].archived, true);

        const deleted = await api(srv.base, 'POST', '/account/delete', { password: 'pruebachat1' }, beto.cookie);
        assert.equal(deleted.status, 200);

        // La cuenta borrada arrastra TODAS sus referencias, también las que
        // viven en filas de otras cuentas y no tienen FK (la clave de un DM
        // es 'dm:<usuario>', no un id).
        const prefs = await api(srv.base, 'GET', '/chat/preferences', null, ana.cookie);
        assert.equal(prefs.status, 200);
        assert.deepEqual(prefs.json.prefs, {}, 'no debe quedar el chat archivado fantasma');
        assert.deepEqual(prefs.json.mutedPeers, [], 'tampoco el silencio huérfano');

        const summary = await api(srv.base, 'GET', '/chats/summary', null, ana.cookie);
        assert.ok(!(summary.json.chats || []).some(chat => chat.peer === 'beto'));
    } finally { await stop(srv); }
});

test('en grupos, el mensaje nuevo respeta el ajuste de mantener archivados', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await contactPair(srv.base);
        const created = await api(srv.base, 'POST', '/groups', { name: 'Equipo', members: ['beto'] }, ana.cookie);
        assert.equal(created.status, 200);
        const gid = created.json.id;
        const send = () => api(srv.base, 'POST', '/groups/' + gid, { message: { kind: 'text', data: 'hola' } }, beto.cookie);

        await api(srv.base, 'POST', '/chat/preferences', { targets: ['group:' + gid], archived: true }, ana.cookie);
        await send();
        let prefs = await api(srv.base, 'GET', '/chat/preferences', null, ana.cookie);
        assert.equal(prefs.json.prefs['group:' + gid], undefined, 'el mensaje devuelve el grupo a la lista');

        await api(srv.base, 'POST', '/account/chat-settings', { keepArchived: true }, ana.cookie);
        await api(srv.base, 'POST', '/chat/preferences', { targets: ['group:' + gid], archived: true }, ana.cookie);
        await send();
        prefs = await api(srv.base, 'GET', '/chat/preferences', null, ana.cookie);
        assert.equal(prefs.json.prefs['group:' + gid].archived, true, 'con el ajuste activo sigue archivado');
    } finally { await stop(srv); }
});
