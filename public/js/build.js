/* Versión de compilación — ÚNICA fuente.
 *
 * La usan las dos caras de la app:
 *   · el service worker (`/js/sw.js`) para nombrar su caché: `zlapy-v202`;
 *   · Ajustes > Información técnica para enseñar la versión y la fecha.
 *
 * Al publicar se sube SOLO aquí: no hay otro número que tocar. Y como
 * `/js/sw.js` importa este archivo, cambiar la versión también hace que el
 * navegador detecte un service worker nuevo (la comprobación de actualización
 * sigue los `importScripts`).
 *
 * `self` es la ventana en la página y el ámbito global en el worker, así que
 * el mismo archivo sirve en los dos sin envoltorios ni módulos.
 */
self.ZLAPY_BUILD = '208';
self.ZLAPY_BUILD_DATE = '18 nov 2026';
