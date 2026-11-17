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
 * memoria. Si el servidor NO ofrece clave de transporte, la peticion sale sin
 * cifrar (es una instalacion sin esa capa) pero con un aviso persistente en
 * pantalla. Si la clave existe y el cifrado o la entropia fallan, la peticion
 * se ABORTA: nunca se degrada a claro en silencio. */
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
       situación es estable y no se vuelve a preguntar. Un fallo de red NO se
       cachea: la promesa se rechaza para que esta petición se aborte y la
       siguiente pueda reintentar. */
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
                .finally(() => { keyRequest = null; });
        }
        return keyRequest;
    }

    /* Aviso de degradación: visible y persistente. La barra se crea aquí para
       que también exista en páginas que no traen su propio manejador (por
       ejemplo, el creador de stickers). */
    let avisado = false;
    function showInsecureBanner() {
        if (typeof document === 'undefined') return;
        const paint = () => {
            if (!document.body || document.getElementById('tlsWarn')) return;
            const bar = document.createElement('div');
            bar.id = 'tlsWarn';
            bar.setAttribute('role', 'status');
            bar.textContent = 'Conexión sin cifrar de transporte: usa HTTPS para proteger tus mensajes en tránsito.';
            bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:8px 12px;' +
                'background:#b3261e;color:#fff;font:500 13px/1.4 system-ui,sans-serif;text-align:center';
            document.body.appendChild(bar);
        };
        if (document.body) paint();
        else document.addEventListener('DOMContentLoaded', paint, { once: true });
    }
    function transportWarning() {
        if (avisado) return;
        avisado = true;
        try { global.dispatchEvent(new CustomEvent('zlapy-transport-insecure')); } catch (e) { }
        showInsecureBanner();
        console.warn('[transporte] El servidor no ofreció clave de cifrado: las peticiones salen sin cifrar.');
    }
    global.ZlapyTransportWarning = transportWarning;

    /* Error de canal: se lanza en vez de enviar contenido privado en claro
       cuando la clave ya existía pero el sobre no se pudo construir. */
    function transportFailure() {
        return new Error('No se pudo cifrar la petición: se canceló para no enviarla en claro.');
    }

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
                if (!k) {
                    // Sin clave ofrecida por el servidor: claro + aviso.
                    if (noKeyOnServer) { transportWarning(); return nativeSend.call(this, body); }
                    // Falló la consulta de la clave: no se degrada a claro.
                    try { this.abort(); } catch { }
                    return;
                }
                let envelope;
                try { envelope = T.encrypt(zt.method, absolute.pathname, body, k); }
                catch { try { this.abort(); } catch { } return; }
                for (const name of ['Content-Type', 'X-Zlapy-Enc', 'X-Zlapy-Ephemeral', 'X-Zlapy-Nonce', 'X-Zlapy-Time'])
                    nativeSetHeader.call(this, name, envelope.headers[name]);
                zt.envelope = envelope;
                /* La respuesta llega cifrada: hay que leerla como binario para
                   poder abrirla después. */
                try { this.responseType = 'arraybuffer'; } catch { }
                nativeSend.call(this, envelope.body);
            }).catch(() => {
                // Red caída al pedir la clave: misma política de fallo cerrado.
                try { this.abort(); } catch { }
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
        if (!key) {
            if (noKeyOnServer) { transportWarning(); return nativeFetch(input, init); }
            // No se sabe si el servidor tiene clave (fallo de /config): se
            // aborta en vez de arriesgar un envío en claro.
            throw transportFailure();
        }

        let envelope;
        try { envelope = T.encrypt(method, url.pathname, options.body, key); }
        catch { throw transportFailure(); }

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
     * ahí todos los frames llevan el prefijo `z1:`. Si el servidor no ofrece
     * clave de transporte se sigue en claro (con aviso persistente); si la
     * clave existía y el cifrado falla, la conexión se CIERRA en vez de
     * degradar el canal en silencio. */
    const NativeWebSocket = global.WebSocket;
    if (NativeWebSocket) {
        class SecureWebSocket extends NativeWebSocket {
            constructor(url, protocols) {
                super(url, protocols);
                this._zt = { key: null, out: 0, in: 0, queue: [], insecure: false };
                this.addEventListener('open', () => { this._ztStart(); }, { once: true });
            }

            async _ztStart() {
                let key;
                try { key = await loadServerKey(); }
                catch { try { this.close(); } catch { } return; }
                if (!key) {
                    // Solo se habla en claro cuando /config respondió SIN
                    // clave. Un fallo al consultarla se trata como error de
                    // canal: cerrar es preferible a exponer los frames.
                    if (!noKeyOnServer) { try { this.close(); } catch { } return; }
                    this._zt.insecure = true;
                    transportWarning();
                    for (const text of this._zt.queue.splice(0)) super.send(text);
                    return;
                }
                if (this.readyState !== NativeWebSocket.OPEN) { this._zt.queue.length = 0; return; }
                let session;
                try { session = T.wsKey(T.randomBytes(32), T.fromBase64(key)); }
                catch { try { this.close(); } catch { } return; }
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
