import { cleanCookie } from '../shared/text.js';

export function createPrefetch({
    auth: authService,
    debug: debugService,
    lyrics: lyricsService,
    playback: playbackService,
    queue: queueService,
    resolver: resolverService,
    songDetails: songDetailsService,
    transfer: transferService
} = {}) {
    const LOCAL_PREFETCH_TRIGGER_SEC = 10;

    const LOCAL_PREFETCH_PLAYBACK_WAIT_MS = 1000;

    // Keep the full online-audio download close to playback to avoid wasting
    // bandwidth and memory on tracks the user may skip. The URL itself may
    // still be resolved earlier and is shared with the eventual download.
    const NETEASE_PREFETCH_TRIGGER_SEC = 15;

    const NETEASE_LARGE_PREFETCH_TRIGGER_SEC = 25;

    const NETEASE_LARGE_FILE_THRESHOLD_BYTES = 16 * 1024 * 1024;

    const NETEASE_PREFETCH_MAX_BYTES_DESKTOP = 64 * 1024 * 1024;

    const NETEASE_PREFETCH_MAX_BYTES_MOBILE = 32 * 1024 * 1024;

    let nextSongUrlPrewarmController = null;

    let nextSongUrlPrewarmPromise = null;

    function resetNeteaseDetailPrefetchState() {
        songDetailsService?.reset();
    }

    // ---- 下一首预加载相关 ----
    let nextSongRawData = null;

    // 存放预加载的 ArrayBuffer（下一首）
    let nextSongAbortController = null;

    // AbortController（用于取消预加载请求）
    let hasPreloaded = false;

    // 是否已完成预加载
    let nextPreloadIndex = null;

    // 预加载对应的播放列表索引
    let prefetchAttempted = false;

    // 是否尝试过预取
    let prefetchInProgress = false;

    // 防止重复发起预取
    let nextSongFetchPromise = null;

    // 如果预取正在进行，保存其 Promise（用于播放时复用）
    let nextSongPreloadMeta = null;

    // 保存预取音频的 URL/音质信息，供命中预取时刷新标签
    let nextPreloadToken = 0;

    let nextPreloadQueueRef = null;

    let nextPreloadTrack = null;

    let nextPreloadSongId = 0;

    let nextPreloadLevel = '';

    let nextPreloadCookie = '';

    let nextPreloadAuthGeneration = -1;

    let nextPreloadKind = 'none';

    // local / netease / netease-url
    let nextPreloadStatus = 'idle';

    // idle / loading / ready / url-ready / skipped / failed
    let nextPreloadRecoveryBudget = null;

    function getPlaylistTrackSongId(track) {
        const id = Number(track?.songId || track?.songData?.id || 0);
        return Number.isSafeInteger(id) && id > 0 ? id : 0;
    }

    function hasLockedNextPreloadTarget(queueRef = queueService.playlist, index = nextPreloadIndex, track = null) {
        if (!queueRef || !Number.isInteger(index) || index < 0 || index >= queueRef.length) return false;
        const target = queueRef[index];
        return nextPreloadKind !== 'none'
            && nextPreloadQueueRef === queueRef
            && nextPreloadTrack === target
            && (!track || target === track);
    }

    function isNextPreloadCompatible(queueRef = queueService.playlist, index = nextPreloadIndex, track = null) {
        if (!hasLockedNextPreloadTarget(queueRef, index, track)) return false;
        const target = queueRef[index];
        if (target?.netease) {
            return nextPreloadKind.startsWith('netease')
                && nextPreloadSongId === getPlaylistTrackSongId(target)
                && nextPreloadLevel === authService.neteaseQuality
                && nextPreloadCookie === authService.neteaseCookie
                && nextPreloadAuthGeneration === authService.authGeneration;
        }
        return nextPreloadKind === 'local';
    }

    function isNextPreloadSnapshotCurrent(token, queueRef, index, track, songId = 0, level = '', generation = authService.authGeneration) {
        if (token !== nextPreloadToken || queueRef !== queueService.playlist) return false;
        if (!hasLockedNextPreloadTarget(queueRef, index, track)) return false;
        if (nextPreloadTrack !== track || queueRef[index] !== track) return false;
        if (nextPreloadKind.startsWith('netease')) {
            return nextPreloadSongId === Number(songId)
                && nextPreloadLevel === level
                && nextPreloadCookie === authService.neteaseCookie
                && nextPreloadAuthGeneration === generation
                && generation === authService.authGeneration;
        }
        return true;
    }

    function takeNextPrewarmedNeteaseUrl(songId, level = authService.neteaseQuality) {
        const index = nextPreloadIndex;
        const track = queueService.playlist[index];
        const candidates = Array.isArray(nextSongPreloadMeta?.candidates)
            ? nextSongPreloadMeta.candidates.filter(Boolean)
            : [];
        if (!candidates.length || nextPreloadKind !== 'netease-url') return null;
        if (!isNextPreloadCompatible(queueService.playlist, index, track)
            || nextPreloadSongId !== Number(songId)
            || nextPreloadLevel !== level) return null;

        const result = {
            audioInfo: nextSongPreloadMeta.audioInfo ? { ...nextSongPreloadMeta.audioInfo } : null,
            audioUrl: nextSongPreloadMeta.audioUrl || candidates[0],
            proxyUrl: nextSongPreloadMeta.proxyUrl || '',
            candidates: [...candidates],
            usedMatch: !!nextSongPreloadMeta.usedMatch,
            matchSource: nextSongPreloadMeta.matchSource || ''
        };
        cancelNextPreload({ resetAttempted: false, silent: true, resetDetails: false });
        return result;
    }

    function getNeteasePrefetchLimitBytes() {
        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        const slowNetwork = !!connection?.saveData || /(^|-)2g$/.test(String(connection?.effectiveType || ''));
        const lowMemory = Number.isFinite(Number(navigator.deviceMemory)) && Number(navigator.deviceMemory) <= 4;
        const compactViewport = typeof matchMedia === 'function' && matchMedia('(max-width: 700px)').matches;
        return slowNetwork || lowMemory || compactViewport
            ? NETEASE_PREFETCH_MAX_BYTES_MOBILE
            : NETEASE_PREFETCH_MAX_BYTES_DESKTOP;
    }

    async function readLocalAudioForPrefetch(file) {
        const maxBytes = getNeteasePrefetchLimitBytes();
        if (file.size > maxBytes) return { kind: 'skipped', sizeHint: file.size, maxBytes };
        return { kind: 'raw', ab: await file.arrayBuffer(), audioUrl: '', audioInfo: null };
    }

    function getNeteaseTrackSizeHint(track) {
        const song = track?.songData || {};
        const audioInfo = nextPreloadTrack === track ? nextSongPreloadMeta?.audioInfo : null;
        const candidates = [
            audioInfo?.size,
            song.hrMusic?.size,
            song.hMusic?.size,
            song.mMusic?.size,
            song.lMusic?.size,
            song.size
        ];
        for (const value of candidates) {
            const size = Number(value);
            if (Number.isFinite(size) && size > 0) return size;
        }
        return 0;
    }

    function getNeteasePrefetchTriggerSec(track) {
        const size = getNeteaseTrackSizeHint(track);
        // Unknown size uses the conservative window because it may be a
        // lossless file whose metadata is only available after URL resolve.
        return !size || size >= NETEASE_LARGE_FILE_THRESHOLD_BYTES
            ? NETEASE_LARGE_PREFETCH_TRIGGER_SEC
            : NETEASE_PREFETCH_TRIGGER_SEC;
    }

    function createStalePreloadError() {
        const error = new Error('stale preload');
        error.stale = true;
        return error;
    }

    function takeNextPreloadedRawData(index, track, songId = 0, level = '') {
        const token = nextPreloadToken;
        const queueRef = queueService.playlist;
        if (!hasPreloaded || !nextSongRawData) return null;
        if (!isNextPreloadSnapshotCurrent(token, queueRef, index, track, songId, level, nextPreloadAuthGeneration)) return null;

        const result = {
            ab: nextSongRawData,
            ...(nextSongPreloadMeta || {})
        };
        cancelNextPreload({ resetAttempted: false, silent: true, resetDetails: false });
        prefetchAttempted = false;
        return result;
    }

    // 等待预取完成（短等待），返回 true 表示预取已完成且数据可用
    async function waitForPrefetchCompletion(timeoutMs = LOCAL_PREFETCH_PLAYBACK_WAIT_MS, token = nextPreloadToken) {
        if (hasPreloaded && nextSongRawData) return true;
        if (!prefetchInProgress || !nextSongFetchPromise) return false;
        const result = await waitForPromiseWithTimeout(nextSongFetchPromise, timeoutMs);
        return result.ok && token === nextPreloadToken && hasPreloaded && !!nextSongRawData;
    }

    // 等待任意 Promise 在限定时间内解析（返回 {ok, value}）
    function waitForPromiseWithTimeout(promise, timeoutMs) {
        if (!promise) return Promise.resolve({ ok: false });
        let timer;
        return Promise.race([
            promise.then(v => ({ ok: true, value: v })).catch(e => ({ ok: false, err: e })),
            new Promise(res => { timer = setTimeout(() => res({ ok: false, timeout: true }), timeoutMs); })
        ]).then(r => { if (timer) clearTimeout(timer); return r; });
    }

    // 取消下一首预加载；令牌递增后，任何迟到的 Promise 都不能回填新状态。
    function cancelNextPreload({ resetAttempted = true, silent = false, resetDetails = true } = {}) {
        nextPreloadToken++;
        lyricsService?.cancelLyricPrefetch();
        try {
            if (nextSongAbortController) {
                try { if (typeof nextSongAbortController.abort === 'function') nextSongAbortController.abort(); }
                catch(e) {}
                nextSongAbortController = null;
            }
            if (nextSongUrlPrewarmController) {
                try { nextSongUrlPrewarmController.abort(); } catch(e) {}
                nextSongUrlPrewarmController = null;
            }
            nextSongUrlPrewarmPromise = null;
        } finally {
            nextSongRawData = null;
            hasPreloaded = false;
            nextPreloadIndex = null;
            nextPreloadQueueRef = null;
            nextPreloadTrack = null;
            nextPreloadSongId = 0;
            nextPreloadLevel = '';
            nextPreloadCookie = '';
            nextPreloadAuthGeneration = -1;
            nextPreloadKind = 'none';
            nextPreloadStatus = 'idle';
            if (resetAttempted) prefetchAttempted = false;
            prefetchInProgress = false;
            try { nextSongFetchPromise = null; } catch (e) {}
            try { nextSongPreloadMeta = null; } catch (e) {}
            nextPreloadRecoveryBudget = null;
            if (resetDetails) songDetailsService?.cancelPrefetch();
        }
        if (!silent) debugService.log('Next-song preload cancelled');
    }

    function getLikelyNextPlaylistIndex() {
        if (!queueService.playlist || queueService.playlist.length === 0 || queueService.curIdx < 0 || queueService.playMode === 2) return null;
        if (queueService.playMode === 1) {
            if (queueService.playlist.length === 1) return null;
            if (hasLockedNextPreloadTarget(queueService.playlist, nextPreloadIndex) && nextPreloadIndex !== queueService.curIdx) return nextPreloadIndex;
            let nextIdx = Math.floor(Math.random() * queueService.playlist.length);
            if (nextIdx === queueService.curIdx) nextIdx = (nextIdx + 1) % queueService.playlist.length;
            return nextIdx;
        }
        return queueService.curIdx + 1 >= queueService.playlist.length ? 0 : queueService.curIdx + 1;
    }

    function applyNeteaseSongDetailToPlaylist(song, queueRef = queueService.playlist) {
        return songDetailsService.applyToPlaylist([song], queueRef);
    }

    function prefetchUpcomingNeteaseDetails() {
        songDetailsService?.refresh();
    }

    function prewarmNextNeteaseSongUrl() {
        try {
            if (!queueService.playlist || queueService.playlist.length === 0 || queueService.curIdx < 0 || queueService.playMode === 2 || playbackService.getActiveCustomLoop()) return;
            const queueRef = queueService.playlist;
            const nextIdx = getLikelyNextPlaylistIndex();
            if (nextIdx === null) return;
            const nextTrack = queueRef[nextIdx];
            const songId = getPlaylistTrackSongId(nextTrack);
            if (!nextTrack?.netease || !songId) return;

            const sameTarget = hasLockedNextPreloadTarget(queueRef, nextIdx, nextTrack)
                && nextPreloadSongId === songId
                && nextPreloadLevel === authService.neteaseQuality
                && nextPreloadCookie === authService.neteaseCookie
                && nextPreloadAuthGeneration === authService.authGeneration;
            if (prefetchInProgress || hasPreloaded) return;
            if (sameTarget && (nextPreloadStatus === 'url-loading' || nextPreloadStatus === 'url-ready')) return;

            if (!sameTarget) cancelNextPreload({ resetAttempted: false, silent: true, resetDetails: false });
            if (nextSongUrlPrewarmController) {
                try { nextSongUrlPrewarmController.abort(); } catch(e) {}
            }

            const token = ++nextPreloadToken;
            const controller = new AbortController();
            const cookieSnapshot = authService.neteaseCookie;
            const levelSnapshot = authService.neteaseQuality;
            const generationSnapshot = authService.authGeneration;
            nextSongUrlPrewarmController = controller;
            nextPreloadQueueRef = queueRef;
            nextPreloadTrack = nextTrack;
            nextPreloadIndex = nextIdx;
            nextPreloadSongId = songId;
            nextPreloadLevel = levelSnapshot;
            nextPreloadCookie = cookieSnapshot;
            nextPreloadAuthGeneration = generationSnapshot;
            nextPreloadKind = 'netease-url';
            nextPreloadStatus = 'url-loading';
            nextPreloadRecoveryBudget = { urlRefreshUsed: false, stallRecoveryUsed: false };
            nextSongPreloadMeta = null;
            const cookieParam = cookieSnapshot ? `&cookie=${encodeURIComponent(cleanCookie(cookieSnapshot))}` : '';
            const strategy = resolverService.getNeteaseMatchStrategy(levelSnapshot);
            const prewarmPromise = resolverService.resolveNeteaseAudioUrlWithTimeout(
                songId,
                cookieParam,
                levelSnapshot,
                { signal: controller.signal, useQueue: true, priority: 'idle' },
                30_000,
                strategy
            );
            nextSongUrlPrewarmPromise = prewarmPromise;
            prewarmPromise.then(result => {
                if (controller.signal.aborted || !isNextPreloadSnapshotCurrent(token, queueRef, nextIdx, nextTrack, songId, levelSnapshot, generationSnapshot)) return;
                if (result?.candidates?.length) {
                    nextSongPreloadMeta = {
                        audioUrl: result.audioUrl || result.candidates[0],
                        audioInfo: result.audioInfo || null,
                        candidates: [...result.candidates],
                        usedMatch: !!result.usedMatch,
                        matchSource: result.matchSource || ''
                    };
                    if (!prefetchInProgress) nextPreloadStatus = 'url-ready';
                    const detail = result.usedMatch ? ` via match${result.matchSource ? `/${result.matchSource}` : ''}` : '';
                    debugService.log(`Prewarmed next URL: ${nextTrack.name}${detail}`, 'success');
                } else {
                    nextPreloadStatus = 'failed';
                }
            }).catch(e => {
                if (e?.name !== 'AbortError' && !e?.stale) debugService.log('Next URL prewarm failed: ' + (e?.message || 'Unknown error'), 'warn');
                if (isNextPreloadSnapshotCurrent(token, queueRef, nextIdx, nextTrack, songId, levelSnapshot, generationSnapshot)) nextPreloadStatus = 'failed';
            }).finally(() => {
                if (nextSongUrlPrewarmPromise === prewarmPromise) nextSongUrlPrewarmPromise = null;
                if (nextSongUrlPrewarmController === controller) nextSongUrlPrewarmController = null;
                if (isNextPreloadSnapshotCurrent(token, queueRef, nextIdx, nextTrack, songId, levelSnapshot, generationSnapshot)
                    && nextPreloadStatus === 'url-loading') nextPreloadStatus = 'failed';
            });
        } catch (_) {}
    }

    async function fetchNeteaseAudioForPrefetch(snapshot, controller) {
        const signal = controller.signal;
        const cookieParam = snapshot.cookie ? `&cookie=${encodeURIComponent(cleanCookie(snapshot.cookie))}` : '';
        const strategy = resolverService.getNeteaseMatchStrategy(snapshot.level);
        const maxBytes = getNeteasePrefetchLimitBytes();
        const budget = snapshot.recoveryBudget;

        while (true) {
            if (signal.aborted || !isNextPreloadSnapshotCurrent(snapshot.token, snapshot.queueRef, snapshot.index, snapshot.track, snapshot.songId, snapshot.level, snapshot.authGeneration)) {
                throw createStalePreloadError();
            }
            let resolved = !budget.urlRefreshUsed && snapshot.prewarmedMeta?.candidates?.length
                ? {
                    ...snapshot.prewarmedMeta,
                    audioInfo: snapshot.prewarmedMeta.audioInfo ? { ...snapshot.prewarmedMeta.audioInfo } : null,
                    candidates: [...snapshot.prewarmedMeta.candidates]
                }
                : null;
            if (!resolved && !budget.urlRefreshUsed && snapshot.prewarmPromise) {
                resolved = await transferService.awaitWithSignal(snapshot.prewarmPromise, signal);
            }
            if (!resolved) {
                resolved = await resolverService.resolveNeteaseAudioUrlWithTimeout(
                    snapshot.songId,
                    cookieParam,
                    snapshot.level,
                    {
                        signal,
                        useQueue: true,
                        priority: 'idle',
                        ...(budget.urlRefreshUsed ? { cacheScope: 'none', forceRefresh: true } : {})
                    },
                    30_000,
                    strategy
                );
            }
            if (signal.aborted || !isNextPreloadSnapshotCurrent(snapshot.token, snapshot.queueRef, snapshot.index, snapshot.track, snapshot.songId, snapshot.level, snapshot.authGeneration)) {
                throw createStalePreloadError();
            }
            let audioInfo = resolved.audioInfo || null;
            let candidates = resolved.candidates || [];
            if (!audioInfo || !candidates.length) throw new Error('NO_URL_FROM_PREFETCH');

            // The API size is available before the CDN GET in most cases.
            // Avoid opening a full body request for files that cannot safely
            // fit in the current device's prefetch budget.
            const apiSize = Number(audioInfo.size || 0);
            const apiSizeKnown = Number.isFinite(apiSize) && apiSize > 0;
            if (apiSizeKnown && apiSize > maxBytes) {
                return {
                    kind: 'url',
                    audioUrl: candidates[0],
                    audioInfo,
                    candidates: [...candidates],
                    sizeHint: apiSize,
                    maxBytes,
                    usedMatch: !!resolved.usedMatch,
                    matchSource: resolved.matchSource || ''
                };
            }

            let readResult;
            try {
                readResult = await transferService.fetchAudioDataWithFallback(candidates, { signal, maxBytes });
            } catch (error) {
                const shouldRefresh = !budget.urlRefreshUsed && [401, 403, 404, 410].includes(Number(error?.status));
                if (!shouldRefresh) throw error;
                budget.urlRefreshUsed = true;
                await resolverService.invalidateNeteaseResolvedAudioCache(snapshot.songId, snapshot.level, snapshot.cookie);
                if (signal.aborted || !isNextPreloadSnapshotCurrent(snapshot.token, snapshot.queueRef, snapshot.index, snapshot.track, snapshot.songId, snapshot.level, snapshot.authGeneration)) {
                    throw createStalePreloadError();
                }
                continue;
            }

            if (signal.aborted || !isNextPreloadSnapshotCurrent(snapshot.token, snapshot.queueRef, snapshot.index, snapshot.track, snapshot.songId, snapshot.level, snapshot.authGeneration)) {
                throw createStalePreloadError();
            }
            if (readResult.tooLarge) {
                return {
                    kind: 'url',
                    audioUrl: readResult.audioUrl,
                    audioInfo,
                    candidates: [...candidates],
                    sizeHint: readResult.byteLength,
                    maxBytes,
                    usedMatch: !!resolved.usedMatch,
                    matchSource: resolved.matchSource || ''
                };
            }
            return {
                kind: 'raw',
                ab: readResult.buffer,
                audioUrl: readResult.audioUrl,
                audioInfo,
                candidates: [...candidates],
                usedMatch: !!resolved.usedMatch,
                matchSource: resolved.matchSource || ''
            };
        }
    }

    // 本地仍提前 10 秒；网易云大文件只在剩余 25 秒时开始完整下载。
    async function prefetchNextSong(requestedIndex = null) {
        try {
            if (!queueService.playlist || queueService.playlist.length === 0 || queueService.curIdx < 0 || queueService.playMode === 2 || playbackService.getActiveCustomLoop() || !playbackService.playbackState.isPlaying) return;
            const queueRef = queueService.playlist;
            const nextIdx = Number.isInteger(requestedIndex)
                && requestedIndex >= 0
                && requestedIndex < queueRef.length
                && requestedIndex !== queueService.curIdx
                ? requestedIndex
                : getLikelyNextPlaylistIndex();
            if (nextIdx === null) return;
            const nextTrack = queueRef[nextIdx];
            if (!nextTrack) return;
            const songId = getPlaylistTrackSongId(nextTrack);
            if (!nextTrack.file && (!nextTrack.netease || !songId)) return;

            const sameTarget = hasLockedNextPreloadTarget(queueRef, nextIdx, nextTrack)
                && (nextTrack.file || (nextPreloadSongId === songId
                    && nextPreloadLevel === authService.neteaseQuality
                    && nextPreloadCookie === authService.neteaseCookie
                    && nextPreloadAuthGeneration === authService.authGeneration));
            const reuseUrlPrewarm = sameTarget
                && nextTrack.netease
                && nextPreloadKind === 'netease-url'
                && (nextPreloadStatus === 'url-loading' || nextPreloadStatus === 'url-ready');
            if (sameTarget && (prefetchInProgress || hasPreloaded || nextPreloadStatus === 'skipped')) return;
            if (!sameTarget || nextPreloadStatus === 'failed') cancelNextPreload({ resetAttempted: false, silent: true, resetDetails: false });
            if (!reuseUrlPrewarm && nextSongUrlPrewarmController) {
                try { nextSongUrlPrewarmController.abort(); } catch (_) {}
                nextSongUrlPrewarmController = null;
            }

            const token = reuseUrlPrewarm ? nextPreloadToken : ++nextPreloadToken;
            const controller = nextTrack.file
                ? { aborted: false, abort() { this.aborted = true; } }
                : new AbortController();
            const levelSnapshot = nextTrack.file ? '' : authService.neteaseQuality;
            const generationSnapshot = nextTrack.file ? -1 : authService.authGeneration;
            const prewarmPromiseSnapshot = reuseUrlPrewarm ? nextSongUrlPrewarmPromise : null;
            const prewarmedMetaSnapshot = reuseUrlPrewarm && nextSongPreloadMeta
                ? {
                    ...nextSongPreloadMeta,
                    audioInfo: nextSongPreloadMeta.audioInfo ? { ...nextSongPreloadMeta.audioInfo } : null,
                    candidates: Array.isArray(nextSongPreloadMeta.candidates) ? [...nextSongPreloadMeta.candidates] : []
                }
                : null;
            const snapshot = {
                token,
                queueRef,
                index: nextIdx,
                track: nextTrack,
                songId,
                level: levelSnapshot,
                authGeneration: generationSnapshot,
                cookie: authService.neteaseCookie,
                prewarmPromise: prewarmPromiseSnapshot,
                prewarmedMeta: prewarmedMetaSnapshot,
                recoveryBudget: nextPreloadRecoveryBudget || { urlRefreshUsed: false, stallRecoveryUsed: false }
            };
            nextPreloadRecoveryBudget = snapshot.recoveryBudget;
            nextSongAbortController = controller;
            nextPreloadQueueRef = queueRef;
            nextPreloadTrack = nextTrack;
            nextPreloadIndex = nextIdx;
            nextPreloadSongId = songId;
            nextPreloadLevel = levelSnapshot;
            nextPreloadCookie = snapshot.cookie;
            nextPreloadAuthGeneration = generationSnapshot;
            nextPreloadKind = nextTrack.file ? 'local' : 'netease';
            nextPreloadStatus = 'loading';
            nextSongRawData = null;
            hasPreloaded = false;
            if (!reuseUrlPrewarm) nextSongPreloadMeta = null;
            prefetchInProgress = true;
            prefetchAttempted = true;

            if (nextTrack.netease && !nextTrack.file) lyricsService?.prefetchLyricById(songId);

            const work = nextTrack.file
                ? (async () => {
                    const result = await readLocalAudioForPrefetch(nextTrack.file);
                    if (controller.aborted || !isNextPreloadSnapshotCurrent(token, queueRef, nextIdx, nextTrack, 0, '', -1)) throw createStalePreloadError();
                    return result;
                })()
                : fetchNeteaseAudioForPrefetch(snapshot, controller);
            nextSongFetchPromise = work;
            work.then(result => {
                if (!result || controller.aborted || !isNextPreloadSnapshotCurrent(token, queueRef, nextIdx, nextTrack, songId, levelSnapshot, generationSnapshot)) return;
                nextSongPreloadMeta = {
                    audioUrl: result.audioUrl || '',
                    audioInfo: result.audioInfo || null,
                    candidates: Array.isArray(result.candidates) ? [...result.candidates] : [],
                    usedMatch: !!result.usedMatch,
                    matchSource: result.matchSource || ''
                };
                nextSongRawData = result.kind === 'raw' ? result.ab : null;
                hasPreloaded = result.kind === 'raw' && !!result.ab;
                nextPreloadKind = nextTrack.file ? 'local' : (result.kind === 'raw' ? 'netease' : 'netease-url');
                nextPreloadStatus = result.kind === 'skipped' ? 'skipped' : (hasPreloaded ? 'ready' : 'url-ready');
                if (hasPreloaded) {
                    debugService.log(`Preloaded ${nextTrack.file ? 'local file' : 'Netease audio'}: ${nextTrack.name}`, 'success');
                } else {
                    debugService.log(`Skipped full ${nextTrack.file ? 'local' : 'Netease'} preload for ${nextTrack.name}: ${(result.sizeHint / 1024 / 1024).toFixed(1)}MB exceeds ${(result.maxBytes / 1024 / 1024).toFixed(0)}MB limit`, 'info');
                }
            }).catch(error => {
                if (error?.name !== 'AbortError' && !error?.stale) debugService.log(`Next-song preload failed: ${error?.message || error}`, 'warn');
                if (isNextPreloadSnapshotCurrent(token, queueRef, nextIdx, nextTrack, songId, levelSnapshot, generationSnapshot)) nextPreloadStatus = 'failed';
            }).finally(() => {
                if (nextSongFetchPromise === work) nextSongFetchPromise = null;
                if (!isNextPreloadSnapshotCurrent(token, queueRef, nextIdx, nextTrack, songId, levelSnapshot, generationSnapshot)) return;
                prefetchInProgress = false;
                if (nextPreloadStatus === 'loading') nextPreloadStatus = 'failed';
            });
        } catch (error) {
            if (error?.name !== 'AbortError' && !error?.stale) debugService.log(`Next-song preload setup failed: ${error?.message || error}`, 'warn');
            prefetchInProgress = false;
        }
    }

    let initialized = false;
    return {
        get LOCAL_PREFETCH_TRIGGER_SEC() { return LOCAL_PREFETCH_TRIGGER_SEC; },
        resetNeteaseDetailPrefetchState,
        get nextSongRawData() { return nextSongRawData; },
        set nextSongRawData(value) { nextSongRawData = value; },
        get hasPreloaded() { return hasPreloaded; },
        set hasPreloaded(value) { hasPreloaded = value; },
        get nextPreloadIndex() { return nextPreloadIndex; },
        get prefetchAttempted() { return prefetchAttempted; },
        set prefetchAttempted(value) { prefetchAttempted = value; },
        get prefetchInProgress() { return prefetchInProgress; },
        get nextSongFetchPromise() { return nextSongFetchPromise; },
        get nextSongPreloadMeta() { return nextSongPreloadMeta; },
        set nextSongPreloadMeta(value) { nextSongPreloadMeta = value; },
        get nextPreloadToken() { return nextPreloadToken; },
        get nextPreloadSongId() { return nextPreloadSongId; },
        get nextPreloadKind() { return nextPreloadKind; },
        get nextPreloadStatus() { return nextPreloadStatus; },
        set nextPreloadStatus(value) { nextPreloadStatus = value; },
        get nextPreloadRecoveryBudget() { return nextPreloadRecoveryBudget; },
        hasLockedNextPreloadTarget,
        isNextPreloadCompatible,
        isNextPreloadSnapshotCurrent,
        takeNextPrewarmedNeteaseUrl,
        getNeteasePrefetchTriggerSec,
        takeNextPreloadedRawData,
        waitForPrefetchCompletion,
        cancelNextPreload,
        getLikelyNextPlaylistIndex,
        applyNeteaseSongDetailToPlaylist,
        prefetchUpcomingNeteaseDetails,
        prewarmNextNeteaseSongUrl,
        prefetchNextSong,
        initialize() {
            if (initialized) return;
            initialized = true;

        }
    };
}
