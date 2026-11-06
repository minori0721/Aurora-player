export function createPlaylistFade({ root, containers }, env = window) {
    const near = new Set(), observed = new Set(), dirty = new WeakSet();
    let cache = new WeakMap(), prepared = new Set();
    const supported = env.CSS?.supports('mask-image', 'linear-gradient(to right, black, transparent)');
    const range = supported ? env.document.createRange() : null;
    const stats = { updates: 0, textReads: 0, rangeReads: 0, writes: 0, cacheHits: 0, maxMasked: 0, layoutChanges: 0 };
    let observer = null, resize = null, frame = null, timer = null, initialized = false, disposed = false;
    let epoch = 0, signature = '', coverage = null;
    const margin = 165;
    const open = () => !disposed && supported && root.classList.contains('show') && !env.document.hidden;

    function schedule() {
        if (!open() || frame !== null) return;
        frame = env.requestAnimationFrame(update);
    }

    function refresh() { coverage = null; schedule(); }
    function invalidate(row) { if (row) dirty.add(row); schedule(); }

    function onScroll() {
        if (!open()) return;
        env.clearTimeout(timer);
        timer = env.setTimeout(() => { timer = null; schedule(); }, 100);
        const top = root.scrollTop;
        if (!coverage || top < coverage.top + 55 || top + coverage.height > coverage.bottom - 55) schedule();
    }

    function update() {
        frame = null;
        if (!open()) return;
        stats.updates++;
        const bounds = root.getBoundingClientRect(), style = env.getComputedStyle(root);
        const nextSignature = [root.clientWidth, containers[0]?.clientWidth, style.paddingLeft, style.paddingRight, style.fontSize, style.fontFamily,
            style.getPropertyValue('--playlist-shared-index-digits'), ...containers.filter(Boolean).map(el => el.style.getPropertyValue('--playlist-index-digits'))].join('|');
        if (signature !== nextSignature) { signature = nextSignature; epoch++; stats.layoutChanges++; }
        const candidates = new Set();
        for (const group of near) {
            if (!group.isConnected || group.hidden) continue;
            const rect = group.getBoundingClientRect();
            if (rect.bottom <= bounds.top - margin || rect.top >= bounds.bottom + margin) continue;
            if (group.classList.contains('pl-item')) { candidates.add(group); continue; }
            const rows = [...group.children].filter(row => !row.hidden);
            const pitch = rect.height / rows.length;
            const first = Math.max(0, Math.floor((bounds.top - margin - rect.top) / pitch));
            const end = Math.min(rows.length, Math.ceil((bounds.bottom + margin - rect.top) / pitch));
            for (let index = first; index < end; index++) candidates.add(rows[index]);
        }
        const changes = [];
        for (const row of candidates) {
            if (cache.get(row) === epoch && !dirty.has(row)) { stats.cacheHits++; continue; }
            for (const text of row.querySelectorAll('.pl-song-name,.pl-song-artists')) {
                let overflow = false;
                if (!text.hidden) {
                    stats.textReads++;
                    const width = text.clientWidth, content = text.scrollWidth;
                    overflow = width > 0 && content > width + 1;
                    if (!overflow && width > 0) {
                        stats.rangeReads++; range.selectNodeContents(text);
                        overflow = range.getBoundingClientRect().width > text.getBoundingClientRect().width + .02;
                    }
                }
                changes.push({ text, overflow });
            }
            cache.set(row, epoch); dirty.delete(row);
        }
        // Keep finished masks on their nodes; scrolling only prepares newly encountered rows.
        for (const { text, overflow } of changes) if (text.classList.contains('pl-text-fade') !== overflow) {
            text.classList.toggle('pl-text-fade', overflow); stats.writes++;
        }
        prepared = candidates;
        const top = root.scrollTop;
        coverage = candidates.size ? { top: top - margin, bottom: top + root.clientHeight + margin, height: root.clientHeight } : null;
        stats.maxMasked = Math.max(stats.maxMasked, [...prepared].reduce((n, row) => n + row.querySelectorAll('.pl-text-fade').length, 0));
    }

    function observe() {
        if (!open()) return;
        resize?.observe(root);
        if (containers[0]) resize?.observe(containers[0]);
        const heading = root.querySelector('.playlist-header h3'); if (heading) resize?.observe(heading);
        observer ||= new env.IntersectionObserver(entries => {
            for (const entry of entries) {
                if (entry.isIntersecting) near.add(entry.target); else near.delete(entry.target);
            }
            schedule();
        }, { root, rootMargin: `${margin}px 0px`, threshold: 0 });
        for (const group of observed) if (!group.isConnected) {
            observer.unobserve(group); observed.delete(group); near.delete(group);
        }
        for (const container of containers) if (container) for (const group of container.children) {
            if (!group.matches('.pl-row-group,.pl-item') || observed.has(group)) continue;
            observed.add(group); observer.observe(group);
        }
        schedule();
    }

    function suspend() {
        if (frame !== null) env.cancelAnimationFrame(frame);
        env.clearTimeout(timer); frame = null; timer = null;
        observer?.disconnect(); resize?.disconnect(); near.clear(); observed.clear(); prepared.clear(); coverage = null;
    }

    function reset() { suspend(); cache = new WeakMap(); epoch++; }
    function fontsChanged() { signature = ''; refresh(); }
    function visibility() { if (env.document.hidden) suspend(); else observe(); }

    return {
        observe, suspend, reset, refresh, invalidate,
        initialize() {
            if (initialized || disposed || !supported) return;
            initialized = true;
            root.addEventListener('scroll', onScroll, { passive: true });
            env.addEventListener('resize', refresh);
            env.document.addEventListener('visibilitychange', visibility);
            resize = new env.ResizeObserver(() => schedule());
            env.document.fonts?.ready.then(fontsChanged);
            env.document.fonts?.addEventListener('loadingdone', fontsChanged);
        },
        dispose() {
            disposed = true;
            reset(); root.removeEventListener('scroll', onScroll); env.removeEventListener('resize', refresh);
            env.document.removeEventListener('visibilitychange', visibility);
            env.document.fonts?.removeEventListener('loadingdone', fontsChanged);
            for (const container of containers) container?.querySelectorAll('.pl-text-fade').forEach(text => text.classList.remove('pl-text-fade'));
        },
        debug() {
            return { ...stats, masked: [...prepared].reduce((n, row) => n + row.querySelectorAll('.pl-text-fade').length, 0),
                observed: observed.size, near: near.size, textObservers: 0, framePending: frame !== null, scrollPending: timer !== null };
        }
    };
}
