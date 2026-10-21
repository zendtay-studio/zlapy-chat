/**
 * Cifrado del canal en el navegador.
 *
 * Envuelve `fetch` para que todas las peticiones POST con cuerpo JSON viajen
 * cifradas y sus respuestas se descifren solas. La aplicación sigue llamando a
 * `fetch` como siempre: el sobre se construye aquí.
 *
 * La clave pública del servidor se pide una vez a `/config` y se guarda en
 * memoria. Si el servidor no la ofrece (por ejemplo, porque se sirve desde un
 * proxy antiguo), la petición sale sin cifrar en vez de fallar: el cifrado es
 * una capa adicional, no un requisito para usar la aplicación.
 *
 * Solo se cifran peticiones al mismo origen; las externas (por ejemplo, las
 * imágenes de GIPHY que pide la vista previa) no pasan por aquí.
 */
'use strict';

(function (global) {
    const T = global.ZlapyTransport;
    if (!T || typeof global.fetch !== 'function') return;

    const nativeFetch = global.fetch.bind(global);
    const CONFIG_PATH = '/config';
    const JSON_TYPE = 'application/json';

    let serverKey = null;
    let keyRequest = null;

    /* Clave pública del servidor, cacheada. */
    function loadServerKey() {
        if (serverKey) return Promise.resolve(serverKey);
        if (!keyRequest) {
            keyRequest = nativeFetch(CONFIG_PATH, { credentials: 'same-origin', cache: 'no-store' })
                .then(response => (response.ok ? response.json() : null))
                .then(config => {
                    serverKey = config && config.transportPublicKey ? config.transportPublicKey : null;
                    return serverKey;
                })
                .catch(() => null);
        }
        return keyRequest;
    }

    /* Descifra la respuesta si el servidor la devolvió envuelta. */
    async function openResponse(response, envelope) {
        if (response.headers.get('X-Zlapy-Enc') !== T.ALGO) return response;
        const nonce = response.headers.get('X-Zlapy-Resp-Nonce');
        if (!nonce) return response;
        const sealed = new Uint8Array(await response.arrayBuffer());
        const plain = T.decryptResponse(sealed, nonce, envelope.method, envelope.path, envelope.time, response.status, envelope.key);
        if (plain === null) throw new Error('La respuesta del servidor no se pudo descifrar.');
        return new Response(plain, {
            status: response.status,
            statusText: response.statusText,
            headers: { 'Content-Type': JSON_TYPE + '; charset=utf-8' }
        });
    }

    global.fetch = async function (input, init) {
        // Solo se interpolan peticiones con URL de texto: son las que usa la app.
        if (typeof input !== 'string') return nativeFetch(input, init);
        const options = init || {};
        const method = String(options.method || 'GET').toUpperCase();
        if (method !== 'POST' || typeof options.body !== 'string') return nativeFetch(input, init);

        const url = new URL(input, global.location.href);
        if (url.origin !== global.location.origin) return nativeFetch(input, init);
        const headers = new Headers(options.headers || {});
        if (!headers.has('Content-Type')) headers.set('Content-Type', JSON_TYPE);
        if (!String(headers.get('Content-Type')).includes(JSON_TYPE)) return nativeFetch(input, init);

        const key = await loadServerKey();
        if (!key) return nativeFetch(input, init);

        let envelope;
        try { envelope = T.encrypt(method, url.pathname, options.body, key); }
        catch { return nativeFetch(input, init); }

        headers.set('Content-Type', envelope.headers['Content-Type']);
        headers.set('X-Zlapy-Enc', envelope.headers['X-Zlapy-Enc']);
        headers.set('X-Zlapy-Ephemeral', envelope.headers['X-Zlapy-Ephemeral']);
        headers.set('X-Zlapy-Nonce', envelope.headers['X-Zlapy-Nonce']);
        headers.set('X-Zlapy-Time', envelope.headers['X-Zlapy-Time']);

        const response = await nativeFetch(input, { ...options, headers, body: envelope.body });
        return openResponse(response, envelope);
    };

    /* Permite a la aplicación saber si el cifrado está activo. */
    global.ZlapyTransportReady = loadServerKey;

    // WebSocket cifrado
    /* Se envuelve el constructor para que cada conexión abra su propia sesión.
     * El primer frame es el saludo (clave pública efímera, en claro); desde
     * ahí todos los frames llevan el prefijo `z1:`. Si la clave del servidor
     * no está disponible, la conexión sigue en claro en vez de romperse. */
    const NativeWebSocket = global.WebSocket;
    if (NativeWebSocket) {
        class SecureWebSocket extends NativeWebSocket {
            constructor(url, protocols) {
                super(url, protocols);
                this._zt = { key: null, out: 0, in: 0, queue: [] };
                this.addEventListener('open', () => { this._ztStart(); }, { once: true });
            }

            async _ztStart() {
                const key = await loadServerKey();
                if (!key) {
                    // Sin clave se vacía la cola en claro: la app sigue igual.
                    for (const text of this._zt.queue.splice(0)) super.send(text);
                    return;
                }
                if (this.readyState !== NativeWebSocket.OPEN) { this._zt.queue.length = 0; return; }
                const session = T.wsKey(T.randomBytes(32), T.fromBase64(key));
                this._zt.key = session.key;
                super.send(JSON.stringify({ type: 'enc', ephemeral: T.toBase64(session.ephemeralRaw) }));
                for (const text of this._zt.queue.splice(0)) this.send(text);
            }

            send(data) {
                if (typeof data !== 'string') return super.send(data);
                if (!this._zt.key) {
                    if (this._zt.queue.length < 200) this._zt.queue.push(data);
                    return;
                }
                return super.send(T.wsSeal(this._zt.key, this._zt.out++, data));
            }

            _ztDecode(data) {
                if (typeof data !== 'string' || !data.startsWith('z1:') || !this._zt.key) return data;
                return T.wsOpen(this._zt.key, this._zt.in++, data);
            }

            set onmessage(handler) {
                super.onmessage = handler ? event => {
                    const text = this._ztDecode(event.data);
                    if (text !== null) handler(new MessageEvent('message', { data: text }));
                } : null;
            }

            get onmessage() { return super.onmessage; }

            addEventListener(type, listener, options) {
                if (type !== 'message' || !listener) return super.addEventListener(type, listener, options);
                const wrapped = event => {
                    const text = this._ztDecode(event.data);
                    if (text !== null) listener.call(this, new MessageEvent('message', { data: text }));
                };
                return super.addEventListener(type, wrapped, options);
            }
        }
        global.WebSocket = SecureWebSocket;
    }
})(window);
