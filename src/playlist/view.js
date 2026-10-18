import { toHttps } from '../shared/text.js';

export function createPlaylistView({
    dom: domService,
    persistence: persistenceService,
    prefetch: prefetchService,
    queue: queueService
} = {}) {
    let playlistCoverObserver = null;

    const PLAYLIST_COVER_CONCURRENCY = 4;

    const PLAYLIST_COVER_BATCH_INTERVAL_MS = 80;

    const PLAYLIST_COVER_RETRY_MAX = 2;

    const PLAYLIST_COVER_RETRY_BASE_MS = 400;

    const PLAYLIST_COVER_FAILURE_COOLDOWN_MS = 30 * 1000;

    const PLAYLIST_COVER_REQUEST_TIMEOUT_MS = 8 * 1000;

    const PLAYLIST_COVER_CACHE_MAX_ENTRIES = 300;

    let playlistCoverGeneration = 0;

    let playlistCoverActive = 0;

    let playlistCoverQueue = [];

    let playlistCoverQueueSequence = 0;

    let playlistCoverPumpTimer = null;

    let playlistCoverPumpDueAt = Infinity;

    const playlistCoverResources = new Map();

    function getPlaylistCoverBatchSize() {
        return window.innerWidth <= 768 ? 10 : 16;
    }

    function buildPlaylistCoverSrc(url) {
        const value = toHttps(url || '');
        if (!value) return '';
        return `${value}${value.includes('?') ? '&' : '?'}param=80y80`;
    }

    function isCurrentPlaylistCoverImage(img, src = img?.dataset?.coverSrc, requireConnected = true) {
        return !!img && (!requireConnected || img.isConnected)
            && img.dataset.coverGeneration === String(playlistCoverGeneration)
            && !!src && img.dataset.coverSrc === src;
    }

    function getPlaylistCoverResource(src) {
        let resource = playlistCoverResources.get(src);
        if (!resource) {
            resource = {
                src,
                status: 'idle',
                attempt: 0,
                retryAt: 0,
                priority: 2,
                queueVersion: 0,
                lastUsed: Date.now(),
                waiters: new Set(),
                probe: null,
                cancelled: false,
                loadToken: 0
            };
            playlistCoverResources.set(src, resource);
        }
        resource.lastUsed = Date.now();
        return resource;
    }

    function applyPlaylistCoverResource(resource, img) {
        if (!resource || !isCurrentPlaylistCoverImage(img, resource.src, false)) return;
        img.src = resource.src;
        img.classList.remove('empty');
        img.removeAttribute('data-src');
        img.removeAttribute('data-observing');
        img.removeAttribute('data-next-retry-at');
        img.dataset.coverLoaded = '1';
        resource.waiters.delete(img);
    }

    function prunePlaylistCoverWaiters(resource) {
        if (!resource) return 0;
        resource.waiters.forEach(img => {
            if (!isCurrentPlaylistCoverImage(img, resource.src)) resource.waiters.delete(img);
        });
        return resource.waiters.size;
    }

    function detachPlaylistCoverImage(img) {
        const src = img?.dataset?.coverSrc;
        if (src) playlistCoverResources.get(src)?.waiters.delete(img);
        if (img) {
            delete img.dataset.coverSrc;
            delete img.dataset.coverLoaded;
            delete img.dataset.coverGeneration;
        }
    }

    function bindPlaylistCoverImage(img, src, enqueue = false) {
        if (!img) return;
        const normalizedSrc = src ? toHttps(src) : '';
        const oldSrc = img.dataset.coverSrc || '';
        if (oldSrc && oldSrc !== normalizedSrc) detachPlaylistCoverImage(img);

        img.dataset.coverGeneration = String(playlistCoverGeneration);
        if (!normalizedSrc) {
            img.classList.add('empty');
            img.removeAttribute('src');
            img.removeAttribute('data-src');
            img.removeAttribute('data-observing');
            img.removeAttribute('data-next-retry-at');
            delete img.dataset.coverSrc;
            delete img.dataset.coverLoaded;
            return;
        }

        const resource = getPlaylistCoverResource(normalizedSrc);
        resource.waiters.add(img);
        img.dataset.coverSrc = normalizedSrc;
        img.classList.add('empty');
        if (resource.status === 'loaded') {
            applyPlaylistCoverResource(resource, img);
            return;
        }

        img.dataset.src = normalizedSrc;
        img.removeAttribute('src');
        delete img.dataset.coverLoaded;
        if (enqueue) enqueuePlaylistCover(img, 1);
    }

    function schedulePlaylistCoverPump(delay = 0) {
        const dueAt = performance.now() + Math.max(0, Number(delay) || 0);
        if (playlistCoverPumpTimer && dueAt >= playlistCoverPumpDueAt) return;
        if (playlistCoverPumpTimer) clearTimeout(playlistCoverPumpTimer);
        playlistCoverPumpDueAt = dueAt;
        playlistCoverPumpTimer = setTimeout(() => {
            playlistCoverPumpTimer = null;
            playlistCoverPumpDueAt = Infinity;
            pumpPlaylistCoverQueue();
        }, Math.max(0, dueAt - performance.now()));
    }

    function queuePlaylistCoverResource(resource, priority = 1) {
        if (!resource || resource.status === 'loaded') return;
        if (!prunePlaylistCoverWaiters(resource)) return;
        const now = Date.now();
        if (resource.status === 'loading' && !resource.cancelled) return;
        if (resource.retryAt > now) {
            schedulePlaylistCoverPump(resource.retryAt - now);
            return;
        }
        resource.status = 'idle';
        resource.priority = Math.min(Number(resource.priority || 2), priority);
        resource.queueVersion += 1;
        playlistCoverQueue.push({
            resource,
            version: resource.queueVersion,
            priority: resource.priority,
            sequence: ++playlistCoverQueueSequence
        });
        schedulePlaylistCoverPump(0);
    }

    function enqueuePlaylistCover(img, priority = 1) {
        if (!img) return;
        const src = img.dataset.coverSrc || img.dataset.src;
        if (!src) return;
        const resource = getPlaylistCoverResource(src);
        resource.waiters.add(img);
        queuePlaylistCoverResource(resource, priority);
    }

    function enqueueDuePlaylistCoverRetries() {
        const now = Date.now();
        playlistCoverResources.forEach(resource => {
            if (resource.status !== 'retry-wait' || resource.retryAt > now) return;
            resource.retryAt = 0;
            resource.priority = 2;
            queuePlaylistCoverResource(resource, 2);
        });
    }

    function getNextPlaylistCoverRetryDelay() {
        const now = Date.now();
        let nextDelay = null;
        playlistCoverResources.forEach(resource => {
            prunePlaylistCoverWaiters(resource);
            if (!resource.waiters.size || resource.status !== 'retry-wait' || resource.retryAt <= now) return;
            const delay = resource.retryAt - now;
            if (nextDelay === null || delay < nextDelay) nextDelay = delay;
        });
        return nextDelay;
    }

    function loadPlaylistCoverAttempt(resource) {
        return new Promise(resolve => {
            const probe = new Image();
            let settled = false;
            const finish = ok => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                if (resource.probe === probe) resource.probe = null;
                resolve(ok);
            };
            const timeout = setTimeout(() => finish(false), PLAYLIST_COVER_REQUEST_TIMEOUT_MS);
            resource.probe = probe;
            probe.referrerPolicy = 'no-referrer';
            probe.decoding = 'async';
            probe.onload = () => finish(true);
            probe.onerror = () => finish(false);
            probe.src = resource.src;
        });
    }

    function completePlaylistCoverAttempt(resource, ok, loadToken) {
        if (!resource) return;
        if (loadToken !== resource.loadToken || resource.cancelled) return;
        if (ok) {
            resource.status = 'loaded';
            resource.attempt = 0;
            resource.retryAt = 0;
            resource.priority = 2;
            prunePlaylistCoverWaiters(resource);
            resource.waiters.forEach(img => applyPlaylistCoverResource(resource, img));
            return;
        }

        resource.attempt += 1;
        const exhausted = resource.attempt > PLAYLIST_COVER_RETRY_MAX;
        resource.status = 'retry-wait';
        resource.retryAt = Date.now() + (exhausted
            ? PLAYLIST_COVER_FAILURE_COOLDOWN_MS
            : PLAYLIST_COVER_RETRY_BASE_MS * Math.pow(3, resource.attempt - 1) + Math.floor(Math.random() * 120));
        if (exhausted) resource.attempt = 0;
        prunePlaylistCoverWaiters(resource);
        resource.waiters.forEach(img => {
            if (isCurrentPlaylistCoverImage(img, resource.src)) img.classList.add('empty');
        });
        schedulePlaylistCoverPump(Math.max(0, resource.retryAt - Date.now()));
    }

    function cancelOrphanedPlaylistCoverResources() {
        playlistCoverResources.forEach((resource, src) => {
            prunePlaylistCoverWaiters(resource);
            if (resource.waiters.size) return;
            resource.queueVersion += 1;
            if (resource.status === 'loading') {
                resource.cancelled = true;
                resource.loadToken += 1;
                resource.status = 'idle';
                resource.retryAt = 0;
                if (resource.probe) {
                    try { resource.probe.src = ''; } catch (_) {}
                }
                return;
            }
            playlistCoverResources.delete(src);
        });
        playlistCoverQueue = playlistCoverQueue.filter(entry => {
            return entry?.resource && playlistCoverResources.get(entry.resource.src) === entry.resource
                && entry.version === entry.resource.queueVersion;
        });
    }

    function trimPlaylistCoverResourceCache() {
        if (playlistCoverResources.size <= PLAYLIST_COVER_CACHE_MAX_ENTRIES) return;
        const candidates = Array.from(playlistCoverResources.values())
            .filter(resource => resource.status !== 'loading' && !resource.waiters.size)
            .sort((a, b) => a.lastUsed - b.lastUsed);
        while (playlistCoverResources.size > PLAYLIST_COVER_CACHE_MAX_ENTRIES && candidates.length) {
            playlistCoverResources.delete(candidates.shift().src);
        }
    }

    function takePlaylistCoverQueueEntry() {
        playlistCoverQueue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
        return playlistCoverQueue.shift() || null;
    }

    function pumpPlaylistCoverQueue() {
        if (!domService.el.plSidebar || !domService.el.plSidebar.classList.contains('show')) return;
        enqueueDuePlaylistCoverRetries();
        cancelOrphanedPlaylistCoverResources();
        const batchSize = getPlaylistCoverBatchSize();
        let launched = 0;

        while (playlistCoverActive < PLAYLIST_COVER_CONCURRENCY && launched < batchSize) {
            const entry = takePlaylistCoverQueueEntry();
            if (!entry) break;
            const resource = entry.resource;
            if (!resource || entry.version !== resource.queueVersion || resource.status === 'loaded') continue;
            if (!prunePlaylistCoverWaiters(resource)) continue;
            const now = Date.now();
            if (resource.retryAt > now) {
                schedulePlaylistCoverPump(resource.retryAt - now);
                continue;
            }

            resource.status = 'loading';
            resource.cancelled = false;
            const loadToken = ++resource.loadToken;
            resource.lastUsed = Date.now();
            playlistCoverActive++;
            launched++;
            loadPlaylistCoverAttempt(resource)
                .then(ok => completePlaylistCoverAttempt(resource, ok, loadToken))
                .finally(() => {
                    playlistCoverActive = Math.max(0, playlistCoverActive - 1);
                    trimPlaylistCoverResourceCache();
                    schedulePlaylistCoverPump(0);
                });
        }

        if (playlistCoverQueue.length > 0) {
            schedulePlaylistCoverPump(PLAYLIST_COVER_BATCH_INTERVAL_MS);
        } else {
            const nextDelay = getNextPlaylistCoverRetryDelay();
            if (nextDelay !== null) schedulePlaylistCoverPump(Math.max(50, nextDelay));
        }
    }

    function ensurePlaylistCoverObserver() {
        if (playlistCoverObserver || !domService.el.plSidebar) return;
        playlistCoverObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const img = entry.target;
                img.removeAttribute('data-observing');
                observer.unobserve(img);
                const rect = img.getBoundingClientRect();
                const rootRect = domService.el.plSidebar.getBoundingClientRect();
                const priority = rect.bottom > rootRect.top && rect.top < rootRect.bottom ? 0 : 1;
                enqueuePlaylistCover(img, priority);
            });
        }, {
            root: domService.el.plSidebar,
            rootMargin: '300px 0px',
            threshold: 0.01
        });
    }

    function observePlaylistCovers() {
        if (!domService.el.plSidebar || !domService.el.plSidebar.classList.contains('show')) return;
        ensurePlaylistCoverObserver();
        if (!playlistCoverObserver) return;
        domService.el.plContainer.querySelectorAll('.pl-item-cover[data-src]').forEach(img => {
            if (img.dataset.observing === '1') return;
            img.dataset.observing = '1';
            playlistCoverObserver.observe(img);
        });
        schedulePlaylistCoverPump(0);
    }

    let activePlaylistRow = null;

    function updatePlaylistActiveItem() {
        const nextRow = domService.el.plContainer.children[queueService.curIdx] || null;
        if (activePlaylistRow !== nextRow) {
            if (activePlaylistRow) {
                activePlaylistRow.classList.remove('active');
                activePlaylistRow.setAttribute('aria-current', 'false');
            }
            if (nextRow) {
                nextRow.classList.add('active');
                nextRow.setAttribute('aria-current', 'true');
            }
            activePlaylistRow = nextRow;
        }
        if (typeof persistenceService.schedulePlaylistStateSave === 'function') persistenceService.schedulePlaylistStateSave();
    }

    function updatePlaylistCompanionMarker(row, track) {
        row.querySelector('.pl-item-companion')?.remove();
        if (track?.needsFile) {
            const marker = document.createElement('span');
            marker.className = 'pl-item-companion warn';
            marker.textContent = '!';
            marker.title = track.fileHandle ? '点击播放以授权读取本地文件' : '本地文件未恢复，请重新选择或导入文件';
            marker.setAttribute('aria-label', marker.title);
            row.appendChild(marker);
            return;
        }
        if (!track || track.netease || !['valid', 'invalid', 'ambiguous'].includes(track.sliStatus)) return;
        const hasWarning = track.sliStatus !== 'valid' || !!track.sliRuntimeError;
        const marker = document.createElement('span');
        marker.className = `pl-item-companion${hasWarning ? ' warn' : ''}`;
        marker.textContent = hasWarning ? '!' : '∞';
        marker.title = hasWarning ? `SLI ${track.sliStatus === 'ambiguous' ? '匹配歧义' : '无效'}: ${track.sliRuntimeError || track.sliMessage || '未知原因'}` : '已匹配 SLI 循环';
        marker.setAttribute('aria-label', marker.title);
        row.appendChild(marker);
    }

    function refreshPlaylistItem(index) {
        persistenceService.schedulePlaylistTrackSave(index);
        const row = domService.el.plContainer.children[index];
        const track = queueService.playlist[index];
        if (!row || !track) return;

        row.setAttribute('aria-label', track.needsFile
            ? (track.fileHandle ? `授权并播放第 ${index + 1} 首：${track.name}` : `第 ${index + 1} 首：${track.name}，需要重新选择本地文件`)
            : `播放第 ${index + 1} 首：${track.name}`);
        const titleEl = row.querySelector('.pl-item-title');
        if (titleEl) {
            const icon = track.netease ? '☁️ ' : (track.needsFile ? '⚠️ ' : '');
            titleEl.textContent = `${icon}${track.name}`;
        }
        updatePlaylistCompanionMarker(row, track);

        const coverEl = row.querySelector('.pl-item-cover');
        if (!coverEl) return;
        const coverUrl = toHttps(track.songData?.album?.picUrl || track.songData?.al?.picUrl || '');
        const src = buildPlaylistCoverSrc(coverUrl);
        if (coverEl.dataset.coverSrc === src && src && coverEl.dataset.coverLoaded === '1') return;
        bindPlaylistCoverImage(coverEl, src, !!(domService.el.plSidebar && domService.el.plSidebar.classList.contains('show')));
        if (src && domService.el.plSidebar && domService.el.plSidebar.classList.contains('show')) observePlaylistCovers();
    }

    function ensurePlaylistRenderedAndActive() {
        if (domService.el.plContainer.children.length !== queueService.playlist.length) renderPlaylist();
        else updatePlaylistActiveItem();
    }

    function createPlaylistRow(track, index) {
        const d = document.createElement('button');
        d.type = 'button';
        d.className = 'pl-item';
        d.setAttribute('aria-current', 'false');
        const indexEl = document.createElement('span');
        indexEl.className = 'pl-item-index';
        indexEl.textContent = String(index + 1);

        const coverEl = document.createElement('img');
        coverEl.className = 'pl-item-cover empty';
        coverEl.width = 30;
        coverEl.height = 30;
        coverEl.alt = '歌曲封面';
        coverEl.loading = 'lazy';
        coverEl.decoding = 'async';
        coverEl.referrerPolicy = 'no-referrer';
        const coverUrl = toHttps(track.songData?.album?.picUrl || track.songData?.al?.picUrl || '');
        bindPlaylistCoverImage(coverEl, buildPlaylistCoverSrc(coverUrl));

        const titleEl = document.createElement('span');
        titleEl.className = 'pl-item-title';
        d.appendChild(indexEl);
        d.appendChild(coverEl);
        d.appendChild(titleEl);
        updatePlaylistCompanionMarker(d, track);
        d.onclick = () => {
            if (!prefetchService.isNextPreloadCompatible(queueService.playlist, index, track)) {
                try { prefetchService.cancelNextPreload(); } catch(e) {}
            }
            queueService.playTrackFromPlaylist(index);
        };
        d.setAttribute('aria-label', track.needsFile
            ? (track.fileHandle ? `授权并播放第 ${index + 1} 首：${track.name}` : `第 ${index + 1} 首：${track.name}，需要重新选择本地文件`)
            : `播放第 ${index + 1} 首：${track.name}`);
        const icon = track.netease ? '☁️ ' : (track.needsFile ? '⚠️ ' : '');
        titleEl.textContent = `${icon}${track.name}`;
        return d;
    }

    function appendPlaylistRows(startIndex = 0, force = false) {
        if (!force && domService.el.plContainer.children.length !== startIndex) {
            renderPlaylist();
            return;
        }
        const frag = document.createDocumentFragment();
        for (let i = startIndex; i < queueService.playlist.length; i++) frag.appendChild(createPlaylistRow(queueService.playlist[i], i));
        domService.el.plContainer.appendChild(frag);
        updatePlaylistActiveItem();
        observePlaylistCovers();
        cancelOrphanedPlaylistCoverResources();
        trimPlaylistCoverResourceCache();
        persistenceService.schedulePlaylistStateSave(true);
    }

    function renderPlaylist() {
        playlistCoverGeneration += 1;
        if (playlistCoverObserver && domService.el.plContainer) {
            domService.el.plContainer.querySelectorAll('.pl-item-cover').forEach(img => playlistCoverObserver.unobserve(img));
        }
        domService.el.plContainer.innerHTML = '';
        activePlaylistRow = null;
        playlistCoverQueue = [];
        appendPlaylistRows(0, true);
        if (typeof persistenceService.schedulePlaylistStateSave === 'function') persistenceService.schedulePlaylistStateSave(true);
    }

    function scrollPlaylistToCurrent() {
        if (!domService.el.plSidebar || !queueService.playlist || queueService.playlist.length === 0 || queueService.curIdx < 0) return;
        const active = domService.el.plContainer.querySelector('.pl-item.active');
        if (!active) return; // no current item in list, keep still
        active.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function scrollPlaylistToTop() {
        if (!domService.el.plSidebar) return;
        domService.el.plSidebar.scrollTo({ top: 0, behavior: 'smooth' });
    }

    let initialized = false;
    return {
        observePlaylistCovers,
        refreshPlaylistItem,
        ensurePlaylistRenderedAndActive,
        appendPlaylistRows,
        renderPlaylist,
        scrollPlaylistToCurrent,
        scrollPlaylistToTop,
        initialize() {
            if (initialized) return;
            initialized = true;

        }
    };
}
