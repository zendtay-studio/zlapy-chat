// Derivación de la llave maestra y contraseñas de cuenta.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
    SCRYPT_PARAMS, BCRYPT_COST, credentialMaterial, deriveKey, deriveMasterKey,
    bcryptInput, hashPassword, verifyPassword, estimatePasswordBits, assessPassword
} = require('../../src/crypto/kdf.js');

test('la derivación es determinista con la misma sal y la misma clave', () => {
    const salt = crypto.randomBytes(16);
    const a = deriveKey('clave-de-prueba-2026', salt);
    const b = deriveKey('clave-de-prueba-2026', salt);
    assert.equal(a.length, 32);
    assert.equal(a.toString('hex'), b.toString('hex'));
});

test('la sal cambia la llave derivada', () => {
    const a = deriveKey('clave-de-prueba-2026', crypto.randomBytes(16));
    const b = deriveKey('clave-de-prueba-2026', crypto.randomBytes(16));
    assert.notEqual(a.toString('hex'), b.toString('hex'));
});

test('la contraseña cambia la llave derivada', () => {
    const salt = crypto.randomBytes(16);
    const a = deriveKey('clave-de-prueba-2026', salt);
    const b = deriveKey('otra-clave-2026', salt);
    assert.notEqual(a.toString('hex'), b.toString('hex'));
});

test('el material de la credencial incluye el usuario', () => {
    const sal = crypto.randomBytes(16);
    const ana = deriveMasterKey('ana', 'clave-de-prueba-2026', sal);
    const beto = deriveMasterKey('beto', 'clave-de-prueba-2026', sal);
    assert.notEqual(ana.toString('hex'), beto.toString('hex'));
    // El material no se puede confundir entre usuario y contraseña.
    assert.notEqual(credentialMaterial('ana', 'beto'), credentialMaterial('anab', 'eto'));
    assert.equal(credentialMaterial('ana', 'beto'), 'ana\0beto');
});

test('los parámetros de scrypt son los previstos (coste suficiente, memoria acotada)', () => {
    assert.equal(SCRYPT_PARAMS.N, 32768);
    assert.equal(SCRYPT_PARAMS.r, 8);
    assert.equal(SCRYPT_PARAMS.p, 1);
    assert.equal(SCRYPT_PARAMS.dkLen, 32);
    assert.ok(SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 128 >= 32 * 1024 * 1024, 'debe usar al menos 32 MiB');
});

test('el pre-hash de bcrypt no trunca la contraseña (ni la pierde por multibyte)', () => {
    const larga = 'á'.repeat(200);   // 400 bytes en UTF-8
    const entrada = bcryptInput(larga);
    assert.equal(entrada.length, 44, 'SHA-256 en Base64: 44 caracteres');
    assert.ok(entrada.length <= 72, 'bcrypt trunca a 72 bytes: el pre-hash cabe entero');
    // Dos contraseñas distintas dan pre-hash distintos (no hay colisiones por truncado).
    assert.notEqual(bcryptInput(larga), bcryptInput('á'.repeat(199) + 'é'));
});

test('hashPassword genera un hash bcrypt verificable (y no guarda la contraseña)', async () => {
    const hash = await hashPassword('clave-de-prueba-2026');
    assert.match(hash, /^\$2[aby]\$\d{2}\$/);
    assert.equal(hash.includes('clave-de-prueba-2026'), false);
    assert.equal(await verifyPassword('clave-de-prueba-2026', hash), true);
    assert.equal(await verifyPassword('otra-clave', hash), false);
});

test('verifyPassword rechaza formatos que no son hashes', async () => {
    assert.equal(await verifyPassword('x', ''), false);
    assert.equal(await verifyPassword('x', 'no-es-un-hash'), false);
    assert.equal(await verifyPassword('x', '$2b$10$invalido'), false);
});

test('la estimación de entropía distingue las contraseñas débiles', () => {
    const debil = assessPassword('123456');
    assert.equal(debil.weak, true);
    const fuerte = assessPassword(crypto.randomBytes(24).toString('base64url'));
    assert.equal(fuerte.weak, false);
    assert.ok(fuerte.bits >= 60, `bits estimados: ${fuerte.bits}`);
    assert.ok(estimatePasswordBits('123456') < estimatePasswordBits(crypto.randomBytes(24).toString('base64url')));
});

test('las contraseñas más usadas se marcan como débiles aunque "midan" mucho', () => {
    assert.equal(assessPassword('password').weak, true);
    assert.equal(assessPassword('123456789').weak, true);
    assert.equal(assessPassword('').weak, true);
    assert.equal(assessPassword('corta').weak, true);
});
