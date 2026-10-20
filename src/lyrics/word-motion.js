export function createWordLyricMotion(viewport, { getTime, isPlaying, isClockRunning = () => true,
    getTransportVersion = () => 0, environment = window, document: doc = document } = {}) {
    const reduced = environment.matchMedia('(prefers-reduced-motion: reduce)');
    let cache = new WeakMap(), line = null, words = [], animations = [];
    let visible = true, mode = '', transport = -1, lastAudio = -Infinity, disposed = false;
    let supported = true;
    const write = (node, progress) => {
        const position = `${((1 - Math.max(0, Math.min(1, progress))) * 100).toFixed(3)}% 0px`;
        if (node.style.backgroundPosition !== position) node.style.backgroundPosition = position;
    };
    function cancelAnimations() {
        for (const record of animations) record.animation.cancel();
        animations = [];
    }
    function reset() {
        cancelAnimations();
        if (line) observer?.unobserve(line);
        for (const word of words) word.node.style.backgroundPosition = '';
        line = null; words = []; cache = new WeakMap(); mode = ''; lastAudio = -Infinity;
    }
    function sync(force = false) {
        if (disposed || !line) return;
        const anchor = environment.performance?.now() ?? doc.timeline?.currentTime;
        const now = getTime() * 1000;
        if (!Number.isFinite(now)) return;
        const audible = isPlaying() && isClockRunning();
        const shown = visible && !doc.hidden;
        const step = shown && audible && (reduced.matches || !supported);
        const nextMode = !shown || !audible ? 'frozen' : step ? 'step' : 'running';
        const version = getTransportVersion();
        const probe = animations.find(record => now < record.start + record.duration);
        const actual = probe?.animation.currentTime;
        // Document time is sampled per frame; audio time keeps advancing between frames.
        const frameAge = Number.isFinite(anchor) && Number.isFinite(doc.timeline?.currentTime)
            ? Math.max(0, anchor - doc.timeline.currentTime) : 0;
        const drifted = nextMode === 'running' && typeof actual === 'number'
            && Math.abs(actual + frameAge - probe.delay - (now - probe.start)) > 45;
        const changed = nextMode !== mode || version !== transport || now < lastAudio - 1;
        lastAudio = now;
        if (!force && !changed && !drifted && !step) return;
        mode = nextMode; transport = version;
        cancelAnimations();
        // One shared document-time anchor; no restart frames or per-word JS frame loop.
        for (const word of words) {
            const elapsed = now - word.start;
            const progress = word.duration > 0 ? elapsed / word.duration : elapsed >= 0 ? 1 : 0;
            write(word.node, reduced.matches ? elapsed >= 0 ? 1 : 0 : progress);
            if (nextMode !== 'running' || elapsed >= word.duration || word.duration <= 0) continue;
            const delay = word.start - now;
            try {
                const animation = word.node.animate([{ backgroundPosition: '100% 0px' }, { backgroundPosition: '0% 0px' }], {
                    duration: word.duration, delay, fill: 'both', easing: 'linear'
                });
                if (Number.isFinite(anchor)) animation.startTime = anchor;
                animations.push({ animation, start: word.start, duration: word.duration, delay });
            } catch (_) {
                supported = false;
                sync(true);
                return;
            }
        }
    }
    const observer = viewport && environment.IntersectionObserver ? new environment.IntersectionObserver(entries => {
        for (const entry of entries) if (entry.target === line && visible !== entry.isIntersecting) {
            visible = entry.isIntersecting; sync(true);
        }
    }, { root: viewport }) : null;
    function activate(next, force = false) {
        if (next !== line) {
            cancelAnimations();
            if (line) observer?.unobserve(line);
            for (const word of words) word.node.style.backgroundPosition = '';
            line = next; words = []; visible = true; mode = '';
            if (line) {
                words = cache.get(line);
                if (!words) {
                    const start = Number(line.dataset.time) * 1000;
                    words = [...line.querySelectorAll('.yrc-char')].map(node => ({ node,
                        start: start + Number(node.dataset.start), duration: Number(node.dataset.dur) }))
                        .filter(word => Number.isFinite(word.start) && Number.isFinite(word.duration) && word.duration >= 0);
                    cache.set(line, words);
                }
                supported = words.every(word => typeof word.node.animate === 'function');
                if (words.length) observer?.observe(line);
                else line = null;
            }
            force = true;
        }
        sync(force);
    }
    const onVisibility = () => sync(true);
    doc.addEventListener('visibilitychange', onVisibility);
    reduced.addEventListener?.('change', onVisibility);
    return {
        activate, sync, reset,
        dispose() {
            reset(); disposed = true; observer?.disconnect();
            doc.removeEventListener('visibilitychange', onVisibility);
            reduced.removeEventListener?.('change', onVisibility);
        }
    };
}
