/* Acento compartido: el MISMO componente en todas las páginas (index,
   perfil, historias, grupos, privacidad y login). El index de la app guarda
   la apariencia del chat en localStorage bajo la llave por usuario
   (zlapy_appearance_<id>) y un puntero del dispositivo
   (zlapy_appearance_hint); este componente lee esa cache y pinta las
   variables del tema (--accent, --accent-ink, --accent-secondary y sus
   derivados) para que todas las páginas usen el mismo color sin parpadeo.
   Después lo refina por cuenta: sesión, cache por usuario y servidor.
   Funciona cargado SIN defer en el head: pinta antes del primer render. */
(() => {
    'use strict';

    const HINT_KEY = 'zlapy_appearance_hint';
    /* Los mismos defaults del index (CHAT_APPEARANCE_DEFAULTS), sin el
       fallback de la paleta vieja: sin datos deja el default de theme.css. */
    const DEFAULTS = { sender: '#25483c', senderText: '#e2f0e9', receiver: '#1c332b' };
    const hex = (value, fallback) => (/^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback);

    /* Pinta --accent y derivados con la apariencia dada.
       El campo `accent` es el acento de los controles que se elige
       aparte en Ajustes > Chats: vacío o inválido sigue al color de
       burbuja del remitente, igual que applyWall() del index. */
    const apply = value => {
        if (!value || typeof value !== 'object') return null;
        const sender = hex(value.sender, DEFAULTS.sender);
        const senderText = hex(value.senderText, DEFAULTS.senderText);
        const receiver = hex(value.receiver, DEFAULTS.receiver);
        const accent = hex(value.accent, '');
        const root = document.documentElement.style;
        root.setProperty('--accent', accent || sender);
        root.setProperty('--accent-ink', senderText);
        root.setProperty('--accent-secondary', receiver);
        root.setProperty('--accent-hover', 'color-mix(in srgb, ' + (accent || sender) + ' 88%, ' + senderText + ')');
        root.setProperty('--accent-soft', 'color-mix(in srgb, ' + (accent || sender) + ' 18%, transparent)');
        return { sender, senderText, receiver, accent };
    };

    /* Guarda la cache en los mismos 5 campos y llaves que escribe el index
       (cacheChatAppearanceLocally): así el index no pierde datos al releerla. */
    const cache = (userId, value) => {
        const stored = {
            sender: value.sender,
            senderText: value.senderText,
            receiver: value.receiver,
            receiverText: hex(value.receiverText, DEFAULTS.senderText),
            accent: value.accent || ''
        };
        try { localStorage.setItem('zlapy_appearance_' + userId, JSON.stringify(stored)); }
        catch (error) { console.error('[appearance] No se pudo guardar la cache del acento:', error); }
        try { localStorage.setItem(HINT_KEY, JSON.stringify({ id: userId, ...stored })); }
        catch (error) { console.error('[appearance] No se pudo guardar el puntero del acento:', error); }
    };

    /* Pinta sincrónico con lo cacheado del dispositivo: sin esperar red
       ni sesión, para que no parpadee el default de theme.css. */
    try {
        const hint = JSON.parse(localStorage.getItem(HINT_KEY) || 'null');
        if (hint && (/^#[0-9a-f]{6}$/i.test(hint.accent || '') || /^#[0-9a-f]{6}$/i.test(hint.sender || ''))) apply(hint);
    } catch (error) { console.error('[appearance] No se pudo leer el puntero del acento:', error); }

    /* Refinado por cuenta: la cache del hint no sabe de qué usuario es, así
       que cuando entra la sesión se corrige con la cache de SU constante y
       por último con la apariencia del servidor (fuente de verdad). */
    const init = async () => {
        let user;
        try {
            const response = await fetch('/auth/session', { cache: 'no-store' });
            if (!response.ok) return;
            const session = await response.json();
            if (!session || !session.authenticated) return;
            user = session.user || {};
        } catch (error) {
            console.error('[appearance] No se pudo iniciar la carga del acento:', error);
            return;
        }
        const userId = String(user.id || user.username || 'guest');
        try {
            const cached = JSON.parse(localStorage.getItem('zlapy_appearance_' + userId) || 'null');
            if (cached) apply(cached);
        } catch (error) { console.error('[appearance] No se pudo leer la cache del acento:', error); }
        try {
            const response = await fetch('/account/chat-settings', { cache: 'no-store' });
            if (!response.ok) return;
            const result = await response.json();
            if (!result || !result.settings) return;
            const painted = apply(result.settings);
            /* Solo cachea si la apariencia era utilizable. */
            if (painted) cache(userId, result.settings);
        } catch (error) {
            console.error('[appearance] No se pudo traer el acento de la cuenta:', error);
        }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
