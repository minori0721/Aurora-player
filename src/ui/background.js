import { DEFAULT_THEME_BASE, DEFAULT_THEME_COLORS } from './theme.js';

import { createSpatialPainter, SPATIAL_TRANSITION_MS, transitionProgress } from './background-field.js';

const THEME_TRANSITION_MS = SPATIAL_TRANSITION_MS;

export function backgroundSize(width, height) {
    const w = Number.isFinite(width) ? Math.max(1, width) : 1;
    const h = Number.isFinite(height) ? Math.max(1, height) : 1;
    const scale = Math.min(1, (w <= 768 ? 384 : 512) / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), fps: w <= 768 ? 24 : 30 };
}

export function flowTheme(theme = {}) {
    const base = (theme.base || DEFAULT_THEME_BASE).match(/[\d.]+/g)?.slice(0, 3).map(Number);
    const fallbackBase = base?.length === 3 ? base : [245, 247, 250];
    const colors = new Float32Array(12), weights = new Float32Array(4);
    for (let i = 0; i < 4; i++) {
        const css = theme.colors?.[i] || DEFAULT_THEME_COLORS[i];
        const hex = /^#([\da-f]{6})$/i.exec(css);
        const values = hex ? [0, 2, 4].map(offset => parseInt(hex[1].slice(offset, offset + 2), 16)) : css.match(/[\d.]+/g)?.map(Number);
        const rgb = values?.length >= 3 && values.slice(0, 3).every(Number.isFinite) ? values : fallbackBase;
        const alpha = rgb.length > 3 ? Math.max(0, Math.min(1, rgb[3])) : 1;
        for (let channel = 0; channel < 3; channel++) {
            const value = Math.max(0, Math.min(1, (rgb[channel] * alpha + fallbackBase[channel] * (1 - alpha)) / 255));
            colors[i * 3 + channel] = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        }
        weights[i] = Number.isFinite(theme.weights?.[i]) ? Math.max(0.03, theme.weights[i]) : 0.25;
    }
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    for (let i = 0; i < 4; i++) weights[i] /= total;
    return { colors, weights };
}

export const createFlowPainter = createSpatialPainter;

export function createFlowBackground(canvas, { body = document.body, makePainter = createFlowPainter } = {}) {
    let painter = null, disposed = false, lost = false, failed = false;
    let spatialTheme = {};
    let playing = false, hidden = true, reduced = false, phase = 0, lastMotionAt = null;
    let frame = 0, timer = 0, fps = 30, draws = 0, transitionAt = -Infinity, nextFrameAt = 0;
    let target = flowTheme(), from = target;
    const colors = new Float32Array(target.colors), weights = new Float32Array(target.weights);
    const transitionMs = THEME_TRANSITION_MS;
    if (canvas) canvas.hidden = true;

    function cancel(resetMotion = true) {
        if (frame) cancelAnimationFrame(frame);
        if (timer) clearTimeout(timer);
        frame = timer = 0;
        if (resetMotion) lastMotionAt = null;
        nextFrameAt = 0;
    }

    function interpolate(now) {
        const t = reduced ? 1 : Math.max(0, Math.min(1, (now - transitionAt) / transitionMs));
        const ease = transitionProgress(t * transitionMs);
        for (let i = 0; i < 12; i++) colors[i] = from.colors[i] + (target.colors[i] - from.colors[i]) * ease;
        for (let i = 0; i < 4; i++) weights[i] = from.weights[i] + (target.weights[i] - from.weights[i]) * ease;
        return t < 1;
    }

    function schedule() {
        if (disposed || hidden || reduced || failed || lost || !painter || frame || timer) return;
        if (!playing && performance.now() >= transitionAt + transitionMs) return;
        const now = performance.now(), interval = 1000 / fps;
        nextFrameAt = nextFrameAt ? Math.max(nextFrameAt, now - interval) + interval : now + interval;
        timer = setTimeout(() => {
            timer = 0;
            frame = requestAnimationFrame(render);
        }, Math.max(0, nextFrameAt - now - 2));
    }

    function render(now = performance.now()) {
        frame = 0;
        if (disposed || hidden || failed || lost || !canvas) return;
        if (!painter) {
            try { painter = makePainter(canvas); } catch (_) { painter = null; }
            if (!painter) { failed = true; canvas.hidden = true; return; }
            painter.setTheme?.(spatialTheme, now);
            body?.classList?.add('flow-background-ready');
            canvas.hidden = false;
        }
        if (playing && !reduced && lastMotionAt !== null) phase += Math.min(0.25, Math.max(0, now - lastMotionAt) / 1000);
        lastMotionAt = now;
        interpolate(now);
        if (reduced) painter.finishTransition?.();
        painter.draw(colors, weights, phase);
        draws++;
        schedule();
    }

    function setTheme(theme = {}) {
        if (disposed) return;
        const spatialChanged = theme.spatial !== spatialTheme.spatial;
        spatialTheme = theme;
        const next = flowTheme(theme);
        if (!spatialChanged && next.colors.every((value, index) => value === target.colors[index]) && next.weights.every((value, index) => value === target.weights[index])) return;
        const now = performance.now();
        painter?.setTheme?.(spatialTheme, hidden || reduced ? now - transitionMs : now);
        interpolate(now);
        from = { colors: new Float32Array(colors), weights: new Float32Array(weights) };
        target = next;
        transitionAt = painter && !hidden && !reduced ? now : -Infinity;
        if (painter && !hidden) { cancel(false); render(now); }
    }

    function setState(state) {
        if (disposed) return;
        const changed = playing !== !!state.playing || hidden !== !!state.hidden || reduced !== !!state.reduced;
        playing = !!state.playing; hidden = !!state.hidden; reduced = !!state.reduced;
        const size = backgroundSize(state.width, state.height);
        fps = size.fps;
        const resized = canvas && (canvas.width !== size.width || canvas.height !== size.height);
        if (resized) { canvas.width = size.width; canvas.height = size.height; }
        if (changed || resized) cancel(changed);
        if (hidden || disposed || failed || lost) return;
        // A page with no playback never allocates a WebGL context just to sit idle.
        if ((changed || resized) && (painter || (playing && !reduced)) && canvas) render();
    }

    function contextLost(event) {
        event.preventDefault(); lost = true; painter = null; cancel();
        canvas.hidden = true; body?.classList?.remove('flow-background-ready');
    }

    function contextRestored() {
        if (disposed) return;
        lost = failed = false;
        if (!hidden && playing) render();
    }

    canvas?.addEventListener?.('webglcontextlost', contextLost);
    canvas?.addEventListener?.('webglcontextrestored', contextRestored);
    return {
        setTheme, setState,
        getStats: () => ({ draws, phase, active: !!(frame || timer), ready: !!painter, failed, lost, width: canvas?.width, height: canvas?.height, fps }),
        dispose() {
            disposed = true; cancel(); painter?.dispose(); painter = null;
            canvas?.removeEventListener?.('webglcontextlost', contextLost);
            canvas?.removeEventListener?.('webglcontextrestored', contextRestored);
            if (canvas) { canvas.hidden = true; canvas.width = canvas.height = 1; }
            body?.classList?.remove('flow-background-ready');
        }
    };
}
