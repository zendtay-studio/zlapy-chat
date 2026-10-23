/**
 * Configuración del servidor.
 *
 * Resuelve los valores de configuración desde el entorno con los valores por
 * defecto, valida los rangos permitidos y expone las rutas que usa el
 * servidor (raíz, `public/`, datos y bases SQLite).
 */

const DEFAULTS = Object.freeze({
    PORT: 3000,
    MESSAGE_DIRECT_CHAR_LIMIT: 10_000,
    MESSAGE_GROUP_CHAR_LIMIT: 15_000,
    STORY_TEXT_CHAR_LIMIT: 140,
    PROFILE_DESCRIPTION_CHAR_LIMIT: 140,
    MESSAGE_RATE_LIMIT: 30,
    MESSAGE_RATE_WINDOW_MS: 60_000,
    MAX_AUDIO_DURATION_MS: 60_000,
    MAX_HTTP_BODY_BYTES: 32 * 1024 * 1024,
    MAX_MESSAGE_DATA_CHARS: 24_000_000,
    MAX_GALLERY_ITEMS: 20,
    MAX_GALLERY_ENCODED_CHARS: 24_000_000,
    NOTE_TTL_MS: 24 * 60 * 60 * 1000,
    CHAT_PAGE_CACHE_TTL_MS: 10_000,
    CHAT_PAGE_CACHE_MAX: 20,
    SQLITE_CACHE_SIZE_KB: 64_000,
    SQLITE_BUSY_TIMEOUT_MS: 5_000,
    STORY_TTL_MS: 24 * 60 * 60 * 1000,
    AUTH_SESSION_TTL_MS: 30 * 24 * 60 * 60 * 1000
});

function integerSetting(env, name, min, max) {
    const raw = env[name] === undefined || env[name] === '' ? DEFAULTS[name] : env[name];
    const normalized = String(raw).trim();
    if (!/^\d+$/.test(normalized)) throw new Error(`${name} must be an integer.`);
    const value = Number(normalized);
    if (!Number.isSafeInteger(value) || value < min || value > max)
        throw new Error(`${name} must be between ${min} and ${max}.`);
    return value;
}

function loadConfig(env = process.env) {
    const settings = {
        port: integerSetting(env, 'PORT', 1, 65535),
        directMessageCharacters: integerSetting(env, 'MESSAGE_DIRECT_CHAR_LIMIT', 1, 1_000_000),
        groupMessageCharacters: integerSetting(env, 'MESSAGE_GROUP_CHAR_LIMIT', 1, 1_000_000),
        storyCharacters: integerSetting(env, 'STORY_TEXT_CHAR_LIMIT', 1, 100_000),
        profileDescriptionCharacters: integerSetting(env, 'PROFILE_DESCRIPTION_CHAR_LIMIT', 1, 100_000),
        messagesPerMinute: integerSetting(env, 'MESSAGE_RATE_LIMIT', 1, 1_000_000),
        messageWindowMs: integerSetting(env, 'MESSAGE_RATE_WINDOW_MS', 1, 365 * 24 * 60 * 60 * 1000),
        maxAudioDurationMs: integerSetting(env, 'MAX_AUDIO_DURATION_MS', 1_000, 60 * 60 * 1000),
        maxHttpBodyBytes: integerSetting(env, 'MAX_HTTP_BODY_BYTES', 1_024, 1024 * 1024 * 1024),
        maxMessageDataChars: integerSetting(env, 'MAX_MESSAGE_DATA_CHARS', 1, 1024 * 1024 * 1024),
        maxGalleryItems: integerSetting(env, 'MAX_GALLERY_ITEMS', 2, 100),
        maxGalleryEncodedChars: integerSetting(env, 'MAX_GALLERY_ENCODED_CHARS', 1, 1024 * 1024 * 1024),
        noteTtlMs: integerSetting(env, 'NOTE_TTL_MS', 60_000, 30 * 24 * 60 * 60 * 1000),
        chatPageCacheTtlMs: integerSetting(env, 'CHAT_PAGE_CACHE_TTL_MS', 0, 60 * 60 * 1000),
        chatPageCacheMax: integerSetting(env, 'CHAT_PAGE_CACHE_MAX', 0, 100_000),
        sqliteCacheSizeKb: integerSetting(env, 'SQLITE_CACHE_SIZE_KB', 1_024, 1_048_576),
        sqliteBusyTimeoutMs: integerSetting(env, 'SQLITE_BUSY_TIMEOUT_MS', 0, 60_000),
        storyTtlMs: integerSetting(env, 'STORY_TTL_MS', 60_000, 30 * 24 * 60 * 60 * 1000),
        authSessionTtlMs: integerSetting(env, 'AUTH_SESSION_TTL_MS', 60_000, 365 * 24 * 60 * 60 * 1000),
        dataDir: typeof env.DATA_DIR === 'string' && env.DATA_DIR.trim() ? env.DATA_DIR.trim() : '',
        chatMasterKey: typeof env.CHAT_MASTER_KEY === 'string' ? env.CHAT_MASTER_KEY.trim() : '',
        // Forzar TLS: toda petición en claro se redirige a HTTPS y la cookie
        // de sesión se marca como Secure. Solo se apaga a propósito (FORCE_TLS=false),
        // por ejemplo para un uso exclusivo por HTTP en la red local sin
        // certificados: en ese modo el tráfico (y la cookie) viaja sin cifrar.
        forceTls: booleanSetting(env, 'FORCE_TLS', true),
        // Interfaz de escucha. 'auto' (por defecto) mantiene 0.0.0.0; 'loopback'
        // restringe el servicio a la máquina local (útil tras un proxy inverso).
        bindHost: typeof env.BIND_HOST === 'string' && ['auto', 'loopback', '0.0.0.0'].includes(env.BIND_HOST.trim())
            ? env.BIND_HOST.trim() : 'auto'
    };
    if (settings.maxMessageDataChars > settings.maxHttpBodyBytes)
        throw new Error('MAX_MESSAGE_DATA_CHARS cannot exceed MAX_HTTP_BODY_BYTES.');
    if (settings.maxGalleryEncodedChars > settings.maxHttpBodyBytes)
        throw new Error('MAX_GALLERY_ENCODED_CHARS cannot exceed MAX_HTTP_BODY_BYTES.');
    return Object.freeze(settings);
}

/* Ajustes booleanos: FORCE_TLS=0/false/no/off desactiva. */
function booleanSetting(env, name, fallback) {
    const raw = env[name];
    if (typeof raw !== 'string' || !raw.trim()) return fallback;
    const value = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    return fallback;
}

/* Valores ya resueltos: los usa el servidor y los scripts de operación
 * (`ops/`), que cargan el `.env` con dotenv antes de usarlos. */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* En una instalación nueva el `.env` no existe todavía (no viene en el
 * repositorio). Se crea a partir de `.env.example` con los valores por
 * defecto, de modo que `npm start` funcione sin pasos manuales y el usuario
 * tenga un fichero donde ajustar la configuración. El `.env` puede contener
 * secretos, así que se deja con permisos de solo para el propietario. */
const ENV_PATH = path.join(ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');
function ensureEnvFile() {
    if (fs.existsSync(ENV_PATH)) return false;
    if (!fs.existsSync(ENV_EXAMPLE_PATH)) return false;
    fs.writeFileSync(ENV_PATH, fs.readFileSync(ENV_EXAMPLE_PATH));
    try { fs.chmodSync(ENV_PATH, 0o600); } catch (error) { /* best-effort */ }
    return true;
}
const envCreated = ensureEnvFile();

// Carga el `.env` de la raiz del proyecto: el servidor y los scripts de
// operacion parten de la misma configuracion. Las variables ya presentes en el
// entorno mandan sobre el fichero.
require('dotenv').config({ path: ENV_PATH });
if (envCreated) {
    console.log(`[config] se creó ${path.relative(ROOT, ENV_PATH)} a partir de .env.example (instalación nueva).`);
}

const CONFIG = loadConfig(process.env);
const GIPHY_API_KEY = String(process.env.GIPHY_API_KEY || '').trim();
const PORT = CONFIG.port;
const PUBLIC = path.join(ROOT, 'public');
const DATA = CONFIG.dataDir ? path.resolve(CONFIG.dataDir) : path.join(ROOT, 'data');
const DB_PATH = path.join(DATA, 'zlapy.db');
const BLOB_DB_PATH = path.join(DATA, 'blob.db');

/* Valor EFECTIVO de FORCE_TLS. CONFIG está congelada a propósito (los ajustes
 * no se recalculan en caliente), pero el repliegue sin certificados necesita
 * rebajarlo al arrancar: sin este portador mutable, la asignación lanza
 * TypeError y el servidor muere al arrancar en cualquier instalación nueva
 * sin cert.pem/key.pem (lo cazó el CI porque el checkout no lleva certificados). */
const tlsState = { forceTls: CONFIG.forceTls };

/* Rutas de los certificados TLS (avanzado): por defecto, en la raíz del
 * proyecto. Se pueden apuntar a otro sitio para pruebas o para instalaciones
 * servidas tras un proxy que termina el TLS. */
const TLS_CERT_FILE = typeof process.env.TLS_CERT_FILE === 'string' && process.env.TLS_CERT_FILE.trim()
    ? path.resolve(process.env.TLS_CERT_FILE.trim()) : path.join(ROOT, 'cert.pem');
const TLS_KEY_FILE = typeof process.env.TLS_KEY_FILE === 'string' && process.env.TLS_KEY_FILE.trim()
    ? path.resolve(process.env.TLS_KEY_FILE.trim()) : path.join(ROOT, 'key.pem');

module.exports = {
    DEFAULTS,
    loadConfig,
    ROOT,
    CONFIG,
    tlsState,
    TLS_CERT_FILE,
    TLS_KEY_FILE,
    GIPHY_API_KEY,
    PORT,
    PUBLIC,
    DATA,
    DB_PATH,
    BLOB_DB_PATH
};
