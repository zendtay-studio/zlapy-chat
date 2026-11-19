'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const authRoutes = require('../../src/auth/routes.js');
const sessions = require('../../src/auth/sessions.js');
const metaRoutes = require('../../src/meta/routes.js');
const stickerRoutes = require('../../src/stickers/routes.js');
const notify = require('../../src/realtime/notify.js');
const { AuthKeyUnreadableError } = require('../../src/crypto/user-auth-keys.js');

const originalPostAuthLogin = authRoutes.postAuthLogin;
const originalSessionUser = sessions.sessionUser;
const originalGetConfig = metaRoutes.getConfig;
const originalGiphySearch = stickerRoutes.getGiphySearch;
const originalUserList = notify.userList;

let configError = null;
let loginError = null;
let giphyError = null;
let userListResult = [];
let userListCalls = [];

// Sustituir antes de cargar router.js: este captura las funciones al hacer
// require, igual que en producción, y el handler exterior sigue siendo real.
authRoutes.postAuthLogin = async () => { if (loginError) throw loginError; };
sessions.sessionUser = req => req.testAuthUser || null;
metaRoutes.getConfig = (...args) => {
    if (configError) throw configError;
    return originalGetConfig(...args);
};
stickerRoutes.getGiphySearch = async () => { if (giphyError) throw giphyError; };
notify.userList = viewerId => {
    userListCalls.push(viewerId);
    return userListResult;
};

const routerPath = require.resolve('../../src/http/router.js');
delete require.cache[routerPath];
const { handler } = require(routerPath);

test.after(() => {
    authRoutes.postAuthLogin = originalPostAuthLogin;
    sessions.sessionUser = originalSessionUser;
    metaRoutes.getConfig = originalGetConfig;
    stickerRoutes.getGiphySearch = originalGiphySearch;
    notify.userList = originalUserList;
});

function requestOf(pathname, method = 'GET', authUser = null) {
    const req = new EventEmitter();
    Object.assign(req, {
        url: pathname,
        method,
        headers: { host: 'localhost' },
        socket: { remoteAddress: '127.0.0.1', encrypted: true },
        testAuthUser: authUser,
        resume() { }
    });
    const res = {
        req,
        headersSent: false,
        statusCode: 0,
        headers: {},
        body: '',
        ended: false,
        setHeader(name, value) { this.headers[name] = value; },
        writeHead(status, headers = {}) {
            this.statusCode = status;
            this.headers = { ...this.headers, ...headers };
            this.headersSent = true;
            return this;
        },
        end(body) {
            if (body !== undefined) this.body += body.toString();
            this.ended = true;
            return this;
        },
        destroy() { this.destroyed = true; }
    };
    return { req, res };
}

function dispatch(pathname, method = 'GET', authUser = null) {
    const { req, res } = requestOf(pathname, method, authUser);
    const result = handler(req, res);
    return { req, res, result };
}

test('el handler exterior convierte una excepción inesperada en 500 JSON genérico', t => {
    t.mock.method(console, 'error', () => { });
    configError = new Error('detalle interno que no debe filtrarse');
    try {
        const { res } = dispatch('/config');
        assert.equal(res.statusCode, 500);
        assert.match(res.headers['Content-Type'], /application\/json/);
        assert.deepEqual(JSON.parse(res.body), { error: 'Error interno del servidor.' });
        assert.ok(!res.body.includes(configError.message));
    } finally { configError = null; }
});

test('el handler exterior reserva 400 para errores de cliente explícitos', t => {
    t.mock.method(console, 'error', () => { });
    for (const error of [
        Object.assign(new Error('validación privada'), { statusCode: 400 }),
        Object.assign(new Error('validación privada'), { status: 400 }),
        Object.assign(new Error('validación privada'), { code: 'BAD_REQUEST' })
    ]) {
        configError = error;
        try {
            const { res } = dispatch('/config');
            assert.equal(res.statusCode, 400);
            assert.match(res.headers['Content-Type'], /application\/json/);
            assert.deepEqual(JSON.parse(res.body), { error: 'bad request' });
            assert.ok(!res.body.includes(error.message));
        } finally { configError = null; }
    }
});

test('el handler exterior conserva AuthKeyUnreadableError como 503', t => {
    t.mock.method(console, 'error', () => { });
    configError = new AuthKeyUnreadableError('id-privado');
    try {
        const { res } = dispatch('/config');
        assert.equal(res.statusCode, 503);
        assert.deepEqual(JSON.parse(res.body), {
            error: 'Cifrado de la cuenta no legible con la llave actual. El operador debe revisar la llave maestra.'
        });
        assert.ok(!res.body.includes('id-privado'));
    } finally { configError = null; }
});

test('el POST asíncrono conserva AuthKeyUnreadableError como 503', async t => {
    t.mock.method(console, 'error', () => { });
    loginError = new AuthKeyUnreadableError('id-privado');
    try {
        const { req, res } = dispatch('/auth/login', 'POST');
        req.emit('end');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(res.statusCode, 503);
        assert.deepEqual(JSON.parse(res.body), {
            error: 'Cifrado de la cuenta no legible con la llave actual. El operador debe revisar la llave maestra.'
        });
        assert.ok(!res.body.includes('id-privado'));
    } finally { loginError = null; }
});

test('un rechazo async de login inesperado responde 500 y no queda sin manejar', async t => {
    t.mock.method(console, 'error', () => { });
    loginError = new Error('fallo async privado');
    try {
        const { req, res } = dispatch('/auth/login', 'POST');
        req.emit('end');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(res.statusCode, 500);
        assert.deepEqual(JSON.parse(res.body), { error: 'Error interno del servidor.' });
        assert.ok(!res.body.includes(loginError.message));
    } finally { loginError = null; }
});

test('un rechazo async marcado como 400 conserva ese significado', async t => {
    t.mock.method(console, 'error', () => { });
    loginError = Object.assign(new Error('entrada privada'), { statusCode: 400 });
    try {
        const { req, res } = dispatch('/auth/login', 'POST');
        req.emit('end');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(res.statusCode, 400);
        assert.deepEqual(JSON.parse(res.body), { error: 'bad request' });
    } finally { loginError = null; }
});

test('una ruta GET async rechazada pasa por el mismo 500 genérico', async t => {
    t.mock.method(console, 'error', () => { });
    giphyError = new Error('upstream privado');
    try {
        const { res, result } = dispatch('/giphy/search', 'GET', { id: 'u', username: 'ana' });
        await result;
        assert.equal(res.statusCode, 500);
        assert.deepEqual(JSON.parse(res.body), { error: 'Error interno del servidor.' });
        assert.ok(!res.body.includes(giphyError.message));
    } finally { giphyError = null; }
});

for (const pathname of ['/users', '/contacts']) {
    test(`GET ${pathname} sin paginación calcula userList una sola vez`, () => {
        userListResult = [
            { id: 'viewer-id', username: 'ana' },
            { id: 'contact-id', username: 'beto' }
        ];
        userListCalls = [];
        const authUser = { id: 'viewer-id', username: 'ana' };
        const { res } = dispatch(pathname, 'GET', authUser);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(JSON.parse(res.body), { users: userListResult, more: false, total: 2 });
        assert.deepEqual(userListCalls, ['viewer-id']);
    });
}
