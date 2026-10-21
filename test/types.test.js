const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeContactData, normalizePollData, togglePollVote } = require('../src/shared/types.js');

test('normalizes polls and discards client-supplied votes', () => {
    const poll = normalizePollData(JSON.stringify({
        question: '  ¿Café?  ',
        options: [{ id: 'yes', text: ' Sí ' }, { id: 'no', text: 'No' }],
        votes: { someone: 'yes' }
    }));

    assert.deepEqual(poll, {
        question: '¿Café?',
        options: [{ id: 'yes', text: 'Sí' }, { id: 'no', text: 'No' }],
        allowMultiple: false,
        votes: {}
    });
});

test('normalizes polls that allow multiple selections', () => {
    const poll = normalizePollData({
        question: '¿Qué te gusta?',
        options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
        allowMultiple: true,
        votes: { someone: ['a'] }
    });

    assert.equal(poll.allowMultiple, true);
    assert.deepEqual(poll.votes, {});
});

test('poll votes can be changed or withdrawn, including legacy single-choice values', () => {
    assert.deepEqual(togglePollVote({ user: 'a' }, 'user', 'a', false), {});
    assert.deepEqual(togglePollVote({ user: ['a'] }, 'user', 'b', false), { user: ['b'] });
    assert.deepEqual(togglePollVote({ user: 'a' }, 'user', 'b', true), { user: ['a', 'b'] });
    assert.deepEqual(togglePollVote({ user: ['a', 'b'] }, 'user', 'a', true), { user: ['b'] });
    assert.deepEqual(togglePollVote({ user: ['a'] }, 'user', 'a', true), {});
});

test('rejects malformed polls and duplicate option ids', () => {
    assert.equal(normalizePollData('not json'), null);
    assert.equal(normalizePollData({ question: 'Question', options: [{ id: 'a', text: 'A' }] }), null);
    assert.equal(normalizePollData({
        question: 'Question',
        options: [{ id: 'a', text: 'A' }, { id: 'a', text: 'B' }]
    }), null);
});

test('only resolves and returns a known username for a shared contact', () => {
    const findContact = username => username === 'ana' ? { username: 'ana', id: 'private-id' } : null;

    assert.deepEqual(normalizeContactData({ username: 'ana', id: 'spoofed' }, findContact), { username: 'ana' });
    assert.equal(normalizeContactData({ username: 'unknown' }, findContact), null);
    assert.equal(normalizeContactData('{broken', findContact), null);
});
