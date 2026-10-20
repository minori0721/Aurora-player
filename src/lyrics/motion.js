export const LYRIC_SCROLL_DURATION_MS = 400;
export const LYRIC_SCROLL_LEAD_MS = 15;
export const LYRIC_SCROLL_EASING = 'cubic-bezier(0.3333333333, 1, 0.6666666667, 1)';
export const LYRIC_REST_SCALE = 1 / 1.16;

function sample(state, time) {
    const t = Math.max(0, Math.min(1, (time - state.started) / state.duration));
    const distance = state.to - state.from;
    const slope = state.slope;
    const progress = (-2 * t + 3) * t * t + slope * t * (1 - t) * (1 - t);
    const speed = (1 - t) * (slope + (6 - 3 * slope) * t);
    return { position: state.from + distance * progress, velocity: distance * speed / state.duration, done: t >= 1 };
}

export function createLyricMotion(viewport, { environment, document: doc, isReduced } = {}) {
    let motion = null, frame = 0, generation = 0, disposed = false, active = null;
    const records = new Map(), moving = new Map();
    const now = () => environment.performance.now();
    const write = value => {
        if (typeof viewport.scrollTo === 'function') viewport.scrollTo({ top: value, behavior: 'auto' });
        else viewport.scrollTop = value;
    };
    function stopFrame() {
        environment.cancelAnimationFrame(frame);
        frame = 0; generation++;
    }
    function curve(from, to, started, end, velocity = null) {
        const duration = Math.max(1, end - started), distance = to - from;
        const slope = velocity === null || Math.abs(distance) < 1e-12 ? 3
            : Math.max(0, Math.min(3, velocity * duration / distance));
        return { from, to, started, duration, slope };
    }
    function paint(record, scale) {
        record.value = scale;
        const transform = `scale(${scale})`;
        if (record.visual.style.transform !== transform) record.visual.style.transform = transform;
        const shift = `translateY(calc(var(--lyric-subtitle-gap) * ${1 / scale - 1}))`;
        if (record.subtitle && record.subtitle.style.transform !== shift) record.subtitle.style.transform = shift;
    }
    function getRecord(line) {
        if (!line) return null;
        let record = records.get(line);
        if (!record) {
            const visual = line.querySelector('.lyric-visual');
            if (!visual) return null;
            record = { visual, subtitle: visual.querySelector('.lyric-translation'), value: LYRIC_REST_SCALE,
                extent: Math.max(visual.offsetWidth || 1, visual.offsetHeight || 1) };
            records.set(line, record);
        }
        return record;
    }
    function schedule() {
        if (frame || disposed || !motion && !moving.size) return;
        const stamp = generation;
        frame = environment.requestAnimationFrame(timestamp => {
            if (disposed || stamp !== generation) return;
            frame = 0; step(timestamp);
        });
    }
    function cancel(snapVisuals = false) {
        stopFrame(); motion = null;
        if (snapVisuals) {
            for (const [record, state] of moving) paint(record, state.to);
            moving.clear();
        }
        schedule();
    }
    function step(timestamp) {
        if (doc.hidden) { cancel(true); return; }
        const samples = [...moving].map(([record, state]) => [record, state, sample(state, timestamp)]);
        const scroll = motion && sample(motion, timestamp);
        const ratio = Math.max(1, environment.devicePixelRatio || 1);
        const settled = (state, value, extent = 1) => Math.abs(state.to - value.position) * extent * ratio < .1
            && Math.abs(value.velocity) * (1000 / 60) * extent * ratio < .1;
        // Finish the shared group together once remaining motion is below a tenth of a device pixel.
        const finish = isReduced() || (!scroll || settled(motion, scroll))
            && samples.every(([record, state, value]) => settled(state, value, record.extent));
        if (scroll) {
            write(finish || scroll.done ? motion.to : scroll.position);
            if (finish || scroll.done) motion = null;
        }
        for (const [record, state, value] of samples) {
            paint(record, finish || value.done ? state.to : value.position);
            if (finish || value.done) moving.delete(record);
        }
        schedule();
    }
    function moveTo(value, smooth = false) {
        if (disposed) return;
        const height = viewport.clientHeight || viewport.offsetHeight || 1;
        const target = Math.max(0, Math.min(Math.max(0, (viewport.scrollHeight || 0) - height), value));
        const time = now(), from = viewport.scrollTop || 0;
        if (smooth && motion?.to === target && !isReduced() && !doc.hidden) return motion.started + motion.duration;
        const velocity = motion ? sample(motion, time).velocity : null;
        stopFrame(); motion = null;
        if (!smooth || isReduced() || doc.hidden || Math.abs(target - from) < .5) {
            write(target); schedule(); return time;
        }
        motion = curve(from, target, time, time + LYRIC_SCROLL_DURATION_MS, velocity);
        schedule();
        return time + LYRIC_SCROLL_DURATION_MS;
    }
    function targetScale(record, target, time, end, smooth) {
        if (!record) return;
        const previous = moving.get(record);
        if (previous?.to === target && smooth) return;
        const velocity = previous ? sample(previous, time).velocity : null;
        if (!smooth || end <= time || Math.abs(target - record.value) < 1e-9) {
            moving.delete(record); paint(record, target); return;
        }
        moving.set(record, curve(record.value, target, time, end, velocity));
        // Keep the previous rendered scale through the class change, before the next paint.
        paint(record, record.value);
    }
    function setActive(line, { smooth = true, endAt = null } = {}) {
        if (disposed) return;
        const next = getRecord(line), time = now();
        const end = endAt ?? time + LYRIC_SCROLL_DURATION_MS;
        smooth = smooth && !isReduced() && !doc.hidden;
        if (active !== next) targetScale(active, LYRIC_REST_SCALE, time, end, smooth);
        if (active !== next || !smooth) targetScale(next, 1, time, end, smooth);
        active = next; schedule();
    }
    function refresh() {
        for (const record of records.values()) {
            record.subtitle = record.visual.querySelector('.lyric-translation');
            record.extent = Math.max(record.visual.offsetWidth || 1, record.visual.offsetHeight || 1);
            paint(record, record.value);
        }
    }
    function reset() {
        stopFrame(); motion = null; active = null; moving.clear();
        for (const record of records.values()) {
            record.visual.style.transform = '';
            if (record.subtitle) record.subtitle.style.transform = '';
        }
        records.clear();
    }
    return { moveTo, cancel, setActive, refresh, reset, dispose() { reset(); disposed = true; } };
}
