// Regresión V-04: el acceso a un adjunto de grupo lo decide quién era miembro
// CUANDO se publicó, no quién lo es ahora. Antes, entrar en un grupo público
// daba acceso a todos los adjuntos anteriores.
process.env.PROFILE_DESCRIPTION_CHAR_LIMIT = '500';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('crypto');
const { startServer, stop, api, register } = require('./helpers.js');

function adjunto(texto) {
    const buf = Buffer.from(texto);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    return { hash, data: `data:image/png;base64,${buf.toString('base64')}` };
}
const descargar = (base, cookie, hash) => fetch(`${base}/blob/${hash}`, {
    headers: { Cookie: `chatlocal_session=${encodeURIComponent(cookie)}` }
});

test('quien entra en un grupo público no lee los adjuntos anteriores', async () => {
    const srv = await startServer();
    try {
        const victima = await register(srv.base, 'vicgrupo');
        const atacante = await register(srv.base, 'atagrupo');

        // Grupo público y abierto (cualquiera puede entrar).
        const grupo = await api(srv.base, 'POST', '/groups', {
            name: 'publico', visibility: 'public', joinPolicy: 'open'
        }, victima.cookie);
        assert.equal(grupo.status, 200);
        assert.equal(grupo.json.visibility, 'public');
        const gid = grupo.json.id;

        // La víctima publica un adjunto privado en el grupo.
        const a = adjunto('ADJUNTO-PRIVADO-ANTIGUO');
        const envio = await api(srv.base, 'POST', `/groups/${gid}`, {
            message: { kind: 'image', hash: a.hash, data: a.data }
        }, victima.cookie);
        assert.equal(envio.status, 200);

        // Control: el atacante, SIN entrar, no puede descargarlo.
        assert.equal((await descargar(srv.base, atacante.cookie, a.hash)).status, 404,
            'quien no es miembro no debe acceder al adjunto');

        // El atacante entra al grupo.
        const union = await api(srv.base, 'POST', `/groups/${gid}`, { join: true }, atacante.cookie);
        assert.equal(union.status, 200);

        // Y sigue sin poder descargar lo publicado antes de entrar.
        assert.equal((await descargar(srv.base, atacante.cookie, a.hash)).status, 404,
            'entrar después no debe dar acceso a los adjuntos anteriores (regresión V-04)');

        // En cambio, lo que se publique AHORA sí es accesible para ambos.
        const nuevo = adjunto('ADJUNTO-NUEVO');
        const envio2 = await api(srv.base, 'POST', `/groups/${gid}`, {
            message: { kind: 'image', hash: nuevo.hash, data: nuevo.data }
        }, victima.cookie);
        assert.equal(envio2.status, 200);
        assert.equal((await descargar(srv.base, atacante.cookie, nuevo.hash)).status, 200,
            'el nuevo miembro sí accede a lo publicado con él dentro');
    } finally { await stop(srv); }
});
