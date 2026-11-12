'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startServer, stop, api, register } = require('../helpers.js');

test('la búsqueda de grupos públicos filtra en servidor y pagina resultados', async () => {
    const srv = await startServer();
    try {
        const owner = await register(srv.base, 'discoverowner');
        const visitor = await register(srv.base, 'discovervisitor');
        assert.ok(owner.cookie);
        assert.ok(visitor.cookie);

        const algebra = await api(srv.base, 'POST', '/groups', {
            name: 'Álgebra avanzada', description: 'Matemática para todos',
            visibility: 'public', joinPolicy: 'open'
        }, owner.cookie);
        const reading = await api(srv.base, 'POST', '/groups', {
            name: 'Club de lectura', description: 'Matemática recreativa',
            visibility: 'public', joinPolicy: 'open'
        }, owner.cookie);
        const requestedGroup = await api(srv.base, 'POST', '/groups', {
            name: 'Álgebra práctica', visibility: 'public', joinPolicy: 'request'
        }, owner.cookie);
        const privateGroup = await api(srv.base, 'POST', '/groups', {
            name: 'Álgebra privada', visibility: 'private'
        }, owner.cookie);
        for (const result of [algebra, reading, requestedGroup, privateGroup])
            assert.equal(result.status, 200);

        const firstPage = await api(srv.base, 'GET', '/groups/discover?q=algebra&limit=1', null, visitor.cookie);
        assert.equal(firstPage.status, 200);
        assert.equal(firstPage.json.groups.length, 1);
        assert.equal(firstPage.json.more, true);

        const secondPage = await api(srv.base, 'GET', '/groups/discover?q=algebra&limit=1&offset=1', null, visitor.cookie);
        assert.equal(secondPage.status, 200);
        assert.equal(secondPage.json.groups.length, 1);
        assert.equal(secondPage.json.more, false);

        const matches = await api(srv.base, 'GET', '/groups/discover?q=algebra&limit=20', null, visitor.cookie);
        assert.equal(matches.status, 200);
        assert.deepEqual(new Set(matches.json.groups.map(group => group.id)),
            new Set([algebra.json.id, requestedGroup.json.id]));
        assert.ok(matches.json.groups.every(group => group.id !== privateGroup.json.id));

        const requested = await api(srv.base, 'POST', `/groups/${requestedGroup.json.id}`, { join: true }, visitor.cookie);
        assert.equal(requested.status, 200);
        assert.equal(requested.json.requested, true);
        const afterRequest = await api(srv.base, 'GET', '/groups/discover?q=algebra&limit=20', null, visitor.cookie);
        assert.equal(afterRequest.json.groups.find(group => group.id === requestedGroup.json.id).requested, true);

        const cancelled = await api(srv.base, 'POST', `/groups/${requestedGroup.json.id}`, { cancelJoin: true }, visitor.cookie);
        assert.equal(cancelled.status, 200);
        const afterCancel = await api(srv.base, 'GET', '/groups/discover?q=algebra&limit=20', null, visitor.cookie);
        assert.equal(afterCancel.json.groups.find(group => group.id === requestedGroup.json.id).requested, false);

        const joined = await api(srv.base, 'POST', `/groups/${algebra.json.id}`, { join: true }, visitor.cookie);
        assert.equal(joined.status, 200);
        const afterJoin = await api(srv.base, 'GET', '/groups/discover?q=algebra&limit=20', null, visitor.cookie);
        assert.deepEqual(afterJoin.json.groups.map(group => group.id), [requestedGroup.json.id]);

        const recommendations = await api(srv.base, 'GET', '/groups/discover?limit=1', null, visitor.cookie);
        assert.equal(recommendations.status, 200);
        assert.equal(recommendations.json.groups.length, 1);
        assert.equal(recommendations.json.more, true);

        assert.equal((await api(srv.base, 'GET', '/groups/discover?limit=51', null, visitor.cookie)).status, 400);
        assert.equal((await api(srv.base, 'GET', '/groups/discover?offset=10001', null, visitor.cookie)).status, 400);
        assert.equal((await api(srv.base, 'GET', `/groups/discover?q=${'a'.repeat(101)}`, null, visitor.cookie)).status, 400);
    } finally {
        await stop(srv);
    }
});
