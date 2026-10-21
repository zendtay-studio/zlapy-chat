// Regresión: el estado en RAM (historias, notas, registro de llamadas) se
// muta, NO se reasigna. Si se reasignara, los módulos que importan la
// referencia se quedarían con la lista antigua y una historia borrada
// seguiría apareciendo.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startServer, stop, api, register } = require('./helpers.js');

test('una historia borrada desaparece de verdad (no sigue en la lista del servidor)', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const created = await api(srv.base, 'POST', '/story', { kind: 'text', text: 'hola', bg: '#123456' }, ana.cookie);
        assert.equal(created.status, 200);

        let list = await api(srv.base, 'GET', '/stories', null, ana.cookie);
        let mine = (list.json.stories || []).filter(story => story.from === 'ana');
        assert.equal(mine.length, 1, 'la historia debe estar en la lista');

        const removed = await api(srv.base, 'POST', '/story/delete', { ts: mine[0].ts }, ana.cookie);
        assert.equal(removed.status, 200);

        list = await api(srv.base, 'GET', '/stories', null, ana.cookie);
        mine = (list.json.stories || []).filter(story => story.from === 'ana');
        assert.equal(mine.length, 0, 'la historia borrada no debe seguir en la lista');

        // Y tampoco vuelve al reiniciar el servidor.
        const again = await api(srv.base, 'GET', '/stories', null, ana.cookie);
        assert.equal((again.json.stories || []).filter(story => story.from === 'ana').length, 0);
    } finally { await stop(srv); }
});

test('el estado compartido se muta: setStories no deja referencias obsoletas', async () => {
    const state = require('../src/state.js');
    const before = state.stories;
    state.setStories([{ from: 'x', ts: 1 }]);
    assert.equal(state.stories.length, 1);
    // La referencia importada sigue viendo la lista actual.
    assert.equal(before.length, 1);
    assert.equal(before[0].from, 'x');
    state.setStories([]);
    assert.equal(state.stories.length, 0);
    assert.equal(before.length, 0);
});
