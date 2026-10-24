/**
 * Cifrado del canal en el navegador.
 *
 * Envuelve `fetch` Y `XMLHttpRequest` para que todas las peticiones POST con
 * cuerpo JSON viajen cifradas y sus respuestas se descifran solas. La
 * aplicacion sigue llamando a `fetch` como siempre: el sobre se construye aqui.
 * `XMLHttpRequest` se envuelve porque la subida de adjuntos y de historias lo
 * usa: sin envolverlo, esos cuerpos (los mas grandes y privados) salian en
 * claro incluso habiendo clave disponible.
 *
 * La clave publica del servidor se pide una vez a `/config` y se guarda en
 * memoria. Si el servidor no la ofrece, la peticion sale sin cifrar en vez de
 * fallar: el cifrado es una capa adicional, no un requisito. Cuando eso pasa se
 * avisa una vez por sesion (`ZlapyTransportWarning`) para que la degradacion no
 * sea silenciosa. */
'use strict';

(function (global) {
    const T = global.ZlapyTransport;
    if (!T || typeof global.fetch !== 'function') return;

    const nativeFetch = global.fetch.bind(global);
    const NativeXHR = global.XMLHttpRequest;
    const CONFIG_PATH = '/config';
    const JSON_TYPE = 'application/json';

    let serverKey = null;
    let keyRequest = null;
    let noKeyOnServer = false;

    /* Clave pública del servidor, cacheada. Si /config responde sin clave, la
       situación es estable y no se vuelve a preguntar. Pero si la petición
       falla (corta de red, no ok), solo se pierde ESTA petición: el caché se
       limpia para que el siguiente intento reitere en vez de degradar el canal
       durante toda la sesión. */
    function loadServerKey() {
        if (serverKey) return Promise.resolve(serverKey);
        if (noKeyOnServer) return Promise.resolve(null);
        if (!keyRequest) {
            keyRequest = nativeFetch(CONFIG_PATH, { credentials: 'same-origin', cache: 'no-store' })
                .then(response => {
                    if (!response.ok) throw new Error('config ' + response.status);
                    return response.json();
                })
                .then(config => {
                    if (config && config.transportPublicKey) serverKey = config.transportPublicKey;
                    else noKeyOnServer = true;
                    return serverKey;
                })
                .catch(() => null)
                .finally(() => { keyRequest = null; });
        }
        return keyRequest;
    }

    /* Aviso de degradación: una sola vez por sesión. */
    let avisado = false;
    function transportWarning() {
        if (avisado) return;
        avisado = true;
        try { global.dispatchEvent(new CustomEvent('zlapy-transport-insecure')); } catch (e) { }
        console.warn('[transporte] El servidor no ofreció clave de cifrado: las peticiones salen sin cifrar.');
    }
    global.ZlapyTransportWarning = transportWarning;

    /* Envoltura de XMLHttpRequest: el mismo sobre que en `fetch`. La subida de
       adjuntos y de historias pasa por aquí, así que sin esto esos cuerpos
       viajaban en claro siempre. */
    if (NativeXHR && NativeXHR.prototype) {
        const nativeOpen = NativeXHR.prototype.open;
        const nativeSetHeader = NativeXHR.prototype.setRequestHeader;
        const nativeSend = NativeXHR.prototype.send;
        NativeXHR.prototype.open = function (method, url) {
            this._zt = { method: String(method || 'GET').toUpperCase(), url: String(url || ''), envelope: null };
            /* La respuesta de un POST cifrado vuelve cifrada. Se abre aquí,
               dentro de `open`, para que se ejecute ANTES que el manejador de
               la aplicación (que se registra después de open). Sin esto, la
               subida de adjuntos y de notas de voz leía bytes cifrados,
               fallaba el JSON y el envío parecía no haber salido. */
            this.addEventListener('load', () => openXhrResponse(this));
            return nativeOpen.apply(this, arguments);
        };
        NativeXHR.prototype.send = function (body) {
            const zt = this._zt;
            if (!zt || zt.method !== 'POST' || typeof body !== 'string') return nativeSend.call(this, body);
            const absolute = new URL(zt.url, global.location.href);
            if (absolute.origin !== global.location.origin) return nativeSend.call(this, body);
            return loadServerKey().then(k => {
                // loadServerKey devuelve una promesa: el valor real llega aquí.
                if (!k) { transportWarning(); return nativeSend.call(this, body); }
                let envelope;
                try { envelope = T.encrypt(zt.method, absolute.pathname, body, k); }
                catch { transportWarning(); return nativeSend.call(this, body); }
                for (const name of ['Content-Type', 'X-Zlapy-Enc', 'X-Zlapy-Ephemeral', 'X-Zlapy-Nonce', 'X-Zlapy-Time'])
                    nativeSetHeader.call(this, name, envelope.headers[name]);
                zt.envelope = envelope;
                /* La respuesta llega cifrada: hay que leerla como binario para
                   poder abrirla después. */
                try { this.responseType = 'arraybuffer'; } catch { }
                nativeSend.call(this, envelope.body);
            });
        };
    }

    /* Abre la respuesta de un XHR: si viene cifrada, se descifra y se entrega
       como texto, igual que si la petición no hubiera ido cifrada. */
    function openXhrResponse(xhr) {
        const zt = xhr._zt;
        if (!zt || !zt.envelope) return;
        if (xhr.status === 204 || xhr.status === 205 || xhr.status === 304) return;
        if (xhr.responseType !== 'arraybuffer') return;
        let raw;
        try { raw = new Uint8Array(xhr.response || new ArrayBuffer(0)); }
        catch { return; }
        let plain = null;
        if (xhr.getResponseHeader('X-Zlapy-Enc') === T.ALGO) {
            const nonce = xhr.getResponseHeader('X-Zlapy-Resp-Nonce');
            if (nonce) {
                plain = T.decryptResponse(raw, nonce, zt.envelope.method, zt.envelope.path,
                    zt.envelope.time, xhr.status, zt.envelope.key);
            }
        } else {
            plain = new TextDecoder().decode(raw);
        }
        if (plain === null) return;
        Object.defineProperty(xhr, 'responseText', { value: plain, configurable: true });
        Object.defineProperty(xhr, 'response', { value: plain, configurable: true });
    }

    /* Descifra la respuesta si el servidor la devolvió envuelta. */
    async function openResponse(response, envelope) {
        // Los estados sin cuerpo no llevan sobre: entregarlos tal cual.
        const sinCuerpo = response.status === 204 || response.status === 205 || response.status === 304;
        if (sinCuerpo || response.headers.get('X-Zlapy-Enc') !== T.ALGO) return response;
        const nonce = response.headers.get('X-Zlapy-Resp-Nonce');
        if (!nonce) return response;
        const sealed = new Uint8Array(await response.arrayBuffer());
        const plain = T.decryptResponse(sealed, nonce, envelope.method, envelope.path, envelope.time, response.status, envelope.key);
        if (plain === null) throw new Error('La respuesta del servidor no se pudo descifrar.');
        // Se conservan las cabeceras originales además del Content-Type, y no
        // se descartan sin más.
        const headers = new Headers();
        response.headers.forEach((value, name) => headers.set(name, value));
        headers.set('Content-Type', JSON_TYPE + '; charset=utf-8');
        return new Response(plain, {
            status: response.status,
            statusText: response.statusText,
            headers
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
        if (!key) { transportWarning(); return nativeFetch(input, init); }

        let envelope;
        try { envelope = T.encrypt(method, url.pathname, options.body, key); }
        catch { transportWarning(); return nativeFetch(input, init); }

        headers.set('Content-Type', envelope.headers['Content-Type']);
        headers.set('X-Zlapy-Enc', envelope.headers['X-Zlapy-Enc']);
        headers.set('X-Zlapy-Ephemeral', envelope.headers['X-Zlapy-Ephemeral']);
        headers.set('X-Zlapy-Nonce', envelope.headers['X-Zlapy-Nonce']);
        headers.set('X-Zlapy-Time', envelope.headers['X-Zlapy-Time']);

        const response = await nativeFetch(input, { ...options, headers, body: envelope.body });
        return openResponse(response, envelope);
    };

    /* Permite a la aplicación saber si el cifrado está activo. */

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
                this._zt = { key: null, out: 0, in: 0, queue: [], insecure: false };
                this.addEventListener('open', () => { this._ztStart(); }, { once: true });
            }

            async _ztStart() {
                const key = await loadServerKey();
                if (!key) {
                    // Sin clave se vacía la cola en claro: la app sigue igual,
                    // pero se avisa de que el canal va sin cifrar. Se marca la
                    // conexión como insegura para que los mensajes que lleguen
                    // después no se queden en la cola esperando una clave que
                    // no va a venir (y acaban silenciosamente tirados).
                    this._zt.insecure = true;
                    transportWarning();
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
                if (this._zt.insecure) return super.send(data);
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
