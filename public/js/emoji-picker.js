/* Selector de emojis integrado en el panel de stickers y reacciones. */
(() => {
    'use strict';

    const terms = {
        '❤️': 'corazon amor heart', '👍': 'me gusta like pulgar arriba', '👎': 'no me gusta pulgar abajo',
        '😂': 'risa feliz llorar', '🔥': 'fuego caliente', '😍': 'enamorado amor ojos corazon',
        '🥰': 'amor enamorada feliz', '😭': 'llorar triste', '😢': 'triste llorar', '😡': 'enojo enojado',
        '👏': 'aplauso', '🙏': 'gracias por favor manos', '🎉': 'fiesta celebrar', '💯': 'cien perfecto',
        '🤔': 'pensar duda', '😮': 'sorpresa', '😱': 'miedo susto', '💀': 'calavera muerto',
        '🤡': 'payaso', '💩': 'popo caca', '🤝': 'acuerdo', '👋': 'hola saludo',
        '🥳': 'fiesta cumpleaños', '🤩': 'emocionado estrella', '😴': 'dormir sueño',
        '🤮': 'vomitar asco', '🤢': 'asco enfermo', '🙄': 'ojos arriba',
        '🤷': 'no se', '💪': 'fuerza brazo', '🌹': 'rosa flor', '🍕': 'pizza',
        '🍔': 'hamburguesa', '🍻': 'cerveza brindis', '⚽': 'futbol', '🚀': 'cohete',
        '⭐': 'estrella', '✅': 'correcto check', '❌': 'incorrecto cruz'
    };

    let panel = null;
    let categories = [];
    let selectedCategory = null;
    let onSelect = null;
    let searchInput = null;
    let searchListener = null;
    const categoryData = new Map();
    const categoryRequests = new Map();
    let indexPromise = null;

    const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

    function render() {
        if (!panel || !categories.length) return;
        const search = normalize(searchInput.value.trim());
        const categoryRow = panel.querySelector('.emojiPickerCategories');
        const grid = panel.querySelector('.emojiPickerGrid');
        categoryRow.innerHTML = categories.map(category =>
            `<button type="button" class="emojiPickerCategory${category.id === selectedCategory ? ' on' : ''}" data-category="${category.id}" role="tab" aria-selected="${category.id === selectedCategory}" aria-label="${category.label}" title="${category.label}">${category.icon}</button>`
        ).join('');
        const source = search
            ? categories.flatMap(category => (categoryData.get(category.id)?.subgroups || []).flatMap(subgroup =>
                subgroup.emojis.map(item => ({ ...item, category, subgroup }))))
                .filter(item => item.emoji.includes(search) || normalize(item.name).includes(search) ||
                    normalize(item.category.label).includes(search) || normalize(item.subgroup.label).includes(search) ||
                    normalize(terms[item.emoji] || '').includes(search))
            : (categoryData.get(selectedCategory)?.subgroups || [])
                .flatMap(subgroup => subgroup.emojis.map(item => ({ ...item, category: categories.find(category => category.id === selectedCategory), subgroup })));
        grid.replaceChildren();
        const sections = new Map();
        for (const item of source) {
            const key = `${item.category.id}:${item.subgroup.id}`;
            let emojiGrid = sections.get(key);
            if (!emojiGrid) {
                const section = document.createElement('section');
                section.className = 'emojiPickerSubgroup';
                section.setAttribute('aria-label', `${item.category.label}: ${item.subgroup.label}`);
                const heading = document.createElement('h3');
                heading.className = 'emojiPickerSubgroupTitle';
                heading.textContent = search ? `${item.category.label} · ${item.subgroup.label}` : item.subgroup.label;
                emojiGrid = document.createElement('div');
                emojiGrid.className = 'emojiPickerSubgroupGrid';
                section.append(heading, emojiGrid);
                grid.appendChild(section);
                sections.set(key, emojiGrid);
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'emojiPickerEmoji';
            button.dataset.emoji = item.emoji;
            button.setAttribute('aria-label', `${terms[item.emoji] || item.name} ${item.emoji}`);
            button.textContent = item.emoji;
            button.onclick = () => {
                if (onSelect) onSelect(item.emoji);
            };
            emojiGrid.appendChild(button);
        }
        if (!source.length) {
            const empty = document.createElement('span');
            empty.className = 'emojiPickerEmpty';
            empty.textContent = 'No se encontraron emojis';
            grid.appendChild(empty);
        }
        categoryRow.querySelectorAll('[data-category]').forEach(button => {
            button.onclick = async () => {
                selectedCategory = button.dataset.category;
                searchInput.value = '';
                try {
                    await loadCategory(selectedCategory);
                    render();
                } catch (error) {
                    console.error('[emoji] No se pudo cargar la categoría:', error);
                    grid.textContent = 'No se pudo cargar esta categoría de emojis.';
                }
            };
        });
    }

    async function loadCategory(id) {
        if (categoryData.has(id)) return;
        if (categoryRequests.has(id)) return categoryRequests.get(id);
        const category = categories.find(item => item.id === id);
        if (!category || !/^[a-z0-9-]+\.json$/.test(category.file)) {
            throw new Error(`Categoría de emojis inválida: ${id}`);
        }
        const request = fetch(`/files/emoji/${category.file}`)
            .then(response => {
                if (!response.ok) throw new Error(`No se pudo cargar ${category.label} (HTTP ${response.status}).`);
                return response.json();
            })
            .then(data => {
                if (!data || data.id !== id || !Array.isArray(data.subgroups)) {
                    throw new Error(`El archivo de la categoría ${category.label} tiene un formato inválido.`);
                }
                categoryData.set(id, data);
            })
            .finally(() => categoryRequests.delete(id));
        categoryRequests.set(id, request);
        return request;
    }

    async function loadAllCategories() {
        await Promise.all(categories.map(category => loadCategory(category.id)));
    }

    function mount(container, input, onEmoji) {
        onSelect = onEmoji;
        if (panel && panel.parentElement === container && searchInput === input) {
            render();
            return;
        }
        if (searchInput && searchListener) searchInput.removeEventListener('input', searchListener);
        categories = [];
        selectedCategory = null;
        panel = container;
        searchInput = input;
        panel.classList.add('emojiPickerEmbedded');
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-label', 'Seleccionar emoji');
        panel.innerHTML = '<nav class="emojiPickerCategories" aria-label="Categorías de emojis"></nav><div class="emojiPickerDivider" role="separator" aria-hidden="true"></div><div class="emojiPickerGrid" role="list"></div>';
        const grid = panel.querySelector('.emojiPickerGrid');
        grid.textContent = 'Cargando emojis…';
        searchListener = async () => {
            try {
                if (searchInput.value.trim()) await loadAllCategories();
                if (panel && panel.contains(grid)) render();
            } catch (error) {
                console.error('[emoji] No se pudieron cargar las categorías de emojis:', error);
                if (panel && panel.contains(grid)) grid.textContent = 'No se pudieron cargar los emojis. Intenta de nuevo.';
            }
        };
        searchInput.addEventListener('input', searchListener);
        if (!indexPromise) {
            indexPromise = fetch('/files/emoji/index.json')
                .then(response => {
                    if (!response.ok) throw new Error(`No se pudo cargar el índice de emojis (HTTP ${response.status}).`);
                    return response.json();
                })
                .then(index => {
                    if (!index || !Array.isArray(index.groups) || !index.groups.length) {
                        throw new Error('El índice de emojis tiene un formato inválido.');
                    }
                    return index.groups;
                })
                .catch(error => {
                    indexPromise = null;
                    throw error;
                });
        }
        indexPromise.then(async groups => {
            if (!panel || !panel.contains(grid)) return;
            categories = groups;
            selectedCategory = categories[0].id;
            render();
            if (searchInput.value.trim()) await loadAllCategories();
            else await loadCategory(selectedCategory);
            if (panel && panel.contains(grid)) render();
        }).catch(error => {
            console.error('[emoji] No se pudo inicializar el selector:', error);
            if (panel && panel.contains(grid)) grid.textContent = 'No se pudo cargar el catálogo de emojis.';
        });
    }

    function unmount() {
        if (!panel) return;
        panel.replaceChildren();
        panel = null;
        onSelect = null;
        if (searchInput && searchListener) searchInput.removeEventListener('input', searchListener);
        searchInput = null;
        searchListener = null;
        selectedCategory = null;
    }

    window.ZlapyEmojiPicker = { mount, unmount };
})();
