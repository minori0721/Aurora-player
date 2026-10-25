import { toHttps } from '../shared/text.js';

const CONCURRENCY = 4;
const NEAR_CONCURRENCY = 2;
const MARGIN = 300;
const SCROLL_IDLE_MS = 120;
const RECLAIM_AFTER_MS = 500;
const TIMEOUT_MS = 8000;
const CACHE_LIMIT = 300;

export function playlistCoverSrc(value) {
    if (!value) return '';
    try {
        const url = new URL(toHttps(value));
        if (['data:', 'blob:'].includes(url.protocol)) return url.href;
        if (url.protocol !== 'https:') return '';
        url.searchParams.set('param', '80y80');
        return url.href;
    } catch (_) { return ''; }
}

export function createPlaylistCovers({ root, container }, env = window) {
    const resources = new Map();
    const nearby = new Set(), observed = new Set(), active = new Set();
    let generation = 0, observer = null, resizeObserver = null;
    let frame = null, wakeTimer = null, wakeAt = Infinity;
    let lastScrollAt = -Infinity, reclaimed = 0, initialized = false, disposed = false;
    const now = () => env.performance.now();
    const isOpen = () => !disposed && root.classList.contains('show') && !env.document.hidden;
    const current = (img, src = img.dataset.coverSrc) => img.isConnected
        && img.dataset.coverGeneration === String(generation) && !!src && img.dataset.coverSrc === src;
    const filtered = img => !!img.closest?.('.pl-item')?.hidden;

    function clearWake() {
        if (wakeTimer !== null) env.clearTimeout(wakeTimer);
        wakeTimer = null;
        wakeAt = Infinity;
    }

    function requestUpdate() {
        if (!isOpen() || frame !== null) return;
        frame = env.requestAnimationFrame(() => { frame = null; update(); });
    }

    function wakeAtTime(time) {
        if (!isOpen() || time >= wakeAt) return;
        clearWake();
        wakeAt = time;
        wakeTimer = env.setTimeout(() => { wakeTimer = null; wakeAt = Infinity; requestUpdate(); }, Math.max(0, time - now()));
    }

    function getResource(src) {
        let resource = resources.get(src);
        if (!resource) {
            resource = { src, status: 'idle', failures: 0, retryAt: 0, lastUsed: now(), waiters: new Set(), job: null };
            resources.set(src, resource);
        }
        resource.lastUsed = now();
        return resource;
    }

    function trim() {
        for (const resource of resources.values()) {
            if (!resource.job && !resource.waiters.size && resource.status === 'idle' && !resource.failures) resources.delete(resource.src);
        }
        if (resources.size <= CACHE_LIMIT) return;
        const unused = [...resources.values()].filter(item => !item.job && !item.waiters.size)
            .sort((a, b) => a.lastUsed - b.lastUsed);
        for (const resource of unused) {
            if (resources.size <= CACHE_LIMIT) break;
            resources.delete(resource.src);
        }
    }

    function unobserve(img) {
        observer?.unobserve(img);
        observed.delete(img);
        nearby.delete(img);
    }

    function apply(resource, img) {
        if (!isOpen() || !current(img, resource.src) || filtered(img)) return;
        const src = resource.src;
        const reveal = () => {
            if (!current(img, src)) return;
            img.classList.remove('empty');
            img.dataset.coverLoaded = '1';
            img.onload = img.onerror = null;
        };
        img.onload = reveal;
        img.onerror = () => {
            if (!current(img, src)) return;
            img.onload = img.onerror = null;
            img.classList.add('empty');
            delete img.dataset.coverLoaded;
            img.dataset.src = src;
            if (resource.status === 'loaded') {
                resource.status = 'retry-wait';
                resource.failures = 1;
                resource.retryAt = now() + 400;
            }
            register(img);
            requestUpdate();
        };
        img.loading = 'eager';
        img.src = src;
        if (img.complete && img.naturalWidth > 0) reveal();
        delete img.dataset.src;
        resource.waiters.delete(img);
        unobserve(img);
    }

    function start(resource) {
        const probe = new env.Image();
        const job = { resource, probe, anchors: [...resource.waiters], startedAt: now(), finish: null };
        let settled = false;
        const finish = result => {
            if (settled) return;
            settled = true;
            env.clearTimeout(timeout);
            probe.onload = probe.onerror = null;
            active.delete(job);
            resource.job = null;
            if (result !== 'loaded') { try { probe.src = ''; } catch (_) {} }
            if (result === 'loaded') {
                resource.status = 'loaded';
                resource.failures = 0;
                resource.retryAt = 0;
                resource.lastUsed = now();
                for (const img of [...resource.waiters]) if (nearby.has(img)) apply(resource, img);
            } else if (result === 'cancel') {
                resource.status = 'idle';
            } else {
                resource.status = 'retry-wait';
                resource.failures++;
                resource.retryAt = now() + (resource.failures > 2 ? 30000
                    : 400 * 3 ** (resource.failures - 1) + Math.floor(Math.random() * 120));
            }
            trim();
            requestUpdate();
        };
        const timeout = env.setTimeout(() => finish('failed'), TIMEOUT_MS);
        job.finish = finish;
        resource.job = job;
        resource.status = 'loading';
        if (resource.failures > 2) resource.failures = 0;
        active.add(job);
        probe.referrerPolicy = 'no-referrer';
        probe.decoding = 'async';
        probe.fetchPriority = resource.visible ? 'auto' : 'low';
        probe.onload = () => finish('loaded');
        probe.onerror = () => finish('failed');
        try { probe.src = resource.src; } catch (_) { finish('failed'); }
    }

    function distance(rect, bounds) {
        return Math.max(bounds.top - rect.bottom, rect.top - bounds.bottom, 0);
    }

    function update() {
        clearWake();
        if (!isOpen()) return;
        const time = now(), bounds = root.getBoundingClientRect();
        const idleAt = lastScrollAt + SCROLL_IDLE_MS;
        for (const resource of resources.values()) {
            resource.waiters.clear();
            resource.visible = false;
            resource.distance = Infinity;
        }
        // Only the observer's small nearby set needs geometry reads, not the whole playlist.
        for (const img of nearby) {
            if (!current(img) || img.dataset.coverLoaded === '1') { unobserve(img); continue; }
            if (filtered(img)) { nearby.delete(img); continue; }
            const rect = img.getBoundingClientRect(), gap = distance(rect, bounds);
            if (gap > MARGIN) { nearby.delete(img); continue; }
            const resource = getResource(img.dataset.coverSrc);
            resource.waiters.add(img);
            resource.visible ||= rect.bottom > bounds.top && rect.top < bounds.bottom;
            resource.distance = Math.min(resource.distance, gap);
        }
        const pending = [];
        for (const resource of resources.values()) {
            if (!resource.waiters.size) continue;
            if (resource.status === 'loaded') {
                for (const img of [...resource.waiters]) apply(resource, img);
            } else if (!resource.job) pending.push(resource);
            else resource.job.probe.fetchPriority = resource.visible ? 'auto' : 'low';
        }
        const ready = pending.filter(resource => resource.retryAt <= time && (resource.visible || !resource.failures));
        ready.sort((a, b) => (a.visible ? (a.failures ? 1 : 0) : 2) - (b.visible ? (b.failures ? 1 : 0) : 2)
            || a.distance - b.distance);

        if (active.size >= CONCURRENCY && reclaimed < 2 && ready.some(resource => resource.visible)) {
            const remote = [...active].filter(job => !job.resource.waiters.size)
                .map(job => ({ job, gap: Math.min(...job.anchors.filter(img => current(img, job.resource.src))
                    .map(img => distance(img.getBoundingClientRect(), bounds))) }))
                .filter(item => item.gap > MARGIN).sort((a, b) => b.gap - a.gap);
            for (const { job } of remote) {
                const due = Math.max(idleAt, job.startedAt + RECLAIM_AFTER_MS);
                if (due > time) { wakeAtTime(due); continue; }
                job.finish('cancel');
                if (++reclaimed >= 2) break;
            }
        }

        for (const resource of ready) {
            if (active.size >= CONCURRENCY) break;
            if (!resource.visible) {
                if (time < idleAt) { wakeAtTime(idleAt); continue; }
                if ([...active].filter(job => !job.resource.visible).length >= NEAR_CONCURRENCY) continue;
            }
            start(resource);
        }
        for (const resource of pending) {
            if (resource.visible && resource.retryAt > time) wakeAtTime(resource.retryAt);
        }
        trim();
    }

    function register(img) {
        if (!isOpen() || !img.dataset.coverSrc || observed.has(img) || img.dataset.coverLoaded === '1') return;
        observed.add(img);
        observer.observe(img);
    }

    function ensureObserver() {
        if (observer) return;
        observer = new env.IntersectionObserver(entries => {
            for (const entry of entries) {
                const img = entry.target;
                if (!observed.has(img) || !current(img)) continue;
                if (entry.isIntersecting) nearby.add(img);
                else nearby.delete(img);
            }
            requestUpdate();
        }, { root, rootMargin: `${MARGIN}px 0px`, threshold: 0 });
    }

    function bind(img, value) {
        const src = playlistCoverSrc(value);
        if (img.dataset.coverGeneration === String(generation) && img.dataset.coverSrc === src) return;
        unobserve(img);
        const old = resources.get(img.dataset.coverSrc);
        old?.waiters.delete(img);
        if (old?.job && !old.waiters.size) old.job.finish('cancel');
        img.onload = img.onerror = null;
        img.removeAttribute('src');
        img.classList.add('empty');
        delete img.dataset.coverLoaded;
        img.dataset.coverGeneration = String(generation);
        img.dataset.coverSrc = src;
        if (src) {
            img.dataset.src = src;
            ensureObserver();
            register(img);
        } else delete img.dataset.src;
        requestUpdate();
    }

    function observe() {
        if (!isOpen()) return;
        ensureObserver();
        container.querySelectorAll('.pl-item-cover[data-src]').forEach(register);
        requestUpdate();
    }

    function suspend() {
        clearWake();
        if (frame !== null) env.cancelAnimationFrame(frame);
        frame = null;
        observer?.disconnect();
        observed.clear();
        nearby.clear();
        reclaimed = 0;
        lastScrollAt = -Infinity;
        for (const resource of resources.values()) resource.waiters.clear();
    }

    function reset() {
        generation++;
        suspend();
        for (const job of [...active]) job.finish('cancel');
        trim();
    }

    function onScroll() {
        lastScrollAt = now();
        reclaimed = 0;
        requestUpdate();
    }

    function onVisibility() {
        if (env.document.hidden) suspend();
        else observe();
    }

    function initialize() {
        if (initialized) return;
        initialized = true;
        root.addEventListener('scroll', onScroll, { passive: true });
        env.addEventListener('resize', onScroll);
        env.document.addEventListener('visibilitychange', onVisibility);
        if (env.ResizeObserver) {
            resizeObserver = new env.ResizeObserver(requestUpdate);
            resizeObserver.observe(root);
        }
    }

    function dispose() {
        disposed = true;
        reset();
        resizeObserver?.disconnect();
        root.removeEventListener('scroll', onScroll);
        env.removeEventListener('resize', onScroll);
        env.document.removeEventListener('visibilitychange', onVisibility);
        resources.clear();
    }

    return { bind, observe, suspend, reset, initialize, dispose, visibilityChanged: requestUpdate };
}
