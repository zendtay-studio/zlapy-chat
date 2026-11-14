/* Markdown para chats y descripciones: igual formato que el de las burbujas
   de Zlapy (saltos de línea, encabezados, estilos, listas y listas de tareas,
   citas, bloques de código, tablas, línea divisoria, notas al pie y escapado
   con "\").
   Por seguridad NO se activan los enlaces ni las imágenes del markdown
   ([texto](url) y ![alt](url) se muestran tal cual) ni se interpreta HTML del
   usuario: todo entra DESPUÉS de escapar y aquí sólo se generan etiquetas
   propias (b/i/s/code/pre/ul/ol/li/div/table/sup).
   Compartido por index.html y group-details.html. */
(() => {
    'use strict';

    const APOS = '&' + '#39;';
    /* Marca de cita: ">" o su versión escapada (">"), porque el texto
       que entra ya pasó por escape. */
    const MD_MARCA_CITA = new RegExp('^(\\s*)(?:>|' + '&' + 'gt;)\\s?');
    const escapeMd = value => String(value == null ? '' : value)
        .replace(/[&<>"']/g, c => ({ 38: '&' + 'amp;', 60: '&' + 'lt;', 62: '&' + 'gt;', 34: '&' + 'quot;', 39: APOS }[c.charCodeAt(0)]));

    const MD_ESC = '\u0001';
    const MD_PROTEGIDO = /(<a\s[^>]*>[\s\S]*?<\/a>|<span\s[^>]*>[\s\S]*?<\/span>|<code>[\s\S]*?<\/code>|<b>[\s\S]*?<\/b>|<i>[\s\S]*?<\/i>|<s>[\s\S]*?<\/s>|<br>)/g;
    const MD_ESTILOS = [
        [/`([^`\n]+)`/g, '<code>$1</code>'],
        [/\*\*\*([^*\n]+)\*\*\*/g, '<b><i>$1</i></b>'],
        [/\*\*([^*\n]+)\*\*/g, '<b>$1</b>'],
        [/__([^_\n]+)__/g, '<b>$1</b>'],
        [/~~([^~\n]+)~~/g, '<s>$1</s>'],
        [/\*([^*\n]+)\*/g, '<i>$1</i>'],
        [/(^|[^\w\\])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>']
    ];
    /* "\*" "\_" etc.: un carácter escapado se cambia por un marcador
       invisible que sobrevive a todo el formateo y al final se restaura
       ya escapado. */
    function mdGuardaEscapados(texto) {
        return texto.replace(/\\([\\`*_~#<>[\]()+\-.!|>{}$&])/g, (completo, car) => MD_ESC + car.charCodeAt(0) + MD_ESC);
    }
    function mdRestauraEscapados(texto) {
        return texto.replace(/\u0001(\d+)\u0001/g, (completo, car) => escapeMd(String.fromCharCode(Number(car))));
    }
    /* Estilos en línea (una línea ya escapada): código, negrita, cursiva,
       tachado y las referencias de nota al pie. */
    function mdInline(texto) {
        const partes = texto.split(MD_PROTEGIDO);
        for (let i = 0; i < partes.length; i++) {
            if (i % 2 === 1 || !partes[i]) continue;
            let salida = partes[i];
            for (const [patron, etiqueta] of MD_ESTILOS) salida = salida.replace(patron, etiqueta);
            partes[i] = salida;
        }
        return partes.join('').replace(/\[\^(\d+)\]/g, '<sup class="mdNotaPie">[$1]</sup>');
    }
    function mdListaHTML(entrada) {
        if (!entrada || !entrada.items.length) return '';
        const etiqueta = entrada.ordenada ? 'ol' : 'ul';
        let html = `<${etiqueta} class="mdLista">`;
        for (const item of entrada.items) {
            html += `<li>${item.html}`;
            if (item.hijos) html += mdListaHTML(item.hijos);
            html += '</li>';
        }
        return html + `</${etiqueta}>`;
    }
    function mdTablaHTML(columas, alineacion, filas) {
        const celda = (texto, etiqueta, col) =>
            `<${etiqueta}${alineacion[col] && alineacion[col] !== 'none' ? ` style="text-align:${alineacion[col]}"` : ''}>${texto}</${etiqueta}>`;
        let html = '<div class="mdTablaEnv"><table class="mdTabla"><thead><tr>';
        for (let col = 0; col < columas; col++) html += celda(mdInline(filas[0][col] || ''), 'th', col);
        html += '</tr></thead><tbody>';
        for (let fila = 1; fila < filas.length; fila++) {
            html += '<tr>';
            for (let col = 0; col < columas; col++) html += celda(mdInline(filas[fila][col] || ''), 'td', col);
            html += '</tr>';
        }
        return html + '</tbody></table></div>';
    }
    /* Render completo: recorre el texto línea por línea y arma los bloques
       (párrafos, encabezados, listas con sangría, citas, tablas, bloques de
       código y notas al pie). */
    /* Botón de copiar de los bloques de código: dos SVG (portapapeles y
       visto); el visto sólo se muestra con .mdCopiarListo (feedback tras
       copiar). Los handlers en línea cortan la propagación para que el
       clic no dispare el menú/selección/doble-toque de la burbuja. */
    const MD_COPIAR_CODIGO = '<button class="mdCopiar" type="button" title="Copiar código" aria-label="Copiar el código"' +
        ' onpointerdown="event.stopPropagation()"' +
        ' onclick="event.stopPropagation();copiarMdCodigo(this)">' +
        '<svg class="mdCopiarIcono" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>' +
        '<svg class="mdCopiarOk" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>' +
        '</button>';

    /* Copia el texto del bloque de código que contiene al botón. Se publica
       en window porque el onclick vive en HTML generado. */
    function copiarMdCodigo(boton) {
        const bloque = boton && boton.closest ? boton.closest('.mdCodigo') : null;
        const codigo = bloque ? bloque.querySelector('pre code') || bloque.querySelector('code') : null;
        const texto = codigo ? codigo.textContent : '';
        const listo = () => {
            boton.classList.add('mdCopiarListo');
            setTimeout(() => boton.classList.remove('mdCopiarListo'), 1600);
        };
        const fallo = () => {
            /* Recurso sin clipboard API (o permiso denegado): textarea fuera
               de pantalla + execCommand, igual que el resto de la app. */
            const auxiliar = document.createElement('textarea');
            auxiliar.value = texto;
            auxiliar.setAttribute('readonly', '');
            auxiliar.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
            document.body.appendChild(auxiliar);
            auxiliar.select();
            try { document.execCommand('copy'); listo(); } catch { }
            auxiliar.remove();
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(texto).then(listo).catch(fallo);
        else fallo();
    }
    window.copiarMdCodigo = copiarMdCodigo;

    function mdRender(fuente) {
        const lineas = fuente.split('\n');
        const salida = [];
        let para = [], lista = [], cita = [], valla = null, tabla = null;
        const cierraPara = () => { if (para.length) { salida.push(para.join('<br>')); para = []; } };
        const cierraCita = () => { if (cita.length) { salida.push(`<div class="mdCita">${cita.join('<br>')}</div>`); cita = []; } };
        const cierraTabla = () => { if (tabla) { salida.push(mdTablaHTML(tabla.columas, tabla.alineacion, tabla.filas)); tabla = null; } };
        const cierraLista = () => { while (lista.length) { const hecha = mdListaHTML(lista.pop()); if (hecha) salida.push(hecha); } };
        const cierraTodo = () => { cierraPara(); cierraCita(); cierraTabla(); cierraLista(); };
        const mdCelda = linea => linea.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        for (let i = 0; i < lineas.length; i++) {
            const linea = lineas[i];
            if (valla !== null) {
                if (/^\s*```+\s*$/.test(linea)) {
                    salida.push(`<div class="mdCodigo">${MD_COPIAR_CODIGO}<pre><code>${valla.join('\n')}</code></pre></div>`);
                    valla = null;
                } else valla.push(linea);
                continue;
            }
            if (/^\s*```/.test(linea)) { cierraTodo(); valla = []; continue; }
            const titulo = linea.match(/^\s*(#{1,6})\s+(\S.*?)\s*#*\s*$/);
            if (titulo) {
                cierraTodo();
                salida.push(`<div class="mdTitulo mdT${titulo[1].length}">${mdInline(titulo[2])}</div>`);
                continue;
            }
            if (/^\s*([-*_])\1{2,}\s*$/.test(linea)) { cierraTodo(); salida.push('<div class="mdLinea"></div>'); continue; }
            const nota = linea.match(/^\s*\[\^(\d+)\]:\s*(.*)$/);
            if (nota) {
                cierraTodo();
                salida.push(`<div class="mdNotaPieDef"><sup>[${nota[1]}]</sup> ${mdInline(nota[2])}</div>`);
                continue;
            }
            /* El marcador de cita puede venir como ">" o escapado: el texto ya
               pasó por escape antes de entrar (descripciones crudas y
               burbujas). */
            if (MD_MARCA_CITA.test(linea)) {
                cierraPara(); cierraTabla(); cierraLista();
                cita.push(mdInline(linea.replace(MD_MARCA_CITA, '')));
                continue;
            }
            const tarea = linea.match(/^\s*([-*+])\s+\[([ xX])\]\s+(.*)$/);
            const vinyeta = linea.match(/^\s*([-*+])\s+(?!\[[ xX]\])(.*)$/);
            const numerada = linea.match(/^\s*(\d+)[.)]\s+(.*)$/);
            if (tarea || vinyeta || numerada) {
                cierraPara(); cierraCita(); cierraTabla();
                const ordenada = !tarea && !vinyeta;
                const sangria = linea.match(/^\s*/)[0].replace(/\t/g, '  ').length;
                const nivel = Math.floor(sangria / 2);
                while (lista.length && lista[lista.length - 1].nivel > nivel) {
                    const cerrada = lista.pop();
                    if (lista.length) {
                        const padre = lista[lista.length - 1];
                        const ultimo = padre.items[padre.items.length - 1];
                        if (ultimo) ultimo.hijos = cerrada;
                    } else salida.push(mdListaHTML(cerrada));
                }
                const tope = lista[lista.length - 1];
                if (!tope || tope.nivel < nivel || tope.ordenada !== ordenada) {
                    lista.push({ nivel: tope ? Math.max(nivel, tope.nivel + 1) : 0, ordenada, items: [] });
                }
                const texto = tarea
                    ? `<span class="mdCheck">${tarea[2] === ' ' ? '☐' : '☑'}</span> ${mdInline(tarea[3])}`
                    : mdInline(ordenada ? numerada[2] : vinyeta[2]);
                lista[lista.length - 1].items.push({ html: texto, hijos: null });
                continue;
            }
            if (linea.includes('|') && i + 1 < lineas.length && lineas[i + 1].includes('-')
                && lineas[i + 1].includes('|') && /^[\s|:-]+$/.test(lineas[i + 1])) {
                cierraTodo();
                const columas = mdCelda(linea).length;
                const alineacion = mdCelda(lineas[i + 1]).map(seg => {
                    const izq = seg.startsWith(':'), der = seg.endsWith(':');
                    return izq && der ? 'center' : der ? 'right' : izq ? 'left' : 'none';
                });
                const filas = [mdCelda(linea)];
                i++;
                while (i + 1 < lineas.length && lineas[i + 1].includes('|')) { i++; filas.push(mdCelda(lineas[i])); }
                salida.push(mdTablaHTML(columas, alineacion, filas));
                continue;
            }
            cierraLista(); cierraCita(); cierraTabla();
            para.push(mdInline(linea));
        }
        if (valla !== null) salida.push(`<div class="mdCodigo">${MD_COPIAR_CODIGO}<pre><code>${valla.join('\n')}</code></pre></div>`);
        cierraTodo();
        return salida.join('');
    }
    /* Entradas públicas:
       decorateMessageHTML(html)      -> html YA escapado (burbujas: trae
                                        menciones/autolinks que se respetan)
       decorateMarkdownText(texto)    -> texto crudo, markdown completo
                                        (descripciones de usuario y grupo)
       decorateMarkdownInline(texto)  -> texto crudo, SOLO estilos en línea
                                        (vistas previas de la lista de chats) */
    function decorateMessageHTML(html) { return mdRestauraEscapados(mdRender(mdGuardaEscapados(html))); }
    function decorateMarkdownText(texto) { return decorateMessageHTML(escapeMd(texto)); }
    function decorateMarkdownInline(texto) { return mdRestauraEscapados(mdInline(mdGuardaEscapados(escapeMd(texto)))); }
    window.decorateMessageHTML = decorateMessageHTML;
    window.decorateMarkdownText = decorateMarkdownText;
    window.decorateMarkdownInline = decorateMarkdownInline;
})();