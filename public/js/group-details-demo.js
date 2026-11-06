(() => {
    'use strict';

    const GROUP = {
        name: 'Fotografía Nocturna',
        members: 128,
        online: 24
    };

    const MEMBERS = [
        { name: 'Lucía Ferrer', user: 'luciaferrer', role: 'admin', me: true, online: true, last: 'En línea', bg: 'linear-gradient(135deg,#f6c48f,#d98a4b)' },
        { name: 'Mateo Rivas', user: 'mateorivas', role: 'admin', online: true, last: 'En línea', bg: 'linear-gradient(135deg,#9cc7ef,#5d8fc4)' },
        { name: 'Ana Kim', user: 'anakim', role: 'member', online: false, last: 'Últ. vez ayer a las 22:14', bg: 'linear-gradient(135deg,#d6b3ee,#9b6fbf)' },
        { name: 'Jorge Pardo', user: 'jorgepardo', role: 'member', online: true, last: 'En línea', bg: 'linear-gradient(135deg,#a8e3c2,#5fae83)' },
        { name: 'Sofía Duarte', user: 'sofiaduarte', role: 'member', online: false, last: 'Últ. vez hoy a las 09:02', bg: 'linear-gradient(135deg,#f0a8b8,#c76a80)' },
        { name: 'Iván Montes', user: 'ivanmontes', role: 'member', online: true, last: 'En línea', bg: 'linear-gradient(135deg,#f3d68f,#c9a34b)' },
        { name: 'Clara Ríos', user: 'clariarios', role: 'member', online: false, last: 'Últ. vez el lunes', bg: 'linear-gradient(135deg,#a4dbe6,#5fa8b8)' },
        { name: 'Nico Sáez', user: 'nicosaez', role: 'member', online: false, last: 'Últ. vez hoy a las 11:47', bg: 'linear-gradient(135deg,#c3c9f0,#7d86c4)' },
        { name: 'Elena Vidal', user: 'elenavidal', role: 'member', online: true, last: 'En línea', bg: 'linear-gradient(135deg,#f2b6a0,#cc7d63)' },
        { name: 'Pablo Ortiz', user: 'pabloortiz', role: 'member', online: false, last: 'Últ. vez ayer a las 18:30', bg: 'linear-gradient(135deg,#b6e0a8,#79b066)' },
        { name: 'Marta Gil', user: 'martagil', role: 'member', online: false, last: 'Últ. vez el domingo', bg: 'linear-gradient(135deg,#e8c6a0,#bd8f5f)' },
        { name: 'Diego Campos', user: 'diegocampos', role: 'member', online: true, last: 'En línea', bg: 'linear-gradient(135deg,#a9c6f5,#6f8fc9)' }
    ];

    const LIMIT = 6;

    const state = {
        view: 'admin',
        muted: false,
        expanded: false,
        query: '',
        confirmResolve: null,
        toastTimer: 0
    };

    const $ = id => document.getElementById(id);
    const refs = {
        backBtn: $('backBtn'),
        menuBtn: $('menuBtn'),
        muteUse: $('muteUse'),
        muteLabel: $('muteLabel'),
        aboutText: $('aboutText'),
        aboutToggle: $('aboutToggle'),
        viewAllBtn: $('viewAllBtn'),
        memberStrip: $('memberStrip'),
        memberSearch: $('memberSearch'),
        memberList: $('memberList'),
        memberEmpty: $('memberEmpty'),
        memberCount: $('memberCount'),
        viewSeg: $('viewSeg'),
        sheetOverlay: $('sheetOverlay'),
        sheet: $('sheet'),
        editOverlay: $('editOverlay'),
        editFrame: $('editFrame'),
        toast: $('toast'),
        toastText: $('toastText')
    };

    const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[character]));

    const initials = name => String(name || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(part => part[0])
        .join('')
        .toUpperCase() || '?';

    const findMember = user => MEMBERS.find(member => member.user === user);

    function toast(message) {
        clearTimeout(state.toastTimer);
        refs.toastText.textContent = message;
        refs.toast.classList.add('show');
        state.toastTimer = setTimeout(() => refs.toast.classList.remove('show'), 2400);
    }

    /* ---------- Integrantes ---------- */

    function renderStrip() {
        const visible = MEMBERS.slice(0, 8);
        refs.memberStrip.innerHTML = visible.map(member => `
            <span class="strip-avatar" style="background:${member.bg}" title="${escapeHtml(member.name)}">
                ${initials(member.name)}
            </span>`).join('') +
            (GROUP.members > visible.length
                ? `<span class="strip-more">+${GROUP.members - visible.length}</span>`
                : '');
    }

    function filteredMembers() {
        const query = state.query.trim().toLowerCase();
        const list = query
            ? MEMBERS.filter(member => (member.name + ' ' + member.user).toLowerCase().includes(query))
            : MEMBERS;
        return { list, query };
    }

    function renderMembers() {
        const { list, query } = filteredMembers();
        const visible = query || state.expanded ? list : list.slice(0, LIMIT);

        refs.memberCount.textContent = String(GROUP.members);
        refs.viewAllBtn.textContent = state.expanded ? 'Ver menos' : 'Ver todos';
        refs.viewAllBtn.hidden = Boolean(query) || list.length <= LIMIT;

        refs.memberList.innerHTML = visible.map(member => {
            const role = member.role === 'admin' ? '<span class="pill admin">Admin</span>' : '';
            const you = member.me ? '<span class="pill you">Tú</span>' : '';
            const dot = member.online ? '<span class="dot"></span>' : '';
            return `
                <button class="member-row" type="button" data-member="${member.user}">
                    <span class="m-avatar" style="background:${member.bg}">${initials(member.name)}${dot}</span>
                    <span class="m-copy">
                        <span class="m-name"><span class="txt">${escapeHtml(member.name)}</span>${you}${role}</span>
                        <span class="m-sub">@${escapeHtml(member.user)} · ${escapeHtml(member.last)}</span>
                    </span>
                </button>`;
        }).join('');

        refs.memberEmpty.hidden = list.length !== 0;
        refs.memberList.hidden = list.length === 0;
    }

    function renderAll() {
        renderStrip();
        renderMembers();
    }

    /* ---------- Hojas modales ---------- */

    function showSheet(html, mode = 'sheet') {
        const confirmMode = mode === 'confirm';
        refs.sheetOverlay.className = confirmMode ? 'mOverlay confirmOverlay' : 'overlay';
        refs.sheet.className = confirmMode ? 'mSheet' : 'sheet';
        refs.sheet.innerHTML = html;
        refs.sheetOverlay.hidden = false;
    }

    function hideSheet() {
        refs.sheetOverlay.hidden = true;
        refs.sheetOverlay.className = 'overlay';
        refs.sheet.className = 'sheet';
        refs.sheet.innerHTML = '';
        if (state.confirmResolve) {
            const resolve = state.confirmResolve;
            state.confirmResolve = null;
            resolve(false);
        }
    }

    function openMember(user) {
        const member = findMember(user);
        if (!member) return;
        const role = member.role === 'admin' ? '<span class="pill admin" style="margin-top:6px">Administrador</span>' : '';
        showSheet(`
            <div class="sheet-profile">
                <span class="sheet-avatar" style="background:${member.bg}">${initials(member.name)}</span>
                <b>${escapeHtml(member.name)}</b>
                <span class="at">@${escapeHtml(member.user)}</span>
                <span class="presence">${escapeHtml(member.last)}</span>
                ${role}
            </div>
            <div class="sheet-actions">
                <button class="sheet-btn primary" type="button" data-close>Enviar mensaje</button>
                <button class="sheet-btn" type="button" data-close>Cerrar</button>
            </div>`);
    }

    function askConfirm({ title, text, ok, danger }) {
        showSheet(`
            <div class="mTitle">${escapeHtml(title)}</div>
            <div class="mText">${escapeHtml(text)}</div>
            <div class="mBtns">
                <button class="mBtn" type="button" data-confirm="0">Cancelar</button>
                <button class="mBtn ${danger ? 'peligro' : 'ok'}" type="button" data-confirm="1">${escapeHtml(ok)}</button>
            </div>`, 'confirm');
        return new Promise(resolve => { state.confirmResolve = resolve; });
    }

    /* ---------- Editor (diseño de Crear grupo, reutilizado) ---------- */

    function setEditorUrl(url) {
        try {
            refs.editFrame.contentWindow.location.replace(url);
        } catch {
            refs.editFrame.src = url;
        }
    }

    function openEditor() {
        hideMenu();
        refs.editOverlay.hidden = false;
        setEditorUrl('/group-create.html?embedded=1&mode=edit&id=demo');
    }

    function closeEditor() {
        refs.editOverlay.hidden = true;
        setEditorUrl('about:blank');
    }

    window.addEventListener('message', event => {
        if (event.origin !== location.origin) return;
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'zlapy:group-close' || data.type === 'zlapy:group-created') closeEditor();
    });

    /* ---------- Menú ---------- */

    function menuItems() {
        const items = [];
        if (state.view === 'admin') items.push({ id: 'edit', label: 'Editar grupo', icon: 'edit' });
        items.push({ id: 'add', label: 'Añadir personas', icon: 'userPlus' });
        items.push({ id: 'share', label: 'Compartir enlace', icon: 'share' });
        items.push({
            id: 'mute',
            label: state.muted ? 'Activar notificaciones' : 'Silenciar notificaciones',
            icon: state.muted ? 'bell' : 'mute'
        });
        items.push({ id: 'leave', label: 'Salir del grupo', icon: 'logout', danger: true });
        return items;
    }

    function openMenu() {
        if (typeof ZlapyPopMenu === 'undefined') return;
        refs.menuBtn.setAttribute('aria-expanded', 'true');
        const menu = ZlapyPopMenu.open({
            anchor: refs.menuBtn,
            items: menuItems(),
            onSelect: doAction,
            onClose: () => refs.menuBtn.setAttribute('aria-expanded', 'false')
        });
        if (!menu) refs.menuBtn.setAttribute('aria-expanded', 'false');
    }

    function hideMenu() {
        if (typeof ZlapyPopMenu !== 'undefined') ZlapyPopMenu.close();
    }

    /* ---------- Acciones ---------- */

    function toggleMute() {
        state.muted = !state.muted;
        const quick = document.querySelector('.quick[data-action="mute"]');
        refs.muteUse.setAttribute('href', state.muted ? '#i-bell-off' : '#i-bell');
        refs.muteLabel.textContent = state.muted ? 'Silenciado' : 'Silenciar';
        if (quick) quick.setAttribute('aria-pressed', String(state.muted));
        toast(state.muted ? 'Grupo silenciado (demo).' : 'Notificaciones activadas (demo).');
    }

    function doAction(action) {
        hideMenu();
        if (action === 'edit') return openEditor();
        if (action === 'add') return toast('Demo: se abriría el selector de contactos.');
        if (action === 'share') {
            const done = () => toast('Enlace del grupo copiado.');
            const fail = () => toast('Demo: se compartiría el enlace del grupo.');
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(location.href).then(done, fail);
            } else {
                fail();
            }
            return;
        }
        if (action === 'mute') return toggleMute();
        if (action === 'leave') {
            return askConfirm({
                title: 'Salir del grupo',
                text: 'Dejarás de recibir mensajes de «Fotografía Nocturna». En esta demo no se sale de ningún sitio.',
                ok: 'Salir',
                danger: true
            }).then(confirmed => { if (confirmed) toast('Demo: habrías salido del grupo.'); });
        }
        if (action === 'delete') {
            return askConfirm({
                title: 'Eliminar grupo',
                text: 'Se eliminará el grupo para todos sus integrantes. En esta demo no se borra nada.',
                ok: 'Eliminar',
                danger: true
            }).then(confirmed => { if (confirmed) toast('Demo: el grupo se habría eliminado.'); });
        }
    }

    /* ---------- Vista admin / miembro ---------- */

    function setView(view) {
        state.view = view === 'member' ? 'member' : 'admin';
        document.body.dataset.view = state.view;
        refs.viewSeg.querySelectorAll('[data-view]').forEach(button => {
            const on = button.dataset.view === state.view;
            button.classList.toggle('on', on);
            button.setAttribute('aria-pressed', String(on));
        });
        hideMenu();
        toast(state.view === 'admin' ? 'Vista de administrador.' : 'Vista de miembro.');
    }

    /* ---------- Eventos ---------- */

    refs.backBtn.addEventListener('click', () => {
        if (history.length > 1) history.back();
        else location.assign('/');
    });

    refs.menuBtn.addEventListener('click', event => {
        event.stopPropagation();
        if (typeof ZlapyPopMenu !== 'undefined' && ZlapyPopMenu.isOpen()) hideMenu();
        else openMenu();
    });

    refs.aboutToggle.addEventListener('click', () => {
        const clamped = refs.aboutText.classList.toggle('clamped');
        refs.aboutToggle.textContent = clamped ? 'Leer más' : 'Leer menos';
        refs.aboutToggle.setAttribute('aria-expanded', String(!clamped));
    });

    refs.viewAllBtn.addEventListener('click', () => {
        state.expanded = !state.expanded;
        renderMembers();
    });

    refs.memberSearch.addEventListener('input', () => {
        state.query = refs.memberSearch.value;
        renderMembers();
    });

    refs.viewSeg.addEventListener('click', event => {
        const button = event.target.closest('[data-view]');
        if (button) setView(button.dataset.view);
    });

    refs.sheetOverlay.addEventListener('click', event => {
        if (event.target === refs.sheetOverlay) hideSheet();
    });

    document.addEventListener('click', event => {
        const closeBtn = event.target.closest('[data-close]');
        if (closeBtn) {
            hideSheet();
            if (closeBtn.classList.contains('primary')) toast('Demo: abriría el chat con este integrante.');
            return;
        }

        const confirmBtn = event.target.closest('[data-confirm]');
        if (confirmBtn) {
            const confirmed = confirmBtn.dataset.confirm === '1';
            const resolve = state.confirmResolve;
            state.confirmResolve = null;
            hideSheet();
            if (resolve) resolve(confirmed);
            return;
        }

        const memberBtn = event.target.closest('[data-member]');
        if (memberBtn) {
            openMember(memberBtn.dataset.member);
            return;
        }

        const actionBtn = event.target.closest('[data-action]');
        if (actionBtn) {
            doAction(actionBtn.dataset.action);
            return;
        }

    });

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        if (!refs.editOverlay.hidden) closeEditor();
        else if (!refs.sheetOverlay.hidden) hideSheet();
        else if (typeof ZlapyPopMenu !== 'undefined' && ZlapyPopMenu.isOpen()) hideMenu();
    });

    document.addEventListener('contextmenu', event => event.preventDefault());

    renderAll();
})();
