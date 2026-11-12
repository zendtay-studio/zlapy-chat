const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { api, register, startServer, stop, WsClient } = require('../helpers.js');

async function contactPair(base) {
    const ana = await register(base, 'ana');
    const beto = await register(base, 'beto');
    await api(base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
    await api(base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);
    return { ana, beto };
}

test('las reacciones privadas se alternan, persisten y se sincronizan por WebSocket', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-reactions-restart-'));
    let srv = await startServer({ dataDir });
    let anaWs, betoWs;
    try {
        const { ana, beto } = await contactPair(srv.base);
        const sent = await api(srv.base, 'POST', '/send', {
            to: 'beto', kind: 'text', data: 'mensaje con reacciones'
        }, ana.cookie);
        assert.equal(sent.status, 200);
        const messageId = sent.json.message.id;

        anaWs = new WsClient(srv.port, ana.cookie);
        betoWs = new WsClient(srv.port, beto.cookie);
        await anaWs.connect();
        await betoWs.connect();

        const reacted = await api(srv.base, 'POST', '/message/reaction', {
            messageId, emoji: '❤️'
        }, beto.cookie);
        assert.equal(reacted.status, 200);
        assert.deepEqual(reacted.json.reactions, [{ emoji: '❤️', count: 1, mine: true }]);
        const [anaEvent, betoEvent] = await Promise.all([
            anaWs.waitFor('message-reactions'),
            betoWs.waitFor('message-reactions')
        ]);
        assert.deepEqual(anaEvent.reactions, [{ emoji: '❤️', count: 1, mine: false }]);
        assert.deepEqual(betoEvent.reactions, [{ emoji: '❤️', count: 1, mine: true }]);

        const historyA = await api(srv.base, 'POST', '/messages', { to: 'beto' }, ana.cookie);
        const historyB = await api(srv.base, 'POST', '/messages', { to: 'ana' }, beto.cookie);
        assert.deepEqual(historyA.json.messages[0].reactions, [{ emoji: '❤️', count: 1, mine: false }]);
        assert.deepEqual(historyB.json.messages[0].reactions, [{ emoji: '❤️', count: 1, mine: true }]);
        anaWs.destroy();
        betoWs.destroy();
        anaWs = betoWs = null;
        await stop(srv);
        srv = await startServer({ dataDir });
        const afterRestart = await api(srv.base, 'POST', '/messages', { to: 'beto' }, ana.cookie);
        assert.deepEqual(afterRestart.json.messages[0].reactions, [{ emoji: '❤️', count: 1, mine: false }]);

        const switched = await api(srv.base, 'POST', '/message/reaction', {
            messageId, emoji: '👍'
        }, beto.cookie);
        assert.deepEqual(switched.json.reactions, [{ emoji: '👍', count: 1, mine: true }]);
        const removed = await api(srv.base, 'POST', '/message/reaction', {
            messageId, emoji: '👍'
        }, beto.cookie);
        assert.deepEqual(removed.json.reactions, []);

        const invalid = await api(srv.base, 'POST', '/message/reaction', {
            messageId, emoji: '❤️👍'
        }, beto.cookie);
        assert.equal(invalid.status, 400);
        const stranger = await register(srv.base, 'carla');
        const denied = await api(srv.base, 'POST', '/message/reaction', {
            messageId, emoji: '🔥'
        }, stranger.cookie);
        assert.equal(denied.status, 404);
    } finally {
        anaWs?.destroy();
        betoWs?.destroy();
        await stop(srv);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('las reacciones de grupo solo se aceptan de miembros y aparecen en el historial', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await contactPair(srv.base);
        const created = await api(srv.base, 'POST', '/groups', {
            name: 'Reacciones', members: ['beto']
        }, ana.cookie);
        assert.equal(created.status, 200);
        const groupId = created.json.id;
        const sent = await api(srv.base, 'POST', `/groups/${groupId}`, {
            message: { kind: 'text', data: 'mensaje del grupo' }
        }, ana.cookie);
        assert.equal(sent.status, 200);

        const reacted = await api(srv.base, 'POST', '/message/reaction', {
            messageId: sent.json.message.id, emoji: '🎉'
        }, beto.cookie);
        assert.equal(reacted.status, 200);
        const history = await api(srv.base, 'GET', `/groups/${groupId}/messages`, null, ana.cookie);
        assert.deepEqual(history.json.messages[0].reactions, [{ emoji: '🎉', count: 1, mine: false }]);

        const stranger = await register(srv.base, 'carla');
        const denied = await api(srv.base, 'POST', '/message/reaction', {
            messageId: sent.json.message.id, emoji: '👏'
        }, stranger.cookie);
        assert.equal(denied.status, 404);
    } finally { await stop(srv); }
});

test('no se puede reaccionar a mensajes de una sola vista', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await contactPair(srv.base);
        const sent = await api(srv.base, 'POST', '/send', {
            to: 'beto', kind: 'text', data: 'privado', once: true
        }, ana.cookie);
        assert.equal(sent.status, 200);
        const rejected = await api(srv.base, 'POST', '/message/reaction', {
            messageId: sent.json.message.id, emoji: '❤️'
        }, beto.cookie);
        assert.equal(rejected.status, 404);
    } finally { await stop(srv); }
});
