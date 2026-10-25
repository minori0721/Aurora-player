import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLyricViewport, LYRIC_RESUME_DELAY_MS } from '../src/lyrics/viewport.js';
import { FakeElement } from './helpers/host.mjs';

test('lyric padding stays immediate when reduced-motion sets a global transition duration', () => {
    const css = fs.readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
    const rule = css.match(/\.lyrics-scroll\s*\{([^}]+)\}/)[1];
    assert.match(rule, /transition:\s*none\s*;/);
});

function fixture({ cover = null, desktop = true, reduced = true, withVisuals = false, nativeSmooth = false, onSeek = null } = {}) {
    let now = 0, sequence = 0, selected = false, resizeCallback = () => {}, geometryReads = 0;
    const timers = new Map(), frames = new Map(), moves = [], seeks = [];
    const doc = new FakeElement(), shell = new FakeElement(), viewport = new FakeElement(), content = new FakeElement();
    const button = new FakeElement(), hint = new FakeElement(), state = { playing: true, reduced, desktop };
    const layout = new FakeElement(), header = new FakeElement(), controls = new FakeElement(), observed = [];
    layout.append(header, shell, controls); shell.parentElement = layout;
    viewport.parentNode = shell; viewport.clientHeight = 180; viewport.scrollTop = 0;
    viewport.appendChild(content);
    const lines = Array.from({ length: 20 }, (_, index) => {
        const line = new FakeElement(); line.dataset.time = String(index * 5); line.dataset.lyricTime = line.dataset.time;
        line.closest = selector => selector === '[data-lyric-time]' ? line : null;
        Object.defineProperty(line, 'offsetTop', { configurable: true, get: () => { geometryReads++; return (parseFloat(content.style.paddingTop) || 0) + index * 60; } });
        line.offsetHeight = 44;
        if (withVisuals) {
            const visual = new FakeElement(), original = new FakeElement(), subtitle = new FakeElement();
            visual.className = 'lyric-visual'; visual.offsetTop = 3;
            original.className = 'lyric-original'; original.offsetTop = 0; original.offsetHeight = 28;
            subtitle.className = 'lyric-translation'; visual.append(original, subtitle); line.appendChild(visual);
        }
        return line;
    });
    content.append(...lines);
    viewport.contains = node => node === viewport || node === content || lines.includes(node);
    viewport.focus = () => { doc.activeElement = viewport; };
    Object.defineProperty(viewport, 'scrollHeight', { get: () => (parseFloat(content.style.paddingTop) || 0) + (parseFloat(content.style.paddingBottom) || 0) + 19 * 60 + 44 });
    viewport.scrollTo = options => { if (!nativeSmooth || options.behavior !== 'smooth') viewport.scrollTop = options.top; moves.push(options); };
    doc.hidden = false; doc.getSelection = () => ({ isCollapsed: !selected, anchorNode: lines[0] });
    const environment = Object.assign(new FakeElement(), {
        performance: { now: () => now },
        matchMedia: query => ({ get matches() { return query.includes('901px') ? state.desktop : state.reduced; } }),
        setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
        cancelAnimationFrame(id) { frames.delete(id); },
        ResizeObserver: class { constructor(callback) { resizeCallback = callback; } observe(node) { observed.push(node); } disconnect() {} }
    });
    const flush = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(now); } };
    const tick = duration => {
        const end = now + duration;
        while (true) {
            const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            now = next[1].at; timers.delete(next[0]); next[1].callback(); flush();
        }
        now = end; flush();
    };
    const event = (target, type, extra = {}) => target.dispatchEvent({ type, target, preventDefault() {}, stopPropagation() {}, ...extra });
    let view;
    view = createLyricViewport(viewport, { content, returnButton: button, timeHint: hint, alignmentTarget: cover, environment, document: doc,
        isPlaying: () => state.playing, seek: time => { seeks.push(time); if (onSeek) return onSeek(time, view); view.setActive(time / 5); } });
    view.setLines(lines); view.setActive(2);
    const scroll = top => { viewport.scrollTop = top; event(viewport, 'scroll'); flush(); };
    const wheel = () => event(viewport, 'wheel', { deltaY: 120 });
    const click = line => event(content, 'click', { target: line });
    return { view, shell, viewport, content, button, hint, state, lines, doc, environment, timers, frames, moves, seeks,
        event, tick, flush, scroll, wheel, click, header, controls, observed, resize: () => resizeCallback(), geometryReads: () => geometryReads,
        select(value) { selected = value; event(doc, 'selectionchange'); } };
}

test('lyrics follow only when the active line changes, with no persistent idle task', () => {
    const f = fixture(), count = f.moves.length;
    assert.equal(f.viewport.scrollTop, 142);
    f.view.setActive(2); assert.equal(f.moves.length, count);
    f.view.setActive(3); assert.equal(f.viewport.scrollTop, 202);
    assert.equal(f.button.hidden, true); assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 0);
    f.view.dispose();
});

test('continuous browsing cancels follow only once and defers geometry work until the gesture ends', () => {
    const f = fixture(), before = f.moves.length;
    f.wheel(); f.scroll(600);
    const reads = f.geometryReads(), entered = f.moves.length;
    for (let index = 3; index < 15; index++) { f.wheel(); f.view.setActive(index); f.view.relayout(); }
    assert.equal(entered, before + 1); assert.equal(f.moves.length, entered);
    assert.equal(f.geometryReads(), reads);
    f.tick(180); assert.ok(f.geometryReads() > reads);
    const settled = f.geometryReads(); f.event(f.viewport, 'scrollend'); f.flush();
    assert.equal(f.geometryReads(), settled, 'native event and timer must not duplicate layout');
    f.view.dispose();
});

test('returning far away uses native smooth scrolling and cannot be overwritten by a cue change', () => {
    const f = fixture({ reduced: false, nativeSmooth: true });
    f.wheel(); f.scroll(1100); f.view.returnToCurrent();
    assert.equal(f.moves.at(-1).behavior, 'smooth'); assert.equal(f.viewport.scrollTop, 1100);
    const moves = f.moves.length;
    f.view.setActive(6); assert.equal(f.moves.length, moves);
    f.scroll(142); f.event(f.viewport, 'scrollend'); f.tick(400);
    assert.equal(f.viewport.scrollTop, 382); assert.deepEqual(f.seeks, []);
    f.view.dispose();
});

test('manual input interrupts native return and stale callbacks cannot finish a later return', () => {
    const f = fixture({ reduced: false, nativeSmooth: true });
    f.wheel(); f.scroll(1100); f.view.returnToCurrent();
    const old = [...f.timers.values()].at(-1).callback;
    f.wheel(); f.scroll(900); f.view.returnToCurrent();
    const moves = f.moves.length; old();
    assert.equal(f.moves.length, moves); assert.equal(f.viewport.scrollTop, 900);
    f.wheel(); f.scroll(800); f.tick(180);
    assert.equal(f.viewport.scrollTop, 800); assert.equal(f.button.hidden, false);
    f.view.dispose(); assert.equal(f.timers.size, 0);
});

test('wheel browsing keeps playback separate and resumes six seconds after scrolling settles', () => {
    const f = fixture();
    f.wheel(); f.scroll(600);
    assert.equal(f.button.hidden, false); assert.equal(f.button.dataset.direction, 'up');
    assert.equal(f.hint.textContent, '浏览 00:50');
    f.view.setActive(5); assert.equal(f.viewport.scrollTop, 600); assert.deepEqual(f.seeks, []);
    f.tick(180 + LYRIC_RESUME_DELAY_MS - 1); assert.equal(f.viewport.scrollTop, 600);
    f.tick(1); assert.equal(f.viewport.scrollTop, 322); assert.equal(f.button.hidden, true);
    assert.deepEqual(f.seeks, []); f.view.dispose();
});

test('pausing cancels auto-return, and resuming starts a fresh delay', () => {
    const f = fixture(); f.wheel(); f.scroll(600); f.tick(180);
    f.state.playing = false; f.view.syncPlayback(); f.tick(20000);
    assert.equal(f.viewport.scrollTop, 600); assert.equal(f.timers.size, 0);
    f.state.playing = true; f.view.syncPlayback(); f.tick(5999);
    assert.equal(f.viewport.scrollTop, 600); f.tick(1); assert.equal(f.button.hidden, true);
    f.view.dispose();
});

test('native touch scrolling enters browse mode even when the browser cancels pointer events', () => {
    const f = fixture();
    f.event(f.viewport, 'pointerdown', { pointerId: 1, clientX: 0, clientY: 10, button: 0 });
    f.event(f.viewport, 'touchstart', { touches: [{}] });
    f.event(f.doc, 'pointercancel', { pointerId: 1 });
    f.scroll(700); f.tick(20000); assert.equal(f.button.hidden, false);
    f.event(f.viewport, 'touchend', { touches: [] }); f.click(f.lines[8]); assert.deepEqual(f.seeks, []); f.tick(LYRIC_RESUME_DELAY_MS);
    assert.equal(f.button.hidden, true); assert.deepEqual(f.seeks, []); f.view.dispose();
});

test('drag release cannot seek, while a later deliberate line click can seek and follow', () => {
    const f = fixture();
    f.event(f.viewport, 'pointerdown', { pointerId: 1, clientX: 0, clientY: 100, button: 0 });
    f.event(f.viewport, 'pointermove', { pointerId: 1, clientX: 0, clientY: 60 });
    f.event(f.doc, 'pointerup', { pointerId: 1 }); f.click(f.lines[8]);
    assert.deepEqual(f.seeks, []);
    f.tick(501); f.click(f.lines[8]);
    assert.deepEqual(f.seeks, [40]); assert.equal(f.button.hidden, true); f.view.dispose();
});

test('return button aligns to the latest playing line without seeking or changing play state', () => {
    const f = fixture(); f.wheel(); f.scroll(600); f.view.setActive(10);
    f.state.playing = false; f.view.syncPlayback(); f.doc.activeElement = f.button; f.event(f.button, 'click');
    assert.equal(f.viewport.scrollTop, 622); assert.equal(f.state.playing, false); assert.deepEqual(f.seeks, []);
    assert.equal(f.doc.activeElement, f.viewport);
    f.view.dispose();
});

test('clicking a following lyric commits its new active line before starting exactly one return', () => {
    const f = fixture({ reduced: false, nativeSmooth: true, withVisuals: true }), before = f.moves.length;
    f.click(f.lines[8]);
    assert.deepEqual(f.seeks, [40]);
    assert.equal(f.moves.length, before + 1);
    assert.equal(f.moves.at(-1).behavior, 'smooth');
    assert.equal(f.moves.at(-1).top, f.lines[8].offsetTop + 17 - 90);
    const target = f.moves.at(-1).top, moves = f.moves.length;
    f.scroll(target); f.event(f.viewport, 'scrollend'); f.flush(); f.tick(500);
    assert.equal(f.moves.length, moves, 'finishing an aligned return must not write the position again');
    assert.equal(f.viewport.scrollTop, target);
    f.view.dispose();
});

test('a later clicked line wins and reset during a seek invalidates the old positioning pass', () => {
    const f = fixture({ reduced: false, nativeSmooth: true });
    f.click(f.lines[8]); f.click(f.lines[12]);
    assert.deepEqual(f.seeks, [40, 60]);
    const target = f.moves.at(-1).top;
    assert.equal(target, f.lines[12].offsetTop + 22 - 90);
    f.scroll(target); f.event(f.viewport, 'scrollend'); f.tick(1000);
    assert.equal(f.viewport.scrollTop, target);
    f.view.dispose();
    const g = fixture({ onSeek: (time, view) => { view.reset(); return true; } });
    g.click(g.lines[8]);
    assert.equal(g.button.hidden, true);
    assert.equal(g.viewport.scrollTop, 0);
    g.view.dispose();
});

test('a cancelled native scrollend cannot finish a newer lyric return before it reaches its target', () => {
    const f = fixture({ reduced: false, nativeSmooth: true });
    f.wheel(); f.scroll(1100); f.view.returnToCurrent(); f.click(f.lines[12]);
    const count = f.moves.length, target = f.moves.at(-1).top;
    f.event(f.viewport, 'scrollend');
    assert.equal(f.moves.length, count); assert.equal(f.viewport.scrollTop, 1100);
    f.scroll(target); f.event(f.viewport, 'scrollend');
    assert.equal(f.moves.length, count); assert.equal(f.viewport.scrollTop, target);
    f.view.dispose();
});

test('track reset cancels timers and invalidates even an already queued old return callback', () => {
    const f = fixture(); f.wheel(); f.scroll(600); f.tick(180);
    const old = [...f.timers.values()][0].callback;
    f.view.reset(); f.view.setLines(f.lines); f.view.setActive(1);
    const position = f.viewport.scrollTop; old(); f.tick(20000);
    assert.equal(f.viewport.scrollTop, position); assert.equal(f.button.hidden, true); assert.equal(f.hint.hidden, true);
    f.view.dispose();
});

test('keyboard browsing keeps its position until focus leaves or Escape explicitly restores it', () => {
    const f = fixture(); f.event(f.viewport, 'keydown', { key: 'PageDown' }); f.scroll(600); f.tick(20000);
    assert.equal(f.button.hidden, false);
    f.event(f.viewport, 'keydown', { key: 'Escape' }); assert.equal(f.viewport.scrollTop, 142);
    f.event(f.viewport, 'keydown', { key: 'End' }); f.scroll(900); f.tick(180);
    f.event(f.viewport, 'focusout', { relatedTarget: f.button }); f.tick(LYRIC_RESUME_DELAY_MS);
    assert.equal(f.button.hidden, true); f.view.dispose();
});

test('selected text and hidden pages defer return instead of pulling the view away', () => {
    const f = fixture(); f.wheel(); f.scroll(600); f.tick(180); f.select(true); f.tick(12000);
    assert.equal(f.button.hidden, false); f.click(f.lines[6]); assert.deepEqual(f.seeks, []);
    f.select(false); f.doc.hidden = true; f.event(f.doc, 'visibilitychange'); f.tick(12000);
    assert.equal(f.button.hidden, false);
    f.doc.hidden = false; f.event(f.doc, 'visibilitychange'); f.tick(LYRIC_RESUME_DELAY_MS);
    assert.equal(f.button.hidden, true); f.view.dispose();
});

test('layout changes preserve the browsing anchor but realign a following view', () => {
    const f = fixture(); f.wheel(); f.scroll(600); const before = f.viewport.scrollTop;
    f.view.relayout(); assert.equal(f.viewport.scrollTop, before);
    f.viewport.clientHeight = 240; f.view.relayout(); assert.equal(f.button.hidden, false);
    f.view.returnToCurrent(); f.view.relayout();
    assert.equal(f.viewport.scrollTop, 142); f.view.dispose();
});

test('plain lyrics stay scrollable without fabricated time or a return control', () => {
    const f = fixture(); f.view.setLines([]); f.wheel(); f.scroll(400); f.tick(20000);
    assert.equal(f.viewport.scrollTop, 400); assert.equal(f.button.hidden, true); assert.equal(f.hint.hidden, true);
    assert.deepEqual(f.seeks, []); f.view.dispose();
});

test('subtitle changes keep the original text centered, without repeated alignment', () => {
    const f = fixture(), original = new FakeElement();
    original.className = 'lyric-original'; original.offsetTop = 3; original.offsetHeight = 28;
    f.lines[2].appendChild(original); f.view.relayout();
    assert.equal(f.viewport.scrollTop, 137);
    const count = f.moves.length;
    f.lines[2].offsetHeight = 80; f.view.relayout(); f.view.relayout();
    assert.equal(f.viewport.scrollTop, 137); assert.equal(f.moves.length, count);
    assert.equal(f.lines[2].style['--lyric-anchor-y'], '17px');
    f.lines[2].offsetHeight = 44; f.view.relayout();
    assert.equal(f.moves.length, count); f.view.dispose();
});

test('scaled inner text has its own origin while scrolling keeps the outer row coordinates', () => {
    const f = fixture(), visual = new FakeElement(), original = new FakeElement(), subtitle = new FakeElement();
    visual.className = 'lyric-visual'; visual.offsetTop = 3;
    original.className = 'lyric-original'; original.offsetTop = 0; original.offsetHeight = 30;
    subtitle.className = 'lyric-translation'; visual.append(original, subtitle); f.lines[2].appendChild(visual);
    f.view.relayout();
    assert.equal(f.lines[2].style['--lyric-anchor-y'], '15px');
    assert.equal(f.viewport.scrollTop, f.lines[2].offsetTop + 18 - 90);
    const position = f.viewport.scrollTop;
    f.lines[2].offsetHeight = 90; f.view.relayout();
    assert.equal(f.viewport.scrollTop, position, 'a subtitle must not shift the main text anchor');
    original.offsetHeight = 60; f.view.relayout();
    assert.equal(f.lines[2].style['--lyric-anchor-y'], '30px');
    assert.equal(f.viewport.scrollTop, f.lines[2].offsetTop + 33 - 90); f.view.dispose();
});

test('long-lyric styles keep the click row unscaled and bound timed word boxes', () => {
    const css = fs.readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
    assert.match(css, /\.lyric-line\[data-lyric-time\]\s*\{[^}]*transform:\s*none/);
    assert.match(css, /\.lyric-visual\s*\{[^}]*transform:\s*scale\(0\.8620689655\)/);
    assert.match(css, /\.lyric-line\.active \.lyric-visual\s*\{\s*transform:\s*scale\(1\)/);
    assert.match(css, /\.yrc-char\s*\{[^}]*max-width:\s*100%[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere/);
});

test('layout compensation is immediate but taking control still cancels smooth scrolling', () => {
    const f = fixture(), original = new FakeElement();
    original.className = 'lyric-original'; original.offsetTop = 3; original.offsetHeight = 28;
    f.lines[2].appendChild(original); f.view.relayout();
    assert.equal(f.moves.at(-1).behavior, 'auto');
    const count = f.moves.length; f.wheel();
    assert.equal(f.moves.length, count + 1); assert.equal(f.moves.at(-1).behavior, 'auto');
    assert.equal(f.viewport.scrollTop, 137); f.view.dispose();
});

test('desktop follows the cover center and returning from browse uses the same anchor', () => {
    const cover = new FakeElement(); cover.getBoundingClientRect = () => ({ top: 10, height: 100 });
    const f = fixture({ cover });
    assert.equal(f.content.style.paddingTop, '60px'); assert.equal(f.content.style.paddingBottom, '120px');
    assert.equal(f.lines[2].offsetTop + 22 - f.viewport.scrollTop, 60);
    f.wheel(); f.scroll(600); f.view.setActive(10); f.view.returnToCurrent();
    assert.equal(f.lines[10].offsetTop + 22 - f.viewport.scrollTop, 60); assert.deepEqual(f.seeks, []);
    f.view.setActive(0); assert.equal(f.lines[0].offsetTop + 22 - f.viewport.scrollTop, 60);
    f.view.setActive(19); assert.equal(f.lines[19].offsetTop + 22 - f.viewport.scrollTop, 60);
    f.view.dispose();
});

test('mobile keeps viewport centering and switching breakpoints restores the correct anchor', () => {
    let reads = 0;
    const cover = new FakeElement(); cover.getBoundingClientRect = () => { reads++; return { top: 10, height: 100 }; };
    const f = fixture({ cover, desktop: false });
    assert.equal(f.content.style.paddingTop, '90px'); assert.equal(reads, 0);
    assert.equal(f.viewport.scrollTop, 142);
    f.state.desktop = true; f.event(f.environment, 'resize'); f.flush();
    assert.equal(f.content.style.paddingTop, '60px');
    f.state.desktop = false; f.event(f.environment, 'resize'); f.flush();
    assert.equal(f.content.style.paddingTop, '90px'); assert.equal(f.content.style.paddingBottom, '90px');
    assert.equal(f.lines[2].offsetTop + 22 - f.viewport.scrollTop, 90); f.view.dispose();
});

test('cover anchors are bounded away from faded edges and unavailable geometry falls back', () => {
    let rect = { top: -500, height: 100 };
    const cover = new FakeElement(); cover.getBoundingClientRect = () => rect;
    const f = fixture({ cover }); assert.equal(f.content.style.paddingTop, '27px');
    rect = { top: 500, height: 100 }; f.view.relayout(); assert.equal(f.content.style.paddingTop, '153px');
    rect = { top: 10, height: 0 }; f.view.relayout(); assert.equal(f.content.style.paddingTop, '90px');
    rect = { top: NaN, height: 100 }; f.view.relayout(); assert.equal(f.content.style.paddingTop, '90px');
    f.view.dispose();
});

test('cover alignment does not change the browse timestamp or restart idle tasks', () => {
    let center = 60;
    const cover = new FakeElement(); cover.getBoundingClientRect = () => ({ top: center - 50, height: 100 });
    const f = fixture({ cover }); f.wheel(); f.scroll(600);
    const hint = f.hint.textContent, position = f.viewport.scrollTop;
    center = 100; f.view.relayout(); assert.equal(f.hint.textContent, hint); assert.equal(f.viewport.scrollTop, position);
    f.view.returnToCurrent(); f.tick(20000);
    assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 0); assert.deepEqual(f.seeks, []);
    f.view.dispose();
});

test('header or control resizing updates desktop placement even when the viewport size is unchanged', () => {
    const cover = new FakeElement(); cover.getBoundingClientRect = () => ({ top: 10, height: 100 });
    const f = fixture({ cover });
    assert.ok(f.observed.includes(f.header)); assert.ok(f.observed.includes(f.controls));
    f.viewport.getBoundingClientRect = () => ({ top: 10, height: 180 });
    f.resize(); f.flush();
    assert.equal(f.content.style.paddingTop, '50px');
    assert.equal(f.lines[2].offsetTop + 22 - f.viewport.scrollTop, 50);
    f.view.dispose();
});

test('reduced motion uses immediate alignment, and disposal removes listeners and pending work', () => {
    const f = fixture(); f.state.reduced = true; f.view.setActive(7);
    assert.equal(f.moves.at(-1).behavior, 'auto'); f.wheel(); f.scroll(600);
    f.view.dispose(); f.tick(20000); f.wheel();
    assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 0); assert.deepEqual(f.seeks, []);
});

function wrappingFixture(options) {
    const f = fixture(options), heights = f.lines.map(() => 40);
    for (const [index, line] of f.lines.entries()) {
        Object.defineProperty(line, 'offsetTop', { get: () => (parseFloat(f.content.style.paddingTop) || 0) + heights.slice(0, index).reduce((a, b) => a + b + 10, 0) });
        Object.defineProperty(line, 'offsetHeight', { get: () => heights[index] });
    }
    heights[0] = 64; f.view.setLines(f.lines); f.view.setActive(0); f.flush();
    return { ...f, heights };
}

test('compensating row wraps invalidate cached centers even when the content height is unchanged', () => {
    const f = wrappingFixture({ reduced: false }), total = f.heights.reduce((a, b) => a + b, 0), moves = f.moves.length;
    f.heights[0] = 40; f.heights[1] = 64; f.view.setActive(1);
    assert.equal(f.moves.length, moves, 'must not scroll toward stale geometry');
    assert.equal(f.lines[1].style['--lyric-anchor-y'], '32px', 'measure the new geometry in the same update');
    assert.equal(f.frames.size, 1); f.tick(100);
    assert.ok(f.viewport.scrollTop > 32 && f.viewport.scrollTop < f.lines[1].offsetTop + 32 - 90);
    f.tick(300);
    assert.equal(f.heights.reduce((a, b) => a + b, 0), total);
    assert.equal(f.viewport.scrollTop, f.lines[1].offsetTop + 32 - 90);
    assert.equal(f.moves.length, moves + 2); assert.equal(f.moves.at(-1).behavior, 'auto');
    const aligned = f.moves.length; f.resize(); f.flush();
    assert.equal(f.moves.length, aligned, 'a delayed ResizeObserver must not interrupt the smooth scroll');
    f.view.dispose();
});

test('normal following moves over 400ms and wheel input immediately cancels its pending frame', () => {
    const f = fixture({ reduced: false }); f.view.setActive(3);
    assert.equal(f.viewport.scrollTop, 142); assert.equal(f.frames.size, 1);
    f.tick(100); assert.ok(f.viewport.scrollTop > 142 && f.viewport.scrollTop < 202);
    const position = f.viewport.scrollTop; f.wheel(); f.flush(); f.tick(1000);
    assert.equal(f.viewport.scrollTop, position); assert.equal(f.button.hidden, false);
    assert.deepEqual(f.seeks, []); f.view.dispose(); assert.equal(f.frames.size, 0);
});

test('hiding a page cancels animated following and returning synchronizes without a lingering frame', () => {
    const f = fixture({ reduced: false }); f.view.setActive(3); f.tick(100);
    const position = f.viewport.scrollTop; f.doc.hidden = true; f.event(f.doc, 'visibilitychange');
    f.tick(1000); assert.equal(f.viewport.scrollTop, position); assert.equal(f.frames.size, 0);
    f.doc.hidden = false; f.event(f.doc, 'visibilitychange'); f.flush();
    assert.equal(f.viewport.scrollTop, 202); assert.equal(f.frames.size, 0); f.view.dispose();
});

test('visible wrap compensation uses independent translation and is released on track reset', () => {
    const f = wrappingFixture({ reduced: false }), animations = [];
    f.environment.CSS = { supports: () => true };
    f.environment.getComputedStyle = () => ({ translate: '0px 0px' });
    for (const line of f.lines) line.animate = (keyframes, options) => {
        const animation = { keyframes, options, cancelled: false, finished: new Promise(() => {}), cancel() { this.cancelled = true; } };
        animations.push(animation); return animation;
    };
    f.heights[0] = 40; f.heights[1] = 64; f.view.setActive(1);
    assert.ok(animations.length > 0 && animations.length <= 32);
    assert.ok(animations.every(animation => animation.options.duration === 400 && 'translate' in animation.keyframes[0] && !('transform' in animation.keyframes[0])));
    f.view.reset(); assert.ok(animations.every(animation => animation.cancelled)); assert.equal(f.frames.size, 0); f.view.dispose();
});

test('row wrap refreshes do not pull an active touch gesture or trigger a seek', () => {
    const f = wrappingFixture(); f.wheel(); f.scroll(500);
    f.event(f.viewport, 'touchstart', { touches: [{}] });
    f.heights[0] = 40; f.heights[1] = 64; f.view.setActive(1); f.flush();
    assert.equal(f.viewport.scrollTop, 500); assert.deepEqual(f.seeks, []); assert.equal(f.button.hidden, false);
    f.event(f.viewport, 'touchend', { touches: [] }); f.view.returnToCurrent(); f.flush();
    assert.equal(f.viewport.scrollTop, f.lines[1].offsetTop + 32 - 90); f.view.dispose();
});

test('reset cancels following after a wrap and repeated unchanged highlights schedule nothing', () => {
    const f = wrappingFixture({ reduced: false });
    f.heights[0] = 40; f.heights[1] = 64; f.view.setActive(1); assert.equal(f.frames.size, 1);
    f.view.reset(); f.flush(); assert.equal(f.frames.size, 0);
    f.view.setLines(f.lines); f.view.setActive(2); f.flush();
    const count = f.moves.length;
    for (let i = 0; i < 100; i++) f.view.setActive(2);
    assert.equal(f.moves.length, count); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
    f.view.dispose();
});

test('explicit return uses fresh wrap geometry without waiting for another layout frame', () => {
    const f = wrappingFixture(); f.wheel(); f.scroll(500);
    f.heights[0] = 40; f.heights[1] = 64; f.view.setActive(1);
    const count = f.moves.length; f.view.returnToCurrent();
    assert.equal(f.moves.length, count + 1);
    assert.equal(f.viewport.scrollTop, f.lines[1].offsetTop + 32 - 90); f.view.dispose();
});

test('a cue flushes an already queued resize without leaving a second layout callback', () => {
    const f = wrappingFixture(); f.resize(); assert.equal(f.frames.size, 1);
    f.heights[0] = 40; f.heights[1] = 64; f.view.setActive(1);
    assert.equal(f.viewport.scrollTop, f.lines[1].offsetTop + 32 - 90);
    assert.equal(f.frames.size, 0); f.view.dispose();
});

test('15ms anticipation continues the same scroll when the real cue arrives', () => {
    const f = fixture({ reduced: false });
    assert.equal(f.view.anticipate(3), true); f.tick(15);
    assert.ok(f.viewport.scrollTop > 142 && f.viewport.scrollTop < 202);
    const position = f.viewport.scrollTop, moves = f.moves.length;
    f.view.setActive(3);
    assert.equal(f.viewport.scrollTop, position); assert.equal(f.moves.length, moves);
    f.tick(385);
    assert.equal(f.viewport.scrollTop, 202); assert.equal(f.frames.size, 0, 'the cue must not restart a 400ms animation');
    f.view.dispose();
});

test('viewport shares the anticipated scroll deadline with actual-cue zoom and leaves no finish callback', () => {
    const f = fixture({ reduced: false, withVisuals: true });
    const first = f.lines[2].querySelector('.lyric-visual'), second = f.lines[3].querySelector('.lyric-visual');
    assert.equal(first.style.transform, 'scale(1)');
    f.view.anticipate(3); f.tick(15);
    assert.equal(first.style.transform, 'scale(1)');
    f.view.setActive(3);
    assert.ok(Number(second.style.transform.match(/scale\(([^)]+)\)/)[1]) < 1);
    assert.equal(f.frames.size, 1);
    f.tick(385);
    assert.equal(f.viewport.scrollTop, f.lines[3].offsetTop + 17 - 90);
    assert.equal(second.style.transform, 'scale(1)'); assert.equal(f.frames.size, 0);
    const count = f.moves.length; f.tick(1000);
    assert.equal(f.moves.length, count); assert.equal(f.frames.size, 0); f.view.dispose();
});

test('browsing and track reset cannot restore a cancelled scroll or retain old zoom transforms', () => {
    const f = fixture({ reduced: false, withVisuals: true });
    f.view.setActive(3); f.tick(100); f.wheel(); f.scroll(600); f.tick(500);
    assert.equal(f.viewport.scrollTop, 600); assert.equal(f.frames.size, 0);
    assert.equal(f.lines[3].querySelector('.lyric-visual').style.transform, 'scale(1)');
    f.view.returnToCurrent(); f.tick(100); f.view.reset(); f.tick(1000);
    assert.equal(f.viewport.scrollTop, 0); assert.equal(f.frames.size, 0);
    for (const row of f.lines.slice(2, 4)) assert.equal(row.querySelector('.lyric-visual').style.transform, '');
    f.view.dispose();
});

test('early scrolling never changes the current line used by return-to-current', () => {
    const f = fixture({ reduced: false }); f.view.anticipate(3); f.tick(20);
    f.view.returnToCurrent(); f.tick(400);
    assert.equal(f.viewport.scrollTop, 142); assert.deepEqual(f.seeks, []); f.view.dispose();
});

test('manual browsing, touch, reduced motion and pause block anticipation', () => {
    const f = fixture({ reduced: false }); f.wheel(); f.scroll(600);
    assert.equal(f.view.anticipate(3), false); f.tick(20); assert.equal(f.viewport.scrollTop, 600);
    f.view.returnToCurrent(); f.tick(400);
    f.event(f.viewport, 'touchstart', { touches: [{}] });
    assert.equal(f.view.anticipate(3), false);
    f.event(f.viewport, 'touchend', { touches: [] }); f.tick(400);
    f.state.reduced = true; assert.equal(f.view.anticipate(3), false);
    f.state.reduced = false; f.state.playing = false; f.view.syncPlayback();
    assert.equal(f.view.anticipate(3), false); f.view.dispose();
});

test('pausing or a forced seek cancels the anticipated line instead of following it later', () => {
    const f = fixture({ reduced: false }); f.view.anticipate(3); f.tick(20);
    f.state.playing = false; f.view.syncPlayback(); f.tick(400);
    assert.equal(f.viewport.scrollTop, 142); assert.equal(f.frames.size, 0);
    f.state.playing = true; f.view.syncPlayback(); f.view.anticipate(3); f.tick(20);
    f.view.setActive(8, true); f.tick(400);
    assert.equal(f.viewport.scrollTop, 502); assert.equal(f.frames.size, 0); f.view.dispose();
});

test('a wrap at the actual cue retargets early scrolling without a position jump', () => {
    const f = wrappingFixture({ reduced: false }); f.view.anticipate(1); f.tick(20);
    const position = f.viewport.scrollTop;
    f.heights[0] = 40; f.heights[1] = 64; f.view.setActive(1);
    assert.equal(f.viewport.scrollTop, position);
    f.tick(20); assert.ok(f.viewport.scrollTop > position);
    f.tick(400); assert.equal(f.viewport.scrollTop, f.lines[1].offsetTop + 32 - 90);
    f.view.dispose();
});

test('weight-driven original wraps settle with zoom and delayed resize does not restart following', () => {
    const f = wrappingFixture({ reduced: false, withVisuals: true });
    for (const [index, line] of f.lines.entries()) {
        Object.defineProperty(line.querySelector('.lyric-original'), 'offsetHeight', { get: () => f.heights[index] - 12 });
    }
    f.view.relayout(); f.tick(400);
    f.view.anticipate(1); f.tick(15);
    const before = f.viewport.scrollTop;
    f.heights[0] = 40; f.heights[1] = 64; f.view.setActive(1);
    assert.equal(f.viewport.scrollTop, before, 'reflow must not snap the current scroll position');
    assert.equal(f.lines[1].style['--lyric-anchor-y'], '26px');
    f.tick(400);
    const settled = f.viewport.scrollTop, writes = f.moves.length;
    assert.equal(settled, f.lines[1].offsetTop + 29 - 90);
    assert.equal(f.lines[1].querySelector('.lyric-visual').style.transform, 'scale(1)');
    assert.equal(f.frames.size, 0);
    f.resize(); f.flush(); f.tick(1000);
    assert.equal(f.viewport.scrollTop, settled); assert.equal(f.moves.length, writes);
    assert.equal(f.frames.size, 0); f.view.dispose();
});

test('reset, hidden pages and resize drop anticipation and use the actual current line', () => {
    const f = fixture({ reduced: false }); f.view.anticipate(3); f.tick(20);
    f.doc.hidden = true; f.event(f.doc, 'visibilitychange');
    f.doc.hidden = false; f.event(f.doc, 'visibilitychange'); f.flush();
    assert.equal(f.viewport.scrollTop, 142);
    f.view.anticipate(3); f.tick(20); f.event(f.environment, 'resize'); f.flush();
    assert.equal(f.viewport.scrollTop, 142);
    f.view.anticipate(3); f.tick(20); f.view.reset(); f.tick(1000);
    assert.equal(f.viewport.scrollTop, 0); assert.equal(f.frames.size, 0); f.view.dispose();
});
