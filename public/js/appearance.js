/* Acento configurado por el usuario (Ajustes > Chats / burbuja del chat).
   El chat guarda el accent en localStorage con la llave por usuario
   (chatlocal_appearance_<id>) y en un puntero chatlocal_appearance_hint que
   permite pintar antes del primer render. Aqui se aplica a var(--accent) para
   que theme.css (perfil, historias, privacidad, vista) use el mismo color. */
(() => {
  'use strict';
  const HINT_KEY = 'chatlocal_appearance_hint';
  const DEFAULTS = { sender: '#d3dbe1', senderText: '#101318', receiver: '#171b21' };
  const hex = (value, fallback) => (/^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback);
  const readJson = key => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.error('[appearance] No se pudo leer ' + key + ':', error);
      return null;
    }
  };
  const writeJson = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (error) { console.error('[appearance] No se pudo escribir ' + key + ':', error); }
  };
  const apply = value => {
    const sender = hex(value && value.sender, DEFAULTS.sender);
    const senderText = hex(value && value.senderText, DEFAULTS.senderText);
    const receiver = hex(value && value.receiver, DEFAULTS.receiver);
    const root = document.documentElement.style;
    root.setProperty('--accent', sender);
    root.setProperty('--accent-ink', senderText);
    root.setProperty('--accent-secondary', receiver);
    root.setProperty('--accent-hover', 'color-mix(in srgb, ' + sender + ' 88%, ' + senderText + ')');
    root.setProperty('--accent-soft', 'color-mix(in srgb, ' + sender + ' 18%, transparent)');
    return { sender, senderText, receiver };
  };
  const save = (userId, accent) => {
    writeJson('chatlocal_appearance_' + userId, accent);
    writeJson(HINT_KEY, { id: userId, ...accent });
  };
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
    const hint = readJson(HINT_KEY);
    if (hint && hint.id === userId) apply(hint);
    const cached = readJson('chatlocal_appearance_' + userId);
    if (cached) apply(cached);
    try {
      const response = await fetch('/account/chat-settings', { cache: 'no-store' });
      if (!response.ok) return;
      const result = await response.json();
      if (!result || !result.settings) return;
      save(userId, apply(result.settings));
    } catch (error) {
      console.error('[appearance] No se pudo traer el acento de la cuenta:', error);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();