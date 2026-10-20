import { createRequestPriority } from '../storage/cache.js';

const LYRIC_CACHE_TTL_MS = 3600_000;
const PREFETCH_TIMEOUT_MS = 12_000;

export function isLyricResponse(data) {
    return !!data && (data.code === undefined || Number(data.code) === 200)
        && (!!data.nolyric || !!data.uncollected || ['lrc', 'tlyric', 'trans', 'romalrc', 'yrc']
            .some(key => typeof data[key]?.lyric === 'string'));
}

export function createLyricRequests({ api, cache } = {}) {
    let background = null, taken = null;

    function load(songId, options = {}) {
        return cache.cachedFetchJson(api.buildApiUrl(`/lyric/new?id=${songId}`), {
            ...options, useQueue: true, cachePredicate: isLyricResponse
        }, LYRIC_CACHE_TTL_MS);
    }

    function cancelPrefetch() {
        const previous = background;
        background = null;
        previous?.controller.abort();
    }

    function cancelTaken() {
        const previous = taken;
        taken = null;
        previous?.controller.abort();
    }

    function prefetch(songId) {
        if (!Number.isSafeInteger(songId) || songId <= 0) return false;
        if (background?.songId === songId && !background.controller.signal.aborted) return true;
        cancelPrefetch();
        const record = { songId, controller: new AbortController(), priority: createRequestPriority('idle'), promise: null };
        background = record;
        const timer = setTimeout(() => record.controller.abort(), PREFETCH_TIMEOUT_MS);
        record.promise = Promise.resolve().then(() => load(songId, {
            signal: record.controller.signal, priority: 'idle', requestPriority: record.priority
        })).finally(() => clearTimeout(timer));
        // Failure is retried by foreground playback, never surfaced on the current lyric view.
        record.promise.catch(() => {});
        return true;
    }

    function take(songId, { signal } = {}) {
        const record = background;
        if (!record || record.songId !== songId || record.controller.signal.aborted) return null;
        background = null;
        cancelTaken();
        taken = record;
        record.priority.promote('interactive');
        const abort = () => record.controller.abort();
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        // Transfer the existing subscription before audio consumption cancels its old prefetch.
        const promise = record.promise.finally(() => {
            signal?.removeEventListener('abort', abort);
            if (taken === record) taken = null;
        });
        promise.catch(() => {});
        return promise;
    }

    return { load, prefetch, take, cancelPrefetch, cancelTaken };
}
