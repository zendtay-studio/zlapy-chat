(function (global) {
    'use strict';

    const SIZE = 256;
    const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
    const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
    const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
    const VIDEO_SECONDS_MAX = 10;
    const VIDEO_FPS = 8;
    const WEBP_QUALITY = .50;
    let activeEditorCancel = null;

    function formatMegabytes(bytes) {
        return `${bytes / (1024 * 1024)} MB`;
    }

    function element(tag, attributes = {}) {
        const node = document.createElement(tag);
        for (const [name, value] of Object.entries(attributes)) {
            if (name === 'class') node.className = value;
            else node.setAttribute(name, value);
        }
        return node;
    }

    function loadImage(file) {
        return new Promise((resolve, reject) => {
            const objectUrl = URL.createObjectURL(file);
            const image = new Image();
            image.onload = () => resolve({
                source: image,
                width: image.naturalWidth,
                height: image.naturalHeight,
                release: () => URL.revokeObjectURL(objectUrl)
            });
            image.onerror = () => {
                URL.revokeObjectURL(objectUrl);
                reject(new Error('No se pudo abrir la imagen.'));
            };
            image.src = objectUrl;
        });
    }

    function loadVideo(file) {
        return new Promise((resolve, reject) => {
            const objectUrl = URL.createObjectURL(file);
            const video = document.createElement('video');
            video.preload = 'metadata';
            video.muted = true;
            video.playsInline = true;
            const fail = () => {
                URL.revokeObjectURL(objectUrl);
                reject(new Error('Este navegador no puede abrir ese video. Prueba con MP4 o WebM.'));
            };
            video.onerror = fail;
            video.onloadedmetadata = () => {
                if (!Number.isFinite(video.duration) || video.duration < .15 || !video.videoWidth || !video.videoHeight) {
                    fail();
                    return;
                }
                resolve({
                    source: video,
                    width: video.videoWidth,
                    height: video.videoHeight,
                    duration: video.duration,
                    release: () => {
                        video.pause();
                        video.removeAttribute('src');
                        video.load();
                        URL.revokeObjectURL(objectUrl);
                    }
                });
            };
            video.src = objectUrl;
        });
    }

    function open(file) {
        if (!file) return Promise.resolve(null);
        const type = String(file.type || '').toLowerCase();
        const isVideo = type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name || '');
        const isGif = type === 'image/gif' || /\.gif$/i.test(file.name || '');
        const limit = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
        if (file.size > limit)
            return Promise.reject(new Error(isVideo
                ? `El video no puede superar ${formatMegabytes(MAX_VIDEO_BYTES)}.`
                : `La imagen no puede superar ${formatMegabytes(MAX_IMAGE_BYTES)}.`));
        if (isGif && file.size > MAX_OUTPUT_BYTES)
            return Promise.reject(new Error(`El GIF debe pesar como máximo ${formatMegabytes(MAX_OUTPUT_BYTES)}.`));

        const ready = isVideo ? loadVideo(file) : loadImage(file);
        return ready.then(asset => {
            if (isGif && (asset.width !== SIZE || asset.height !== SIZE)) {
                asset.release();
                throw new Error(`Los GIF animados se conservan sin cambios y deben medir ${SIZE} × ${SIZE}. Para recortarlos, usa un video o una imagen.`);
            }
            return openEditor(file, asset, { isVideo, isGif });
        });
    }

    function openEditor(file, asset, options) {
        const landing = document.getElementById('stickerCreatorLanding');
        const intro = landing && landing.querySelector('.stickerCreatorIntro');
        const toolbarTitle = document.getElementById('stickerCreatorTitle');
        const editorContent = element('div', { id: 'stickerEditorContent' });
        const sheet = element('section', { class: 'stickerEditorSheet', 'aria-label': 'Editar stricker' });
        const title = options.isVideo ? 'Recortar video para stricker' : options.isGif ? 'Crear stricker GIF' : 'Recortar stricker';
        const previousTitle = toolbarTitle ? toolbarTitle.textContent : '';
        const previousIntroHidden = intro ? intro.hidden : false;
        if (!landing || !intro || !toolbarTitle) {
            asset.release();
            return Promise.reject(new Error('No se pudo abrir el editor dentro del creador de strickers.'));
        }
        toolbarTitle.textContent = title;
        const hint = element('div', { class: 'stickerEditorHint' });
        hint.textContent = options.isVideo
            ? `Pellizca para acercar y ajusta el tramo en la línea de tiempo. Se tomarán los fotogramas del tramo seleccionado directamente del video y se convertirán en un WebP animado de ${SIZE} × ${SIZE} (máximo ${VIDEO_SECONDS_MAX} segundos a ${VIDEO_FPS} FPS).`
            : options.isGif ? `Este GIF ya mide ${SIZE} × ${SIZE}. Se conservará su animación.` :
                `Pellizca para acercar o alejar y arrastra para encuadrar. Se comprimirá en WebP de ${SIZE} × ${SIZE}.`;
        const stage = element('div', { class: 'stickerEditorStage', tabindex: '0', 'aria-label': 'Vista previa cuadrada. Pellizca para cambiar el zoom y arrastra para encuadrar.' });
        const canvas = element('canvas', { class: 'stickerEditorCanvas', width: SIZE, height: SIZE });
        const context = canvas.getContext('2d');
        if (!context) {
            asset.release();
            toolbarTitle.textContent = previousTitle;
            return Promise.reject(new Error('No se pudo preparar la vista previa del stricker.'));
        }
        stage.appendChild(canvas);

        const controls = element('div', { class: 'stickerEditorControls' });
        let trimRail = null;
        let trimSelection = null;
        let startHandle = null;
        let endHandle = null;
        let startTimeLabel = null;
        let endTimeLabel = null;
        let playhead = null;
        let videoPreview = null;
        let trimStart = 0;
        let trimEnd = 0;
        let minimumClip = .25;
        let trimPreviewTimer = null;
        let previewVersion = 0;
        let previewAnimationFrame = 0;
        let publishEnabled = false;
        const publishToggle = element('div', { class: 'stickerEditorPublishToggle' });
        const publishSwitch = element('button', { type: 'button', class: 'tgl stickerEditorSwitch', role: 'switch', 'aria-checked': 'false', 'aria-label': 'Publicar también en la biblioteca de Zlapy' });
        publishToggle.append(publishSwitch, document.createTextNode('Publicar también en la biblioteca de Zlapy'));
        const publishHint = element('div', { class: 'stickerEditorPublishHint' });
        publishHint.textContent = 'Será visible para otras personas. Añade etiquetas para que puedan encontrarlo.';
        const tagBox = element('div', { class: 'stickerEditorTagBox', hidden: '' });
        const tagInput = element('input', { type: 'text', maxlength: '24', placeholder: 'Escribe una etiqueta y pulsa Enter', 'aria-label': 'Etiqueta para publicar en Zlapy' });
        const tagChips = element('div', { class: 'stickerEditorTagChips' });
        const tagError = element('div', { class: 'stickerEditorTagError', 'aria-live': 'polite' });
        const publishTags = [];
        tagBox.append(tagChips, tagInput, tagError);
        publishHint.hidden = true;
        publishSwitch.addEventListener('click', () => {
            publishEnabled = !publishEnabled;
            publishSwitch.setAttribute('aria-checked', String(publishEnabled));
            publishToggle.classList.toggle('on', publishEnabled);
            tagBox.hidden = !publishEnabled;
            publishHint.hidden = !publishEnabled;
        });
        tagInput.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const tag = tagInput.value.trim().replace(/^#/, '').normalize('NFC').toLowerCase();
            if (!tag) return;
            if (!/^[\p{L}\p{N}_-]{1,24}$/u.test(tag)) {
                tagError.textContent = 'Usa hasta 24 letras o números, sin espacios.';
                return;
            }
            if (publishTags.includes(tag)) { tagInput.value = ''; return; }
            if (publishTags.length >= 8) {
                tagError.textContent = 'Puedes añadir hasta 8 etiquetas.';
                return;
            }
            publishTags.push(tag);
            tagInput.value = '';
            tagError.textContent = '';
            const chip = element('span', { class: 'stickerEditorTag' });
            chip.append(document.createTextNode('#' + tag));
            const remove = element('button', { type: 'button', 'aria-label': 'Quitar etiqueta ' + tag });
            remove.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4-6.3-6.3-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"></path></svg>';
            remove.onclick = () => {
                publishTags.splice(publishTags.indexOf(tag), 1);
                chip.remove();
            };
            chip.appendChild(remove);
            tagChips.appendChild(chip);
        });
        if (options.isVideo) {
            videoPreview = asset.source;
            videoPreview.hidden = true;
            videoPreview.controls = false;
            const clipLimit = Math.min(VIDEO_SECONDS_MAX, asset.duration);
            minimumClip = Math.min(.25, clipLimit);
            trimStart = 0;
            trimEnd = clipLimit;
            const timelineCaption = element('div', { class: 'stickerEditorTimelineCaption' });
            timelineCaption.textContent = `Video de ${asset.duration.toFixed(1)} s. Arrastra el tramo o sus extremos para elegir qué parte usar.`;
            trimRail = element('div', { class: 'stickerTrimRail', role: 'group', 'aria-label': 'Línea de tiempo del video' });
            trimSelection = element('div', { class: 'stickerTrimSelection' });
            playhead = element('div', { class: 'stickerTrimPlayhead', 'aria-hidden': 'true' });
            startHandle = element('button', { type: 'button', class: 'stickerTrimHandle stickerTrimStart', role: 'slider', tabindex: '0', 'aria-label': 'Inicio del stricker' });
            endHandle = element('button', { type: 'button', class: 'stickerTrimHandle stickerTrimEnd', role: 'slider', tabindex: '0', 'aria-label': 'Final del stricker' });
            trimRail.append(trimSelection, playhead, startHandle, endHandle);
            const timelineTimes = element('div', { class: 'stickerEditorTimelineTimes' });
            startTimeLabel = element('span');
            endTimeLabel = element('span');
            timelineTimes.append(startTimeLabel, endTimeLabel);
            controls.append(timelineCaption, trimRail, timelineTimes);
        }

        const timeLabel = element('div', { class: 'stickerEditorTime', 'aria-live': 'polite' });
        const error = element('div', { class: 'stickerEditorError', role: 'status', 'aria-live': 'polite' });
        const actions = element('div', { class: 'mBtns stickerEditorActions' });
        const cancel = element('button', { type: 'button', class: 'mBtn' });
        cancel.textContent = 'Cancelar';
        const save = element('button', { type: 'button', class: 'mBtn ok stickerEditorSave' });
        save.textContent = 'Crear stricker';
        actions.append(cancel, save);
        sheet.append(hint, stage);
        if (controls.childElementCount) sheet.appendChild(controls);
        sheet.appendChild(timeLabel);
        if (videoPreview) sheet.appendChild(videoPreview);
        sheet.append(publishToggle, publishHint, tagBox, error, actions);
        editorContent.appendChild(sheet);

        intro.hidden = true;
        landing.appendChild(editorContent);

        let zoom = 1;
        let focusX = asset.width / 2;
        let focusY = asset.height / 2;
        const stagePointers = new Map();
        let panPointer = null;
        let pinchGesture = null;
        let timelinePointer = null;
        let disposed = false;
        return new Promise((resolve, reject) => {
            function close(value, failure) {
                if (disposed) return;
                disposed = true;
                document.removeEventListener('keydown', onKey);
                clearTimeout(trimPreviewTimer);
                cancelAnimationFrame(previewAnimationFrame);
                previewVersion++;
                editorContent.remove();
                intro.hidden = previousIntroHidden;
                toolbarTitle.textContent = previousTitle;
                if (activeEditorCancel === cancelEditor) activeEditorCancel = null;
                asset.release();
                if (failure) reject(failure);
                else resolve(value);
            }
            function cancelEditor() { close(null); }

            function onKey(event) {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    close(null);
                }
            }

            function scaleFor(sourceWidth = asset.width, sourceHeight = asset.height) {
                return Math.max(SIZE / sourceWidth, SIZE / sourceHeight) * zoom;
            }

            function clampFocus() {
                const cropSide = SIZE / scaleFor();
                focusX = asset.width > cropSide
                    ? Math.max(cropSide / 2, Math.min(asset.width - cropSide / 2, focusX))
                    : asset.width / 2;
                focusY = asset.height > cropSide
                    ? Math.max(cropSide / 2, Math.min(asset.height - cropSide / 2, focusY))
                    : asset.height / 2;
            }

            function zoomAt(nextZoom, point) {
                const center = point || { x: SIZE / 2, y: SIZE / 2 };
                const sourceX = focusX + (center.x - SIZE / 2) / scaleFor();
                const sourceY = focusY + (center.y - SIZE / 2) / scaleFor();
                zoom = Math.max(1, Math.min(5, nextZoom));
                const scale = scaleFor();
                focusX = sourceX - (center.x - SIZE / 2) / scale;
                focusY = sourceY - (center.y - SIZE / 2) / scale;
                clampFocus();
                draw();
            }

            function draw(source = asset.source) {
                drawInto(context, source, asset.width, asset.height);
            }

            function drawInto(targetContext, source, sourceWidth, sourceHeight) {
                const scale = scaleFor();
                const x = SIZE / 2 - focusX * scale;
                const y = SIZE / 2 - focusY * scale;
                targetContext.clearRect(0, 0, SIZE, SIZE);
                targetContext.drawImage(source, x, y, sourceWidth * scale, sourceHeight * scale);
            }

            function seek(targetAsset, time) {
                const video = targetAsset.source;
                if (Math.abs(video.currentTime - time) < .02 && !video.seeking && video.readyState >= 2)
                    return Promise.resolve();
                if (Math.abs(video.currentTime - time) < .02 && !video.seeking) {
                    return new Promise((resolveSeek, rejectSeek) => {
                        const timeout = setTimeout(() => {
                            video.removeEventListener('loadeddata', done);
                            rejectSeek(new Error('No se pudo leer un fotograma del video.'));
                        }, 5000);
                        const done = () => {
                            clearTimeout(timeout);
                            video.removeEventListener('loadeddata', done);
                            resolveSeek();
                        };
                        video.addEventListener('loadeddata', done, { once: true });
                    });
                }
                return new Promise((resolveSeek, rejectSeek) => {
                    const timeout = setTimeout(() => {
                        video.removeEventListener('seeked', done);
                        rejectSeek(new Error('No se pudo leer un fotograma del video.'));
                    }, 5000);
                    const done = () => {
                        clearTimeout(timeout);
                        video.removeEventListener('seeked', done);
                        resolveSeek();
                    };
                    video.addEventListener('seeked', done, { once: true });
                    video.currentTime = Math.max(0, Math.min(targetAsset.duration, time));
                });
            }

            function waitForVideoTime(time) {
                return new Promise((resolve, reject) => {
                    let frameId = 0;
                    let timerId = 0;
                    const finish = failure => {
                        cancelAnimationFrame(frameId);
                        clearTimeout(timerId);
                        if (failure) reject(failure);
                        else resolve();
                    };
                    const check = () => {
                        if (disposed) return finish(new Error('Conversión cancelada.'));
                        if (videoPreview.currentTime >= time) return finish();
                        if (videoPreview.paused || videoPreview.ended)
                            return finish(new Error('La reproducción se detuvo antes de completar el tramo.'));
                        frameId = requestAnimationFrame(check);
                    };
                    timerId = setTimeout(() => finish(new Error('Se agotó el tiempo al leer el tramo de video.')), 12000);
                    check();
                });
            }

            function updatePlayhead() {
                if (!options.isVideo || !playhead) return;
                const time = videoPreview.currentTime;
                playhead.style.left = `${time / asset.duration * 100}%`;
                playhead.hidden = time < trimStart || time > trimEnd;
            }

            function animatePlayhead() {
                cancelAnimationFrame(previewAnimationFrame);
                const tick = () => {
                    if (disposed || videoPreview.paused) return;
                    updatePlayhead();
                    previewAnimationFrame = requestAnimationFrame(tick);
                };
                previewAnimationFrame = requestAnimationFrame(tick);
            }

            async function playTrimmedPreview() {
                const version = ++previewVersion;
                videoPreview.pause();
                cancelAnimationFrame(previewAnimationFrame);
                error.textContent = '';
                try {
                    await seek(asset, trimStart);
                    if (disposed || version !== previewVersion) return;
                    draw();
                    updatePlayhead();
                    await videoPreview.play();
                    if (disposed || version !== previewVersion) {
                        videoPreview.pause();
                        return;
                    }
                    animatePlayhead();
                } catch (failure) {
                    if (!disposed && version === previewVersion)
                        error.textContent = failure.message || 'No se pudo reproducir la vista previa del video.';
                }
            }

            function updateTime() {
                if (!options.isVideo) return;
                const startPercent = trimStart / asset.duration * 100;
                const endPercent = trimEnd / asset.duration * 100;
                trimSelection.style.left = `${startPercent}%`;
                trimSelection.style.width = `${endPercent - startPercent}%`;
                startHandle.style.left = `${startPercent}%`;
                endHandle.style.left = `${endPercent}%`;
                updatePlayhead();
                startTimeLabel.textContent = `${formatTime(trimStart)} · Inicio`;
                endTimeLabel.textContent = `${formatTime(trimEnd)} · Final`;
                startHandle.setAttribute('aria-valuemin', String(minimumTrimStart()));
                startHandle.setAttribute('aria-valuemax', String(Math.max(0, trimEnd - minimumClip)));
                startHandle.setAttribute('aria-valuenow', String(trimStart));
                startHandle.setAttribute('aria-valuetext', formatTime(trimStart));
                endHandle.setAttribute('aria-valuemin', String(trimStart + minimumClip));
                endHandle.setAttribute('aria-valuemax', String(Math.min(asset.duration, trimStart + VIDEO_SECONDS_MAX)));
                endHandle.setAttribute('aria-valuenow', String(trimEnd));
                endHandle.setAttribute('aria-valuetext', formatTime(trimEnd));
                const length = trimEnd - trimStart;
                timeLabel.textContent = `Se usará ${formatTime(trimStart)}–${formatTime(trimEnd)} (${length.toFixed(1)} s de ${asset.duration.toFixed(1)} s).`;
                clearTimeout(trimPreviewTimer);
                trimPreviewTimer = setTimeout(playTrimmedPreview, 140);
            }

            function minimumTrimStart() {
                return Math.max(0, trimEnd - VIDEO_SECONDS_MAX);
            }

            function formatTime(seconds) {
                const whole = Math.floor(seconds);
                const tenths = Math.floor((seconds - whole) * 10);
                return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}.${tenths}`;
            }

            function exportImage() {
                return new Promise((resolveExport, rejectExport) => canvas.toBlob(blob => {
                    if (!blob) rejectExport(new Error('No se pudo comprimir la imagen.'));
                    else if (blob.type !== 'image/webp') rejectExport(new Error('Este navegador no puede crear imágenes WebP.'));
                    else if (blob.size > MAX_OUTPUT_BYTES) rejectExport(new Error(`El stricker supera el máximo de ${formatMegabytes(MAX_OUTPUT_BYTES)}.`));
                    else resolveExport(new File([blob], 'stricker.webp', { type: 'image/webp' }));
                }, 'image/webp', .50));
            }

            async function exportVideo() {
                if (!global.AnimatedWebP || typeof global.AnimatedWebP.mux !== 'function')
                    throw new Error('No se cargó el codificador WebP animado. Recarga la página e inténtalo otra vez.');
                videoPreview.pause();
                cancelAnimationFrame(previewAnimationFrame);
                clearTimeout(trimPreviewTimer);
                previewVersion++;
                const start = trimStart;
                const duration = trimEnd - trimStart;
                const frameCount = Math.max(1, Math.ceil(duration * VIDEO_FPS));
                if (duration > VIDEO_SECONDS_MAX || start + duration > asset.duration + .02)
                    throw new Error(`El tramo de video debe durar como máximo ${VIDEO_SECONDS_MAX} segundos.`);
                timeLabel.textContent = 'Preparando el WebP animado del tramo…';
                return encodeAnimatedWebP(frameCount, start);
            }

            async function encodeAnimatedWebP(frameCount, startAt) {
                const frames = [];
                const frameDuration = Math.round(1000 / VIDEO_FPS);
                await seek(asset, startAt);
                try {
                    await videoPreview.play();
                    for (let frame = 0; frame < frameCount; frame++) {
                        await waitForVideoTime(startAt + frame / VIDEO_FPS);
                        if (disposed) throw new Error('Conversión cancelada.');
                        draw();
                        const blob = await new Promise((resolveFrame, rejectFrame) => canvas.toBlob(
                            value => value ? resolveFrame(value) : rejectFrame(new Error('No se pudo comprimir un fotograma WebP.')),
                            'image/webp',
                            WEBP_QUALITY
                        ));
                        if (blob.type !== 'image/webp')
                            throw new Error('Este navegador no puede crear fotogramas WebP.');
                        frames.push({ bytes: new Uint8Array(await blob.arrayBuffer()), duration: frameDuration });
                        if (!disposed)
                            timeLabel.textContent = `Creando WebP animado… ${Math.round((frame + 1) / frameCount * 100)}%`;
                    }
                } finally {
                    videoPreview.pause();
                }
                const encoded = global.AnimatedWebP.mux(frames, SIZE, SIZE);
                if (encoded.byteLength > MAX_OUTPUT_BYTES)
                    throw new Error(`El WebP animado supera el máximo de ${formatMegabytes(MAX_OUTPUT_BYTES)}. Recorta un tramo más corto.`);
                return new File([encoded], 'stricker.webp', { type: 'image/webp' });
            }

            document.addEventListener('keydown', onKey);
            activeEditorCancel = cancelEditor;
            cancel.onclick = () => close(null);
            function changeTrimHandle(handle, event) {
                if (!options.isVideo || !['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const step = event.shiftKey ? 1 : .1;
                if (handle === startHandle) {
                    if (event.key === 'Home') trimStart = minimumTrimStart();
                    else if (event.key === 'End') trimStart = Math.max(0, trimEnd - minimumClip);
                    else trimStart += event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -step : step;
                    trimStart = Math.max(minimumTrimStart(), Math.min(trimEnd - minimumClip, trimStart));
                } else {
                    if (event.key === 'Home') trimEnd = trimStart + minimumClip;
                    else if (event.key === 'End') trimEnd = Math.min(asset.duration, trimStart + VIDEO_SECONDS_MAX);
                    else trimEnd += event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -step : step;
                    trimEnd = Math.max(trimStart + minimumClip, Math.min(asset.duration, trimStart + VIDEO_SECONDS_MAX, trimEnd));
                }
                updateTime();
            }
            function timelineValue(event) {
                const rect = trimRail.getBoundingClientRect();
                return Math.max(0, Math.min(asset.duration, ((event.clientX - rect.left) / rect.width) * asset.duration));
            }
            function updateTrimFromPointer(event) {
                if (!timelinePointer || timelinePointer.id !== event.pointerId) return;
                const at = timelineValue(event);
                if (timelinePointer.mode === 'start')
                    trimStart = Math.max(minimumTrimStart(), Math.min(at, trimEnd - minimumClip));
                else if (timelinePointer.mode === 'end')
                    trimEnd = Math.max(trimStart + minimumClip, Math.min(asset.duration, trimStart + VIDEO_SECONDS_MAX, at));
                else {
                    const length = trimEnd - trimStart;
                    trimStart = Math.max(0, Math.min(asset.duration - length, at - timelinePointer.offset));
                    trimEnd = trimStart + length;
                }
                updateTime();
            }
            trimRail?.addEventListener('pointerdown', event => {
                if (event.button !== undefined && event.button !== 0) return;
                const target = event.target;
                const at = timelineValue(event);
                const selectionStart = trimStart;
                if (target === startHandle) timelinePointer = { id: event.pointerId, mode: 'start' };
                else if (target === endHandle) timelinePointer = { id: event.pointerId, mode: 'end' };
                else if (target === trimSelection) timelinePointer = { id: event.pointerId, mode: 'move', offset: at - selectionStart };
                else {
                    const nearStart = Math.abs(at - selectionStart) <= Math.abs(at - selectionEnd);
                    timelinePointer = { id: event.pointerId, mode: nearStart ? 'start' : 'end' };
                }
                trimRail.setPointerCapture(event.pointerId);
                updateTrimFromPointer(event);
            });
            trimRail?.addEventListener('pointermove', updateTrimFromPointer);
            const stopTimelineDrag = event => {
                if (timelinePointer && timelinePointer.id === event.pointerId) {
                    timelinePointer = null;
                    updateTime();
                }
            };
            trimRail?.addEventListener('pointerup', stopTimelineDrag);
            trimRail?.addEventListener('pointercancel', stopTimelineDrag);
            startHandle?.addEventListener('keydown', event => changeTrimHandle(startHandle, event));
            endHandle?.addEventListener('keydown', event => changeTrimHandle(endHandle, event));
            videoPreview?.addEventListener('timeupdate', () => {
                draw();
                updatePlayhead();
                if (!videoPreview.paused && videoPreview.currentTime >= trimEnd) {
                    videoPreview.pause();
                    cancelAnimationFrame(previewAnimationFrame);
                    videoPreview.currentTime = trimEnd;
                    updatePlayhead();
                }
            });
            function stagePoint(point) {
                const rect = stage.getBoundingClientRect();
                return {
                    x: (point.x - rect.left) * SIZE / rect.width,
                    y: (point.y - rect.top) * SIZE / rect.height
                };
            }
            stage.addEventListener('wheel', event => {
                if (options.isGif) return;
                event.preventDefault();
                zoomAt(zoom * Math.exp(-event.deltaY * .002), stagePoint({ x: event.clientX, y: event.clientY }));
            }, { passive: false });
            stage.addEventListener('keydown', event => {
                if (options.isGif || !['+', '=', '-', '_'].includes(event.key)) return;
                event.preventDefault();
                zoomAt(zoom * (event.key === '-' || event.key === '_' ? .9 : 1.1));
            });
            function beginPinch() {
                const points = Array.from(stagePointers.values()).slice(0, 2);
                if (points.length !== 2) return;
                const first = stagePoint(points[0]);
                const second = stagePoint(points[1]);
                const centerX = (first.x + second.x) / 2;
                const centerY = (first.y + second.y) / 2;
                const scale = scaleFor();
                pinchGesture = {
                    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
                    zoom,
                    sourceX: focusX + (centerX - SIZE / 2) / scale,
                    sourceY: focusY + (centerY - SIZE / 2) / scale
                };
                panPointer = null;
            }
            function updateStageGesture() {
                if (stagePointers.size >= 2 && pinchGesture) {
                    const points = Array.from(stagePointers.values()).slice(0, 2);
                    const first = stagePoint(points[0]);
                    const second = stagePoint(points[1]);
                    const centerX = (first.x + second.x) / 2;
                    const centerY = (first.y + second.y) / 2;
                    const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
                    zoom = Math.max(1, Math.min(5, pinchGesture.zoom * distance / pinchGesture.distance));
                    const scale = scaleFor();
                    focusX = pinchGesture.sourceX - (centerX - SIZE / 2) / scale;
                    focusY = pinchGesture.sourceY - (centerY - SIZE / 2) / scale;
                    clampFocus();
                    draw();
                    return;
                }
                if (!panPointer || !stagePointers.has(panPointer.id)) return;
                const point = stagePointers.get(panPointer.id);
                const rect = stage.getBoundingClientRect();
                const scale = scaleFor();
                focusX -= (point.x - panPointer.x) * SIZE / rect.width / scale;
                focusY -= (point.y - panPointer.y) * SIZE / rect.height / scale;
                panPointer = { id: panPointer.id, x: point.x, y: point.y };
                clampFocus();
                draw();
            }
            stage.addEventListener('pointerdown', event => {
                if (options.isGif) return;
                stage.setPointerCapture(event.pointerId);
                stagePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
                if (stagePointers.size >= 2) beginPinch();
                else panPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
            });
            stage.addEventListener('pointermove', event => {
                if (!stagePointers.has(event.pointerId)) return;
                stagePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
                updateStageGesture();
            });
            const finishStagePointer = event => {
                stagePointers.delete(event.pointerId);
                pinchGesture = null;
                if (stagePointers.size === 1) {
                    const [id, point] = stagePointers.entries().next().value;
                    panPointer = { id, x: point.x, y: point.y };
                } else {
                    panPointer = null;
                }
                if (stagePointers.size >= 2) beginPinch();
            };
            stage.addEventListener('pointerup', finishStagePointer);
            stage.addEventListener('pointercancel', finishStagePointer);
            save.onclick = async () => {
                save.disabled = true;
                cancel.disabled = true;
                error.textContent = '';
                try {
                    let output;
                    if (options.isGif) output = file;
                    else if (options.isVideo) output = await exportVideo();
                    else output = await exportImage();
                    if (publishEnabled && !publishTags.length)
                        throw new Error('Añade al menos una etiqueta o desactiva la publicación en Zlapy.');
                    if (!disposed) close({ file: output, publish: publishEnabled, tags: publishTags.slice() });
                } catch (failure) {
                    if (!disposed) {
                        error.textContent = failure.message || 'No se pudo crear el stricker.';
                        save.disabled = false;
                        cancel.disabled = false;
                    }
                }
            };

            if (options.isGif) {
                draw();
                timeLabel.textContent = `${asset.width} × ${asset.height} · animación original`;
            } else if (options.isVideo) {
                updateTime();
            } else {
                draw();
            }
            save.focus();
        });
    }

    const BBOT_SIZE = 256;
    const BBOT_ANIMATION_FRAMES = 20;
    const BBOT_FRAME_DURATION = 100;
    const BBOT_EFFECT_FILTERS = {
        none: '',
        chrome: 'grayscale(.45) contrast(1.35) brightness(1.12)',
        glass: 'contrast(1.16) saturate(1.2) brightness(1.08)',
        neon: 'saturate(1.5) contrast(1.2)',
        crt: 'contrast(1.25) saturate(.82)',
        worn: 'sepia(.18) contrast(.9) saturate(.72)'
    };

    function drawBbotEffects(context, settings, phase) {
        const amount = key => Math.max(0, Math.min(1, Number(settings[key]) / 100 || 0));
        const radius = Math.max(1, (Number(settings.size) || 200) * .46);
        const center = BBOT_SIZE / 2;
        const filters = [BBOT_EFFECT_FILTERS[settings.effect] || ''];
        if (amount('chrome')) filters.push(`grayscale(${amount('chrome') * .55}) contrast(${1 + amount('chrome') * .35})`);
        if (amount('glass')) filters.push(`saturate(${1 + amount('glass') * .2}) brightness(${1 + amount('glass') * .08})`);
        const hueDrift = Math.sin(phase * Math.PI * 2) * amount('hueDrift') * 90;
        filters.push(`hue-rotate(${hueDrift}deg)`);
        context.filter = filters.filter(Boolean).join(' ');
        context.save();
        if (amount('bloom')) {
            context.shadowColor = settings.ink || '#f7f9f9';
            context.shadowBlur = 18 * amount('bloom');
        }
        context.drawImage(settings.image, center - radius / .92, center - radius / .92,
            radius * 2 / .92, radius * 2 / .92);
        context.restore();
        context.filter = 'none';

        const rim = amount('rim');
        const halo = amount('halo');
        if (rim || halo) {
            context.save();
            const gradient = context.createLinearGradient(center - radius, center - radius, center + radius, center + radius);
            gradient.addColorStop(0, '#9fffe7');
            gradient.addColorStop(.5, settings.ink || '#f7f9f9');
            gradient.addColorStop(1, '#9ca7ff');
            context.strokeStyle = gradient;
            context.globalAlpha = Math.max(rim, halo) * .9;
            context.lineWidth = halo ? 1 + halo * 5 : 1 + rim * 2;
            context.shadowColor = gradient;
            context.shadowBlur = 5 + 18 * Math.max(rim, halo);
            context.beginPath();
            context.arc(center, center, radius + (halo ? 3 + halo * 4 : 0), 0, Math.PI * 2);
            context.stroke();
            context.restore();
        }

        context.save();
        context.beginPath();
        context.arc(center, center, radius, 0, Math.PI * 2);
        context.clip();

        const gloss = amount('gloss') + amount('glass') * .35;
        if (gloss) {
            const gradient = context.createLinearGradient(center, center - radius, center, center + radius * .4);
            gradient.addColorStop(0, `rgba(255,255,255,${.55 * Math.min(1, gloss)})`);
            gradient.addColorStop(.45, `rgba(255,255,255,${.12 * Math.min(1, gloss)})`);
            gradient.addColorStop(1, 'rgba(255,255,255,0)');
            context.fillStyle = gradient;
            context.fillRect(center - radius, center - radius, radius * 2, radius * 2);
        }

        const holo = amount('holo');
        if (holo) {
            const gradient = context.createLinearGradient(center - radius, center - radius, center + radius, center + radius);
            gradient.addColorStop(0, '#ff54d833');
            gradient.addColorStop(.35, '#6d6bff55');
            gradient.addColorStop(.68, '#43ffe044');
            gradient.addColorStop(1, '#fff06b33');
            context.globalCompositeOperation = 'screen';
            context.globalAlpha = holo;
            context.fillStyle = gradient;
            context.fillRect(center - radius, center - radius, radius * 2, radius * 2);
        }

        const scanlines = amount('scanlines');
        if (scanlines) {
            context.globalAlpha = scanlines * .5;
            context.fillStyle = '#05070a';
            for (let y = center - radius; y < center + radius; y += 4)
                context.fillRect(center - radius, y, radius * 2, 1);
        }

        const scratches = amount('scratches');
        if (scratches) {
            context.globalAlpha = scratches * .55;
            context.strokeStyle = '#ffffff';
            context.lineWidth = .7;
            for (let index = 0; index < 12; index++) {
                const x = center - radius + ((index * 47 + 13) % Math.max(1, radius * 2));
                const y = center - radius + ((index * 71 + 29) % Math.max(1, radius * 2));
                context.beginPath();
                context.moveTo(x, y);
                context.lineTo(x + 2 + index % 4, y - 5 - index % 7);
                context.stroke();
            }
        }
        context.restore();
    }

    async function renderBbotStickerFile(createFace, expression, settings = {}) {
        if (!global.AnimatedWebP || typeof global.AnimatedWebP.mux !== 'function')
            throw new Error('No se pudo inicializar la exportación de WebP animado.');
        const renderRoot = document.getElementById('stickerCreatorLanding');
        if (!renderRoot) throw new Error('No se pudo preparar la cara para exportarla.');
        const faceHost = element('div', { class: 'bbotEditorFace' });
        faceHost.style.position = 'fixed';
        faceHost.style.left = '0';
        faceHost.style.top = '0';
        faceHost.style.width = `${BBOT_SIZE}px`;
        faceHost.style.height = `${BBOT_SIZE}px`;
        faceHost.style.display = 'grid';
        faceHost.style.placeItems = 'center';
        faceHost.style.visibility = 'hidden';
        faceHost.style.pointerEvents = 'none';
        faceHost.style.setProperty('--face-skin', /^#[0-9a-f]{6}$/i.test(settings.skin) ? settings.skin : '#17191c');
        faceHost.style.setProperty('--face-ink', /^#[0-9a-f]{6}$/i.test(settings.ink) ? settings.ink : '#f7f9f9');
        faceHost.style.setProperty('--face-ring', /^#[0-9a-f]{6}$/i.test(settings.ring) ? settings.ring : '#17191c');
        renderRoot.appendChild(faceHost);
        let faceInstance = null;
        try {
            faceInstance = createFace(faceHost, {
                expression,
                mouth: settings.mouth === true,
                pupils: settings.pupils === true,
                track: false,
                blink: settings.blink !== false,
                idle: settings.idle !== false
            });
            const svg = faceHost.querySelector('svg');
            if (!svg) throw new Error('No se pudo preparar la cara para exportarla.');
            const faceSize = Math.max(120, Math.min(240, Number(settings.size) || 200));
            svg.style.width = `${faceSize}px`;
            svg.style.height = `${faceSize}px`;
            svg.style.position = 'absolute';
            svg.style.left = '50%';
            svg.style.top = '50%';
            svg.style.transform = 'translate(-50%, -50%)';
            if (settings.reaction && typeof faceInstance.react === 'function')
                faceInstance.react(settings.reaction, { force: true });

            const styleProperties = [
                'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
                'vector-effect', 'opacity', 'transform', 'transform-origin', 'transform-box',
                'clip-path', 'overflow', 'display'
            ];
            const frames = [];
            for (let frameIndex = 0; frameIndex < BBOT_ANIMATION_FRAMES; frameIndex++) {
                const phase = frameIndex / BBOT_ANIMATION_FRAMES;
                if (settings.track && typeof faceInstance.look === 'function') {
                    faceInstance.look(Math.sin(phase * Math.PI * 2) * .72,
                        Math.cos(phase * Math.PI * 2) * .35, 120);
                }
                await new Promise(resolve => global.requestAnimationFrame(() =>
                    global.setTimeout(resolve, BBOT_FRAME_DURATION)));

                const clone = svg.cloneNode(true);
                clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
                clone.setAttribute('width', String(faceSize));
                clone.setAttribute('height', String(faceSize));
                clone.style.width = `${faceSize}px`;
                clone.style.height = `${faceSize}px`;
                clone.style.position = 'absolute';
                clone.style.left = '50%';
                clone.style.top = '50%';
                clone.style.transform = 'translate(-50%, -50%)';
                const originals = [svg, ...svg.querySelectorAll('*')];
                const copies = [clone, ...clone.querySelectorAll('*')];
                originals.forEach((node, index) => {
                    const computed = global.getComputedStyle(node);
                    for (const property of styleProperties) {
                        const value = computed.getPropertyValue(property);
                        if (value) copies[index].style.setProperty(property, value);
                    }
                });
                clone.style.width = `${faceSize}px`;
                clone.style.height = `${faceSize}px`;
                clone.style.position = 'absolute';
                clone.style.left = '50%';
                clone.style.top = '50%';
                clone.style.transform = 'translate(-50%, -50%)';

                const svgBlob = new Blob([new XMLSerializer().serializeToString(clone)], {
                    type: 'image/svg+xml;charset=utf-8'
                });
                const objectUrl = URL.createObjectURL(svgBlob);
                try {
                    const image = new Image();
                    await new Promise((resolve, reject) => {
                        image.onload = resolve;
                        image.onerror = () => reject(new Error('No se pudo convertir la cara a fotograma.'));
                        image.src = objectUrl;
                    });
                    const canvas = document.createElement('canvas');
                    canvas.width = BBOT_SIZE;
                    canvas.height = BBOT_SIZE;
                    const context = canvas.getContext('2d');
                    if (!context) throw new Error('No se pudo preparar el WebP animado.');
                    drawBbotEffects(context, { ...settings, image }, phase);
                    const blob = await new Promise((resolve, reject) => {
                        canvas.toBlob(result => result
                            ? resolve(result)
                            : reject(new Error('No se pudo exportar un fotograma WebP.')), 'image/webp', .86);
                    });
                    if (blob.type !== 'image/webp')
                        throw new Error('Este navegador no puede exportar como WebP.');
                    frames.push({
                        bytes: new Uint8Array(await blob.arrayBuffer()),
                        duration: BBOT_FRAME_DURATION
                    });
                } finally {
                    URL.revokeObjectURL(objectUrl);
                }
            }
            const bytes = global.AnimatedWebP.mux(frames, BBOT_SIZE, BBOT_SIZE, 0);
            if (bytes.length > MAX_OUTPUT_BYTES)
                throw new Error(`El stricker supera el máximo de ${formatMegabytes(MAX_OUTPUT_BYTES)}.`);
            return new File([bytes], 'bbot-stricker.webp', { type: 'image/webp' });
        } finally {
            if (faceInstance) faceInstance.destroy();
            faceHost.remove();
        }
    }

    function openBbotEditor(initialExpression, initialSettings = {}) {
        return import('./vendor/bbot-face.js').then(({ createFace, EXPRESSION_NAMES, REACTION_NAMES }) => {
            const expression = EXPRESSION_NAMES.includes(initialExpression) ? initialExpression : 'idle';
            const landing = document.getElementById('stickerCreatorLanding');
            const intro = landing && landing.querySelector('.stickerCreatorIntro');
            const toolbarTitle = document.getElementById('stickerCreatorTitle');
            if (!landing || !intro || !toolbarTitle)
                throw new Error('No se pudo abrir el editor de caras.');

            const editorContent = element('div', { id: 'stickerEditorContent' });
            const sheet = element('section', { class: 'stickerEditorSheet', 'aria-label': 'Personalizar cara bbot' });
            const hint = element('div', { class: 'stickerEditorHint' });
            hint.textContent = 'Personaliza la cara, prueba sus movimientos y guarda un WebP animado transparente.';
            const stage = element('div', { class: 'stickerEditorStage bbotEditorStage' });
            const preview = element('div', { class: 'bbotEditorFace' });
            stage.appendChild(preview);
            const controls = element('div', { class: 'stickerEditorControls bbotEditorControls' });
            const expressionLabels = {
                idle: 'Neutral', content: 'A gusto', relieved: 'Aliviada', happy: 'Feliz', joy: 'Alegría',
                excited: 'Emocionada', love: 'Enamorada', pleading: 'Suplicante', shy: 'Tímida',
                surprised: 'Sorprendida', scared: 'Asustada', curious: 'Curiosa', confused: 'Confundida',
                dizzy: 'Mareada', thinking: 'Pensando', focus: 'Concentrada', suspicious: 'Sospechosa',
                unimpressed: 'Indiferente', smug: 'Engreída', sly: 'Astuta', bored: 'Aburrida',
                exasperated: 'Exasperada', worried: 'Preocupada', guilty: 'Culpable', sad: 'Triste',
                disgusted: 'Asqueada', annoyed: 'Molesta', angry: 'Enojada', sleepy: 'Soñolienta', sleep: 'Dormida'
            };
            const reactionLabels = {
                blink: 'Parpadear', wink: 'Guiñar', nod: 'Asentir', shake: 'Negar',
                bounce: 'Rebotar', pop: 'Pop', boing: 'Boing', spin: 'Girar', jitter: 'Temblar'
            };
            const defaults = {
                expression, skin: '#17191c', ink: '#f7f9f9', ring: '#17191c',
                size: 200, mouth: false, pupils: false, track: true, blink: true, idle: true,
                preset: 'default', effect: 'none', gloss: 0, rim: 0, chrome: 0, glass: 0, bloom: 0,
                halo: 0, holo: 0, scanlines: 0, scratches: 0, hueDrift: 0, reaction: ''
            };
            const state = { ...defaults, ...initialSettings };
            if (!EXPRESSION_NAMES.includes(state.expression)) state.expression = expression;
            if (!REACTION_NAMES.includes(state.reaction)) state.reaction = '';
            for (const key of ['mouth', 'pupils', 'track', 'blink', 'idle'])
                state[key] = state[key] === true;
            for (const key of ['skin', 'ink', 'ring']) {
                if (!/^#[0-9a-f]{6}$/i.test(state[key])) state[key] = defaults[key];
            }
            state.size = Math.max(120, Math.min(240, Number(state.size) || defaults.size));
            const settings = { ...state };
            const group = title => {
                const section = element('section', { class: 'bbotEditorSection' });
                const heading = element('h3', { class: 'bbotEditorSectionTitle' });
                heading.textContent = title;
                const body = element('div', { class: 'bbotEditorGroup' });
                section.append(heading, body);
                controls.appendChild(section);
                return body;
            };
            const button = (label, className = 'bbotEditorChip') => {
                const node = element('button', { type: 'button', class: className });
                node.textContent = label;
                return node;
            };
            const field = (labelText, input) => {
                const wrapper = element('label', { class: 'bbotEditorField' });
                const label = element('span');
                label.textContent = labelText;
                wrapper.append(label, input);
                return wrapper;
            };
            const option = (key, labelText) => {
                const wrapper = element('label', { class: 'bbotEditorCheck' });
                const input = element('input', { type: 'checkbox', 'data-setting': key });
                input.checked = state[key] === true;
                const text = element('span');
                text.textContent = labelText;
                wrapper.append(input, text);
                return { wrapper, input };
            };
            const range = (key, labelText, min, max, value, suffix = '%') => {
                const wrapper = element('label', { class: 'bbotEditorRange' });
                const label = element('span');
                const name = element('span');
                const output = element('output');
                name.textContent = labelText;
                output.textContent = `${value}${suffix}`;
                label.append(name, output);
                const input = element('input', {
                    type: 'range', min: String(min), max: String(max), value: String(value),
                    'data-setting': key, 'aria-label': labelText
                });
                wrapper.append(label, input);
                input.addEventListener('input', () => { output.textContent = `${input.value}${suffix}`; });
                return { wrapper, input };
            };
            const presetGroup = group('Preajustes');
            const presets = {
                default: ['#17191c', '#f7f9f9', '#17191c'],
                inverted: ['#f7f9f9', '#17191c', '#ffffff'],
                acid: ['#b7ff3c', '#151b0a', '#f0ff9a'],
                sky: ['#86d8ff', '#102637', '#d2f3ff'],
                paper: ['#f1e7d0', '#302719', '#fff8e9'],
                ember: ['#ff784f', '#32130d', '#ffd0a1']
            };
            const presetButtons = new Map();
            for (const [name, colors] of Object.entries(presets)) {
                const item = button(name);
                item.classList.toggle('on', state.preset === name);
                item.onclick = () => {
                    [settings.skin, settings.ink, settings.ring] = colors;
                    state.preset = name;
                    settings.preset = name;
                    syncColors();
                    renderFace();
                };
                presetButtons.set(name, item);
                presetGroup.appendChild(item);
            }
            const randomize = button('Sorpréndeme');
            presetGroup.appendChild(randomize);

            const colorsGroup = group('Color');
            const colorInputs = {};
            for (const [key, label] of [['skin', 'Cara'], ['ink', 'Ojos y boca'], ['ring', 'Contorno']]) {
                const input = element('input', {
                    type: 'color', value: state[key], 'data-setting': key,
                    'aria-label': label
                });
                colorInputs[key] = input;
                colorsGroup.appendChild(field(label, input));
                input.addEventListener('input', () => {
                    settings[key] = input.value;
                    state.preset = 'custom';
                    settings.preset = 'custom';
                    updateActivePreset();
                    renderFace();
                });
            }
            function syncColors() {
                for (const key of Object.keys(colorInputs)) {
                    const value = settings[key];
                    if (/^#[0-9a-f]{6}$/i.test(value)) colorInputs[key].value = value;
                    else colorInputs[key].value = '#777777';
                }
                updateActivePreset();
            }
            function updateActivePreset() {
                for (const [name, item] of presetButtons) item.classList.toggle('on', state.preset === name);
                randomize.classList.toggle('on', state.preset === 'random');
            }
            randomize.onclick = () => {
                const names = Object.keys(presets);
                const name = names[Math.floor(Math.random() * names.length)];
                [settings.skin, settings.ink, settings.ring] = presets[name];
                settings.expression = EXPRESSION_NAMES[Math.floor(Math.random() * EXPRESSION_NAMES.length)];
                state.preset = 'random';
                settings.preset = 'random';
                syncColors();
                updateActiveMood();
                renderFace();
            };

            const sizeGroup = group('Tamaño');
            const sizeControl = range('size', 'Tamaño de cara', 120, 240, state.size, ' px');
            sizeGroup.appendChild(sizeControl.wrapper);
            sizeControl.input.addEventListener('input', () => {
                settings.size = Number(sizeControl.input.value);
                updateFace();
            });

            const optionsGroup = group('Opciones');
            const options = [
                option('mouth', 'Dibujar boca'),
                option('pupils', 'Pupilas interiores'),
                option('track', 'Seguir cursor'),
                option('blink', 'Parpadear'),
                option('idle', 'Movimiento aleatorio')
            ];
            for (const item of options) {
                optionsGroup.appendChild(item.wrapper);
                item.input.addEventListener('change', () => {
                    const key = item.input.dataset.setting;
                    settings[key] = item.input.checked;
                    if (key === 'mouth' || key === 'pupils') renderFace();
                    else updateFace();
                });
            }

            const moodGroup = group('Emoción');
            const moodButtons = new Map();
            for (const name of EXPRESSION_NAMES) {
                const item = button(expressionLabels[name] || name);
                item.title = expressionLabels[name] || name;
                item.classList.toggle('on', settings.expression === name);
                item.onclick = () => {
                    settings.expression = name;
                    updateActiveMood();
                    updateFace();
                };
                moodButtons.set(name, item);
                moodGroup.appendChild(item);
            }
            function updateActiveMood() {
                for (const [name, item] of moodButtons) item.classList.toggle('on', name === settings.expression);
            }

            const effectGroup = group('Efectos');
            const effectPresets = {
                none: {},
                chrome: { chrome: 80, gloss: 25, rim: 65 },
                glass: { glass: 75, gloss: 70, rim: 30 },
                neon: { rim: 90, bloom: 80, halo: 55, holo: 30 },
                crt: { scanlines: 70, hueDrift: 20 },
                worn: { scratches: 65, gloss: 15, hueDrift: 10 }
            };
            let applyingEffectPreset = false;
            const effectButtons = new Map();
            for (const name of Object.keys(effectPresets)) {
                const item = button(name);
                item.classList.toggle('on', settings.effect === name);
                item.onclick = () => {
                    settings.effect = name;
                    settings.presetEffect = name;
                    for (const key of ['gloss', 'rim', 'chrome', 'glass', 'bloom', 'halo', 'holo', 'scanlines', 'scratches', 'hueDrift'])
                        settings[key] = effectPresets[name][key] || 0;
                    applyingEffectPreset = true;
                    for (const control of effectControls) {
                        control.input.value = String(settings[control.input.dataset.setting]);
                        control.input.dispatchEvent(new Event('input'));
                    }
                    applyingEffectPreset = false;
                    updateActiveEffect();
                    updatePreviewFilter();
                };
                effectButtons.set(name, item);
                effectGroup.appendChild(item);
            }
            const effectControls = [];
            const ranges = group('Ajustes de efecto');
            for (const [key, label] of [
                ['gloss', 'Brillo'], ['rim', 'Luz de borde'], ['chrome', 'Cromo'],
                ['glass', 'Vidrio'], ['bloom', 'Resplandor'], ['halo', 'Halo'],
                ['holo', 'Holograma'], ['scanlines', 'Líneas CRT'],
                ['scratches', 'Rayones'], ['hueDrift', 'Cambio de tono']
            ]) {
                const control = range(key, label, 0, 100, Math.max(0, Math.min(100, Number(settings[key]) || 0)));
                effectControls.push(control);
                ranges.appendChild(control.wrapper);
                control.input.addEventListener('input', () => {
                    settings[key] = Number(control.input.value);
                    if (!applyingEffectPreset) {
                        settings.effect = 'custom';
                        settings.presetEffect = 'custom';
                    }
                    updateActiveEffect();
                    updatePreviewFilter();
                });
            }
            function updateActiveEffect() {
                for (const [name, item] of effectButtons) item.classList.toggle('on', name === settings.effect);
            }
            function updatePreviewFilter() {
                const amount = key => Math.max(0, Math.min(1, Number(settings[key]) / 100 || 0));
                const filters = [BBOT_EFFECT_FILTERS[settings.effect] || ''];
                if (amount('chrome')) filters.push(`grayscale(${amount('chrome') * .55}) contrast(${1 + amount('chrome') * .35})`);
                if (amount('glass')) filters.push(`saturate(${1 + amount('glass') * .2}) brightness(${1 + amount('glass') * .08})`);
                if (amount('hueDrift')) filters.push(`hue-rotate(${amount('hueDrift') * 90}deg)`);
                preview.style.filter = filters.filter(Boolean).join(' ');
                preview.style.setProperty('--bbot-gloss', String(Math.max(amount('gloss'), amount('glass') * .35)));
                preview.style.setProperty('--bbot-rim', String(Math.max(amount('rim'), amount('halo'))));
                preview.style.setProperty('--bbot-holo', String(amount('holo')));
                preview.style.setProperty('--bbot-scanlines', String(amount('scanlines')));
                preview.style.setProperty('--bbot-scratches', String(amount('scratches')));
                preview.style.setProperty('--bbot-hue-drift', `${amount('hueDrift') * .9}deg`);
            }

            const reactionGroup = group('Tócame');
            const reactionButtons = new Map();
            for (const name of REACTION_NAMES) {
                const item = button(reactionLabels[name] || name);
                item.classList.toggle('on', settings.reaction === name);
                item.onclick = () => {
                    settings.reaction = settings.reaction === name ? '' : name;
                    for (const [reaction, control] of reactionButtons)
                        control.classList.toggle('on', settings.reaction === reaction);
                    if (settings.reaction && faceInstance) faceInstance.react(settings.reaction, { force: true });
                };
                reactionButtons.set(name, item);
                reactionGroup.appendChild(item);
            }

            const layout = element('div', { class: 'bbotEditorLayout' });
            layout.append(stage, controls);
            const publishToggle = element('div', { class: 'stickerEditorPublishToggle' });
            const publishSwitch = element('button', {
                type: 'button', class: 'tgl stickerEditorSwitch', role: 'switch',
                'aria-checked': 'false', 'aria-label': 'Publicar también en la biblioteca de Zlapy'
            });
            publishToggle.append(publishSwitch, document.createTextNode('Publicar también en la biblioteca de Zlapy'));
            const publishHint = element('div', { class: 'stickerEditorPublishHint', hidden: '' });
            publishHint.textContent = 'Será visible para otras personas. Añade etiquetas para que puedan encontrarlo.';
            const tagBox = element('div', { class: 'stickerEditorTagBox', hidden: '' });
            const tagInput = element('input', {
                type: 'text', maxlength: '24', placeholder: 'Escribe una etiqueta y pulsa Enter',
                'aria-label': 'Etiqueta para publicar en Zlapy'
            });
            const tagChips = element('div', { class: 'stickerEditorTagChips' });
            const tagError = element('div', { class: 'stickerEditorTagError', 'aria-live': 'polite' });
            const publishTags = [];
            tagBox.append(tagChips, tagInput, tagError);
            let publishEnabled = false;
            publishSwitch.addEventListener('click', () => {
                publishEnabled = !publishEnabled;
                publishSwitch.setAttribute('aria-checked', String(publishEnabled));
                publishToggle.classList.toggle('on', publishEnabled);
                tagBox.hidden = !publishEnabled;
                publishHint.hidden = !publishEnabled;
            });
            tagInput.addEventListener('keydown', event => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                const tag = tagInput.value.trim().replace(/^#/, '').normalize('NFC').toLowerCase();
                if (!tag) return;
                if (!/^[\p{L}\p{N}_-]{1,24}$/u.test(tag)) {
                    tagError.textContent = 'Usa hasta 24 letras o números, sin espacios.';
                    return;
                }
                if (publishTags.includes(tag)) { tagInput.value = ''; return; }
                if (publishTags.length >= 8) {
                    tagError.textContent = 'Puedes añadir hasta 8 etiquetas.';
                    return;
                }
                publishTags.push(tag);
                tagInput.value = '';
                tagError.textContent = '';
                const chip = element('span', { class: 'stickerEditorTag' });
                chip.append(document.createTextNode('#' + tag));
                const remove = element('button', { type: 'button', 'aria-label': 'Quitar etiqueta ' + tag });
                remove.textContent = '×';
                remove.onclick = () => {
                    publishTags.splice(publishTags.indexOf(tag), 1);
                    chip.remove();
                };
                chip.appendChild(remove);
                tagChips.appendChild(chip);
            });

            const error = element('div', { class: 'stickerEditorError', role: 'status', 'aria-live': 'polite' });
            const actions = element('div', { class: 'mBtns stickerEditorActions' });
            const cancel = element('button', { type: 'button', class: 'mBtn' });
            cancel.textContent = 'Cancelar';
            const save = element('button', { type: 'button', class: 'mBtn ok stickerEditorSave' });
            save.textContent = 'Crear stricker';
            actions.append(cancel, save);
            sheet.append(hint, layout, publishToggle, publishHint, tagBox, error, actions);
            editorContent.appendChild(sheet);

            const previousTitle = toolbarTitle.textContent;
            const previousIntroHidden = intro.hidden;
            intro.hidden = true;
            toolbarTitle.textContent = 'Personalizar cara bbot';
            landing.appendChild(editorContent);
            let faceInstance = null;
            let disposed = false;
            const renderFace = () => {
                if (faceInstance) faceInstance.destroy();
                preview.replaceChildren();
                preview.style.setProperty('--face-skin', settings.skin);
                preview.style.setProperty('--face-ink', settings.ink);
                preview.style.setProperty('--face-ring', settings.ring);
                faceInstance = createFace(preview, {
                    expression: settings.expression,
                    mouth: settings.mouth,
                    pupils: settings.pupils,
                    track: settings.track,
                    blink: settings.blink,
                    idle: settings.idle
                });
                updateFace();
            };
            function updateFace() {
                if (faceInstance) {
                    faceInstance.set({
                        track: settings.track,
                        blink: settings.blink,
                        idle: settings.idle
                    });
                    faceInstance.setExpression(settings.expression);
                }
                const svg = preview.querySelector('svg');
                if (svg) {
                    svg.style.width = `${settings.size}px`;
                    svg.style.height = `${settings.size}px`;
                    svg.style.position = 'absolute';
                    svg.style.left = '50%';
                    svg.style.top = '50%';
                    svg.style.transform = 'translate(-50%, -50%)';
                }
                updatePreviewFilter();
            };
            const finish = result => {
                if (disposed) return;
                disposed = true;
                document.removeEventListener('keydown', onKey);
                if (faceInstance) faceInstance.destroy();
                editorContent.remove();
                intro.hidden = previousIntroHidden;
                toolbarTitle.textContent = previousTitle;
                if (activeEditorCancel === cancelEditor) activeEditorCancel = null;
                resolve(result);
            };
            const cancelEditor = () => finish(null);
            const onKey = event => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    finish(null);
                }
            };
            document.addEventListener('keydown', onKey);
            activeEditorCancel = cancelEditor;
            cancel.onclick = cancelEditor;
            syncColors();
            renderFace();

            save.onclick = async () => {
                save.disabled = true;
                cancel.disabled = true;
                error.textContent = '';
                try {
                    if (publishEnabled && !publishTags.length)
                        throw new Error('Añade al menos una etiqueta o desactiva la publicación en Zlapy.');
                    const file = await renderBbotStickerFile(createFace, settings.expression, settings);
                    if (!disposed)
                        finish({
                            file,
                            publish: publishEnabled,
                            tags: publishTags.slice(),
                            bbot: { ...settings }
                        });
                } catch (failure) {
                    if (!disposed) {
                        error.textContent = failure.message || 'No se pudo crear el stricker.';
                        save.disabled = false;
                        cancel.disabled = false;
                    }
                }
            };
            save.focus();
        });
    }

    const creatorFile = document.getElementById('stickerCreatorFile');
    if (creatorFile) {
        const choose = document.getElementById('stickerCreatorChoose');
        const close = document.getElementById('stickerCreatorClose');
        const busy = document.getElementById('stickerCreatorBusy');
        const error = document.getElementById('stickerCreatorError');
        const landing = document.getElementById('stickerCreatorLanding');
        const createBbot = document.getElementById('stickerCreatorBbot');
        const formats = document.getElementById('stickerCreatorFormats');
        if (formats) {
            formats.textContent = `Imágenes hasta ${formatMegabytes(MAX_IMAGE_BYTES)} · Videos hasta ${formatMegabytes(MAX_VIDEO_BYTES)} · Tramos de video hasta ${VIDEO_SECONDS_MAX} segundos`;
        }

        function notifyParent(type, result) {
            if (global.parent !== global) {
                global.parent.postMessage({ type, result }, global.location.origin);
                return true;
            }
            return false;
        }

        choose.addEventListener('click', () => {
            error.textContent = '';
            creatorFile.click();
        });
        async function saveStickerFile(file, settings, sendAfterCreate, bbot) {
            const data = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => typeof reader.result === 'string'
                    ? resolve(reader.result) : reject(new Error('No se pudo leer el stricker preparado.'));
                reader.onerror = () => reject(new Error('No se pudo leer el stricker preparado.'));
                reader.readAsDataURL(file);
            });
            busy.hidden = false;
            busy.textContent = 'Guardando stricker…';
            const response = await fetch('/stickers/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data, publish: settings.publish, tags: settings.tags })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'No se pudo guardar el stricker.');
            result.sendAfterCreate = sendAfterCreate;
            if (bbot) result.bbot = bbot;
            if (notifyParent('zlapy-sticker-created', result)) return;
            landing.querySelector('.stickerCreatorIntro p').textContent = 'Stricker creado y guardado en tus favoritos.';
            busy.textContent = 'Stricker creado';
        }
        async function createStickerFromFile(file, sendAfterCreate = false) {
            if (!file) return;
            error.textContent = '';
            choose.disabled = true;
            try {
                const output = await open(file);
                if (output) await saveStickerFile(output.file, output, sendAfterCreate);
            } catch (failure) {
                console.error('[stickers] No se pudo crear el stricker:', failure);
                error.textContent = failure.message || 'No se pudo crear el stricker.';
            } finally {
                busy.hidden = true;
                choose.disabled = false;
            }
        }
        async function createBbotSticker(expression = 'idle', sendAfterCreate = false, initialSettings = {}, autoCreate = false) {
            error.textContent = '';
            choose.disabled = true;
            createBbot.disabled = true;
            if (autoCreate) {
                busy.hidden = false;
                busy.textContent = 'Preparando la cara…';
            }
            try {
                const output = autoCreate
                    ? await import('./vendor/bbot-face.js').then(({ createFace, EXPRESSION_NAMES }) => {
                        if (!EXPRESSION_NAMES.includes(expression))
                            throw new Error('La expresión de la cara no es válida.');
                        return renderBbotStickerFile(createFace, expression, initialSettings).then(file => ({
                            file,
                            publish: false,
                            tags: [],
                            bbot: { ...initialSettings, expression }
                        }));
                    })
                    : await openBbotEditor(expression, initialSettings);
                if (output) await saveStickerFile(output.file, output, sendAfterCreate, output.bbot);
            } catch (failure) {
                console.error('[stickers] No se pudo crear el stricker de cara:', failure);
                error.textContent = failure.message || 'No se pudo crear el stricker de cara.';
            } finally {
                busy.hidden = true;
                choose.disabled = false;
                createBbot.disabled = false;
            }
        }
        global.addEventListener('message', event => {
            if (global.parent === global || event.origin !== global.location.origin ||
                event.source !== global.parent || !event.data) return;
            if (event.data.type === 'zlapy-sticker-edit-image' &&
                event.data.file instanceof Blob && event.data.file.type.startsWith('image/')) {
                createStickerFromFile(event.data.file);
            } else if (event.data.type === 'zlapy-sticker-create-bbot' &&
                typeof event.data.expression === 'string' && /^[a-z]+$/.test(event.data.expression)) {
                createBbotSticker(event.data.expression, event.data.sendAfterCreate === true,
                    event.data.settings && typeof event.data.settings === 'object' ? event.data.settings : {},
                    event.data.autoCreate === true);
            }
        });
        createBbot.addEventListener('click', () => createBbotSticker());
        close.addEventListener('click', () => {
            if (activeEditorCancel) {
                activeEditorCancel();
                return;
            }
            if (!notifyParent('zlapy-sticker-creator-close')) global.location.assign('/');
        });
        creatorFile.addEventListener('change', async () => {
            const file = creatorFile.files && creatorFile.files[0];
            creatorFile.value = '';
            await createStickerFromFile(file);
        });
    }
})(window);
