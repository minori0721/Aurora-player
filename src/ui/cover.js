export function createCovers({
    content: contentService,
    dom: domService,
    metadata: metadataService,
    queue: queueService
} = {}) {
    let mainCoverObjectUrl = null;

    let mainCoverMimeType = '';

    let mainCoverGeneration = 0;

    let mainCoverSource = null;

    const mainCoverTrackIds = new WeakMap();

    let mainCoverTrackId = 0;

    let coverResizeTimer = 0;

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

    function commitMainCover(src, { onLoad = null, objectUrl = false, mimeType = '' } = {}, generation = mainCoverGeneration) {
        if (generation !== mainCoverGeneration) {
            if (objectUrl) URL.revokeObjectURL(src);
            return;
        }
        const previousUrl = mainCoverObjectUrl;
        mainCoverObjectUrl = objectUrl ? src : null;
        mainCoverMimeType = mimeType;
        domService.el.img.onload = () => {
            if (generation !== mainCoverGeneration || domService.el.img.getAttribute('src') !== src) return;
            if (onLoad) onLoad();
            try { metadataService.updateMediaSession(); } catch (_) {}
        };
        if (src) domService.el.img.src = src;
        else domService.el.img.removeAttribute('src');
        // Move every current consumer off the previous URL before revoking it.
        contentService.updateMusicMiniPlayer();
        try { metadataService.updateMediaSession(); } catch (_) {}
        if (previousUrl && previousUrl !== mainCoverObjectUrl) URL.revokeObjectURL(previousUrl);
    }

    function setMainCover(src = '', { onLoad = null, objectUrl = false, mimeType = '' } = {}) {
        const generation = ++mainCoverGeneration;
        const track = queueService.playlist[queueService.curIdx];
        mainCoverTrackId = 0;
        if (src && track && typeof track === 'object') {
            if (!mainCoverTrackIds.has(track)) mainCoverTrackIds.set(track, generation);
            mainCoverTrackId = mainCoverTrackIds.get(track);
        }
        mainCoverSource = src && !objectUrl ? { src, onLoad, size: coverDisplaySize() } : null;
        commitMainCover(objectUrl ? src : coverDisplayUrl(src), { onLoad, objectUrl, mimeType }, generation);
    }

    function scheduleCoverResize() {
        clearTimeout(coverResizeTimer);
        coverResizeTimer = setTimeout(() => {
            const source = mainCoverSource;
            const size = coverDisplaySize();
            if (!source || source.size === size) return;
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
