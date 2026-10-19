export const COVER_PENDING_TIMEOUT_MS = 15_000;

export function createCovers({
    content: contentService,
    dom: domService,
    metadata: metadataService,
    queue: queueService,
    render: renderService
} = {}) {
    let mainCoverObjectUrl = null;

    let mainCoverMimeType = '';

    let mainCoverGeneration = 0;

    let mainCoverSource = null;

    const mainCoverTrackIds = new WeakMap();

    let mainCoverTrackId = 0;

    let coverResizeTimer = 0;
    let pendingThemeTimer = 0;

    function clearPendingTheme() {
        clearTimeout(pendingThemeTimer);
        pendingThemeTimer = 0;
    }

    function coverDisplaySize() {
        const edge = (Math.max(domService.el.img.clientWidth, domService.el.img.clientHeight) || 280) * (window.devicePixelRatio || 1);
        return [512, 768, 1024, 1536, 2048].find(size => size >= edge) || 2048;
    }

    function coverDisplayUrl(src, size = coverDisplaySize()) {
        if (!src) return '';
        try {
            const url = new URL(src, location.href);
            if (/^https?:$/.test(url.protocol) && /(^|\.)music\.126\.net$/i.test(url.hostname)
                && !/\.(?:gif|apng|webp)$/i.test(url.pathname)) {
                url.searchParams.set('param', `${size}y${size}`);
                return url.href;
            }
        } catch (_) {}
        return src;
    }

    function commitMainCover(src, { onLoad = null, objectUrl = false, mimeType = '', pending = false } = {}, generation = mainCoverGeneration) {
        if (generation !== mainCoverGeneration) {
            if (objectUrl) URL.revokeObjectURL(src);
            return;
        }
        const previousUrl = mainCoverObjectUrl;
        const track = queueService.playlist[queueService.curIdx];
        const isCurrent = () => generation === mainCoverGeneration && queueService.playlist[queueService.curIdx] === track;
        mainCoverObjectUrl = objectUrl ? src : null;
        mainCoverMimeType = mimeType;
        clearPendingTheme();
        // A stalled metadata/image read must not retain another track's background forever.
        // Keep accepting a late image if this generation is still current.
        if (src || pending) pendingThemeTimer = setTimeout(() => {
            if (generation !== mainCoverGeneration) return;
            pendingThemeTimer = 0;
            if (isCurrent()) renderService.updateTheme(null);
        }, COVER_PENDING_TIMEOUT_MS);
        const alreadyLoaded = src && domService.el.img.getAttribute('src') === src
            && domService.el.img.complete && domService.el.img.naturalWidth > 0;
        const loaded = () => {
            if (!isCurrent() || domService.el.img.getAttribute('src') !== src) return;
            clearPendingTheme();
            renderService.updateTheme(domService.el.img);
            if (onLoad) onLoad();
            try { metadataService.updateMediaSession(); } catch (_) {}
        };
        domService.el.img.onload = src ? loaded : null;
        domService.el.img.onerror = src ? () => {
            if (!isCurrent() || domService.el.img.getAttribute('src') !== src) return;
            domService.el.img.style.opacity = 0;
            setMainCover();
        } : null;
        if (src) {
            if (domService.el.img.getAttribute('src') !== src) domService.el.img.src = src;
        } else {
            domService.el.img.removeAttribute('src');
            if (!pending) renderService.updateTheme(null);
        }
        // Move every current consumer off the previous URL before revoking it.
        contentService.updateMusicMiniPlayer();
        try { metadataService.updateMediaSession(); } catch (_) {}
        if (previousUrl && previousUrl !== mainCoverObjectUrl) URL.revokeObjectURL(previousUrl);
        if (alreadyLoaded) loaded();
    }

    function setMainCover(src = '', { onLoad = null, objectUrl = false, mimeType = '', pending = false } = {}) {
        const generation = ++mainCoverGeneration;
        const track = queueService.playlist[queueService.curIdx];
        mainCoverTrackId = 0;
        if (src && track && typeof track === 'object') {
            if (!mainCoverTrackIds.has(track)) mainCoverTrackIds.set(track, generation);
            mainCoverTrackId = mainCoverTrackIds.get(track);
        }
        mainCoverSource = src && !objectUrl ? { src, onLoad, size: coverDisplaySize(), track } : null;
        commitMainCover(objectUrl ? src : coverDisplayUrl(src), { onLoad, objectUrl, mimeType, pending }, generation);
    }

    function scheduleCoverResize() {
        clearTimeout(coverResizeTimer);
        coverResizeTimer = setTimeout(() => {
            const source = mainCoverSource;
            const size = coverDisplaySize();
            if (!source || source.track !== queueService.playlist[queueService.curIdx] || source.size === size) return;
            source.size = size;
            const src = coverDisplayUrl(source.src, size);
            if (src === domService.el.img.getAttribute('src')) return;
            const generation = ++mainCoverGeneration;
            commitMainCover(src, { onLoad: source.onLoad }, generation);
        }, 180);
    }

    let initialized = false;
    return {
        get mainCoverMimeType() { return mainCoverMimeType; },
        get mainCoverTrackIds() { return mainCoverTrackIds; },
        get mainCoverTrackId() { return mainCoverTrackId; },
        coverDisplayUrl,
        setMainCover,
        initialize() {
            if (initialized) return;
            initialized = true;
            window.addEventListener('resize', scheduleCoverResize);

            if (typeof ResizeObserver === 'function') new ResizeObserver(scheduleCoverResize).observe(domService.el.coverWrap);
        }
    };
}
