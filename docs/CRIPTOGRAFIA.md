# Zlapy — Criptografía

Documento técnico de referencia del sistema criptográfico de Zlapy.

Todo lo que sigue está leído del código de `src/crypto/` y de sus consumidores.
Cuando el código y la especificación de MTProto 2.0 discrepan, **manda el
código**; las discrepancias están recogidas explícitamente en el capítulo
[10. Discrepancias con MTProto 2.0 real](#10-discrepancias-con-mtproto-20-real).

---

## Índice

1. [Visión general](#1-visión-general)
2. [Llave maestra](#2-llave-maestra)
3. [Cifrado en reposo: los tres formatos PCE](#3-cifrado-en-reposo-los-tres-formatos-pce)
4. [Derivación MTProto 2.0 (PCE3)](#4-derivación-mtproto-20-pce3)
5. [Firmas Ed25519](#5-firmas-ed25519)
6. [Rotación y ciclo de vida de las claves](#6-rotación-y-ciclo-de-vida-de-las-claves)
7. [Qué NO es este sistema](#7-qué-no-es-este-sistema)
8. [Migración al esquema en la nube](#8-migración-al-esquema-en-la-nube)
9. [Checklist del threat model](#9-checklist-del-threat-model)
10. [Discrepancias con MTProto 2.0 real](#10-discrepancias-con-mtproto-20-real)
11. [Cifrado del canal de transporte](#11-cifrado-del-canal-de-transporte)
12. [Índice de ficheros y símbolos](#12-índice-de-ficheros-y-símbolos)

---

## 1. Visión general

Zlapy usa un modelo de **cifrado en la nube** (cloud chats) inspirado en
**MTProto 2.0** de Telegram: el servidor **conoce** las claves de cifrado y por
eso puede sincronizar el historial entre dispositivos, indexar, buscar y
reenviar. **No** es cifrado de extremo a extremo (los *chats secretos* de
Telegram quedan fuera de alcance a propósito; véase
`src/crypto/mtproto.js:9-15`).

Hay **dos capas** de cifrado, con **claves distintas**:

```
                     ┌───────────────────────────────────────────┐
   Capa 1            │  LLAVE MAESTRA  (32 bytes, del servidor)   │
   "del servidor"    │  · cifra adjuntos (blob.db)               │
                     │  · cifra el material E2E de los grupos     │
                     │  · cifra la clave VAPID (push)             │
                     │  · cifra la auth_key de cada usuario       │
                     │  · sirve de semilla de firma alternativa   │
                     └───────────────────────────────────────────┘

                     ┌───────────────────────────────────────────┐
   Capa 2            │  auth_key POR USUARIO (2048 bits)          │
   "del usuario"     │  · cifra mensajes      → sobre PCE3         │
                     │  · cifra resúmenes    → sobre PCE3         │
                     │  · cifra notas, perfil, llamadas,         │
                     │    suscripciones push e historias → PCE3   │
                     │  · es la semilla de la firma Ed25519      │
                     └───────────────────────────────────────────┘
```

Y **tres formatos de sobre** conviven en la base:

| Prefijo | Cifrado | Clave | Contexto autenticado | Estado |
| --- | --- | --- | --- | --- |
| `PCE1:` | AES-256-GCM | llave maestra | ninguno | legado, aún se lee |
| `PCE2:` | AES-256-GCM | llave maestra | AAD con id/chat/remitente/destinatario/tipo/grupo | legado, aún se lee |
| `PCE3:` | AES-256-GCM con derivación MTProto 2.0 | `auth_key` del autor | AAD con dominio + contexto del mensaje | **actual** |

Mapa de ficheros:

```
src/crypto/master-key.js     → llave maestra, arranque fail-fast
src/crypto/message-crypto.js → PCE1 / PCE2, firmas Ed25519
src/crypto/mtproto.js        → PCE3: auth_key, msg_key, aes_key/aes_iv, cabecera, relleno
src/crypto/user-auth-keys.js → auth_key por usuario, cifrado/descifrado por usuario, sal
src/crypto/setup.js          → instancia única y re-exportaciones
```

---

## 2. Llave maestra

### 2.1 De dónde sale

`src/crypto/master-key.js:19-43` — función `getMasterKeyBytes()`:

```
  ┌─ CONFIG.chatMasterKey no vacío?  ── sí ──►  base64 → debe decodificar EXACTAMENTE 32 bytes
  │                                                     si no → throw
  ↓ no
  ├─ ¿la base de datos tiene cuentas?  ── sí ──►  THROW  ← fail-fast
  │
  ↓ no (instalación nueva)
  └─ genera 32 bytes aleatorios (crypto.randomBytes, CSPRNG) y los escribe en
     el propio `.env` (línea CHAT_MASTER_KEY=) con escritura atómica
     (temporal 0600 + rename, con verificación post-escritura: si otro
     arrancador compitió y escribió el suyo antes, se ADOPTA la del ganador).
     [`src/crypto/master-key.js`, `ops/generate-master-key.js`]
```

- **Única ubicación de la llave**: `CHAT_MASTER_KEY` en el `.env` (permisos
  `600`, escritura atómica). **No hay fichero aparte** (el viejo
  `.zlapymasterkey` quedó eliminado): un solo lugar del que el respaldo copia la clave.
- **Formato de la variable de entorno**: `CHAT_MASTER_KEY` es **base64** de
  32 bytes (`src/config.js`). El parseo directo del `.env` usa `[ \t]*`
  (nunca `\s*`: en JS ese `\s` cruza saltos de línea).
- `npm run key` mantiene/reescribe la misma línea con las mismas garantías.
- **Rotación con datos** (`npm run key -- --force` sobre una base con
  cuentas): ya no es destructiva. El motor
  [`ops/reencrypt-master.js`](../ops/reencrypt-master.js) verifica que la
  llave del `.env` descifra TODOS los sobres dependientes de la maestra
  (`user_auth_keys.auth_key`, `groups.keys_cipher`, `meta` VAPID y los
  adjuntos de `blob.db`), guarda una copia del `.env` en
  `.env.master-bak` [†], entra la llave nueva y re-cifra cada base en una
  transacción SQLite. Falla el paso cualquiera → reversión compensada con
  los valores originales, estado intacto. Las claves de usuario y el
  contenido de los mensajes NO dependen de la maestra: no se re-cifran y no
  hace falta.
  [†] ventana residual: un SIGKILL/corte de luz A MITAD de los pocos
  milisegundos de trabajo deja un estado mixto; la copia `.env.master-bak`
  permite restaurar el arranque previo (y las bases, del backup).

### 2.2 La regla de arranque abortado

`src/crypto/master-key.js`:

```js
if (baseDeDatosConDatos())
    throw new Error(`No hay CHAT_MASTER_KEY en el .env y la base de datos ya contiene datos. ` +
        'Restaura la llave maestra desde tu respaldo antes de arrancar: una llave nueva haría ' +
        'ilegibles todos los mensajes, historias y adjuntos cifrados con la anterior.');
```

**Por qué**: regenerar la llave en silencio haría **irreversibles** todos los
mensajes, historias y adjuntos cifrados con la llave anterior. Es una decisión
de "fail loud": el operador tiene que restaurar la llave desde `backups/`, no
inventarse una nueva.

Nota: esta comprobación mira `DB_PATH` y `BLOB_DB_PATH` (`src/config.js:88`
para `BLOB_DB_PATH`), es decir, la **existencia de los ficheros**, no si
contienen filas.

Hay un segundo control de arranque, independiente del anterior, en
`server.js:39-46` y `src/db/database.js:51-59`: la base declara en la tabla
`meta` la clave `crypto_version`; si no es `'2'` y hay mensajes o el valor
existe, el proceso aborta con *"Database crypto version is incompatible"*.

### 2.3 Qué cifra y qué no

| Dato | Cifrado con | Dónde |
| --- | --- | --- |
| Adjuntos / medios (`blob.db`) | llave maestra (`PCE1`) | `src/chat/media.js:28` (escribe), `:35` (lee) |
| Material E2E de grupos (`cryptoId` + keyboxes) | llave maestra (`PCE1`) | `src/groups/store.js:112` |
| Clave privada VAPID (push) | llave maestra (`PCE1`) | `src/push/vapid.js:31,34` |
| La propia `auth_key` de cada usuario (en hex) | llave maestra (`PCE1`) | `src/crypto/user-auth-keys.js:54`, `src/users/store.js:206` |
| **Mensajes** | `auth_key` del autor (`PCE3`) | `src/chat/messages.js:52-56` |
| **Resúmenes de chat** | `auth_key` del dueño (`PCE3`) | `src/chat/summaries.js:48` |
| **Notas, perfil (nombre/bio/nota)** | `auth_key` del dueño (`PCE3`) | `src/users/store.js:397-405,445` |
| **Registro de llamadas** | `auth_key` del dueño (`PCE3`) | `src/calls/store.js:28,41` |
| **Suscripciones push** | `auth_key` del usuario (`PCE3`) | `src/push/routes.js:27` |
| **Historias** | `auth_key` del autor (`PCE3`) | `src/stories/routes.js:61,106,121,139` |
| Contraseñas de cuenta | no: hash **scrypt** + salt (N=16384, r=8, p=1) | `src/auth/sessions.js:119-123` (hash), `src/users/store.js:305-307` (columnas) |
| Claves privadas de los grupos (keyboxes) | no: las gestiona el cliente; solo el sobre va cifrado en reposo | `src/groups/store.js:100-116` |

### 2.4 La llave maestra ya no es la clave de firma por defecto

Antiguamente la firma Ed25519 de cada mensaje se derivaba de la llave maestra
(hallazgo `zlapy.masterkey.global-derivation`, ya corregido). Ahora la semilla
**por defecto** es la `auth_key` del propio usuario:

`src/crypto/setup.js:18-27`:

```js
const messageCrypto = createMessageCrypto(masterKey.export(), {
    signingKeyFor: userId => {
        const rec = authKeyRecord(userId);
        return rec ? rec.key : masterKey.export();
    }
});
```

La llave maestra se conserva como **segunda** semilla candidata, para que los
mensajes firmados antes del cambio sigan siendo verificables
(`src/crypto/message-crypto.js:122-138`).

**Consecuencia**: la llave maestra, por sí sola, **no descifra** el contenido de
los mensajes de nadie. Haría falta además la base de datos con las
`auth_key`. Está verificado en `test/mtproto-server.test.js:36-54`.

---

## 3. Cifrado en reposo: los tres formatos PCE

### 3.1 `PCE1:` — AES-256-GCM con la llave maestra, sin contexto

`src/crypto/message-crypto.js:25-31` (cifrado) y `:33-51` (descifrado).

```
Formato:  PCE1:<iv_base64>:<(cifrado || tag)_base64>

  iv         = crypto.randomBytes(12)                       → 12 bytes, 96 bits
  clave      = llave maestra (32 bytes)
  algoritmo  = AES-256-GCM
  tag        = 16 bytes (GCM por defecto), va PEGADO al cifrado
  AAD        = (ninguno)
```

```js
function encryptAtRest(plain) {
    if (typeof plain !== 'string' || plain === '') return plain;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `PCE1:${iv.toString('base64')}:${Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64')}`;
}
```

**Descifrado y tolerancia a legacy** (`message-crypto.js:33-51`):

```js
function decryptAtRest(blob) {
    if (typeof blob !== 'string' || blob === '') return blob;   // vacío → tal cual
    if (!blob.startsWith('PCE1:')) return blob;                 // ← legacy en claro → tal cual
    const parts = blob.split(':');
    if (parts.length !== 3) return blob;                        // malformado → tal cual
    try {
        ...
        if (iv.length !== 12 || combined.length < 16) return null; // ← malformado → null
        ...
    } catch {
        return null;                                            // ← tag incorrecto → null
    }
}
```

Hay que distinguir tres resultados distintos:

| Entrada | Salida | Significado |
| --- | --- | --- |
| No es `PCE1:` (texto plano legacy) | **el mismo texto** | "tolerancia a legacy": se devuelve tal cual |
| `PCE1:` mal formado (partes, IV, longitud) | `null` | sobre corrupto |
| `PCE1:` con tag GCM incorrecto | `null` | **alteración detectada** |

El mismo patrón se aplica a los campos de texto legacy dentro del cuerpo de
un mensaje ya descifrado: `src/shared/message-data.js:9-23`
(`decryptLegacyMessageFields` aplica `decryptAtRest` a `data`, `text`, `name`,
`caption` y al `reply.preview`).

### 3.2 `PCE2:` — AES-256-GCM con la llave maestra **autenticando el contexto**

`src/crypto/message-crypto.js:69-76` (cifrado) y `:78-94` (descifrado).

```
Formato:  PCE2:<iv_base64>:<(cifrado || tag)_base64>

  iv         = crypto.randomBytes(12)
  clave      = llave maestra (32 bytes)
  algoritmo  = AES-256-GCM
  AAD        = utf8(JSON.stringify([
                  "dp/message-aead/v2",
                  { version, id, chat, ts, fromId, toId, kind, cryptoGroupId }
               ]))
```

El contexto (`message-crypto.js:53-67`) es:

```js
function messageContext(row) {
    const context = {
        version: MESSAGE_VERSION,   // = 2  (message-crypto.js:11)
        id: row.id,
        chat: row.chat,
        ts: row.ts,
        fromId: row.from_id,
        toId: row.to_id || '',
        kind: row.kind,
        cryptoGroupId: row.crypto_group_id || ''
    };
    if (Object.values(context).some(value => value === undefined || value === null))
        throw new TypeError('Incomplete message context.');
    return context;
}
```

**Por qué**: GCM autentica (AAD) no solo el texto cifrado sino **también** los
datos asociados. Al meter el contexto del mensaje en el AAD, el texto plano
queda **ligado** a su posición:

```
  ┌──────────────┐   mover la fila a otro chat      ┌──────────────┐
  │ mensaje A    │ ─────────────────────────────►  │ mensaje A    │
  │ chat: u1__u2 │                                  │ chat: u1__u3 │
  └──────────────┘                                  └──────────────┘
        │                                                  │
        │  el AAD se calcula con chat = "chat:u1__u2"     │  el AAD se calcularía con
        ▼                                                  ▼  chat = "chat:u1__u3"
  ┌──────────────┐                                  ┌──────────────┐
  │ tag GCM      │                                  │ tag GCM      │
  │ (sobre AAD-1)│                                  │ (sobre AAD-2)│
  └──────────────┘                                  └──────────────┘
        │                                                  │
        └────────────────►  ✗ no coincide ◄────────────────┘
                        (GCM tag mismatch → null)
```

Es decir: **mover una fila de mensaje a otro chat, cambiar su remitente,
cambiar su destinatario o cambiar su tipo invalida la etiqueta y hace que el
mensaje sea ilegible**. Verificado en `test/message-crypto.test.js:30-37`.

El descifrado (`message-crypto.js:78-94`) es estricto: si el prefijo no es
`PCE1:` ni `PCE2:` lanza `Unsupported message encryption version.`; si el
sobre `PCE2:` está mal formado lanza `Malformed message ciphertext.`; y si el
AAD no coincide, `decipher.final()` lanza → el mensaje se descarta
(`src/chat/messages.js:97-103`).

### 3.3 `PCE3:` — el sobre de la nube (MTProto 2.0)

`src/crypto/mtproto.js:128-154` (cifrado) y `:159-189` (descifrado).

```
Formato:  PCE3:<keyId_hex>:<msgKey_hex>:<iv_base64>:<(cifrado || tag)_base64>

  keyId      = auth_key_id del autor  (16 hex = 8 bytes)
  msgKey     = msg_key del mensaje    (32 hex = 16 bytes)   ← en CLARO
  iv         = aes_iv[0:12]           (12 bytes, base64)
  cifrado    = AES-256-GCM(clave = aes_key, iv, AAD) || tag GCM (16 bytes)
```

El sobre se construye en `mtproto.js:148-153`:

```js
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
return {
    keyId: authKeyId(key),
    msgKey: msgKey.toString('hex'),
    blob: `PCE3:${authKeyId(key)}:${msgKey.toString('hex')}:${iv.toString('base64')}:${ciphertext.toString('base64')}`
};
```

El IV **no es aleatorio**: es la primera mitad (12 bytes) del `aes_iv`
derivado. Los 4 bytes restantes del `aes_iv` (`aes_iv[12:16]`) se usan como
parte del AAD (`mtproto.js:142-145`):

```js
const iv = aesIv.subarray(0, 12);
const aad = Buffer.concat([aesIv.subarray(12), DOMAIN, extraAad || Buffer.alloc(0)]);
const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
cipher.setAAD(aad);
```

con `DOMAIN = Buffer.from('zlapy/mtproto2/v3', 'utf8')` (`mtproto.js:48`) y
`extraAad` = el contexto del mensaje (`src/crypto/user-auth-keys.js:95-102`):

```js
function messageContextBytes(row) {
    return Buffer.from(JSON.stringify({
        domain: 'zlapy/message-context/v3',
        id: row.id, chat: row.chat, ts: row.ts,
        fromId: row.from_id, toId: row.to_id || '', kind: row.kind,
        cryptoGroupId: row.crypto_group_id || ''
    }), 'utf8');
}
```

AAD completo de un mensaje PCE3:

```
  AAD = aes_iv[12:16]  (4 bytes)  ||  "zlapy/mtproto2/v3"  ||  JSON del contexto
```

**Por qué el `msgKey` va en claro**: es exactamente la comprobación de
integridad de MTProto. El receptor **recalcula** el `msg_key` sobre el texto
plano ya descifrado y exige que coincida con el que venía en el sobre
(`mtproto.js:180-181`):

```js
// Comprobacion de MTProto: el msg_key debe coincidir con el recalculado.
if (!computeMsgKey(key, plaintext, 0).equals(msgKey)) return null;
```

Ventajas de tenerlo en claro:

1. **Es la comprobación estructural de MTProto** y hace que el sobre sea
   *auto-descriptivo*: `key_id` dice con qué clave se cifró y `msg_key` dice con
   qué clave de mensaje.
2. **Detecta la substitución de sobre**: si alguien cambia el `msg_key` de un
   sobre por el de otro, la clave derivada cambia y el descifrado falla (o el
   `msg_key` recalculado no coincide). Verificado en
   `test/mtproto.test.js:68-74`.
3. **No filtra nada útil**: con el `msg_key` solo NO se puede derivar el
   `aes_key`; hace falta además la `auth_key` (2048 bits) del autor. Quien
   tenga el `msg_key` y la base, pero no la `auth_key`, no descifra nada.

### 3.4 Descifrado de PCE3: la cadena de comprobaciones

`src/crypto/mtproto.js:159-189`, en orden:

```
  1.  ¿Es un string? ¿tiene 5 partes separadas por ':'? ¿parts[0] === 'PCE3'?   → si no: null
  2.  ¿auth_key mide 256 bytes? ¿msg_key mide 16? ¿iv mide 12?                 → si no: null
  3.  ¿authKeyId(auth_key) === parts[1]?   (la clave corresponde al sobre)     → si no: null
  4.  derivar aes_key / aes_iv a partir de (auth_key, msg_key, x=0)
  5.  AES-256-GCM descifrar con AAD = aes_iv[12:16] || DOMAIN || extraAad
        · si el tag no cuadra → throw → null
  6.  ¿computeMsgKey(auth_key, plaintext) === msg_key?                        → si no: null
  7.  leer la cabecera interna (32 bytes) y comprobar bodyLength
  8.  devolver { body: <cuerpo>, header: {salt, sessionId, msgId, seqNo, bodyLength} }
```

Cualquier fallo devuelve `null` (todo el cuerpo está en un `try/catch`,
`mtproto.js:160-188`). En el servidor, un `null` significa que el mensaje **se
descarta** y no se entrega a ningún cliente
(`src/chat/messages.js:91-95`).

### 3.5 Enrutamiento por versión y coherencia de `crypto_version`

`src/chat/messages.js:73-103`:

```js
const isV3 = typeof row.data === 'string' && row.data.startsWith('PCE3:');
const hasV2Ciphertext = typeof row.data === 'string' && row.data.startsWith('PCE2:');
if (isV3 ? row.crypto_version < 3 : (row.crypto_version >= 2) !== hasV2Ciphertext) {
    console.error(`[crypto] Versión de cifrado inconsistente para el mensaje ${row.id}.`);
    return null;
}
```

Reglas:

| `data` | `crypto_version` | Resultado |
| --- | --- | --- |
| `PCE3:` | ≥ 3 | se descifra con la `auth_key` del autor |
| `PCE3:` | < 3 | **descartado** (inconsistente) |
| `PCE2:` | ≥ 2 | se descifra con la llave maestra + AAD de contexto |
| `PCE1:` | 1 | se descifra con la llave maestra sin contexto |
| `PCE1:` | ≥ 2 | **descartado** (inconsistente) |

La columna `messages.crypto_version` es `INTEGER NOT NULL DEFAULT 2`
(`src/db/schema.js:222`), y los mensajes nuevos se escriben con
`cryptoVersion: 3` (`src/chat/messages.js:57`).

---

## 4. Derivación MTProto 2.0 (PCE3)

Todo lo de este capítulo está en `src/crypto/mtproto.js`.

### 4.1 Constantes

| Constante | Valor | Línea |
| --- | --- | --- |
| `AUTH_KEY_BYTES` | `256` (2048 bits) | `mtproto.js:44` |
| `PADDING_MIN` | `12` | `mtproto.js:45` |
| `PADDING_MAX` | `27` | `mtproto.js:46` |
| `INTERNAL_HEADER_BYTES` | `32` | `mtproto.js:47` |
| `DOMAIN` | `"zlapy/mtproto2/v3"` | `mtproto.js:48` |

### 4.2 La `auth_key` y su `auth_key_id`

```
  auth_key   = crypto.randomBytes(256)          → 2048 bits ALEATORIOS por usuario
  auth_key_id = SHA1(auth_key)[últimos 8 bytes] → 64 bits bajos, en hex (16 caracteres)
```

`mtproto.js:53-61`:

```js
function authKeyId(authKey) {
    const key = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey), 'hex');
    return crypto.createHash('sha1').update(key).digest().subarray(-8).toString('hex');
}

function generateAuthKey() {
    return crypto.randomBytes(AUTH_KEY_BYTES);
}
```

Puntos clave:

- La `auth_key` es **aleatoria**, **no** derivada de la llave maestra. Ésta es
  la diferencia de fondo con el diseño anterior: la llave maestra ya no
  descifra el contenido de nadie por sí sola.
- Se genera **por usuario**, la primera vez que hace falta, en
  `src/crypto/user-auth-keys.js:46-59` (`ensureAuthKey`).
- Se guarda **cifrada con la llave maestra** (PCE1) en la tabla
  `user_auth_keys.auth_key`, en hexadecimal
  (`user-auth-keys.js:54`).
- `keyFingerprint()` (`mtproto.js:193-195`) es exactamente el mismo
  `auth_key_id`, y se publica como `encryptionKeyId` en el perfil
  (`src/profile/routes.js:49`) — la "safety card" de MTProto. El test
  `test/mtproto-server.test.js:56-65` comprueba que el formato es
  `/^[0-9a-f]{16}$/`.

### 4.3 El `msg_key`

`mtproto.js:85-91`:

```js
function computeMsgKey(authKey, plaintextWithPadding, x = 0) {
    const key = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey), 'hex');
    const large = crypto.createHash('sha256')
        .update(Buffer.concat([key.subarray(88 + x, 120 + x), plaintextWithPadding]))
        .digest();
    return large.subarray(8, 24);
}
```

Fórmula, exactamente como la hace el código:

```
  msg_key_large = SHA256( auth_key[88+x .. 120+x]  ||  plaintext_con_relleno )
  msg_key       = msg_key_large[8:24]          ← los 128 bits CENTRALES
```

- `auth_key[88+x .. 120+x]` son **32 bytes** de la `auth_key` (no la clave
  entera).
- Los 128 bits centrales se toman con `.subarray(8, 24)` sobre el digest
  SHA-256 (32 bytes): se descartan los 8 primeros y los 8 últimos.
- `x = 0` es el valor por defecto y **el único que usa el servidor**: tanto
  `encrypt` como `decrypt` llaman con `x = 0` (`mtproto.js:140,141,171,181`).
  En MTProto real `x = 8` se usa en sentido servidor→cliente.

El `plaintext_con_relleno` que se hashea **incluye la cabecera interna de 32
bytes** (véase §4.5), es decir:

```
  msg_key = SHA256( auth_key[88:120] || cabecera_interna(32) || cuerpo || relleno )[8:24]
```

Esto difiere del texto literal de la especificación (que hashea
`substr(auth_key,88+x,32) + plaintext + random_padding`, donde `plaintext` es
el cuerpo). Véase [§10](#10-discrepancias-con-mtproto-20-real), **D-2**.

### 4.4 Derivación de `aes_key` y `aes_iv`

`mtproto.js:71-82`:

```js
function deriveKeys(authKey, msgKey, x = 0) {
    const key = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey), 'hex');
    const mk = Buffer.isBuffer(msgKey) ? msgKey : Buffer.from(String(msgKey), 'hex');
    if (key.length !== AUTH_KEY_BYTES) throw new Error('auth_key invalida.');
    if (mk.length !== 16) throw new Error('msg_key invalida.');
    const sha256a = crypto.createHash('sha256').update(Buffer.concat([mk, key.subarray(x, x + 36)])).digest();
    const sha256b = crypto.createHash('sha256').update(Buffer.concat([key.subarray(40 + x, 76 + x), mk])).digest();
    return {
        aesKey: Buffer.concat([sha256a.subarray(0, 8), sha256b.subarray(8, 24), sha256a.subarray(24, 32)]),
        aesIv: Buffer.concat([sha256b.subarray(0, 8), sha256a.subarray(8, 24), sha256b.subarray(24, 32)])
    };
}
```

```
  sha256_a = SHA256( msg_key || auth_key[x .. x+36] )
  sha256_b = SHA256( auth_key[40+x .. 76+x] || msg_key )

  aes_key = sha256_a[0:8]    (8 bytes)
          || sha256_b[8:24]  (16 bytes)
          || sha256_a[24:32] (8 bytes)      = 32 bytes

  aes_iv  = sha256_b[0:8]    (8 bytes)
          || sha256_a[8:24]  (16 bytes)
          || sha256_b[24:32] (8 bytes)      = 32 bytes
```

Esto es **idéntico** a la fórmula de MTProto 2.0. El test
`test/mtproto.test.js:36-51` lo verifica byte a byte contra una
reimplementación independiente.

El `aes_iv` completo son 32 bytes, pero **sólo se usan 16**:

```
  aes_iv (32 bytes)  ┌────────────────┬────────────────┐
                     │  [0:12] → IV   │  [12:16] → AAD │
                     └────────────────┴────────────────┘
                     (GCM IV)         (4 bytes al AAD)
```

Los 16 bytes restantes (`aes_iv[16:32]`) **no se usan**: no van al IV ni al
AAD. Es una diferencia menor respecto a MTProto, donde el IV completo se usa
en el modo IGE.

### 4.5 Cabecera interna

`mtproto.js:102-124`:

```
  offset  bytes  campo
  ─────────────────────────────────────────
  0       8      salt        (u64 LE)
  8       8      session_id  (u64 LE)
  16      8      msg_id      (u64 LE)
  24      4      seq_no      (u32 LE)
  28      4      message_length (u32 LE)
  ─────────────────────────────────────────
  total   32 bytes
```

```js
function buildInternalHeader({ salt, sessionId, msgId, seqNo, bodyLength }) {
    const header = Buffer.alloc(INTERNAL_HEADER_BYTES);
    const u64 = value => {
        try { return BigInt.asUintN(64, BigInt(value)); }
        catch { return 0n; }
    };
    header.writeBigUInt64LE(u64(salt), 0);
    header.writeBigUInt64LE(u64(sessionId), 8);
    header.writeBigUInt64LE(u64(msgId), 16);
    header.writeUInt32LE(seqNo >>> 0, 24);
    header.writeUInt32LE(bodyLength >>> 0, 28);
    return header;
}
```

**Posición**: la cabecera va **encima** del cuerpo, al principio del texto
plano (`mtproto.js:139`):

```js
const plaintext = Buffer.concat([header, payload, padding]);
```

Por tanto, dentro del cifrado, el orden es:

```
  ┌───────────────┬───────────────┬───────────────┐
  │ cabecera (32) │ cuerpo (N)    │ relleno (12-27)│
  └───────────────┴───────────────┴───────────────┘
  ▲
  └── el msg_key se calcula sobre TODO este bloque (cabecera incluida)
```

`seq_no` se escribe siempre como `0` en el servidor (`mtproto.js:136` y
`src/chat/messages.js:53`, `src/crypto/user-auth-keys.js:76`): el control de
secuencia de MTProto no se usa, porque cada mensaje va cifrado por separado
con su propia clave.

### 4.6 Relleno aleatorio

`mtproto.js:94-99`:

```js
function buildPadding(bodyLength) {
    const base = INTERNAL_HEADER_BYTES + bodyLength;
    let size = PADDING_MIN + ((16 - ((base + PADDING_MIN) % 16)) % 16);
    if (size > PADDING_MAX) size = PADDING_MAX;
    return crypto.randomBytes(size);
}
```

Propiedades:

- Longitud entre **12 y 27 bytes** (inclusivos).
- `INTERNAL_HEADER_BYTES + bodyLength + padding.length` es **múltiplo de 16**
  (salvo cuando el recorte a `PADDING_MAX` rompe la alineación: con
  `PADDING_MAX = 27` y cabecera de 32 bytes, el máximo alcanzable es 27; el
  test `test/mtproto.test.js:83-93` comprueba la alineación para longitudes
  de cuerpo de 1, 15, 16, 100 y 1000 bytes).
- Los bytes son **aleatorios** (`crypto.randomBytes`), no un patrón fijo.
- El relleno **entra en el cálculo del `msg_key`**, igual que en MTProto.

MTProto real exige un relleno de **12 a 1024 bytes**; Zlapy usa un
subconjunto 12..27 para "que mantenga el total en 16" (comentario en
`mtproto.js:45-46`). Véase [§10](#10-discrepancias-con-mtproto-20-real), **D-3**.

### 4.7 El `msg_id` monotónico

`mtproto.js:199-203`:

```js
function nextMsgId(lastMsgId, now = Date.now()) {
    const base = BigInt(Math.floor(now / 1000)) << 32n;
    const last = BigInt(lastMsgId || 0);
    return (base > last ? base : last + 1n).toString();
}
```

```
  msg_id = max( unix_time_segundos << 32 , último_msg_id + 1 )
```

Es el mismo esquema de MTProto: los 32 bits altos son el tiempo Unix en
segundos y los 32 bits bajos son un contador. Se guarda como **texto**
(`user_auth_keys.last_msg_id` es `TEXT`, `src/db/schema.js:252`) porque no
cabe en un entero de 64 bits con signo de SQLite.

El `msg_id` se actualiza en la base en cada cifrado
(`src/crypto/user-auth-keys.js:75`, `src/chat/messages.js:50`) para que la
monotonía sobreviva a un reinicio del servidor.

### 4.8 La ventana anti-repetición

`mtproto.js:207-213`:

```js
function msgIdAcceptable(msgId, now = Date.now()) {
    const value = Number(msgId);
    if (!Number.isFinite(value) || value <= 0) return false;
    const seconds = value / 4294967296;
    const delta = now / 1000 - seconds;
    return delta <= 300 && delta >= -30;
}
```

```
  segundos_del_msg_id = msg_id / 2^32
  delta = ahora - segundos_del_msg_id

  se acepta  ⟺  -30 s ≤ delta ≤ 300 s
                 ▲            ▲
                 │            └─ 300 s hacia ATRÁS (tolerancia)
                 └─ 30 s hacia DELANTE (tolerancia)
```

Es la ventana de MTProto 2.0. Test en `test/mtproto.test.js:116-122`.

> **Nota de estado**: `msgIdAcceptable()` está exportada y cubierta por tests,
> pero **no la invoca ningún módulo de `src/`** (búsqueda exhaustiva: sólo
> `src/crypto/mtproto.js` y `test/mtproto.test.js`). Es decir, la comprobación
> **no se aplica en tiempo de ejecución**: el servidor no rechaza por sí mismo
> un `msg_id` fuera de ventana. La protección real en contra de repeticiones es
> el AES-GCM con clave por mensaje (un mismo mensaje reenviado se descifra
> igual, porque la clave es determinista para ese `msg_key`).

### 4.9 Desviación deliberada: AES-IGE → AES-GCM

`src/crypto/mtproto.js:34-39` lo dice explícitamente:

```
 * DESVIACION DOCUMENTADA (y por que)
 *   MTProto cifra con AES-256 en modo IGE, que NO tiene etiqueta de
 *   autenticacion: un atacante que modifique el cifrado no lo detecta (solo
 *   hay un CRC interno). Aqui se usa la MISMA derivacion de claves de
 *   MTProto pero con AES-256-GCM, que si es autenticada. Es estrictamente mas
 *   fuerte y no cambia el modelo (la clave sigue siendo por mensaje).
```

| | MTProto 2.0 real | Zlapy |
| --- | --- | --- |
| Modo | AES-256-**IGE** | AES-256-**GCM** |
| Autenticación | ninguna (sólo CRC interno) | **etiqueta de 16 bytes** + AAD |
| Alteración del cifrado | **indetectable** (salvo colisiones de CRC) | **rechazada** |
| Alteración de la cabecera | no detectada | detectada (va dentro del AAD y del texto cifrado) |
| Clave por mensaje | sí | sí (igual) |
| Interoperabilidad | — | **no**: un sobre Zlapy no lo entiende un cliente MTProto |

**Consecuencia práctica**: el modelo de claves es el de MTProto (clave de
mensaje derivada, `msg_key` central, cabecera interna), pero el sobre tiene
**una propiedad que MTProto no tiene**: es *authenticated*. Un atacante con
acceso de escritura a la base no puede alterar un mensaje (cambiar su texto,
su chat, su autor o su cabecera) sin que el descifrado falle y el mensaje sea
descartado (`src/chat/messages.js:91-95`). Es **estrictamente más fuerte**
que el esquema original.

El coste: un sobre de Zlapy **no es interoperable** con MTProto 2.0 real
(ni con Telegram ni con otro cliente MTProto).

### 4.10 Diagrama completo de una escritura PCE3

```
  emisor (usuario U)
  ─────────────────────────────────────────────────────────────────
  1.  rec = authKeyRecord(U)                  [user-auth-keys.js:28]
      └─ descifra PCE1 con la llave maestra → auth_key (256 bytes)

  2.  rotateSaltIfNeeded(U, rec)              [user-auth-keys.js:61]
      └─ si han pasado 30 min → sal nueva

  3.  msg_id = nextMsgId(rec.lastMsgId)       [mtproto.js:199]
      └─ persistir en user_auth_keys.last_msg_id

  4.  header = cabecera_interna(sal, session, msg_id, seq_no=0, len)
                                                [mtproto.js:102]
  5.  padding = randomBytes(12..27)           [mtproto.js:94]
  6.  plaintext = header || cuerpo || padding  [mtproto.js:139]
  7.  msg_key = SHA256(auth_key[88:120] || plaintext)[8:24]
                                                [mtproto.js:85]
  8.  {aes_key, aes_iv} = deriveKeys(auth_key, msg_key, x=0)
                                                [mtproto.js:71]
  9.  iv = aes_iv[0:12]
      aad = aes_iv[12:16] || "zlapy/mtproto2/v3" || contexto
                                                [mtproto.js:145]
 10.  cifrado = AES-256-GCM(aes_key, iv, aad, plaintext) || tag
                                                [mtproto.js:146-148]
 11.  blob = "PCE3:" + keyId + ":" + msgKey + ":" + iv + ":" + cifrado
                                                [mtproto.js:152]
```

---

## 5. Firmas Ed25519

### 5.1 Derivación de la semilla

`src/crypto/message-crypto.js:102-121`:

```js
const deriveKeyPair = (base, userId) => {
    const seed = Buffer.from(crypto.hkdfSync(
        'sha256',
        base,                              // ikm  = auth_key del usuario (o llave maestra)
        Buffer.from(userId, 'utf8'),       // salt = id del usuario
        Buffer.from(SIGNATURE_DOMAIN, 'utf8'), // info = dominio
        32                                  // longitud de la salida
    ));
    const privateKey = crypto.createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
        format: 'der',
        type: 'pkcs8'
    });
    const publicKey = crypto.createPublicKey(privateKey);
    return {
        privateKey,
        publicKey,
        publicKeyDer: publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    };
};
```

```
  semilla_ed25519 = HKDF-SHA256(
        ikm  = auth_key del usuario   (256 bytes)   ← o la llave maestra como fallback
        salt = utf8(userId)
        info = "dp/message-signature/ed25519/v2"
        L    = 32
  )

  clave_privada = Ed25519(PKCS8_prefix || semilla)
  clave_publica = SPKI DER → base64      ← esto es lo que se guarda en la base
```

- `SIGNATURE_DOMAIN = 'dp/message-signature/ed25519/v2'` (`message-crypto.js:13`).
- `ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')`
  (`message-crypto.js:14`) — el prefijo DER de un PKCS#8 de Ed25519 con la
  semilla de 32 bytes dentro.
- El par es **determinista**: la misma `auth_key` + el mismo `userId` producen
  siempre la misma clave, así que se **cachea** en memoria (`keyPairCache`,
  máx. 500 entradas, `message-crypto.js:100-101,134-137`). El comentario
  explica el motivo: HKDF + import de clave costaban ~0,1-0,2 ms por mensaje y
  hasta 200 verificaciones por página leída.

### 5.2 Dos semillas candidatas

`src/crypto/message-crypto.js:122-141`:

```js
function keyPairsForUser(userId) {
    ...
    const pairs = [];
    const base = signingKeyFor ? signingKeyFor(userId) : null;
    if (base && Buffer.isBuffer(base) && base.length >= 16) pairs.push(deriveKeyPair(base, userId));
    pairs.push(deriveKeyPair(masterKey, userId));
    ...
}
```

La lista de pares es:

1. **El par derivado de la `auth_key` del usuario** (si existe).
2. **El par derivado de la llave maestra** (siempre, como compatibilidad con
   los mensajes firmados antes del cambio de esquema).

`keyPairForUser()` devuelve el **primero** (índice 0): es el que se usa para
firmar. `verifyMessage()` prueba **ambos**.

### 5.3 Qué se firma

`src/crypto/message-crypto.js:143-164`:

```js
function messageSignaturePayload(message, row) {
    const context = messageContext(row);
    return JSON.stringify({
        domain: SIGNATURE_DOMAIN,
        context,
        message: {
            name: message.name || '',
            mime: message.mime || '',
            caption: message.caption || '',
            data: message.data || '',
            hash: message.hash || '',
            once: !!message.once,
            edited: !!message.edited,
            gallery: Array.isArray(message.gallery) ? message.gallery : [],
            reply: message.reply || null,
            enc: message.enc || '',
            mentions: Array.isArray(message.mentions) ? message.mentions : [],
            mentionLabels: message.mentionLabels || {},
            invite: message.invite || null
        }
    });
}
```

```
  payload_firmado = JSON.stringify({
      domain:   "dp/message-signature/ed25519/v2",
      context:  { version, id, chat, ts, fromId, toId, kind, cryptoGroupId },
      message:  { name, mime, caption, data, hash, once, edited,
                  gallery, reply, enc, mentions, mentionLabels, invite }
  })
```

La firma cubre **el texto plano del mensaje y su contexto**, **no** el
cifrado. Es decir, la firma es un control **independiente** del AEAD: el GCM
protege el sobre, la Ed25519 protege la integridad semántica (contenido +
contexto) y su procedencia.

Firma (`message-crypto.js:166-177`):

```js
const signature = crypto.sign(null, Buffer.from(messageSignaturePayload(message, row), 'utf8'), pair.privateKey);
return {
    signature: signature.toString('base64'),
    signingPublicKey: pair.publicKeyDer
};
```

`crypto.sign(null, ...)` con una clave Ed25519 usa el algoritmo puro Ed25519
(la firma es de 64 bytes) y no Ed25519ph ni ECDSA.

### 5.4 Qué se guarda

Columnas en `messages` (`src/db/schema.js:222-225`):

| Columna | Contenido |
| --- | --- |
| `signature` | firma Ed25519 en base64 (64 bytes crudos) |
| `signing_public_key` | clave pública SPKI DER en base64 (~44 bytes) |
| `crypto_version` | 3 en los mensajes actuales |

### 5.5 Qué se verifica al leer

`src/chat/messages.js:120-128`:

```js
if (row.crypto_version >= 2) {
    message.signatureValid = messageCrypto.verifyMessage(
        message, row, message.signature, message.signingPublicKey
    );
    if (!message.signatureValid) {
        console.error(`[crypto] Firma inválida para el mensaje ${row.id}.`);
        return null;
    }
}
```

`verifyMessage` (`message-crypto.js:183-197`) recorre los pares candidatos y,
para cada uno, exige **las dos** cosas:

1. `signingPublicKey === pair.publicKeyDer` (la clave pública almacenada tiene
   que ser exactamente la del par derivado), y
2. `crypto.verify(null, payload, pair.publicKey, signature)` devuelve `true`.

Si la firma no valida, el mensaje **se descarta** y no llega a ningún cliente.

> Nota: la verificación es *fail-closed* pero **no** distingue "alterado" de
> "firmado con una semilla antigua": ambos casos son `signatureValid = false`.
> Es el motivo por el que la regeneración de clave re-firma todo el contenido
> (§6.3).

### 5.6 El límite de la firma

```
  ✔ Detecta:  alteración del contenido o del contexto en la BASE
  ✔ Detecta:  mensaje movido de chat, de autor o de tipo
  ✘ NO prueba:  autoría frente a un servidor comprometido
```

**Por qué no prueba autoría**: el servidor conoce la `auth_key` de cada
usuario (es lo que permite sincronizar el historial) y por tanto puede
**derivar la semilla y firmar como ese usuario**. La firma Ed25519 demuestra
que *alguien con la clave del usuario* firmó el mensaje; no demuestra que
*el usuario* lo firmó.

Lo que sí aporta valor real:

- Detecta alterations hechas **sin** acceso a la clave del usuario (por
  ejemplo, un atacante con acceso de solo-lectura a `zlapy.db`, una
  corrupción de disco, un bug de restauración, o un operador con la base pero
  sin las claves).
- Es la primera barrera para el caso "copia de la base por otro motivo".

Contra un atacante con acceso al proceso del servidor (y por tanto a las
`auth_key` en memoria), la firma **no aporta** nada: puede firmar como
cualquiera. La única defensa en ese escenario sería el cifrado de extremo a
extremo, que Zlapy no implementa (§7).

---

## 6. Rotación y ciclo de vida de las claves

### 6.1 La sal

- Se genera como entero aleatorio de 64 bits enmascarado:
  `randomUint64()` (`src/crypto/user-auth-keys.js:24`):
  ```js
  const randomUint64 = () => Number(crypto.randomBytes(8).readBigUInt64LE(0) & 0x7fffffffffffffffn);
  ```
  (63 bits útiles: se limpia el bit alto para que quepa en el `INTEGER` de
  SQLite.)
- La `session_id` se genera con la misma función y **no rota nunca**.
- Ambas se guardan en `user_auth_keys.salt` y `user_auth_keys.session_id`
  (`src/db/schema.js:250-251`).

### 6.2 `rotateSaltIfNeeded`

`src/crypto/user-auth-keys.js:61-67`:

```js
const SALT_ROTATION_MS = 30 * 60 * 1000;   // MTProto: la sal se rota cada 30 minutos

function rotateSaltIfNeeded(userId, rec) {
    if (Date.now() - (rec.saltAt || 0) < SALT_ROTATION_MS) return rec;
    rec.salt = randomUint64();
    rec.saltAt = Date.now();
    try { Stmt.updateAuthKeySalt.run(rec.salt, Date.now(), userId); } catch { }
    return rec;
}
```

Se invoca justo antes de cada cifrado:
- `src/crypto/user-auth-keys.js:72` (`encryptForUser`)
- `src/chat/messages.js:47` (`prepareStoredMessage`)

**Detalles honestos del comportamiento real**:

1. **La rotación de sal no tiene efecto criptográfico en Zlapy.** La sal sólo
   viaja dentro de la cabecera interna, y la cabecera **no** entra en la
   derivación de `aes_key`/`aes_iv` (la derivación usa `auth_key` y `msg_key`,
   `mtproto.js:71-82`). MTProto usa la sal para thwarting ataques de
   reúso de claves; aquí la rotación es **metadata de compatibilidad**, no un
   control de seguridad activo.
2. **Rotar la sal no invalida nada**: cada mensaje guarda su sal en su
   cabecera cifrada, así que los mensajes antiguos se descifran igual.
3. **El temporizador se reinicia al cargar la clave en RAM**: `authKeyRecord`
   hace `saltAt: Date.now()` (`user-auth-keys.js:38`), no lee el `updated_at`
   de la base. Tras un reinicio del servidor, la sal no rota hasta que pasen
   30 min **desde el arranque**.
4. **El `UPDATE` a la base va envuelto en `try/catch`**: si falla, la sal en
   memoria cambia pero la de disco no; al recargar, la sal vuelve a la
   antigua. No es un fallo de seguridad, pero sí una discrepancia entre RAM
   y disco.

### 6.3 Regeneración de clave: `POST /account/regenerate-key`

Ruta: `src/http/router.js:260` → `src/profile/routes.js:187-194` →
`src/users/store.js:194-297`.

```
  POST /account/regenerate-key   (con sesión iniciada)
  │
  ├─ 1. oldRec = authKeyRecord(userId)          [store.js:195]
  ├─ 2. newKey  = mtproto.generateAuthKey()      (2048 bits nuevas)
  ├─ 3. newKeyId = mtproto.authKeyId(newKey)
  ├─ 4. sal y sessionId nuevas
  │
  ├─ 5. INSTALAR la clave nueva ANTES de re-cifrar        [store.js:206-208]
  │      Stmt.replaceAuthKey.run(...)
  │      authKeys.authKeyCache.delete(userId)
  │      messageCrypto.forgetSigningKey(userId)
  │      → motivo (comentario en store.js:203-205): si se re-cifrara antes,
  │        las firmas quedarían hechas con la clave vieja y dejarían de validar
  │
  ├─ 6. Re-cifrar TODOS los mensajes del usuario            [store.js:219-247]
  │      · si el mensaje era PCE3 → se descifra con oldRec.key
  │      · si era PCE2/PCE1 → se descifra con la llave maestra (decryptMessage)
  │      · se vuelve a firmar y cifrar con prepareStoredMessage (cryptoVersion 3)
  │
  ├─ 7. Re-cifrar el resto de contenido del usuario          [store.js:250-294]
  │      summaries, group_summaries, user_notes, user_profiles,
  │      calls, push_subs, stories
  │      (con encryptWithNew → mtproto.encrypt(newKey, ..., {salt, sessionId, msgId, seqNo:0}))
  │
  └─ 8. Devuelve { keyId, reencrypted }   [store.js:296]
```

**Diferencia con MTProto real**: en MTProto, regenerar la `auth_key` hace que
el servidor **olvide** la clave anterior y los mensajes antiguos dejan de ser
descifrables por el servidor (sólo queda la copia del otro extremo). En Zlapy
el contenido del usuario **se re-cifra** con la clave nueva, de modo que **no
se pierde el historial** (`src/users/store.js:188-193`, test
`test/mtproto-server.test.js:67-97`).

**Qué pasa con los datos cifrados con la llave anterior**:

| Tipo de dato | Efecto |
| --- | --- |
| Mensajes del usuario | **re-cifrados** con la clave nueva (`crypto_version` = 3) |
| Resúmenes, notas, perfil, llamadas, push, historias | **re-cifrados** con la clave nueva |
| `auth_key` antigua | **sobrescrita** en `user_auth_keys` (`replaceAuthKey`), la vieja desaparece |
| Contenido de **otros** usuarios | intacto (cada uno tiene su propia clave) |
| Adjuntos (`blob.db`) | **intactos**: se cifran con la llave maestra, no con la `auth_key` |

> **Aviso**: `encryptWithNew` (`store.js:210-214`) cifra los elementos que no
> son mensajes **sin** el `extraAad` de contexto (no es un mensaje, no hay fila
> a la que atar el contexto). Eso está bien: el contexto ataría el sobre a
> campos que no existen en esas tablas.

### 6.4 Tabla `user_auth_keys`

`src/db/schema.js:246-255`:

```
  ┌────────────────────────────────────────────────────────────────┐
  │ user_auth_keys                                                   │
  ├──────────────┬─────────────┬───────────────────────────────────┤
  │ user_id (PK) │ auth_key    │ PCE1 con la llave maestra (hex)    │
  │ key_id       │ hex, 16 car.│ = los 64 bits bajos del SHA-1      │
  │ salt         │ INTEGER     │ rotada cada 30 min                 │
  │ session_id   │ INTEGER     │ fija por clave                     │
  │ last_msg_id  │ TEXT        │ msg_id monotónico                   │
  │ created_at   │ INTEGER     │                                     │
  │ updated_at   │ INTEGER     │                                     │
  └──────────────┴─────────────┴───────────────────────────────────┘
```

La `auth_key` está cifrada en reposo: un atacante con el fichero de la base
(sin la llave maestra) no obtiene las claves de cifrado de los usuarios. A la
inversa, quien tenga la llave maestra **y** la base sí (es el escenario del
servidor).

---

## 7. Qué NO es

### 7.1 No hay cifrado de extremo a extremo

- El servidor **conoce** la `auth_key` de cada usuario: es lo que le permite
  descifrar, indexar, buscar y sincronizar el historial entre dispositivos.
  Está escrito en `src/crypto/mtproto.js:9-15` y en `src/chat/messages.js:1-7`.
- No hay implementacion de los *chats secretos* de Telegram: los chats
  normales de Zlapy son chats **en la nube**.
- El material E2E de los **grupos** (`cryptoId` + keyboxes,
  `src/groups/store.js:100-116`) lo gestiona el cliente, pero **el servidor
  guarda ese material cifrado en reposo** con la llave maestra y lo sirve.
  El marcador `enc: 'e2' | 'g2'` (`src/chat/routes.js:174`,
  `src/http/router.js:417`) indica que el **cliente** afirma haber cifrado el
  contenido de extremo a extremo; el servidor lo transporta sin poder
  descifrarlo.
- Las **contraseñas** de cuenta se guardan como hash + salt, no como
  cifrado reversible; eso no es E2E, es hashed.

### 7.2 El servidor puede descifrar

Dado el proceso del servidor, un atacante con:

- la `auth_key` en memoria o en la base (esta última, cifrada con la llave
  maestra) **y**
- la llave maestra (`CHAT_MASTER_KEY` del `.env`)

…descifra **todos** los mensajes, resúmenes, notas, perfiles, llamadas,
historias y suscripciones push. Y con la llave maestra sola también puede
descifrar los **adjuntos**, el **material E2E de los grupos** y la **clave
VAPID**.

### 7.3 Las llamadas

Las llamadas son **P2P** con **DTLS-SRTP** de WebRTC, en el momento y **sin
guardarse** (`src/crypto/mtproto.js:13-15`). El servidor sólo guarda el
**registro** de llamadas (quién llamó a quién, cuándo, duración) y ese
registro **sí** va cifrado en reposo con la `auth_key` del usuario
(`src/calls/store.js:28,41`).

### 7.4 Lo que tampoco protege el esquema

- **Confidencialidad frente al servidor**: ninguna.
- **Integridad frente al servidor**: la detecta si se altera *después* de
  escribir (el GCM y la firma fallan), pero un servidor comprometido puede
  alterar y volver a escribir coherentemente.
- **Metadatos**: el servidor ve quién habla con quién, cuándo, con qué
  frecuencia y con qué tamaño. Los sobres no esconden esa información.

---

## 8. Migración al esquema en la nube

Script: `ops/migrate-to-mtproto.js`.

### 8.1 Uso

```
  node ops/migrate-to-mtproto.js            # SIMULACIÓN: no escribe nada
  node ops/migrate-to-mtproto.js --apply    # migra de verdad
```

- El flag se lee en `migrate-to-mtproto.js:45`: `const APPLY = process.argv.includes('--apply');`
- Recomendación del propio script: **parar el servidor** (o el supervisor)
  antes de migrar (`migrate-to-mtproto.js:21-22`).

### 8.2 Flujo

```
  1. ¿--apply?  → sí: backup() antes de nada        [migrate-to-mtproto.js:60-77,217-223]
       · backups/pre-mtproto-<timestamp>/   (modo 0700)
       · db.backup() de zlapy.db  y  de blob.db  (copia consistente, sin WAL suelto)
       · chmod 0600 de los ficheros copiados

  2. Cargar la llave maestra (misma lógica que el servidor)  [:47-58]
       · CHAT_MASTER_KEY (base64) del .env
       · si falta → throw: "sin la llave maestra no se puede leer el contenido antiguo"

  3. Crear messageCrypto y userAuthKeys con la MISMA implementación
     que el servidor                                        [:85-103]
       · createMessageCrypto(masterKey)                     (sin signingKeyFor:
         la firma se rehace con la auth_key, no con la maestra)
       · createUserAuthKeys({ db, Stmt, encryptAtRest, decryptAtRest })

  4. MENSAJES: PCE2 → PCE3                                [:111-144]
       SELECT ... FROM messages WHERE crypto_version < 3
       por cada fila:
         · plain = messageCrypto.decryptMessage(row.data, row)   → si falla, omitidos++
         · body  = JSON.parse(plain)                            → si falla, omitidos++
         · rec   = ensureAuthKey(row.from_id)          (crea la auth_key si no existe)
         · msgId = mtproto.nextMsgId(rec.lastMsgId)
         · encrypted = mtproto.encrypt(rec.key, JSON.stringify(body),
                        { salt, sessionId, msgId, seqNo: 0 }, messageContextBytes(row))
         · VERIFICACIÓN DE IDA Y VUELTA:                     [:134-136]
               check = mtproto.decrypt(rec.key, encrypted.blob, messageContextBytes(row))
               if (!check || check.body.toString('utf8') !== plain) → omitidos++ (NO se escribe)
         · si APPLY: UPDATE messages SET ... crypto_version = 3, data = encrypted.blob

  5. RESTO DE CONTENIDO (sólo si APPLY)                     [:146-200]
       · selector: necesitaAuthKey(v) = es string no vacío y NO empieza por 'PCE3:'
       · summaries, group_summaries, user_notes, user_profiles,
         calls, push_subs, stories  →  decryptForUser() → encryptForUser()

  6. Informe por pantalla                                [:202-214]
       · mensajes / resúmenes / notas / perfiles / llamadas / push / historias
       · omitidos (ilegibles)
       · mensajes que quedan en el esquema viejo
```

### 8.3 Simulación por defecto

Sin `--apply`:
- Se recorre todo el histórico y se **cuenta**, pero **no se escribe nada**
  (las escrituras están dentro de `if (APPLY)`, `:137` y `:147`).
- La **verificación de ida y vuelta sí se hace igual** (`:135`), porque es
  lectura pura: sirve para saber de antemano cuántos registros son
  irrecuperables.
- El mensaje final es `SIMULACION (no se escribio nada)` + la instrucción de
  cómo migrar de verdad (`:205,214`).

### 8.4 Idempotencia

- Los mensajes se seleccionan con `WHERE crypto_version < 3` (`:114`), así que
  uno ya migrado no vuelve a tocarse.
- El resto del contenido se filtra con `necesitaAuthKey()` (`:109`), que
  descarta lo que ya empieza por `PCE3:`.
- Repetir el script es seguro; el propio script lo dice (`:24,213`).

### 8.5 Verificación de ida y vuelta

Antes de escribir **cada** mensaje, el script descifra lo que acaba de cifrar y
compara con el texto plano original (`:134-136`):

```js
const check = mtproto.decrypt(rec.key, encrypted.blob, messageContextBytes(row));
if (!check || check.body.toString('utf8') !== plain) { resumen.omitidos++; continue; }
```

Si la comprobación falla, el registro **no se escribe**: se cuenta como
`omitidos` y el histórico queda intacto para ese registro.

### 8.6 ¿Por qué el servidor NO migra al arrancar?

Porque **no hace falta**. El servidor **lee los dos formatos y escribe siempre
el nuevo**:

- Al leer: `rowToMessage` (`src/chat/messages.js:73-130`) detecta el formato
  por el prefijo y descifra en consecuencia; los mensajes PCE2 siguen
  leyéndose perfectamente.
- Al escribir: todo mensaje nuevo se cifra en PCE3 (`prepareStoredMessage`,
  `src/chat/messages.js:47-61`).

Consecuencia: **el contenido viejo se va re-cifrando solo** a medida que se
reescribe (un mensaje editado, una/poll vote, un mensaje nuevo). El script sólo
sirve para convertir el histórico **de golpe** (`migrate-to-mtproto.js:11-15`):

```
 * Que NO hace
 *   El servidor NO migra al arrancar: lee los dos formatos y escribe siempre el
 *   nuevo. Si borras este fichero, el servidor sigue funcionando igual (el
 *   contenido viejo se sigue leyendo y se va re-cifrando solo a medida que se
 *   reescribe).
```

El propio test lo comprueba: *"el servidor NO necesita el script (el script es
eliminable sin romper nada)"* (`test/migrate-to-mtproto.test.js:1-4`).

Motivos operativos de que sea manual:

1. **Coste y disponibilidad**: reescribir todo el histórico es una operación
   larga; hacerla en el arranque retrasaría el servicio.
2. **Reversibilidad**: el script hace un respaldo previo (`backups/`), lo que
   da un punto de vuelta. Una migración automática en el arranque no tendría
   ese punto.
3. **Auditoría**: el operador ve un informe de cuántos registros son
   irrecuperables *antes* de tocar nada.

---

## 9. Checklist del threat model

### 9.1 Qué protege cada mecanismo

| Mecanismo | Amenaza que cubre | Dónde |
| --- | --- | --- |
| **AES-256-GCM con clave por mensaje (PCE3)** | Alteración del texto cifrado, del contexto o de la cabecera interna en la base | `src/crypto/mtproto.js:146-148,173-179` |
| **AAD con el contexto del mensaje** | Mover un mensaje a otro chat, cambiar su autor, destinatario, tipo o grupo | `src/chat/messages.js:91`, `src/crypto/user-auth-keys.js:95-102` |
| **`msg_key` en claro + recálculo** | Substitución de sobres, mensajes de otro remitente pegados en una fila | `src/crypto/mtproto.js:180-181` |
| **`key_id` en el sobre + comprobación** | Descifrar un sobre con la clave equivocada | `src/crypto/mtproto.js:170` |
| **`auth_key` aleatoria por usuario (no derivada de la maestra)** | Que la llave maestra por sí sola descifre el contenido de todos | `src/crypto/mtproto.js:59-61`, `src/crypto/user-auth-keys.js:46-59` |
| **`auth_key` cifrada en reposo con la llave maestra** | Robo del fichero `zlapy.db` sin acceso al fichero de la llave | `src/crypto/user-auth-keys.js:54` |
| **Firma Ed25519 sobre contenido + contexto** | Alteración del texto plano en la base; mensaje movido de chat | `src/crypto/message-crypto.js:166-197`, `src/chat/messages.js:120-128` |
| **Derivación de la firma desde la `auth_key` del usuario** | Que la llave maestra permita suplantar a cualquier usuario | `src/crypto/setup.js:18-27` |
| **PCE1 (AES-256-GCM) para adjuntos, grupos y VAPID** | Lectura del contenido sensible por quien tenga sólo la base | `src/chat/media.js:28`, `src/groups/store.js:112`, `src/push/vapid.js:31` |
| **Fail-fast de la llave maestra** | Arrancar con una llave nueva que dejaría ilegible todo el histórico | `src/crypto/master-key.js:29-32` |
| **`.env` con la llave en modo 0600** | Lectura de la llave por otros usuarios del sistema | `ops/generate-master-key.js` (escritura atómica + chmod) |
| **Compatibilidad de lectura (`decryptAtRest` devuelve el texto tal cual)** | Perder contenido legacy al migrar | `src/crypto/message-crypto.js:35` |
| **Regeneración de clave con re-cifrado** | Perder el historial al rotar la clave del usuario | `src/users/store.js:194-297` |
| **Verificación de ida y vuelta en la migración** | Escribir un mensaje que luego no se puede releer | `ops/migrate-to-mtproto.js:134-136` |
| **Respaldo previo a la migración** | Migración fallida irreversible | `ops/migrate-to-mtproto.js:60-77` |
| **Contraseñas con hash scrypt + salt** | Recuperación de la contraseña a partir de la base | `src/auth/sessions.js:119-123` |

### 9.2 Qué NO protege

| Amenaza | Por qué no la cubre | Nota |
| --- | --- | --- |
| **Servidor comprometido / con acceso al proceso** | El servidor conoce la `auth_key` de todos: descifra todo y puede firmar como cualquiera | Por diseño (modelo en la nube) |
| **Compromiso de la llave maestra + de la base** | Se descifra todo: mensajes, adjuntos, material E2E de grupos, VAPID | Es el peor caso realista del servidor |
| **Confidencialidad extremo a extremo** | No existe: no hay E2E en los chats normales | Fuera de alcance (§7) |
| **Autenticidad de la autoría frente al servidor** | La firma Ed25519 la puede producir el servidor, que tiene la `auth_key` | §5.6 |
| **Metadatos** | Quién habla con quién, cuándo y con qué tamaño son visibles para el servidor | Los sobres no los ocultan |
| **Reenvío de un mensaje capturado a otro sitio** | El mensaje se descifra igual (la clave es determinista para ese `msg_key`) | No hay marca de contexto de transporte |
| **Repetición de un mensaje dentro de la ventana** | `msgIdAcceptable()` **no se invoca** en `src/` | §4.8 |
| **Alteración hecha por el servidor y luego reescrita** | El atacante puede cifrar y firmar coherentemente | §5.6 |
| **Contenido de los chats secretos E2E de grupo** | Lo controla el cliente; el servidor sólo lo transporta y guarda las keyboxes cifradas | `src/groups/store.js:100-116` |
| **Confidencialidad del audio/vídeo de las llamadas** | DTLS-SRTP de WebRTC, P2P y en el momento | El servidor no guarda el audio |
| **Pérdida de la llave maestra** | Sin ella, `PCE1`, adjuntos, VAPID y las `auth_key` en reposo son irrecuperables | De ahí el fail-fast y los respaldos |

---

## 10. Discrepancias con MTProto 2.0 real

Resumen de las diferencias encontradas al comparar el código con la
especificación de MTProto 2.0. **En todos los casos manda el código de
Zlapy**; se listan aquí para que nadie asuma interoperabilidad.

| # | Aspecto | MTProto 2.0 real | Zlapy (código) | Dónde |
| --- | --- | --- | --- | --- |
| **D-1** | Modo de cifrado | AES-256-**IGE** (sin autenticación) | AES-256-**GCM** (autenticado) | `src/crypto/mtproto.js:146,173` |
| **D-2** | Entrada del hash del `msg_key` | `SHA256(substr(auth_key,88+x,32) + plaintext + random_padding)`; el `plaintext` es el cuerpo | `SHA256(auth_key[88:120] + cabecera_interna(32) + cuerpo + relleno)`; **la cabecera interna también entra** | `src/crypto/mtproto.js:85-91,139-140` |
| **D-3** | Longitud del relleno | 12 a **1024** bytes | 12 a **27** bytes | `src/crypto/mtproto.js:45-46,94-99` |
| **D-4** | Sentido `x` de la derivación | `x = 0` cliente→servidor, `x = 8` servidor→cliente | siempre `x = 0` | `src/crypto/mtproto.js:140-141,171,181` |
| **D-5** | Uso del `aes_iv` completo | IV de 32 bytes usado por IGE | sólo 12 bytes como IV; 4 bytes van al AAD; **los 16 restantes no se usan** | `src/crypto/mtproto.js:142-145` |
| **D-6** | `msg_id` | 64 bits = `(unix_time << 32) + contador` | idéntico, pero **se devuelve y se lee como `Number`** → pérdida de precisión por encima de 2^53 (sólo afecta al objeto `header` que se devuelve, no a la autenticación) | `src/crypto/mtproto.js:102-124,199-203` |
| **D-7** | `seq_no` | contador de secuencia por sesión | siempre `0` | `src/crypto/mtproto.js:136`, `src/chat/messages.js:53` |
| **D-8** | Regenerar la `auth_key` | El servidor olvida la clave vieja: los mensajes antiguos dejan de descifrarse | Se **re-cifra** todo el contenido del usuario con la clave nueva | `src/users/store.js:186-297` |
| **D-9** | `auth_key` | La genera el cliente y la negocia con el servidor | La genera el **servidor** (`crypto.randomBytes(256)`) y se la entrega al usuario implícitamente | `src/crypto/mtproto.js:59-61`, `src/crypto/user-auth-keys.js:46-59` |
| **D-10** | Ventana anti-repetición | Parte del protocolo | La función existe y está cubierta por tests, pero **no se aplica en tiempo de ejecución**: no puede aplicarse al historial almacenado (un mensaje de hace una hora quedaría fuera de la ventana y sería ilegible). En la práctica, la protección contra repetir un mensaje antiguo la dan el **recálculo del `msg_key`** y el **contexto autenticado (AAD)**, que impiden mover una fila a otra conversación | `src/crypto/mtproto.js:207-213` |
| **D-11** | Dominio / separación | MTProto no usa un dominio explícito en el AAD (no hay AAD) | AAD = `aes_iv[12:16] || "zlapy/mtproto2/v3" || contexto` | `src/crypto/mtproto.js:48,145` |
| **D-12** | `session_id` | 64 bits, por sesión de autorización | 63 bits aleatorios, **nunca rota** mientras viva la `auth_key` | `src/crypto/user-auth-keys.js:24,52` |
| **D-13** | Sal | Parte de la derivación de la clave en IGE / sirve para anti-replay | Viaja en la cabecera interna, que forma parte del texto claro hasheado: **sí entra en el `msg_key`** y, por tanto, en `aes_key`/`aes_iv`; rotarla cambia el `msg_key` y el ciphertext de los mensajes nuevos (verificado) | `src/crypto/mtproto.js:102-114` vs `:71-82` |

**Nota adicional sobre la versión de MTProto de referencia**: el propio
código declara que replica la *estructura* de MTProto 2.0
(`src/crypto/mtproto.js:16-17`), y su derivación de claves es **byte a byte
idéntica** a la fórmula oficial (`test/mtproto.test.js:36-51`). Lo que cambia
es el modo de cifrado y el tratamiento del relleno, la cabecera y el `x`.

---

## 11. Cifrado del canal de transporte

Las secciones anteriores describen el cifrado **en reposo**. Este capítulo
describe la capa que protege el **cuerpo** de las peticiones y los frames del
WebSocket cuando el servidor se sirve por HTTP sin TLS, que es el modo normal
en una red local.

### 11.1 Qué problema resuelve

Por defecto el servidor no usa TLS: el cliente abre `http://192.168.x.x:3000`.
Sin ninguna protección, cualquier dispositivo de la red que pueda ver el
tráfico lee las contraseñas del login y los mensajes. La capa de transporte
añade un sobre cifrado a nivel de aplicación con estas propiedades:

- **Confidencialidad del cuerpo**: sin la clave de sesión no se puede leer el
  JSON que viaja en un `POST` ni el texto de un frame WebSocket.
- **Integridad**: el cuerpo va autenticado con HMAC-SHA256; alterar un byte
  invalida el sobre.
- **Contexto**: el sobre está atado al método, la ruta, la marca de tiempo y
  (en la respuesta) el código de estado. Un cuerpo no se puede mover a otra
  ruta ni reutilizar en otra conversación.
- **Frescura limitada**: la marca de tiempo debe estar a menos de **60 s** del
  reloj del servidor.
- **Respuestas autenticadas**: el servidor cifra y autentica la respuesta con
  la misma clave de sesión; el cliente rechaza una respuesta manipulada.

No es un sustituto de TLS. Las cabeceras —incluida la cookie
`chatlocal_session`— siguen en claro, y las respuestas `GET` no se cifran. El
modelo de amenazas completo está en [§11.8](#118-modelo-de-amenazas).

### 11.2 El par de claves del servidor

El servidor necesita un par de claves X25519 estable para que el cliente pueda
cifrar la primera petición. **No se guarda un secreto nuevo**: la clave privada
se deriva de la llave maestra con HKDF-SHA256:

```
privada_cruda = HKDF-SHA256(
    ikm  = llave maestra (32 bytes),
    salt = "zlapy-transport-salt",
    info = "x25519-private",
    len  = 32
)
```

Después se aplica el *clamping* que exige X25519 (los tres bits bajos a cero,
el bit más alto a cero y el bit 254 a uno) y se envuelve la clave cruda en una
estructura PKCS#8 (`302e020100300506032b656e04220420` + 32 bytes), que es lo
que espera `crypto.createPrivateKey()`. La pública se extrae de la estructura
SPKI (`302a300506032b656e032100` + 32 bytes) y sus últimos 32 bytes son la
clave cruda que se publica en base64.

La consecuencia práctica es que **respaldar la llave maestra basta**: al
restaurarla en otro servidor se obtiene el mismo par de transporte. Si se rota
la llave maestra, la clave pública cambia y los clientes que tengan una página
abierta deben recargarla (el cliente pide `/config` al cargar y guarda la clave
en memoria).

Se publica en dos sitios, ambos públicos:

```jsonc
// GET /config  y  GET /healthz
{
  "transportAlgorithm": "x25519-chacha20-hmac-v1",
  "transportPublicKey": "<32 bytes en base64>"
}
```

`/healthz` la incluye para que un cliente o un *script* de diagnóstico pueda
comprobar que el servidor tiene la capa activa sin pedir toda la configuración.
La clave pública no es un secreto: su función es que el cliente pueda cifrar
sin conocer ningún secreto compartido de antemano.

### 11.3 Apertura de una petición HTTP

El cliente solo envía el sobre cuando la petición cumple **todas** estas
condiciones (`public/transport.js`):

1. La URL es una cadena y es del **mismo origen**.
2. El método es `POST`.
3. El cuerpo es una cadena (`JSON.stringify(...)`).
4. El `Content-Type` es `application/json` (o no se indicó).

Las demás peticiones (`GET`, subidas binarias, peticiones a GIPHY) salen sin
cambios. El sobre se compone de cuatro cabeceras y un cuerpo binario:

| Cabecera | Valor |
| --- | --- |
| `X-Zlapy-Enc` | `x25519-chacha20-hmac-v1` |
| `X-Zlapy-Ephemeral` | clave pública efímera del cliente: 32 bytes en base64 |
| `X-Zlapy-Nonce` | nonce aleatorio de 12 bytes en base64 |
| `X-Zlapy-Time` | `Date.now()` del cliente, en milisegundos |
| `Content-Type` | `application/octet-stream` |

El cuerpo es `ciphertext ‖ tag`, donde `tag` son 32 bytes de HMAC-SHA256.

En el servidor, `src/http/transport.js` valida el sobre antes de que el
enrutador vea nada:

1. `X-Zlapy-Enc` debe ser exactamente la versión soportada. Si no, `400`.
2. `X-Zlapy-Time` debe ser un número finito y estar a ≤ 60 000 ms del reloj del
   servidor. Si no, `400`.
3. La clave efímera debe medir 32 bytes y el nonce 12 (se admite hasta 32).
   Un nonce **vacío o de más de 32 bytes** se rechaza aquí mismo (`400`,
   "Sobre inválido."): el nonce identifica al sobre y sin él no hay nada que
   recordar para el anti-replay.
4. Se deriva la clave de sesión y se comprueba el HMAC. Si falla, `400`.
5. **Anti-replay**: el nonce se registra en una memoria de
   `MAX_CLOCK_SKEW_MS + 30 000 ms` (tope duro de 8192 entradas, con tope
   y desalojo del más viejo). El registro se hace **solo cuando el sobre
   era legítimo** (MAC ya verificado): registrarlo antes permitiría a un
   atacante inundar el mapa con basura y expulsar el nonce que legítimamente
   se está reenviando (replay por desalojo FIFO). Un nonce repetido dentro
   de la ventana recibe `400 {"error": "Sobre ya utilizado."}`.
6. Se descifra y se parsea el JSON. Debe ser un objeto; si no, `400`.

Solo entonces el enrutador recibe el cuerpo ya descifrado y sigue su flujo
normal: las rutas no saben si el cliente usó el sobre o no. La respuesta se
envuelve con `sealResponse()`: se interceptan `writeHead()` y `end()` para
cifrar el cuerpo y añadir las cabeceras del sobre, sin cambiar el resto del
enrutador.

### 11.4 La clave de sesión

Ambos lados calculan el mismo secreto con X25519:

```
secreto = X25519(privada_efímera_cliente, pública_servidor)
        = X25519(privada_servidor,          pública_efímera_cliente)
```

y derivan de él 64 bytes con HKDF-SHA256:

```
clave_sesion = HKDF-SHA256(
    ikm  = secreto,
    salt = pública_efímera_cliente ‖ pública_servidor,
    info = "zlapy-transport-v1/session",
    len  = 64
)
```

- Los **primeros 32 bytes** son la clave de ChaCha20.
- Los **últimos 32 bytes** son la clave del HMAC-SHA256.

La sal incluye las dos claves públicas para que la derivación quede atada a esa
sesión concreta. El `info` separa el dominio HTTP del WebSocket: el WS usa
`zlapy-transport-v1/ws` y, por tanto, una clave distinta aunque el secreto
X25519 sea el mismo.

### 11.5 El sobre: ChaCha20 + HMAC-SHA256

El cifrado es **cifrar-y-luego-autenticar** (*encrypt-then-MAC*), no AEAD:

```
ciphertext = ChaCha20(clave[0..32), nonce, plaintext)
tag        = HMAC-SHA256(clave[32..64),
                AAD ‖ u64le(len(AAD)) ‖ nonce ‖ ciphertext ‖ u64le(len(ciphertext)))
sobre      = ciphertext ‖ tag
```

Detalles de implementación:

- **ChaCha20**: se usa el cifrado `chacha20` de Node con un IV de 16 bytes:
  contador de bloque `1` en los primeros 4 bytes (little-endian) y el nonce en
  los 12 restantes. En el cliente se implementa el mismo flujo en JavaScript.
- **Nonce**: 12 bytes aleatorios por petición (`crypto.randomBytes(12)` en el
  servidor, `crypto.getRandomValues` en el navegador). La respuesta usa otro
  nonce distinto, que viaja en `X-Zlapy-Resp-Nonce`.
- **Longitudes**: la longitud del AAD y la del texto cifrado se codifican como
  enteros de 64 bits little-endian dentro del HMAC para que no haya ambigüedad
  al concatenar campos.
- **Comparación**: el servidor compara la etiqueta con `timingSafeEqual`.
- **AAD de petición**: `zlapy-transport-v1|REQ|<MÉTODO>|<ruta>|<time>`.
- **AAD de respuesta**:
  `zlapy-transport-v1|RSP|<MÉTODO>|<ruta>|<time>|<estado>`.

La respuesta se cifra con la **misma** clave de sesión y el mismo algoritmo. El
`sealResponse()` del servidor quita `Content-Length` (la longitud cambia al
cifrar), pone `Content-Type: application/octet-stream` y añade:

```
X-Zlapy-Enc: x25519-chacha20-hmac-v1
X-Zlapy-Resp-Nonce: <12 bytes en base64>
```

`Content-Length` se recalcula solo, porque Node lo deriva del buffer que se
pasa a `end()`.

**¿Por qué no ChaCha20-Poly1305?** El cliente es JavaScript puro (véase
[§11.7](#117-el-cliente)) y la implementación artesanal de Poly1305 que se
probó no era correcta. HMAC-SHA256 es más fácil de escribir bien y de verificar
contra Node; el coste es una etiqueta de 32 bytes en lugar de 16. La
construcción sigue siendo segura siempre que la clave del HMAC sea distinta de
la de cifrado, y lo es: son mitades distintas de la salida de HKDF.

### 11.6 WebSocket cifrado

El WebSocket transporta mensajes en tiempo real (presencia, `typing`, eventos
de llamadas y el aviso de mensajes nuevos), así que también se cifra. El
protocolo es:

1. La conexión se abre como siempre (`GET /ws` con la cookie de sesión y el
   `Origin` correcto). El *upgrade* no cambia.
2. El cliente espera a `open` y envía un frame de texto **en claro**:

   ```json
   { "type": "enc", "ephemeral": "<32 bytes en base64>" }
   ```

   La clave privada efímera es nueva en cada conexión.
3. El servidor comprueba que la clave mida 32 bytes, deriva la clave con
   `sessionFromEphemeral(ephemeral, "zlapy-transport-v1/ws")` y guarda en el
   socket `{ key, out: 0, in: 0 }`.
4. El servidor responde con `{ "type": "enc-ok" }`, ya **cifrado** (la sesión
   existe cuando `wsSend` escribe). Si el saludo no es válido no hay respuesta
   y la conexión sigue en claro; si el cliente nunca lo envía, todo sigue
   funcionando como antes.
5. A partir de ahí, **todos** los frames de texto en ambas direcciones son
   `z1:<base64>`; los frames que no empiezan por `z1:` se descartan
   (`openFrame` devuelve `null`) sin cerrar la conexión.

El nonce del WS no es aleatorio: es un contador de 32 bits por dirección, para
no repetir nunca (nonce, clave) y evitar el coste de generar 12 bytes por
frame. Se construye así:

```
nonce[0..4)  = contador en little-endian (32 bits)
nonce[4..12) = etiqueta ASCII de 4 bytes: "zlapyC2S" (cliente → servidor)
                                          "zlapyS2C" (servidor → cliente)
AAD          = "zlapy-transport-v1|WS|<C2S|S2C>|<contador>"
```

Los contadores son independientes por sentido (`in` para lo que llega, `out`
para lo que sale), de modo que la misma clave se usa en ambos sentidos sin
colisión de nonces. Cada sentido se corta al llegar a `0xFFFFFFFF`.

Propiedades:

- **La clave es por conexión**: cerrar y volver a abrir genera otra efímera.
- **Integridad y orden**: alterar, reordenar o saltarse un frame invalida la
  etiqueta HMAC (el contador forma parte del AAD).
- **Compatibilidad**: un cliente que no manda el saludo (o una versión
  anterior) sigue en claro; el servidor no lo expulsa.

### 11.7 El cliente

El cliente vive en dos ficheros que se cargan en todas las páginas:

| Fichero | Papel |
| --- | --- |
| `public/transport-crypto.js` | Primitivas: SHA-256, HMAC-SHA256, HKDF, X25519, ChaCha20, `aeadSeal`/`aeadOpen`, `encrypt`, `decryptResponse`, `wsKey`, `wsSeal`, `wsOpen` y utilidades base64/aleatorias. Expone `window.ZlapyTransport`. |
| `public/transport.js` | Integración con la aplicación: envuelve `fetch` y `WebSocket`, pide la clave a `/config` y aplica el sobre de forma transparente. Expone `window.ZlapyTransportReady()`. |

**Por qué JavaScript puro y no `crypto.subtle`.** `window.crypto.subtle` solo
existe en **contextos seguros** (`https://` o `localhost`). El objetivo de esta
capa es precisamente el acceso por `http://` a la IP de la LAN, donde
`crypto.subtle` no está disponible. Por eso X25519, ChaCha20, SHA-256, HMAC y
HKDF están implementados en `transport-crypto.js`. Solo se usa
`crypto.getRandomValues()` para la aleatoriedad, que sí está disponible en
contextos no seguros.

Las primitivas se validan contra Node en `test/transport.test.js`: SHA-256,
HMAC, HKDF, X25519, ChaCha20 y el sobre completo producen los mismos bytes en
ambos lados; además hay un vector de bloque de ChaCha20 (RFC 8439) y pruebas de
ida y vuelta de 2 MB.

**Integración con `fetch`** (`transport.js`):

1. La primera petición que necesita el sobre pide `/config` y guarda
   `transportPublicKey` en memoria. Se comparte una única promesa para no
   duplicar la petición.
2. Si `/config` no trae la clave (servidor antiguo, proxy que la filtra), la
   petición sale **en claro**. El cifrado es aditivo: nunca debe romper la app.
3. Si `encrypt()` falla (clave inválida, por ejemplo), también se envía en
   claro.
4. Si la respuesta trae `X-Zlapy-Enc` y `X-Zlapy-Resp-Nonce`, se descifra y se
   devuelve un `Response` nuevo con `Content-Type: application/json`. Si la
   etiqueta no valida, se lanza un error: una respuesta manipulada **no** se
   acepta ni se degrada a texto plano.

**Integración con WebSocket** (`transport.js`): se extiende el constructor
nativo (`class SecureWebSocket extends NativeWebSocket`).

- Al abrir la conexión pide la clave del servidor. Si no está, vacía la cola en
  claro.
- Si está, deriva la sesión, guarda `{ key, out, in }`, envía el saludo y vacía
  la cola ya cifrada.
- `send(texto)` antes del saludo se encola (máximo 200 frames) para no perder
  los mensajes que la app envía nada más conectar.
- `send(binario)` no se toca.
- `onmessage` y `addEventListener('message')` descifran los frames `z1:` antes
  de entregarlos a la aplicación. La app sigue recibiendo `event.data` como
  texto JSON normal.
- Si un frame no descifra, se descarta (no se entrega basura a la app).

### 11.8 Modelo de amenazas

| Amenaza | ¿La capa la detiene? | Por qué |
| --- | --- | --- |
| Lectura pasiva del cuerpo de un `POST` | **Sí** | ChaCha20 con una clave que solo conocen cliente y servidor. |
| Lectura pasiva de frames WebSocket | **Sí** | Igual, con clave por conexión. |
| Modificación del cuerpo o de la respuesta | **Sí** | HMAC-SHA256 sobre AAD + nonce + ciphertext. |
| Mover un cuerpo a otra ruta o a otra respuesta | **Sí** | El AAD incluye método, ruta, tiempo y estado. |
| Responder con un cuerpo viejo de la misma ruta | **Sí** | El AAD incluye la marca de tiempo de la petición. |
| Repetir un sobre capturado | **No** | No hay caché de nonces; dentro de los 60 s el servidor lo procesaría otra vez. |
| Leer las cabeceras (cookie de sesión incluida) | **No** | Solo se cifra el cuerpo. |
| Robar la cookie y usar la API | **No** | La cookie viaja en claro; el servidor acepta peticiones en claro. |
| Leer una respuesta `GET` | **No** | Solo se cifran los `POST` y el WS. |
| Suplantar al servidor (MITM activo) | **No** | El atacante entrega su propia clave pública en `/config`. |
| Leer el contenido en el servidor | **No** | El servidor descifra para procesar; no es E2E. |
| Analizar metadatos (quién, cuándo, tamaño) | **No** | Rutas, tiempos y longitudes siguen visibles. |

La conclusión importante: **esta capa no sustituye a HTTPS**. Su objetivo es
que el contenido sensible no quede legible en una captura de red casual
(Wireshark, un portátil en la misma wifi) y que el cliente no acepte respuestas
manipuladas. Para proteger la sesión y las cabeceras hace falta TLS, que ya
está soportado en el mismo puerto (véase `README.md`, «HTTPS y el móvil»).

Otras notas:

- **Reloj**: la ventana de ±60 s exige que el dispositivo tenga la hora
  razonablemente sincronizada. Un móvil con la hora muy desviada recibe `400
  Marca de tiempo fuera de rango.`; se corrige poniendo la hora en automático.
- **Rotación de la llave maestra**: cambia la clave pública. Una página ya
  abierta conserva la anterior y sus peticiones fallarán con `400` hasta
  recargar.
- **Sin estado en el servidor**: el sobre HTTP no crea sesiones ni guarda
  nonces; cada petición es independiente. La clave de sesión dura lo que dura
  la petición (o la conexión WS).

### 11.9 Pruebas

`test/transport.test.js` cubre:

- Las primitivas del cliente contra las de Node (SHA-256, HMAC, HKDF, X25519,
  ChaCha20) y un vector de bloque del RFC 8439.
- Ida y vuelta del sobre, incluido un cuerpo de 2 MB.
- Rechazo de sobres manipulados, de ruta cambiada y de tiempo caducado; el
  nonce va dentro del HMAC, así que cambiarlo también invalida el sobre.
- WebSocket en ambos sentidos, handshake y contadores, y compatibilidad con
  clientes que no cifran.
- `GET /config` y `GET /healthz` publican la clave.
- Registro, envío y lectura de historial con el cliente cifrado, y el camino en
  claro cuando no se envía sobre.
- Un sobre roto recibe `400` sin tumbar el servidor.

---

## 12. Índice de ficheros y símbolos

| Fichero | Símbolo | Qué hace |
| --- | --- | --- |
| `src/crypto/master-key.js:19` | `getMasterKeyBytes()` | Lee/genera/aborta: la llave maestra de 32 bytes |
| `src/crypto/message-crypto.js:25` | `encryptAtRest()` | `PCE1:` AES-256-GCM con la llave maestra |
| `src/crypto/message-crypto.js:33` | `decryptAtRest()` | `PCE1:` + tolerancia a legacy (devuelve el texto tal cual) |
| `src/crypto/message-crypto.js:53` | `messageContext()` | Contexto del mensaje (AAD de `PCE2`) |
| `src/crypto/message-crypto.js:69` | `encryptMessage()` | `PCE2:` AES-256-GCM + AAD de contexto |
| `src/crypto/message-crypto.js:78` | `decryptMessage()` | `PCE2:` estricto; `PCE1:` → `decryptAtRest` |
| `src/crypto/message-crypto.js:102` | `deriveKeyPair()` | HKDF-SHA256 → par Ed25519 |
| `src/crypto/message-crypto.js:125` | `keyPairsForUser()` | Candidatos: `auth_key` y llave maestra |
| `src/crypto/message-crypto.js:143` | `messageSignaturePayload()` | Lo que se firma |
| `src/crypto/message-crypto.js:166` | `signMessage()` | Firma Ed25519 |
| `src/crypto/message-crypto.js:183` | `verifyMessage()` | Verificación (fail-closed) |
| `src/crypto/mtproto.js:53` | `authKeyId()` | 64 bits bajos del SHA-1 |
| `src/crypto/mtproto.js:59` | `generateAuthKey()` | 2048 bits aleatorios |
| `src/crypto/mtproto.js:71` | `deriveKeys()` | `aes_key` / `aes_iv` (fórmula MTProto) |
| `src/crypto/mtproto.js:85` | `computeMsgKey()` | 128 bits centrales |
| `src/crypto/mtproto.js:94` | `buildPadding()` | Relleno 12..27 |
| `src/crypto/mtproto.js:102` | `buildInternalHeader()` | Cabecera de 32 bytes |
| `src/crypto/mtproto.js:128` | `encrypt()` | Construye el sobre `PCE3:` |
| `src/crypto/mtproto.js:159` | `decrypt()` | Abre el sobre `PCE3:` (devuelve `null` si falla) |
| `src/crypto/mtproto.js:199` | `nextMsgId()` | `msg_id` monotónico |
| `src/crypto/mtproto.js:207` | `msgIdAcceptable()` | Ventana 300 s / 30 s (**no usada en runtime**) |
| `src/crypto/user-auth-keys.js:28` | `authKeyRecord()` | Carga (y descifra) la `auth_key` |
| `src/crypto/user-auth-keys.js:46` | `ensureAuthKey()` | Crea la `auth_key` si no existe |
| `src/crypto/user-auth-keys.js:61` | `rotateSaltIfNeeded()` | Rotación de sal a los 30 min |
| `src/crypto/user-auth-keys.js:70` | `encryptForUser()` | Cifra con la `auth_key` del usuario |
| `src/crypto/user-auth-keys.js:81` | `decryptForUser()` | Descifra `PCE3:` o cae a `PCE1:` |
| `src/crypto/user-auth-keys.js:95` | `messageContextBytes()` | AAD de contexto de `PCE3` |
| `src/crypto/setup.js:17-40` | (instancia) | Crea la llave y comparte los helpers |
| `src/chat/messages.js:32` | `prepareStoredMessage()` | Firma + cifra un mensaje nuevo (PCE3) |
| `src/chat/messages.js:73` | `rowToMessage()` | Lee un mensaje: PCE3 / PCE2 / PCE1 + verifica la firma |
| `src/users/store.js:194` | `regenerateAuthKey()` | Regenera y re-cifra |
| `src/profile/routes.js:187` | `postAccountRegenerateKey()` | Ruta `POST /account/regenerate-key` |
| `ops/migrate-to-mtproto.js` | (script) | Migración manual PCE2 → PCE3 |
| `ops/generate-master-key.js:32` | `generateMasterKey()` | Genera/vacía `CHAT_MASTER_KEY` en `.env` |

Tests relacionados:

| Test | Qué cubre |
| --- | --- |
| `test/mtproto.test.js` | Derivación byte a byte, padding, cabecera, `msg_id`, ventana, autenticación, aislamiento entre claves |
| `test/mtproto-server.test.js` | Clave por usuario, la maestra no descifra sola, `encryptionKeyId`, regeneración sin perder historial, `key_id` del autor en cada sobre |
| `test/message-crypto.test.js` | `PCE2` con contexto ligado, firma válida/inválida, lectura de `PCE1` legacy |
| `test/migrate-to-mtproto.test.js` | Simulación, migración real, conservación del contenido, script eliminable |
| `test/generate-master-key.test.js` | Generación de la llave maestra en `.env` |
