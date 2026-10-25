import { fmtTime } from '../shared/text.js';
import { createLyricMotion, LYRIC_SCROLL_DURATION_MS, LYRIC_SCROLL_EASING } from './motion.js';
import { createLyricWrapping } from './wrapping.js';

export const LYRIC_RESUME_DELAY_MS = 6000;
const SCROLL_SETTLE_MS = 180;

export function createLyricViewport(viewport, { content, returnButton, timeHint, seek, isPlaying, alignmentTarget = null,
    environment = window, document: doc = document } = {}) {
    let lines = [], centers = [], geometry = [], active = -1, preview = null, browsing = false, disposed = false;
    let anticipated = -1;
    let followTarget = null, followEnd = null, layoutSmooth = false, pendingReflow = false;
    let resumeTimer = 0, settleTimer = 0, paintFrame = 0, layoutFrame = 0, generation = 0;
    let playing = !!isPlaying(), pointer = null, touches = 0, touchMoved = false, keyboardReading = false;
    let suppressClickUntil = 0, lastScrollAt = -Infinity;
    const listeners = [], shell = viewport.parentNode;
    const reduced = environment.matchMedia('(prefers-reduced-motion: reduce)');
    const desktop = environment.matchMedia('(min-width: 901px)');
    const now = () => environment.performance.now();
    const height = () => viewport.clientHeight || viewport.offsetHeight || 1;
    const top = () => viewport.scrollTop || 0;
    const maxScroll = () => Math.max(0, (viewport.scrollHeight || 0) - height());
    const scrollMotion = createLyricMotion(viewport, { environment, document: doc, isReduced: () => reduced.matches });
    const layoutShifts = new Map();
    const wrapping = createLyricWrapping(content, { environment, document: doc });
    let followPoint = height() / 2;
    const listen = (target, type, callback, options) => {
        target?.addEventListener?.(type, callback, options);
        listeners.push(() => target?.removeEventListener?.(type, callback, options));
    };
    const clearResume = () => { environment.clearTimeout(resumeTimer); resumeTimer = 0; };
    const clearSettle = () => { environment.clearTimeout(settleTimer); settleTimer = 0; };
    const moveTo = scrollMotion.moveTo;
    const cancelFollowing = () => { anticipated = -1; followEnd = null; scrollMotion.cancel(); };

    function cancelLayoutShifts() {
        for (const animation of layoutShifts.values()) animation.cancel();
        layoutShifts.clear();
    }

    function compensateReflow(previous, next) {
        if (!environment.CSS?.supports?.('translate', '0px') || reduced.matches || doc.hidden || browsing) return;
        const low = top() - height() * .25, high = top() + height() * 1.25;
        const shifts = [];
        for (let index = 0; index < next.length; index++) {
            const line = lines[index], old = previous[index], current = next[index];
            if (!old || typeof line.animate !== 'function' || Math.max(old.center, current.center) < low
                || Math.min(old.center, current.center) > high) continue;
            const animation = layoutShifts.get(line);
            const translate = animation ? environment.getComputedStyle(line).translate : '';
            const visibleOffset = parseFloat(translate?.split(/\s+/)[1]) || 0;
            const delta = old.center - current.center + visibleOffset;
            if (Math.abs(delta) > .5) shifts.push({ line, delta, animation });
        }
        for (const { line, delta, animation } of shifts.slice(0, 32)) {
            animation?.cancel();
            const nextAnimation = line.animate([{ translate: `0 ${delta}px` }, { translate: '0 0' }], {
                duration: LYRIC_SCROLL_DURATION_MS, easing: LYRIC_SCROLL_EASING
            });
            layoutShifts.set(line, nextAnimation);
            const release = () => { if (layoutShifts.get(line) === nextAnimation) layoutShifts.delete(line); };
            nextAnimation.finished.then(release, release);
        }
    }
    const selectionInside = () => {
        const selection = doc.getSelection?.();
        return selection && !selection.isCollapsed && content.contains(selection.anchorNode);
    };
    const blocked = () => doc.hidden || pointer || touches > 0 || keyboardReading || selectionInside();
    const nearestIndex = () => {
        if (!centers.length) return -1;
        const point = top() + followPoint;
        let low = 0, high = centers.length;
        while (low < high) { const mid = (low + high) >>> 1; if (centers[mid] < point) low = mid + 1; else high = mid; }
        if (!low) return 0;
        if (low === centers.length) return low - 1;
        return point - centers[low - 1] <= centers[low] - point ? low - 1 : low;
    };

    function showTime(index) {
        const time = Number(lines[index]?.dataset.time);
        timeHint.hidden = !Number.isFinite(time) || time < 0;
        if (!timeHint.hidden) {
            timeHint.textContent = `浏览 ${fmtTime(time)}`;
            timeHint.setAttribute('aria-label', `浏览位置 ${fmtTime(time)}`);
        }
    }

    function paint() {
        if (disposed) return;
        const index = browsing ? nearestIndex() : -1, next = lines[index] || null;
        if (next !== preview) { preview?.classList.remove('lyric-preview'); next?.classList.add('lyric-preview'); preview = next; }
        returnButton.hidden = !browsing || active < 0;
        if (browsing) showTime(index);
        else timeHint.hidden = true;
        if (!returnButton.hidden) {
            const position = centers[active] - top();
            returnButton.dataset.direction = position < height() * .15 ? 'up' : position > height() * .85 ? 'down' : 'here';
        }
    }

    function schedulePaint() {
        if (paintFrame || disposed || doc.hidden) return;
        paintFrame = environment.requestAnimationFrame(() => { paintFrame = 0; paint(); });
    }

    function align(smooth = true) {
        const index = anticipated >= 0 ? anticipated : active;
        if (index < 0 || !Number.isFinite(centers[index])) return;
        const target = centers[index] - followPoint;
        followTarget = target;
        followEnd = moveTo(target, smooth && Math.abs(target - top()) < height() * 3);
    }

    function returnToCurrent() {
        if (!lines.length || active < 0 || disposed) return;
        const restoreFocus = doc.activeElement === returnButton;
        anticipated = -1;
        clearResume(); clearSettle(); browsing = false; keyboardReading = false;
        shell.classList?.remove('lyrics-browsing');
        paint();
        if (layoutFrame) { followTarget = null; scheduleLayout(true); }
        else align();
        if (restoreFocus) viewport.focus({ preventScroll: true });
    }

    function armResume() {
        clearResume();
        if (!browsing || !playing || blocked() || disposed) return;
        const stamp = generation;
        resumeTimer = environment.setTimeout(() => {
            resumeTimer = 0;
            if (stamp === generation && browsing && isPlaying() && !blocked()) returnToCurrent();
        }, LYRIC_RESUME_DELAY_MS);
    }

    function settled() {
        clearSettle();
        if (browsing) { scheduleLayout(); schedulePaint(); armResume(); }
    }

    function beginBrowsing() {
        cancelFollowing();
        if (!lines.length || maxScroll() < 1) return;
        if (!browsing) { browsing = true; shell.classList?.add('lyrics-browsing'); moveTo(top()); }
        clearResume(); schedulePaint();
    }

    function measureLine(line) {
        const original = line.querySelector('.lyric-original');
        const visual = line.querySelector('.lyric-visual');
        const height = line.offsetHeight;
        const origin = original ? original.offsetTop + original.offsetHeight / 2 : height / 2;
        // The inner scale uses a local origin; scrolling uses the outer row's coordinates.
        const anchor = origin + (visual && original ? visual.offsetTop : 0);
        return { height, origin, anchor, center: line.offsetTop + anchor };
    }

    function geometryChanged(index) {
        if (!lines[index]) return false;
        const previous = geometry[index], next = measureLine(lines[index]);
        return !previous || previous.height !== next.height || previous.anchor !== next.anchor || previous.center !== next.center || previous.origin !== next.origin;
    }

    function relayout(smooth = false) {
        if (disposed) return;
        smooth = smooth || layoutSmooth; layoutSmooth = false;
        environment.cancelAnimationFrame(layoutFrame); layoutFrame = 0;
        const index = browsing ? nearestIndex() : -1;
        const offset = index >= 0 ? centers[index] - top() - followPoint : 0;
        const visibleHeight = height();
        followPoint = visibleHeight / 2;
        if (alignmentTarget && desktop.matches) {
            const box = viewport.getBoundingClientRect(), target = alignmentTarget.getBoundingClientRect();
            const point = target.top + target.height / 2 - box.top;
            if (box.height > 0 && target.height > 0 && Number.isFinite(point)) {
                // Keep the desktop anchor inside the unfaded portion of the lyric viewport.
                followPoint = Math.max(visibleHeight * .15, Math.min(visibleHeight * .85, point));
            }
        }
        const paddingTop = lines.length ? `${followPoint}px` : '0px';
        const paddingBottom = lines.length ? `${visibleHeight - followPoint}px` : '0px';
        if (content.style.paddingTop !== paddingTop) content.style.paddingTop = paddingTop;
        if (content.style.paddingBottom !== paddingBottom) content.style.paddingBottom = paddingBottom;
        wrapping.layout(lines[index >= 0 ? index : anticipated >= 0 ? anticipated : active]);
        // Read geometry together, then update only changed transform anchors.
        const next = lines.map(measureLine);
        if (pendingReflow) compensateReflow(geometry, next);
        pendingReflow = false;
        next.forEach(({ origin }, index) => {
            if (geometry[index]?.origin !== origin) lines[index].style.setProperty('--lyric-anchor-y', `${origin}px`);
        });
        geometry = next;
        centers = next.map(line => line.center);
        scrollMotion.refresh();
        const followIndex = anticipated >= 0 ? anticipated : active;
        if (browsing && index >= 0 && !pointer && !touches) {
            const target = centers[index] - followPoint - offset;
            if (Math.abs(target - top()) > .5) moveTo(target);
        }
        else if (!browsing && Number.isFinite(centers[followIndex])
            && (followTarget === null || Math.abs(centers[followIndex] - followPoint - followTarget) > .5)) align(smooth);
        paint();
    }

    function scheduleLayout(smooth = false) {
        if (smooth === true) layoutSmooth = true;
        if (disposed || layoutFrame || doc.hidden) return;
        layoutFrame = environment.requestAnimationFrame(() => { layoutFrame = 0; relayout(); });
    }

    function reset() {
        wrapping.reset();
        generation++; clearResume(); clearSettle();
        cancelFollowing(); cancelLayoutShifts();
        scrollMotion.reset();
        environment.cancelAnimationFrame(paintFrame); environment.cancelAnimationFrame(layoutFrame);
        paintFrame = layoutFrame = 0;
        if (pointer || touches) suppressClickUntil = now() + 500;
        pointer = null; touches = 0; touchMoved = false; keyboardReading = false;
        preview?.classList.remove('lyric-preview'); preview = null;
        lines = []; centers = []; geometry = []; active = -1; browsing = false;
        followTarget = followEnd = null; layoutSmooth = false; pendingReflow = false;
        shell.classList?.remove('lyrics-browsing');
        content.style.paddingTop = content.style.paddingBottom = '0px';
        content.style.transform = '';
        returnButton.hidden = timeHint.hidden = true;
        moveTo(0);
    }

    function syncPlayback() {
        const next = !!isPlaying();
        if (next === playing) return;
        playing = next;
        if (!playing && anticipated >= 0) {
            cancelFollowing(); followTarget = null;
            if (!browsing && !blocked()) align();
        }
        if (playing && !settleTimer) armResume(); else clearResume();
    }

    function activate(line) {
        if (!line || !lines.includes(line) || selectionInside()) return;
        const time = Number(line.dataset.time);
        if (Number.isFinite(time) && time >= 0 && seek(time) !== false) returnToCurrent();
    }

    listen(viewport, 'scroll', () => {
        if (!browsing && (pointer || touches)) beginBrowsing();
        if (!browsing) return;
        if (touches) touchMoved = true;
        lastScrollAt = now(); clearResume(); clearSettle(); schedulePaint();
        settleTimer = environment.setTimeout(settled, SCROLL_SETTLE_MS);
    }, { passive: true });
    listen(viewport, 'scrollend', settled, { passive: true });
    listen(viewport, 'wheel', event => {
        if (event.ctrlKey || !event.deltaY) return;
        beginBrowsing(); clearSettle();
        settleTimer = environment.setTimeout(settled, SCROLL_SETTLE_MS);
    }, { passive: true });
    listen(viewport, 'pointerdown', event => {
        if (event.button > 0) return;
        cancelFollowing();
        if (browsing && now() - lastScrollAt < SCROLL_SETTLE_MS) suppressClickUntil = now() + 500;
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
        clearResume();
    }, { passive: true });
    listen(viewport, 'pointermove', event => {
        if (!pointer || pointer.id !== event.pointerId) return;
        if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 9) {
            pointer.moved = true; beginBrowsing();
        }
    }, { passive: true });
    const releasePointer = event => {
        if (!pointer || pointer.id !== event.pointerId) return;
        if (pointer.moved || event.type === 'pointercancel') suppressClickUntil = now() + 500;
        pointer = null;
        if (!browsing && !touches && !selectionInside()) align();
        if (!settleTimer) armResume();
    };
    listen(doc, 'pointerup', releasePointer, { passive: true });
    listen(doc, 'pointercancel', releasePointer, { passive: true });
    listen(viewport, 'touchstart', event => { cancelFollowing(); if (!touches) touchMoved = false; touches = event.touches.length; clearResume(); }, { passive: true });
    const releaseTouch = event => {
        touches = event.touches.length;
        if (!touches) {
            if (touchMoved) suppressClickUntil = now() + 500;
            touchMoved = false;
            if (!browsing && !pointer && !selectionInside()) align();
            if (!settleTimer) armResume();
        }
    };
    listen(viewport, 'touchend', releaseTouch, { passive: true });
    listen(viewport, 'touchcancel', releaseTouch, { passive: true });
    listen(content, 'click', event => {
        const line = event.target.closest?.('[data-lyric-time]');
        if (now() < suppressClickUntil || pointer?.moved) { event.preventDefault(); return; }
        activate(line);
    });
    listen(content, 'pointerover', event => {
        if (event.pointerType === 'mouse' && !browsing) showTime(lines.indexOf(event.target.closest?.('[data-lyric-time]')));
    });
    listen(content, 'pointerleave', () => { if (!browsing) timeHint.hidden = true; });
    listen(viewport, 'keydown', event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === 'Escape' && browsing) { event.preventDefault(); event.stopPropagation(); returnToCurrent(); return; }
        const line = event.target.closest?.('[data-lyric-time]');
        if (event.key === 'Enter' || (event.key === ' ' && line)) {
            event.preventDefault(); event.stopPropagation(); activate(line || lines[nearestIndex()]); return;
        }
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
            keyboardReading = true; beginBrowsing(); event.stopPropagation();
        }
    });
    listen(viewport, 'focusout', event => {
        if (!viewport.contains(event.relatedTarget)) { keyboardReading = false; armResume(); }
    });
    listen(returnButton, 'click', returnToCurrent);
    listen(doc, 'selectionchange', () => { if (browsing) armResume(); });
    listen(doc, 'visibilitychange', () => {
        clearResume(); cancelFollowing(); cancelLayoutShifts(); followTarget = null;
        scrollMotion.cancel(true);
        if (!doc.hidden) { scheduleLayout(); armResume(); }
    });
    listen(reduced, 'change', () => {
        if (!reduced.matches) return;
        cancelFollowing(); cancelLayoutShifts(); followTarget = null;
        scrollMotion.cancel(true);
        layoutSmooth = pendingReflow = false;
        if (!doc.hidden) relayout();
    });
    listen(environment, 'resize', () => { cancelFollowing(); cancelLayoutShifts(); followTarget = null; scheduleLayout(); });
    listen(doc.fonts, 'loadingdone', () => { wrapping.invalidate(); scheduleLayout(); });
    const observer = environment.ResizeObserver ? new environment.ResizeObserver(scheduleLayout) : null;
    observer?.observe(viewport); observer?.observe(content);
    if (alignmentTarget) {
        observer?.observe(alignmentTarget);
        if (shell.parentElement) {
            observer?.observe(shell.parentElement);
            for (const sibling of shell.parentElement.children) if (sibling !== shell) observer?.observe(sibling);
        }
    }

    return {
        reset, relayout(smooth = false) { wrapping.refresh(lines); relayout(smooth); }, syncPlayback, returnToCurrent,
        setLines(next) { reset(); lines = [...next]; wrapping.refresh(lines); relayout(); },
        anticipate(index) {
            if (disposed || browsing || blocked() || reduced.matches || !isPlaying() || active < 0 || index !== active + 1
                || !Number.isFinite(centers[index])) return false;
            if (anticipated === index) return true;
            anticipated = index;
            if (wrapping.layout(lines[index]) || layoutFrame || geometryChanged(active) || geometryChanged(index)) relayout(true);
            else align();
            return true;
        },
        setActive(index, force = false) {
            syncPlayback();
            const changed = active !== index;
            const previous = active;
            const continuing = anticipated === index && !force;
            if (changed || force) anticipated = -1;
            active = index;
            if (!changed && !force) return;
            if (wrapping.layout(lines[index]) || layoutFrame || geometryChanged(previous) || geometryChanged(index)) {
                pendingReflow = pendingReflow || previous >= 0 && changed;
                // Apply the changed row geometry before this frame paints, not one frame later.
                if (doc.hidden) scheduleLayout(previous >= 0);
                else relayout(previous >= 0);
            }
            else if (browsing) { if (changed || force) paint(); }
            else if ((changed || force) && !continuing) align(previous >= 0);
            scrollMotion.setActive(lines[index], { smooth: previous >= 0, endAt: browsing ? null : followEnd });
        },
        dispose() {
            if (disposed) return;
            reset(); disposed = true; scrollMotion.dispose(); observer?.disconnect(); listeners.forEach(remove => remove());
        }
    };
}
