/**
 * Resolución segura de ficheros estáticos.
 *
 * Decodifica la ruta pedida, rechaza traversal y nombres reservados del
 * sistema de ficheros, y comprueba que el fichero resolved esté dentro de
 * `public/` y sea real (canonicalizando los enlaces simbólicos).
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_EXTENSIONS = new Set(['.html', '.js', '.css', '.png', '.svg', '.webp', '.json', '.webmanifest']);
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;

function decodeRequestPath(rawUrl) {
    if (typeof rawUrl !== 'string') return null;
    let pathname = rawUrl.split(/[?#]/, 1)[0];
    if (!pathname.startsWith('/') || pathname.includes('\\')) return null;

    for (let depth = 0; depth < 5; depth++) {
        let decoded;
        try {
            decoded = decodeURIComponent(pathname);
        } catch (error) {
            if (error instanceof URIError) return null;
            throw error;
        }
        if (decoded === pathname) break;
        pathname = decoded;
    }
    if (pathname.includes('%') || pathname.includes('\\') || /[\0-\x1f\x7f]/.test(pathname)) return null;
    const segments = pathname.slice(1).split('/');
    if (segments.some(segment => {
        const deviceName = segment.split('.')[0].replace(/[ .]+$/g, '');
        return segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' ') ||
            /[<>:"|?*]/.test(segment) || WINDOWS_DEVICE_NAME.test(deviceName) ||
            (segment.startsWith('.') && segment.length > 1);
    })) return null;
    return segments.filter(Boolean).join(path.sep);
}

function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
    );
}

function resolvePublicFile(publicRoot, rawUrl) {
    const relativePath = decodeRequestPath(rawUrl);
    if (relativePath === null) return null;
    const root = path.resolve(publicRoot);
    const candidate = path.resolve(root, relativePath || 'index.html');
    if (!isInside(root, candidate)) return null;
    if (!PUBLIC_EXTENSIONS.has(path.extname(candidate).toLowerCase())) return null;

    try {
        const canonicalRoot = fs.realpathSync(root);
        const canonicalFile = fs.realpathSync(candidate);
        if (!isInside(canonicalRoot, canonicalFile) || !fs.statSync(canonicalFile).isFile()) return null;
        return canonicalFile;
    } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return null;
        throw error;
    }
}

module.exports = { decodeRequestPath, resolvePublicFile };
