(() => {
    'use strict';

    const params = new URLSearchParams(location.search);
    const embedded = params.get('embedded') === '1' && window.parent !== window;
    const groupId = params.get('id') || '';
    const PREVIEW_KEY = 'zlapy:group-details-preview:' + groupId;
    const LIST_LIMIT = 20;
    const AVATAR_COLORS = ['#2f6f68', '#4a5b8c', '#7a4d7d', '#8a5a3b', '#3f6b4a', '#6b5a2f'];

    const refs = {
        backBtn: document.getElementById('backBtn'),
        topbarName: document.getElementById('topbarName'),
        appbarSub: document.getElementById('appbarSub'),
        editQuick: document.getElementById('editQuick'),
        loadingState: document.getElementById('loadingState'),
        errorState: document.getElementById('errorState'),
        errorTitle: document.getElementById('errorTitle'),
        errorText: document.getElementById('errorText'),
        errorBackBtn: document.getElementById('errorBackBtn'),
        retryBtn: document.getElementById('retryBtn'),
        mainContent: document.getElementById('mainContent'),
        heroAvatarArt: document.getElementById('heroAvatarArt'),
        groupName: document.getElementById('groupName'),
        heroMeta: document.getElementById('heroMeta'),
        visibilityPill: document.getElementById('visibilityPill'),
        heroPresence: document.getElementById('heroPresence'),
        addQuick: document.getElementById('addQuick'),
        shareQuick: document.getElementById('shareQuick'),
        muteQuick: document.getElementById('muteQuick'),
        muteIcon: document.getElementById('muteIcon'),
        muteLabel: document.getElementById('muteLabel'),
        aboutCard: document.getElementById('aboutCard'),
        aboutText: document.getElementById('aboutText'),
        aboutToggle: document.getElementById('aboutToggle'),
        infoDetails: document.getElementById('infoDetails'),
        infoSummary: document.getElementById('infoSummary'),
        infoNote: document.getElementById('infoNote'),
        requestsCard: document.getElementById('requestsCard'),
        requestCount: document.getElementById('requestCount'),
        requestList: document.getElementById('requestList'),
        memberCount: document.getElementById('memberCount'),
        memberStrip: document.getElementById('memberStrip'),
        memberSearchWrap: document.getElementById('memberSearchWrap'),
        memberSearch: document.getElementById('memberSearch'),
        clearSearch: document.getElementById('clearSearch'),
        memberList: document.getElementById('memberList'),
        memberEmpty: document.getElementById('memberEmpty'),
        viewAllBtn: document.getElementById('viewAllBtn'),
        leaveBtn: document.getElementById('leaveBtn'),
        deleteBtn: document.getElementById('deleteBtn'),
        pickerOverlay: document.getElementById('pickerOverlay'),
        peopleTitle: document.getElementById('peopleTitle'),
        peopleHint: document.getElementById('peopleHint'),
        copyInviteRow: document.getElementById('copyInviteRow'),
        copyInviteBtn: document.getElementById('copyInviteBtn'),
        peopleSearch: document.getElementById('peopleSearch'),
        peopleList: document.getElementById('peopleList'),
        peopleOk: document.getElementById('peopleOk'),
        sheetOverlay: document.getElementById('sheetOverlay'),
        sheet: document.getElementById('sheet'),
        toast: document.getElementById('toast'),
        toastText: document.getElementById('toastText')
    };

    const state = {
        me: null,
        group: null,
        profiles: {},
        contacts: [],
        picker: null,
        query: '',
        expanded: false,
        aboutExpanded: false,
        muted: false,
        busy: false,
        confirmResolve: null,
        toastTimer: 0,
        copyTimer: 0
    };

    /* ============ utilidades ============ */

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function normalize(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
    }

    function initials(value) {
        const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return '?';
        return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
    }

    function colorFor(username) {
        let hash = 0;
        const text = String(username || '');
        for (let index = 0; index < text.length; index += 1)
            hash = ((hash << 5) - hash) + text.charCodeAt(index);
        return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
    }

    function avatarStyle(username) {
        const color = colorFor(username);
        return `--av-a:${color};--av-b:color-mix(in srgb, ${color} 52%, #000)`;
    }

    function profileFor(username) {
        return state.profiles[username] || null;
    }

    function displayName(username) {
        const profile = profileFor(username);
        return (profile && typeof profile.name === 'string' && profile.name.trim())
            ? profile.name.trim()
            : String(username || '');
    }

    function avatarSrc(username) {
        const profile = profileFor(username);
        if (profile && typeof profile.avatar === 'string' && profile.avatar) return profile.avatar;
        const key = (profile && profile.id) || username;
        return key ? '/avatar/' + encodeURIComponent(key) + '.svg?v=3' : '';
    }

    function contactByUsername(username) {
        return state.contacts.find(contact => contact && contact.username === username) || null;
    }

    function isSelf(username) {
        return Boolean(state.me && state.me.username === username);
    }

    function isAdmin(username) {
        const target = username || (state.me && state.me.username);
        return Boolean(target && state.group && (state.group.admins || []).includes(target));
    }

    function canAdd() {
        return Boolean(state.group && (state.group.addPolicy === 'all' || isAdmin()));
    }

    function canEdit() {
        return Boolean(state.group && (isAdmin() || state.group.editPolicy === 'all'));
    }

    function memberWord(count) {
        return count === 1 ? 'integrante' : 'integrantes';
    }

    function presenceText(contact) {
        if (!contact) return '';
        if (contact.online) return 'en línea';
        if (!contact.lastSeen) return '';
        const date = new Date(contact.lastSeen);
        if (!Number.isFinite(date.getTime())) return '';
        const now = new Date();
        const time = date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const startThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        const daysAgo = Math.round((startToday - startThatDay) / 86400000);
        if (daysAgo === 0) return `Últ. vez hoy a las ${time}`;
        if (daysAgo === 1) return `Últ. vez ayer a las ${time}`;
        return `Últ. vez ${date.toLocaleDateString('es', { day: 'numeric', month: 'short' })} a las ${time}`;
    }

    function createdText(timestamp) {
        const date = new Date(timestamp);
        if (!Number.isFinite(date.getTime())) return '';
        return date.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function avatarHtml(username, className, withPresence) {
        const src = avatarSrc(username);
        const online = Boolean(contactByUsername(username) && contactByUsername(username).online);
        const dot = withPresence !== false && online ? '<span class="online-dot"></span>' : '';
        const art = src
            ? `<img src="${escapeHtml(src)}" alt="">`
            : escapeHtml(initials(displayName(username) || username));
        return `<span class="${className}" style="${avatarStyle(username)}">${art}${dot}</span>`;
    }

    function showToast(message, kind) {
        if (!message) return;
        window.clearTimeout(state.toastTimer);
        refs.toastText.textContent = message;
        refs.toast.className = 'toast show' + (kind === 'alert' ? ' alert' : '');
        state.toastTimer = window.setTimeout(() => {
            refs.toast.className = 'toast';
        }, 3200);
    }

    function postToParent(type, payload) {
        if (!embedded) return;
        try {
            window.parent.postMessage({ type, ...(payload || {}) }, location.origin);
        } catch (error) {
            console.error('[detalles] No se pudo avisar a la app:', error);
        }
    }

    /* ============ carga de datos ============ */

    async function fetchGroup() {
        const response = await fetch('/groups/' + encodeURIComponent(groupId) + '?light=1', { cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(data.error || 'No se pudo cargar el grupo.');
            error.status = response.status;
            throw error;
        }
        if (!data || !data.id) throw new Error('El grupo no está disponible.');
        return data;
    }

    async function fetchMe() {
        try {
            const response = await fetch('/auth/session', { cache: 'no-store' });
            const data = await response.json().catch(() => ({}));
            return data && data.user ? data.user : null;
        } catch {
            return null;
        }
    }

    async function loadContacts() {
        try {
            const response = await fetch('/contacts', { cache: 'no-store' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) return;
            const list = Array.isArray(data.users) ? data.users : [];
            state.contacts = list.filter(contact => contact && contact.username && !isSelf(contact.username));
        } catch (error) {
            console.error('[detalles] No se pudieron cargar los contactos:', error);
        }
    }

    async function loadPreferences() {
        try {
            const response = await fetch('/chat/preferences', { cache: 'no-store' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) return;
            const muted = Array.isArray(data.mutedPeers) ? data.mutedPeers : [];
            state.muted = muted.includes('group:' + groupId);
        } catch (error) {
            console.error('[detalles] No se pudo leer el estado de silencio:', error);
        }
    }

    function groupProfileNames(group) {
        const names = [...(group.members || [])];
        for (const request of group.joinRequests || []) {
            if (request && request.username) names.push(request.username);
        }
        return [...new Set(names.filter(Boolean))];
    }

    async function ensureProfiles(usernames) {
        const wanted = [...new Set((usernames || []).filter(Boolean))]
            .filter(username => !state.profiles[username]);
        if (!wanted.length) return;
        await Promise.all(wanted.map(async username => {
            try {
                const response = await fetch('/profile?username=' + encodeURIComponent(username), { cache: 'no-store' });
                if (!response.ok) return;
                const profile = await response.json().catch(() => null);
                if (profile && profile.username) state.profiles[username] = profile;
            } catch (error) {
                console.error('[detalles] No se pudo cargar el perfil de @' + username + ':', error);
            }
        }));
    }

    async function post(path, body) {
        const response = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'No se pudo completar la acción.');
        return data;
    }

    function readPreview() {
        try {
            const parsed = JSON.parse(sessionStorage.getItem(PREVIEW_KEY) || 'null');
            if (parsed && parsed.group && parsed.group.id === groupId) {
                state.group = parsed.group;
                state.me = parsed.me || state.me;
            }
        } catch { }
    }

    /* ============ pintado ============ */

    function renderHeader() {
        const group = state.group;
        const count = (group.members || []).length;
        document.title = (group.name || 'Grupo') + ' — Zlapy';
        refs.topbarName.textContent = 'Detalles del grupo';
        refs.appbarSub.textContent = `${count} ${memberWord(count)}`;
    }

    function renderIdentity() {
        const group = state.group;
        if (group.avatar && typeof group.avatar === 'string') {
            refs.heroAvatarArt.innerHTML = '';
            const img = document.createElement('img');
            img.src = group.avatar;
            img.alt = '';
            refs.heroAvatarArt.append(img);
            return;
        }
        const members = (group.members || []).slice(0, 4);
        if (!members.length) {
            refs.heroAvatarArt.innerHTML =
                `<span class="collage" data-count="1"><span class="collage-tile" style="${avatarStyle(group.id || group.name)}">${escapeHtml(initials(group.name))}</span></span>`;
            return;
        }
        const tiles = members.map(username => {
            const src = avatarSrc(username);
            const art = src
                ? `<img src="${escapeHtml(src)}" alt="">`
                : `<span style="${avatarStyle(username)}">${escapeHtml(initials(displayName(username) || username))}</span>`;
            return `<span class="collage-tile">${art}</span>`;
        }).join('');
        refs.heroAvatarArt.innerHTML = `<span class="collage" data-count="${members.length}">${tiles}</span>`;
    }

    function renderHero() {
        const group = state.group;
        renderIdentity();
        refs.groupName.textContent = group.name || 'Grupo';
        const publicGroup = group.visibility === 'public';
        refs.visibilityPill.innerHTML =
            `<svg class="icon" aria-hidden="true"><use href="#i-${publicGroup ? 'globe' : 'lock'}"></use></svg>${publicGroup ? 'Grupo público' : 'Grupo privado'}`;

        const knownMembers = (group.members || []).filter(username => !isSelf(username));
        const created = createdText(group.createdAt);
        refs.heroMeta.hidden = !created;
        refs.heroMeta.textContent = created ? `Creado el ${created}` : '';
        const allKnown = knownMembers.length > 0 && knownMembers.every(username => Boolean(contactByUsername(username)));
        const online = knownMembers.filter(username => {
            const contact = contactByUsername(username);
            return contact && contact.online;
        }).length;
        refs.heroPresence.hidden = !allKnown || !online;
        refs.heroPresence.textContent = online === 1 ? '1 contacto en línea' : `${online} contactos en línea`;
        refs.heroPresence.title = refs.heroPresence.textContent;

        refs.addQuick.hidden = !canAdd();
        refs.editQuick.hidden = !canEdit();
        refs.muteQuick.classList.toggle('on', state.muted);
        refs.muteQuick.setAttribute('aria-pressed', String(state.muted));
        refs.muteQuick.setAttribute('aria-label', state.muted ? 'Reactivar avisos del grupo' : 'Silenciar grupo');
        refs.muteQuick.title = state.muted ? 'Reactivar avisos del grupo' : 'Silenciar grupo';
        refs.muteLabel.textContent = state.muted ? 'Silenciado' : 'Silenciar';
        const use = refs.muteIcon.querySelector('use');
        if (use) use.setAttribute('href', state.muted ? '#i-bell-off' : '#i-bell');

        refs.deleteBtn.hidden = !isAdmin();
    }

    function renderAbout() {
        const group = state.group;
        const description = typeof group.description === 'string' ? group.description.trim() : '';
        /* Sin descripción no hay tarjeta: un bloque «Acerca de» vacío solo
           añade ruido entre la portada y los integrantes. */
        refs.aboutCard.hidden = !description;
        if (!description) return;
        refs.aboutText.textContent = description;
        refs.aboutText.classList.add('clamped');
        refs.aboutText.classList.remove('is-empty');
        const long = refs.aboutText.scrollHeight > refs.aboutText.clientHeight + 2;
        if (!long) state.aboutExpanded = false;
        refs.aboutText.classList.toggle('clamped', !state.aboutExpanded);
        refs.aboutToggle.hidden = !long;
        refs.aboutToggle.textContent = state.aboutExpanded ? 'Leer menos' : 'Leer más';
        refs.aboutToggle.setAttribute('aria-expanded', String(state.aboutExpanded));
    }

    const INFO_FIELDS = {
        visibility: 'visibility',
        join: 'joinPolicy',
        write: 'writePolicy',
        add: 'addPolicy',
        edit: 'editPolicy',
        mention: 'mentionAllPolicy'
    };

    function renderInfo() {
        const group = state.group;
        const values = {
            visibility: group.visibility,
            join: group.joinPolicy,
            write: group.writePolicy,
            add: group.addPolicy,
            edit: group.editPolicy,
            mention: group.mentionAllPolicy
        };
        refs.infoDetails.querySelectorAll('.info-row[data-info-key]').forEach(row => {
            const key = row.dataset.infoKey;
            row.querySelectorAll('.seg button[data-value]').forEach(button => {
                const active = button.dataset.value === values[key];
                button.classList.toggle('on', active);
                button.setAttribute('aria-pressed', String(active));
                /* Los permisos son cosa de administradores: el resto ve el
                   estado, pero no puede cambiarlo desde aquí. */
                button.disabled = !isAdmin();
            });
        });
        const activeLabel = key => {
            const button = refs.infoDetails.querySelector(`.info-row[data-info-key="${key}"] button.on`);
            return button ? button.textContent.trim() : '';
        };
        refs.infoSummary.textContent =
            `${activeLabel('visibility')} · ${activeLabel('join')} · ${activeLabel('write') === 'Todos' ? 'Todos escriben' : 'Solo admins escriben'}`;
        refs.infoNote.hidden = isAdmin();
    }

    async function updateInfoPolicy(key, value) {
        const field = INFO_FIELDS[key];
        if (!field || !isAdmin() || state.busy || !state.group || state.group[field] === value) return;
        await groupAction({ [field]: value }, 'Permisos actualizados.');
    }

    function memberSort(left, right) {
        const leftAdmin = (state.group.admins || []).includes(left) ? 0 : 1;
        const rightAdmin = (state.group.admins || []).includes(right) ? 0 : 1;
        if (leftAdmin !== rightAdmin) return leftAdmin - rightAdmin;
        return displayName(left).localeCompare(displayName(right), 'es', { sensitivity: 'base' });
    }

    function memberRow(username) {
        const admin = (state.group.admins || []).includes(username);
        const contact = contactByUsername(username);
        const presence = contact ? presenceText(contact) : '';
        const subtitle = ['@' + username, presence].filter(Boolean).join(' · ');
        return `<button class="contact" type="button" data-profile="${escapeHtml(username)}">
            ${avatarHtml(username, 'person-avatar', true)}
            <span class="person-copy">
                <span class="person-name">
                    <b>${escapeHtml(displayName(username))}</b>
                    ${admin ? '<span class="tag admin">Admin</span>' : ''}
                    ${isSelf(username) ? '<span class="tag you">Tú</span>' : ''}
                </span>
                <span class="person-sub">${escapeHtml(subtitle)}</span>
            </span>
            <svg class="icon member-chevron"><use href="#i-chevron"></use></svg>
        </button>`;
    }

    function renderMembers() {
        const group = state.group;
        const members = [...(group.members || [])].sort(memberSort);
        if (members.length < 8 && state.query) {
            state.query = '';
            refs.memberSearch.value = '';
        }
        const query = normalize(state.query);
        const filtered = members.filter(username => {
            if (!query) return true;
            return normalize(`${displayName(username)} ${username}`).includes(query);
        });
        const visible = state.expanded || query ? filtered : filtered.slice(0, LIST_LIMIT);

        const faces = members.slice(0, 5)
            .map(username => avatarHtml(username, 'strip-avatar', false))
            .join('');
        const remaining = members.length - Math.min(members.length, 5);
        const names = members.map(username => displayName(username));
        const summary = !names.length
            ? ''
            : names.length === 1
                ? names[0]
                : names.length === 2
                    ? `${names[0]} y ${names[1]}`
                    : names.length === 3
                        ? `${names[0]}, ${names[1]} y ${names[2]}`
                        : `${names.slice(0, 2).join(', ')} y ${names.length - 2} más`;
        refs.memberStrip.innerHTML = `<span class="strip-faces">${faces}${remaining > 0 ? `<span class="strip-more">+${remaining}</span>` : ''}</span><span class="strip-label">${escapeHtml(summary)}</span>`;
        refs.memberStrip.hidden = !members.length || Boolean(query);
        refs.memberSearchWrap.hidden = members.length < 8;

        refs.memberCount.textContent = String(members.length);
        refs.memberCount.classList.toggle('is-empty', members.length === 0);
        refs.memberList.innerHTML = visible.map(memberRow).join('');
        refs.memberEmpty.hidden = filtered.length > 0;
        refs.clearSearch.hidden = !state.query;
        if (document.activeElement !== refs.memberSearch) refs.memberSearch.value = state.query;
        refs.viewAllBtn.hidden = Boolean(query) || filtered.length <= LIST_LIMIT;
        refs.viewAllBtn.textContent = state.expanded ? 'Ver menos' : `Ver todos (${filtered.length})`;
    }

    function requestRow(request) {
        const username = typeof request === 'string' ? request : request && request.username;
        if (!username) return '';
        return `<div class="contact">
            ${avatarHtml(username, 'person-avatar', false)}
            <span class="person-copy">
                <span class="person-name"><b>${escapeHtml(displayName(username))}</b></span>
                <span class="person-sub">@${escapeHtml(username)}</span>
            </span>
            <span class="request-actions">
                <button class="icon-action accept" type="button" data-request-action="approve" data-user="${escapeHtml(username)}" aria-label="Aceptar solicitud" title="Aceptar solicitud">
                    <svg class="icon"><use href="#i-check"></use></svg>
                </button>
                <button class="icon-action reject" type="button" data-request-action="reject" data-user="${escapeHtml(username)}" aria-label="Rechazar solicitud" title="Rechazar solicitud">
                    <svg class="icon"><use href="#i-x"></use></svg>
                </button>
            </span>
        </div>`;
    }

    function renderRequests() {
        const requests = isAdmin() && Array.isArray(state.group.joinRequests)
            ? state.group.joinRequests.filter(request => request && (typeof request === 'string' || request.username))
            : [];
        refs.requestsCard.hidden = !requests.length;
        refs.requestCount.textContent = String(requests.length);
        refs.requestList.innerHTML = requests.map(requestRow).join('');
    }

    function renderAll() {
        if (!state.group) return;
        renderHeader();
        renderHero();
        renderAbout();
        renderInfo();
        renderRequests();
        renderMembers();
    }

    /* ============ estados ============ */

    function showLoading() {
        refs.loadingState.hidden = false;
        refs.errorState.hidden = true;
        refs.mainContent.hidden = true;
    }

    function showError(error) {
        const status = error && error.status;
        refs.loadingState.hidden = true;
        refs.mainContent.hidden = true;
        refs.errorState.hidden = false;
        refs.topbarName.textContent = 'Detalles del grupo';
        refs.errorTitle.textContent = status === 403
            ? 'No tienes acceso a este grupo'
            : status === 404
                ? 'El grupo ya no está disponible'
                : 'No se pudo abrir el grupo';
        refs.errorText.textContent = (error && error.message)
            || 'Comprueba la conexión e inténtalo de nuevo.';
    }

    function revealGroup() {
        refs.loadingState.hidden = true;
        refs.errorState.hidden = true;
        refs.mainContent.hidden = false;
        renderAll();
    }

    async function refreshGroup() {
        const group = await fetchGroup();
        state.group = group;
        await ensureProfiles(groupProfileNames(group));
        return group;
    }

    /* ============ hojas (modales) ============ */

    function openSheet(content) {
        refs.sheet.innerHTML = content;
        refs.sheetOverlay.hidden = false;
    }

    function settleConfirm(value) {
        const resolve = state.confirmResolve;
        state.confirmResolve = null;
        refs.sheetOverlay.hidden = true;
        refs.sheet.innerHTML = '';
        if (resolve) resolve(value);
    }

    function closeSheet() {
        settleConfirm(false);
    }

    function confirmAction(options) {
        if (state.confirmResolve) settleConfirm(false);
        return new Promise(resolve => {
            state.confirmResolve = resolve;
            openSheet(`<div class="mTitle">${escapeHtml(options.title)}</div>
            <div class="mText">${escapeHtml(options.text)}</div>
            <div class="mBtns">
                <button class="mBtn" type="button" data-confirm="no">Cancelar</button>
                <button class="mBtn peligro" type="button" data-confirm="yes">${escapeHtml(options.confirmLabel || 'Confirmar')}</button>
            </div>`);
        });
    }

    function openProfile(username) {
        if (!username || !state.group) return;
        const contact = contactByUsername(username);
        const admin = (state.group.admins || []).includes(username);
        const presence = contact ? presenceText(contact) : '';
        const actions = [];

        if (contact && !isSelf(username)) {
            actions.push(`<button class="mBtn" type="button" data-sheet-action="message" data-user="${escapeHtml(username)}">Enviar mensaje</button>`);
        }
        if (isAdmin() && !isSelf(username)) {
            actions.push(`<button class="mBtn" type="button" data-sheet-action="${admin ? 'remove-admin' : 'make-admin'}" data-user="${escapeHtml(username)}">${admin ? 'Quitar administrador' : 'Hacer administrador'}</button>`);
        }

        const name = displayName(username);
        const avatar = avatarHtml(username, 'profile-avatar', false);
        openSheet(`<div class="profile-hero">
            ${avatar}
            <div class="mTitle">${escapeHtml(name)}</div>
            <div class="mText">@${escapeHtml(username)}${presence ? ' · ' + escapeHtml(presence) : ''}</div>
            ${admin ? '<span class="tag admin profile-role">Administrador</span>' : ''}
        </div>
        ${actions.length ? `<div class="mBtns">${actions.join('')}</div>` : ''}
        ${isAdmin() && !isSelf(username) ? `<div class="mBtns"><button class="mBtn peligro" type="button" data-sheet-action="remove-member" data-user="${escapeHtml(username)}">Quitar del grupo</button></div>` : ''}
        <div class="mBtns">
            <button class="mBtn" type="button" data-sheet-action="close">Cerrar</button>
        </div>`);
    }

    /* ============ acciones sobre el grupo ============ */

    async function groupAction(payload, message) {
        if (state.busy || !state.group) return;
        state.busy = true;
        try {
            await post('/groups/' + encodeURIComponent(state.group.id), payload);
            await refreshGroup();
            renderAll();
            showToast(message, 'check');
        } catch (error) {
            console.error('[detalles] No se pudo actualizar el grupo:', error);
            showToast(error.message || 'No se pudo actualizar el grupo.', 'alert');
        } finally {
            state.busy = false;
        }
    }

    function makeAdmin(username) {
        closeSheet();
        return groupAction({ approveAdmin: username }, 'Ahora es administrador.');
    }

    function removeAdmin(username) {
        closeSheet();
        return groupAction({ removeAdmin: username }, 'Ya no es administrador.');
    }

    async function removeMember(username) {
        const name = displayName(username);
        const ok = await confirmAction({
            title: 'Quitar del grupo',
            text: `¿Quieres quitar a ${name} (@${username}) del grupo?`,
            confirmLabel: 'Quitar'
        });
        if (!ok) return;
        await groupAction({ removeMember: username }, 'Integrante eliminado.');
    }

    function approveRequest(username) {
        return groupAction({ approveJoin: username }, 'Solicitud aceptada.');
    }

    function rejectRequest(username) {
        return groupAction({ rejectJoin: username }, 'Solicitud rechazada.');
    }

    async function toggleMute() {
        if (!state.group || state.busy) return;
        const next = !state.muted;
        state.muted = next;
        renderHero();
        try {
            await post('/chat/preferences', {
                targets: ['group:' + state.group.id],
                muted: next
            });
            showToast(next ? 'Grupo silenciado.' : 'Avisos del grupo activados.', 'check');
        } catch (error) {
            state.muted = !next;
            renderHero();
            showToast(error.message || 'No se pudo cambiar el silencio.', 'alert');
        }
    }

    /* ============ selector de personas (añadir / compartir) ============ */

    function openPeoplePicker(mode) {
        if (!state.group) return;
        const adding = mode === 'add';
        const members = new Set(state.group.members || []);
        const available = state.contacts.filter(contact => !adding || !members.has(contact.username));
        state.picker = {
            mode,
            selected: new Set(),
            query: '',
            emptyText: !state.contacts.length
                ? 'Todavía no tienes contactos.'
                : !available.length
                    ? 'Tus contactos ya están en el grupo.'
                    : 'No hay contactos que coincidan.'
        };
        refs.peopleTitle.textContent = adding ? 'Añadir participantes' : 'Compartir grupo';
        refs.peopleOk.textContent = adding ? 'Añadir' : 'Compartir';
        window.clearTimeout(state.copyTimer);
        refs.copyInviteBtn.classList.remove('copied');
        refs.copyInviteBtn.textContent = 'Copiar enlace de invitación';
        refs.copyInviteRow.hidden = adding || !state.group.inviteCode;
        refs.peopleSearch.value = '';
        refs.pickerOverlay.hidden = false;
        renderPicker();
        refs.peopleSearch.focus({ preventScroll: true });
    }

    function closePeoplePicker() {
        refs.pickerOverlay.hidden = true;
        state.picker = null;
        state.busy = false;
    }

    function renderPicker() {
        const picker = state.picker;
        if (!picker) return;
        const members = new Set((state.group && state.group.members) || []);
        const query = normalize(picker.query);
        const candidates = state.contacts.filter(contact => {
            if (picker.mode === 'add' && members.has(contact.username)) return false;
            return !query || normalize(`${displayName(contact.username)} ${contact.username}`).includes(query);
        });
        refs.peopleList.innerHTML = candidates.length
            ? candidates.map(contact => {
                const username = contact.username;
                const checked = picker.selected.has(username);
                const src = avatarSrc(username);
                const art = src
                    ? `<img src="${escapeHtml(src)}" alt="">`
                    : escapeHtml(initials(displayName(username) || username));
                return `<label class="pickerPerson">
                    <input type="checkbox" value="${escapeHtml(username)}" ${checked ? 'checked' : ''}>
                    <span class="av" style="${avatarStyle(username)}">${art}</span>
                    <span class="meta"><b>${escapeHtml(displayName(username))}</b><span class="sub">@${escapeHtml(username)}</span></span>
                </label>`;
            }).join('')
            : `<div class="help">${escapeHtml(picker.emptyText)}</div>`;
        refs.peopleOk.disabled = !picker.selected.size || state.busy;
        updatePickerHint(picker);
    }

    function updatePickerHint(picker) {
        const names = [...picker.selected].map(username => displayName(username));
        refs.peopleHint.textContent = names.length
            ? `Seleccionados: ${names.join(', ')}`
            : 'Ningún contacto seleccionado';
    }

    async function addSelectedMembers(selected) {
        let added = 0;
        for (const username of selected) {
            try {
                await post('/groups/' + encodeURIComponent(state.group.id), { addMember: username });
                added += 1;
            } catch (error) {
                showToast(error.message || 'No se pudo añadir al integrante.', 'alert');
                break;
            }
        }
        if (!added) return;
        await refreshGroup();
        renderAll();
        showToast(added === 1 ? 'Integrante añadido.' : `Integrantes añadidos: ${added}.`, 'check');
    }

    async function shareInvite(selected) {
        if (!state.group.inviteCode) {
            showToast('No tienes una invitación disponible para compartir.', 'alert');
            return;
        }
        let shared = 0;
        for (const username of selected) {
            try {
                await post('/send', {
                    to: username,
                    kind: 'group-invite',
                    groupId: state.group.id,
                    inviteCode: state.group.inviteCode
                });
                shared += 1;
            } catch (error) {
                console.error('[detalles] No se pudo compartir la invitación:', error);
            }
        }
        showToast(shared
            ? `Invitación compartida en ${shared} chat${shared === 1 ? '' : 's'}.`
            : 'No se pudo compartir la invitación.', shared ? 'check' : 'alert');
    }

    async function copyInviteLink() {
        if (!state.group || !state.group.inviteCode) {
            showToast('No tienes una invitación disponible para compartir.', 'alert');
            return;
        }
        const link = `${location.origin}/?join=${encodeURIComponent(state.group.id)}&code=${encodeURIComponent(state.group.inviteCode)}`;
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(link);
            } else {
                const field = document.createElement('textarea');
                field.value = link;
                field.setAttribute('readonly', '');
                field.style.position = 'fixed';
                field.style.left = '-9999px';
                document.body.append(field);
                field.select();
                field.setSelectionRange(0, field.value.length);
                const copied = document.execCommand('copy');
                field.remove();
                if (!copied) throw new Error('copy');
            }
            refs.copyInviteBtn.textContent = 'Enlace copiado';
            refs.copyInviteBtn.classList.add('copied');
            window.clearTimeout(state.copyTimer);
            state.copyTimer = window.setTimeout(() => {
                refs.copyInviteBtn.textContent = 'Copiar enlace de invitación';
                refs.copyInviteBtn.classList.remove('copied');
            }, 2000);
        } catch (error) {
            console.error('[detalles] No se pudo copiar el enlace:', error);
            showToast('No se pudo copiar el enlace.', 'alert');
        }
    }

    async function confirmPickerSelection() {
        const picker = state.picker;
        if (!picker || !picker.selected.size || state.busy) return;
        const selected = [...picker.selected];
        state.busy = true;
        refs.peopleOk.disabled = true;
        try {
            if (picker.mode === 'add') await addSelectedMembers(selected);
            else await shareInvite(selected);
        } catch (error) {
            showToast(error.message || 'No se pudo completar la acción.', 'alert');
        } finally {
            state.busy = false;
            closePeoplePicker();
        }
    }

    function finishGroupRemoval(type) {
        try { sessionStorage.removeItem(PREVIEW_KEY); } catch { }
        if (embedded) {
            postToParent(type, { groupId: state.group.id });
            window.setTimeout(() => {
                if (!state.group) return;
                showToast(type === 'zlapy:group-deleted' ? 'Grupo eliminado.' : 'Saliste del grupo.', 'check');
                goBack();
            }, 1200);
            return;
        }
        location.assign('/');
    }

    async function leaveGroup() {
        if (!state.group || state.busy) return;
        const ok = await confirmAction({
            title: 'Salir del grupo',
            text: `¿Seguro que quieres salir de "${state.group.name}"? Dejarás de recibir sus mensajes.`,
            confirmLabel: 'Salir'
        });
        if (!ok) return;
        state.busy = true;
        try {
            await post('/groups/' + encodeURIComponent(state.group.id), { leave: true });
            finishGroupRemoval('zlapy:group-left');
        } catch (error) {
            showToast(error.message || 'No se pudo salir del grupo.', 'alert');
        } finally {
            state.busy = false;
        }
    }

    async function deleteGroup() {
        if (!state.group || !isAdmin() || state.busy) return;
        const ok = await confirmAction({
            title: 'Eliminar grupo',
            text: `Se eliminará "${state.group.name}" para todos los integrantes y no se podrá recuperar.`,
            confirmLabel: 'Eliminar para todos'
        });
        if (!ok) return;
        state.busy = true;
        try {
            await post('/groups/' + encodeURIComponent(state.group.id), { deleteGroup: true });
            finishGroupRemoval('zlapy:group-deleted');
        } catch (error) {
            showToast(error.message || 'No se pudo eliminar el grupo.', 'alert');
        } finally {
            state.busy = false;
        }
    }

    function requestEdit() {
        if (!state.group || !canEdit()) return;
        if (embedded) {
            postToParent('zlapy:edit-group', { groupId: state.group.id });
            return;
        }
        location.assign('/group-create.html?mode=edit&id=' + encodeURIComponent(state.group.id));
    }

    function goBack() {
        if (embedded) {
            postToParent('zlapy:group-details-close');
            return;
        }
        if (history.length > 1) history.back();
        else location.assign('/');
    }

    function handleSheetAction(action, username) {
        if (action === 'close') {
            closeSheet();
            return;
        }
        if (action === 'message') {
            closeSheet();
            if (embedded) postToParent('zlapy:open-chat', { username });
            else showToast('Abre el chat desde la app para enviar un mensaje.', 'alert');
            return;
        }
        if (action === 'make-admin') {
            makeAdmin(username);
            return;
        }
        if (action === 'remove-admin') {
            removeAdmin(username);
            return;
        }
        if (action === 'remove-member') {
            closeSheet();
            removeMember(username);
        }
    }

    /* ============ eventos ============ */

    function bindEvents() {
        /* En escritorio el cierre se representa con ✕ (patrón de los paneles
           de WhatsApp Desktop); en Android se mantiene la flecha atrás. */
        if (!/Android/i.test(navigator.userAgent)) {
            const use = refs.backBtn.querySelector('use');
            if (use) use.setAttribute('href', '#i-x');
            refs.backBtn.setAttribute('aria-label', 'Cerrar detalles del grupo');
            refs.backBtn.setAttribute('title', 'Cerrar');
        }
        refs.backBtn.addEventListener('click', goBack);
        refs.errorBackBtn.addEventListener('click', goBack);
        refs.retryBtn.addEventListener('click', () => location.reload());
        refs.editQuick.addEventListener('click', requestEdit);
        refs.infoDetails.addEventListener('click', event => {
            const button = event.target.closest('.seg button[data-value]');
            const row = button && button.closest('.info-row[data-info-key]');
            if (!row) return;
            updateInfoPolicy(row.dataset.infoKey, button.dataset.value);
        });

        refs.addQuick.addEventListener('click', () => openPeoplePicker('add'));
        refs.shareQuick.addEventListener('click', () => openPeoplePicker('share'));
        refs.muteQuick.addEventListener('click', toggleMute);

        refs.aboutToggle.addEventListener('click', () => {
            state.aboutExpanded = !state.aboutExpanded;
            renderAbout();
        });

        refs.memberSearch.addEventListener('input', event => {
            state.query = event.target.value;
            renderMembers();
        });
        refs.clearSearch.addEventListener('click', () => {
            state.query = '';
            refs.memberSearch.value = '';
            renderMembers();
            refs.memberSearch.focus();
        });
        refs.viewAllBtn.addEventListener('click', () => {
            state.expanded = !state.expanded;
            renderMembers();
        });
        refs.memberList.addEventListener('click', event => {
            const row = event.target.closest('[data-profile]');
            if (row) openProfile(row.dataset.profile);
        });

        refs.requestList.addEventListener('click', event => {
            const button = event.target.closest('[data-request-action]');
            if (!button) return;
            const username = button.dataset.user;
            if (button.dataset.requestAction === 'approve') approveRequest(username);
            else rejectRequest(username);
        });

        refs.leaveBtn.addEventListener('click', leaveGroup);
        refs.deleteBtn.addEventListener('click', deleteGroup);

        refs.pickerOverlay.addEventListener('click', event => {
            if (event.target === refs.pickerOverlay) {
                closePeoplePicker();
                return;
            }
            const action = event.target.closest('[data-action]');
            if (!action) return;
            if (action.dataset.action === 'close') closePeoplePicker();
            else if (action.dataset.action === 'ok') confirmPickerSelection();
        });
        refs.peopleSearch.addEventListener('input', event => {
            if (!state.picker) return;
            state.picker.query = event.target.value;
            renderPicker();
        });
        refs.peopleList.addEventListener('change', event => {
            const input = event.target.closest('input[type="checkbox"]');
            if (!input || !state.picker) return;
            if (input.checked) state.picker.selected.add(input.value);
            else state.picker.selected.delete(input.value);
            refs.peopleOk.disabled = !state.picker.selected.size || state.busy;
            updatePickerHint(state.picker);
        });
        refs.copyInviteBtn.addEventListener('click', copyInviteLink);

        refs.sheetOverlay.addEventListener('click', event => {
            if (event.target === refs.sheetOverlay) closeSheet();
        });
        refs.sheet.addEventListener('click', event => {
            const confirmButton = event.target.closest('[data-confirm]');
            if (confirmButton) {
                settleConfirm(confirmButton.dataset.confirm === 'yes');
                return;
            }
            const action = event.target.closest('[data-sheet-action]');
            if (action) handleSheetAction(action.dataset.sheetAction, action.dataset.user || '');
        });

        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            if (!refs.pickerOverlay.hidden) closePeoplePicker();
            else if (!refs.sheetOverlay.hidden) closeSheet();
        });
    }

    /* ============ arranque ============ */

    async function init() {
        bindEvents();
        if (!groupId) {
            showError(new Error('Falta el identificador del grupo.'));
            return;
        }

        readPreview();
        if (state.group) {
            revealGroup();
        } else {
            showLoading();
        }

        try {
            const [me, group] = await Promise.all([fetchMe(), fetchGroup()]);
            if (me) state.me = me;
            state.group = group;
            await Promise.all([loadContacts(), loadPreferences()]);
            await ensureProfiles([...groupProfileNames(group), ...state.contacts.map(contact => contact.username)]);
            revealGroup();
        } catch (error) {
            console.error('[detalles] No se pudo cargar el grupo:', error);
            if (state.group) {
                revealGroup();
                showToast('No se pudo actualizar la información del grupo.', 'alert');
            } else {
                showError(error);
            }
        }
    }

    init();
})();
