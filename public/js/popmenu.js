/* Pop-menu compartido: el mismo componente en la app, en historias y en los
   detalles de grupo.
 *
 *   ZlapyPopMenu.open({ anchor, items, reactions, onReact, onMore, onClose })
 *     · items: [{ id, label, icon, danger }]  (icon = nombre del SVG de la lista)
 *     · reactions: emojis de la barra de reacciones (barra sobre el menu)
 *     · con items vacío Y reactions: se muestra SOLO la barra de reacciones
 *     · devuelve el elemento del menu (para enlazar los clicks)
 *   ZlapyPopMenu.close()
 *
 * Se cierra solo al tocar fuera, al pulsar Escape o al abrir otro menu.
 */
(function (global) {
    'use strict';

    const ICONS = {
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
        settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1l-.1-.1a1.7 1.7 0 0 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
        user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c.5-3.8 3-5.8 7.5-5.8s7 2 7.5 5.8"/>',
        userPlus: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.4-3.2 2.3-5 5.5-5s5.1 1.8 5.5 5"/><path d="M18 8v6M15 11h6"/>',
        userMinus: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.4-3.2 2.3-5 5.5-5s5.1 1.8 5.5 5"/><path d="M16 11h6"/>',
        unlock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.4-2"/>',
        phone: '<path d="M6.6 3.5 9 6.2 7.6 8.4a14.5 14.5 0 0 0 6 6l2.2-1.4 2.7 2.4-.8 2.4c-.3.9-1.2 1.4-2.1 1.2A17.7 17.7 0 0 1 3.1 6.4c-.2-.9.3-1.8 1.2-2.1l2.3-.8Z"/>',
        trash: '<path d="M3.5 6.5h17"/><path d="M18.5 6.5v12a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-12"/><path d="M9 6.5v-2a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M10 11v5M14 11v5"/>',
        broom: '<path d="M14 3 9 8"/><path d="M9 8 4 13a3 3 0 0 0 4 4l5-5"/><path d="M12 6l6 6"/>',
        pin: '<path d="M9 4h6l-1 5 3 3v2h-4v6l-1 1-1-1v-6H7v-2l3-3-1-5Z"/>',
        mute: '<path d="M3 9v6h4l5 5V4L7 9H3Z"/><path d="m16 9 5 6M21 9l-5 6"/>',
        bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/>',
        eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
        reply: '<path d="m9 7-5 5 5 5"/><path d="M4 12h9a6 6 0 0 1 6 6v1"/>',
        shield: '<path d="M12 3 5 6v5.5c0 4.2 2.9 7.6 7 9.5 4.1-1.9 7-5.3 7-9.5V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
        archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8"/><path d="M10 12h4"/>',
        send: '<path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9Z"/>',
        share: '<circle cx="18" cy="5" r="2.4"/><circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="19" r="2.4"/><path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5"/>',
        logout: '<path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5"/><path d="M14 8l4 4-4 4M8 12h10"/>',
        block: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
        edit: '<path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m14 6 4 4"/>',
        copy: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
        download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 21h14"/>',
        star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z"/>',
        heart: '<path d="M12 21.35 10.55 20C5.4 15.36 2 12.28 2 8.5A5.5 5.5 0 0 1 7.5 3c1.74 0 3.41.81 4.5 2.09A5.99 5.99 0 0 1 16.5 3 5.5 5.5 0 0 1 22 8.5c0 3.78-3.4 6.86-8.55 11.51L12 21.35z"/>',
        close: '<path d="M6 6l12 12M18 6 6 18"/>',
        more: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
        checkSquare: '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="m8.5 12.2 2.6 2.6 4.6-5"/>',
        search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/>',
        camera: '<path d="M4 8h3l1.4-2h7.2L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.4"/>',
        users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.4-3.2 2.3-5 5.5-5s5.1 1.8 5.5 5"/><path d="M17 6.5a3 3 0 0 1 0 5.6M18 14.5c1.8.6 2.9 2 3.2 4.5"/>',
        gallery: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.5"/><path d="m6 17.5 4.2-4.8 3.4 3.8 2.2-2.6 2.7 3.6"/>',
        file: '<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8L14 3.5Z"/><path d="M14 3.5V8h4.5"/>',
        poll: '<path d="M6 20V9M12 20V4M18 20V13"/>'
    };

    let current = null;
    let currentReactions = null;
    let currentAnchor = null;
    let currentOptions = null;

    /* Solo nombres de la lista de arriba: nada de HTML crudo, aunque mañana
       alguien le pase un dato suelto al menu. */
    function iconMarkup(name) {
        const key = String(name || '');
        if (!key || !Object.prototype.hasOwnProperty.call(ICONS, key)) return '';
        return `<svg class="zlapyMenuIcon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[key]}</svg>`;
    }

    function close() {
        if (!current) return;
        const menu = current;
        const reactions = currentReactions;
        const opts = currentOptions;
        current = null;
        currentReactions = null;
        currentAnchor = null;
        currentOptions = null;
        menu.classList.remove('on');
        menu.hidden = true;
        if (reactions) reactions.remove();
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
        /* La fase aquí debe ser la misma que en el add de `open`, o el
           listener del scroll nunca se va. */
        window.removeEventListener('resize', alResize);
        if (global.visualViewport) global.visualViewport.removeEventListener('resize', alResize);
        window.removeEventListener('scroll', close);
        if (opts && typeof opts.onClose === 'function') {
            try { opts.onClose(); } catch { }
        }
    }

    function onOutside(event) {
        if (!current) return;
        if (current.contains(event.target)) return;
        if (currentReactions && currentReactions.contains(event.target)) return;
        if (currentAnchor && currentAnchor.contains && currentAnchor.contains(event.target)) return;
        close();
    }

    function onKey(event) {
        if (event.key === 'Escape' && current) {
            event.preventDefault();
            close();
        }
    }

    /* Coloca el menú (y la barra de reacciones) junto a su ancla o punto.
       Vive separado de `open` porque también se usa al cambiar el tamaño
       de la ventana: en Android abrir/cerrar el teclado dispara un resize,
       y el menú debe REACOMODARSE dentro del área visible, no morir. */
    function colocar() {
        if (!current || !currentOptions) return;
        const opts = currentOptions;
        const rect = currentAnchor && currentAnchor.getBoundingClientRect
            ? currentAnchor.getBoundingClientRect()
            : null;
        const x = opts.x != null ? opts.x : (rect ? rect.left : 16);
        const y = opts.y != null ? opts.y : (rect ? rect.bottom + 6 : 16);
        const menu = current;
        const reactionBar = currentReactions;
        const barSola = menu.hidden;
        menu.style.left = '0px';
        menu.style.top = '0px';
        if (reactionBar) {
            reactionBar.style.left = '0px';
            reactionBar.style.top = '0px';
            menu.style.maxHeight = `${Math.max(120, innerHeight - reactionBar.offsetHeight - 32)}px`;
        } else menu.style.maxHeight = '';
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        const reactionHeight = reactionBar ? reactionBar.offsetHeight : 0;
        const reactionWidth = reactionBar ? reactionBar.offsetWidth : 0;
        const reactionGap = reactionBar ? 7 : 0;
        let left = x - width;
        let top = y;
        if (opts.align === 'right' || (rect && !opts.x)) left = rect.right - width;
        left = Math.max(8, Math.min(left, innerWidth - width - 8));
        const minTop = 8 + reactionHeight + reactionGap;
        if (top + height > innerHeight - 8) top = y - height - reactionHeight - reactionGap - 6;
        top = Math.max(minTop, Math.min(top, innerHeight - height - 8));
        menu.style.left = Math.round(left) + 'px';
        menu.style.top = Math.round(top) + 'px';
        if (reactionBar) {
            const reactionLeft = barSola
                ? Math.max(8, Math.min(x - reactionWidth / 2, innerWidth - reactionWidth - 8))
                : Math.max(8, Math.min(left + width - reactionWidth, innerWidth - reactionWidth - 8));
            reactionBar.style.left = Math.round(reactionLeft) + 'px';
            reactionBar.style.top = Math.round(top - reactionHeight - reactionGap) + 'px';
        }
    }

    /* Alto del viewport en el último evento de tamaño (para distinguir qué
       tipo de resize llegó). */
    let prevAlto = null;
    function alResize() {
        const alto = global.visualViewport ? global.visualViewport.height : global.innerHeight;
        /* Abrir el teclado ENCOGE el viewport; cerrarlo lo AGRANDA. Si el
           alto creció, el teclado se cerró — y en Android ese cierre se
           suele comer el toque de "fuera" (el pointerdown nunca llega a la
           página) — así que el menú se CIERRA, como antes del reacomodo.
           Si el alto baja o se mantiene (teclado abriéndose, rotación),
           el menú se REACOMODA y sigue abierto. */
        if (prevAlto !== null && alto > prevAlto + 24) {
            prevAlto = alto;
            close();
            return;
        }
        prevAlto = alto;
        colocar();
    }

    function open(options) {
        const opts = options || {};
        close();
        const items = Array.isArray(opts.items) ? opts.items : [];
        const hasReactions = Array.isArray(opts.reactions) && opts.reactions.length > 0 &&
            (typeof opts.onReact === 'function' || typeof opts.onMore === 'function');
        if (!items.length && !hasReactions) return null;
        let menu = document.getElementById('zlapyPopMenu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'zlapyPopMenu';
            menu.className = 'zlapyMenu';
            menu.setAttribute('role', 'menu');
            menu.hidden = true;
            document.body.appendChild(menu);
        }
        menu.classList.toggle('compact', opts.compact === true);
        /* Texto de cada etiqueta escapado: hoy todas son literales del código,
           pero este es el único `innerHTML` del menú y el día que una etiqueta
           nazca de un dato de usuario (un nombre de grupo, por ejemplo) no debe
           convertirse en HTML. */
        const attr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const text = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const reactions = Array.isArray(opts.reactions) ? opts.reactions.filter(value => typeof value === 'string').slice(0, 8) : [];
        const showReactions = reactions.length && (typeof opts.onReact === 'function' || typeof opts.onMore === 'function');
        menu.innerHTML = `<div class="zlapyMenuList">${items.map(item => `
            <button class="zlapyMenuItem${item.danger ? ' danger' : ''}${item.selected ? ' selected' : ''}" type="button" role="menuitem"${item.selected ? ' aria-current="true"' : ''} data-menu-id="${attr(item.id)}">
                ${iconMarkup(item.icon)}<span class="zlapyMenuLabel">${text(item.label)}</span>
            </button>`).join('')}</div>`;
        /* "Solo barra": con items vacío el menú no se dibuja (queda el
           cuadro invisible) y se muestra únicamente la barra de reacciones,
           centrada en el punto pedido. */
        const barSola = !items.length;
        menu.classList.toggle('on', !barSola);
        menu.hidden = barSola;
        current = menu;
        currentAnchor = opts.anchor || null;
        currentOptions = opts;
        if (showReactions) {
            const bar = document.createElement('div');
            bar.className = 'zlapyReactionBar';
            bar.setAttribute('role', 'group');
            bar.setAttribute('aria-label', 'Reaccionar al mensaje');
            bar.innerHTML = `${reactions.map(emoji => `
                <button class="zlapyMenuReaction" type="button" data-reaction="${attr(emoji)}" aria-label="Reaccionar con ${attr(emoji)}">${text(emoji)}</button>`).join('')}${typeof opts.onMore === 'function'
                ? '<button class="zlapyMenuReaction zlapyMenuReactionMore" type="button" data-reaction-more aria-label="Ver todos los emojis"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></button>' : ''}`;
            document.body.appendChild(bar);
            currentReactions = bar;
        }
        /* El enganche de los botones de reacción (más abajo) trabaja sobre
           la barra recién creada. */
        const reactionBar = currentReactions;

        // Colocarlo junto al ancla (o en el punto pedido), siempre en pantalla.
        colocar();

        menu.querySelectorAll('[data-menu-id]').forEach(button => {
            button.onclick = event => {
                event.preventDefault();
                event.stopPropagation();
                const id = button.dataset.menuId;
                close();
                if (typeof opts.onSelect === 'function') opts.onSelect(id, event);
            };
        });
        if (reactionBar) reactionBar.querySelectorAll('[data-reaction]').forEach(button => {
            button.onclick = event => {
                event.preventDefault();
                event.stopPropagation();
                const emoji = button.dataset.reaction;
                close();
                if (typeof opts.onReact === 'function') opts.onReact(emoji, event);
            };
        });
        const moreButton = reactionBar && reactionBar.querySelector('[data-reaction-more]');
        if (moreButton) moreButton.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            close();
            if (typeof opts.onMore === 'function') opts.onMore(event);
        };
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
        /* Al cambiar el tamaño de la ventana: abrir el teclado ENCOGE el
           viewport → el menú se reacomoda y sigue abierto (funciona igual
           con teclado que sin él); cerrarlo lo AGRANDA → se cierra como
           siempre (ver alResize). */
        prevAlto = global.visualViewport ? global.visualViewport.height : global.innerHeight;
        window.addEventListener('resize', alResize);
        if (global.visualViewport) global.visualViewport.addEventListener('resize', alResize);
        // Solo el scroll de la pagina cierra el menu (no el de un panel
        // interior, que no lo descoloca).
        window.addEventListener('scroll', close);
        if (typeof opts.onOpen === 'function') opts.onOpen(menu);
        return menu;
    }

    global.ZlapyPopMenu = { open, close, icons: ICONS, isOpen: () => !!current };
})(window);
