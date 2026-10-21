/**
 * Llave maestra del servidor.
 *
 * Obtiene la llave de 32 bytes que cifra los datos en reposo: la lee de
 * CHAT_MASTER_KEY o del fichero `.zlapymasterkey`, la genera si no existe
 * ninguna y se niega a arrancar si falta la llave de una base con datos.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { BLOB_DB_PATH, CONFIG, DB_PATH, ROOT } = require('../config.js');

// Cifrado en reposo (llave maestra)
const MASTER_KEY_PATH = path.join(ROOT, '.zlapymasterkey');
const getMasterKeyBytes = () => {
    if (CONFIG.chatMasterKey) {
        const key = Buffer.from(CONFIG.chatMasterKey, 'base64');
        if (key.length !== 32) throw new Error('CHAT_MASTER_KEY must encode exactly 32 bytes.');
        return key;
    }
    const keyFileExists = fs.existsSync(MASTER_KEY_PATH);
    // Fail-fast: si ya existe una base de datos con datos y la llave maestra no
    // está disponible, se aborta. Regenerarla en silencio haría irreversibles
    // todos los mensajes, historias y adjuntos cifrados con la llave anterior.
    if (!keyFileExists && (fs.existsSync(DB_PATH) || fs.existsSync(BLOB_DB_PATH)))
        throw new Error(`Falta ${MASTER_KEY_PATH} (o CHAT_MASTER_KEY) y ya existe una base de datos con datos. ` +
            'Restaura la llave maestra desde tu respaldo antes de arrancar: una llave nueva haría ' +
            'ilegibles todos los mensajes, historias y adjuntos cifrados con la anterior.');
    if (keyFileExists) {
        const key = fs.readFileSync(MASTER_KEY_PATH);
        if (key.length !== 32) throw new Error(`${MASTER_KEY_PATH} must contain exactly 32 bytes.`);
        try { fs.chmodSync(MASTER_KEY_PATH, 0o600); } catch { }
        return key;
    }
    const b = crypto.randomBytes(32);
    fs.writeFileSync(MASTER_KEY_PATH, b, { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(MASTER_KEY_PATH, 0o600); } catch { }
    return b;
};

module.exports = {
    getMasterKeyBytes,
};
