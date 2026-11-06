/* Visor de tablas de Zlapy (cliente).
 *
 * Pide /api/overview para el panel lateral y /api/table/<tabla> para la
 * rejilla. Todo el contenido se pinta con textContent: los valores vienen de
 * la base y nunca se interpretan como HTML. El material sensible llega
 * enmascarado del servidor salvo que el interruptor «revelar» esté activo.
 */
'use strict';

const $ = sel => document.querySelector(sel);

const state = {
    tables: [],
    byName: new Map(),
    selected: null,
    offset: 0,
    limit: 100,
    reveal: false,
    query: ''
};

const MASK = '••••••••';
const DB_LABEL = { zlapy: 'zlapy.db', blob: 'zlapy-blob.db' };
const DB_COLOR = { zlapy: '#4a9eff', blob: '#f0b429' };

/* ---------------- utilidades ---------------- */

async function api(pathname) {
    const res = await fetch(pathname, { headers: { Accept: 'application/json' } });
    let payload = null;
    try { payload = await res.json(); } catch { /* respuesta no JSON */ }
    if (!res.ok) throw new Error(payload && payload.error ? payload.error : `HTTP ${res.status}`);
    return payload;
}

const fmt = n => Number(n).toLocaleString('es-ES');

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function chip(kind, label) {
    return el('i', `k ${kind}`, label);
}

/* ---------------- barra superior y panel lateral ---------------- */

function renderStats(totals) {
    const host = $('#stats');
    host.textContent = '';

    const item = (value, label) => {
        const span = document.createElement('span');
        span.append(el('b', null, fmt(value)), document.createTextNode(' ' + label));
        return span;
    };

    const sep = () => el('span', 'sep');
    host.append(
        item(totals.tables, 'tablas'), sep(),
        item(totals.columns, 'columnas'), sep(),
        item(totals.rows, 'filas')
    );
}

function renderSidebar() {
    const host = $('#sidebar');
    host.textContent = '';

    const groups = new Map();
    for (const table of state.tables) {
        if (!groups.has(table.db)) groups.set(table.db, []);
        groups.get(table.db).push(table);
    }

    for (const [db, tables] of groups) {
        const section = el('section', 'db-section');

        const title = el('h3', 'db-title');
        const dot = el('i', 'db-dot');
        dot.style.setProperty('--c', DB_COLOR[db] || '#4a9eff');
        title.append(dot, document.createTextNode(DB_LABEL[db] || db));
        section.appendChild(title);

        for (const table of tables) {
            const button = el('button', 'tbl-item');
            button.type = 'button';
            button.dataset.table = table.name;

            const name = el('span', 'n', table.name);
            const count = el('span', 'cnt' + (table.rows === 0 ? ' zero' : ''), fmt(table.rows));
            button.append(name, count);
            button.addEventListener('click', () => selectTable(table.name, { resetOffset: true }));

            section.appendChild(button);
        }

        host.appendChild(section);
    }

    applySearch();
    markActive();
}

function applySearch() {
    const query = state.query.trim().toLowerCase();

    for (const button of document.querySelectorAll('.tbl-item')) {
        const table = state.byName.get(button.dataset.table);
        if (!table) continue;
        const match = !query ||
            table.name.toLowerCase().includes(query) ||
            table.columns.some(col => col.name.toLowerCase().includes(query));
        button.classList.toggle('search-dim', !!query && !match);
    }
}

function markActive() {
    for (const button of document.querySelectorAll('.tbl-item')) {
        button.classList.toggle('active', button.dataset.table === state.selected);
    }
}

/* ---------------- vista de tabla ---------------- */

function showError(message) {
    const placeholder = $('#placeholder');
    placeholder.hidden = false;
    placeholder.classList.add('error');
    placeholder.textContent = message;
    $('#tableView').hidden = true;
}

async function loadTable() {
    if (!state.selected) return;

    const params = new URLSearchParams({
        offset: String(state.offset),
        limit: String(state.limit),
        reveal: state.reveal ? '1' : '0'
    });

    try {
        const data = await api(`/api/table/${encodeURIComponent(state.selected)}?${params}`);
        renderTable(data);
    } catch (error) {
        showError(`No se pudo leer «${state.selected}»: ${error.message}`);
    }
}

function renderTable(data) {
    $('#placeholder').hidden = true;
    const view = $('#tableView');
    view.hidden = false;

    $('#tableName').textContent = data.table;

    const badge = $('#tableDb');
    badge.textContent = DB_LABEL[data.db] || data.db;
    badge.classList.toggle('blob', data.db === 'blob');

    const shown = data.rows.length;
    const range = shown
        ? `${fmt(data.offset + 1)}–${fmt(data.offset + shown)} de ${fmt(data.total)}`
        : `0 de ${fmt(data.total)}`;
    $('#tableMeta').textContent = `${fmt(data.total)} fila${data.total === 1 ? '' : 's'} · ${data.columns.length} columnas · ${range}`;

    /* cabecera */
    const thead = $('#dataTable thead');
    thead.textContent = '';
    const headRow = document.createElement('tr');

    const ridHead = el('th', 'rid-h', '#');
    ridHead.title = 'rowid';
    headRow.appendChild(ridHead);

    for (const col of data.columns) {
        const th = document.createElement('th');
        const nameLine = el('span', 'th-name', col.name);
        const chips = el('span', 'ck');
        if (col.pk) chips.appendChild(chip('pk', 'PK'));
        if (col.ref) chips.appendChild(chip('fk', 'FK'));
        if (col.notnull && !col.pk) chips.appendChild(chip('uq', 'NN'));
        nameLine.appendChild(chips);

        const typeLine = el('span', 'th-type', col.type || 'ANY');
        th.append(nameLine, typeLine);

        th.title = [
            `${data.table}.${col.name}`,
            col.type || 'ANY',
            col.pk ? 'PRIMARY KEY' : null,
            col.notnull ? 'NOT NULL' : 'NULL',
            col.ref ? `FK → ${col.ref.table}.${col.ref.toColumn}` : null,
            col.default !== null && col.default !== undefined ? `DEFAULT ${col.default}` : null,
            col.sensitive ? 'enmascarada por defecto' : null
        ].filter(Boolean).join(' · ');

        headRow.appendChild(th);
    }
    thead.appendChild(headRow);

    /* cuerpo */
    const tbody = $('#dataTable tbody');
    tbody.textContent = '';

    for (const row of data.rows) {
        const tr = document.createElement('tr');

        const ridCell = el('td', 'rid', String(row.__rid));
        ridCell.title = `rowid ${row.__rid}`;
        tr.appendChild(ridCell);

        for (const col of data.columns) {
            const value = row.values[col.name];
            const td = document.createElement('td');

            if (value === null) {
                td.className = 'null';
                td.textContent = 'NULL';
                td.title = `${col.name} · NULL`;
            } else if (value === MASK) {
                td.className = 'masked';
                td.textContent = MASK;
                td.title = `${col.name} · enmascarado (activa «revelar» para verlo)`;
            } else if (value === '') {
                td.className = 'empty-value';
                td.textContent = "''";
                td.title = `${col.name} · cadena vacía`;
            } else {
                const text = String(value);
                td.textContent = text;
                td.title = `${col.name} · ${text.length > 2000 ? text.slice(0, 2000) + '…' : text}`;
            }

            tr.appendChild(td);
        }

        tbody.appendChild(tr);
    }

    /* vacío y paginación */
    const hasRows = shown > 0;
    $('#dataTable').style.display = hasRows ? '' : 'none';
    $('#emptyState').hidden = hasRows;

    $('#prev').disabled = data.offset <= 0;
    $('#next').disabled = data.offset + shown >= data.total;

    $('#pageInfo').textContent = shown
        ? `${fmt(data.offset + 1)}–${fmt(data.offset + shown)} de ${fmt(data.total)}`
        : `0 de ${fmt(data.total)}`;
}

/* ---------------- navegación ---------------- */

function selectTable(name, options = {}) {
    state.selected = name;
    if (options.resetOffset !== false) state.offset = 0;

    if (location.hash !== '#' + encodeURIComponent(name)) {
        history.replaceState(null, '', '#' + encodeURIComponent(name));
    }

    markActive();
    loadTable();
}

async function loadOverview() {
    const data = await api('/api/overview');
    state.tables = data.tables;
    state.byName = new Map(data.tables.map(table => [table.name, table]));
    renderStats(data.totals);
    renderSidebar();
    return data;
}

async function refresh() {
    const selected = state.selected;
    try {
        await loadOverview();
        if (selected && state.byName.has(selected)) {
            state.selected = selected;
            renderSidebar();
            await loadTable();
        }
    } catch (error) {
        showError(`No se pudo leer la base: ${error.message}`);
    }
}

/* ---------------- arranque ---------------- */

function wireEvents() {
    $('#search').addEventListener('input', event => {
        state.query = event.target.value;
        applySearch();
    });

    $('#tgl-reveal').addEventListener('change', event => {
        state.reveal = event.target.checked;
        loadTable();
    });

    $('#refresh').addEventListener('click', refresh);

    $('#prev').addEventListener('click', () => {
        state.offset = Math.max(0, state.offset - state.limit);
        loadTable();
    });

    $('#next').addEventListener('click', () => {
        state.offset += state.limit;
        loadTable();
    });

    $('#pageSize').addEventListener('change', event => {
        state.limit = Number(event.target.value) || 100;
        state.offset = 0;
        loadTable();
    });

    window.addEventListener('keydown', event => {
        if (event.key === 'Escape' && document.activeElement === $('#search')) {
            $('#search').value = '';
            state.query = '';
            applySearch();
        }
    });
}

async function init() {
    wireEvents();

    let overview;
    try {
        overview = await loadOverview();
    } catch (error) {
        showError(`No se pudo leer la base: ${error.message}`);
        return;
    }

    const fromHash = decodeURIComponent(location.hash.replace(/^#/, ''));
    const preferred = overview.tables.some(table => table.name === 'users') ? 'users' : null;
    const initial = (fromHash && state.byName.has(fromHash)) ? fromHash : (preferred || (overview.tables[0] && overview.tables[0].name));

    if (initial) selectTable(initial);
}

init();
