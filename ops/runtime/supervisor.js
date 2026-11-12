/**
 * Supervisor del servidor Zlapy.
 *
 * Vigila `node server.js` y lo relanza si muere por un fallo no capturado
 * (crash, código de salida != 0) o si se queda colgado sin generar evento de
 * salida (vivo pero sin responder).
 */

/*   - Carga el MISMO `.env` que el servidor (dotenv) ANTES de resolver su
 *     configuración. Sin esto, `PORT` y las variables `SUPERVISOR_*`
 *     documentadas en `.env.example` son inertes: el health check sondea un
 *     puerto donde no escucha nadie → ciclo infinito de reinicios.
 *   - No sondea un puerto supuesto: captura el puerto real del banner de
 *     arranque del hijo ("✅ Zlapy (SQLite) en el puerto NNNN") y sondea ese.
 *     El puerto de `.env` queda como valor inicial y como respaldo.
 *   - Backoff exponencial entre reinicios (1 s → 30 s): nunca spammea.
 *   - Distingue FALLO DE ARRANQUE (el hijo nunca llegó a servir) de CAÍDA EN
 *     CALIENTE (el hijo ya servía y se cae):
 *       * el cortacircuito (exit 70) protege SOLO del fallo de arranque;
 *       * la caída en caliente reinicia siempre con backoff topado, avisa por
 *         log y NUNCA deja el servicio apagado.
 *   - Watchdog de salud: sólo un 2xx en el health check cuenta como sano;
 *     un proceso vivo pero colgado se detecta y se reinicia.
 *   - GRACE_PERIOD_MS deja que el servidor termine de arrancar antes de
 *     exigirle que responda.
 *   - Un hijo que ignora SIGTERM cae con SIGKILL tras 5 s. El hijo libera el
 *     puerto en su apagado ordenado (`closeAllConnections` en
 *     src/http/servers.js) y el supervisor espera a su salida antes de
 *     relanzarlo.
 *   - Escribe el PID del hijo en SUPERVISOR_PID_FILE (.zlapy.pid).
 *   - Un segundo `npm start` con otro server.js vivo se corta con exit 70 y
 *     un mensaje claro (antes: bucle de "puerto ocupado" sin explicación).
 *   - SIGINT/SIGTERM/SIGHUP paran al hijo SIEMPRE: SIGTERM primero y SIGKILL
 *     a los 5 s si lo ignora; cerrar la terminal (SIGHUP) no deja huérfanos.
 *
 * Uso: npm start  (o: node ops/runtime/supervisor.js)
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { ensureDeps } = require('../install/ensure-deps.js');

// El supervisor y el servidor deben leer el MISMO fichero de configuración.
// `dotenv` no sobrescribe variables ya presentes en el entorno, así que el
// hijo (que hereda `process.env` y vuelve a cargar `.env`) ve exactamente los
// mismos valores que el supervisor. Si dotenv no estuviera instalado, se
// sigue con el entorno del proceso (aviso, no caída).
try {
    require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
} catch (e) {
    console.warn('[supervisor] no se pudo cargar dotenv:', e.message);
}

const ROOT = path.join(__dirname, '..', '..');

// Lectura de enteros tolerante: un valor inútil avisa y cae al valor por
// defecto en vez de dejar la variable sin efecto (la configuración existiría
// pero no llegaría a aplicarse).
const readInt = (name, fallback, { min = 1 } = {}) => {
    const raw = String(process.env[name] === undefined ? '' : process.env[name]).trim();
    if (raw === '') return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value < min) {
        console.warn(`[supervisor] ${name}="${raw}" no es un entero >= ${min}; se usa ${fallback}`);
        return fallback;
    }
    return value;
};

// El PID file siempre vive dentro del proyecto: una ruta relativa del `.env`
// se resuelve contra la raíz, no contra el directorio desde el que se arrancó
// `npm start`.
const resolvePidFile = raw => {
    const value = String(raw || '').trim();
    if (!value) return path.join(ROOT, '.zlapy.pid');
    return path.resolve(ROOT, value);
};

const PID_FILE = resolvePidFile(process.env.SUPERVISOR_PID_FILE);
// Backoff exponencial: BASE * 2^n hasta MAX.
const BASE_DELAY = readInt('SUPERVISOR_BACKOFF_MS', 1000);
const MAX_DELAY = readInt('SUPERVISOR_BACKOFF_MAX_MS', 30000);
// Tope de fallos de ARRANQUE consecutivos antes de abrir el cortacircuito.
// Superado, el supervisor para y avisa (código 70) en vez de insistir para
// siempre. 0 = sin tope.
const MAX_RESTARTS = readInt('SUPERVISOR_MAX_RESTARTS', 10, { min: 0 });

// Watchdog de salud. El período de gracia deja arrancar al servidor (esquema,
// hidratación) antes de exigirle que responda.
const HEALTH_PATH = String(process.env.SUPERVISOR_HEALTH_PATH || '').trim() || '/healthz';
const HEALTH_INTERVAL_MS = readInt('SUPERVISOR_HEALTH_MS', 15000);
const HEALTH_TIMEOUT_MS = readInt('SUPERVISOR_HEALTH_TIMEOUT_MS', 5000);
const HEALTH_FAILURES_BEFORE_KILL = readInt('SUPERVISOR_FAILURES_BEFORE_KILL', 3);
const GRACE_PERIOD_MS = readInt('SUPERVISOR_STARTUP_MS', 30000);
// Puerto inicial: sólo sirve hasta que el hijo anuncie el suyo en el banner.
// `SUPERVISOR_HEALTH_PORT` permite fijarlo a mano; `PORT` es el valor normal
// porque es el que lee el servidor de `.env`.
const CONFIGURED_PORT = readInt('SUPERVISOR_HEALTH_PORT', readInt('PORT', 3000));
// Umbral de caídas en caliente a partir del cual se deja una alerta clara.
// El servicio NO se apaga: se sigue reintentando con el backoff máximo.
const HOT_CRASH_THRESHOLD = readInt('SUPERVISOR_HOT_CRASH_THRESHOLD', 5);
// Tiempo que el servicio debe seguir sano para dar el incidente por cerrado
// y olvidar la racha de fallos. Por defecto no puede ser menor que el ciclo
// de detección del watchdog (gracia + fallos × intervalo): así el cortacircuito
// y el watchdog son coherentes entre sí.
const STABLE_UPTIME_MS = Math.max(
    readInt('SUPERVISOR_STABLE_MS', 60000),
    GRACE_PERIOD_MS + HEALTH_FAILURES_BEFORE_KILL * HEALTH_INTERVAL_MS
);
// Un child que ignora SIGTERM (sí ocurre) no muere con la señal blanda.
const SIGKILL_GRACE_MS = 5000;
// Latido servidor → supervisor (canal IPC) y su watchdog: un proceso vivo
// pero con el event loop bloqueado a veces sigue contestando algún health
// check rezagado; el latido es la señal directa. Se arma DESPUÉS de que el
// servidor anuncie que escucha, así que un arranque lento no lo dispara.
const HB_INTERVAL_MS = readInt('SUPERVISOR_HB_MS', 10000);
const HB_STALE_MS = Math.max(readInt('SUPERVISOR_HB_STALE_MS', 45000), HB_INTERVAL_MS * 3);
// Intentos de instalación de dependencias (exit 79) antes de rendirse.
const DEPS_INSTALL_ATTEMPTS = readInt('SUPERVISOR_DEPS_INSTALL_ATTEMPTS', 3, { min: 0 });

// El banner del servidor: "✅ Zlapy (SQLite) en el puerto 3100".
const PORT_BANNER = /en el puerto\s+(\d{1,5})/i;

let child = null;
let stopped = false;
let childStartedAt = 0;
// El hijo llegó a responder 2xx al health check (o sea: estaba sirviendo).
let childHealthy = false;
// El hijo ya escuchó en su puerto (banner recibido): la gracia de arranque
// deja de aplicar, porque el servidor está levantado.
let childBound = false;
// Cuándo se volvió sano: sirve para medir la ventana estable.
let healthySince = 0;
// Fallos de salud consecutivos (watchdog) del hijo actual.
let consecutiveFailures = 0;
// Fallos de ARRANQUE consecutivos: el hijo murió sin llegar a servir.
let startupFailures = 0;
// Caídas EN CALIENTE consecutivas: el hijo ya servía y se ha caído.
let hotCrashes = 0;
// Exponente del backoff (reinicios seguidos sin un periodo estable).
let restartAttempt = 0;
// Puerto que se sondea: el configurado hasta que el hijo anuncie el suyo.
let healthPort = CONFIGURED_PORT;
let killTimer = null;
// Temporizador de reinicio pendiente; se guarda para poder cancelarlo al apagar.
//
// SIN unref() a propósito: cuando el hijo cae, `child` pasa a null y no queda
// ningún handle activo que mantenga vivo el event loop. Con unref() aquí, el
// proceso entero saldría con código 0 antes de que el temporizador disparase y
// el servidor no volvería a levantarse nunca.
let restartTimer = null;
// Sondeo de salud en curso: evita solapar dos comprobaciones.
let pendingProbe = null;
// Último latido recibido del hijo (canal IPC). 0 = ninguno todavía.
let lastHeartbeat = 0;
// Intentos de instalación de dependencias (exit 79) desde la última racha
// buena: se reinician cuando el servicio vuelve a estar sano.
let depAttempts = 0;

function writePid(pid) {
    try {
        // El directorio del PID file se crea si falta (con 0700): un
        // SUPERVISOR_PID_FILE con subdirectorio no debe fallar en silencio.
        fs.mkdirSync(path.dirname(PID_FILE), { recursive: true, mode: 0o700 });
        fs.writeFileSync(PID_FILE, pid ? String(pid) : '');
        // El PID del hijo en 0644 era legible por cualquier usuario local;
        // no es secreto, pero el fichero no necesita más permisos.
        try { fs.chmodSync(PID_FILE, 0o600); } catch { /* best-effort */ }
    } catch (e) { /* best-effort */ }
}

// Backoff exponencial acotado: el máximo nunca se supera, así que un
// crash-loop no se convierte en una espera de horas.
function nextDelay() {
    return Math.min(BASE_DELAY * Math.pow(2, restartAttempt), MAX_DELAY);
}

function checkHealth(port = healthPort) {
    return new Promise((resolve) => {
        const req = http.get(
            {
                host: '127.0.0.1',
                port,
                path: HEALTH_PATH,
                timeout: HEALTH_TIMEOUT_MS,
                // `agent: false` cierra el socket al terminar la respuesta: el
                // supervisor no deja conexiones vivas ni retiene el puerto.
                agent: false
            },
            (res) => {
                res.resume();
                // Solo un 2xx cuenta como sano: cualquier 4xx/5xx es un fallo
                // (incluido el 503 de /healthz cuando la base no responde).
                resolve(res.statusCode >= 200 && res.statusCode < 300);
            }
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

// Un solo sondeo a la vez: el banner y el bucle periódico pueden pedir uno a
// la vez y no deben solaparse.
function probe() {
    if (!pendingProbe) {
        pendingProbe = checkHealth(healthPort).then(
            value => { pendingProbe = null; return value; },
            error => { pendingProbe = null; throw error; }
        );
    }
    return pendingProbe;
}

// El servicio pasó a estar sano. `pid` identifica al hijo: si mientras
// sonaba ha muerto y hay otro en su lugar, el resultado es de otro proceso.
function markHealthy(pid) {
    if (!child || child.pid !== pid) return;
    if (!childHealthy) {
        childHealthy = true;
        healthySince = Date.now();
        consecutiveFailures = 0;
        console.log(`[supervisor] servicio sano (pid ${pid}, puerto ${healthPort})`);
        return;
    }
    // Ventana estable: tras un rato sirviendo con normalidad, la racha de
    // fallos se olvida.
    if (!startupFailures && !hotCrashes && !restartAttempt) return;
    if (Date.now() - healthySince < STABLE_UPTIME_MS) return;
    console.log(
        `[supervisor] servicio estable ${Math.round((Date.now() - healthySince) / 1000)}s; ` +
        'se olvidan los fallos de la racha anterior'
    );
    startupFailures = 0;
    hotCrashes = 0;
    restartAttempt = 0;
    depAttempts = 0;
}

// Reinicio forzado por salud: mata al child para que el handler `exit` haga
// su trabajo normal (backoff, log, relanzamiento).
function killUnhealthy(reason) {
    if (stopped || !child) return;
    // Si ya hay un kill en curso no se reintenta: el siguiente 'exit' se
    // encarga del relanzamiento.
    if (killTimer) return;
    console.error(`[supervisor] salud fallida x${consecutiveFailures} (${reason}); reiniciando pid ${child.pid}`);
    try { child.kill('SIGTERM'); } catch (e) { /* ya salió */ }
    killTimer = setTimeout(() => {
        try { if (child) child.kill('SIGKILL'); } catch (e) { /* ya salió */ }
    }, SIGKILL_GRACE_MS);
    killTimer.unref();
}

// Programa el reinicio. Sin unref(): es lo único que mantiene vivo al
// supervisor entre que el hijo cae y el siguiente arranque.
function scheduleRestart(delay) {
    if (stopped) return;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
        restartTimer = null;
        start();
    }, delay);
}

// Reenvía la salida del hijo tal cual (el supervisor no se traga los logs
// del servidor) y busca en ella el banner con el puerto real.
function watchChildOutput(stream, pid) {
    let tail = '';
    stream.on('data', (chunk) => {
        process.stdout.write(chunk);
        tail += chunk.toString('utf8');
        // Sólo se analizan líneas completas; el resto se guarda para la
        // siguiente vez (el banner puede llegar partido entre dos chunks).
        const lines = tail.split('\n');
        tail = lines.pop();
        for (const line of lines) handleChildLine(line, pid);
    });
    stream.on('end', () => { if (tail.trim()) handleChildLine(tail, pid); });
}

function handleChildLine(line, pid) {
    const match = line.match(PORT_BANNER);
    if (!match) return;
    const port = Number.parseInt(match[1], 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return;
    markChildPort(pid, port);
}

/* El hijo ya escucha: fija el puerto que se sondea, termina la gracia de
   arranque y fuerza una comprobación de salud inmediata (clasifica un crash
   posterior como caída en caliente, no como fallo de arranque). Lo usan el
   banner de stdout y el mensaje 'ready' del canal IPC. */
function markChildPort(pid, port) {
    if (!child || child.pid !== pid) return;
    const changed = port !== healthPort;
    healthPort = port;
    // El servidor ya escuchó: la gracia de arranque deja de aplicar.
    childBound = true;
    console.log(
        `[supervisor] el servidor escucha en el puerto ${port}; el health check sondea ese puerto` +
        (changed ? ` (el puerto configurado era ${CONFIGURED_PORT})` : '')
    );
    probe().then(ok => { if (ok) markHealthy(pid); }).catch(() => { });
}

/* Mensajes del hijo por el canal IPC (spawn con 'ipc'). Ver protocolo en
   ops/runtime/supervisor.js: 'ready' · 'hb' · 'deps-missing'. */
function handleChildMessage(msg, pid) {
    if (!msg || typeof msg !== 'object' || !child || child.pid !== pid) return;
    if (msg.t === 'ready') {
        const port = Number.parseInt(msg.port, 10);
        if (Number.isInteger(port) && port > 0) markChildPort(pid, port);
    } else if (msg.t === 'hb') {
        lastHeartbeat = Date.now();
    } else if (msg.t === 'deps-missing') {
        const nombres = Array.isArray(msg.missing) && msg.missing.length ? msg.missing.join(', ') : '(sin detalle)';
        console.error(`[supervisor] el servidor avisa de que le faltan dependencias: ${nombres}`);
    }
}

// Programación del reinicio tras una caída, con la clasificación correcta.
function handleChildExit(code, signal) {
    const uptimeSec = Math.round((Date.now() - childStartedAt) / 1000);

    /* CÓDIGO 78 (EX_CONFIG): la credencial del propietario no abre la base
       (falta, es la equivocada o la base no está inicializada). No es un
       fallo transitorio: reintentar sólo repetiría el mismo error. Se para
       el supervisor y se espera a que el operador corrija el `.env` (o
       ejecute `npm run owner -- init`). */
    if (code === 78) {
        console.error(
            `[supervisor] el servidor salió con código 78 (EX_CONFIG): la credencial del propietario ` +
            'no abre esta base. No se reintenta (sería el mismo error): corrige DB_USER/DB_PASSWORD en el .env ' +
            'o ejecuta `npm run owner -- init` si la base es nueva, y vuelve a arrancar.'
        );
        writePid(null);
        process.exit(78);
    }

    /* CÓDIGO 79 (EX_UNAVAILABLE): al servidor le falta una dependencia (lo
       detecta su preflight, ops/install/ensure-deps.js). No es un fallo transitorio
       que se arregle reintentando, pero SÍ es reparable aquí: se instala lo
       que falte y se relanza UNA vez, sin backoff y sin gastar intentos de
       arranque (así no hay tormenta de reinicios ni cortacircuito). */
    if (code === 79) {
        depAttempts += 1;
        if (DEPS_INSTALL_ATTEMPTS > 0 && depAttempts > DEPS_INSTALL_ATTEMPTS) {
            console.error(
                `[supervisor] CIRCUITO ABIERTO: ${depAttempts} intentos de instalar dependencias sin éxito. ` +
                'Instálalas a mano (`npm run deps` o `npm install`) y vuelve a arrancar.'
            );
            writePid(null);
            process.exit(70);
        }
        console.error(
            `[supervisor] el servidor salió con código 79: le falta una dependencia. ` +
            `Instalándola (${depAttempts}/${DEPS_INSTALL_ATTEMPTS || '∞'})…`
        );
        let instalado = false;
        try {
            instalado = ensureDeps({ loggers: { log: m => console.log(m), error: m => console.error(m) } });
        } catch (e) {
            console.error(`[supervisor] no se pudieron instalar las dependencias: ${e && e.message ? e.message : e}`);
        }
        if (instalado) {
            // Reintento inmediato y sin penalización: la causa ya no existe.
            startupFailures = 0;
            restartAttempt = 0;
            scheduleRestart(300);
            return;
        }
        writePid(null);
        process.exit(70);
    }

    if (childHealthy) {
        // CAÍDA EN CALIENTE: el servicio estaba sirviendo y se ha caído.
        // Aquí NO se abre el cortacircuito: el servicio se queda levantado
        // siempre (con backoff topado) aunque el bucle sea infinito.
        startupFailures = 0;
        hotCrashes += 1;
        const delay = nextDelay();
        restartAttempt += 1;
        console.error(
            `[supervisor] CAÍDA EN CALIENTE (code=${code}, signal=${signal}, uptime=${uptimeSec}s, ` +
            `caídas=${hotCrashes}/${HOT_CRASH_THRESHOLD}); reinicio en ${(delay / 1000).toFixed(1)}s. ` +
            'El servicio no se queda apagado.'
        );
        if (hotCrashes === HOT_CRASH_THRESHOLD || (hotCrashes > HOT_CRASH_THRESHOLD && hotCrashes % 10 === 0)) {
            console.error(
                `[supervisor] ALERTA: ${hotCrashes} caídas en caliente seguidas (crash-loop). ` +
                `Se sigue reintentando con el backoff máximo (${(MAX_DELAY / 1000).toFixed(0)}s) y el ` +
                'servicio se mantiene en servicio, pero hace falta intervención humana.'
            );
        }
        scheduleRestart(delay);
        return;
    }

    // FALLO DE ARRANQUE: el hijo murió sin llegar a servir.
    startupFailures += 1;
    hotCrashes = 0;
    const delay = nextDelay();
    restartAttempt += 1;
    if (MAX_RESTARTS > 0 && startupFailures >= MAX_RESTARTS) {
        console.error(
            `[supervisor] CIRCUITO ABIERTO: ${startupFailures} fallos de arranque consecutivos ` +
            `(último code=${code}, signal=${signal}). El servidor no llegó a levantarse; se deja de ` +
            'reintentar y hay que arrancar a mano tras corregir la causa.'
        );
        writePid(null);
        process.exit(70); // EX_SOFTWARE: distinto de 0 para que un gestor lo vea
    }
    console.error(
        `[supervisor] fallo de arranque (code=${code}, signal=${signal}, uptime=${uptimeSec}s, ` +
        `intentos=${startupFailures}/${MAX_RESTARTS || '∞'}); reinicio en ${(delay / 1000).toFixed(1)}s`
    );
    scheduleRestart(delay);
}

/* Otro server.js vivo bajo OTRO supervisor arrancado antes: se detecta por
   el PID guardado. Sin esta guarda, un segundo `npm start` entra en el bucle
   de "puerto ocupado" sin explicar que el puerto lo tiene una instancia
   anterior que sigue corriendo — y la impresión es que el servidor
   "no se deja parar". */
function aliveServerPid() {
    try {
        const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (!Number.isInteger(pid) || pid <= 0) return 0;
        // Pid reciclado por otro proceso: no es un server.js.
        if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('server.js')) return 0;
        return pid;
    } catch { return 0; }
}

function start() {
    if (stopped) return;
    const otro = aliveServerPid();
    if (otro) {
        console.error(
            `[supervisor] ya hay un server.js vivo (pid ${otro}), seguramente bajo otro supervisor arrancado antes.\n` +
            `              Para pararlo de verdad hay que parar a ESE supervisor (Ctrl+C en SU terminal o kill a SU pid),\n` +
            `              no lanzar otro npm start. Este intento se corta aquí (exit 70).`
        );
        process.exit(70);
    }
    console.log(`[supervisor] arrancando servidor (puerto configurado ${CONFIGURED_PORT})…`);
    child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        // stdout se canaliza para poder leer el banner del puerto; stderr se
        // hereda directamente (el servidor avisa ahí del puerto ocupado). El
        // canal 'ipc' es el que pone a hablar a los dos procesos: el servidor
        // avisa con 'ready' cuando escucha, latidos ('hb') y 'deps-missing'.
        stdio: ['inherit', 'pipe', 'inherit', 'ipc'],
        env: process.env
    });
    childStartedAt = Date.now();
    childHealthy = false;
    childBound = false;
    healthySince = 0;
    consecutiveFailures = 0;
    // El latido solo empieza a llegar una vez el servidor escucha.
    lastHeartbeat = 0;
    // El puerto vuelve a ser el configurado hasta que el hijo anuncie el suyo.
    healthPort = CONFIGURED_PORT;
    // Un spawn fallido (ENOMEM, límites) deja pid undefined: no se escribe
    // basura en el fichero de PID.
    if (typeof child.pid === 'number' && child.pid > 0) {
        writePid(child.pid);
    } else {
        writePid(null);
        console.error('[supervisor] el proceso se lanzó sin pid válido');
    }
    const childPid = child.pid;
    console.log(`[supervisor] servidor arriba (pid ${childPid})`);

    if (child.stdout) watchChildOutput(child.stdout, childPid);

    // Un mismo hijo puede emitir 'error' y después 'exit': el fallo se
    // cuenta una sola vez.
    const childRef = child;
    let settled = false;
    childRef.on('message', (msg) => handleChildMessage(msg, childPid));
    const settle = () => {
        if (settled) return false;
        settled = true;
        return true;
    };

    childRef.on('error', (err) => {
        console.error('[supervisor] no se pudo lanzar el servidor:', err.message);
        // Sin esto, el PID file se queda con basura del intento fallido y un
        // killTimer pendiente deja al supervisor en estado incoherente.
        writePid(null);
        if (child === childRef) child = null;
        if (killTimer) { clearTimeout(killTimer); killTimer = null; }
        if (stopped || !settle()) return;
        // No se pudo ni arrancar: cuenta como fallo de arranque (y el
        // cortacircuito protege del bucle infinito de spawns fallidos).
        handleChildExit(null, null);
    });

    childRef.on('exit', (code, signal) => {
        writePid(null);
        if (killTimer) { clearTimeout(killTimer); killTimer = null; }
        if (child === childRef) child = null;
        if (stopped || !settle()) return;
        handleChildExit(code, signal);
    });
}

// Un solo ciclo de sondeo: si un health check se cuelga, el siguiente no se
// solapa con él.
async function watchHealth() {
    while (!stopped) {
        await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS).unref());
        if (stopped || !child) continue;
        const pid = child.pid;
        // Durante la gracia no se exige respuesta: el servidor puede tardar
        // en levantar el esquema. En cuanto llega el banner (el servidor ya
        // escuchó) o el hijo se declara sano, se sondea sin esperar.
        if (!childHealthy && !childBound && Date.now() - childStartedAt < GRACE_PERIOD_MS) continue;

        /* Latido: solo aplica si alguno llegó (o sea, el servidor escucha y
           hay canal IPC). Un arranque lento NUNCA dispara esto: los latidos
           empiezan después de "ready". */
        if (lastHeartbeat && Date.now() - lastHeartbeat > HB_STALE_MS) {
            console.error(`[supervisor] sin latido del hijo desde hace ${Math.round((Date.now() - lastHeartbeat) / 1000)}s`);
            lastHeartbeat = 0;
            killUnhealthy('latido ausente (event loop bloqueado o excepción en el bucle del servidor)');
        }

        const ok = await probe();
        if (stopped || !child || child.pid !== pid) continue;

        if (ok) {
            if (consecutiveFailures > 0) {
                console.log(`[supervisor] salud recuperada (pid ${pid})`);
            }
            consecutiveFailures = 0;
            markHealthy(pid);
        } else {
            consecutiveFailures++;
            if (consecutiveFailures >= HEALTH_FAILURES_BEFORE_KILL) {
                killUnhealthy('el health check no responde');
            }
        }
    }
}

function shutdown(signal) {
    if (stopped) return;
    stopped = true;
    // Un reinicio pendiente ya no debe colarse: sin esto, un SIGTERM durante
    // la ventana de backoff levantaría un servidor nuevo justo después de
    // pedir parar, y quedaría huérfano sin supervisor.
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
    console.log(`[supervisor] ${signal}: deteniendo…`);
    if (child) {
        // Aviso por el canal antes de la señal: el servidor sabe así que el
        // apagado lo pide su supervisor (no un usuario en su terminal) y
        // puede soltar recursos ajenos a la señal.
        try { child.send({ t: 'stop', graceMs: SIGKILL_GRACE_MS }); } catch { /* sin canal */ }
        // El hijo recibe la señal y hace su apagado ordenado (cierra las
        // conexiones y libera el puerto)…
        try { child.kill(signal); } catch (e) { /* ya salió */ }
        // …y si la ignora, SIGKILL: el supervisor NUNCA se va dejando al
        // hijo vivo, o el puerto queda secuestrado por un huérfano.
        killTimer = setTimeout(() => {
            try { if (child) child.kill('SIGKILL'); } catch (e) { /* ya salió */ }
            process.exit(0);
        }, SIGKILL_GRACE_MS);
    }
    setTimeout(() => process.exit(0), SIGKILL_GRACE_MS + 500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
/* Cerrar la ventana/pestaña del terminal manda SIGHUP: sin este manejador el
   supervisor muere solo y el hijo queda huérfano agarrando el puerto. */
process.on('SIGHUP', () => shutdown('SIGHUP'));

// Sólo arranca si se ejecuta directamente; importarlo desde un test no debe
// lanzar un servidor real.
if (require.main === module) {
    /* Preflight de dependencias ANTES del primer arranque: si falta una
       librería, se instala ahora (no en medio de un ciclo de reinicios) y el
       servidor arranca ya con todo. El servidor se auto-comprueba también al
       arrancar, por si alguien ejecuta `node server.js` a mano. */
    let depsOk = false;
    try {
        depsOk = ensureDeps({ loggers: { log: m => console.log(m), error: m => console.error(m) } });
    } catch (e) {
        console.error(`[supervisor] ${e && e.message ? e.message : e}`);
        process.exit(3);
    }
    if (!depsOk) {
        console.error('[supervisor] sin las dependencias instaladas no se arranca el servidor.');
        process.exit(3);
    }
    start();
    watchHealth();
}

// Clasificación de códigos de salida del hijo, aislada para poder testearla
// sin levantar procesos: 'config' no se reintenta, 'deps' se repara aquí,
// 'crash' sigue la política normal (backoff + watchdog).
function classifyExit(code) {
    if (code === 78) return 'config';   // credencial del propietario: no reintentar
    if (code === 79) return 'deps';     // falta una dependencia: instalar y relanzar
    return 'crash';
}

// Expuesto para poder testear el watchdog y la clasificación sin levantar un
// servidor real.
module.exports = {
    checkHealth,
    killUnhealthy,
    classifyExit,
    getState: () => ({
        consecutiveFailures,
        startupFailures,
        hotCrashes,
        restartAttempt,
        childHealthy,
        healthPort,
        childPid: child ? child.pid : null,
        lastHeartbeat,
        depAttempts
    })
};
