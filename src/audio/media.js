// A media element owns its browser buffer. It is not an application audio-file cache.
export function createMediaTransport(url, { element = document.createElement('audio'), startupMs = 10000, stallMs = 15000 } = {}) {
    let disposed = false, settled = false, callbacks = {}, source = null;
    let lastProgress = performance.now(), lastPosition = -1, lastBuffered = -1;
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    ready.catch(() => {});
    const listeners = [];
    const listen = (name, handler) => {
        element.addEventListener(name, handler);
        listeners.push([name, handler]);
    };
    function fail(error) {
        if (disposed) return;
        if (!settled) { settled = true; rejectReady(error); }
        else callbacks.error?.(error);
    }
    function bufferedEnd() {
        const ranges = element.buffered;
        for (let i = 0; i < (ranges?.length || 0); i++) {
            if (ranges.start(i) <= element.currentTime + 0.1 && ranges.end(i) >= element.currentTime) return ranges.end(i);
        }
        return 0;
    }
    listen('loadedmetadata', () => {
        if (disposed) return;
        lastProgress = performance.now();
        if (!settled) { settled = true; resolveReady(); }
        callbacks.duration?.();
    });
    listen('durationchange', () => { if (!disposed) callbacks.duration?.(); });
    listen('playing', () => { if (!disposed) { lastProgress = performance.now(); callbacks.state?.('playing'); } });
    listen('waiting', () => { if (!disposed) callbacks.state?.('loading'); });
    listen('seeking', () => { if (!disposed) { lastProgress = performance.now(); callbacks.state?.('loading'); callbacks.seek?.(); } });
    listen('seeked', () => {
        if (disposed) return;
        lastProgress = performance.now();
        callbacks.seek?.();
        if (!element.paused) callbacks.state?.(element.readyState >= 3 ? 'playing' : 'loading');
    });
    listen('progress', () => { if (!disposed) callbacks.progress?.(); });
    listen('ended', () => { if (!disposed) callbacks.ended?.(); });
    listen('error', () => fail(Object.assign(new Error(`流式音频加载失败 (${element.error?.code || 'unknown'})`), { mediaCode: element.error?.code })));
    const watchdog = setInterval(() => {
        if (disposed) return;
        const now = performance.now();
        // Background freezing and offline time are not evidence of a broken URL.
        if (document.hidden || navigator.onLine === false || callbacks.suspended?.()) { lastProgress = now; return; }
        const position = Number(element.currentTime || 0), buffered = bufferedEnd();
        if (position !== lastPosition || buffered > lastBuffered) {
            lastProgress = now; lastPosition = position; lastBuffered = buffered;
        }
        if ((!settled || !element.paused && !element.ended) && now - lastProgress >= (settled ? stallMs : startupMs)) {
            fail(Object.assign(new Error('流式音频长时间没有进展'), { timeout: true }));
            lastProgress = now;
        }
    }, 1000);
    element.crossOrigin = 'anonymous';
    element.preload = 'auto';
    element.setAttribute('playsinline', '');
    element.src = url;
    element.load();
    return {
        ready, element, url,
        get disposed() { return disposed; },
        get duration() { return Number.isFinite(element.duration) ? element.duration : 0; },
        get time() { return Number(element.currentTime || 0); },
        get ended() { return element.ended; },
        bufferedEnd,
        observe(next) { callbacks = next; },
        connect(context, destination) {
            if (!source) { source = context.createMediaElementSource(element); source.connect(destination); }
        },
        async play(offset, isCurrent = () => true) {
            await ready;
            if (disposed || !isCurrent()) return;
            if (Number.isFinite(offset) && Math.abs(element.currentTime - offset) > 0.025) element.currentTime = Math.max(0, Math.min(offset, this.duration || offset));
            lastProgress = performance.now();
            await element.play();
        },
        pause() { element.pause(); lastProgress = performance.now(); },
        seek(offset) { element.currentTime = Math.max(0, Math.min(offset, this.duration || offset)); lastProgress = performance.now(); },
        dispose() {
            if (disposed) return;
            disposed = true;
            if (!settled) rejectReady(new DOMException('Stream disposed', 'AbortError'));
            clearInterval(watchdog);
            callbacks = {};
            listeners.forEach(([name, handler]) => element.removeEventListener(name, handler));
            try { source?.disconnect(); } catch (_) {}
            element.pause();
            element.removeAttribute('src');
            element.load();
        }
    };
}

export function readPlaybackPreference(storage) {
    try { return (storage ?? globalThis.localStorage)?.getItem('aurora_playback_mode') === 'complete' ? 'complete' : 'stream'; }
    catch (_) { return 'stream'; }
}

export function pcmSizeEstimate(duration, sampleRate = 48000, channels = 2) {
    return Math.ceil(Math.max(0, Number(duration) || 0) * Math.max(48000, Number(sampleRate) || 0) * channels * 4);
}
