import test from 'node:test';
import assert from 'node:assert/strict';
import { createMusicImages, MUSIC_IMAGE_RETRY_DELAY_MS } from '../src/netease/images.js';
import { createContent } from '../src/netease/content.js';
import { FakeElement } from './helpers/host.mjs';

function fixture(t) {
    const root = new FakeElement(), document = new FakeElement();
    const images = [], observers = [], requests = [], timers = new Map();
    const flags = { open: true };
    let sequence = 0;
    root.contains = image => images.includes(image);
    root.querySelectorAll = () => images.filter(image => image.dataset.src);
    root.getBoundingClientRect = () => ({ top: 0, bottom: 400, left: 0, right: 400 });
    document.hidden = false;
    const env = { document, innerHeight: 600, innerWidth: 800,
        location: { href: 'http://127.0.0.1/' },
        setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        IntersectionObserver: class {
            constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); observers.push(this); }
            observe(image) { this.targets.add(image); }
            unobserve(image) { this.targets.delete(image); }
            disconnect() { this.targets.clear(); }
        }
    };
    const fallbackCover = 'data:image/svg+xml,cover', fallbackArtist = 'data:image/svg+xml,artist';
    const loader = createMusicImages({ root, isActive: () => flags.open, fallbackCover, fallbackArtist }, env);
    loader.initialize();
    t.after(() => loader.dispose());
    function image(source = 'https://cover.test/one.jpg', top = 40, standalone = false) {
        const img = new FakeElement();
        img.dataset.src = source;
        img.top = top;
        img.complete = false;
        img.naturalWidth = 0;
        img.getBoundingClientRect = () => ({ top: img.top, bottom: img.top + 50, left: 10, right: 60, width: 50, height: 50 });
        img.getClientRects = () => img.hidden ? [] : [{}];
        Object.defineProperty(img, 'src', {
            get() { return this.getAttribute('src') || ''; },
            set(value) { this.setAttribute('src', value); this.complete = false; this.naturalWidth = 0; requests.push({ image: img, source: value }); }
        });
        img.succeed = () => { img.complete = true; img.naturalWidth = 160; img.dispatchEvent({ type: 'load' }); };
        img.fail = () => { img.complete = true; img.naturalWidth = 0; img.dispatchEvent({ type: 'error' }); };
        if (!standalone) images.push(img);
        return img;
    }
    const enter = img => observers[0].callback([{ target: img, isIntersecting: true }]);
    const visibility = (img, isIntersecting) => observers[1].callback([{ target: img, isIntersecting }]);
    const tick = () => { const tasks = [...timers.values()]; timers.clear(); for (const task of tasks) task.callback(); };
    const httpRequests = () => requests.filter(request => request.source.startsWith('https:'));
    return { loader, env, root, flags, images, observers, requests, timers, image, enter, visibility, tick, httpRequests, fallbackCover, fallbackArtist };
}

test('preloading uses the cloud scroll container and has no idle tasks or duplicate native lazy gate', t => {
    const f = fixture(t), img = f.image();
    f.loader.observe(); f.loader.observe();
    assert.equal(f.observers[0].options.root, f.root);
    assert.equal(f.observers[0].options.rootMargin, '240px 0px');
    assert.equal(f.observers[0].targets.size, 1);
    assert.equal(f.requests.length, 0); assert.equal(f.timers.size, 0);
    assert.equal(img.loading, 'eager');
    f.enter(img); f.enter(img);
    assert.equal(f.httpRequests().length, 1);
    img.succeed();
    assert.equal(f.observers[0].targets.size, 0);
    assert.equal(img.listeners.get('load').size, 0);
    assert.equal(img.listeners.get('error').size, 0);
});

test('a visible failure gets one delayed retry with the unchanged URL, then stops', t => {
    const f = fixture(t), img = f.image();
    f.loader.observe(); f.enter(img); img.fail();
    assert.equal(img.src, f.fallbackCover);
    assert.equal(f.timers.size, 1);
    assert.equal([...f.timers.values()][0].delay, MUSIC_IMAGE_RETRY_DELAY_MS);
    f.tick(); assert.equal(f.httpRequests().length, 2);
    assert.equal(f.httpRequests()[0].source, f.httpRequests()[1].source);
    img.fail(); f.tick(); f.visibility(img, true); f.loader.observe();
    assert.equal(f.httpRequests().length, 2); assert.equal(f.timers.size, 0);
    assert.equal(f.observers[1].targets.size, 0);
    assert.equal(img.src, f.fallbackCover);
});

test('document-wide scans cannot take over playlist thumbnails outside the cloud scroll root', t => {
    const f = fixture(t), own = f.image(), other = f.image('https://cover.test/playlist.jpg', 40, true);
    f.loader.observe({ querySelectorAll: () => [own, other] });
    assert.equal(f.observers[0].targets.has(own), true);
    assert.equal(f.observers[0].targets.has(other), false);
    assert.equal(other.loading, undefined);
    assert.equal(other.listeners.size, 0);
});

test('a successful retry releases listeners and retry observation', t => {
    const f = fixture(t), img = f.image();
    f.loader.observe(); f.enter(img); img.fail(); f.tick(); img.succeed();
    assert.equal(f.httpRequests().length, 2); assert.equal(f.timers.size, 0);
    assert.equal(f.observers[1].targets.size, 0);
    assert.equal(img.listeners.get('error').size, 0);
});

test('same-origin relative image URLs can retry without changing their address', t => {
    const f = fixture(t), img = f.image('/cover/one.jpg');
    f.loader.observe(); f.enter(img); img.fail(); f.tick();
    assert.equal(f.requests.filter(request => request.source === '/cover/one.jpg').length, 2);
});

test('offscreen failures do not retry until the image is truly visible', t => {
    const f = fixture(t), img = f.image('https://cover.test/offscreen.jpg', 450);
    f.loader.observe(); f.enter(img); img.fail();
    assert.equal(f.timers.size, 0);
    img.top = 40; f.visibility(img, true); assert.equal(f.timers.size, 1);
    f.tick(); assert.equal(f.httpRequests().length, 2);
});

test('scrolling away cancels the wait without spending the retry', t => {
    const f = fixture(t), img = f.image();
    f.loader.observe(); f.enter(img); img.fail();
    img.top = -100; f.visibility(img, false); f.tick();
    assert.equal(f.httpRequests().length, 1);
    img.top = 40; f.visibility(img, true); f.tick();
    assert.equal(f.httpRequests().length, 2);
});

test('the retry timer rechecks geometry even before a queued visibility event is delivered', t => {
    const f = fixture(t), img = f.image();
    f.loader.observe(); f.enter(img); img.fail();
    img.top = 450; f.tick();
    assert.equal(f.httpRequests().length, 1);
    img.top = 40; f.visibility(img, true); f.tick();
    assert.equal(f.httpRequests().length, 2);
});

test('clearing a subtree cancels timers and stale callbacks without clearing sibling observations', t => {
    const f = fixture(t), old = f.image(), sibling = f.image('https://cover.test/sibling.jpg', 1000);
    f.loader.observe(); f.enter(old); old.fail();
    const oldLoad = [...old.listeners.get('load')][0], oldError = [...old.listeners.get('error')][0];
    const staleTimer = [...f.timers.values()][0].callback;
    f.loader.clear({ contains: value => value === old }); old.isConnected = false;
    oldLoad(); oldError(); staleTimer(); f.tick();
    assert.equal(f.httpRequests().length, 1); assert.equal(f.timers.size, 0);
    assert.equal(f.observers[0].targets.has(sibling), true);
    assert.equal(f.observers[1].targets.size, 0);
});

test('clearing a page releases detached targets and allows retained tab DOM to resume', t => {
    const f = fixture(t), old = f.image(), retained = f.image('https://cover.test/retained.jpg');
    f.loader.observe(); f.enter(retained); old.isConnected = false;
    f.loader.clear();
    assert.equal(f.observers[0].targets.size, 0);
    assert.equal(old.listeners.get('error').size, 0);
    f.images.splice(f.images.indexOf(old), 1);
    f.loader.observe(); f.enter(retained);
    assert.equal(f.httpRequests().length, 1, 'healthy in-flight image is not restarted');
    retained.succeed();
    assert.equal(retained.listeners.get('load').size, 0);
});

test('closing a panel cancels retries and reopening can finish the one remaining retry', t => {
    const f = fixture(t), img = f.image();
    f.loader.observe(); f.enter(img); img.fail();
    f.flags.open = false; f.loader.pause(); f.tick();
    assert.equal(f.httpRequests().length, 1); assert.equal(f.timers.size, 0);
    f.flags.open = true; f.loader.resume(); f.visibility(img, true); f.tick();
    assert.equal(f.httpRequests().length, 2);
});

test('hidden tabs stop retry waits and resume only when the panel is still open', t => {
    const f = fixture(t), img = f.image();
    f.loader.observe(); f.enter(img); img.fail();
    f.env.document.hidden = true; f.env.document.dispatchEvent({ type: 'visibilitychange' }); f.tick();
    assert.equal(f.timers.size, 0); assert.equal(f.httpRequests().length, 1);
    f.env.document.hidden = false; f.env.document.dispatchEvent({ type: 'visibilitychange' }); f.visibility(img, true); f.tick();
    assert.equal(f.httpRequests().length, 2);
});

test('hidden cached tabs do not consume a retry', t => {
    const f = fixture(t), img = f.image();
    f.loader.observe(); f.enter(img); img.hidden = true; img.fail(); f.visibility(img, true); f.tick();
    assert.equal(f.timers.size, 0); assert.equal(f.httpRequests().length, 1);
});

test('artist thumbnails preserve their fallback and broken data placeholders cannot retry forever', t => {
    const f = fixture(t), artist = f.image(), placeholder = f.image(f.fallbackCover);
    artist.closest = selector => selector === '.artist' ? {} : null;
    f.loader.observe(); f.enter(artist); artist.fail();
    assert.equal(artist.src, f.fallbackArtist);
    f.enter(placeholder); placeholder.fail();
    assert.equal(f.timers.size, 1, 'only the network image gets a retry');
});

test('changing a source on a reused node cancels the old retry and callbacks', t => {
    const f = fixture(t), img = f.image();
    f.loader.observe(); f.enter(img); img.fail();
    const oldError = [...img.listeners.get('error')][0];
    img.dataset.src = 'https://cover.test/new.jpg'; f.loader.observe(); f.enter(img);
    oldError(); f.tick();
    assert.equal(img.src, 'https://cover.test/new.jpg');
    assert.equal(f.httpRequests().length, 2); assert.equal(f.timers.size, 0);
});

test('mini covers skip identical pending and loaded sources but move Blob references immediately when closed', t => {
    const f = fixture(t), img = f.image('', 500, true);
    f.loader.setMiniCover(img, 'blob:old');
    assert.equal(f.loader.setMiniCover(img, 'blob:old'), false); img.succeed();
    assert.equal(f.loader.setMiniCover(img, 'blob:old'), false);
    f.flags.open = false; f.loader.pause();
    f.loader.setMiniCover(img, 'blob:new');
    assert.equal(img.src, 'blob:new'); assert.equal(f.requests.length, 2);
    f.loader.setMiniCover(img);
    assert.equal(img.getAttribute('src'), null);
});

test('mini cover failures have one retry and ordinary player updates cannot restart the failure loop', t => {
    const f = fixture(t), img = f.image('', 500, true), source = 'https://cover.test/mini.jpg';
    f.loader.setMiniCover(img, source); img.fail();
    for (let i = 0; i < 20; i++) f.loader.setMiniCover(img, source);
    f.tick(); img.fail();
    for (let i = 0; i < 20; i++) f.loader.setMiniCover(img, source);
    f.tick();
    assert.equal(f.httpRequests().length, 2); assert.equal(f.timers.size, 0);
    assert.equal(img.src, f.fallbackCover);
});

test('switching mini covers invalidates old callbacks and retry timers', t => {
    const f = fixture(t), img = f.image('', 500, true);
    f.loader.setMiniCover(img, 'https://cover.test/old.jpg'); img.fail();
    const callback = [...f.timers.values()][0].callback, oldError = [...img.listeners.get('error')][0];
    f.loader.setMiniCover(img, 'https://cover.test/new.jpg');
    callback(); oldError();
    assert.equal(img.src, 'https://cover.test/new.jpg'); assert.equal(f.timers.size, 0);
});

test('mini UI labels still update while repeated cover assignments are suppressed', t => {
    const f = fixture(t), image = f.image('', 500, true);
    const elements = new Map(['music-mini-player', 'music-mini-title', 'music-mini-artists', 'music-mini-play', 'music-mini-artist']
        .map(id => [id, new FakeElement(id)]));
    elements.set('music-mini-cover', image);
    const document = { getElementById: id => elements.get(id) };
    const saved = new Map(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.defineProperty(globalThis, 'window', { value: f.env, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
    t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
    const playBtn = new FakeElement(); playBtn.setAttribute('aria-label', '播放');
    const title = new FakeElement(); title.textContent = 'First';
    const queue = { playlist: [{ name: 'First' }], curIdx: 0 };
    const content = createContent({ dom: { neteaseBrowserScroll: f.root, neteasePanel: { classList: { contains: () => true } },
        el: { title, artist: { textContent: 'Artist' }, playBtn } }, queue,
        covers: { mainCoverTrackIds: new WeakMap(), coverDisplayUrl: () => 'https://cover.test/same.jpg' } });
    content.updateMusicMiniPlayer();
    title.textContent = 'Second'; playBtn.setAttribute('aria-label', '暂停'); content.updateMusicMiniPlayer();
    assert.equal(f.httpRequests().length, 1);
    assert.equal(elements.get('music-mini-title').textContent, 'Second');
    assert.equal(elements.get('music-mini-play').getAttribute('aria-label'), '暂停');
    queue.playlist = []; content.updateMusicMiniPlayer();
    assert.equal(image.getAttribute('src'), null);
});
