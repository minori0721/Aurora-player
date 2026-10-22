import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLyricMotion, LYRIC_REST_SCALE, LYRIC_SCROLL_DURATION_MS, LYRIC_SCROLL_EASING } from '../src/lyrics/motion.js';
import { FakeElement } from './helpers/host.mjs';

test('timed lyric transforms have one JS owner and only the active original is bold', () => {
    const css = fs.readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
    const ruleFor = selector => css.match(new RegExp(`^${selector.replaceAll('.', '\\.')}\\s*\\{([^}]+)\\}`, 'm'))[1];
    assert.equal(LYRIC_SCROLL_DURATION_MS, 400);
    const points = [...LYRIC_SCROLL_EASING.matchAll(/[\d.]+/g)].map(value => Number(value[0]));
    for (let i = 0; i <= 100; i++) {
        const t = i / 100, x = 3 * (1 - t) ** 2 * t * points[0] + 3 * (1 - t) * t ** 2 * points[2] + t ** 3;
        const y = 3 * (1 - t) ** 2 * t * points[1] + 3 * (1 - t) * t ** 2 * points[3] + t ** 3;
        assert.ok(Math.abs(x - t) < 1e-9);
        assert.ok(Math.abs(y - (1 - (1 - t) ** 3)) < 1e-9);
    }
    for (const selector of ['.lyric-visual', '.lyric-visual .lyric-translation']) {
        const rule = ruleFor(selector);
        assert.match(rule, /transition:\s*none\s*;/);
    }
    assert.match(ruleFor('.lyric-visual .lyric-original'), /font-weight:\s*400/);
    assert.match(ruleFor('.lyric-line.active .lyric-visual .lyric-original'), /font-weight:\s*800/);
    assert.doesNotMatch(ruleFor('.lyric-line'), /transition:[^;]*(?:font|all)/);
    const subtitle = ruleFor('.lyric-visual .lyric-translation');
    assert.match(subtitle, /font-weight:\s*500/);
});

test('subtitle gap stays within 0.02px throughout zoom without animating layout properties', () => {
    const css = fs.readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
    const scale = Number(css.match(/font-size: calc\(1\.1rem \* 1\.16\); transform: scale\(([\d.]+)\)/)[1]);
    const gap = Number(css.match(/--lyric-subtitle-gap:\s*([\d.]+)px/)[1]);
    const compensation = Number(css.match(/translateY\(calc\(var\(--lyric-subtitle-gap\) \* ([\d.]+)\)\)/)[1]);
    for (let i = 0; i <= 100; i++) {
        const progress = i / 100, currentScale = scale + (1 - scale) * progress;
        const actual = (gap + gap * compensation * (1 - progress)) * currentScale;
        assert.ok(Math.abs(actual - gap) < .02, `gap=${actual}, progress=${progress}`);
    }
    assert.match(css, /\.lyric-line\.active \.lyric-visual \.lyric-translation\s*\{\s*transform: translateY\(0\)/);
});

function fixture() {
    let time = 0, sequence = 0, reduced = false;
    const frames = new Map(), writes = [], doc = { hidden: false };
    const viewport = { clientHeight: 180, scrollHeight: 1800, scrollTop: 0,
        scrollTo(options) { this.scrollTop = options.top; writes.push(options); } };
    const environment = {
        performance: { now: () => time },
        requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
        cancelAnimationFrame(id) { frames.delete(id); }
    };
    const motion = createLyricMotion(viewport, { document: doc, isReduced: () => reduced, environment });
    const advance = ms => { time += ms; for (const [id, callback] of [...frames]) { frames.delete(id); callback(time); } };
    return { motion, viewport, frames, writes, doc, environment, advance, setReduced(value) { reduced = value; } };
}

test('scroll duration is 400ms; following eases out and stops requesting frames at its target', () => {
    assert.equal(LYRIC_SCROLL_DURATION_MS, 400);
    const f = fixture(); f.motion.moveTo(300, true);
    assert.equal(f.writes.length, 0); assert.equal(f.frames.size, 1);
    f.advance(100); assert.ok(f.viewport.scrollTop > 150 && f.viewport.scrollTop < 300);
    f.advance(299); assert.equal(f.viewport.scrollTop, 300); assert.equal(f.frames.size, 0);
    f.advance(1); assert.equal(f.viewport.scrollTop, 300); assert.equal(f.frames.size, 0);
    const writes = f.writes.length; f.advance(2000); assert.equal(f.writes.length, writes);
});

function line() {
    const row = new FakeElement(), visual = new FakeElement(), subtitle = new FakeElement();
    visual.className = 'lyric-visual'; subtitle.className = 'lyric-translation';
    visual.appendChild(subtitle); row.appendChild(visual);
    return { row, visual, subtitle };
}
const scaleOf = item => Number(item.visual.style.transform.match(/scale\(([^)]+)\)/)[1]);

test('15ms anticipation changes only scroll; zoom joins the same frame loop and deadline at the cue', () => {
    const f = fixture(), first = line(), second = line();
    f.motion.setActive(first.row, { smooth: false });
    const end = f.motion.moveTo(60, true); f.advance(15);
    assert.ok(f.viewport.scrollTop > 0); assert.equal(scaleOf(first), 1);
    f.motion.setActive(second.row, { endAt: end });
    assert.equal(scaleOf(first), 1); assert.equal(scaleOf(second), LYRIC_REST_SCALE);
    assert.equal(f.frames.size, 1);
    f.advance(100); assert.ok(scaleOf(second) > LYRIC_REST_SCALE && scaleOf(second) < 1);
    assert.ok(scaleOf(first) < 1 && scaleOf(first) > LYRIC_REST_SCALE);
    f.advance(285); assert.equal(f.viewport.scrollTop, 60);
    assert.equal(scaleOf(first), LYRIC_REST_SCALE); assert.equal(scaleOf(second), 1); assert.equal(f.frames.size, 0);
    const transform = second.visual.style.transform, count = f.writes.length;
    f.advance(1000); assert.equal(second.visual.style.transform, transform); assert.equal(f.writes.length, count);
});

test('subtitle box gap stays constant at every shared animation frame', () => {
    const f = fixture(), first = line(), second = line();
    f.motion.setActive(first.row, { smooth: false });
    const end = f.motion.moveTo(60, true); f.motion.setActive(second.row, { endAt: end });
    for (let i = 0; i < 24; i++) {
        f.advance(400 / 24);
        for (const item of [first, second]) {
            const scale = scaleOf(item), shift = Number(item.subtitle.style.transform.match(/\* ([^)]*)/)[1]);
            assert.ok(Math.abs((3 + 3 * shift) * scale - 3) < 1e-9);
        }
    }
});

test('repeated targets preserve the existing deadline and do not restart zoom or scrolling', () => {
    const f = fixture(), first = line(), second = line();
    f.motion.setActive(first.row, { smooth: false });
    const end = f.motion.moveTo(60, true); f.motion.setActive(second.row, { endAt: end });
    f.advance(100); const position = f.viewport.scrollTop, scale = scaleOf(second);
    assert.equal(f.motion.moveTo(60, true), end); f.motion.setActive(second.row, { endAt: end });
    assert.equal(f.viewport.scrollTop, position); assert.equal(scaleOf(second), scale);
    f.advance(300); assert.equal(scaleOf(second), 1); assert.equal(f.frames.size, 0);
});

test('rapid line changes continue displayed scales without jumps, overshoot or duplicate RAFs', () => {
    const f = fixture(), items = [line(), line(), line()];
    f.motion.setActive(items[0].row, { smooth: false });
    f.motion.setActive(items[1].row, { endAt: f.motion.moveTo(60, true) }); f.advance(100);
    const before = items.slice(0, 2).map(scaleOf);
    f.motion.setActive(items[2].row, { endAt: f.motion.moveTo(120, true) });
    assert.deepEqual(items.slice(0, 2).map(scaleOf), before); assert.equal(f.frames.size, 1);
    for (let i = 0; i < 25; i++) {
        f.advance(20);
        assert.ok(f.viewport.scrollTop <= 120);
        assert.ok(items.every(item => scaleOf(item) >= LYRIC_REST_SCALE && scaleOf(item) <= 1));
        assert.ok(f.frames.size <= 1);
    }
    assert.equal(f.frames.size, 0); assert.equal(scaleOf(items[2]), 1);
});

test('manual scroll cancellation never writes the old scroll target while zoom finishes', () => {
    const f = fixture(), first = line(), second = line();
    f.motion.setActive(first.row, { smooth: false });
    f.motion.setActive(second.row, { endAt: f.motion.moveTo(60, true) }); f.advance(100);
    const old = [...f.frames.values()][0]; f.motion.cancel(); f.viewport.scrollTop = 500;
    old(200); f.advance(400);
    assert.equal(f.viewport.scrollTop, 500); assert.equal(scaleOf(second), 1); assert.equal(f.frames.size, 0);
});

test('replacement subtitles inherit the current scale compensation without restarting the animation', () => {
    const f = fixture(), first = line(), second = line();
    f.motion.setActive(first.row, { smooth: false }); f.motion.setActive(second.row);
    f.advance(100); const scale = scaleOf(second);
    const replacement = new FakeElement(); replacement.className = 'lyric-translation';
    second.visual.replaceChildren(replacement); f.motion.refresh();
    assert.equal(scaleOf(second), scale); assert.equal(replacement.style.transform, second.subtitle.style.transform);
    f.advance(300); assert.equal(scaleOf(second), 1); assert.equal(f.frames.size, 0);
});

test('animation frames do not read layout or query word nodes', () => {
    const f = fixture(), first = line(), second = line(); let reads = 0;
    for (const item of [first, second]) for (const property of ['offsetWidth', 'offsetHeight']) {
        Object.defineProperty(item.visual, property, { get() { reads++; return 400; } });
    }
    f.motion.setActive(first.row, { smooth: false }); f.motion.setActive(second.row);
    const before = reads;
    for (let i = 0; i < 25; i++) f.advance(20);
    assert.equal(reads, before); assert.equal(f.frames.size, 0);
});

test('hidden pages, reduced motion, reset and disposal release the shared loop and old transforms', () => {
    for (const kind of ['hidden', 'reduced', 'reset', 'dispose']) {
        const f = fixture(), first = line(), second = line();
        f.motion.setActive(first.row, { smooth: false });
        f.motion.setActive(second.row, { endAt: f.motion.moveTo(60, true) }); f.advance(100);
        const stale = [...f.frames.values()][0];
        if (kind === 'hidden') f.doc.hidden = true;
        else if (kind === 'reduced') f.setReduced(true);
        else f.motion[kind]();
        f.advance(20); const current = second.visual.style.transform;
        if (kind === 'reset' || kind === 'dispose') assert.equal(current, '');
        else assert.equal(scaleOf(second), 1);
        stale(1000); f.advance(1000);
        assert.equal(second.visual.style.transform, current); assert.equal(f.frames.size, 0);
    }
});

test('rapid forward retargets keep position and velocity continuous without overshooting', () => {
    const f = fixture(); f.motion.moveTo(300, true); f.advance(99);
    const prior = f.viewport.scrollTop; f.advance(1); const position = f.viewport.scrollTop, speed = position - prior;
    f.motion.moveTo(450, true); assert.equal(f.viewport.scrollTop, position); f.advance(1);
    assert.ok(Math.abs((f.viewport.scrollTop - position) - speed) < .05);
    let previous = f.viewport.scrollTop;
    for (let i = 0; i < 20; i++) { f.advance(20); assert.ok(f.viewport.scrollTop >= previous && f.viewport.scrollTop <= 450); previous = f.viewport.scrollTop; }
    assert.equal(f.viewport.scrollTop, 450); assert.equal(f.frames.size, 0);
});

test('reversing the target stays bounded and stale callbacks cannot write over a new animation', () => {
    const f = fixture(); f.motion.moveTo(300, true); const stale = [...f.frames.values()][0]; f.advance(100);
    const position = f.viewport.scrollTop; f.motion.moveTo(0, true); stale(200);
    assert.equal(f.viewport.scrollTop, position); assert.equal(f.frames.size, 1);
    let previous = position;
    for (let i = 0; i < 20; i++) { f.advance(20); assert.ok(f.viewport.scrollTop <= previous && f.viewport.scrollTop >= 0); previous = f.viewport.scrollTop; }
    assert.equal(f.viewport.scrollTop, 0);
});

test('cancellation, hidden pages and disposal leave no continuing frame or late write', () => {
    const f = fixture(); f.motion.moveTo(300, true); f.advance(100);
    const position = f.viewport.scrollTop; f.motion.cancel(); f.advance(1000);
    assert.equal(f.viewport.scrollTop, position); assert.equal(f.frames.size, 0);
    f.motion.moveTo(400, true); f.doc.hidden = true; f.advance(20);
    assert.equal(f.viewport.scrollTop, position); assert.equal(f.frames.size, 0);
    f.doc.hidden = false; f.motion.moveTo(400, true); const old = [...f.frames.values()][0]; f.motion.dispose(); old(3000);
    assert.equal(f.viewport.scrollTop, position); assert.equal(f.frames.size, 0);
});

test('reduced motion snaps, can interrupt an active scroll, and targets stay within scroll bounds', () => {
    const f = fixture(); f.setReduced(true); f.motion.moveTo(5000, true);
    assert.equal(f.viewport.scrollTop, 1620); assert.equal(f.frames.size, 0);
    f.setReduced(false); f.motion.moveTo(0, true); f.advance(100); f.setReduced(true); f.advance(20);
    assert.equal(f.viewport.scrollTop, 0); assert.equal(f.frames.size, 0);
    f.motion.moveTo(-20); assert.equal(f.viewport.scrollTop, 0);
});
