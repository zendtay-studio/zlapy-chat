/* Orden y paginación de la fila de historias de la lista de chats.
 *
 * La fila enseña las historias de los CONTACTOS primero y, después, las de
 * los demás usuarios que el servidor entrega (amigos de amigos, historias
 * públicas…). Estas últimas no se pintan todas de golpe: se muestran por
 * tandas y un «+» al final carga la siguiente. Así la fila no se llena de
 * caras ajenas ni se construye de más cuando hay muchas historias.
 *
 * Igual que `presence.js`, vive fuera del HTML para poder probarse en Node:
 * entra una lista de historias, sale qué va en cada tramo. El pintado (HTML,
 * avatares, clases) se queda en `index.html`.
 *
 * Va dentro de un IIFE porque es un <script> CLÁSICO y no debe compartir
 * `const` con los otros scripts de la página.
 */
(() => {
    'use strict';

    /* Cuántas historias ajenas se enseñan en la primera tanda. Los contactos
       no se recortan: son lo primero y lo que el usuario espera ver. */
    const PAGE = 8;

    const nombre = valor => (valor == null ? '' : String(valor));

    /**
     * Reparte las historias por origen y las ordena dentro de cada tramo.
     *
     * @param {object} opciones
     * @param {Array} opciones.stories historias (`{ from, ts, … }`)
     * @param {Array|Set} opciones.contacts contactos (`{ username }`, nombres
     *   o un `Set` de nombres: la pertenencia no debe depender del filtro de
     *   la lista visible)
     * @param {string} opciones.me nombre del usuario actual
     * @param {object} [opciones.seen] marcas vistas por usuario (`{ user: ts }`)
     * @param {(u: string) => string} [opciones.nameOf] nombre visible, para ordenar
     * @returns {{mine: Array, contacts: string[], server: string[], freshByUser: object}}
     *   `contacts` y `server` son nombres de usuario ya ordenados; `freshByUser`
     *   dice cuántas historias sin ver tiene cada uno.
     */
    function layout(opciones = {}) {
        const stories = Array.isArray(opciones.stories) ? opciones.stories : [];
        const contacts = Array.isArray(opciones.contacts) || (opciones.contacts && typeof opciones.contacts[Symbol.iterator] === 'function')
            ? opciones.contacts
            : [];
        const me = opciones.me;
        const seen = opciones.seen && typeof opciones.seen === 'object' ? opciones.seen : {};
        const nameOf = typeof opciones.nameOf === 'function' ? opciones.nameOf : nombre;

        const porUsuario = Object.create(null);
        for (const historia of stories) {
            if (!historia || !historia.from) continue;
            (porUsuario[historia.from] = porUsuario[historia.from] || []).push(historia);
        }

        const vistos = u => Number(seen[u]) || 0;
        const freshByUser = Object.create(null);
        for (const u of Object.keys(porUsuario)) {
            freshByUser[u] = porUsuario[u].filter(s => Number(s.ts) > vistos(u)).length;
        }

        const contactos = new Set();
        for (const contacto of (contacts || [])) {
            if (typeof contacto === 'string') {
                if (contacto) contactos.add(contacto);
                continue;
            }
            /* También acepta un `Set` o un iterable: la fila de historias
               usa los nombres recordados, no la lista visible filtrada. */
            if (contacto && typeof contacto === 'object' && Symbol.iterator in contacto) {
                for (const u of contacto) if (u) contactos.add(u);
                continue;
            }
            const u = contacto && contacto.username;
            if (u) contactos.add(u);
        }

        const orden = (a, b) => ((freshByUser[b] > 0) - (freshByUser[a] > 0))
            || String(nameOf(a)).localeCompare(String(nameOf(b)))
            || String(a).localeCompare(String(b));

        const ajenos = Object.keys(porUsuario)
            .filter(u => u !== me)
            .sort(orden);

        return {
            mine: porUsuario[me] || [],
            contacts: ajenos.filter(u => contactos.has(u)),
            server: ajenos.filter(u => !contactos.has(u)),
            freshByUser
        };
    }

    /**
     * Recorta la lista de historias ajenas a la tanda pedida.
     *
     * @param {string[]} lista nombres ya ordenados
     * @param {number} extra tandas adicionales que el usuario ha pedido con «+»
     * @param {number} [tamano] historias por tanda
     * @returns {{visible: string[], hidden: number}}
     */
    function page(lista, extra = 0, tamano = PAGE) {
        const items = Array.isArray(lista) ? lista : [];
        const limite = Math.max(0, Math.floor(Number(tamano) || 0))
            + Math.max(0, Math.floor(Number(extra) || 0));
        return {
            visible: items.slice(0, limite),
            hidden: Math.max(0, items.length - limite)
        };
    }

    const api = { PAGE, layout, page };
    if (typeof window === 'object' && window) window.ZlapyStoryRow = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})();
