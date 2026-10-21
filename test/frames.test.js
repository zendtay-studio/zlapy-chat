const assert = require('node:assert/strict');
const test = require('node:test');
const { parseFrames, MAX_FRAME_BYTES } = require('../src/realtime/frames.js');

function maskedFrame(opcode, text, { fin = true } = {}) {
    const payload = Buffer.from(text);
    const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
    const header = Buffer.from([(fin ? 0x80 : 0x00) | opcode, 0x80 | payload.length]);
    const maskedPayload = Buffer.from(payload);
    for (let i = 0; i < maskedPayload.length; i++) maskedPayload[i] ^= mask[i % 4];
    return Buffer.concat([header, mask, maskedPayload]);
}

function mockSocket() {
    return {
        writes: [],
        ended: false,
        destroyed: false,
        write(data) { this.writes.push(data); },
        end() { this.ended = true; },
        destroy() { this.destroyed = true; }
    };
}

test('parses a masked text frame split across TCP chunks', () => {
    const socket = mockSocket();
    const received = [];
    const frame = maskedFrame(0x1, '{"type":"typing"}');
    const first = parseFrames(socket, frame.subarray(0, 5), text => received.push(text));

    assert.equal(first.length, 5);
    const rest = parseFrames(socket, Buffer.concat([first, frame.subarray(5)]), text => received.push(text));
    assert.equal(rest.length, 0);
    assert.deepEqual(received, ['{"type":"typing"}']);
});

test('replies to ping with a pong carrying the same payload (RFC 6455)', () => {
    const socket = mockSocket();
    const received = [];
    const frames = Buffer.concat([
        maskedFrame(0x9, 'ping'),
        maskedFrame(0x1, 'hello')
    ]);

    const rest = parseFrames(socket, frames, text => received.push(text));

    assert.equal(rest.length, 0);
    assert.deepEqual(received, ['hello']);
    assert.deepEqual(socket.writes, [Buffer.concat([Buffer.from([0x8a, 4]), Buffer.from('ping')])]);
});

test('ends the socket when receiving a close frame', () => {
    const socket = mockSocket();
    const received = [];

    const rest = parseFrames(socket, maskedFrame(0x8, ''), text => received.push(text));

    assert.equal(rest.length, 0);
    assert.equal(socket.ended, true);
    assert.deepEqual(received, []);
});

test('rejects unmasked client frames (RFC 6455 §5.1)', () => {
    const socket = mockSocket();
    const payload = Buffer.from('{"type":"ping"}');
    const frame = Buffer.from([0x81, payload.length, ...payload]);

    parseFrames(socket, frame, () => { });

    assert.ok(socket.destroyed || socket.ended, 'un frame sin máscara debe cortar la conexión');
    // El close escrito lleva el código 1002 (0x03EA)
    const close = socket.writes.find(w => w.length >= 2 && w[0] === 0x88);
    assert.ok(close, 'debe escribir un frame de close');
    assert.equal(close[2], 0x03);
    assert.equal(close[3], 0xea);
});

test('rejects an oversized declared length with close 1009', () => {
    const socket = mockSocket();
    // len=127 con 8 bytes que declaran 2^40 bytes
    const head = Buffer.alloc(10);
    head[0] = 0x81; head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(1) << BigInt(40), 2);

    parseFrames(socket, Buffer.concat([head, Buffer.alloc(16)]), () => { });

    assert.ok(socket.destroyed || socket.ended, 'un frame gigante declarado debe cortar la conexión');
    const close = socket.writes.find(w => w.length >= 2 && w[0] === 0x88);
    assert.ok(close, 'debe escribir un frame de close');
    assert.equal(close[2], 0x03); // 1009 >> 8
    assert.equal(close[3], 0xf1); // 1009 & 0xff
});

test('rejects a masked frame whose payload exceeds MAX_FRAME_BYTES', () => {
    const socket = mockSocket();
    const huge = Math.min(MAX_FRAME_BYTES + 1, 70000);
    // len=126 con valor > MAX_FRAME_BYTES no se puede: 126 cabe en 16 bits y
    // MAX_FRAME_BYTES es 256 KB. Se usa len=127 con un valor justo por encima.
    const head = Buffer.alloc(10);
    head[0] = 0x81; head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(MAX_FRAME_BYTES) + BigInt(1), 2);

    parseFrames(socket, Buffer.concat([head, Buffer.alloc(8)]), () => { });
    assert.ok(socket.destroyed || socket.ended);
    assert.ok(huge > 0); // (sanity del helper)
});

test('assembles fragmented text messages across parseFrames calls', () => {
    const socket = mockSocket();
    const received = [];
    const part1 = maskedFrame(0x1, '{"type":"ty', { fin: false });
    const part2 = maskedFrame(0x0, 'ping"}', { fin: true });

    let rest = parseFrames(socket, part1, text => received.push(text));
    assert.equal(received.length, 0, 'aún no está completo');
    rest = parseFrames(socket, Buffer.concat([rest, part2]), text => received.push(text));

    assert.equal(rest.length, 0);
    assert.deepEqual(received, ['{"type":"typing"}']);
});

test('rejects a continuation without an initial fragment', () => {
    const socket = mockSocket();
    parseFrames(socket, maskedFrame(0x0, 'huérfano'), () => { });
    assert.ok(socket.destroyed || socket.ended);
});

test('rejects binary frames with close 1003', () => {
    const socket = mockSocket();
    parseFrames(socket, maskedFrame(0x2, 'datos'), () => { });
    assert.ok(socket.destroyed || socket.ended);
    const close = socket.writes.find(w => w.length >= 2 && w[0] === 0x88);
    assert.ok(close);
    assert.equal(close[3], 0xeb); // 1003 & 0xff
});
