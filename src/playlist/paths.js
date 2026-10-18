const AUDIO_FILE_EXTENSIONS = new Set(['mp3', 'flac', 'wav', 'm4a', 'ogg']);

const COMPANION_FILE_EXTENSIONS = new Set(['sli', 'lrc']);

function normalizeImportPath(path) {
    return String(path || '').replace(/\\/g, '/').split('/')
        .filter(part => part && part !== '.' && part !== '..').join('/').normalize('NFC');
}

function normalizeImportKey(value) {
    return normalizeImportPath(value).toLowerCase();
}

function splitImportPath(path) {
    const normalized = normalizeImportPath(path);
    const slash = normalized.lastIndexOf('/');
    return { path: normalized, dir: slash >= 0 ? normalized.slice(0, slash) : '', name: slash >= 0 ? normalized.slice(slash + 1) : normalized };
}

function createImportPathFields(relativePath, fallbackName = '') {
    const parts = splitImportPath(relativePath || fallbackName);
    const name = parts.name || fallbackName;
    const normalizedName = name.normalize('NFC').toLowerCase();
    const dot = normalizedName.lastIndexOf('.');
    const ext = dot >= 0 ? normalizedName.slice(dot + 1) : '';
    const stem = dot >= 0 ? normalizedName.slice(0, dot) : normalizedName;
    return {
        relativePath: parts.path || name,
        pathKey: normalizeImportKey(parts.path || name),
        dirKey: normalizeImportKey(parts.dir),
        name, nameKey: normalizedName, ext, stemKey: stem
    };
}

export { AUDIO_FILE_EXTENSIONS, COMPANION_FILE_EXTENSIONS, createImportPathFields, normalizeImportKey, normalizeImportPath };
