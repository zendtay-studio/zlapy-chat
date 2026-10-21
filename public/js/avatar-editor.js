/* Editor de foto de perfil compartido ("Mi perfil", "Ajustes ▸ Perfil" y
   fotos de grupo).
   La imagen se ve completa dentro del recuadro: se arrastra para moverla y se
   toca un punto para que ese punto quede en el centro del recorte. El zoom
   (botones, rueda o pellizco) ajusta el encuadre y el resultado se guarda
   comprimido a 512 x 512, que es el tamaño que acepta el servidor. */
(function (global) {
  'use strict';

  const OUTPUT_SIZE = 512;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 6;
  const MAX_FILE_BYTES = 25 * 1024 * 1024;

  const ICONS = {
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M12 5v14M5 12h14"/>'
  };

  function icon(name) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  /* Lee el archivo como imagen. createImageBitmap respeta la orientación EXIF,
     así que una foto tomada en vertical no sale girada. */
  async function decode(file) {
    if (!file) throw new Error('No se seleccionó ninguna imagen.');
    if (file.type && !/^image\//i.test(file.type)) throw new Error('El archivo elegido no es una imagen.');
    if (file.size && file.size > MAX_FILE_BYTES) throw new Error('La imagen es demasiado grande (máximo 25 MB).');
    if (typeof global.createImageBitmap === 'function') {
      try {
        const bitmap = await global.createImageBitmap(file, { imageOrientation: 'from-image' });
        return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => { try { bitmap.close(); } catch (e) { } } };
      } catch (error) { /* algunos navegadores no aceptan las opciones: usamos <img> */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const element = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('No se pudo leer la imagen seleccionada.'));
        img.src = url;
      });
      return {
        source: element,
        width: element.naturalWidth || element.width,
        height: element.naturalHeight || element.height,
        release: () => URL.revokeObjectURL(url)
      };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  function open(options) {
    const opts = options || {};
    const file = opts.file;
    if (!file) return Promise.resolve(null);

    let previousOverflow = '';
    const overlay = document.createElement('div');
    overlay.id = 'avEditorOverlay';
    overlay.className = 'avEditorOverlay';
    overlay.innerHTML = `<div class="avEditorSheet" role="dialog" aria-modal="true" aria-label="Editar foto">
      <div class="avEditorTitle">Editar foto</div>
      <div class="avEditorHint">Arrastra la imagen para moverla y toca un punto para centrarlo. Usa <b>−</b> / <b>+</b> o pellizca para acercar. Se guarda en <b>512 × 512</b>.</div>
      <div class="avEditorStage"><canvas class="avEditorCanvas" width="${OUTPUT_SIZE}" height="${OUTPUT_SIZE}"></canvas></div>
      <div class="avEditorToolbar">
        <button type="button" class="avEditorIconBtn" data-zoom="out" title="Alejar" aria-label="Alejar">${icon('minus')}</button>
        <button type="button" class="avEditorIconBtn" data-zoom="in" title="Acercar" aria-label="Acercar">${icon('plus')}</button>
      </div>
      <div class="avEditorError" role="alert" aria-live="polite"></div>
      <div class="avEditorBtns">
        <button type="button" class="avEditorBtnCancel">Cancelar</button>
        <button type="button" class="avEditorBtnSave">Guardar</button>
      </div>
    </div>`;

    const sheet = overlay.querySelector('.avEditorSheet');
    const canvas = overlay.querySelector('.avEditorCanvas');
    const stage = overlay.querySelector('.avEditorStage');
    const errorBox = overlay.querySelector('.avEditorError');
    const ctx = canvas.getContext('2d');

    let image = null;
    let zoom = 1;
    let focusX = 0;
    let focusY = 0;
    let closed = false;

    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);

    const promise = new Promise(resolve => {
      function finish(value) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        document.body.style.overflow = previousOverflow;
        if (image && image.release) image.release();
        resolve(value);
      }
      function onKey(event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(null);
        }
      }
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('click', event => { if (event.target === overlay) finish(null); });
      overlay.querySelector('.avEditorBtnCancel').onclick = () => finish(null);
      overlay.querySelector('.avEditorBtnSave').onclick = () => {
        if (!image) return;
        finish({ dataUrl: exportImage() });
      };
      overlay.querySelectorAll('[data-zoom]').forEach(button => {
        button.onclick = () => setZoom(zoom * (button.dataset.zoom === 'in' ? 1.2 : 1 / 1.2));
      });
    });

    /* --- Geometría del recorte --- */
    function baseScale() {
      return Math.min(OUTPUT_SIZE / image.width, OUTPUT_SIZE / image.height);
    }

    function currentScale() {
      return baseScale() * zoom;
    }

    // Lado del recorte en píxeles de la imagen original.
    function cropSide() {
      return Math.min(OUTPUT_SIZE / currentScale(), image.width, image.height);
    }

    function clampFocus() {
      const side = cropSide();
      const half = side / 2;
      focusX = image.width > side ? Math.max(half, Math.min(image.width - half, focusX)) : image.width / 2;
      focusY = image.height > side ? Math.max(half, Math.min(image.height - half, focusY)) : image.height / 2;
    }

    function setZoom(next) {
      if (!image) return;
      zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
      clampFocus();
      render();
    }

    function imageLeft() {
      return OUTPUT_SIZE / 2 - focusX * currentScale();
    }

    function imageTop() {
      return OUTPUT_SIZE / 2 - focusY * currentScale();
    }

    function render() {
      if (!image) return;
      clampFocus();
      const scale = currentScale();
      const width = image.width * scale;
      const height = image.height * scale;
      const left = imageLeft();
      const top = imageTop();
      ctx.clearRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
      ctx.fillStyle = '#0b0f13';
      ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
      ctx.drawImage(image.source, left, top, width, height);

      // Recuadro de recorte: se oscurece todo lo que queda fuera.
      const sidePx = Math.min(OUTPUT_SIZE, cropSide() * scale);
      const x = OUTPUT_SIZE / 2 - sidePx / 2;
      const y = OUTPUT_SIZE / 2 - sidePx / 2;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.58)';
      ctx.beginPath();
      ctx.rect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
      ctx.rect(x, y, sidePx, sidePx);
      ctx.fill('evenodd');
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, sidePx - 2, sidePx - 2);
      ctx.restore();
    }

    function exportImage() {
      const side = cropSide();
      const out = document.createElement('canvas');
      out.width = out.height = OUTPUT_SIZE;
      const outCtx = out.getContext('2d');
      outCtx.fillStyle = '#0b0f13';
      outCtx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
      outCtx.drawImage(
        image.source,
        focusX - side / 2, focusY - side / 2, side, side,
        0, 0, OUTPUT_SIZE, OUTPUT_SIZE
      );
      return out.toDataURL('image/jpeg', 0.82);
    }

    /* --- Gestos: arrastrar para mover, tocar para centrar, pellizcar para zoom --- */
    const pointers = new Map();
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startFocusX = 0;
    let startFocusY = 0;
    let pinchStart = 0;
    let pinchZoom = 1;

    function toCanvas(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const ratio = rect.width ? OUTPUT_SIZE / rect.width : 1;
      return { x: (clientX - rect.left) * ratio, y: (clientY - rect.top) * ratio };
    }

    function imagePointAt(clientX, clientY) {
      const point = toCanvas(clientX, clientY);
      const scale = currentScale();
      return {
        x: (point.x - imageLeft()) / scale,
        y: (point.y - imageTop()) / scale
      };
    }

    stage.addEventListener('pointerdown', event => {
      if (event.button != null && event.button !== 0) return;
      stage.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      startFocusX = focusX;
      startFocusY = focusY;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStart = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        pinchZoom = zoom;
      }
      event.preventDefault();
    });

    stage.addEventListener('pointermove', event => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (Math.abs(event.clientX - startX) > 4 || Math.abs(event.clientY - startY) > 4) moved = true;
      if (pointers.size === 1) {
        const scale = currentScale();
        const ratio = canvas.getBoundingClientRect().width ? OUTPUT_SIZE / canvas.getBoundingClientRect().width : 1;
        focusX = startFocusX - (event.clientX - startX) * ratio / scale;
        focusY = startFocusY - (event.clientY - startY) * ratio / scale;
        render();
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const factor = distance / pinchStart;
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const before = imagePointAt(midX, midY);
        zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchZoom * factor));
        const scale = currentScale();
        const point = toCanvas(midX, midY);
        // El punto que estaba bajo los dedos se queda bajo los dedos.
        focusX = before.x - (point.x - OUTPUT_SIZE / 2) / scale;
        focusY = before.y - (point.y - OUTPUT_SIZE / 2) / scale;
        render();
      }
      event.preventDefault();
    });

    const releasePointer = event => {
      const wasSingle = pointers.size === 1;
      pointers.delete(event.pointerId);
      if (wasSingle && !moved && image) {
        // Toque: ese punto queda en el centro del recorte.
        const point = imagePointAt(event.clientX, event.clientY);
        focusX = point.x;
        focusY = point.y;
        render();
      }
      if (pointers.size < 2) pinchStart = 0;
    };
    stage.addEventListener('pointerup', releasePointer);
    stage.addEventListener('pointercancel', releasePointer);
    stage.addEventListener('lostpointercapture', releasePointer);

    stage.addEventListener('wheel', event => {
      if (!image) return;
      event.preventDefault();
      const before = imagePointAt(event.clientX, event.clientY);
      zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
      const scale = currentScale();
      const point = toCanvas(event.clientX, event.clientY);
      focusX = before.x - (point.x - OUTPUT_SIZE / 2) / scale;
      focusY = before.y - (point.y - OUTPUT_SIZE / 2) / scale;
      render();
    }, { passive: false });

    decode(file).then(decoded => {
      image = decoded;
      focusX = image.width / 2;
      focusY = image.height / 2;
      render();
      const saveButton = overlay.querySelector('.avEditorBtnSave');
      if (saveButton) saveButton.focus();
    }).catch(error => {
      errorBox.textContent = error.message || 'No se pudo abrir la imagen.';
      overlay.querySelector('.avEditorBtnSave').disabled = true;
      if (typeof opts.onError === 'function') opts.onError(error);
    });

    return promise;
  }

  global.ZlapyAvatarEditor = { open };
})(window);
