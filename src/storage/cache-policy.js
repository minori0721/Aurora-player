import { hashCacheScope } from '../shared/text.js';

const JSON_CACHE_SENSITIVE_PARAMS = new Set(['cookie', 'token', 'key', 'csrf', 'music_u']);

const JSON_CACHE_VOLATILE_PARAMS = new Set(['timestamp', 'nocache']);

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
