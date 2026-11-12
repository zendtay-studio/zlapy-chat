'use strict';

/*
 * Genera el paquete bbot-v3 como WebP animados
 * con transparencia usando el motor de animación real de @bwnd/bbot
 * (https://github.com/bwndapp/bbot — licencia MIT, ver
 * public/js/vendor/BBOT-LICENSE.txt). No se repite una pose a mano: el
 * script replica el bucle `frame` del renderizador de su web (muelles
 * k/d idénticos, deambular de la mirada con su misma estadística,
 * parpadeos con la condición expresa de los ojos ya cerrados y las
 * reacciones wink/nod/shake/bounce/pop/boing/spin/jitter) y dibuja cada
 * fotograma con la misma geometría de esfera y párpados. Cada expresión se
 * procesa completa antes de comenzar la siguiente e informa el avance por
 * fotograma. Rasteriza y codifica con módulos WebAssembly portables, sin
 * depender de ejecutables nativos del sistema.
 *
 *   node ops/data/generate-animated-bbot-pack.js <directorio-de-salida>
 *
 * Los fotogramas se rasterizan con alfa y se conmutan en un WebP animado,
 * validando fotogramas, alfa, tamaño y cabecera antes de sustituir los
 * archivos del paquete. La agenda de cada cara es
 * determinista (PRNG con semilla por expresión), así que dos
 * regeneraciones del mismo código producen los mismos bytes.
 *
 * El recorte circular del párpado (disco ∩ semiplano) se calcula aquí y sale
 * como polígono (cuerda exacta + arco muestreado a 4°).
 */

const fs = require('node:fs');
const path = require('node:path');

/* ------------------------------------------------------- pack y formato */

const OUTPUT_SIZE = 256; // px. El paquete siempre ha sido cuadrado de 256.
const FRAME_MS = 50;     // 50 ms = 20 fps (delay = 5 centésimas de segundo)
const FRAMES = 140;      // 7 segundos por expresión
const LOOP_SECONDS = (FRAMES * FRAME_MS) / 1000;
const MAX_BYTES = 8 * 1024 * 1024;
const WEBP_QUALITY = 100;
const WEBP_METHOD = 0;
let imageProcessorPromise;

/* Paleta por defecto de la web de bbot (face.css):
 *   --face-skin #17191c · --face-ink #f7f9f9 · anillo transparente.
 * Sin boca y sin pupilas, igual que el demo de bbot.bwnd.app. */
const SKIN = '#17191c';
const INK = '#f7f9f9';
const LID_RADIUS = 12.6; // eyeR + clipPad: el disco al que bbot recorta los párpados

/* ------------------------------------------------------------------ bbot */

/* Datos verbatim de src/expressions.js de @bwnd/bbot (MIT). Cada campo es
 * el objetivo de un muelle; anima en vez de saltar. */
const EXPRESSIONS = {
    idle: { lidT: 0, lidB: 0, lidSkew: 0, scaleSkew: 0, tilt: 0, eyeScale: 1, squashY: 1, gap: 1, eyeY: 0, head: 0, gazeX: 0, gazeY: 0, mouth: 0.1, open: 0, track: 1 },
    content: { lidT: 0.1, lidB: 0.2, lidSkew: 0, scaleSkew: 0, tilt: 0, eyeScale: 0.96, squashY: 1, gap: 0.98, eyeY: 1, head: 3, gazeX: 0, gazeY: 0.16, mouth: 0.55, open: 0, track: 0.55 },
    relieved: { lidT: 0, lidB: 0.34, lidSkew: 0, scaleSkew: 0, tilt: -5, eyeScale: 1.06, squashY: 0.72, gap: 0.98, eyeY: 2, head: 9, gazeX: 0, gazeY: 0.12, mouth: 0.62, open: 0.14, track: 0.4 },
    happy: { lidT: 0, lidB: 0.44, lidSkew: 0, scaleSkew: 0, tilt: 0, eyeScale: 1.06, squashY: 1, gap: 1, eyeY: 1, head: 0, gazeX: 0, gazeY: 0, mouth: 0.85, open: 0, track: 0.85 },
    joy: { lidT: 0.16, lidB: 0.6, lidSkew: 0, scaleSkew: 0, tilt: 0, eyeScale: 1.22, squashY: 1, gap: 1.05, eyeY: 2, head: 0, gazeX: 0, gazeY: 0, mouth: 1, open: 0.35, track: 0.4 },
    excited: { lidT: 0, lidB: 0, lidSkew: 0, scaleSkew: 0, tilt: 0, eyeScale: 1.24, squashY: 1, gap: 1.07, eyeY: -2, head: 0, gazeX: 0, gazeY: 0, mouth: 1, open: 0.5, track: 1.25 },
    love: { lidT: 0, lidB: 0.12, lidSkew: 0, scaleSkew: 0, tilt: 0, eyeScale: 1.26, squashY: 1, gap: 1.02, eyeY: 1, head: 9, gazeX: 0, gazeY: 0.1, mouth: 0.95, open: 0, track: 0.55 },
    pleading: { lidT: 0, lidB: 0.16, lidSkew: 0, scaleSkew: 0, tilt: -9, eyeScale: 1.3, squashY: 1, gap: 0.9, eyeY: 1, head: 7, gazeX: 0, gazeY: -0.3, mouth: 0.3, open: 0, track: 0.85 },
    shy: { lidT: 0.34, lidB: 0.2, lidSkew: 0.1, scaleSkew: 0, tilt: -6, eyeScale: 0.98, squashY: 1, gap: 0.96, eyeY: 1, head: 12, gazeX: -0.5, gazeY: 0.26, mouth: 0.45, open: 0, track: 0.35 },
    surprised: { lidT: 0, lidB: 0, lidSkew: 0, scaleSkew: 0, tilt: 0, eyeScale: 1.3, squashY: 1, gap: 1.02, eyeY: -1, head: 0, gazeX: 0, gazeY: 0, mouth: 0, open: 0.95, track: 1 },
    scared: { lidT: 0.16, lidB: 0.04, lidSkew: 0, scaleSkew: 0, tilt: -22, eyeScale: 1.26, squashY: 1, gap: 0.86, eyeY: -1, head: 0, gazeX: 0, gazeY: 0.12, mouth: -0.6, open: 0.55, track: 1.3 },
    curious: { lidT: 0, lidB: 0, lidSkew: 0.12, scaleSkew: 0, tilt: 0, eyeScale: 1.08, squashY: 1, gap: 1, eyeY: 0, head: 9, gazeX: 0, gazeY: -0.22, mouth: 0.35, open: 0.1, track: 1 },
    confused: { lidT: 0, lidB: 0, lidSkew: 0.1, scaleSkew: -0.18, tilt: 0, eyeScale: 1, squashY: 1, gap: 1, eyeY: 0, head: 13, gazeX: 0.22, gazeY: -0.2, mouth: -0.1, open: 0, track: 0.7 },
    dizzy: { lidT: 0, lidB: 0, lidSkew: 0, scaleSkew: 0.42, tilt: 0, eyeScale: 1.06, squashY: 1, gap: 1.04, eyeY: 0, head: 13, gazeX: -0.15, gazeY: 0.08, mouth: 0.15, open: 0.32, track: 0.15 },
    thinking: { lidT: 0.22, lidB: 0, lidSkew: 0, scaleSkew: 0, tilt: 0, eyeScale: 1, squashY: 1, gap: 1, eyeY: 0, head: 6, gazeX: 0.55, gazeY: -0.5, mouth: 0.1, open: 0, track: 0.12 },
    focus: { lidT: 0.32, lidB: 0.28, lidSkew: 0, scaleSkew: 0, tilt: 0, eyeScale: 1.05, squashY: 1, gap: 0.94, eyeY: 0, head: 0, gazeX: 0, gazeY: 0, mouth: 0, open: 0, track: 1.25 },
    suspicious: { lidT: 0.3, lidB: 0.22, lidSkew: 0.24, scaleSkew: 0, tilt: 6, eyeScale: 1, squashY: 1, gap: 0.96, eyeY: 0, head: -5, gazeX: 0, gazeY: 0, mouth: -0.25, open: 0, track: 1 },
    unimpressed: { lidT: 0, lidB: 0, lidSkew: 0, scaleSkew: 0, tilt: 0, eyeScale: 1.04, squashY: 0.42, gap: 1, eyeY: 0, head: 0, gazeX: 0, gazeY: 0, mouth: -0.08, open: 0, track: 0.9 },
    smug: { lidT: 0.34, lidB: 0, lidSkew: 0.16, scaleSkew: 0, tilt: 8, eyeScale: 1, squashY: 1, gap: 1, eyeY: 0, head: 6, gazeX: 0.38, gazeY: 0, mouth: 0.55, open: 0, track: 0.5 },
    sly: { lidT: 0.28, lidB: 0.36, lidSkew: 0, scaleSkew: 0, tilt: 7, eyeScale: 1, squashY: 1, gap: 1, eyeY: 0, head: 0, gazeX: 0.42, gazeY: 0, mouth: 0.7, open: 0, track: 0.45 },
    bored: { lidT: 0.46, lidB: 0, lidSkew: 0, scaleSkew: 0, tilt: 0, eyeScale: 1, squashY: 1, gap: 1, eyeY: 0, head: 4, gazeX: -0.62, gazeY: 0.16, mouth: -0.2, open: 0, track: 0.18 },
    exasperated: { lidT: 0.5, lidB: 0, lidSkew: 0, scaleSkew: 0, tilt: 0, eyeScale: 1.02, squashY: 1, gap: 1, eyeY: 0, head: 0, gazeX: 0.1, gazeY: -0.72, mouth: -0.28, open: 0, track: 0.15 },
    worried: { lidT: 0.22, lidB: 0, lidSkew: 0, scaleSkew: 0, tilt: -14, eyeScale: 1.06, squashY: 1, gap: 0.97, eyeY: 1, head: 0, gazeX: 0, gazeY: 0, mouth: -0.45, open: 0, track: 0.9 },
    guilty: { lidT: 0.38, lidB: 0.1, lidSkew: 0, scaleSkew: 0, tilt: -12, eyeScale: 0.96, squashY: 1, gap: 0.97, eyeY: 2, head: -8, gazeX: -0.42, gazeY: 0.4, mouth: -0.4, open: 0, track: 0.3 },
    sad: { lidT: 0.34, lidB: 0, lidSkew: 0, scaleSkew: 0, tilt: -20, eyeScale: 1.02, squashY: 1, gap: 1, eyeY: 2, head: 0, gazeX: 0, gazeY: 0, mouth: -0.75, open: 0, track: 0.7 },
    disgusted: { lidT: 0.3, lidB: 0.2, lidSkew: 0.16, scaleSkew: -0.1, tilt: 9, eyeScale: 1.02, squashY: 0.82, gap: 0.94, eyeY: 0, head: -7, gazeX: -0.2, gazeY: 0, mouth: -0.7, open: 0.18, track: 0.6 },
    annoyed: { lidT: 0.5, lidB: 0.05, lidSkew: 0, scaleSkew: 0, tilt: 10, eyeScale: 1, squashY: 1, gap: 0.96, eyeY: 0, head: -4, gazeX: 0, gazeY: 0, mouth: -0.3, open: 0, track: 1.05 },
    angry: { lidT: 0.42, lidB: 0, lidSkew: 0, scaleSkew: 0, tilt: 22, eyeScale: 1, squashY: 1, gap: 0.94, eyeY: 0, head: 0, gazeX: 0, gazeY: 0, mouth: -0.55, open: 0, track: 1.15 },
    sleepy: { lidT: 0.6, lidB: 0.05, lidSkew: 0, scaleSkew: 0, tilt: -4, eyeScale: 1, squashY: 1, gap: 1, eyeY: 2, head: 5, gazeX: 0, gazeY: 0.2, mouth: -0.15, open: 0.15, track: 0.45 },
    sleep: { lidT: 0.5, lidB: 0.5, lidSkew: 0, scaleSkew: 0, tilt: 0, eyeScale: 1, squashY: 1, gap: 1, eyeY: 2, head: 6, gazeX: 0, gazeY: 0, mouth: 0.1, open: 0.1, track: 0 },
};

const TAU = Math.PI * 2;
const easeInOut = p => (p < .5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p));

/* Reacciones verbatim de src/expressions.js: `apply(p, o)` corre por
 * fotograma con p 0 → 1 sobre `o`, la bolsa de desplazamientos. */
const REACTIONS = {
    blink: { dur: .26, apply: (p, o) => { o.blink = Math.max(o.blink, Math.sin(p * Math.PI) ** .55); } },
    wink: { dur: .42, apply: (p, o) => { o.winkR = Math.max(o.winkR, Math.sin(p * Math.PI) ** .55); } },
    nod: { dur: .72, apply: (p, o) => { o.hy += Math.sin(p * TAU * 1.5) * 7 * (1 - p); } },
    shake: { dur: .72, apply: (p, o) => { o.hx += Math.sin(p * TAU * 2) * 7 * (1 - p); } },
    bounce: {
        dur: .85,
        apply: (p, o) => {
            const e = Math.sin(p * TAU) * (1 - p);
            o.hy -= Math.abs(e) * 13;
            o.sy += e * .13;
            o.sx -= e * .13;
        }
    },
    pop: {
        dur: .5,
        apply: (p, o) => {
            const e = Math.sin(p * Math.PI) * (1 - p * .4);
            o.sx += e * .17;
            o.sy += e * .17;
        }
    },
    boing: {
        dur: .95,
        apply: (p, o) => {
            const e = Math.sin(p * TAU * 2.2) * Math.exp(-p * 4);
            o.sy += e * .24;
            o.sx -= e * .24;
        }
    },
    spin: { dur: .95, apply: (p, o) => { o.rot += easeInOut(p) * 360; } },
    jitter: {
        dur: .5,
        apply: (p, o) => {
            const d = 1 - p;
            o.hx += Math.sin(p * 79) * 2.2 * d;
            o.hy += Math.cos(p * 67) * 2.2 * d;
        }
    },
};

/* Geometría verbatim del objeto G de src/core.js (viewBox de −50 a 50). */
const G = {
    headR: 46,
    eyeX: 19,
    eyeY: -3,
    eyeR: 12,
    turn: .36,
    lean: 1.8,
    clipPad: .6,
    lidSlack: 1,
    pupilR: 4.6,
    pupilTravel: 4.2,
    mouthY: 20,
    talkHold: .5,
    mouthW: 14,
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ------------------------------------------------------- muelles (bbot) */

function spring(value, k, d) {
    return { x: value, v: 0, to: value, k, d };
}

function advance(s, dt) {
    s.v += ((s.to - s.x) * s.k - s.v * s.d) * dt;
    s.x += s.v * dt;
    return s.x;
}

/* ---------------------------------------------------- esfera de la cara */

const hit = { x: 0, y: 0, squash: 1, phi: 0 };

function project(px, py, cosYaw, sinYaw, cosPitch, sinPitch) {
    const pz = Math.sqrt(Math.max(G.headR * G.headR - px * px - py * py, 1));
    const x1 = px * cosYaw + pz * sinYaw;
    const z1 = pz * cosYaw - px * sinYaw;
    hit.x = x1;
    hit.y = py * cosPitch - z1 * sinPitch;
    const z2 = py * sinPitch + z1 * cosPitch;
    hit.squash = clamp(z2 / pz, .25, 1);
    hit.phi = Math.atan2(hit.y, x1) * 180 / Math.PI;
    return hit;
}

/* ---------------------------------------------------- azar reproducible */

/* La web usa Math.random() para programar el deambular de la mirada y los
 * parpadeos. Para un sticker el bucle debe cerrarse y las regeneraciones
 * deben producir los mismos bytes, así que la agenda sale de un PRNG con
 * semilla por expresión, con la misma estadística que aim(): dirección
 * dentro de ±0.9/±0.6, 30% al centro y segundo parpadeo con 24% de
 * probabilidad. */
function hashSeed(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function mulberry32(seed) {
    let state = seed >>> 0;
    return function next() {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/* Reacción por expresión, tomada del propio vocabulario de reacciones de
 * @bwnd/bbot y con el mismo carácter que el demo de su web. */
const REACTION_BY_EXPRESSION = {
    idle: 'blink',
    content: 'nod',
    relieved: 'nod',
    happy: 'bounce',
    joy: 'boing',
    excited: 'bounce',
    love: 'bounce',
    pleading: 'nod',
    shy: 'blink',
    surprised: 'pop',
    scared: 'jitter',
    curious: 'pop',
    confused: 'shake',
    dizzy: 'spin',
    thinking: 'nod',
    focus: 'blink',
    suspicious: 'shake',
    unimpressed: 'wink',
    smug: 'wink',
    sly: 'wink',
    bored: 'wink',
    exasperated: 'shake',
    worried: 'jitter',
    guilty: 'jitter',
    sad: 'blink',
    disgusted: 'shake',
    annoyed: 'shake',
    angry: 'shake',
    sleepy: 'blink',
    sleep: 'blink',
};

/* -------------------------------------------------------------- agenda */

function buildSchedule(expression) {
    const random = mulberry32(hashSeed(`bbot-v3:${expression}`));
    const stops = [];
    while (stops.length < 6) {
        const stop = random() < .3
            ? { x: 0, y: 0 }
            : { x: (random() * 2 - 1) * .9, y: (random() * 2 - 1) * .6 };
        if (stops.some(item => Math.hypot(item.x - stop.x, item.y - stop.y) < .25)) continue;
        stops.push(stop);
    }
    const wander = stops.map((stop, index) => ({
        t: .04 + index * (LOOP_SECONDS - .8) / stops.length,
        x: stop.x,
        y: stop.y
    }));
    wander.push({ t: LOOP_SECONDS - .12, x: 0, y: 0 });

    const blinkCount = 5 + Math.floor(random() * 2);
    const blinkSpacing = (LOOP_SECONDS - 1) / blinkCount;
    const blinks = Array.from({ length: blinkCount }, (_, index) =>
        .45 + index * blinkSpacing + (random() - .5) * .24);
    const reactions = [];
    let previousReaction = REACTION_BY_EXPRESSION[expression] || 'blink';
    reactions.push({ t: .28, name: previousReaction });
    let reactionTime = 1.05 + random() * .2;
    while (reactionTime < LOOP_SECONDS - 1) {
        const choices = Object.keys(REACTIONS).filter(name => name !== previousReaction);
        const name = choices[Math.floor(random() * choices.length)];
        reactions.push({ t: reactionTime, name });
        previousReaction = name;
        reactionTime += .95 + random() * .5;
    }
    return {
        wander,
        blinks,
        reactions
    };
}

/* --------------------------------------------------------- simulación */

const SIM_HZ = 120;                 // paso interno de integración
const WARMUP_LOOP_TIMES = 2;        // simula dos bucles y publica el último

function simulate(expression) {
    const schedule = buildSchedule(expression);
    const preset = EXPRESSIONS[expression] || EXPRESSIONS.idle;
    const gaze = { x: spring(0, 150, 19), y: spring(0, 150, 19) };
    const shape = {};
    for (const key in EXPRESSIONS.idle) shape[key] = spring(EXPRESSIONS.idle[key], 190, 24);
    for (const key in preset) {
        if (shape[key]) {
            shape[key].x = preset[key];
            shape[key].to = preset[key];
        }
    }

    const dt = 1 / SIM_HZ;
    const stepsPerFrame = Math.round(FRAME_MS / 1000 / dt);
    if (!Number.isInteger(stepsPerFrame) || stepsPerFrame < 1)
        throw new Error(`FRAME_MS ${FRAME_MS} no cabe en la simulación a ${SIM_HZ} Hz.`);

    /* Agenda absoluta: WARMUP bucles con los mismos eventos para que el
     * último salga con el estado residual de un vorheriger periodo ya
     * rodado y el bucle cierre limpio. */
    const events = [];
    for (let period = 0; period < WARMUP_LOOP_TIMES; period++) {
        for (const time of schedule.blinks)
            events.push({ at: period * LOOP_SECONDS + time, def: REACTIONS.blink });
        for (const reaction of schedule.reactions)
            events.push({ at: period * LOOP_SECONDS + reaction.t, def: REACTIONS[reaction.name] });
    }
    events.sort((a, b) => a.at - b.at);

    const periodSteps = FRAMES * stepsPerFrame;
    const totalSteps = periodSteps * WARMUP_LOOP_TIMES;
    const active = [];
    let nextEvent = 0;
    const frames = [];

    for (let step = 0; step <= totalSteps; step++) {
        const now = step * dt;

        while (nextEvent < events.length && events[nextEvent].at <= now) {
            const event = events[nextEvent++];
            if (event.def === REACTIONS.blink && shape.lidT.to + shape.lidB.to >= .9)
                continue; // mismo criterio que la web: ojos ya cerrados no parpadean
            active.push({ def: event.def, t: now - event.at });
        }

        const loopTime = now % LOOP_SECONDS;
        let target = { x: 0, y: 0 };
        for (const stop of schedule.wander)
            if (loopTime >= stop.t) target = stop;

        const strength = shape.track.x;
        gaze.x.to = clamp(target.x * strength + shape.gazeX.x, -1.15, 1.15);
        gaze.y.to = clamp(target.y * strength + shape.gazeY.x, -1.15, 1.15);
        const gx = advance(gaze.x, dt);
        const gy = advance(gaze.y, dt);
        for (const key in shape) advance(shape[key], dt);

        const o = { hx: 0, hy: 0, rot: 0, sx: 1, sy: 1, blink: 0, winkR: 0 };
        for (let index = active.length - 1; index >= 0; index--) {
            const reaction = active[index];
            reaction.t += dt;
            const p = reaction.t / reaction.def.dur;
            if (p >= 1) { active.splice(index, 1); continue; }
            reaction.def.apply(p, o);
        }

        const isSample = step % stepsPerFrame === 0 && step >= totalSteps - periodSteps;
        if (isSample) {
            const cosYaw = Math.cos(gx * G.turn);
            const sinYaw = Math.sin(gx * G.turn);
            const cosPitch = Math.cos(-gy * G.turn);
            const sinPitch = Math.sin(-gy * G.turn);
            const lidT = clamp(shape.lidT.x, 0, 1);
            const lidB = clamp(shape.lidB.x, 0, 1);
            const eyes = [1, -1].map(side => {
                const shut = side > 0 ? Math.max(o.blink, o.winkR) : o.blink;
                const lidTop = clamp(lidT + (side > 0 ? shape.lidSkew.x : 0), 0, 1);
                const skewed = shape.eyeScale.x * (side > 0 ? 1 + shape.scaleSkew.x : 1);
                const at = project(
                    side * G.eyeX * shape.gap.x,
                    G.eyeY + shape.eyeY.x,
                    cosYaw, sinYaw, cosPitch, sinPitch
                );
                return {
                    side,
                    project: { x: at.x, y: at.y, squash: at.squash, phi: at.phi },
                    eyeSx: skewed,
                    eyeSy: skewed * shape.squashY.x * (1 - shut * .94),
                    spin: -side * shape.tilt.x,
                    top: -G.eyeR + lidTop * (2 * G.eyeR + G.lidSlack),
                    bottom: G.eyeR - lidB * (2 * G.eyeR + G.lidSlack)
                };
            });
            frames.push({
                hx: o.hx + gx * G.lean,
                hy: o.hy + gy * G.lean,
                rot: o.rot + shape.head.x,
                headScaleX: o.sx,
                headScaleY: o.sy,
                eyes
            });
        }
    }
    const publishStart = frames.length - FRAMES;
    return frames.slice(publishStart);
}

/* --------------------------------------------------------------- SVG */

function eyeTransform(eye) {
    const p = eye.project;
    return `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})` +
        ` rotate(${p.phi.toFixed(2)}) scale(${p.squash.toFixed(3)} 1) rotate(${(-p.phi).toFixed(2)})` +
        ` scale(${eye.eyeSx.toFixed(3)} ${Math.max(eye.eyeSy, .001).toFixed(3)})`;
}

const circlePolygon = radius => Array.from({ length: 64 }, (_, index) => {
    const theta = index / 64 * TAU;
    return `${index ? 'L' : 'M'} ${(radius * Math.cos(theta)).toFixed(2)} ${(radius * Math.sin(theta)).toFixed(2)}`;
}).join(' ') + ' Z';

/* Párpado: disco ∩ semiplano en coordenadas locales del ojo. En la web un
 * rect con clip-path cubre p·ŷ ≤ 0 (superior) o p·ŷ ≥ 0 (inferior) tras
 * rotate(spin) translate(0, cut): equivale al disco de radio
 * LID_RADIUS cortado por la línea con normal (sin spin, cos spin) a paso
 * `cut`. Devuelve `M p1 (arco muestreado a 4°) p2 Z`, con la cuerda
 * exacta como borde recto. */
function lidPath(spinDeg, cut, below) {
    const angle = spinDeg * Math.PI / 180;
    const nx = Math.sin(angle);
    const ny = Math.cos(angle);
    const sign = below ? -1 : 1; // cubierto ⇔ sign·(n·q − cut) ≤ 0
    const coveredNone = below ? cut >= LID_RADIUS : cut <= -LID_RADIUS;
    const coveredAll = below ? cut <= -LID_RADIUS : cut >= LID_RADIUS;
    if (coveredNone) return '';
    if (coveredAll) return circlePolygon(LID_RADIUS);

    const s = Math.sqrt(Math.max(LID_RADIUS * LID_RADIUS - cut * cut, 0));
    const p1 = { x: nx * cut + s * ny, y: ny * cut - s * nx };
    const p2 = { x: nx * cut - s * ny, y: ny * cut + s * nx };
    const a1 = Math.atan2(p1.y, p1.x);
    const a2 = Math.atan2(p2.y, p2.x);
    // El arco cubierto pasa por el punto del disco más profundo dentro del
    // semiplano: −sign·LID_RADIUS·n̂. Se recorre del ángulo p1 al ángulo p2
    // por el sentido que contiene ese punto.
    const through = Math.atan2(-sign * ny, -sign * nx);
    const ccw = (from, to) => ((to - from) % TAU + TAU) % TAU;
    const spanCCW = ccw(a1, a2);
    const coveredCCW = ccw(a1, through) <= spanCCW;
    const points = [];
    const steps = 48;
    for (let index = 0; index <= steps; index++) {
        const t = index / steps;
        const theta = coveredCCW ? a1 + spanCCW * t : a1 - (TAU - spanCCW) * t;
        points.push(`${index === 0 ? 'M' : 'L'} ${(LID_RADIUS * Math.cos(theta)).toFixed(2)} ${(LID_RADIUS * Math.sin(theta)).toFixed(2)}`);
    }
    points.pop(); // el último borde lo cierra el punto exacto de la cuerda
    points.push(`L ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`);
    return points.join(' ') + ' Z';
}

function faceSvg(frame) {
    const eyes = frame.eyes.map(eye => {
        const top = lidPath(eye.spin, eye.top, false);
        const bottom = lidPath(eye.spin, eye.bottom, true);
        return `<g transform="${eyeTransform(eye)}">` +
            `<circle r="${G.eyeR}" fill="${INK}"/>` +
            (top ? `<path d="${top}" fill="${SKIN}"/>` : '') +
            (bottom ? `<path d="${bottom}" fill="${SKIN}"/>` : '') +
            '</g>';
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100" width="${OUTPUT_SIZE}" height="${OUTPUT_SIZE}">` +
        `<g transform="translate(${frame.hx.toFixed(2)} ${frame.hy.toFixed(2)}) rotate(${frame.rot.toFixed(2)})` +
        ` scale(${frame.headScaleX.toFixed(3)} ${frame.headScaleY.toFixed(3)})">` +
        `<circle r="${G.headR}" fill="${SKIN}"/>` +
        eyes.join('') +
        '</g></svg>';
}

/* --------------------------------------------------- rasterizar y codificar */

async function getImageProcessors() {
    if (!imageProcessorPromise) {
        imageProcessorPromise = (async () => {
            const { Resvg, initWasm } = await import('@resvg/resvg-wasm');
            const wasmPath = require.resolve('@resvg/resvg-wasm/index_bg.wasm');
            await initWasm(fs.readFileSync(wasmPath));
            const webp = require('webp-wasm');
            await webp.load();
            return { Resvg, encodeWebP: webp.encode };
        })();
    }
    return imageProcessorPromise;
}

async function encodeFrame(svg, Resvg, encodeWebP) {
    const renderer = new Resvg(svg, { shapeRendering: 2 });
    let rendered;
    try {
        rendered = renderer.render();
        if (rendered.width !== OUTPUT_SIZE || rendered.height !== OUTPUT_SIZE)
            throw new Error(`El rasterizador devolvió ${rendered.width}x${rendered.height}; se esperaban ${OUTPUT_SIZE}x${OUTPUT_SIZE}.`);
        const pixels = new Uint8ClampedArray(rendered.pixels);
        const encoded = await encodeWebP(
            { data: pixels, width: rendered.width, height: rendered.height },
            { lossless: 1, exact: 1, quality: WEBP_QUALITY, method: WEBP_METHOD }
        );
        return new Uint8Array(encoded);
    } finally {
        if (rendered) rendered.free();
        renderer.free();
    }
}

function animationFrameCount(bytes) {
    let count = 0;
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const type = bytes.toString('ascii', offset, offset + 4);
        const size = bytes.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (size > bytes.length - start) return 0;
        if (type === 'ANMF') count++;
        offset = start + size + (size & 1);
    }
    return count;
}

function webpHasAlpha(bytes) {
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const type = bytes.toString('ascii', offset, offset + 4);
        const size = bytes.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (size > bytes.length - start) return false;
        if (type === 'VP8X' && size >= 1) return (bytes[start] & 0x10) !== 0;
        if (type === 'VP8L' && size >= 5 && bytes[start] === 0x2f)
            return (bytes[start + 4] & 0x10) !== 0;
        offset = start + size + (size & 1);
    }
    return false;
}

async function main(outputDirectory) {
    const destinationDirectory = path.resolve(outputDirectory);
    fs.mkdirSync(destinationDirectory, { recursive: true });
    const staging = fs.mkdtempSync(path.join(destinationDirectory, '.zlapy-bbot-'));
    try {
        const expressions = Object.keys(EXPRESSIONS);
        const { mux } = require('../../public/js/animated-webp.js');
        const { Resvg, encodeWebP } = await getImageProcessors();
        const staged = [];
        for (let expressionIndex = 0; expressionIndex < expressions.length; expressionIndex++) {
            const expression = expressions[expressionIndex];
            const frames = simulate(expression);
            if (frames.length !== FRAMES)
                throw new Error(`La simulación de "${expression}" dio ${frames.length} fotogramas, se esperaban ${FRAMES}.`);
            const progressPrefix = `[${String(expressionIndex + 1).padStart(2, '0')}/${expressions.length}] ${expression}`;
            const frameBytes = new Array(FRAMES);
            console.log(`${progressPrefix}: renderizando y codificando ${FRAMES} fotogramas (${LOOP_SECONDS} s)`);
            for (let index = 0; index < FRAMES; index++) {
                try {
                    frameBytes[index] = await encodeFrame(faceSvg(frames[index]), Resvg, encodeWebP);
                } catch (error) {
                    throw new Error(`No se pudo renderizar o codificar "${expression}" en el fotograma ${index + 1}/${FRAMES}.`, { cause: error });
                }
                if ((index + 1) % 5 === 0 || index === FRAMES - 1)
                    console.log(`${progressPrefix}: ${index + 1}/${FRAMES} fotogramas (${Math.round((index + 1) / FRAMES * 100)}%)`);
            }
            const bytes = Buffer.from(mux(
                frameBytes.map(bytes => ({ bytes, duration: FRAME_MS })),
                OUTPUT_SIZE, OUTPUT_SIZE, 0
            ));
            const frameCount = animationFrameCount(bytes);
            const hasAlpha = webpHasAlpha(bytes);
            if (bytes.length > MAX_BYTES ||
                bytes.toString('ascii', 0, 4) !== 'RIFF' ||
                bytes.readUInt32LE(4) !== bytes.length - 8 ||
                bytes.toString('ascii', 8, 12) !== 'WEBP' ||
                !hasAlpha || frameCount !== FRAMES) {
                throw new Error(`El WebP de "${expression}" no pasó la validación (alfa=${hasAlpha}, fotogramas=${frameCount}, bytes=${bytes.length}).`);
            }
            const stagedOutput = path.join(staging, `${expression}.webp`);
            fs.writeFileSync(stagedOutput, bytes);
            staged.push([stagedOutput, path.join(destinationDirectory, `${expression}.webp`)]);
            console.log(`${progressPrefix}: lista (${frameCount} fotogramas, ${LOOP_SECONDS} s, ${(bytes.length / 1024).toFixed(0)} kB)`);
        }
        for (const [stagedFile, destination] of staged) fs.renameSync(stagedFile, destination);
        console.log(`Listo: ${staged.length} strickers animados en ${destinationDirectory}`);
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}

if (require.main === module) {
    const outputDirectory = process.argv[2];
    if (!outputDirectory) {
        console.error('Indica el directorio de salida para los WebP animados del paquete bbot.');
        process.exitCode = 2;
    } else {
        main(outputDirectory).catch(error => {
            console.error('[bbot] No se pudo generar el paquete:', error);
            process.exitCode = 1;
        });
    }
}

module.exports = {
    EXPRESSIONS,
    REACTION_BY_EXPRESSION,
    buildSchedule,
    FRAME_MS,
    FRAMES,
    LOOP_SECONDS,
    simulate,
    faceSvg,
    main
};
