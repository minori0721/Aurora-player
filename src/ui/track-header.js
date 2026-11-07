export function createTrackHeaderLayout(title, { environment = window, document: doc = document } = {}) {
    const header = title?.closest('.track-header'), frame = header?.parentElement;
    if (!header || !frame) return null;
    const toolbar = doc.querySelector('.top-bar');
    const desktop = environment.matchMedia('(min-width: 901px)');
    let disposed = false, applied = null;

    function sync() {
        if (disposed || doc.hidden) return;
        const lineHeight = parseFloat(environment.getComputedStyle(title).lineHeight);
        let lift = 0;
        if (desktop.matches && title.offsetHeight > lineHeight * 1.5) {
            // Use the toolbar's untransformed position so auto-hide cannot move the title.
            const top = toolbar ? toolbar.offsetTop + toolbar.offsetHeight : 0;
            lift = Math.max(0, Math.min(10, frame.getBoundingClientRect().top - top - 8));
        }
        if (lift !== applied) {
            applied = lift;
            header.style.setProperty('--track-header-lift', `${lift}px`);
        }
    }

    const observer = environment.ResizeObserver ? new environment.ResizeObserver(sync) : null;
    observer?.observe(title); observer?.observe(frame);
    if (toolbar) observer?.observe(toolbar);
    desktop.addEventListener('change', sync);
    environment.addEventListener('resize', sync, { passive: true });
    doc.addEventListener('visibilitychange', sync);
    doc.fonts?.addEventListener('loadingdone', sync);
    sync();
    return {
        sync,
        dispose() {
            disposed = true; observer?.disconnect();
            desktop.removeEventListener('change', sync);
            environment.removeEventListener('resize', sync);
            doc.removeEventListener('visibilitychange', sync);
            doc.fonts?.removeEventListener('loadingdone', sync);
            header.style.removeProperty('--track-header-lift');
        }
    };
}
