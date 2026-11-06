import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPlaylistFade } from '../src/playlist/fade.js';
import { FakeElement } from './helpers/host.mjs';

function fixture(t, supported = true) {
    let sequence = 0, time = 0, rangeText = null, rangeCreations = 0, fontsReady;
    const frames = new Map(), timers = new Map(), observers = [], resizes = [];
    const root = new FakeElement(), container = new FakeElement(), document = new FakeElement(), fonts = new FakeElement();
    root.classList.add('show'); root.scrollTop = 0; root.clientWidth = 320; root.clientHeight = 400;
    root.getBoundingClientRect = () => ({ top: 0, bottom: root.clientHeight, height: root.clientHeight });
    root.querySelector = () => null;
    container.clientWidth = 296;
    container.style.getPropertyValue = key => container.style[key] || '';
    const style = { paddingLeft: '12px', paddingRight: '12px', fontSize: '16px', fontFamily: 'Arial', getPropertyValue: key => root.style[key] || '' };
    fonts.ready = { then(callback) { fontsReady = callback; } };
    document.fonts = fonts;
    document.createRange = () => {
        rangeCreations++;
        return { selectNodeContents(text) { rangeText = text; }, getBoundingClientRect: () => ({ width: rangeText.inkWidth }) };
    };
    const allRows = () => container.children.flatMap(item => item.classList.contains('pl-item') ? [item] : item.children);
    const texts = () => allRows().flatMap(row => row.children);
    container.querySelectorAll = selector => selector === '.pl-text-fade' ? texts().filter(text => text.classList.contains('pl-text-fade')) : [];
    const env = new FakeElement();
    Object.assign(env, {
        document, CSS: { supports: () => supported }, getComputedStyle: () => style,
        requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
        cancelAnimationFrame(id) { frames.delete(id); },
        setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: time + delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        IntersectionObserver: class {
            constructor(callback, options) { this.callback = callback; this.options = options; this.watched = new Set(); observers.push(this); }
            observe(item) { this.watched.add(item); }
            unobserve(item) { this.watched.delete(item); }
            disconnect() { this.watched.clear(); }
        },
        ResizeObserver: class {
            constructor(callback) { this.callback = callback; this.watched = new Set(); resizes.push(this); }
            observe(item) { this.watched.add(item); }
            disconnect() { this.watched.clear(); }
        }
    });
    function text(name) {
        const element = new FakeElement();
        element.classList.add(name);
        element.clientWidth = 80; element.scrollWidth = 180; element.inkWidth = 180; element.boxWidth = 80;
        element.getBoundingClientRect = () => ({ width: element.boxWidth });
        return element;
    }
    function row(top) {
        const element = new FakeElement();
        element.classList.add('pl-item'); element.top = top;
        element.getBoundingClientRect = () => ({ top: element.top - root.scrollTop, bottom: element.top + 50 - root.scrollTop });
        element.matches = () => true;
        element.append(text('pl-song-name'), text('pl-song-artists'));
        element.querySelectorAll = selector => selector === '.pl-text-fade' ? element.children.filter(t => t.classList.contains('pl-text-fade')) : element.children;
        return element;
    }
    function add(top = 0) { const item = row(top); container.appendChild(item); return item; }
    function group(count, top = 0) {
        const element = new FakeElement();
        element.classList.add('pl-row-group'); element.matches = () => true;
        for (let i = 0; i < count; i++) element.appendChild(row(top + i * 55));
        element.getBoundingClientRect = () => {
            const height = element.children.filter(row => !row.hidden).length * 55;
            return { top: top - root.scrollTop, bottom: top + height - root.scrollTop, height };
        };
        container.appendChild(element);
        return element;
    }
    function flush() {
        let loops = 0;
        while (frames.size) {
            assert.ok(++loops < 20, 'scheduler must settle');
            const tasks = [...frames.values()]; frames.clear(); tasks.forEach(callback => callback(time));
        }
    }
    function tick(ms) {
        time += ms;
        for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.callback(); }
        flush();
    }
    const fade = createPlaylistFade({ root, containers: [container] }, env);
    fade.initialize();
    t.after(() => fade.dispose());
    const observe = (...items) => { fade.observe(); observers[0].callback(items.map(target => ({ target, isIntersecting: true }))); };
    const scroll = top => { root.scrollTop = top; root.dispatchEvent({ type: 'scroll' }); };
    return { fade, env, root, container, document, fonts, style, frames, timers, observers, resizes,
        add, group, flush, tick, observe, scroll, fontsReady: () => fontsReady(), rangeCreations: () => rangeCreations };
}

test('unsupported masks keep the native fallback without ranges or scheduled work', t => {
    const f = fixture(t, false);
    f.add(); f.fade.observe(); f.scroll(20); f.fade.refresh(); f.flush();
    assert.equal(f.rangeCreations(), 0); assert.equal(f.observers.length, 0);
    assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.fade.debug().textReads, 0);
});

test('groups are observed once and offscreen text is not measured eagerly', t => {
    const f = fixture(t), a = f.group(64, 10000), b = f.group(64, 20000);
    f.fade.observe(); f.fade.observe(); f.flush();
    assert.deepEqual([...f.observers[0].watched], [a, b]);
    assert.equal(f.observers[0].options.rootMargin, '165px 0px');
    assert.equal(f.resizes[0].watched.size, 2);
    assert.equal(f.fade.debug().textReads, 0); assert.equal(f.fade.debug().textObservers, 0);
    assert.equal(f.frames.size, 0);
});

test('scrolling prepares fresh text on the next frame while its 100ms timer is pending', t => {
    const f = fixture(t), a = f.add(1000);
    f.observe(a); f.flush();
    const before = f.fade.debug().updates;
    f.scroll(1000); f.scroll(1010); f.scroll(1020);
    assert.equal(f.frames.size, 1); assert.equal(f.timers.size, 1);
    f.flush();
    assert.equal(f.fade.debug().updates, before + 1);
    assert.ok(a.children.every(text => text.classList.contains('pl-text-fade')));
    assert.equal(f.timers.size, 1);
    const reads = f.fade.debug().textReads;
    f.tick(100);
    assert.equal(f.fade.debug().textReads, reads); assert.equal(f.timers.size, 0);
});

test('nearby preparation covers only viewport plus three rows in a 64-row group', t => {
    const f = fixture(t), a = f.group(64);
    f.observe(a); f.flush();
    assert.equal(f.fade.debug().textReads, 22);
    assert.ok(a.children[10].children[0].classList.contains('pl-text-fade'));
    assert.equal(a.children[11].children[0].classList.contains('pl-text-fade'), false);
});

test('fractional ink overflow is measured while fitting and hidden text stays unmasked', t => {
    const f = fixture(t), a = f.add();
    const [name, artist] = a.children;
    Object.assign(name, { clientWidth: 100, scrollWidth: 100, boxWidth: 100.5, inkWidth: 100.53 });
    Object.assign(artist, { clientWidth: 100, scrollWidth: 100, boxWidth: 100.5, inkWidth: 100.51 });
    f.observe(a); f.flush();
    assert.equal(name.classList.contains('pl-text-fade'), true);
    assert.equal(artist.classList.contains('pl-text-fade'), false);
    name.hidden = true; f.fade.invalidate(a); f.flush();
    assert.equal(name.classList.contains('pl-text-fade'), false);
});

test('leaving the viewport keeps finished masks and replay does not measure again', t => {
    const f = fixture(t), a = f.add(); f.observe(a); f.flush();
    const before = f.fade.debug();
    f.observers[0].callback([{ target: a, isIntersecting: false }]); f.flush();
    assert.ok(a.children[0].classList.contains('pl-text-fade'));
    f.observe(a); f.flush();
    assert.equal(f.fade.debug().textReads, before.textReads);
    assert.equal(f.fade.debug().writes, before.writes);
});

test('dirty rows refresh changed titles without remeasuring other cached rows', t => {
    const f = fixture(t), a = f.add(), b = f.add(55); f.observe(a, b); f.flush();
    const before = f.fade.debug().textReads;
    a.children[0].scrollWidth = 20; a.children[0].inkWidth = 20;
    f.fade.invalidate(a); f.flush();
    assert.equal(a.children[0].classList.contains('pl-text-fade'), false);
    assert.equal(b.children[0].classList.contains('pl-text-fade'), true);
    assert.equal(f.fade.debug().textReads - before, 2);
});

test('font, column width and index digit changes invalidate cached geometry', t => {
    const f = fixture(t), a = f.add(); f.observe(a); f.flush();
    let before = f.fade.debug().textReads;
    f.fontsReady(); f.flush(); assert.equal(f.fade.debug().textReads - before, 2);
    before = f.fade.debug().textReads;
    f.root.clientWidth = 400; f.resizes[0].callback(); f.flush(); assert.equal(f.fade.debug().textReads - before, 2);
    before = f.fade.debug().textReads;
    f.container.style['--playlist-index-digits'] = '4'; f.fade.refresh(); f.flush(); assert.equal(f.fade.debug().textReads - before, 2);
    before = f.fade.debug().textReads;
    f.fonts.dispatchEvent({ type: 'loadingdone' }); f.flush(); assert.equal(f.fade.debug().textReads - before, 2);
});

test('hidden groups are skipped until they become visible again', t => {
    const f = fixture(t), a = f.group(64); a.hidden = true;
    f.observe(a); f.flush(); assert.equal(f.fade.debug().textReads, 0);
    a.hidden = false; f.fade.refresh(); f.flush(); assert.equal(f.fade.debug().textReads, 22);
});

test('suspending cancels frames, timers and observers, and reopening reuses measurements', t => {
    const f = fixture(t), a = f.add(); f.observe(a); f.flush();
    const reads = f.fade.debug().textReads;
    f.scroll(10); f.fade.suspend(); f.tick(200);
    assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.observers[0].watched.size, 0); assert.equal(f.resizes[0].watched.size, 0);
    f.observe(a); f.flush(); assert.equal(f.fade.debug().textReads, reads);
    f.document.hidden = true; f.document.dispatchEvent({ type: 'visibilitychange' });
    assert.equal(f.fade.debug().observed, 0);
    f.document.hidden = false; f.document.dispatchEvent({ type: 'visibilitychange' });
    f.observers[0].callback([{ target: a, isIntersecting: true }]); f.flush();
    assert.equal(f.fade.debug().textReads, reads);
});

test('reset releases old observed groups and new rows get fresh measurements', t => {
    const f = fixture(t), a = f.group(64); f.observe(a); f.flush();
    f.fade.reset(); a.isConnected = false; f.container.children = [];
    const b = f.add(); f.observe(b); const before = f.fade.debug().textReads; f.flush();
    assert.deepEqual([...f.observers[0].watched], [b]);
    assert.equal(f.fade.debug().textReads - before, 2);
});

test('initialization is idempotent and late font readiness cannot revive disposed work', t => {
    const f = fixture(t), a = f.add(); f.observe(a); f.flush();
    f.fade.initialize(); assert.equal(f.root.listeners.get('scroll').size, 1);
    f.fade.dispose(); f.fontsReady(); f.fade.initialize(); f.fade.observe(); f.flush();
    assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.root.listeners.get('scroll').size, 0);
    assert.equal(a.children[0].classList.contains('pl-text-fade'), false);
});

test('mask styling preserves ellipsis fallbacks and disables masks in forced colors', () => {
    const css = readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
    assert.match(css, /@supports\s*\(mask-image:[\s\S]*?text-overflow:\s*clip/);
    assert.match(css, /calc\(100% - 14px\)/);
    assert.match(css, /@media\s*\(forced-colors:\s*active\)[\s\S]*?text-overflow:\s*ellipsis[\s\S]*?\.pl-song-name\.pl-text-fade[\s\S]*?mask-image:\s*none/);
});
