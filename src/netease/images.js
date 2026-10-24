import { toHttps } from '../shared/text.js';

export const MUSIC_IMAGE_RETRY_DELAY_MS = 600;

export function createMusicImages({ root, isActive, fallbackCover, fallbackArtist }, env = window) {
    const pending = new Map();
    let mini = null;
    let paused = false;
    let visibilityBound = false;
    const active = () => !paused && !env.document.hidden && isActive();
    const networkSource = source => {
        try { return /^https?:$/.test(new URL(source, env.location?.href).protocol); }
        catch (_) { return false; }
    };
    const matches = state => pending.get(state.image) === state
        && state.image.isConnected
        && (state.standalone || root.contains(state.image))
        && state.image.getAttribute('src') === state.expected;

    const nearby = new env.IntersectionObserver(entries => {
        for (const entry of entries) {
            const state = pending.get(entry.target);
            if (entry.isIntersecting && state && !state.started && active()) start(state);
        }
    }, { root, rootMargin: '240px 0px', threshold: 0.01 });
    // Only failed images need a second observer for actual visibility, not the preload margin.
    const retries = new env.IntersectionObserver(entries => {
        for (const entry of entries) {
            const state = pending.get(entry.target);
            if (!state?.failed) continue;
            if (entry.isIntersecting) scheduleRetry(state);
            else cancelRetry(state);
        }
    }, { threshold: 0.01 });

    function cancelRetry(state) {
        env.clearTimeout(state.timer);
        state.timer = 0;
    }

    function visible(state) {
        const image = state.image;
        if (!active() || !matches(state) || !image.getClientRects().length) return false;
        const rect = image.getBoundingClientRect();
        const bounds = state.standalone
            ? { top: 0, left: 0, bottom: env.innerHeight, right: env.innerWidth }
            : root.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > Math.max(0, bounds.top)
            && rect.top < Math.min(env.innerHeight, bounds.bottom)
            && rect.right > Math.max(0, bounds.left) && rect.left < Math.min(env.innerWidth, bounds.right);
    }

    function release(state) {
        cancelRetry(state);
        nearby.unobserve(state.image);
        retries.unobserve(state.image);
        state.image.removeEventListener('load', state.loaded);
        state.image.removeEventListener('error', state.failedLoad);
        if (pending.get(state.image) === state) pending.delete(state.image);
    }

    function scheduleRetry(state) {
        if (state.timer || !state.failed || state.attempts >= 2 || !visible(state)) return;
        state.timer = env.setTimeout(() => {
            state.timer = 0;
            if (visible(state) && state.failed) start(state);
        }, MUSIC_IMAGE_RETRY_DELAY_MS);
    }

    function start(state) {
        const { image } = state;
        if (pending.get(image) !== state || !image.isConnected) return;
        if (!state.standalone && (!active() || !root.contains(image))) return;
        nearby.unobserve(image);
        retries.unobserve(image);
        state.started = true;
        state.failed = false;
        state.attempts++;
        delete image.dataset.src;
        state.expected = state.source;
        if (image.getAttribute('src') !== state.source) image.src = state.source;
        if (image.complete && image.naturalWidth > 0) state.loaded();
        else if (image.complete) state.failedLoad();
    }

    function bind(image, source, standalone = false) {
        const previous = pending.get(image);
        if (previous) release(previous);
        const state = { image, source, expected: image.getAttribute('src'), standalone,
            started: false, failed: false, attempts: 0, timer: 0,
            fallback: !standalone && image.closest('.artist') ? fallbackArtist : fallbackCover };
        state.loaded = () => {
            if (matches(state) && image.getAttribute('src') === source) release(state);
        };
        state.failedLoad = () => {
            if (!matches(state) || image.getAttribute('src') !== source) return;
            state.failed = true;
            state.expected = state.fallback;
            image.src = state.fallback;
            if (state.attempts >= 2 || !networkSource(source)) release(state);
            else if (active()) {
                retries.observe(image);
                scheduleRetry(state);
            }
        };
        pending.set(image, state);
        image.addEventListener('load', state.loaded);
        image.addEventListener('error', state.failedLoad);
        // IntersectionObserver is the single preload gate for these thumbnails.
        image.loading = 'eager';
        return state;
    }

    function observe(scope = root) {
        for (const image of scope.querySelectorAll('img[data-src]')) {
            if (image.isConnected && !root.contains(image)) continue;
            const source = toHttps(image.dataset.src || '');
            if (!source) continue;
            let state = pending.get(image);
            if (!state || state.source !== source) state = bind(image, source);
            if (active() && !state.started) nearby.observe(image);
        }
    }

    function clear(scope = root) {
        for (const state of pending.values()) {
            if (state.standalone || (scope !== root && scope !== state.image && !scope.contains(state.image))) continue;
            // Retained tab DOM can be observed again without restarting a healthy in-flight image.
            if (state.image.getAttribute('src') === state.expected) state.image.dataset.src = state.source;
            release(state);
        }
    }

    function setMiniCover(image, source = '') {
        if (!image) return false;
        source = toHttps(source);
        if (mini?.image === image && mini.source === source && image.getAttribute('src') === mini.expected) return false;
        if (mini) release(mini);
        mini = null;
        if (!source) {
            image.removeAttribute('src');
            return true;
        }
        mini = bind(image, source, true);
        // Move Blob consumers immediately, even while the panel is closed.
        start(mini);
        return true;
    }

    function suspend() {
        nearby.disconnect();
        retries.disconnect();
        for (const state of pending.values()) cancelRetry(state);
    }

    function resume() {
        paused = false;
        if (!active()) return;
        observe();
        for (const state of pending.values()) {
            if (!state.image.isConnected) { release(state); continue; }
            if (state.failed) retries.observe(state.image);
            else if (!state.started) nearby.observe(state.image);
        }
    }

    function onVisibilityChange() {
        if (env.document.hidden) suspend();
        else if (!paused) resume();
    }

    return {
        observe,
        clear,
        setMiniCover,
        pause() { paused = true; suspend(); },
        resume,
        initialize() {
            if (visibilityBound) return;
            visibilityBound = true;
            env.document.addEventListener('visibilitychange', onVisibilityChange);
        },
        dispose() {
            suspend();
            for (const state of pending.values()) release(state);
            mini = null;
            env.document.removeEventListener('visibilitychange', onVisibilityChange);
            visibilityBound = false;
        }
    };
}
