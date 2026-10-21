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

    const state = {
        me: null,
        contacts: [],
        profiles: Object.create(null),
        selected: [],
        query: '',
        prefs: { ...PREF_DEFAULTS },
        avatar: '',
        busy: false,
        ready: false,
        loadError: false
    };

    const embedded = new URLSearchParams(location.search).get('embedded') === '1' && window.parent !== window;

    const $ = id => document.getElementById(id);
    const refs = {
        createBtn: $('createBtn'),
        closeBtn: $('closeBtn'),
        appbarSub: $('appbarSub'),
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
        return key ? '/avatar/' + encodeURIComponent(key) + '.svg?v=3' : '';
    };

    function presenceText(contact) {
        if (!contact) return 'Sin conexión';
        if (contact.online) return 'En línea';
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
        refs.createBtn.textContent = state.busy ? 'Creando…' : 'Crear';

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
                ? '<span class="online-dot" aria-hidden="true"></span><span>En línea</span>'
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
        document.querySelectorAll('.advanced .seg').forEach(seg => {
            const key = seg.dataset.key;
            seg.querySelectorAll('button[data-value]').forEach(button => {
                const active = button.dataset.value === state.prefs[key];
                button.classList.toggle('on', active);
                button.setAttribute('aria-pressed', String(active));
            });
        });
        updatePreferencesSummary();
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
        if (!state.selected.length) {
            showToast('Selecciona al menos un participante.');
            refs.search.focus();
            return;
        }

        setBusy(true);
        try {
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
            console.error('[grupo] No se pudo crear el grupo:', error);
            showToast(error.message || 'No se pudo crear el grupo.', 'info');
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
            refs.avatarImg.src = state.avatar;
            refs.avatarImg.hidden = false;
            refs.avatarDefault.hidden = true;
        } catch (error) {
            console.error('[grupo] No se pudo preparar la foto:', error);
            showToast('No se pudo preparar la foto del grupo.');
        } finally {
            refs.avatarInput.value = '';
        }
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

    document.querySelectorAll('.advanced .seg').forEach(seg => {
        seg.addEventListener('click', event => {
            const button = event.target.closest('button[data-value]');
            if (!button) return;
            state.prefs[seg.dataset.key] = button.dataset.value;
            renderPreferences();
        });
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
    renderAll();
    syncDescriptionToggle();
    boot();
})();
