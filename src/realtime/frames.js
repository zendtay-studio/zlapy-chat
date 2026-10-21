/**
 * Framing WebSocket (RFC 6455).
 *
 * Implementa el subset que usa Zlapy: el cliente solo envía mensajes de texto
 * y el servidor escribe frames sin máscara. Exige frames enmascarados, acota
 * la longitud y el buffer (close 1009), rechaza frames de control fragmentados
 * o de más de 125 bytes (close 1002), contesta ping y close, ensambla la
 * fragmentación con tope y rechaza los opcodes binarios (close 1003).
 */
'use strict';

const MAX_FRAME_BYTES = 262144;   // 256 KB por frame o mensaje ensamblado
const MAX_BUFFER_BYTES = 786432;  // 768 KB acumulados en el buffer de entrada
const MAX_FRAGMENTS = 4096;       // trozos máximo por mensaje fragmentado

/* Frame de close del servidor → cliente (sin máscara, como manda el RFC). */
function closeFrame(code, reason = '') {
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    return Buffer.concat([Buffer.from([0x88, body.length]), body]);
}

/* Parsea todos los frames completos que quepan en `buf`.
   - onText(textoCompleto) se invoca por cada mensaje de texto completo
     (ensamblando fragmentos si hace falta, con estado en socket._wsFrag).
   - Devuelve el buffer sobrante para el siguiente 'data'.
   - Ante violación de protocolo o de límites escribe un close con el código
     correspondiente y destruye el socket. */
function parseFrames(socket, buf, onText) {
    const fail = (code, reason) => {
        // Marcar el socket como cerrado: el callback del servidor ignora el
        // resto de frames que ya venían en el mismo buffer.
        socket.wsKilled = true;
        // Escribir el close y cerrar con end() para que el frame llegue antes
        // de cortar el TCP; destroy() inmediato puede descartar la cola.
        try { socket.write(closeFrame(code, reason)); } catch { }
        try { socket.end(); } catch { }
        const backstop = setTimeout(() => { try { socket.destroy(); } catch { } }, 2000);
        if (typeof backstop.unref === 'function') backstop.unref();
        return Buffer.alloc(0);
    };

    while (buf.length >= 2) {
        if (buf.length > MAX_BUFFER_BYTES) return fail(1009, 'buffer excedido');

        const b0 = buf[0], b1 = buf[1];
        const fin = !!(b0 & 0x80);
        const opcode = b0 & 0x0f;
        const masked = !!(b1 & 0x80);
        if (!masked) return fail(1002, 'frames del cliente deben venir enmascarados');
        if (!fin && opcode >= 0x8) return fail(1002, 'frame de control fragmentado');

        let len = b1 & 0x7f, off = 2;
        if (len === 126) {
            if (buf.length < 4) break;
            len = buf.readUInt16BE(2);
            off = 4;
        } else if (len === 127) {
            if (buf.length < 10) break;
            const wideLength = buf.readBigUInt64BE(2);
            if (wideLength > BigInt(MAX_FRAME_BYTES)) return fail(1009, 'payload demasiado grande');
            len = Number(wideLength);
            off = 10;
        }
        if (len > MAX_FRAME_BYTES) return fail(1009, 'payload demasiado grande');

        const maskOff = 4; // ya se exigió máscara
        if (buf.length < off + maskOff + len) break; // esperar más datos

        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + maskOff, off + maskOff + len));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buf = buf.subarray(off + maskOff + len);

        if (opcode >= 0x8) {
            if (len > 125) return fail(1002, 'frame de control demasiado grande');
            if (opcode === 0x8) { // close: responder el handshake y cerrar
                const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
                try { socket.write(closeFrame(code === 1005 ? 1000 : code)); } catch { }
                try { socket.end(); } catch { }
                return buf;
            }
            if (opcode === 0x9) { // ping → pong con el mismo payload
                try { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); } catch { }
                continue;
            }
            continue; // pong del cliente: ignorar
        }
        if (opcode === 0x2) return fail(1003, 'solo se aceptan mensajes de texto');
        if (opcode === 0x0) { // continuación de un mensaje fragmentado
            const frag = socket._wsFrag;
            if (!frag) return fail(1002, 'continuación sin mensaje inicial');
            // Tamaño acumulado en O(1): recalcular la suma de las partes en
            // cada fragmento es O(k²), y un solo mensaje de 256 KB en miles
            // de trozos bloquearía el event loop del servidor (y con él a
            // todos los usuarios) durante segundos.
            frag.size += payload.length;
            if (frag.size > MAX_FRAME_BYTES) { socket._wsFrag = null; return fail(1009, 'mensaje fragmentado demasiado grande'); }
            if (frag.parts.length >= MAX_FRAGMENTS) { socket._wsFrag = null; return fail(1009, 'demasiados fragmentos'); }
            frag.parts.push(payload);
            if (fin) {
                socket._wsFrag = null;
                onText(Buffer.concat(frag.parts).toString());
            }
            continue;
        }
        if (opcode === 0x1) { // texto
            if (!fin) { socket._wsFrag = { parts: [payload], size: payload.length }; continue; }
            onText(payload.toString());
            continue;
        }
        return fail(1002, 'opcode reservado');
    }
    return buf;
}

module.exports = { parseFrames, closeFrame, MAX_FRAME_BYTES, MAX_BUFFER_BYTES, MAX_FRAGMENTS };
