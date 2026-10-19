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
            // Store only the small computed result, never the image, ImageData, or data URL.
            const stored = Object.freeze({ mode: theme.mode, base: theme.base, strength: theme.strength,
                primaryCoverage: theme.primaryCoverage, secondaryCoverage: theme.secondaryCoverage, secondaryInfluence: theme.secondaryInfluence,
                colors: Object.freeze([...theme.colors]),
                primary: theme.primary ? Object.freeze([...theme.primary]) : null,
                secondary: theme.secondary ? Object.freeze([...theme.secondary]) : null });
            entries.delete(key); entries.set(key, stored);
            while (entries.size > capacity) entries.delete(entries.keys().next().value);
            return stored;
        }
    };
}
