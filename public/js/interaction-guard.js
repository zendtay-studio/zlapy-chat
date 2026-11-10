'use strict';

const editableSelector = 'input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';

document.addEventListener('contextmenu', event => {
    const target = event.target;
    const element = target && (target.nodeType === 1 ? target : target.parentElement);
    if (!element || !element.closest(editableSelector)) event.preventDefault();
}, true);
