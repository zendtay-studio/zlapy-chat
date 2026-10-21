(() => {
    'use strict';

    const params = new URLSearchParams(location.search);
    const embedded = params.get('embedded') === '1' && window.parent !== window;
    const requestedSection = params.get('section') || '';
    let groupId = params.get('id') || '';

    const POLICY_ROWS = [
        {
            key: 'visibility',
            title: 'Privacidad',
            hint: 'Quién puede encontrar el grupo',
            options: [['private', 'Privado'], ['public', 'Público']]
        },
        {
            key: 'joinPolicy',
            title: 'Cómo unirse',
            hint: 'Cómo entran las personas nuevas',
            options: [['request', 'Solicitar'], ['open', 'Abierta'], ['closed', 'Cerrada']]
        },
        {
            key: 'writePolicy',
            title: 'Quién escribe',
            hint: 'Envío de mensajes en el grupo',
            options: [['all', 'Todos'], ['admins', 'Solo admins']]
        },
        {
            key: 'addPolicy',
            title: 'Añadir miembros',
            hint: 'Quién puede invitar a otras personas',
            options: [['all', 'Todos'], ['admins', 'Solo admins']]
        },
        {
            key: 'editPolicy',
            title: 'Editar grupo',
            hint: 'Nombre, foto, descripción y permisos',
            options: [['all', 'Todos'], ['admins', 'Solo admins']]
        },
        {
            key: 'mentionAllPolicy',
            title: 'Mencionar a @todos',
            hint: 'Uso de la mención global',
            options: [['all', 'Todos'], ['admins', 'Solo admins']]
        }
    ];

    const CONTENT_ROWS = [
        ['image', 'Fotos'],
        ['video', 'Videos'],
        ['audio', 'Audio y notas de voz'],
        ['file', 'Archivos'],
        ['sticker', 'Stickers'],
        ['contact', 'Contactos'],
        ['poll', 'Encuestas']
    ];

    const PALETTE = ['#d3dbe1', '#a8c7fa', '#f7c6a3', '#b9e6c9', '#e7c6f7', '#f5d48f', '#a9dfe8', '#f3b8c3'];

    const state = {
        me: null,
        group: null,
        profiles: Object.create(null),
        contacts: [],
        picker: null,
        profileUser: '',
        draft: null,
        query: '',
        dirty: false,
        saving: false,
        busy: false,
        avatarBusy: false,
        confirmResolve: null
    };

    const $ = id => document.getElementById(id);
    const refs = {
        closeBtn: $('closeBtn'),
        pageTitle: $('pageTitle'),
        appbarSub: $('appbarSub'),
        saveBtn: $('saveBtn'),
        content: $('content'),
        loadingCard: $('loadingCard'),
        errorCard: $('errorCard'),
        errorTitle: $('errorTitle'),
        errorText: $('errorText'),
        errorBackBtn: $('errorBackBtn'),
        pageGrid: $('pageGrid'),
        avatarBtn: $('avatarBtn'),
        avatarFallback: $('avatarFallback'),
        avatarImg: $('avatarImg'),
        avatarCamera: $('avatarCamera'),
        avatarInput: $('avatarInput'),
        removeAvatarBtn: $('removeAvatarBtn'),
        visibilityEyebrow: $('visibilityEyebrow'),
        groupNameLabel: $('groupNameLabel'),
        groupMeta: $('groupMeta'),
        nameInput: $('groupNameInput'),
        nameCount: $('nameCount'),
        descInput: $('groupDescInput'),
        descCount: $('descCount'),
        roleNote: $('roleNote'),
        roleNoteText: $('roleNoteText'),
        addPeopleBtn: $('addPeopleBtn'),
        shareBtn: $('shareBtn'),
        dangerCard: $('dangerCard'),
        dangerHint: $('dangerHint'),
        leaveBtn: $('leaveBtn'),
        deleteBtn: $('deleteBtn'),
        membersCard: $('membersCard'),
        membersSub: $('membersSub'),
        memberCountBadge: $('memberCountBadge'),
        memberSearch: $('memberSearch'),
        memberSearchClear: $('memberSearchClear'),
        requestsBlock: $('requestsBlock'),
        requestCount: $('requestCount'),
        requestList: $('requestList'),
        memberList: $('memberList'),
        memberEmpty: $('memberEmpty'),
        settingsSection: $('settingsSection'),
        settingsSubtitle: $('settingsSubtitle'),
        settingsSummary: $('settingsSummary'),
        settingsNote: $('settingsNote'),
        settingsFoot: $('settingsFoot'),
        policyRows: $('policyRows'),
        contentPolicyList: $('contentPolicyList'),
        contentSubtitle: $('contentSubtitle'),
        settingsStatus: $('settingsStatus'),
        discardBtn: $('discardBtn'),
        memberMenu: $('memberMenu'),
        peopleOverlay: $('peopleOverlay'),
        peopleTitle: $('peopleTitle'),
        peopleHint: $('peopleHint'),
        peopleSearch: $('peopleSearch'),
        peopleList: $('peopleList'),
        profileOverlay: $('profileOverlay'),
        profileTitle: $('profileTitle'),
        profileAvatar: $('profileAvatar'),
        profileName: $('profileName'),
        profileUsername: $('profileUsername'),
        profilePresence: $('profilePresence'),
        confirmOverlay: $('confirmOverlay'),
        confirmTitle: $('confirmTitle'),
        confirmText: $('confirmText'),
        toast: $('toast'),
        toastText: $('toastText')
    };

    let toastTimer = 0;

    const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[character]));

    const normalize = value => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();

    const isEncryptedName = value => {
        const text = String(value || '');
        return text.startsWith('PCE3:') || text.startsWith('PCE1:');
    };

    const displayName = username => {
        const profile = state.profiles[username];
        const name = profile && profile.name;
        return name && !isEncryptedName(name) ? name : username;
    };

    const initials = value => String(value || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(part => part[0])
        .join('')
        .toUpperCase() || '?';

    const colorFor = value => {
        const text = String(value || '');
        let hash = 0;
        for (let index = 0; index < text.length; index++)
            hash = ((hash * 31) + text.charCodeAt(index)) >>> 0;
        return PALETTE[hash % PALETTE.length];
    };

    const avatarUrl = (username, profile) => {
        if (profile && profile.avatar) return profile.avatar;
        const key = (profile && profile.id) || username;
        return key ? '/avatar/' + encodeURIComponent(key) + '.svg?v=3' : '';
    };

    const avatarHtml = username => {
        const profile = state.profiles[username] || {};
        const src = avatarUrl(username, profile);
        return src
            ? `<img src="${escapeHtml(src)}" alt="" loading="lazy">`
            : `<span class="mini" style="background:${colorFor(username)}">${escapeHtml(initials(displayName(username)))}</span>`;
    };

    const isAdmin = () => Boolean(state.group && state.me && (state.group.admins || []).includes(state.me.username));
    const canEdit = () => Boolean(state.group && (isAdmin() || state.group.editPolicy === 'all'));
    const canAdd = () => Boolean(state.group && (isAdmin() || state.group.addPolicy === 'all'));
    const isSelf = username => Boolean(state.me && username === state.me.username);
    const memberWord = count => count === 1 ? 'integrante' : 'integrantes';

    // Mientras haya cambios sin guardar la persona conserva los controles:
    // si ella misma acaba de quitarse el permiso, debe poder confirmar el
    // guardado antes de perder la edición.
    const isEditable = () => canEdit() || state.dirty;

    function showToast(message, icon = 'info') {
        refs.toastText.textContent = message;
        refs.toast.classList.add('show');
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => refs.toast.classList.remove('show'), 3600);
    }

    function post(type, payload = {}) {
        if (!embedded) return false;
        try {
            window.parent.postMessage({ type, ...payload }, location.origin);
            return true;
        } catch {
            return false;
        }
    }

    function postUpdate(group) {
        if (group && group.id) post('zlapy:group-updated', { group });
    }

    function closeMemberMenu() {
        if (window.ZlapyPopMenu) ZlapyPopMenu.close();
        refs.memberMenu.hidden = true;
        refs.memberMenu.innerHTML = '';
        refs.memberMenu.dataset.username = '';
    }

    function closeConfirm(value) {
        const resolve = state.confirmResolve;
        state.confirmResolve = null;
        refs.confirmOverlay.hidden = true;
        if (resolve) resolve(Boolean(value));
    }

    function confirmAction({ title, text, confirmLabel = 'Confirmar', danger = true }) {
        if (state.confirmResolve) closeConfirm(false);
        refs.confirmTitle.textContent = title;
        refs.confirmText.textContent = text;
        const ok = refs.confirmOverlay.querySelector('[data-action="ok"]');
        ok.textContent = confirmLabel;
        ok.classList.toggle('peligro', danger);
        ok.classList.toggle('ok', !danger);
        refs.confirmOverlay.hidden = false;
        const cancel = refs.confirmOverlay.querySelector('[data-action="cancel"]');
        if (cancel) cancel.focus({ preventScroll: true });
        return new Promise(resolve => { state.confirmResolve = resolve; });
    }

    function draftFromGroup(group) {
        return {
            name: group.name || '',
            description: group.description || '',
            visibility: group.visibility === 'public' ? 'public' : 'private',
            joinPolicy: ['open', 'request', 'closed'].includes(group.joinPolicy) ? group.joinPolicy : 'request',
            writePolicy: group.writePolicy === 'admins' ? 'admins' : 'all',
            addPolicy: group.addPolicy === 'all' ? 'all' : 'admins',
            editPolicy: group.editPolicy === 'all' ? 'all' : 'admins',
            mentionAllPolicy: group.mentionAllPolicy === 'all' ? 'all' : 'admins',
            contentPolicy: Object.fromEntries(CONTENT_ROWS.map(([kind]) => [
                kind,
                group.contentPolicy && group.contentPolicy[kind] ? group.contentPolicy[kind] : 'all'
            ]))
        };
    }

    function resetDraft(group) {
        state.draft = draftFromGroup(group);
        state.dirty = false;
    }

    function groupProfileNames(group) {
        const names = [...(group.members || [])];
        for (const request of group.joinRequests || []) {
            if (request && request.username) names.push(request.username);
        }
        return [...new Set(names.filter(Boolean))];
    }

    async function ensureProfiles(usernames) {
        const unique = [...new Set((usernames || []).filter(Boolean))];
        await Promise.allSettled(unique.map(async username => {
            if (state.profiles[username]) return;
            try {
                const response = await fetch('/profile?username=' + encodeURIComponent(username), { cache: 'no-store' });
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const profile = await response.json();
                state.profiles[username] = { ...profile, username };
            } catch (error) {
                state.profiles[username] = { username };
            }
        }));
    }

    async function fetchGroup(id) {
        const response = await fetch('/groups/' + encodeURIComponent(id) + '?light=1', { cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            if (response.status === 404) throw new Error('No tienes acceso a este grupo o ya no existe.');
            if (response.status === 403) throw new Error('No tienes permiso para ver este grupo.');
            throw new Error(data.error || 'No se pudo cargar el grupo.');
        }
        if (!data || !data.id) throw new Error('El grupo no está disponible.');
        return data;
    }

    function showError(title, text) {
        refs.loadingCard.hidden = true;
        refs.pageGrid.hidden = true;
        refs.errorCard.hidden = false;
        refs.errorTitle.textContent = title;
        refs.errorText.textContent = text;
        refs.pageTitle.textContent = 'Detalles del grupo';
        refs.appbarSub.textContent = 'No se pudo cargar';
        refs.saveBtn.disabled = true;
    }

    async function applyGroup(group, { reset = false } = {}) {
        state.group = group;
        if (reset || !state.dirty) resetDraft(group);
        await ensureProfiles(groupProfileNames(group));
        renderAll();
        postUpdate(group);
    }

    function renderHeader() {
        const group = state.group;
        if (!group) return;
        refs.pageTitle.textContent = group.name || 'Detalles del grupo';
        refs.appbarSub.textContent = `${group.members.length} ${memberWord(group.members.length)} · ${group.visibility === 'public' ? 'Público' : 'Privado'}`;
        document.title = `${group.name || 'Grupo'} — Zlapy`;
    }

    /* Avatar del grupo: la foto si la hay; si no, el que genera el servidor a
       partir del identificador interno del grupo (con un diseño propio). */
    function renderGroupAvatar() {
        const group = state.group;
        if (!group) return;
        if (group.avatar) {
            refs.avatarImg.src = group.avatar;
            refs.avatarImg.hidden = false;
            refs.avatarFallback.hidden = true;
            return;
        }
        refs.avatarImg.src = '/avatar/' + encodeURIComponent(group.id) + '.svg?v=1';
        refs.avatarImg.hidden = false;
        refs.avatarFallback.hidden = true;
    }

    function renderGroupCard() {
        const group = state.group;
        if (!group || !state.draft) return;
        renderGroupAvatar();
        const editable = isEditable();
        refs.avatarBtn.disabled = !editable || state.avatarBusy || state.busy;
        refs.avatarBtn.title = editable ? 'Cambiar foto del grupo' : 'Foto del grupo';
        refs.avatarCamera.hidden = !editable;
        refs.removeAvatarBtn.hidden = !group.avatar || !editable || state.avatarBusy || state.busy;
        refs.visibilityEyebrow.textContent = group.visibility === 'public' ? 'Grupo público' : 'Grupo privado';
        refs.groupNameLabel.textContent = group.name || 'Grupo';
        refs.groupMeta.textContent = `${group.members.length} ${memberWord(group.members.length)}`;
        refs.nameInput.disabled = !editable;
        refs.descInput.disabled = !editable;
        if (document.activeElement !== refs.nameInput) refs.nameInput.value = state.draft.name;
        if (document.activeElement !== refs.descInput) refs.descInput.value = state.draft.description;
        refs.nameCount.textContent = `${state.draft.name.length}/40`;
        refs.descCount.textContent = `${state.draft.description.length}/500`;
        refs.roleNote.classList.toggle('is-admin', isAdmin());
        refs.roleNoteText.textContent = isAdmin()
            ? 'Eres administrador. Puedes editar el grupo, cambiar permisos y moderar integrantes.'
            : editable
                ? 'Puedes editar la información y los permisos de este grupo.'
                : 'Solo los administradores pueden editar la información y los permisos.';
        refs.addPeopleBtn.hidden = !canAdd();
        refs.leaveBtn.disabled = state.busy;
        refs.deleteBtn.disabled = state.busy;
        refs.deleteBtn.hidden = !isAdmin();
        refs.dangerHint.textContent = isAdmin()
            ? 'Puedes salir del grupo o eliminarlo para todos los integrantes.'
            : 'Puedes volver a entrar si el grupo sigue disponible.';
    }

    function memberRow(username) {
        const group = state.group;
        const admin = (group.admins || []).includes(username);
        const name = displayName(username);
        const menu = isSelf(username)
            ? ''
            : `<button class="icon-btn member-menu-btn" type="button" data-member-menu="${escapeHtml(username)}" aria-label="Opciones de ${escapeHtml(name)}" title="Opciones">
                    <svg class="icon" aria-hidden="true"><use href="#i-more"></use></svg>
                </button>`;
        return `<div class="member-row" data-member="${escapeHtml(username)}">
            <span class="member-avatar">${avatarHtml(username)}</span>
            <div class="member-copy">
                <div class="member-name">
                    <span class="name-text">${escapeHtml(name)}</span>
                    ${isSelf(username) ? '<span class="you-pill">Tú</span>' : ''}
                    ${admin ? '<span class="role-pill">Admin</span>' : ''}
                </div>
                <div class="member-sub">@${escapeHtml(username)}${admin ? ' · Administrador' : ''}</div>
            </div>
            ${menu}
        </div>`;
    }

    function requestRow(username) {
        const name = displayName(username);
        return `<div class="member-row" data-request="${escapeHtml(username)}">
            <span class="member-avatar">${avatarHtml(username)}</span>
            <div class="member-copy">
                <div class="member-name"><span class="name-text">${escapeHtml(name)}</span></div>
                <div class="member-sub">@${escapeHtml(username)} · Solicitó unirse</div>
            </div>
            <div class="request-actions">
                <button class="mini-btn accept" type="button" data-request-action="approve" data-user="${escapeHtml(username)}">Aceptar</button>
                <button class="mini-btn reject" type="button" data-request-action="reject" data-user="${escapeHtml(username)}">Rechazar</button>
            </div>
        </div>`;
    }

    function renderMembers() {
        const group = state.group;
        if (!group) return;
        const query = normalize(state.query);
        const members = [...group.members]
            .sort((left, right) => {
                const leftAdmin = (group.admins || []).includes(left) ? 0 : 1;
                const rightAdmin = (group.admins || []).includes(right) ? 0 : 1;
                if (leftAdmin !== rightAdmin) return leftAdmin - rightAdmin;
                return displayName(left).localeCompare(displayName(right), 'es', { sensitivity: 'base' });
            })
            .filter(username => !query || normalize(`${displayName(username)} ${username}`).includes(query));
        refs.memberList.innerHTML = members.map(memberRow).join('');
        refs.memberEmpty.hidden = Boolean(members.length);
        refs.memberCountBadge.textContent = String(group.members.length);
        refs.membersSub.textContent = `${group.members.length} ${memberWord(group.members.length)} en el grupo`;
        refs.memberSearchClear.hidden = !state.query;
    }

    function renderRequests() {
        const group = state.group;
        if (!group) return;
        const requests = isAdmin() && Array.isArray(group.joinRequests) ? group.joinRequests : [];
        refs.requestsBlock.hidden = !requests.length;
        refs.requestCount.textContent = String(requests.length);
        refs.requestList.innerHTML = requests
            .filter(request => request && request.username)
            .map(request => requestRow(request.username))
            .join('');
    }

    function segHtml(attribute, key, options, current) {
        return `<div class="seg" data-${attribute}="${key}" role="group" aria-label="${escapeHtml(key)}">
            ${options.map(([value, label]) => `<button type="button" data-value="${value}" class="${value === current ? 'on' : ''}" aria-pressed="${value === current}">${label}</button>`).join('')}
        </div>`;
    }

    function policyLabel(key, value) {
        const row = POLICY_ROWS.find(entry => entry.key === key);
        const found = row && row.options.find(option => option[0] === value);
        return found ? found[1] : String(value || '—');
    }

    function contentLabel(value) {
        if (value === 'all') return 'Todos';
        if (value === 'admins') return 'Solo admins';
        if (value === 'off') return 'Desactivado';
        return String(value || '—');
    }

    function buildPolicyControls() {
        if (!isEditable()) {
            // Quien solo mira el grupo no ve una formulario lleno de botones
            // apagados: se le muestra el valor actual de cada permiso.
            refs.policyRows.innerHTML = POLICY_ROWS.map(row => `<div class="readonly-row">
                <div class="setting-copy"><b>${row.title}</b><span>${row.hint}</span></div>
                <span class="policy-value">${escapeHtml(policyLabel(row.key, state.draft[row.key]))}</span>
            </div>`).join('');
            refs.contentPolicyList.innerHTML = CONTENT_ROWS.map(([kind, label]) => `<div class="readonly-row">
                <span class="policy-name">${escapeHtml(label)}</span>
                <span class="policy-value">${escapeHtml(contentLabel(state.draft.contentPolicy[kind]))}</span>
            </div>`).join('');
            return;
        }
        if (!refs.policyRows.childElementCount) {
            refs.policyRows.innerHTML = POLICY_ROWS.map(row => `<div class="setting-row">
                <div class="setting-copy"><b>${row.title}</b><span>${row.hint}</span></div>
                ${segHtml('policy', row.key, row.options, state.draft[row.key])}
            </div>`).join('');
            refs.contentPolicyList.innerHTML = CONTENT_ROWS.map(([kind, label]) => `<div class="policy-row">
                <span>${label}</span>
                ${segHtml('content', kind, [['all', 'Todos'], ['admins', 'Solo admins'], ['off', 'Desactivado']], state.draft.contentPolicy[kind])}
            </div>`).join('');
        }
        syncPolicyControls();
    }

    function syncPolicyControls() {
        const editable = isEditable();
        document.querySelectorAll('.seg[data-policy]').forEach(segment => {
            const value = state.draft[segment.dataset.policy];
            segment.querySelectorAll('button').forEach(button => {
                const on = button.dataset.value === value;
                button.classList.toggle('on', on);
                button.setAttribute('aria-pressed', String(on));
                button.disabled = !editable;
            });
        });
        document.querySelectorAll('.seg[data-content]').forEach(segment => {
            const value = state.draft.contentPolicy[segment.dataset.content];
            segment.querySelectorAll('button').forEach(button => {
                const on = button.dataset.value === value;
                button.classList.toggle('on', on);
                button.setAttribute('aria-pressed', String(on));
                button.disabled = !editable;
            });
        });
    }

    // Resumen corto del bloque desplegable: qué se ve sin abrirlo.
    function settingsSummaryText() {
        if (!state.draft) return '';
        const visibility = policyLabel('visibility', state.draft.visibility);
        const join = policyLabel('joinPolicy', state.draft.joinPolicy);
        const write = policyLabel('writePolicy', state.draft.writePolicy);
        return [visibility, join, write].filter(Boolean).join(' · ');
    }

    function renderSettings() {
        if (!state.group || !state.draft) return;
        const editable = isEditable();
        buildPolicyControls();
        refs.settingsSubtitle.textContent = editable
            ? 'Controla quién puede entrar, escribir y compartir contenido.'
            : 'Así está configurado el grupo en este momento.';
        if (refs.settingsSummary) refs.settingsSummary.textContent = settingsSummaryText();
        refs.settingsNote.hidden = editable;
        refs.settingsNote.textContent = editable
            ? ''
            : 'Puedes consultar esta configuración, pero solo los administradores pueden cambiarla.';
        refs.contentSubtitle.textContent = editable
            ? 'Elige quién puede enviar cada tipo de contenido.'
            : 'Qué puede enviarse en el grupo ahora mismo.';
        refs.settingsFoot.hidden = !editable;
    }

    function renderAll() {
        renderHeader();
        renderGroupCard();
        renderMembers();
        renderRequests();
        renderSettings();
        updateDirty();
    }

    function updateDirty() {
        if (!state.group || !state.draft) return;
        const base = draftFromGroup(state.group);
        const dirty = Object.keys(base).some(key => {
            if (key === 'contentPolicy')
                return CONTENT_ROWS.some(([kind]) => state.draft.contentPolicy[kind] !== base.contentPolicy[kind]);
            return state.draft[key] !== base[key];
        });
        state.dirty = dirty;
        const editable = isEditable();
        // Quien no puede editar el grupo no ve el botón Guardar: la página
        // es de consulta, no de edición.
        refs.saveBtn.hidden = !canEdit();
        refs.saveBtn.disabled = !editable || !dirty || state.saving || state.busy;
        refs.saveBtn.textContent = state.saving ? 'Guardando…' : 'Guardar';
        refs.settingsStatus.textContent = state.saving
            ? 'Guardando cambios…'
            : dirty
                ? 'Cambios sin guardar'
                : 'Todo guardado';
        refs.discardBtn.hidden = !dirty || state.saving;
    }

    async function refreshGroup() {
        return fetchGroup(state.group.id);
    }

    async function saveSettings() {
        if (!canEdit() || !state.dirty || state.saving || state.busy) return;
        const name = state.draft.name.trim();
        if (!name) {
            showToast('El nombre del grupo no puede estar vacío.', 'alert');
            refs.nameInput.focus();
            return;
        }
        if (name.length > 40) {
            showToast('El nombre admite hasta 40 caracteres.', 'alert');
            return;
        }
        state.saving = true;
        updateDirty();
        try {
            const response = await fetch('/groups/' + encodeURIComponent(state.group.id), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    rename: name,
                    description: state.draft.description.trim(),
                    visibility: state.draft.visibility,
                    joinPolicy: state.draft.joinPolicy,
                    writePolicy: state.draft.writePolicy,
                    addPolicy: state.draft.addPolicy,
                    editPolicy: state.draft.editPolicy,
                    mentionAllPolicy: state.draft.mentionAllPolicy,
                    contentPolicy: { ...state.draft.contentPolicy }
                })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || 'No se pudieron guardar los cambios.');
            let fresh;
            try {
                fresh = await refreshGroup();
            } catch {
                fresh = {
                    ...state.group,
                    ...result,
                    joinRequests: Array.isArray(result.joinRequests) && result.joinRequests.length
                        ? result.joinRequests
                        : state.group.joinRequests,
                    inviteCode: result.inviteCode || state.group.inviteCode
                };
            }
            state.group = fresh;
            resetDraft(fresh);
            await ensureProfiles(groupProfileNames(fresh));
            renderAll();
            postUpdate(fresh);
            showToast('Cambios guardados.', 'check');
        } catch (error) {
            console.error('[detalles] No se pudieron guardar los ajustes:', error);
            showToast(error.message || 'No se pudieron guardar los cambios.', 'alert');
        } finally {
            state.saving = false;
            updateDirty();
        }
    }

    async function groupAction(payload, message) {
        if (state.busy || !state.group) return;
        state.busy = true;
        updateDirty();
        renderGroupCard();
        try {
            const response = await fetch('/groups/' + encodeURIComponent(state.group.id), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || 'No se pudo actualizar el grupo.');
            const fresh = await refreshGroup();
            await applyGroup(fresh, { reset: !state.dirty });
            showToast(message, 'check');
        } catch (error) {
            console.error('[detalles] No se pudo actualizar el grupo:', error);
            showToast(error.message || 'No se pudo actualizar el grupo.', 'alert');
        } finally {
            state.busy = false;
            updateDirty();
            renderGroupCard();
        }
    }

    function makeAdmin(username) {
        return groupAction({ approveAdmin: username }, 'Ahora es administrador.');
    }

    function removeAdmin(username) {
        return groupAction({ removeAdmin: username }, 'Ya no es administrador.');
    }

    function approveRequest(username) {
        return groupAction({ approveJoin: username }, 'Solicitud aceptada.');
    }

    function rejectRequest(username) {
        return groupAction({ rejectJoin: username }, 'Solicitud rechazada.');
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

    /* Menu del integrante: el mismo pop-menu que el resto de la app (con
       icono en cada opcion y cierre al tocar fuera). */
    function openMemberMenu(username, anchor) {
        closeMemberMenu();
        if (!state.group || !username || isSelf(username)) return;
        const admin = state.group.admins.includes(username);
        const items = [
            { id: 'profile', label: 'Ver perfil', icon: 'user' }
        ];
        if (isAdmin()) {
            items.push({ id: admin ? 'remove-admin' : 'make-admin', label: admin ? 'Quitar admin' : 'Hacer admin', icon: 'shield' });
            items.push({ id: 'remove', label: 'Quitar del grupo', icon: 'trash', danger: true });
        }
        if (!window.ZlapyPopMenu) return;
        ZlapyPopMenu.open({
            anchor,
            align: 'right',
            items,
            onSelect: action => {
                if (action === 'profile') handleProfile(username);
                else if (action === 'make-admin') makeAdmin(username);
                else if (action === 'remove-admin') removeAdmin(username);
                else if (action === 'remove') removeMember(username);
            }
        });
    }

    function presenceText(contact) {
        if (!contact) return 'Sin conexión';
        if (contact.online) return 'en línea';
        if (!contact.lastSeen) return 'Sin conexión';
        const date = new Date(contact.lastSeen), now = new Date();
        const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const startThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        const daysAgo = Math.round((startToday - startThatDay) / 86400000);
        if (daysAgo === 0) return `Últ. vez hoy a las ${time}`;
        if (daysAgo === 1) return `Últ. vez ayer a las ${time}`;
        return `Últ. vez ${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} a las ${time}`;
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

    function contactByUsername(username) {
        return state.contacts.find(contact => contact.username === username) || null;
    }

    function closeProfile() {
        refs.profileOverlay.hidden = true;
        state.profileUser = '';
    }

    function openProfile(username) {
        if (!username) return;
        const profile = state.profiles[username] || {};
        const admin = (state.group.admins || []).includes(username);
        state.profileUser = username;
        refs.profileTitle.textContent = admin ? 'Administrador del grupo' : 'Integrante del grupo';
        refs.profileAvatar.innerHTML = avatarHtml(username);
        refs.profileName.textContent = displayName(username);
        refs.profileUsername.textContent = '@' + username;
        refs.profilePresence.textContent = presenceText(profile);
        refs.profileOverlay.hidden = false;
    }

    function renderPicker() {
        const picker = state.picker;
        if (!picker) return;
        const members = new Set((state.group && state.group.members) || []);
        const query = normalize(picker.query);
        const candidates = state.contacts.filter(contact => {
            if (picker.mode === 'add' && members.has(contact.username)) return false;
            const name = displayName(contact.username);
            return !query || normalize(`${name} ${contact.username}`).includes(query);
        });
        refs.peopleList.innerHTML = candidates.length
            ? candidates.map(contact => {
                const username = contact.username;
                const checked = picker.selected.has(username);
                return `<label class="pickerPerson"><input type="checkbox" value="${escapeHtml(username)}" ${checked ? 'checked' : ''}><div class="av">${avatarHtml(username)}</div><div class="meta"><b>${escapeHtml(displayName(username))}</b></div></label>`;
            }).join('')
            : `<div class="help">${escapeHtml(picker.emptyText)}</div>`;
        const ok = refs.peopleOverlay.querySelector('[data-action="ok"]');
        if (ok) ok.disabled = !picker.selected.size || state.busy;
    }

    function closePeoplePicker() {
        refs.peopleOverlay.hidden = true;
        state.picker = null;
        refs.peopleSearch.value = '';
    }

    function openPeoplePicker(mode) {
        if (!state.group) return;
        const adding = mode === 'add';
        const members = new Set(state.group.members || []);
        const alreadyIn = state.contacts.filter(contact => members.has(contact.username)).length;
        const emptyText = !state.contacts.length
            ? 'Todavía no tienes contactos'
            : adding && alreadyIn >= state.contacts.length
                ? 'Tus contactos ya están en el grupo'
                : 'No hay contactos para mostrar';
        state.picker = { mode, selected: new Set(), query: '', emptyText };
        refs.peopleTitle.textContent = adding ? 'Añadir participantes' : 'Compartir invitación';
        refs.peopleHint.textContent = adding
            ? 'Elige a quién quieres invitar al grupo.'
            : 'Elige a quién quieres enviar la invitación del grupo.';
        const ok = refs.peopleOverlay.querySelector('[data-action="ok"]');
        if (ok) ok.textContent = adding ? 'Añadir' : 'Compartir';
        refs.peopleOverlay.hidden = false;
        renderPicker();
        refs.peopleSearch.focus({ preventScroll: true });
    }

    async function addSelectedMembers(selected) {
        let added = 0;
        for (const username of selected) {
            const response = await fetch('/groups/' + encodeURIComponent(state.group.id), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ addMember: username })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) {
                showToast(result.error || 'No se pudo añadir al integrante.', 'alert');
                break;
            }
            added++;
        }
        if (!added) return;
        try {
            const fresh = await refreshGroup();
            await applyGroup(fresh, { reset: !state.dirty });
        } catch { }
        showToast(added === 1 ? 'Integrante añadido.' : `Integrantes añadidos: ${added}.`, 'check');
    }

    async function shareInvite(selected) {
        let shared = 0;
        for (const username of selected) {
            try {
                const response = await fetch('/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        to: username,
                        kind: 'group-invite',
                        groupId: state.group.id,
                        inviteCode: state.group.inviteCode || ''
                    })
                });
                if (response.ok) shared++;
            } catch (error) {
                console.error('[detalles] No se pudo compartir la invitación:', error);
            }
        }
        showToast(shared
            ? `Invitación compartida en ${shared} chat${shared === 1 ? '' : 's'}.`
            : 'No se pudo compartir la invitación.', shared ? 'check' : 'alert');
    }

    async function confirmPickerSelection() {
        const picker = state.picker;
        if (!picker || !picker.selected.size) return;
        const selected = [...picker.selected];
        state.busy = true;
        updateDirty();
        renderPicker();
        try {
            if (picker.mode === 'add') await addSelectedMembers(selected);
            else await shareInvite(selected);
        } catch (error) {
            console.error('[detalles] No se pudo completar la acción:', error);
            showToast(error.message || 'No se pudo completar la acción.', 'alert');
        } finally {
            state.busy = false;
            updateDirty();
            closePeoplePicker();
        }
    }

    function handleProfile(username) {
        openProfile(username);
    }

    async function handleAvatar(file) {
        if (!file || !canEdit() || state.avatarBusy) return;
        if (!file.type.startsWith('image/')) {
            showToast('Selecciona un archivo de imagen.', 'alert');
            return;
        }
        state.avatarBusy = true;
        renderGroupCard();
        try {
            // La foto del grupo se recorta con el mismo editor que la de perfil.
            const editor = window.ZlapyAvatarEditor;
            let avatar = '';
            if (editor && typeof editor.open === 'function') {
                const result = await editor.open({ file });
                if (!result || !result.dataUrl) { refs.avatarInput.value = ''; return; }
                avatar = result.dataUrl;
            } else {
                avatar = await imageToDataUrl(file);
            }
            const response = await fetch('/groups/' + encodeURIComponent(state.group.id), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ avatar })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || 'No se pudo cambiar la foto.');
            let fresh;
            try {
                fresh = await refreshGroup();
            } catch {
                fresh = { ...state.group, ...result };
            }
            await applyGroup(fresh, { reset: !state.dirty });
            showToast('Foto del grupo actualizada.', 'check');
        } catch (error) {
            console.error('[detalles] No se pudo cambiar la foto:', error);
            showToast(error.message || 'No se pudo cambiar la foto.', 'alert');
        } finally {
            state.avatarBusy = false;
            refs.avatarInput.value = '';
            renderGroupCard();
        }
    }

    async function removeGroupAvatar() {
        if (!canEdit() || !state.group || !state.group.avatar || state.avatarBusy) return;
        const ok = await confirmAction({
            title: 'Quitar foto del grupo',
            text: 'La foto actual se eliminará y el grupo volverá a mostrar sus iniciales.',
            confirmLabel: 'Quitar foto'
        });
        if (!ok) return;
        state.avatarBusy = true;
        renderGroupCard();
        try {
            const response = await fetch('/groups/' + encodeURIComponent(state.group.id), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ avatar: '' })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || 'No se pudo quitar la foto.');
            let fresh;
            try {
                fresh = await refreshGroup();
            } catch {
                fresh = { ...state.group, avatar: '' };
            }
            await applyGroup(fresh, { reset: !state.dirty });
            showToast('Foto del grupo eliminada.', 'check');
        } catch (error) {
            console.error('[detalles] No se pudo quitar la foto:', error);
            showToast(error.message || 'No se pudo quitar la foto.', 'alert');
        } finally {
            state.avatarBusy = false;
            renderGroupCard();
        }
    }

    async function imageToDataUrl(file) {
        if (typeof createImageBitmap === 'function') {
            const bitmap = await createImageBitmap(file);
            try {
                const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(bitmap.width * scale));
                canvas.height = Math.max(1, Math.round(bitmap.height * scale));
                const context = canvas.getContext('2d');
                if (!context) throw new Error('No se pudo preparar la foto.');
                context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                const webp = canvas.toDataURL('image/webp', 0.82);
                return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.86);
            } finally {
                bitmap.close();
            }
        }
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
            reader.readAsDataURL(file);
        });
    }

    function addPeople() {
        if (!canAdd() || !state.group) return;
        openPeoplePicker('add');
    }

    async function shareGroup() {
        if (!state.group) return;
        openPeoplePicker('share');
    }

    function finishGroupRemoval(type) {
        try { sessionStorage.removeItem('zlapy:open-group-details'); } catch { }
        if (embedded) {
            post(type, { groupId: state.group.id });
            // Si la app no responde (por ejemplo, una pestaña antigua), el
            // usuario vuelve atrás por su cuenta en lugar de quedarse atascado.
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
        updateDirty();
        try {
            const response = await fetch('/groups/' + encodeURIComponent(state.group.id), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leave: true })
            });
            if (!response.ok) throw new Error('No se pudo salir del grupo.');
            finishGroupRemoval('zlapy:group-left');
        } catch (error) {
            showToast(error.message || 'No se pudo salir del grupo.', 'alert');
        } finally {
            state.busy = false;
            updateDirty();
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
        updateDirty();
        try {
            const response = await fetch('/groups/' + encodeURIComponent(state.group.id), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deleteGroup: true })
            });
            if (!response.ok) throw new Error('No se pudo eliminar el grupo.');
            finishGroupRemoval('zlapy:group-deleted');
        } catch (error) {
            showToast(error.message || 'No se pudo eliminar el grupo.', 'alert');
        } finally {
            state.busy = false;
            updateDirty();
        }
    }

    function goBack() {
        if (!refs.confirmOverlay.hidden) {
            closeConfirm(false);
            return;
        }
        if (!refs.peopleOverlay.hidden) {
            closePeoplePicker();
            return;
        }
        if (!refs.profileOverlay.hidden) {
            closeProfile();
            return;
        }
        if (!refs.memberMenu.hidden) {
            closeMemberMenu();
            return;
        }
        if (post('zlapy:group-details-close')) return;
        if (history.length > 1) history.back();
        else location.assign('/');
    }

    async function boot() {
        if (!groupId) {
            try { groupId = sessionStorage.getItem('zlapy:open-group-details') || ''; } catch { }
        }
        if (!groupId) {
            showError('No hay grupo seleccionado', 'Vuelve a la app y abre un grupo para ver sus detalles.');
            return;
        }
        try { sessionStorage.setItem('zlapy:open-group-details', groupId); } catch { }
        try {
            const sessionResponse = await fetch('/auth/session', { cache: 'no-store' });
            if (!sessionResponse.ok) throw new Error('No se pudo comprobar la sesión.');
            const session = await sessionResponse.json();
            if (!session || !session.authenticated) {
                location.replace('/');
                return;
            }
            state.me = session.user || {};
            const group = await fetchGroup(groupId);
            state.group = group;
            resetDraft(group);
            await ensureProfiles(groupProfileNames(group));
            await loadContacts();
            refs.loadingCard.hidden = true;
            refs.pageGrid.hidden = false;
            renderAll();
            if (requestedSection === 'settings' || requestedSection === 'members') {
                const target = requestedSection === 'settings' ? refs.settingsSection : refs.membersCard;
                // Si se entra justo a los permisos, el bloque viene desplegado.
                if (requestedSection === 'settings' && refs.settingsSection) refs.settingsSection.open = true;
                window.setTimeout(() => {
                    try { target.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch { }
                }, 120);
            }
        } catch (error) {
            console.error('[detalles] No se pudo abrir el grupo:', error);
            showError('No se pudo abrir el grupo', error.message || 'Inténtalo de nuevo desde la app.');
        }
    }

    refs.closeBtn.addEventListener('click', goBack);
    refs.errorBackBtn.addEventListener('click', goBack);
    refs.saveBtn.addEventListener('click', saveSettings);
    refs.addPeopleBtn.addEventListener('click', addPeople);
    refs.shareBtn.addEventListener('click', shareGroup);
    refs.leaveBtn.addEventListener('click', leaveGroup);
    refs.deleteBtn.addEventListener('click', deleteGroup);
    refs.discardBtn.addEventListener('click', () => {
        resetDraft(state.group);
        renderGroupCard();
        renderSettings();
        updateDirty();
        showToast('Cambios descartados.');
    });

    refs.avatarBtn.addEventListener('click', () => {
        if (!canEdit()) return;
        refs.avatarInput.click();
    });
    refs.avatarInput.addEventListener('change', () => {
        const file = refs.avatarInput.files && refs.avatarInput.files[0];
        if (file) handleAvatar(file);
    });
    refs.removeAvatarBtn.addEventListener('click', removeGroupAvatar);

    refs.nameInput.addEventListener('input', () => {
        state.draft.name = refs.nameInput.value;
        refs.nameCount.textContent = `${refs.nameInput.value.length}/40`;
        updateDirty();
    });
    refs.descInput.addEventListener('input', () => {
        state.draft.description = refs.descInput.value;
        refs.descCount.textContent = `${refs.descInput.value.length}/500`;
        updateDirty();
    });
    // La descripcion crece con su contenido, tambien al cargar.
    if (window.ZlapyAutoGrow) ZlapyAutoGrow.grow(refs.descInput, { minHeight: 84, maxHeight: 260 });

    refs.memberSearch.addEventListener('input', () => {
        state.query = refs.memberSearch.value;
        renderMembers();
    });
    refs.memberSearchClear.addEventListener('click', () => {
        state.query = '';
        refs.memberSearch.value = '';
        renderMembers();
        refs.memberSearch.focus({ preventScroll: true });
    });

    refs.memberList.addEventListener('click', event => {
        const button = event.target.closest('[data-member-menu]');
        if (!button) return;
        event.stopPropagation();
        openMemberMenu(button.dataset.memberMenu, button);
    });

    refs.requestList.addEventListener('click', event => {
        const button = event.target.closest('[data-request-action]');
        if (!button) return;
        const username = button.dataset.user;
        if (!username) return;
        if (button.dataset.requestAction === 'approve') approveRequest(username);
        else rejectRequest(username);
    });

    refs.policyRows.addEventListener('click', event => {
        const button = event.target.closest('.seg button');
        if (!button || !isEditable()) return;
        const segment = button.closest('.seg');
        state.draft[segment.dataset.policy] = button.dataset.value;
        syncPolicyControls();
        updateDirty();
        renderSettings();
    });

    refs.contentPolicyList.addEventListener('click', event => {
        const button = event.target.closest('.seg button');
        if (!button || !isEditable()) return;
        const segment = button.closest('.seg');
        state.draft.contentPolicy[segment.dataset.content] = button.dataset.value;
        syncPolicyControls();
        updateDirty();
    });

    refs.peopleList.addEventListener('change', event => {
        const input = event.target.closest('input[type="checkbox"]');
        if (!input || !state.picker) return;
        const username = input.value;
        if (!username) return;
        if (input.checked) state.picker.selected.add(username);
        else state.picker.selected.delete(username);
        renderPicker();
    });

    refs.peopleSearch.addEventListener('input', () => {
        if (!state.picker) return;
        state.picker.query = refs.peopleSearch.value;
        renderPicker();
    });

    refs.peopleOverlay.addEventListener('click', event => {
        const action = event.target.closest('[data-action]');
        if (action) {
            if (action.dataset.action === 'cancel') closePeoplePicker();
            else if (action.dataset.action === 'ok') confirmPickerSelection();
            return;
        }
        if (event.target === refs.peopleOverlay) closePeoplePicker();
    });

    refs.profileOverlay.addEventListener('click', event => {
        const action = event.target.closest('[data-action]');
        if (action) {
            closeProfile();
            return;
        }
        if (event.target === refs.profileOverlay) closeProfile();
    });

    refs.confirmOverlay.addEventListener('click', event => {
        const action = event.target.closest('[data-action]');
        if (action) {
            closeConfirm(action.dataset.action === 'ok');
            return;
        }
        if (event.target === refs.confirmOverlay) closeConfirm(false);
    });

    document.addEventListener('pointerdown', event => {
        if (refs.memberMenu.hidden) return;
        if (event.target.closest('#memberMenu') || event.target.closest('[data-member-menu]')) return;
        closeMemberMenu();
    }, true);

    refs.content.addEventListener('scroll', closeMemberMenu, { passive: true });
    window.addEventListener('resize', closeMemberMenu);

    document.addEventListener('contextmenu', event => event.preventDefault());

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (!refs.confirmOverlay.hidden) { closeConfirm(false); return; }
        if (!refs.peopleOverlay.hidden) { closePeoplePicker(); return; }
        if (!refs.profileOverlay.hidden) { closeProfile(); return; }
        if (!refs.memberMenu.hidden) { closeMemberMenu(); return; }
        goBack();
    });

    boot();
})();
