(() => {
    'use strict';

    const PREF_DEFAULTS = {
        visibility: 'private',
        join: 'request',
        write: 'all',
        add: 'admins',
        edit: 'admins',
        mention: 'all'
    };

    const CONTENT_ROWS = [
        ['image', 'Fotos'],
        ['video', 'Videos'],
        ['audio', 'Audio y notas de voz'],
        ['file', 'Archivos'],
        ['sticker', 'Stickers'],
        ['contact', 'Contactos'],
        ['poll', 'Encuestas']
    ];

    const params = new URLSearchParams(location.search);
    const embedded = params.get('embedded') === '1' && window.parent !== window;
    const editMode = params.get('mode') === 'edit';
    const editGroupId = editMode ? (params.get('id') || '') : '';
    if (editMode) document.body.classList.add('edit-mode');

    const state = {
        me: null,
        contacts: [],
        profiles: Object.create(null),
        selected: [],
        query: '',
        prefs: { ...PREF_DEFAULTS },
        contentPolicy: Object.fromEntries(CONTENT_ROWS.map(([kind]) => [kind, 'all'])),
        group: null,
        isAdmin: false,
        canEditGroup: false,
        avatarChanged: false,
        avatar: '',
        busy: false,
        ready: false,
        loadError: false
    };

    const $ = id => document.getElementById(id);
    const refs = {
        pageTitle: $('pageTitle'),
        createBtn: $('createBtn'),
        closeBtn: $('closeBtn'),
        appbarSub: $('appbarSub'),
        participantsSection: $('participantsSection'),
        footnote: $('footnote'),
        removeAvatarBtn: $('removeAvatarBtn'),
        contentPolicyHead: $('contentPolicyHead'),
        contentPolicyRows: $('contentPolicyRows'),
        advNote: $('advNote'),
        name: $('groupName'),
        nameCount: $('nameCount'),
        descToggle: $('descToggle'),
        descWrap: $('descWrap'),
        desc: $('groupDesc'),
        descCount: $('descCount'),
        avatarBtn: $('avatarBtn'),
        avatarInput: $('avatarInput'),
        avatarImg: $('avatarImg'),
        avatarDefault: $('avatarDefault'),
        memberCount: $('memberCount'),
        chips: $('chips'),
        chipsEmpty: $('chipsEmpty'),
        search: $('searchInput'),
        searchClear: $('searchClear'),
        listLabel: $('listLabel'),
        listCount: $('listCount'),
        contactList: $('contactList'),
        emptySearch: $('emptySearch'),
        emptyTitle: $('emptyTitle'),
        emptyText: $('emptyText'),
        emptyRetry: $('emptyRetry'),
        advanced: $('advanced'),
        advSummary: $('advSummary'),
        content: $('content'),
        toast: $('toast'),
        toastText: $('toastText'),
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
        .toLowerCase();

    const isEncryptedName = value => {
        const text = String(value || '');
        return text.startsWith('PCE3:') || text.startsWith('PCE1:');
    };

    const displayName = username => {
        const profile = state.profiles[username];
        const name = profile && profile.name;
        return name && !isEncryptedName(name) ? name : username;
    };

    const firstName = name => String(name || '').trim().split(/\s+/)[0] || '';

    const initials = name => String(name || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(part => part[0])
        .join('')
        .toUpperCase() || '?';

    const avatarUrl = profile => {
        if (!profile) return '';
        if (profile.avatar) return profile.avatar;
        const key = profile.id || profile.username;
        return key ? '/avatar/' + encodeURIComponent(key) + '.svg' : '';
    };

    function presenceText(contact) {
        if (!contact) return 'Sin conexión';
        if (contact.online) return 'en línea';
        if (!contact.lastSeen) return 'Sin conexión';
        const date = new Date(contact.lastSeen);
        const now = new Date();
        const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const startThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        const daysAgo = Math.round((startToday - startThatDay) / 86400000);
        if (daysAgo === 0) return `Últ. vez hoy a las ${time}`;
        if (daysAgo === 1) return `Últ. vez ayer a las ${time}`;
        return `Últ. vez ${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} a las ${time}`;
    }

    function showToast(message, icon = 'info') {
        refs.toastText.textContent = message;
        refs.toast.classList.add('show');
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => refs.toast.classList.remove('show'), 3400);
    }

    function canCreate() {
        if (editMode) return Boolean(refs.name.value.trim()) && state.ready && !state.loadError && state.canEditGroup;
        return Boolean(refs.name.value.trim()) && state.selected.length > 0 && state.ready && !state.loadError;
    }

    function updateSummary() {
        const count = state.selected.length;
        const name = refs.name.value.trim();

        refs.memberCount.textContent = String(count);
        refs.memberCount.classList.toggle('is-empty', count === 0);
        refs.memberCount.setAttribute('aria-label', `${count} participante${count === 1 ? '' : 's'} seleccionado${count === 1 ? '' : 's'}`);
        refs.nameCount.textContent = `${refs.name.value.length}/40`;
        refs.createBtn.disabled = state.busy || !canCreate();
        refs.createBtn.textContent = state.busy
            ? (editMode ? 'Guardando…' : 'Creando…')
            : (editMode ? 'Guardar' : 'Crear');

        if (editMode) {
            if (state.loadError) refs.appbarSub.textContent = 'No se pudo cargar el grupo';
            else if (!state.ready) refs.appbarSub.textContent = 'Cargando grupo…';
            else if (!state.canEditGroup) refs.appbarSub.textContent = 'No puedes editar este grupo';
            else if (!name) refs.appbarSub.textContent = 'Ponle un nombre al grupo';
            else if (!state.isAdmin) refs.appbarSub.textContent = 'Cambia el nombre, la foto o la descripción';
            else refs.appbarSub.textContent = 'Cambia la información y los permisos';
            return;
        }

        if (state.loadError) refs.appbarSub.textContent = 'No se pudieron cargar los contactos';
        else if (!state.ready) refs.appbarSub.textContent = 'Cargando contactos…';
        else if (!name && count === 0) refs.appbarSub.textContent = 'Añade un nombre y participantes';
        else if (!name) refs.appbarSub.textContent = 'Ponle un nombre al grupo';
        else if (count === 0) refs.appbarSub.textContent = 'Elige a los participantes';
        else refs.appbarSub.textContent = `${count} participante${count === 1 ? '' : 's'}`;
    }

    function renderChips() {
        if (!state.selected.length) {
            refs.chips.innerHTML = '';
            refs.chips.hidden = true;
            refs.chipsEmpty.hidden = false;
            return;
        }

        refs.chips.hidden = false;
        refs.chipsEmpty.hidden = true;
        refs.chips.innerHTML = state.selected.map(username => {
            const profile = state.profiles[username] || { username };
            const name = displayName(username);
            const src = avatarUrl(profile);
            return `<button class="chip" type="button" data-remove="${escapeHtml(username)}" aria-label="Quitar a ${escapeHtml(name)}">
                <span class="chip-avatar" aria-hidden="true">
                    <span>${escapeHtml(initials(name))}</span>
                    ${src ? `<img src="${escapeHtml(src)}" alt="" onerror="this.remove()">` : ''}
                </span>
                <span class="chip-name">${escapeHtml(firstName(name))}</span>
                <svg class="icon" aria-hidden="true"><use href="#i-x"></use></svg>
            </button>`;
        }).join('');
    }

    function setEmptyState(title, text, retry) {
        refs.emptyTitle.textContent = title;
        refs.emptyText.textContent = text;
        refs.emptyRetry.hidden = !retry;
        refs.emptySearch.hidden = false;
        refs.contactList.hidden = true;
    }

    function renderContacts() {
        const query = normalize(state.query);
        const filtered = state.contacts.filter(contact =>
            !query || normalize(`${displayName(contact.username)} ${contact.username}`).includes(query)
        );

        refs.listLabel.textContent = query ? 'Resultados' : 'Todos los contactos';
        refs.listCount.textContent = String(filtered.length);

        if (!state.ready) {
            refs.contactList.hidden = false;
            refs.emptySearch.hidden = true;
            refs.contactList.innerHTML = '<div class="list-loading">Cargando contactos…</div>';
            return;
        }

        if (state.loadError) {
            setEmptyState(
                'No se pudieron cargar los contactos',
                'Comprueba tu conexión e inténtalo de nuevo.',
                true
            );
            return;
        }

        if (!state.contacts.length) {
            setEmptyState(
                'Aún no tienes contactos',
                'Añade a alguien desde Zlapy y vuelve a intentarlo.',
                false
            );
            return;
        }

        if (!filtered.length) {
            setEmptyState(
                'No encontramos a nadie',
                'Prueba con otro nombre o con el @usuario.',
                false
            );
            return;
        }

        refs.contactList.hidden = false;
        refs.emptySearch.hidden = true;
        refs.contactList.innerHTML = filtered.map(contact => {
            const username = contact.username;
            const profile = state.profiles[username] || { username };
            const name = displayName(username);
            const src = avatarUrl(profile);
            const selected = state.selected.includes(username);
            const status = contact.online
                ? '<span class="online-dot" aria-hidden="true"></span><span>en línea</span>'
                : `<span class="sub-sep" aria-hidden="true">·</span><span>${escapeHtml(presenceText(contact))}</span>`;
            return `<button class="contact" type="button" data-contact="${escapeHtml(username)}" aria-pressed="${selected}" aria-label="${selected ? 'Quitar' : 'Añadir'} a ${escapeHtml(name)}">
                <span class="person-avatar" aria-hidden="true">
                    <span>${escapeHtml(initials(name))}</span>
                    ${src ? `<img src="${escapeHtml(src)}" alt="" onerror="this.remove()">` : ''}
                </span>
                <span class="person-copy">
                    <span class="person-name">${escapeHtml(name)}</span>
                    <span class="person-sub">@${escapeHtml(username)}${status}</span>
                </span>
                <span class="check" aria-hidden="true">
                    <svg class="icon"><use href="#i-check"></use></svg>
                </span>
            </button>`;
        }).join('');
    }

    function renderAll() {
        renderChips();
        renderContacts();
        updateSummary();
    }

    function syncDescriptionToggle() {
        const open = !refs.descWrap.hidden;
        const hasText = Boolean(refs.desc.value.trim());
        const icon = open ? 'minus' : hasText ? 'pencil' : 'plus';
        const label = open ? 'Ocultar descripción' : hasText ? 'Editar descripción' : 'Añadir descripción';
        refs.descToggle.setAttribute('aria-expanded', String(open));
        refs.descToggle.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-${icon}"></use></svg><span>${label}</span>`;
    }

    function renderPreferences() {
        document.querySelectorAll('.advanced .seg[data-key]').forEach(seg => {
            const key = seg.dataset.key;
            seg.querySelectorAll('button[data-value]').forEach(button => {
                const active = button.dataset.value === state.prefs[key];
                button.classList.toggle('on', active);
                button.setAttribute('aria-pressed', String(active));
                button.disabled = editMode && !state.isAdmin;
            });
        });
        updatePreferencesSummary();
    }

    function renderContentPolicy() {
        if (!editMode || !state.isAdmin) return;
        refs.contentPolicyRows.innerHTML = CONTENT_ROWS.map(([kind, label]) => `
            <div class="adv-row">
                <div class="adv-label"><b>${label}</b></div>
                <div class="seg" data-content="${kind}" role="group" aria-label="${label}">
                    ${[['all', 'Todos'], ['admins', 'Solo admins'], ['off', 'Desactivado']].map(([value, text]) => `
                        <button type="button" data-value="${value}">${text}</button>
                    `).join('')}
                </div>
            </div>
        `).join('');
        refs.contentPolicyHead.hidden = false;
        refs.contentPolicyRows.hidden = false;
        renderContentPolicyState();
    }

    function renderContentPolicyState() {
        refs.contentPolicyRows.querySelectorAll('.seg[data-content]').forEach(seg => {
            const kind = seg.dataset.content;
            seg.querySelectorAll('button[data-value]').forEach(button => {
                const active = button.dataset.value === state.contentPolicy[kind];
                button.classList.toggle('on', active);
                button.setAttribute('aria-pressed', String(active));
            });
        });
    }

    function updatePreferencesSummary() {
        const activeLabel = key => {
            const button = document.querySelector(`.advanced .seg[data-key="${key}"] button.on`);
            return button ? button.textContent.trim() : '';
        };
        const write = activeLabel('write');
        refs.advSummary.textContent = `${activeLabel('visibility')} · ${activeLabel('join')} · ${write === 'Todos' ? 'Todos escriben' : 'Solo admins escriben'}`;
    }

    function toggleContact(username) {
        const index = state.selected.indexOf(username);
        if (index >= 0) state.selected.splice(index, 1);
        else state.selected.push(username);
        renderAll();

        const row = refs.contactList.querySelector(`[data-contact="${CSS.escape(username)}"]`);
        if (row) row.focus({ preventScroll: true });
    }

    function removeContact(username) {
        const index = state.selected.indexOf(username);
        if (index < 0) return;
        state.selected.splice(index, 1);
        renderAll();
        refs.search.focus({ preventScroll: true });
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

    function setBusy(busy) {
        state.busy = busy;
        updateSummary();
    }

    async function submitGroup() {
        if (state.busy || !canCreate()) return;

        const name = refs.name.value.trim();
        if (!name) {
            showToast('Pon un nombre para el grupo.');
            refs.name.focus();
            return;
        }
        if (!editMode && !state.selected.length) {
            showToast('Selecciona al menos un participante.');
            refs.search.focus();
            return;
        }

        setBusy(true);
        try {
            if (editMode) {
                if (!state.canEditGroup) throw new Error('No tienes permiso para editar este grupo.');
                const payload = {
                    rename: name,
                    description: refs.desc.value.trim()
                };
                if (state.avatarChanged) payload.avatar = state.avatar;
                if (state.isAdmin) {
                    payload.visibility = state.prefs.visibility;
                    payload.joinPolicy = state.prefs.join;
                    payload.writePolicy = state.prefs.write;
                    payload.addPolicy = state.prefs.add;
                    payload.editPolicy = state.prefs.edit;
                    payload.mentionAllPolicy = state.prefs.mention;
                    payload.contentPolicy = { ...state.contentPolicy };
                }

                const response = await fetch('/groups/' + encodeURIComponent(editGroupId), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const group = await response.json();
                if (!response.ok) throw new Error(group.error || 'No se pudo guardar el grupo.');
                if (embedded) {
                    window.parent.postMessage({ type: 'zlapy:group-saved', groupId: editGroupId }, location.origin);
                    return;
                }
                location.assign('/');
                return;
            }

            const response = await fetch('/groups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    members: [...state.selected],
                    description: refs.desc.value.trim(),
                    avatar: state.avatar,
                    visibility: state.prefs.visibility,
                    joinPolicy: state.prefs.join,
                    writePolicy: state.prefs.write,
                    addPolicy: state.prefs.add,
                    editPolicy: state.prefs.edit,
                    mentionAllPolicy: state.prefs.mention
                })
            });
            const group = await response.json();
            if (!response.ok) throw new Error(group.error || 'No se pudo crear el grupo.');
            if (!group || !group.id) throw new Error('El servidor no devolvió el grupo creado.');
            if (embedded) {
                window.parent.postMessage({ type: 'zlapy:group-created', groupId: group.id }, location.origin);
                return;
            }
            try { sessionStorage.setItem('zlapy:open-group', group.id); } catch { }
            location.assign('/');
        } catch (error) {
            console.error('[grupo] No se pudo guardar el grupo:', error);
            showToast(error.message || (editMode ? 'No se pudo guardar el grupo.' : 'No se pudo crear el grupo.'), 'info');
            setBusy(false);
        }
    }

    function goBack() {
        if (state.busy) return;
        if (embedded) {
            window.parent.postMessage({ type: 'zlapy:group-close' }, location.origin);
            return;
        }
        const referrer = document.referrer;
        if (referrer) {
            try {
                if (new URL(referrer).origin === location.origin) {
                    history.back();
                    return;
                }
            } catch { }
        }
        location.assign('/');
    }

    async function loadProfiles(list) {
        await Promise.allSettled(list.map(async contact => {
            try {
                const response = await fetch('/profile?username=' + encodeURIComponent(contact.username), { cache: 'no-store' });
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const profile = await response.json();
                state.profiles[contact.username] = { ...profile, username: contact.username };
            } catch (error) {
                console.error('[grupo] No se pudo cargar el perfil de ' + contact.username + ':', error);
                state.profiles[contact.username] = { username: contact.username };
            }
        }));
    }

    async function bootEdit() {
        state.ready = false;
        state.loadError = false;
        renderPreferences();
        updateSummary();

        try {
            const sessionResponse = await fetch('/auth/session', { cache: 'no-store' });
            if (!sessionResponse.ok) throw new Error('No se pudo comprobar la sesión.');
            const session = await sessionResponse.json();
            if (!session || !session.authenticated) {
                location.replace('/');
                return;
            }
            state.me = session.user || {};

            if (!editGroupId) throw new Error('Falta el grupo que se va a editar.');
            const response = await fetch('/groups/' + encodeURIComponent(editGroupId) + '?light=1', { cache: 'no-store' });
            if (!response.ok) throw new Error(response.status === 404 ? 'No se encontró el grupo.' : 'No se pudo cargar el grupo.');
            const group = await response.json();

            const isAdmin = Array.isArray(group.admins) && group.admins.includes(state.me.username);
            const canEditGroup = isAdmin || group.editPolicy === 'all';
            state.group = group;
            state.isAdmin = isAdmin;
            state.canEditGroup = canEditGroup;
            if (!canEditGroup) throw new Error('No tienes permiso para editar este grupo.');

            document.title = 'Editar grupo — Zlapy';
            refs.pageTitle.textContent = 'Editar grupo';
            refs.participantsSection.hidden = true;
            refs.footnote.hidden = true;
            refs.advanced.open = true;
            refs.advNote.textContent = isAdmin
                ? 'Los cambios se aplican al pulsar Guardar.'
                : 'Solo los administradores pueden cambiar los permisos.';

            refs.name.value = group.name || '';
            refs.desc.value = group.description || '';
            refs.descCount.textContent = `${refs.desc.value.length}/500`;
            if (refs.desc.value.trim()) refs.descWrap.hidden = false;

            state.avatar = group.avatar || '';
            if (state.avatar) {
                refs.avatarImg.src = state.avatar;
                refs.avatarImg.hidden = false;
                refs.avatarDefault.hidden = true;
                refs.removeAvatarBtn.hidden = false;
            } else {
                refs.avatarImg.hidden = true;
                refs.avatarDefault.hidden = false;
                refs.removeAvatarBtn.hidden = true;
            }

            state.prefs = {
                visibility: group.visibility || PREF_DEFAULTS.visibility,
                join: group.joinPolicy || PREF_DEFAULTS.join,
                write: group.writePolicy || PREF_DEFAULTS.write,
                add: group.addPolicy || PREF_DEFAULTS.add,
                edit: group.editPolicy || PREF_DEFAULTS.edit,
                mention: group.mentionAllPolicy || PREF_DEFAULTS.mention
            };
            if (group.contentPolicy && typeof group.contentPolicy === 'object') {
                for (const [kind, policy] of Object.entries(group.contentPolicy)) {
                    if (kind in state.contentPolicy && ['all', 'admins', 'off'].includes(policy)) state.contentPolicy[kind] = policy;
                }
            }

            state.ready = true;
            state.loadError = false;
            renderPreferences();
            renderContentPolicy();
            syncDescriptionToggle();
            updateSummary();
        } catch (error) {
            console.error('[grupo] No se pudo cargar el grupo para editar:', error);
            state.ready = true;
            state.loadError = true;
            renderPreferences();
            updateSummary();
            showToast(error.message || 'No se pudo cargar el grupo.', 'info');
        }
    }

    async function boot() {
        state.ready = false;
        state.loadError = false;
        renderContacts();
        updateSummary();

        try {
            const sessionResponse = await fetch('/auth/session', { cache: 'no-store' });
            if (!sessionResponse.ok) throw new Error('No se pudo comprobar la sesión.');
            const session = await sessionResponse.json();
            if (!session || !session.authenticated) {
                location.replace('/');
                return;
            }
            state.me = session.user || {};

            const usersResponse = await fetch('/users', { cache: 'no-store' });
            if (!usersResponse.ok) throw new Error('No se pudieron cargar los contactos.');
            const data = await usersResponse.json();
            const list = Array.isArray(data.users)
                ? data.users.filter(user => user.username !== state.me.username)
                : [];

            state.contacts = list;
            await loadProfiles(list);
            state.ready = true;
            state.loadError = false;
            renderAll();
        } catch (error) {
            console.error('[grupo] No se pudo cargar la pantalla:', error);
            state.ready = true;
            state.loadError = true;
            renderContacts();
            updateSummary();
            showToast('No se pudieron cargar los contactos.', 'info');
        }
    }

    refs.avatarBtn.addEventListener('click', () => refs.avatarInput.click());

    refs.avatarInput.addEventListener('change', async () => {
        const file = refs.avatarInput.files && refs.avatarInput.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            showToast('Selecciona un archivo de imagen.');
            refs.avatarInput.value = '';
            return;
        }

        try {
            // La foto del grupo usa el mismo editor que la foto de perfil:
            // se recorta a 512 x 512 y se puede mover y ampliar.
            const editor = window.ZlapyAvatarEditor;
            let avatar = '';
            if (editor && typeof editor.open === 'function') {
                const result = await editor.open({ file });
                if (!result || !result.dataUrl) { refs.avatarInput.value = ''; return; }
                avatar = result.dataUrl;
            } else {
                avatar = await imageToDataUrl(file);
            }
            state.avatar = avatar;
            state.avatarChanged = true;
            refs.avatarImg.src = state.avatar;
            refs.avatarImg.hidden = false;
            refs.avatarDefault.hidden = true;
            refs.removeAvatarBtn.hidden = !editMode;
        } catch (error) {
            console.error('[grupo] No se pudo preparar la foto:', error);
            showToast('No se pudo preparar la foto del grupo.');
        } finally {
            refs.avatarInput.value = '';
        }
    });

    refs.removeAvatarBtn.addEventListener('click', () => {
        if (!editMode || state.busy) return;
        state.avatar = '';
        state.avatarChanged = true;
        refs.avatarImg.hidden = true;
        refs.avatarDefault.hidden = false;
        refs.removeAvatarBtn.hidden = true;
        showToast('La foto se quitará al guardar.');
    });

    refs.name.addEventListener('input', updateSummary);
    refs.name.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            if (canCreate()) submitGroup();
        }
    });

    refs.descToggle.addEventListener('click', () => {
        const open = refs.descWrap.hidden;
        refs.descWrap.hidden = !open;
        syncDescriptionToggle();
        if (open) refs.desc.focus();
    });

    refs.desc.addEventListener('input', () => {
        refs.descCount.textContent = `${refs.desc.value.length}/500`;
        syncDescriptionToggle();
    });
    // La descripcion crece con su contenido, tambien al cargar.
    if (window.ZlapyAutoGrow) ZlapyAutoGrow.grow(refs.desc, { minHeight: 64, maxHeight: 260 });

    refs.search.addEventListener('input', () => {
        state.query = refs.search.value;
        refs.searchClear.hidden = !state.query;
        renderContacts();
    });

    refs.searchClear.addEventListener('click', () => {
        refs.search.value = '';
        state.query = '';
        refs.searchClear.hidden = true;
        renderContacts();
        refs.search.focus();
    });

    refs.contactList.addEventListener('click', event => {
        const row = event.target.closest('[data-contact]');
        if (!row) return;
        toggleContact(row.dataset.contact);
    });

    refs.chips.addEventListener('click', event => {
        const chip = event.target.closest('[data-remove]');
        if (!chip) return;
        removeContact(chip.dataset.remove);
    });

    document.querySelectorAll('.advanced .seg[data-key]').forEach(seg => {
        seg.addEventListener('click', event => {
            const button = event.target.closest('button[data-value]');
            if (!button || (editMode && !state.isAdmin)) return;
            state.prefs[seg.dataset.key] = button.dataset.value;
            renderPreferences();
        });
    });

    refs.contentPolicyRows.addEventListener('click', event => {
        const button = event.target.closest('button[data-value]');
        if (!button) return;
        const seg = button.closest('.seg[data-content]');
        if (!seg) return;
        state.contentPolicy[seg.dataset.content] = button.dataset.value;
        renderContentPolicyState();
    });

    refs.createBtn.addEventListener('click', submitGroup);
    refs.closeBtn.addEventListener('click', goBack);
    refs.emptyRetry.addEventListener('click', boot);

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') goBack();
    });

    document.addEventListener('contextmenu', event => event.preventDefault());

    refs.descCount.textContent = '0/500';
    renderPreferences();
    if (editMode) {
        syncDescriptionToggle();
        bootEdit();
    } else {
        renderAll();
        syncDescriptionToggle();
        boot();
    }
})();
