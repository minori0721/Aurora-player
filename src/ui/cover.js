export const COVER_PENDING_TIMEOUT_MS = 15_000;
export const COVER_TRANSITION_MS = 400;
export const COVER_HOLD_TIMEOUT_MS = 2000;

export function createCovers({
    content: contentService,
    dom: domService,
    metadata: metadataService,
    queue: queueService,
    render: renderService
} = {}) {
    let mainCoverMimeType = '';

    let mainCoverGeneration = 0;

    let mainCoverSource = null;

    const mainCoverTrackIds = new WeakMap();

    let mainCoverTrackId = 0;

    let coverResizeTimer = 0;
    let pendingThemeTimer = 0;
    let holdTimer = 0, transitionTimer = 0, transitionVersion = 0;
    let visibleImage = null, spareImage = null, outgoingImage = null, visibleKey = '';
    let animations = [];
    const ownedUrls = new Set();
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const images = () => domService.el.coverImages;

    function releaseUnused() {
        if (spareImage && spareImage !== domService.el.img && spareImage !== visibleImage && spareImage !== outgoingImage) {
            spareImage.onload = spareImage.onerror = null;
            spareImage.removeAttribute('src');
            spareImage.classList.remove('cover-pending');
            spareImage.style.opacity = 0;
        }
        const retained = new Set([domService.el.img, visibleImage, outgoingImage].filter(Boolean).map(image => image.getAttribute('src')));
        for (const url of ownedUrls) if (!retained.has(url)) { URL.revokeObjectURL(url); ownedUrls.delete(url); }
    }

    function finishTransition() {
        transitionVersion++;
        clearTimeout(transitionTimer); transitionTimer = 0;
        for (const animation of animations) animation.cancel();
        animations = [];
        images()?.classList.remove('crossfading');
        if (visibleImage) visibleImage.style.opacity = 1;
        if (outgoingImage && outgoingImage !== visibleImage) spareImage = outgoingImage;
        outgoingImage = null;
        releaseUnused();
    }

    function forgetVisible() {
        finishTransition();
        if (visibleImage && visibleImage !== domService.el.img) spareImage = visibleImage;
        visibleImage = null; visibleKey = '';
        domService.el.coverWrap.classList.remove('has-cover');
        releaseUnused();
    }

    function coverKey(src) {
        try {
            const url = new URL(src, location.href);
            if (/^https?:$/.test(url.protocol) && /(^|\.)music\.126\.net$/i.test(url.hostname)) url.searchParams.delete('param');
            return url.href;
        } catch (_) { return src; }
    }

    function prepareImage(src) {
        finishTransition();
        const previous = domService.el.img;
        if (visibleImage) visibleImage.style.opacity = 1;
        if (previous === visibleImage && previous.getAttribute('src') !== src) {
            const next = spareImage || document.createElement('img');
            spareImage = null;
            previous.removeAttribute('id');
            previous.alt = ''; previous.setAttribute('aria-hidden', 'true');
            next.id = 'album-img'; next.className = 'album-img'; next.alt = '专辑封面';
            next.removeAttribute('aria-hidden');
            next.crossOrigin = 'anonymous'; next.decoding = 'async';
            // Current consumers always see the requested track, not the held outgoing artwork.
            domService.el.img = next;
            images().appendChild(next);
        }
        const image = domService.el.img;
        image.classList.add('cover-pending');
        return image;
    }

    function displayImage(image, key, animate) {
        clearTimeout(holdTimer); holdTimer = 0;
        const previous = visibleImage, changed = key !== visibleKey;
        visibleImage = image; visibleKey = key;
        image.classList.remove('cover-pending'); image.style.opacity = 1;
        domService.el.coverWrap.classList.add('has-cover');
        const canAnimate = previous && previous !== image && changed && animate && !document.hidden
            && !reducedMotion?.matches && typeof image.animate === 'function'
            && window.CSS?.supports('mix-blend-mode', 'plus-lighter');
        if (previous && previous !== image) spareImage = previous;
        if (!canAnimate) { releaseUnused(); return; }
        outgoingImage = previous;
        images().classList.add('crossfading');
        const options = { duration: COVER_TRANSITION_MS, easing: 'ease-in-out', fill: 'both' };
        try {
            animations.push(previous.animate([{ opacity: 1 }, { opacity: 0 }], options));
            animations.push(image.animate([{ opacity: 0 }, { opacity: 1 }], options));
        } catch (_) {
            for (const animation of animations) animation.finished.catch(() => {});
            finishTransition();
            return;
        }
        const version = ++transitionVersion;
        Promise.all(animations.map(animation => animation.finished)).then(() => {
            if (version === transitionVersion) finishTransition();
        }, () => {});
        transitionTimer = setTimeout(() => { if (version === transitionVersion) finishTransition(); }, COVER_TRANSITION_MS + 100);
    }

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

    function commitMainCover(src, { onLoad = null, objectUrl = false, mimeType = '', pending = false, animate = true } = {}, generation = mainCoverGeneration) {
        if (generation !== mainCoverGeneration) {
            if (objectUrl) URL.revokeObjectURL(src);
            return;
        }
        const track = queueService.playlist[queueService.curIdx];
        const isCurrent = () => generation === mainCoverGeneration && queueService.playlist[queueService.curIdx] === track;
        mainCoverMimeType = mimeType;
        clearPendingTheme();
        clearTimeout(holdTimer); holdTimer = 0;
        // A stalled metadata/image read must not retain another track's background forever.
        // Keep accepting a late image if this generation is still current.
        if (src || pending) pendingThemeTimer = setTimeout(() => {
            if (generation !== mainCoverGeneration) return;
            pendingThemeTimer = 0;
            if (isCurrent()) renderService.updateTheme(null);
        }, COVER_PENDING_TIMEOUT_MS);
        const unchanged = src && domService.el.img === visibleImage && visibleImage.getAttribute('src') === src
            && visibleImage.complete && visibleImage.naturalWidth > 0;
        const image = unchanged ? visibleImage : prepareImage(src);
        const alreadyLoaded = src && image.getAttribute('src') === src && image.complete && image.naturalWidth > 0;
        let ready = false;
        const currentImage = () => isCurrent() && domService.el.img === image && image.getAttribute('src') === src;
        const present = () => {
            if (ready || !currentImage()) return;
            ready = true;
            clearPendingTheme();
            if (!unchanged) displayImage(image, coverKey(src), animate);
            renderService.updateTheme(image);
            if (onLoad) onLoad();
            contentService.updateMusicMiniPlayer();
            try { metadataService.updateMediaSession(); } catch (_) {}
            releaseUnused();
        };
        const failed = () => {
            if (!currentImage()) return;
            setMainCover();
        };
        const loaded = () => {
            if (!currentImage()) return;
            if (image === visibleImage || typeof image.decode !== 'function') present();
            else image.decode().then(present, failed);
        };
        image.onload = src ? loaded : null;
        image.onerror = src ? failed : null;
        if (src) {
            if (image.getAttribute('src') !== src) image.src = src;
        } else {
            image.removeAttribute('src');
        }
        if (objectUrl) ownedUrls.add(src);
        // Move every current consumer off the previous URL before revoking it.
        contentService.updateMusicMiniPlayer();
        try { metadataService.updateMediaSession(); } catch (_) {}
        if (!src && !pending) { forgetVisible(); renderService.updateTheme(null); }
        if ((src || pending) && !alreadyLoaded && visibleImage) {
            holdTimer = setTimeout(() => {
                holdTimer = 0;
                if (isCurrent() && !ready) forgetVisible();
            }, COVER_HOLD_TIMEOUT_MS);
        }
        releaseUnused();
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
            commitMainCover(src, { onLoad: source.onLoad, animate: false }, generation);
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
            document.addEventListener('visibilitychange', () => { if (document.hidden) finishTransition(); });
            reducedMotion?.addEventListener('change', () => { if (reducedMotion.matches) finishTransition(); });

            if (typeof ResizeObserver === 'function') new ResizeObserver(scheduleCoverResize).observe(domService.el.coverWrap);
        }
    };
}
