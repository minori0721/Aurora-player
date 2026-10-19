import test from 'node:test';
import assert from 'node:assert/strict';
import { createCovers, COVER_PENDING_TIMEOUT_MS } from '../src/ui/cover.js';

function fixture(t) {
    const saved = { setTimeout, clearTimeout, location: globalThis.location, window: globalThis.window };
    let sequence = 0, source = '', assignments = 0;
    const timers = new Map(), updates = [], events = new Map(), revoked = [], consumers = [];
    globalThis.setTimeout = (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; };
    globalThis.clearTimeout = id => timers.delete(id);
    globalThis.location = { href: 'https://player.fixture/' };
    globalThis.window = { devicePixelRatio: 1, addEventListener: (name, callback) => events.set(name, callback) };
    t.mock.method(URL, 'revokeObjectURL', url => { revoked.push(url); consumers.push('revoke'); });
    const image = { style: {}, complete: false, naturalWidth: 0, clientWidth: 280, clientHeight: 280,
        getAttribute: name => name === 'src' ? source : null,
        removeAttribute(name) { if (name === 'src') { source = ''; this.complete = false; this.naturalWidth = 0; } },
        get src() { return source; },
        set src(value) { source = value; assignments++; this.complete = false; this.naturalWidth = 0; }
    };
    const queue = { playlist: [{}], curIdx: 0 };
    const covers = createCovers({ dom: { el: { img: image, coverWrap: {} } }, queue,
        render: { updateTheme: value => updates.push(value ? image.src : null) },
        content: { updateMusicMiniPlayer() { consumers.push('mini'); } },
        metadata: { updateMediaSession() { consumers.push('media'); } }
    });
    t.after(() => {
        covers.setMainCover();
        globalThis.setTimeout = saved.setTimeout; globalThis.clearTimeout = saved.clearTimeout;
        for (const key of ['location', 'window']) {
            if (saved[key] === undefined) delete globalThis[key]; else globalThis[key] = saved[key];
        }
    });
    return { covers, queue, image, timers, updates, revoked, consumers, events, assignments: () => assignments,
        load() { image.complete = true; image.naturalWidth = 512; image.onload?.(); },
        fire(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } }
    };
}

test('pending metadata preserves the previous background; explicit absence resets it immediately', t => {
    const f = fixture(t);
    f.covers.setMainCover('https://p4.music.126.net/one.jpg'); f.load();
    f.covers.setMainCover('', { pending: true });
    assert.equal(f.updates.length, 1); assert.equal(f.image.src, '');
    f.covers.setMainCover();
    assert.deepEqual(f.updates.slice(-1), [null]); assert.equal(f.timers.size, 0);
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
    assert.deepEqual(f.revoked, ['blob:old']);
    assert.ok(f.consumers.indexOf('mini') < f.consumers.indexOf('revoke'));
    f.covers.initialize(); f.image.clientWidth = 800; f.events.get('resize')();
    const before = f.updates.length;
    f.fire(180);
    assert.equal(f.updates.length, before);
    assert.match(f.image.src, /param=1024y1024/);
    f.load(); assert.equal(f.updates.length, before + 1);
});
