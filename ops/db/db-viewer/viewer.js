/* Visor de datos de Zlapy.
 *
 * Mismo lenguaje visual que docs/esquema (tema oscuro, paleta de grupos,
 * aristas curvas) pero sobre los DATOS: cada nodo es una fila y cada arista
 * una clave ajena real entre dos filas. Tres vistas:
 *
 *   2D     — grafo SVG con layout de fuerzas, pan/zoom, foco por clic.
 *   3D     — el mismo grafo proyectado en 3D (canvas, rotación por arrastre).
 *   Tablas — explorador paginado; los valores FK enlazan a la fila destino.
 *
 * Sin dependencias: el layout de fuerzas, la proyección 3D y la interacción
 * son propios.
 */
'use strict';

/* ---------------- grupos y paleta (heredados de docs/esquema) ---------------- */

const GROUPS = {
    identidad:  { label: 'Identidad y sesiones', color: '#4a9eff' },
    perfil:     { label: 'Perfil y preferencias', color: '#a78bfa' },
    social:     { label: 'Grafo social', color: '#34d399' },
    grupos:     { label: 'Grupos', color: '#f59e0b' },
    mensajeria: { label: 'Mensajería y adjuntos', color: '#f472b6' },
    infra:      { label: 'Infraestructura', color: '#94a3b8' },
    otras:      { label: 'Otras', color: '#94a3b8' }
};

// Tabla → grupo, calcado de docs/esquema/esquema.js para que los colores
// coincidan entre el esquema y el visor de datos.
const TABLE_GROUP = {
    user_profiles: 'perfil', user_chat_settings: 'perfil', user_privacy: 'perfil',
    user_privacy_users: 'perfil', user_notes: 'perfil', user_stickers: 'perfil',
    user_muted_peers: 'perfil', user_chat_prefs: 'perfil',
    users: 'identidad', sessions: 'identidad', user_auth_keys: 'identidad', user_keys: 'identidad',
    summaries: 'social', contacts: 'social', contact_requests: 'social', blocked: 'social',
    groups: 'grupos', group_members: 'grupos', group_join_requests: 'grupos',
    group_summaries: 'grupos', user_group_seen: 'grupos',
    messages: 'mensajeria', message_deletions: 'mensajeria', chat_deletions: 'mensajeria',
    blob_access: 'mensajeria', blob_access_members: 'mensajeria', stories: 'mensajeria',
    calls: 'mensajeria', push_subs: 'mensajeria',
    meta: 'infra', blobs: 'infra'
};

const groupOf = table => GROUPS[TABLE_GROUP[table]] ? TABLE_GROUP[table] : 'otras';
const colorOf = table => GROUPS[groupOf(table)].color;

/* ---------------- estado ---------------- */

const state = {
    mode: '2d',           // 2d | 3d | tables
    schema: null,
    graph: null,
    secrets: false,
    inferred: false,
    query: '',
    focus: null,          // id del nodo aislado
    zoom: 1,
    pan: { x: 60, y: 40 },
    yaw: 0.55, pitch: -0.32, zoom3d: 1,
    fitAfterSimulation: false,
    table: null, offset: 0, limit: 100
};

const nodesById = new Map();
const edgeEls = [];        // { el, edge }
const nodeEls = new Map(); // id → <g> (2D)
const neighborsById = new Map();

const $ = sel => document.querySelector(sel);

function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function fmtCell(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    const text = String(value);
    return text.length > 400 ? `${text.slice(0, 400)}… (${text.length} caracteres)` : text;
}

/* ---------------- carga ---------------- */

async function api(path) {
    const res = await fetch(path);
    if (!res.ok) {
        let error = res.statusText;
        try { error = (await res.json()).error || error; } catch { /* no era JSON */ }
        throw new Error(error);
    }
    return res.json();
}

function withReveal(path) {
    return state.secrets ? `${path}${path.includes('?') ? '&' : '?'}reveal=1` : path;
}

async function load() {
    const [schema, graph] = await Promise.all([
        api(withReveal('/api/schema')),
        api('/api/graph')
    ]);
    state.schema = schema;
    state.graph = graph;

    nodesById.clear();
    for (const node of graph.nodes) nodesById.set(node.id, node);

    buildNeighbors();
    buildLegend();
    buildTablesList();

    if (graph.nodes.length === 0) {
        $('#empty').classList.remove('hidden');
    } else {
        $('#empty').classList.add('hidden');
        layoutGraph();
        render2D();
        fit2D();
        state.fitAfterSimulation = true;
        startSim();
    }
    renderStats();
}

function renderStats() {
    const graph = state.graph;
    const sqliteTables = state.schema.tables.filter(t => t.db === 'zlapy');
    const blobTables = state.schema.tables.filter(t => t.db === 'blob');
    const rowSum = state.schema.tables.reduce((n, t) => n + t.rows, 0);

    const item = (value, label) => `<span><b>${value}</b> ${label}</span>`;
    $('#stats').innerHTML = [
        item(graph.nodes.length.toLocaleString('es-ES'), 'filas'),
        item(graph.edges.length.toLocaleString('es-ES'), 'conexiones'),
        item(sqliteTables.length, 'tablas zlapy'),
        item(blobTables.length, 'tablas blob'),
        item(rowSum.toLocaleString('es-ES'), 'filas totales')
    ].join('<span class="sep"></span>');
}

function buildNeighbors() {
    neighborsById.clear();
    for (const edge of state.graph.edges) {
        if (!neighborsById.has(edge.from)) neighborsById.set(edge.from, new Set());
        if (!neighborsById.has(edge.to)) neighborsById.set(edge.to, new Set());
        neighborsById.get(edge.from).add(edge.to);
        neighborsById.get(edge.to).add(edge.from);
    }
}

function buildLegend() {
    const groupItems = Object.values(GROUPS)
        .filter(g => state.schema.tables.some(t => TABLE_GROUP[t.name] === groupOf(t.name)))
        .map(g => `<span class="item"><i class="chip" style="--c:${g.color}"></i>${esc(g.label)}</span>`)
        .join('');

    $('#legend').innerHTML =
        `<span class="item"><i class="swatch"></i>ON DELETE CASCADE</span>` +
        `<span class="item"><i class="swatch setnull"></i>ON DELETE SET NULL</span>` +
        `<span class="item"><i class="swatch inferred"></i>relación deducida (no es FK)</span>` +
        `<span class="item"><i class="chip" style="--c:#c98a2b"></i>valor enmascarado</span>` +
        `<span class="grow"></span>` + groupItems;
}

/* ---------------- simulación de fuerzas ---------------- */

const sim = {
    alpha: 1,
    running: false,
    charge: -900,
    linkDist: 0,          // se calcula según el número de nodos
    linkStrength: 0.035,
    gravity: 0.009,
    damping: 0.85,
    maxStep: 42
};

function nodeDegree(id) {
    const set = neighborsById.get(id);
    return set ? set.size : 0;
}

function nodeRadius(node) {
    return 4.5 + Math.min(9, Math.sqrt(nodeDegree(node.id)) * 2.1);
}

function layoutGraph() {
    const list = [...nodesById.values()];
    const n = list.length;
    sim.linkDist = Math.min(190, Math.max(70, 26 + 9 * Math.sqrt(n)));
    const spread = Math.max(240, 60 * Math.sqrt(n));

    // Semilla determinista: el mismo grafo se despliega igual siempre.
    let seed = 1;
    const rnd = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
    };

    for (let i = 0; i < n; i++) {
        const node = list[i];
        const angle = rnd() * Math.PI * 2;
        const radius = Math.sqrt(rnd()) * spread;
        node.x = Math.cos(angle) * radius;
        node.y = Math.sin(angle) * radius;
        node.z = (rnd() - 0.5) * spread * 0.6;
        node.vx = 0; node.vy = 0; node.vz = 0;
        node.deg = nodeDegree(node.id);
    }
}

function step() {
    const list = [...nodesById.values()];
    const n = list.length;
    if (n === 0) return;

    // Repulsión por pares (n es acotado: tope de filas por tabla).
    for (let i = 0; i < n; i++) {
        const a = list[i];
        for (let j = i + 1; j < n; j++) {
            const b = list[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dz = b.z - a.z;
            let d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < 1) d2 = 1;
            const d = Math.sqrt(d2);
            const f = sim.charge / (d2 * d);
            const fx = dx * f, fy = dy * f, fz = dz * f;
            a.vx += fx; a.vy += fy; a.vz += fz;
            b.vx -= fx; b.vy -= fy; b.vz -= fz;
        }
    }

    // Muelles sobre las aristas.
    const L = sim.linkDist;
    for (const edge of state.graph.edges) {
        const a = nodesById.get(edge.from);
        const b = nodesById.get(edge.to);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        const k = sim.linkStrength * (d - L) / d;
        const fx = dx * k, fy = dy * k, fz = dz * k;
        a.vx += fx; a.vy += fy; a.vz += fz;
        b.vx -= fx; b.vy -= fy; b.vz -= fz;
    }

    // Gravedad al centro, amortiguación e integración.
    for (const node of list) {
        node.vx -= node.x * sim.gravity;
        node.vy -= node.y * sim.gravity;
        node.vz -= node.z * sim.gravity * 2;
        node.vx *= sim.damping; node.vy *= sim.damping; node.vz *= sim.damping;

        let step = Math.sqrt(node.vx * node.vx + node.vy * node.vy + node.vz * node.vz);
        if (step > sim.maxStep) {
            const scale = sim.maxStep / step;
            node.vx *= scale; node.vy *= scale; node.vz *= scale;
        }
        node.x += node.vx; node.y += node.vy; node.z += node.vz;
    }

    sim.alpha *= 0.97;
    if (sim.alpha < 0.01) sim.running = false;
}

function startSim() {
    sim.alpha = 1;
    sim.running = true;
    requestAnimationFrame(tick);
}

function reheat() {
    sim.alpha = 0.45;
    if (!sim.running) {
        sim.running = true;
        requestAnimationFrame(tick);
    }
}

function tick() {
    if (sim.running) {
        step();
        if (!sim.running && state.fitAfterSimulation) {
            state.fitAfterSimulation = false;
            fit2D();
        }
        if (state.mode === '2d') render2D();
        else if (state.mode === '3d') render3D();
    }
    if (sim.running) requestAnimationFrame(tick);
}

/* ---------------- vista 2D ---------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const key in attrs) el.setAttribute(key, attrs[key]);
    return el;
}

function render2D() {
    const world = $('#world2d');
    if (world.childElementCount === 0) build2D();

    world.classList.toggle('overview', state.zoom < 0.65);
    world.classList.toggle('show-labels', state.zoom >= 1.4);
    for (const node of nodesById.values()) {
        const el = nodeEls.get(node.id);
        if (el) {
            el.setAttribute('transform', `translate(${node.x.toFixed(1)},${node.y.toFixed(1)})`);
            const radius = nodeRadius(node) / state.zoom;
            el.querySelector('circle.halo').setAttribute('r', radius + 4 / state.zoom);
            el.querySelector('circle.core').setAttribute('r', radius);
            const label = el.querySelector('text');
            label.setAttribute('x', radius + 5 / state.zoom);
            label.setAttribute('font-size', 10 / state.zoom);
        }
    }
    for (const item of edgeEls) {
        const a = nodesById.get(item.edge.from);
        const b = nodesById.get(item.edge.to);
        if (!a || !b) continue;
        item.el.setAttribute('d', `M${a.x.toFixed(1)},${a.y.toFixed(1)} L${b.x.toFixed(1)},${b.y.toFixed(1)}`);
    }
    applyWorldTransform();
}

function build2D() {
    const world = $('#world2d');
    world.textContent = '';
    edgeEls.length = 0;
    nodeEls.clear();

    const fragEdges = document.createDocumentFragment();
    const fragNodes = document.createDocumentFragment();

    for (const edge of state.graph.edges) {
        const el = svgEl('path', { class: 'edge2d ' + edgeClass(edge) });
        el.dataset.from = edge.from;
        el.dataset.to = edge.to;
        el.dataset.kind = edge.kind;
        el.dataset.logical = edge.kind === 'inferred' ? '1' : '0';
        const title = svgEl('title', {});
        const a = nodesById.get(edge.from);
        const b = nodesById.get(edge.to);
        title.textContent =
            `${a ? a.table : edge.from} → ${b ? b.table : edge.to}` +
            (edge.kind === 'inferred' ? ' (deducida)' : '');
        el.appendChild(title);
        fragEdges.appendChild(el);
        edgeEls.push({ el, edge });
    }

    for (const node of nodesById.values()) {
        const r = nodeRadius(node);
        const g = svgEl('g', { class: 'node2d', transform: `translate(${node.x},${node.y})` });
        g.style.setProperty('--g', colorOf(node.table));
        g.dataset.id = node.id;

        const halo = svgEl('circle', { class: 'halo', r: r + 4 });
        const core = svgEl('circle', { class: 'core', r });
        const label = svgEl('text', { x: r + 5, y: 3.4 });
        label.textContent = node.label;

        const title = svgEl('title', {});
        title.textContent = `${node.table} · ${JSON.stringify(node.pk)}`;
        g.appendChild(title);
        g.appendChild(halo);
        g.appendChild(core);
        g.appendChild(label);

        g.addEventListener('click', ev => {
            ev.stopPropagation();
            toggleFocus(node.id);
        });
        g.addEventListener('mousedown', ev => ev.stopPropagation());

        fragNodes.appendChild(g);
        nodeEls.set(node.id, g);
    }

    world.appendChild(fragEdges);
    world.appendChild(fragNodes);
}

function edgeClass(edge) {
    if (edge.kind === 'inferred') return 'inferred';
    if (edge.onDelete === 'SET NULL') return 'setnull';
    return 'fk';
}

function applyWorldTransform() {
    $('#world2d').setAttribute('transform', `translate(${state.pan.x},${state.pan.y}) scale(${state.zoom})`);
    $('#zlabel').textContent = Math.round(state.zoom * 100) + '%';
}

function applyStates() {
    const focus = state.focus ? nodesById.get(state.focus) : null;
    const neighbors = focus ? (neighborsById.get(focus.id) || new Set()) : null;
    const query = state.query.trim().toLowerCase();
    $('#world2d').classList.toggle('show-labels', state.zoom >= 1.4 || !!focus || !!query);

    for (const [id, el] of nodeEls) {
        const node = nodesById.get(id);
        if (!node) continue;

        el.classList.toggle('focused', !!focus && id === state.focus);
        el.classList.toggle('muted', !!focus && !(id === state.focus || neighbors.has(id)));

        let hit = true;
        if (query) {
            hit = node.table.toLowerCase().includes(query) ||
                node.label.toLowerCase().includes(query) ||
                JSON.stringify(node.pk).toLowerCase().includes(query);
        }
        el.classList.toggle('hit', !!query && hit);
        el.classList.toggle('search-dim', !!query && !hit);
        el.style.opacity = query && !hit ? '.1' : '1';
    }

    for (const item of edgeEls) {
        const hot = !!focus && (item.edge.from === state.focus || item.edge.to === state.focus);
        item.el.classList.toggle('hot', hot);
        item.el.classList.toggle('muted', !!focus && !hot);
        item.el.classList.toggle('hidden', !state.inferred && item.edge.kind === 'inferred');
    }
    applySearchEdges();
}

function applySearchEdges() {
    const query = state.query.trim().toLowerCase();
    for (const item of edgeEls) {
        if (!state.inferred && item.edge.kind === 'inferred') {
            item.el.classList.add('hidden');
            continue;
        }
        if (query) {
            const a = nodeEls.get(item.edge.from);
            const b = nodeEls.get(item.edge.to);
            const dim = (a && Number(a.style.opacity) < 0.5) || (b && Number(b.style.opacity) < 0.5);
            item.el.classList.toggle('hidden', !!dim);
        } else {
            item.el.classList.remove('hidden');
        }
    }
}

function toggleFocus(id) {
    state.focus = state.focus === id ? null : id;
    applyStates();
    if (state.focus) openDetail(id);
    else closeDetail();
    if (state.mode === '3d') render3D();
}

/* ---------------- vista 3D ---------------- */

let canvas3d = null;
let ctx3d = null;

function init3D() {
    canvas3d = $('#canvas3d');
    ctx3d = canvas3d.getContext('2d');
    resize3D();
}

function resize3D() {
    if (!canvas3d) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas3d.parentElement.getBoundingClientRect();
    canvas3d.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas3d.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx3d.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function project3D(x, y, z) {
    x -= graphCenter.x;
    y -= graphCenter.y;
    z -= graphCenter.z;
    const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw);
    const cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);

    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const y1 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;

    const view = ctx3d.canvas;
    const extent = Math.max(1, graphExtent);
    const sceneScale = Math.min(view.clientWidth, view.clientHeight) * 0.38 / extent;
    const focal = Math.max(1, Math.min(view.clientWidth, view.clientHeight) * 1.8);
    const depth = z2 * sceneScale;
    const scale = focal / Math.max(focal * 0.35, focal + depth);
    const cx = view.clientWidth / 2 || 400;
    const y0 = view.clientHeight / 2 || 300;
    return {
        sx: cx + x1 * sceneScale * scale * state.zoom3d,
        sy: y0 + y1 * sceneScale * scale * state.zoom3d,
        s: scale
    };
}

let graphExtent = 1;
let graphCenter = { x: 0, y: 0, z: 0 };

function render3D() {
    if (!ctx3d) return;
    const view = ctx3d.canvas;
    const w = view.clientWidth, h = view.clientHeight;
    ctx3d.clearRect(0, 0, w, h);

    const focus = state.focus ? nodesById.get(state.focus) : null;
    const neighbors = focus ? (neighborsById.get(focus.id) || new Set()) : null;
    const query = state.query.trim().toLowerCase();
    const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const node of nodesById.values()) {
        bounds.minX = Math.min(bounds.minX, node.x);
        bounds.maxX = Math.max(bounds.maxX, node.x);
        bounds.minY = Math.min(bounds.minY, node.y);
        bounds.maxY = Math.max(bounds.maxY, node.y);
        bounds.minZ = Math.min(bounds.minZ, node.z);
        bounds.maxZ = Math.max(bounds.maxZ, node.z);
    }
    if (nodesById.size) {
        graphCenter = {
            x: (bounds.minX + bounds.maxX) / 2,
            y: (bounds.minY + bounds.maxY) / 2,
            z: (bounds.minZ + bounds.maxZ) / 2
        };
        graphExtent = Math.max(1,
            (bounds.maxX - bounds.minX) / 2,
            (bounds.maxY - bounds.minY) / 2,
            (bounds.maxZ - bounds.minZ) / 2);
    }

    // Proyección de todos los nodos.
    const drawn = [];
    for (const node of nodesById.values()) {
        const p = project3D(node.x, node.y, node.z);
        node._sx = p.sx; node._sy = p.sy; node._s = p.s;
        drawn.push(node);
    }
    drawn.sort((a, b) => a._s - b._s); // lejanos primero

    const matches = id => {
        const node = nodesById.get(id);
        if (!node) return false;
        if (focus) return id === state.focus || neighbors.has(id);
        if (!query) return true;
        return node.table.toLowerCase().includes(query) ||
            node.label.toLowerCase().includes(query) ||
            JSON.stringify(node.pk).toLowerCase().includes(query);
    };

    // Aristas primero (una línea por arista, alfa por profundidad).
    ctx3d.lineWidth = 1;
    for (const edge of state.graph.edges) {
        if (!state.inferred && edge.kind === 'inferred') continue;
        const a = nodesById.get(edge.from);
        const b = nodesById.get(edge.to);
        if (!a || !b) continue;
        if (!matches(edge.from) || !matches(edge.to)) continue;

        const hot = !!focus && (edge.from === state.focus || edge.to === state.focus);
        const depth = Math.min(a._s, b._s);
        const alpha = focus
            ? (hot ? 0.95 : 0.06)
            : (0.12 + 0.4 * Math.max(0, Math.min(1, (depth - 0.6) / 0.45)));

        ctx3d.strokeStyle = hot
            ? '#4a9eff'
            : (edge.kind === 'inferred' ? '#9a7bf0' : (edge.onDelete === 'SET NULL' ? '#c98a2b' : '#4b5a6d'));
        ctx3d.globalAlpha = alpha;
        ctx3d.beginPath();
        ctx3d.moveTo(a._sx, a._sy);
        ctx3d.lineTo(b._sx, b._sy);
        ctx3d.stroke();
    }
    ctx3d.globalAlpha = 1;

    // Nodos de cerca a lejos.
    for (const node of drawn) {
        const r = nodeRadius(node) * node._s * Math.max(0.7, state.zoom3d);
        const color = colorOf(node.table);
        const matched = matches(node.id);
        const isFocus = state.focus === node.id;

        ctx3d.globalAlpha = matched ? 0.95 : 0.12;

        // Halo
        ctx3d.beginPath();
        ctx3d.arc(node._sx, node._sy, r + 6 * node._s, 0, Math.PI * 2);
        ctx3d.fillStyle = color;
        ctx3d.globalAlpha = matched ? 0.14 : 0.04;
        ctx3d.fill();

        // Núcleo
        ctx3d.beginPath();
        ctx3d.arc(node._sx, node._sy, r, 0, Math.PI * 2);
        ctx3d.fillStyle = '#0b0f14';
        ctx3d.fill();
        ctx3d.lineWidth = isFocus ? 3 : 2;
        ctx3d.strokeStyle = isFocus ? '#f0b429' : color;
        ctx3d.stroke();

        // Etiqueta: foco, vecinos o nodos muy al frente.
        const showLabel = isFocus || (focus && neighbors.has(node.id)) || (!!query && matched);
        if (showLabel) {
            ctx3d.globalAlpha = matched ? 1 : 0.2;
            ctx3d.font = '10px ui-monospace, "SF Mono", Consolas, monospace';
            ctx3d.lineWidth = 3;
            ctx3d.strokeStyle = '#0b0f14';
            const text = node.label;
            ctx3d.strokeText(text, node._sx + r + 4, node._sy + 3.4);
            ctx3d.fillStyle = isFocus ? '#f0b429' : '#b8c6d6';
            ctx3d.fillText(text, node._sx + r + 4, node._sy + 3.4);
        }
    }
    ctx3d.globalAlpha = 1;
}

/* ---------------- interacción 2D ---------------- */

function init2D() {
    const view = $('#view-2d');
    const world = $('#world2d');

    // Rueda: zoom sobre el cursor.
    view.addEventListener('wheel', ev => {
        ev.preventDefault();
        const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
        zoomAt(ev.clientX, ev.clientY, factor);
    }, { passive: false });

    // Arrastre del fondo: paneo. Arrastre de un nodo: lo mueve y recalienta.
    let drag = null;
    view.addEventListener('mousedown', ev => {
        if (ev.button !== 0) return;
        const nodeEl = ev.target.closest('.node2d');
        if (nodeEl) {
            const node = nodesById.get(nodeEl.dataset.id);
            drag = { type: 'node', node };
        } else {
            drag = { type: 'pan', x: ev.clientX, y: ev.clientY, pan: { ...state.pan } };
            view.classList.add('panning');
        }
    });
    window.addEventListener('mousemove', ev => {
        if (!drag) return;
        if (drag.type === 'pan') {
            state.pan.x = drag.pan.x + (ev.clientX - drag.x);
            state.pan.y = drag.pan.y + (ev.clientY - drag.y);
            applyWorldTransform();
        } else if (drag.type === 'node' && drag.node) {
            const rect = view.getBoundingClientRect();
            drag.node.x = (ev.clientX - rect.left - state.pan.x) / state.zoom;
            drag.node.y = (ev.clientY - rect.top - state.pan.y) / state.zoom;
            drag.node.vx = 0; drag.node.vy = 0; drag.node.vz = 0;
            reheat();
        }
    });
    window.addEventListener('mouseup', () => {
        drag = null;
        view.classList.remove('panning');
    });

    // Clic en el fondo: limpia el foco.
    view.addEventListener('click', ev => {
        if (ev.target.closest('.node2d')) return;
        if (state.focus) {
            state.focus = null;
            applyStates();
            closeDetail();
        }
    });
}

function zoomAt(clientX, clientY, factor) {
    const view = $('#view-2d');
    const rect = view.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const next = Math.max(0.15, Math.min(3, state.zoom * factor));
    const k = next / state.zoom;
    // El punto bajo el cursor se mantiene fijo.
    state.pan.x = px - (px - state.pan.x) * k;
    state.pan.y = py - (py - state.pan.y) * k;
    state.zoom = next;
    render2D();
}

/* ---------------- interacción 3D ---------------- */

function init3DInput() {
    const view = $('#view-3d');
    let drag = null;

    view.addEventListener('mousedown', ev => {
        if (ev.button !== 0) return;
        drag = { x: ev.clientX, y: ev.clientY, yaw: state.yaw, pitch: state.pitch, moved: 0 };
    });
    window.addEventListener('mousemove', ev => {
        if (!drag) return;
        drag.moved += Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y);
        state.yaw = drag.yaw + (ev.clientX - drag.x) * 0.005;
        state.pitch = Math.max(-1.45, Math.min(1.45,
            drag.pitch + (ev.clientY - drag.y) * 0.005));
        render3D();
    });
    window.addEventListener('mouseup', ev => {
        // Clic sin arrastre sobre un nodo: foco.
        if (drag && drag.moved < 5) {
            const node = pick3D(ev.clientX, ev.clientY);
            if (node) toggleFocus(node.id);
            else if (state.focus) { state.focus = null; applyStates(); closeDetail(); }
        }
        drag = null;
    });
    view.addEventListener('wheel', ev => {
        ev.preventDefault();
        const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
        state.zoom3d = Math.max(0.25, Math.min(3, state.zoom3d * factor));
        render3D();
    }, { passive: false });
}

function pick3D(clientX, clientY) {
    const rect = $('#view-3d').getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    let best = null;
    let bestDist = 18;
    for (const node of nodesById.values()) {
        if (node._sx === undefined) continue;
        const d = Math.hypot(node._sx - px, node._sy - py);
        if (d < bestDist) { bestDist = d; best = node; }
    }
    return best;
}

/* ---------------- panel de detalle ---------------- */

async function openDetail(id) {
    const node = nodesById.get(id);
    if (!node) return;
    let payload = null;
    try {
        payload = await api(withReveal(`/api/row/${encodeURIComponent(node.table)}/${node.rid}`));
    } catch {
        closeDetail();
        return;
    }

    const table = state.schema.tables.find(t => t.name === node.table);
    const panel = $('#detail');
    panel.classList.remove('hidden');

    const fields = payload.row
        ? Object.entries(payload.row).map(([name, value]) => {
            const col = table ? table.columns.find(c => c.name === name) : null;
            const rendered = renderFieldValue(node.table, name, value, col);
            return `<div class="field"><span class="fn">${esc(name)}</span>${rendered}</div>`;
        }).join('')
        : '<div class="field"><span class="fn">(sin datos)</span></div>';

    panel.innerHTML =
        `<header>` +
        `<h3 title="${esc(node.table)}">${esc(node.table)}</h3>` +
        `<button class="close" id="detail-close">cerrar</button>` +
        `</header>` +
        `<div class="field"><span class="fn">clave</span><span class="fv">${esc(JSON.stringify(node.pk))}</span></div>` +
        fields;
    panel.querySelector('h3').style.color = colorOf(node.table);

    $('#detail-close').addEventListener('click', closeDetail);
    panel.querySelectorAll('a.fk').forEach(a => a.addEventListener('click', onFkClick));
}

function closeDetail() {
    const panel = $('#detail');
    panel.classList.add('hidden');
    panel.innerHTML = '';
}

function renderFieldValue(table, column, value, col) {
    const text = fmtCell(value);
    if (text === null) return `<span class="fv null">NULL</span>`;
    const cls = value === MASK_STRING ? ' masked' : '';
    const body = esc(text);
    if (col && col.ref && typeof value === 'string' && value !== MASK_STRING) {
        return `<span class="fv${cls}"><a class="fk" data-table="${esc(col.ref.table)}" data-col="${esc(col.ref.toColumn || col.ref.columns[0])}" data-value="${esc(value)}">${body}</a></span>`;
    }
    return `<span class="fv${cls}">${body}</span>`;
}

const MASK_STRING = '••••••••';

/* ---------------- explorador de tablas ---------------- */

function buildTablesList() {
    const host = $('#tbl-list');
    host.innerHTML = state.schema.tables.map(t =>
        `<div class="tbl-item" data-table="${esc(t.name)}" data-db="${esc(t.db)}">` +
        `<span class="db">${t.db === 'blob' ? 'blob' : 'zlapy'}</span>` +
        `${esc(t.name)}` +
        `<span class="n">${t.rows.toLocaleString('es-ES')}</span>` +
        `</div>`
    ).join('');
    host.querySelectorAll('.tbl-item').forEach(item =>
        item.addEventListener('click', () => openTable(item.dataset.table, 0))
    );
}

async function openTable(table, offset) {
    state.table = table;
    state.offset = offset;
    document.querySelectorAll('.tbl-item').forEach(item =>
        item.classList.toggle('on', item.dataset.table === table)
    );

    let payload;
    try {
        payload = await api(withReveal(`/api/table/${encodeURIComponent(table)}?offset=${offset}&limit=${state.limit}`));
    } catch (error) {
        $('#tbl-main').innerHTML = `<p class="meta">Error: ${esc(error.message)}</p>`;
        return;
    }

    const from = payload.total === 0 ? 0 : payload.offset + 1;
    const to = Math.min(payload.total, payload.offset + payload.rows.length);
    const pager = `
        <div class="pager">
            <span>${from}–${to} de ${payload.total.toLocaleString('es-ES')}</span>
            <button id="pg-prev" ${offset === 0 ? 'disabled' : ''}>←</button>
            <button id="pg-next" ${offset + payload.rows.length >= payload.total ? 'disabled' : ''}>→</button>
        </div>`;

    const head = payload.columns.map(col =>
        `<th>${esc(col.name)}${col.pk ? '<span class="k pk">PK</span>' : ''}</th>`
    ).join('');

    const body = payload.rows.map(row => {
        const cells = payload.columns.map(col => {
            const value = row[col.name];
            if (value === null) return `<td class="null">NULL</td>`;
            const text = fmtCell(value);
            if (col.ref && typeof value === 'string' && value !== MASK_STRING) {
                return `<td><a class="fk" title="${esc(text)}" data-table="${esc(col.ref.table)}" data-col="${esc(col.ref.toColumn || col.ref.columns[0])}" data-value="${esc(value)}">→ ${esc(text)}</a></td>`;
            }
            const cls = value === MASK_STRING ? ' class="masked"' : '';
            return `<td${cls} title="${esc(text)}">${esc(text)}</td>`;
        }).join('');
        return `<tr>${cells}</tr>`;
    }).join('');

    $('#tbl-main').innerHTML =
        `<div class="tbl-head">` +
        `<h2 style="color:${colorOf(table)}">${esc(table)}</h2>` +
        `<span class="meta">${payload.db} · ${payload.columns.length} columnas · ${payload.total.toLocaleString('es-ES')} filas</span>` +
        pager +
        `</div>` +
        (payload.rows.length === 0
            ? `<p class="meta">La tabla está vacía.</p>`
            : `<div class="grid-wrap"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);

    const prev = $('#pg-prev');
    const next = $('#pg-next');
    if (prev) prev.addEventListener('click', () => openTable(table, Math.max(0, offset - state.limit)));
    if (next) next.addEventListener('click', () => openTable(table, offset + state.limit));
    $('#tbl-main').querySelectorAll('a.fk').forEach(a => a.addEventListener('click', onFkClick));
}

/* ---------------- navegación FK → fila ---------------- */

// Índice valor→nodo, para que un enlace FK salte al grafo aunque la fila
// destino esté cargada más allá del tope del grafo.
const nodeByValue = new Map();

function indexNodeValues() {
    nodeByValue.clear();
    for (const node of nodesById.values()) {
        for (const [col, value] of Object.entries(node.pk)) {
            nodeByValue.set(`${node.table}\u0000${col}\u0000${JSON.stringify(value)}`, node.id);
        }
    }
}

function onFkClick(ev) {
    const a = ev.currentTarget;
    const table = a.dataset.table;
    const column = a.dataset.col;
    const value = a.dataset.value;
    const id = nodeByValue.get(`${table}\u0000${column}\u0000${JSON.stringify(decodeMaybe(value))}`) ||
        nodeByValue.get(`${table}\u0000${column}\u0000${JSON.stringify(Number.isFinite(Number(value)) && value !== '' ? Number(value) : value)}`);
    if (!id) {
        window.alert(`La fila referenciada (${table}) no está cargada en el grafo: sube VIEWER_GRAPH_LIMIT o búsqueda por tabla.`);
        return;
    }
    setMode('2d');
    if (state.focus !== id) toggleFocus(id);
    else { applyStates(); openDetail(id); }
}

// Los valores viajan como texto en el data-attribute; si la columna destino
// es numérica, se compara también como número.
function decodeMaybe(value) {
    return value;
}

/* ---------------- modos y controles ---------------- */

function setMode(mode) {
    state.mode = mode;
    $('#m-2d').classList.toggle('on', mode === '2d');
    $('#m-3d').classList.toggle('on', mode === '3d');
    $('#m-tables').classList.toggle('on', mode === 'tables');
    $('#view-2d').classList.toggle('hidden', mode !== '2d');
    $('#view-3d').classList.toggle('hidden', mode !== '3d');
    $('#view-tables').classList.toggle('hidden', mode !== 'tables');

    if (mode === '3d') {
        if (!ctx3d) init3D();
        resize3D();
        if (!sim.running) reheat();
        render3D();
    } else if (mode === '2d') {
        render2D();
    } else if (mode === 'tables') {
        if (!state.table && state.schema.tables.length) {
            openTable(state.schema.tables[0].name, 0);
        }
    }
}

function initControls() {
    $('#m-2d').addEventListener('click', () => setMode('2d'));
    $('#m-3d').addEventListener('click', () => setMode('3d'));
    $('#m-tables').addEventListener('click', () => setMode('tables'));

    $('#search').addEventListener('input', ev => {
        state.query = ev.target.value;
        if (state.mode === '2d') applyStates();
        else if (state.mode === '3d') render3D();
    });

    $('#tgl-secrets').addEventListener('change', ev => {
        state.secrets = ev.target.checked;
        $('#tgl-secrets').parentElement.classList.toggle('warn', state.secrets);
        // Los valores enmascarados vienen del servidor: hay que recargar.
        reload();
    });

    $('#tgl-inferred').addEventListener('change', ev => {
        state.inferred = ev.target.checked;
        if (state.mode === '2d') applyStates();
        else if (state.mode === '3d') render3D();
    });

    $('#zin').addEventListener('click', () => zoomAt(innerWidth / 2, innerHeight / 2, 1.2));
    $('#zout').addEventListener('click', () => zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2));
    $('#zlabel').addEventListener('click', () => {
        state.zoom = 1;
        state.zoom3d = 1;
        state.pan = { x: 60, y: 40 };
        if (state.mode === '3d') render3D();
        else render2D();
    });
    $('#zfit').addEventListener('click', fit);

    window.addEventListener('keydown', ev => {
        if (ev.key === 'Escape') {
            state.focus = null;
            state.query = '';
            $('#search').value = '';
            applyStates();
            closeDetail();
            if (state.mode === '3d') render3D();
        }
    });

    window.addEventListener('resize', () => {
        if (state.mode === '3d') {
            resize3D();
            render3D();
        }
    });
}

function fit() {
    if (state.mode === '3d') {
        state.zoom3d = 1;
        render3D();
        return;
    }
    fit2D();
}

function fit2D() {
    if (!nodesById.size) return;
    let maxX = -Infinity, maxY = -Infinity, minX = Infinity, minY = Infinity;
    for (const node of nodesById.values()) {
        maxX = Math.max(maxX, node.x); maxY = Math.max(maxY, node.y);
        minX = Math.min(minX, node.x); minY = Math.min(minY, node.y);
    }
    const width = Math.max(1, maxX - minX + 160);
    const height = Math.max(1, maxY - minY + 120);
    const view = $('#view-2d').getBoundingClientRect();
    const zoom = Math.max(0.08, Math.min(2.5,
        Math.min(Math.max(1, view.width - 80) / width, Math.max(1, view.height - 70) / height)));
    state.zoom = zoom;
    state.pan.x = view.width / 2 - (minX + maxX) / 2 * zoom;
    state.pan.y = view.height / 2 - (minY + maxY) / 2 * zoom;
    applyWorldTransform();
    render2D();
}

async function reload() {
    closeDetail();
    state.focus = null;
    await load();
    setMode(state.mode);
}

/* ---------------- arranque ---------------- */

async function init() {
    init2D();
    init3DInput();
    initControls();
    try {
        await load();
        indexNodeValues();
        applyStates();
        if (state.schema.tables.length === 0) {
            $('#empty').classList.remove('hidden');
        }
    } catch (error) {
        // Fallo de carga (servidor parado, base inaccesible): aviso visible.
        $('#stats').textContent = '';
        $('#empty').classList.remove('hidden');
        $('#empty').innerHTML =
            `<p>No se pudo cargar el visor: ${esc(error.message)}</p>` +
            `<p>¿Está el servidor corriendo (<code>npm run dbview</code>)?</p>`;
    }
}

init();
