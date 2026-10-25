import { hashCacheScope } from '../shared/text.js';

const JSON_CACHE_SENSITIVE_PARAMS = new Set(['cookie', 'token', 'key', 'csrf', 'music_u']);

const JSON_CACHE_VOLATILE_PARAMS = new Set(['timestamp', 'nocache']);

export const JSON_CACHE_LIMITS = Object.freeze({
    entries: 200, memoryBytes: 16 * 1024 * 1024, diskBytes: 64 * 1024 * 1024,
    maxAge: 7 * 24 * 3600_000
});

const PUBLIC_STATIC_PATH = /\/(?:album|artists|artist\/(?:detail|top\/song|songs|album|mv)|lyric\/new)\/?$/;

export function canRevalidateJson(url, scope, options) {
    if (scope !== 'public' || options.staleWhileRevalidate !== true
        || String(options.method || 'GET').toUpperCase() !== 'GET') return false;
    const headers = new Headers(options.headers);
    return !headers.has('Authorization') && !headers.has('Cookie')
        && PUBLIC_STATIC_PATH.test(new URL(url, window.location.href).pathname);
}

export function jsonCacheEntryBytes(entry) {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
        try { entry.bytes = new TextEncoder().encode(JSON.stringify(entry.data)).byteLength; }
        catch (_) { entry.bytes = Number.MAX_SAFE_INTEGER; }
    }
    return entry.bytes;
}

export function jsonCacheTtl(ttl, data) {
    const value = Number(typeof ttl === 'function' ? ttl(data) : ttl);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function jsonCacheEvictions(entries, now = Date.now()) {
    let count = 0, bytes = 0;
    return [...entries].sort((a, b) => b.ts - a.ts).filter(entry => {
        // Legacy sizes are filled when read, not by serializing every record on startup.
        const size = Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 ? entry.bytes : 0;
        if (!entry.ts || entry.ts > now || now - entry.ts > JSON_CACHE_LIMITS.maxAge
            || count >= JSON_CACHE_LIMITS.entries || bytes + size > JSON_CACHE_LIMITS.diskBytes) return true;
        count++; bytes += size;
        return false;
    });
}

function describeJsonCache(url, requestedScope = 'auto') {
    const parsed = new URL(url, window.location.href);
    const sensitiveValues = [];
    const namesToDelete = [];
    parsed.searchParams.forEach((value, name) => {
        const normalized = name.toLowerCase();
        if (JSON_CACHE_SENSITIVE_PARAMS.has(normalized)) {
            sensitiveValues.push(`${normalized}:${value}`);
            namesToDelete.push(name);
        } else if (JSON_CACHE_VOLATILE_PARAMS.has(normalized)) {
            namesToDelete.push(name);
        }
    });
    namesToDelete.forEach(name => parsed.searchParams.delete(name));
    parsed.searchParams.sort();
    parsed.hash = '';
    const safeUrl = parsed.toString();
    let scope = requestedScope;
    if (scope === 'auto') scope = sensitiveValues.length ? 'account' : 'public';
    if (sensitiveValues.length && scope === 'public') scope = 'account';
    const authScope = sensitiveValues.length ? hashCacheScope(sensitiveValues.sort().join('|')) : 'anon';
    return {
        scope,
        key: scope === 'account' ? `json-account|${authScope}|${safeUrl}` : `json|${safeUrl}`
    };
}

function isJsonResponseCacheable(data, cachePredicate = null) {
    if (!data || typeof data !== 'object') return false;
    if (data.code !== undefined && Number(data.code) !== 200) return false;
    return typeof cachePredicate === 'function' ? cachePredicate(data) !== false : true;
}

export { describeJsonCache, isJsonResponseCacheable };
