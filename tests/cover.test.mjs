import test from 'node:test';
import assert from 'node:assert/strict';
import { createCovers, COVER_PENDING_TIMEOUT_MS, COVER_TRANSITION_MS, COVER_HOLD_TIMEOUT_MS } from '../src/ui/cover.js';
import { createHost, FakeElement } from './helpers/host.mjs';

function fixture(t) {
    const saved = { setTimeout, clearTimeout, location: globalThis.location, window: globalThis.window, document: globalThis.document };
    let sequence = 0, assignments = 0;
    const timers = new Map(), updates = [], events = new Map(), revoked = [], consumers = [], animationRecords = [];
    const { host } = createHost();
    const media = new FakeElement(); media.matches = false;
    host.matchMedia = () => media; host.CSS = { supports: () => true };
    globalThis.document = host.document;
    globalThis.setTimeout = (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; };
    globalThis.clearTimeout = id => timers.delete(id);
    globalThis.location = { href: 'https://player.fixture/' };
    globalThis.window = Object.assign(host, { devicePixelRatio: 1, addEventListener: (name, callback) => events.set(name, callback) });
    t.mock.method(URL, 'revokeObjectURL', url => { revoked.push(url); consumers.push('revoke'); });
    function makeImage() {
        const image = new FakeElement(); image.tagName = 'IMG'; image.complete = false;
        image.naturalWidth = 0; image.clientWidth = image.clientHeight = 280;
        Object.defineProperty(image, 'src', {
            get: () => image.getAttribute('src') || '',
            set(value) { image.setAttribute('src', value); assignments++; image.complete = false; image.naturalWidth = 0; }
        });
        image.animate = (frames, options) => {
            let resolve, reject;
            const animation = { finished: new Promise((yes, no) => { resolve = yes; reject = no; }),
                cancel() { this.cancelled = true; reject(new Error('cancelled')); }, finish: () => resolve(), frames, options, image };
            animationRecords.push(animation); return animation;
        };
        return image;
    }
    host.document.createElement = tag => tag === 'img' ? makeImage() : new FakeElement();
    const image = makeImage(), group = new FakeElement(), coverWrap = new FakeElement();
    const append = group.appendChild.bind(group);
    group.appendChild = child => { group.children = group.children.filter(item => item !== child); return append(child); };
    group.appendChild(image);
    const el = { img: image, coverWrap, coverImages: group };
    const queue = { playlist: [{}], curIdx: 0 };
    const covers = createCovers({ dom: { el }, queue,
        render: { updateTheme: value => updates.push(value ? value.src : null) },
        content: { updateMusicMiniPlayer() { consumers.push('mini'); } },
        metadata: { updateMediaSession() { consumers.push('media'); } }
    });
    t.after(() => {
        covers.setMainCover();
        globalThis.setTimeout = saved.setTimeout; globalThis.clearTimeout = saved.clearTimeout;
        for (const key of ['location', 'window', 'document']) {
            if (saved[key] === undefined) delete globalThis[key]; else globalThis[key] = saved[key];
        }
    });
    return { covers, queue, get image() { return el.img; }, group, timers, updates, revoked, consumers, events, media, host, animationRecords,
        classes: { has: name => coverWrap.classList.contains(name) }, assignments: () => assignments,
        load() { el.img.complete = true; el.img.naturalWidth = 512; el.img.onload?.(); },
        fire(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } }
    };
}

test('pending metadata preserves the previous background; explicit absence resets it immediately', t => {
    const f = fixture(t);
    f.covers.setMainCover('https://p4.music.126.net/one.jpg'); f.load();
    f.covers.setMainCover('', { pending: true });
    assert.equal(f.updates.length, 1); assert.equal(f.image.src, '');
    assert.equal(f.classes.has('has-cover'), true);
    f.covers.setMainCover();
    assert.deepEqual(f.updates.slice(-1), [null]); assert.equal(f.timers.size, 0);
});

test('the disc hides only after a current cover loads and returns on absence or failure', t => {
    const f = fixture(t);
    const hasCover = () => f.classes.has('has-cover');
    f.covers.setMainCover('https://fixture/one.jpg');
    assert.equal(hasCover(), false);
    f.load();
    assert.equal(hasCover(), true);
    f.covers.setMainCover('https://fixture/one.jpg');
    assert.equal(hasCover(), true);
    f.covers.setMainCover('', { pending: true });
    assert.equal(hasCover(), true); f.fire(COVER_HOLD_TIMEOUT_MS); assert.equal(hasCover(), false);
    f.covers.setMainCover('https://fixture/two.jpg'); f.load();
    assert.equal(hasCover(), true);
    f.covers.setMainCover('https://fixture/broken.jpg');
    assert.equal(hasCover(), true);
    f.image.onerror();
    assert.equal(hasCover(), false);
    f.covers.setMainCover('https://fixture/late.jpg');
    f.fire(COVER_PENDING_TIMEOUT_MS);
    assert.equal(hasCover(), false);
    f.load();
    assert.equal(hasCover(), true);
    f.covers.setMainCover();
    assert.equal(hasCover(), false);
});

test('same loaded URL does not reassign the image and still invokes the new track callback', t => {
    const f = fixture(t); let first = 0, second = 0;
    f.covers.setMainCover('https://p4.music.126.net/one.jpg', { onLoad: () => first++ }); f.load();
    f.covers.setMainCover('https://p4.music.126.net/one.jpg', { onLoad: () => second++ });
    assert.equal(f.assignments(), 1); assert.equal(first, 1); assert.equal(second, 1); assert.equal(f.timers.size, 0);
});

test('old loads, errors and timeout callbacks cannot clear or repaint the next track', t => {
    const f = fixture(t);
    f.covers.setMainCover('https://fixture/old.jpg');
    const loaded = f.image.onload, failed = f.image.onerror, expired = [...f.timers.values()][0].callback;
    f.covers.setMainCover('https://fixture/current.jpg'); f.load();
    loaded(); failed(); expired();
    assert.deepEqual(f.updates, ['https://fixture/current.jpg']);
    assert.equal(f.image.src, 'https://fixture/current.jpg'); assert.equal(f.timers.size, 0);
    assert.equal(f.classes.has('has-cover'), true);
});

test('missing, broken and indefinitely pending images fall back, but a current late load is accepted', t => {
    const f = fixture(t);
    f.covers.setMainCover('https://fixture/slow.jpg');
    f.fire(COVER_PENDING_TIMEOUT_MS); assert.deepEqual(f.updates, [null]);
    f.load(); assert.deepEqual(f.updates, [null, 'https://fixture/slow.jpg']);
    f.covers.setMainCover('https://fixture/broken.jpg'); f.image.onerror();
    assert.equal(f.image.src, ''); assert.equal(f.updates.at(-1), null); assert.equal(f.timers.size, 0);
    f.covers.setMainCover('', { pending: true }); f.fire(COVER_PENDING_TIMEOUT_MS);
    assert.equal(f.updates.at(-1), null); assert.equal(f.timers.size, 0);
});

test('a replaced queue cannot receive the old image or a resize retry even before it sets a new cover', t => {
    const f = fixture(t);
    f.covers.setMainCover('https://p4.music.126.net/old.jpg');
    const failed = f.image.onerror;
    f.queue.playlist = [{}];
    f.load(); failed(); f.fire(COVER_PENDING_TIMEOUT_MS);
    assert.deepEqual(f.updates, []);
    f.covers.initialize(); f.image.clientWidth = 800; f.events.get('resize')(); f.fire(180);
    assert.equal(f.assignments(), 1);
});

test('a thumbnail resize keeps the background until the new image loads and revokes old blobs after consumers move', t => {
    const f = fixture(t);
    f.covers.setMainCover('blob:old', { objectUrl: true, mimeType: 'image/jpeg' }); f.load();
    f.consumers.length = 0;
    f.covers.setMainCover('https://p4.music.126.net/one.jpg'); f.load();
    f.fire(COVER_TRANSITION_MS + 100);
    assert.deepEqual(f.revoked, ['blob:old']);
    assert.ok(f.consumers.indexOf('mini') < f.consumers.indexOf('revoke'));
    f.covers.initialize(); f.image.clientWidth = 800; f.events.get('resize')();
    const before = f.updates.length;
    f.fire(180);
    assert.equal(f.updates.length, before);
    assert.match(f.image.src, /param=1024y1024/);
    f.load(); assert.equal(f.updates.length, before + 1);
});

test('decoded images crossfade for 400ms, keep only two elements, and release outgoing data afterwards', async t => {
    const f = fixture(t); f.covers.setMainCover('blob:first', { objectUrl: true }); f.load();
    const first = f.image; f.covers.setMainCover('blob:second', { objectUrl: true });
    assert.equal(first.getAttribute('src'), 'blob:first'); assert.equal(f.revoked.length, 0);
    assert.equal(f.image.classList.contains('cover-pending'), true);
    f.load();
    assert.equal(f.animationRecords.length, 2); assert.equal(f.group.classList.contains('crossfading'), true);
    assert.ok(f.animationRecords.every(animation => animation.options.duration === 400));
    assert.equal(f.group.children.length, 2); assert.equal(f.revoked.length, 0);
    for (const animation of f.animationRecords) animation.finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.group.classList.contains('crossfading'), false); assert.equal(first.getAttribute('src'), null);
    assert.deepEqual(f.revoked, ['blob:first']); assert.equal(f.image.style.opacity, 1);
});

test('loading waits for decode, and late decode completion cannot replace a newer song', async t => {
    const f = fixture(t); f.covers.setMainCover('https://fixture/one.jpg'); f.load();
    f.covers.setMainCover('https://fixture/two.jpg');
    let resolveDecode; f.image.decode = () => new Promise(resolve => { resolveDecode = resolve; });
    f.load(); assert.equal(f.updates.length, 1); assert.equal(f.image.classList.contains('cover-pending'), true);
    f.covers.setMainCover('https://fixture/three.jpg'); f.image.decode = undefined; f.load();
    resolveDecode(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.updates, ['https://fixture/one.jpg', 'https://fixture/three.jpg']);
    assert.equal(f.image.src, 'https://fixture/three.jpg'); assert.equal(f.group.children.length, 2);
});

test('rapid changes merge into the latest image without accumulating images, blobs or timers', t => {
    const f = fixture(t); f.covers.setMainCover('blob:0', { objectUrl: true }); f.load();
    for (let i = 1; i <= 30; i++) { f.covers.setMainCover(`blob:${i}`, { objectUrl: true }); f.load(); }
    assert.equal(f.group.children.length, 2); assert.equal(f.image.src, 'blob:30');
    assert.ok(f.timers.size <= 1); f.fire(COVER_TRANSITION_MS + 100);
    assert.equal(f.revoked.length, 30); assert.equal(f.timers.size, 0);
    assert.equal(f.animationRecords.filter(animation => !animation.cancelled).length, 0);
});

test('same artwork and resize upgrades never restart crossfade', t => {
    const f = fixture(t); f.covers.initialize(); f.covers.setMainCover('https://p4.music.126.net/one.jpg'); f.load();
    f.queue.playlist.push({}); f.queue.curIdx = 1;
    f.covers.setMainCover('https://p4.music.126.net/one.jpg');
    assert.equal(f.assignments(), 1); assert.equal(f.animationRecords.length, 0);
    f.image.clientWidth = 1000; f.events.get('resize')(); f.fire(180); f.load();
    assert.match(f.image.src, /1024y1024/); assert.equal(f.animationRecords.length, 0);
});

test('a duplicate request for the incoming artwork keeps its in-flight fade instead of snapping to the end', t => {
    const f = fixture(t); f.covers.setMainCover('https://fixture/one.jpg'); f.load();
    f.covers.setMainCover('https://fixture/two.jpg'); f.load();
    let loaded = 0;
    f.queue.playlist.push({}); f.queue.curIdx = 1;
    f.covers.setMainCover('https://fixture/two.jpg', { onLoad: () => loaded++ });
    assert.equal(f.assignments(), 2); assert.equal(loaded, 1);
    assert.equal(f.group.classList.contains('crossfading'), true);
    assert.equal(f.animationRecords.length, 2); assert.ok(f.animationRecords.every(animation => !animation.cancelled));
    f.fire(COVER_TRANSITION_MS + 100); assert.equal(f.group.classList.contains('crossfading'), false);
});

test('hidden pages, reduced motion and unsupported blend modes replace directly', t => {
    const f = fixture(t); f.covers.initialize(); f.covers.setMainCover('https://fixture/one.jpg'); f.load();
    for (const kind of ['hidden', 'reduced', 'unsupported']) {
        f.host.document.hidden = kind === 'hidden'; f.media.matches = kind === 'reduced';
        f.host.CSS.supports = () => kind !== 'unsupported';
        f.covers.setMainCover(`https://fixture/${kind}.jpg`); f.load();
        assert.equal(f.animationRecords.length, 0); assert.equal(f.group.classList.contains('crossfading'), false);
    }
});

test('hiding during crossfade settles immediately and releases the old blob', t => {
    const f = fixture(t); f.covers.initialize(); f.covers.setMainCover('blob:one', { objectUrl: true }); f.load();
    f.covers.setMainCover('blob:two', { objectUrl: true }); f.load();
    f.host.document.hidden = true; f.host.document.dispatchEvent({ type: 'visibilitychange' });
    assert.deepEqual(f.revoked, ['blob:one']); assert.equal(f.group.classList.contains('crossfading'), false);
    assert.equal(f.timers.size, 0);
});

test('a superseded pending Blob is released once but the active and incoming Blobs stay alive', t => {
    const f = fixture(t); f.covers.setMainCover('blob:one', { objectUrl: true }); f.load();
    f.covers.setMainCover('blob:two', { objectUrl: true });
    f.covers.setMainCover('blob:three', { objectUrl: true });
    assert.deepEqual(f.revoked, ['blob:two']);
    f.load(); assert.deepEqual(f.revoked, ['blob:two']);
    f.fire(COVER_TRANSITION_MS + 100);
    assert.deepEqual(f.revoked, ['blob:two', 'blob:one']);
    assert.equal(f.image.src, 'blob:three');
});

test('enabling reduced motion settles an active transition without leaving an animation timer', t => {
    const f = fixture(t); f.covers.initialize(); f.covers.setMainCover('https://fixture/one.jpg'); f.load();
    f.covers.setMainCover('https://fixture/two.jpg'); f.load();
    f.media.matches = true; f.media.dispatchEvent({ type: 'change' });
    assert.equal(f.group.classList.contains('crossfading'), false); assert.equal(f.timers.size, 0);
    assert.equal(f.group.children.filter(image => image.getAttribute('src')).length, 1);
});

test('a rejected native animation falls back to the ready image without an unhandled rejection', async t => {
    const f = fixture(t); f.covers.setMainCover('https://fixture/one.jpg'); f.load();
    f.covers.setMainCover('https://fixture/two.jpg');
    f.image.animate = () => { throw new Error('Animation unavailable'); };
    f.load(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.group.classList.contains('crossfading'), false); assert.equal(f.timers.size, 0);
    assert.equal(f.image.src, 'https://fixture/two.jpg'); assert.equal(f.updates.at(-1), f.image.src);
});
