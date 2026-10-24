import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaylistCovers, playlistCoverSrc } from '../src/playlist/covers.js';
import { FakeElement } from './helpers/host.mjs';

function fixture(t) {
    let time = 0, sequence = 0;
    const frames = new Map(), timers = new Map(), requests = [], loaded = new Set(), observers = [];
    const root = new FakeElement(), container = new FakeElement(), document = new FakeElement();
    root.classList.add('show');
    root.getBoundingClientRect = () => ({ top: 0, bottom: 400 });
    container.querySelectorAll = () => container.children.filter(img => img.dataset.src);
    const env = new FakeElement();
    Object.assign(env, {
        document, performance: { now: () => time },
        setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: time + delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
        cancelAnimationFrame(id) { frames.delete(id); },
        Image: class {
            set src(value) {
                this.url = value;
                if (!value) { this.cancelled = true; this.onerror?.(); return; }
                this.at = time;
                this.id = Number(new URL(value).pathname.match(/\d+/)?.[0]);
                requests.push(this);
            }
            succeed() { loaded.add(this.url); this.onload?.(); }
            fail() { this.onerror?.(); }
        },
        IntersectionObserver: class {
            constructor(callback, options) { this.callback = callback; this.options = options; observers.push(this); }
            observe() {}
            unobserve() {}
            disconnect() {}
        },
        ResizeObserver: class { observe() {} disconnect() {} }
    });
    const covers = createPlaylistCovers({ root, container }, env);
    covers.initialize();
    t.mock.method(Math, 'random', () => 0);
    t.after(() => covers.dispose());
    const images = [];
    function add(id = images.length, top = 10000) {
        const img = new FakeElement();
        img.top = top;
        img.getBoundingClientRect = () => ({ top: img.top, bottom: img.top + 30 });
        Object.defineProperty(img, 'src', {
            set(value) { this.source = value; this.complete = loaded.has(value) && !this.holdLoad; this.naturalWidth = this.complete ? 80 : 0; },
            get() { return this.source || ''; }
        });
        covers.bind(img, `https://cover.invalid/${id}.jpg`);
        images.push(img);
        container.appendChild(img);
        return img;
    }
    function enter(img, top = 30) {
        img.top = top;
        observers[0].callback([{ target: img, isIntersecting: true }]);
    }
    function leave(img) {
        img.top = -1000;
        observers[0].callback([{ target: img, isIntersecting: false }]);
    }
    function flush() {
        let loops = 0;
        while (frames.size) {
            assert.ok(++loops < 30, 'frame scheduler must settle');
            const tasks = [...frames.values()];
            frames.clear();
            tasks.forEach(callback => callback(time));
        }
    }
    function tick(ms) {
        const end = time + ms;
        for (;;) {
            const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            time = next[1].at;
            timers.delete(next[0]);
            next[1].callback();
            flush();
        }
        time = end;
        flush();
    }
    return { covers, env, root, container, frames, timers, requests, images, observers, add, enter, leave, flush, tick };
}

test('cover URLs replace size parameters without losing unrelated parameters', () => {
    assert.equal(playlistCoverSrc('http://cover.invalid/a?param=500y500&v=2'), 'https://cover.invalid/a?param=80y80&v=2');
    assert.equal(playlistCoverSrc('data:image/png;base64,abc'), 'data:image/png;base64,abc');
    assert.equal(playlistCoverSrc('blob:https://player.invalid/id'), 'blob:https://player.invalid/id');
    for (const value of ['', 'bad-url', 'javascript:alert(1)']) assert.equal(playlistCoverSrc(value), '');
});

test('a 1177-row playlist does not create image requests for offscreen rows', t => {
    const f = fixture(t);
    for (let i = 0; i < 1177; i++) f.add(i);
    f.flush();
    assert.equal(f.requests.length, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.observers[0].options.rootMargin, '300px 0px');
});

test('visible images use four slots while nearby preloads use at most two', t => {
    const f = fixture(t);
    for (let i = 0; i < 8; i++) f.enter(f.add(i), i < 4 ? 40 * i : 420 + (i - 4) * 40);
    f.flush();
    assert.deepEqual(f.requests.map(job => job.id), [0, 1, 2, 3]);
    for (const job of [...f.requests]) job.succeed();
    f.flush();
    assert.deepEqual(f.requests.slice(4).map(job => job.id), [4, 5]);
    assert.equal(f.requests[4].fetchPriority, 'low');
});

test('fast scrolling discards the old pending queue and gives free slots to the final viewport', t => {
    const f = fixture(t);
    for (let i = 0; i < 24; i++) f.add(i);
    for (let i = 0; i < 4; i++) f.enter(f.images[i], i * 40);
    f.flush();
    for (let i = 4; i < 20; i++) f.enter(f.images[i], 30);
    for (let i = 0; i < 20; i++) f.images[i].top = -1000;
    for (let i = 20; i < 24; i++) f.enter(f.images[i], (i - 20) * 40);
    f.root.dispatchEvent({ type: 'scroll' });
    f.flush();
    f.requests[0].succeed();
    f.flush();
    assert.equal(f.requests[4].id, 20);
    assert.equal(f.requests.length, 5);
});

test('blocked visible images reclaim only two old slow requests after the grace period', t => {
    const f = fixture(t);
    for (let i = 0; i < 8; i++) f.enter(f.add(i), i * 35);
    f.flush();
    const staleLoad = f.requests[0].onload;
    for (let i = 0; i < 4; i++) f.leave(f.images[i]);
    f.root.dispatchEvent({ type: 'scroll' });
    f.flush();
    f.tick(499);
    assert.equal(f.requests.length, 4);
    f.tick(1);
    assert.equal(f.requests.filter(job => job.cancelled).length, 2);
    assert.deepEqual(f.requests.slice(4).map(job => job.id), [4, 5]);
    staleLoad();
    f.flush();
    assert.equal(f.images[0].dataset.coverLoaded, undefined);
    f.tick(1000);
    assert.equal(f.requests.length, 6);
    f.enter(f.images[0]);
    f.leave(f.images[6]); f.leave(f.images[7]);
    f.requests[4].succeed();
    f.flush();
    assert.equal(f.requests.at(-1).id, 0, 'cancelled image is eligible again without failure cooldown');
});

test('visible loading is immediate; nearby loading waits until scrolling has settled', t => {
    const f = fixture(t);
    f.root.dispatchEvent({ type: 'scroll' });
    f.enter(f.add(0), 40);
    f.enter(f.add(1), 430);
    f.flush();
    assert.deepEqual(f.requests.map(job => job.id), [0]);
    f.tick(119);
    assert.equal(f.requests.length, 1);
    f.tick(1);
    assert.deepEqual(f.requests.map(job => job.id), [0, 1]);
});

test('retry deadlines do not wake or retry offscreen images', t => {
    const f = fixture(t), img = f.add();
    f.enter(img); f.flush(); f.requests[0].fail(); f.flush();
    f.leave(img); f.flush(); f.tick(1000);
    assert.equal(f.requests.length, 1);
    assert.equal(f.timers.size, 0);
    f.enter(img); f.flush();
    assert.equal(f.requests.length, 2);
});

test('timeout releases a slot once, stops its request, and retains two retries plus cooldown', t => {
    const f = fixture(t), img = f.add();
    f.enter(img); f.flush();
    const staleError = f.requests[0].onerror;
    f.tick(8000);
    assert.equal(f.requests[0].cancelled, true);
    staleError();
    f.tick(400);
    assert.equal(f.requests.length, 2);
    f.requests[1].fail(); f.flush(); f.tick(1200);
    assert.equal(f.requests.length, 3);
    f.requests[2].fail(); f.flush(); f.tick(29999);
    assert.equal(f.requests.length, 3);
    f.tick(1);
    assert.equal(f.requests.length, 4);
});

test('shared album covers use one task and survive a list rebuild in the success cache', t => {
    const f = fixture(t), first = f.add(1), second = f.add(1);
    f.enter(first); f.enter(second, 80); f.flush();
    assert.equal(f.requests.length, 1);
    f.requests[0].succeed(); f.flush();
    assert.equal(first.dataset.coverLoaded, '1');
    assert.equal(second.dataset.coverLoaded, '1');
    f.covers.reset();
    const third = f.add(1);
    f.enter(third); f.flush();
    assert.equal(f.requests.length, 1);
    assert.equal(third.dataset.coverLoaded, '1');
});

test('closing suspends work; an in-flight completion warms cache without filling hidden rows', t => {
    const f = fixture(t), img = f.add();
    f.enter(img); f.flush();
    f.root.classList.remove('show'); f.covers.suspend();
    f.requests[0].succeed(); f.flush();
    assert.equal(img.dataset.coverLoaded, undefined);
    assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 0);
    f.root.classList.add('show'); f.covers.observe(); f.enter(img); f.flush();
    assert.equal(img.dataset.coverLoaded, '1');
    assert.equal(f.requests.length, 1);
});

test('reset cancels obsolete jobs and late results cannot paint the replacement playlist', t => {
    const f = fixture(t), old = f.add();
    f.enter(old); f.flush();
    const lateLoad = f.requests[0].onload, lateError = f.requests[0].onerror;
    f.covers.reset();
    const current = f.add(5);
    f.enter(current); f.flush();
    lateLoad(); lateError();
    f.requests[1].succeed(); f.flush();
    assert.equal(old.dataset.coverLoaded, undefined);
    assert.equal(current.dataset.coverLoaded, '1');
    assert.equal(f.requests[0].cancelled, true);
});

test('metadata changes to offscreen rows do not bypass the viewport queue', t => {
    const f = fixture(t), img = f.add();
    f.covers.bind(img, 'https://cover.invalid/20.jpg');
    f.flush();
    assert.equal(f.requests.length, 0);
    f.enter(img); f.flush();
    assert.equal(f.requests[0].id, 20);
});

test('success cache evicts least recently used entries after 300 covers', t => {
    const f = fixture(t);
    for (let i = 0; i < 301; i++) {
        const img = f.add(i); f.enter(img); f.flush();
        f.requests.at(-1).succeed(); f.flush(); f.tick(1);
    }
    const hit = f.add(300); f.enter(hit); f.flush();
    assert.equal(f.requests.length, 301);
    const miss = f.add(0); f.enter(miss); f.flush();
    assert.equal(f.requests.length, 302);
});

test('full slots cause no 80ms polling; completed idle lists have no timers or frames', t => {
    const f = fixture(t);
    for (let i = 0; i < 8; i++) f.enter(f.add(i), i * 35);
    f.flush();
    assert.equal(f.timers.size, 4, 'only request timeouts remain while slots are full');
    f.tick(1000);
    assert.equal(f.frames.size, 0);
    for (const job of [...f.requests]) job.succeed(); f.flush();
    for (const job of f.requests.slice(4)) job.succeed(); f.flush();
    assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 0);
});

test('initialization is idempotent and disposal removes listeners and pending work', t => {
    const f = fixture(t);
    f.covers.initialize();
    assert.equal(f.root.listeners.get('scroll').size, 1);
    assert.equal(f.env.document.listeners.get('visibilitychange').size, 1);
    f.enter(f.add()); f.flush(); f.covers.dispose();
    assert.equal(f.requests[0].cancelled, true);
    assert.equal(f.root.listeners.get('scroll').size, 0);
    assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 0);
});

test('a display-stage error restores observation and retries instead of leaving a permanent placeholder', t => {
    const f = fixture(t), img = f.add();
    img.holdLoad = true;
    f.enter(img); f.flush(); f.requests[0].succeed(); f.flush();
    assert.equal(img.dataset.coverLoaded, undefined);
    img.onerror(); f.flush();
    assert.ok(img.dataset.src);
    f.enter(img); f.flush(); f.tick(400);
    assert.equal(f.requests.length, 2);
    img.holdLoad = false;
    f.requests[1].succeed(); f.flush();
    assert.equal(img.dataset.coverLoaded, '1');
});

test('late display callbacks cannot clear the replacement image handlers', t => {
    const f = fixture(t), img = f.add();
    img.holdLoad = true;
    f.enter(img); f.flush(); f.requests[0].succeed(); f.flush();
    const staleError = img.onerror, staleLoad = img.onload;
    f.covers.bind(img, 'https://cover.invalid/9.jpg');
    f.enter(img); f.flush(); f.requests[1].succeed(); f.flush();
    const currentLoad = img.onload;
    staleError(); staleLoad();
    assert.equal(img.onload, currentLoad);
    assert.equal(img.dataset.coverLoaded, undefined);
    img.onload();
    assert.equal(img.dataset.coverLoaded, '1');
});

test('reversing direction inside the grace period does not cancel and redownload the original images', t => {
    const f = fixture(t);
    for (let i = 0; i < 8; i++) f.enter(f.add(i), i * 35);
    f.flush();
    for (let i = 0; i < 4; i++) f.leave(f.images[i]);
    f.root.dispatchEvent({ type: 'scroll' }); f.flush(); f.tick(300);
    for (let i = 4; i < 8; i++) f.leave(f.images[i]);
    for (let i = 0; i < 4; i++) f.enter(f.images[i], i * 40);
    f.root.dispatchEvent({ type: 'scroll' }); f.flush(); f.tick(500);
    assert.equal(f.requests.length, 4);
    assert.equal(f.requests.some(job => job.cancelled), false);
});

test('hidden tabs stop retry work and resume only the current viewport', t => {
    const f = fixture(t), img = f.add();
    f.enter(img); f.flush(); f.requests[0].fail(); f.flush();
    f.env.document.hidden = true;
    f.env.document.dispatchEvent({ type: 'visibilitychange' }); f.tick(1000);
    assert.equal(f.requests.length, 1);
    assert.equal(f.timers.size, 0);
    f.env.document.hidden = false;
    f.env.document.dispatchEvent({ type: 'visibilitychange' }); f.enter(img); f.flush();
    assert.equal(f.requests.length, 2);
});
