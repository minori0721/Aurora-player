import { cleanCookie } from '../shared/text.js';
import { normalizeMusicSong } from './models.js';
import { createRequestPriority } from '../storage/cache.js';

const WINDOW_SIZE = 5;
const LOW_WATER = 2;
const REQUEST_TIMEOUT_MS = 12_000;
const FAILURE_COOLDOWN_MS = 30_000;

const songId = track => {
    const id = Number(track?.songId || track?.songData?.id || 0);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
};

export function hasBasicSongDetail(song) {
    return !!song && typeof song.name === 'string' && !!song.name
        && Array.isArray(song.ar || song.artists) && !!(song.al || song.album)
        && Number(song.dt || song.duration || 0) > 0;
}

export function planDetailWindow(queue, index, mode, { nextIndex = null, loading = false, looping = false } = {}) {
    if (!Array.isArray(queue) || queue.length < 2 || !Number.isInteger(index) || index < 0 || index >= queue.length || mode === 2 || looping) return [];
    if (mode === 1) return Number.isInteger(nextIndex) && nextIndex >= 0 && nextIndex < queue.length && nextIndex !== index
        ? [queue[nextIndex]] : [];
    const entries = [];
    for (let offset = 1; offset <= WINDOW_SIZE && offset < queue.length; offset++) {
        if (loading && index + offset >= queue.length) break;
        entries.push(queue[(index + offset) % queue.length]);
    }
    return entries;
}

export function createSongDetails({ api, auth, cache, content, debug, onlinePlaylist, playback, playlistView, prefetch, queue, transfer } = {}) {
    const inFlight = new Map();
    const failures = new Map();
    let confirmed = new WeakSet();
    let scope = null;
    let background = new Map();
    let backgroundQueue = null;
    let anchor = null;
    let fillWindow = true;
    let refreshQueued = false;
    let backgroundEnabled = false;
    const completed = new Map();

    const ready = song => !!song && (confirmed.has(song) || hasBasicSongDetail(song));
    const abortError = () => new DOMException('Cancelled song details', 'AbortError');
    const scopeCurrent = snapshot => snapshot === scope && snapshot.generation === auth.authGeneration
        && snapshot.cookie === auth.neteaseCookie && snapshot.base === api.buildApiUrl('/song/detail');

    function cancelPrefetch() {
        backgroundEnabled = false;
        const previous = background;
        background = new Map();
        backgroundQueue = null;
        anchor = null;
        fillWindow = true;
        completed.clear();
        previous.forEach(item => item.release());
    }

    function reset() {
        cancelPrefetch();
        new Set([...inFlight.values()].map(record => record.job)).forEach(job => job.controller.abort());
        inFlight.clear();
        failures.clear();
        confirmed = new WeakSet();
        scope = null;
    }

    function ensureScope() {
        if (!scope || !scopeCurrent(scope)) {
            reset();
            scope = { generation: auth.authGeneration, cookie: auth.neteaseCookie, base: api.buildApiUrl('/song/detail') };
        }
        return scope;
    }

    function coolDown(id) {
        failures.delete(id);
        failures.set(id, Date.now() + FAILURE_COOLDOWN_MS);
        while (failures.size > 64) failures.delete(failures.keys().next().value);
    }

    function scheduleRefresh() {
        if (refreshQueued) return;
        refreshQueued = true;
        Promise.resolve().then(() => {
            refreshQueued = false;
            const songs = [];
            for (const item of completed.values()) if (item.queue === queue.playlist && scopeCurrent(item.scope)) songs.push(item.song);
            completed.clear();
            if (songs.length) applyToPlaylist(songs);
            if (backgroundEnabled) refresh();
        }).catch(error => debug.log(`详情预取调度失败: ${error?.name || 'Error'}`, 'warn'));
    }

    function startBatch(ids, priority) {
        const snapshot = ensureScope();
        const job = { controller: new AbortController(), priority: createRequestPriority(priority), consumers: 0, settled: false, records: [] };
        ids.forEach(id => {
            let resolve, reject;
            const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
            const record = { id, job, promise, resolve, reject };
            job.records.push(record);
            inFlight.set(id, record);
        });
        auth.accountAbortControllers?.add(job.controller);
        const cookie = snapshot.cookie ? `&cookie=${encodeURIComponent(cleanCookie(snapshot.cookie))}` : '';
        const url = api.buildApiUrl(`/song/detail?ids=${ids.slice().sort((a, b) => a - b).join(',')}${cookie}`);
        Promise.resolve().then(() => transfer.withRequestTimeout(job.controller.signal, REQUEST_TIMEOUT_MS, '歌曲详情超时', signal =>
            cache.cachedFetchJson(url, { signal, useQueue: true, priority, requestPriority: job.priority,
                cachePredicate: data => Array.isArray(data.songs) && ids.every(id => data.songs.some(song => Number(song?.id) === id && typeof song?.name === 'string')) }, 300_000)
        )).then(json => {
            if (!scopeCurrent(snapshot) || job.controller.signal.aborted) throw abortError();
            if (!Array.isArray(json?.songs) || (json.code !== undefined && Number(json.code) !== 200)) throw new Error('Invalid song details');
            const songs = new Map(json.songs.filter(song => song && typeof song.name === 'string').map(song => [Number(song.id), song]));
            job.settled = true;
            job.records.forEach(record => {
                const song = songs.get(record.id) || null;
                if (song) { confirmed.add(song); failures.delete(record.id); }
                else coolDown(record.id);
                record.resolve(song);
            });
            if (priority === 'idle') debug.log(`预取后续歌曲详情 ${job.records.filter(record => songs.has(record.id)).length}/${ids.length} 首`, 'success');
        }).catch(error => {
            job.settled = true;
            job.records.forEach(record => {
                if (scopeCurrent(snapshot) && error?.name !== 'AbortError') coolDown(record.id);
                record.reject(error);
            });
            if (scopeCurrent(snapshot) && error?.name !== 'AbortError') debug.log(`歌曲详情请求失败: ${error?.timeout ? '超时' : '接口或网络异常'}`, 'warn');
        }).finally(() => {
            job.records.forEach(record => { if (inFlight.get(record.id) === record) inFlight.delete(record.id); });
            auth.accountAbortControllers?.delete(job.controller);
            if (scopeCurrent(snapshot)) scheduleRefresh();
        });
    }

    function acquire(ids, { priority = 'idle', signal } = {}) {
        if (signal?.aborted) return new Map(ids.map(id => [id, { promise: Promise.reject(abortError()), release() {} }]));
        ensureScope();
        const unique = [...new Set(ids)].filter(id => Number.isSafeInteger(id) && id > 0);
        const missing = unique.filter(id => !inFlight.has(id) || inFlight.get(id).job.controller.signal.aborted);
        if (missing.length) startBatch(missing, priority);
        return new Map(unique.map(id => {
            const record = inFlight.get(id);
            const job = record.job;
            job.priority.promote(priority);
            job.consumers++;
            const controller = new AbortController();
            const onParentAbort = () => controller.abort();
            signal?.addEventListener('abort', onParentAbort, { once: true });
            let finished = false;
            const promise = new Promise((resolve, reject) => {
                const finish = (handler, value) => {
                    if (finished) return;
                    finished = true;
                    signal?.removeEventListener('abort', onParentAbort);
                    controller.signal.removeEventListener('abort', onAbort);
                    job.consumers--;
                    handler(value);
                    if (!job.settled && job.consumers === 0) job.controller.abort();
                };
                const onAbort = () => finish(reject, abortError());
                controller.signal.addEventListener('abort', onAbort, { once: true });
                record.promise.then(value => finish(resolve, value), error => finish(reject, error));
            });
            return [id, { promise, release: () => controller.abort() }];
        }));
    }

    function getSongDetail(id, options = {}) {
        if (!Number.isSafeInteger(id) || id <= 0) return Promise.resolve(null);
        if (options.signal?.aborted) return Promise.reject(abortError());
        ensureScope();
        const current = queue.playlist[queue.curIdx];
        if (songId(current) === id && confirmed.has(current.songData)) return Promise.resolve(current.songData);
        return acquire([id], { priority: 'interactive', ...options }).get(id).promise;
    }

    function applyToPlaylist(songs, queueRef = queue.playlist) {
        if (queueRef !== queue.playlist) return [];
        const byId = new Map(songs.map(song => [Number(song?.id), song]));
        const updated = [];
        queueRef.forEach((track, index) => {
            const incoming = track?.netease && byId.get(songId(track));
            if (!incoming) return;
            const previous = track.songData || {};
            const album = { ...(previous.al || previous.album || {}), ...(incoming.al || incoming.album || {}) };
            const normalized = normalizeMusicSong({ ...previous, ...incoming,
                name: incoming.name || previous.name,
                ar: Array.isArray(incoming.ar || incoming.artists) ? incoming.ar || incoming.artists : previous.ar || previous.artists || [],
                al: album, dt: Number(incoming.dt || incoming.duration || previous.dt || previous.duration || 0) });
            track.songData = normalized.songData;
            track.detailCheckedAt = Date.now();
            track.name = `${normalized.name}${normalized.artists.length ? ` - ${normalized.artists.map(artist => artist.name).join(', ')}` : ''}`;
            if (confirmed.has(incoming)) confirmed.add(track.songData);
            updated.push(index);
        });
        updated.forEach(index => playlistView.refreshPlaylistItem(index));
        if (updated.length) content.updateMusicMiniPlayer();
        return updated;
    }

    function refresh() {
        const snapshot = ensureScope();
        backgroundEnabled = true;
        const queueRef = queue.playlist;
        const index = queue.curIdx;
        const mode = queue.playMode;
        const importing = onlinePlaylist?.currentPlaylistData;
        const looping = !!playback.getActiveCustomLoop();
        const lockedIndex = prefetch.hasLockedNextPreloadTarget(queueRef, prefetch.nextPreloadIndex) ? prefetch.nextPreloadIndex : null;
        const importingBase = importing && importing.queueRef === queue.basePlaylist && importing.loading;
        const entries = looping ? [] : queue.getDetailEntries ? queue.getDetailEntries(lockedIndex, importingBase) : planDetailWindow(queueRef, index, mode, {
            nextIndex: lockedIndex,
            loading: importingBase,
            looping
        });
        if (!anchor || anchor.queue !== queueRef || anchor.mode !== mode || anchor.looping !== looping
            || (anchor.index !== index && index !== (anchor.index + 1) % queueRef.length)) fillWindow = true;
        anchor = { queue: queueRef, index, mode, looping };
        let contiguous = 0;
        for (const entry of entries) {
            if (entry?.netease && songId(entry) && !ready(entry.songData)) break;
            contiguous++;
        }
        const wanted = new Set(entries.filter(entry => entry?.netease && !ready(entry.songData)).map(songId).filter(Boolean));
        if (!wanted.size) fillWindow = false;
        // A track that just became current may still need its existing detail request.
        const current = queueRef[index];
        if (entries.length && backgroundQueue === queueRef && background.has(songId(current)) && !ready(current?.songData)) wanted.add(songId(current));
        const previous = background;
        const next = new Map();
        if (backgroundQueue === queueRef) previous.forEach((item, id) => { if (wanted.has(id)) next.set(id, item); });
        const canStart = !['idle', 'loading', 'error'].includes(playback.playbackState?.status);
        const start = canStart && (fillWindow || contiguous <= LOW_WATER);
        const candidates = [...wanted].filter(id => !next.has(id) && (inFlight.has(id)
            || (start && !inFlight.size && (failures.get(id) || 0) <= Date.now())));
        const leases = acquire(candidates, { priority: 'idle' });
        if (start && candidates.length) fillWindow = false;
        leases.forEach((lease, id) => {
            const item = { ...lease };
            next.set(id, item);
            lease.promise.then(song => {
                if (!song || background.get(id) !== item || queueRef !== queue.playlist || !scopeCurrent(snapshot)) return;
                completed.set(id, { song, queue: queueRef, scope: snapshot });
            }).catch(() => {}).finally(() => {
                if (background.get(id) === item) background.delete(id);
                scheduleRefresh();
            });
        });
        // Establish replacement subscriptions before releasing the old window.
        background = next;
        backgroundQueue = queueRef;
        previous.forEach((item, id) => { if (next.get(id) !== item) item.release(); });
    }

    return { getSongDetail, applyToPlaylist, refresh, cancelPrefetch, reset, isReady: ready };
}
