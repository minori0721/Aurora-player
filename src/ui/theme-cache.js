import { SPATIAL_SIZE } from './background-field.js';

export function coverThemeKey(source) {
    if (typeof source !== 'string' || !source || source.length > 2048) return null;
    try {
        const url = new URL(source);
        if (url.protocol === 'blob:') return source;
        if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
        if (/\.(gif|apng|webp)$/i.test(url.pathname)) return null;
        if (/(^|\.)music\.126\.net$/i.test(url.hostname) && url.searchParams.getAll('param').length === 1
            && /^([1-9]\d*)y\1$/.test(url.searchParams.get('param') || '')) url.searchParams.delete('param');
        return url.href;
    } catch (_) { return null; }
}

export function createThemeCache(limit = 16) {
    const capacity = Number.isInteger(limit) ? Math.max(1, Math.min(64, limit)) : 16;
    const entries = new Map();
    const storedThemes = new WeakSet();
    const remember = (key, theme) => {
        entries.delete(key); entries.set(key, theme);
        while (entries.size > capacity) entries.delete(entries.keys().next().value);
        return theme;
    };
    return {
        get size() { return entries.size; },
        get(key) {
            if (!key || !entries.has(key)) return null;
            const theme = entries.get(key);
            entries.delete(key); entries.set(key, theme);
            return theme;
        },
        set(key, theme) {
            if (!key) return theme;
            if (storedThemes.has(theme)) return remember(key, theme);
            // Keep only computed colors and the fixed 16KiB sample, never full-size cover pixels.
            const sample = theme.spatial;
            const spatial = sample?.width === SPATIAL_SIZE && sample.height === SPATIAL_SIZE
                && sample.format === 'srgb-rgba8' && sample.data instanceof Uint8Array
                && sample.data.byteLength === SPATIAL_SIZE * SPATIAL_SIZE * 4
                ? Object.freeze({ width: sample.width, height: sample.height, data: sample.data, format: sample.format }) : undefined;
            const stored = Object.freeze({ spatial, mode: theme.mode, base: theme.base, strength: theme.strength,
                primaryCoverage: theme.primaryCoverage, secondaryCoverage: theme.secondaryCoverage, secondaryInfluence: theme.secondaryInfluence,
                tertiaryCoverage: theme.tertiaryCoverage,
                tertiary: theme.tertiary ? Object.freeze([...theme.tertiary]) : null,
                weights: theme.weights ? Object.freeze([...theme.weights]) : undefined,
                colors: Object.freeze([...theme.colors]),
                primary: theme.primary ? Object.freeze([...theme.primary]) : null,
                secondary: theme.secondary ? Object.freeze([...theme.secondary]) : null });
            storedThemes.add(stored);
            return remember(key, stored);
        }
    };
}
