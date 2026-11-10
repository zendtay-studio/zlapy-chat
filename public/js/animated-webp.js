(function (global, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else global.AnimatedWebP = api;
})(globalThis, function () {
    'use strict';

    const MAX_FRAMES = 300;

    function ascii(value) {
        return Uint8Array.from(value, char => char.charCodeAt(0));
    }

    function write24(bytes, offset, value) {
        bytes[offset] = value & 0xff;
        bytes[offset + 1] = (value >>> 8) & 0xff;
        bytes[offset + 2] = (value >>> 16) & 0xff;
    }

    function chunk(type, data) {
        const paddedLength = data.length + (data.length & 1);
        const result = new Uint8Array(8 + paddedLength);
        result.set(ascii(type), 0);
        new DataView(result.buffer).setUint32(4, data.length, true);
        result.set(data, 8);
        return result;
    }

    function concat(parts) {
        const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
        let offset = 0;
        for (const part of parts) {
            result.set(part, offset);
            offset += part.length;
        }
        return result;
    }

    function imageChunks(bytes) {
        if (!(bytes instanceof Uint8Array) || bytes.length < 20 ||
            String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' ||
            String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP' ||
            new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) !== bytes.length - 8)
            throw new Error('El navegador no generó un fotograma WebP válido.');

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const result = [];
        let hasAlpha = false;
        for (let offset = 12; offset + 8 <= bytes.length;) {
            const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
            const size = view.getUint32(offset + 4, true);
            const end = offset + 8 + size;
            if (end + (size & 1) > bytes.length) throw new Error('El fotograma WebP está incompleto.');
            if (type === 'ALPH' || type === 'VP8L') hasAlpha = true;
            if (type === 'ALPH' || type === 'VP8 ' || type === 'VP8L')
                result.push(bytes.subarray(offset, end + (size & 1)));
            offset = end + (size & 1);
        }
        if (!result.some(part => {
            const type = String.fromCharCode(...part.subarray(0, 4));
            return type === 'VP8 ' || type === 'VP8L';
        })) throw new Error('El fotograma no contiene una imagen WebP compatible.');
        return { chunks: result, hasAlpha };
    }

    function mux(frames, width, height, loop = 0) {
        if (!Array.isArray(frames) || !frames.length || frames.length > MAX_FRAMES)
            throw new Error(`La animación debe contener entre 1 y ${MAX_FRAMES} fotogramas.`);
        if (!Number.isInteger(width) || !Number.isInteger(height) ||
            width < 1 || height < 1 || width > 0x1000000 || height > 0x1000000)
            throw new Error('Las dimensiones de la animación WebP no son válidas.');
        if (!Number.isInteger(loop) || loop < 0 || loop > 0xffff)
            throw new Error('El número de repeticiones de WebP no es válido.');

        const parsedFrames = frames.map(frame => {
            if (!Number.isInteger(frame.duration) || frame.duration < 1 || frame.duration > 0xffffff)
                throw new Error('La duración de un fotograma WebP no es válida.');
            return { ...imageChunks(frame.bytes), duration: frame.duration };
        });
        const hasAlpha = parsedFrames.some(frame => frame.hasAlpha);
        const extendedHeader = new Uint8Array(10);
        extendedHeader[0] = 0x02 | (hasAlpha ? 0x10 : 0);
        write24(extendedHeader, 4, width - 1);
        write24(extendedHeader, 7, height - 1);
        const animationHeader = new Uint8Array(6);
        new DataView(animationHeader.buffer).setUint16(4, loop, true);
        const animationFrames = parsedFrames.map(frame => {
            const frameHeader = new Uint8Array(16);
            write24(frameHeader, 6, width - 1);
            write24(frameHeader, 9, height - 1);
            write24(frameHeader, 12, frame.duration);
            frameHeader[15] = 0x02;
            return chunk('ANMF', concat([frameHeader, ...frame.chunks]));
        });
        const body = concat([
            ascii('WEBP'),
            chunk('VP8X', extendedHeader),
            chunk('ANIM', animationHeader),
            ...animationFrames
        ]);
        const header = new Uint8Array(8);
        header.set(ascii('RIFF'), 0);
        new DataView(header.buffer).setUint32(4, body.length, true);
        return concat([header, body]);
    }

    return { mux, MAX_FRAMES };
});
