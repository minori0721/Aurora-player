import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createSongActions } from '../src/netease/song-actions.js';
import { createMyPlaylists } from '../src/netease/my-playlists.js';
import { createQueue } from '../src/playlist/queue.js';
import { createDownload } from '../src/netease/download.js';
import { createPersistence } from '../src/storage/playlist.js';
import { FakeElement, storage } from './helpers/host.mjs';

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const song = id => ({ id, name: `Song ${id}` });
const track = id => ({ netease: true, songId: id, songData: song(id) });
const playlist = (id, userId = 7, extra = {}) => ({ id, name: `Playlist ${id}`, creator: { userId }, ...extra });
const playlistDetail = (ids, extra = {}) => ({ code: 200, playlist: { id: 9, trackCount: ids.length, trackIds: ids.map(id => ({ id })), ...extra } });

function matches(node, selector) {
    return selector.split(',').some(value => {
        const part = value.trim();
        if (part.startsWith('#')) return node.id === part.slice(1);
        if (part.startsWith('.')) return String(node.className || '').split(/\s+/).includes(part.slice(1));
        const attr = /^\[data-([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
        if (attr) {
            const key = attr[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
            return node.dataset[key] !== undefined && (attr[2] === undefined || String(node.dataset[key]) === attr[2]);
        }
        return node.tagName === part.toUpperCase();
    });
}

class Element extends FakeElement {
    constructor(tag = 'div', doc) { super(); this.tagName = tag.toUpperCase(); this.doc = doc; this.disabled = false; this.open = false; }
    appendChild(child) { child.parentNode = this; return super.appendChild(child); }
    replaceChildren(...children) { this.children.forEach(child => { child.isConnected = false; }); this.children = []; children.forEach(child => this.appendChild(child)); }
    insertBefore(child, before) {
        this.children = this.children.filter(node => node !== child);
        const index = before ? this.children.indexOf(before) : this.children.length;
        this.children.splice(index, 0, child); child.parentNode = this; child.isConnected = true;
        return child;
    }
    closest(selector) { return matches(this, selector) ? this : this.parentNode?.closest?.(selector) || null; }
    querySelectorAll(selector) {
        return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { this.doc.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatchEvent({ type: 'close' }); }
    set innerHTML(value) {
        super.innerHTML = value;
        if (this.tagName !== 'DIALOG') return;
        for (const [tag, className, id] of [
            ['h2', '', 'song-actions-picker-title'], ['p', 'song-actions-song', 'song-actions-picker-song'],
            ['button', 'song-actions-close'], ['div', 'song-actions-list'], ['p', 'song-actions-status'], ['button', 'song-actions-retry']
        ]) {
            const node = new Element(tag, this.doc); node.className = className; node.id = id || '';
            if (className === 'song-actions-retry') node.hidden = true;
            this.appendChild(node);
        }
    }
    get innerHTML() { return super.innerHTML; }
}

function fixture(t, { shared = [], complete = true } = {}) {
    const doc = new Element('document'); doc.doc = doc; doc.body = new Element('body', doc); doc.appendChild(doc.body);
    doc.activeElement = doc.body;
    doc.createElement = tag => new Element(tag, doc);
    doc.getElementById = id => doc.querySelector(`#${id}`);
    const nodes = {};
    for (const id of ['track-song-actions', 'track-like', 'track-collect', 'song-action-message', 'mylist-content']) {
        nodes[id] = doc.createElement(id === 'song-action-message' ? 'p' : 'button'); nodes[id].id = id; doc.body.appendChild(nodes[id]);
    }
    const calls = [], invalidations = [], logs = [], liked = new Set();
    const auth = { generation: 1, neteaseCookie: 'MUSIC_U=synthetic', neteaseUser: { userId: 7 }, accountAbortControllers: new Set(),
        captureAuthSnapshot() { return { cookie: this.neteaseCookie, generation: this.generation }; },
        isAuthSnapshotCurrent(value) { return value.cookie === this.neteaseCookie && value.generation === this.generation; } };
    const api = { buildApiUrl: path => `https://fixture.invalid${path}` };
    const myPlaylists = complete ? { myPlaylistsData: shared, myPlaylistsComplete: true, myPlaylistsCache: 'rendered',
        async ensurePlaylists({ signal, onUpdate } = {}) {
            if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
            const value = { items: this.myPlaylistsData, complete: true, loading: false };
            onUpdate?.(value); return value;
        },
        invalidateAfterSongWrite() { this.myPlaylistsCache = null; }
    } : createMyPlaylists({ api, auth, content: { clearMusicImages() {}, observeMusicImages() {} } });
    const state = { handler(call) {
        if (call.path === '/song/like/check') return { code: 200, data: JSON.parse(call.body.ids).filter(id => liked.has(id)) };
        if (call.path === '/song/like') { if (call.body.like === 'true') liked.add(call.body.id); else liked.delete(call.body.id); return { code: 200 }; }
        if (call.path === '/user/playlist') return { code: 200, playlist: shared, more: false };
        return { code: 200 };
    } };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        const call = { url, path: new URL(url).pathname, options, body: JSON.parse(options.body) }; calls.push(call);
        const value = await state.handler(call);
        return value?.json ? value : { status: 200, ok: true, json: async () => value };
    });
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
    const service = createSongActions({ api, auth, myPlaylists,
        cache: { clearAccountJsonCache: () => invalidations.push(true) }, debug: { log: (...args) => logs.push(args) } });
    const results = [];
    const actions = { ...service, addToPlaylist(value, pid, options = {}) {
        return service.addToPlaylist(value, pid, { ...options, onResult(result) { results.push(result); options.onResult?.(result); } });
    } };
    t.after(async () => { actions.reset(); myPlaylists.reset?.(); await settle(); if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else delete globalThis.document; });
    const menu = (ids = [1]) => {
        const details = doc.createElement('details'); doc.body.appendChild(details);
        for (const id of ids) {
            for (const key of ['songLike', 'songCollect']) {
                const button = doc.createElement('button'); button.dataset[key] = String(id); button.dataset.songTitle = `Song ${id}`; details.appendChild(button);
            }
        }
        return details;
    };
    const click = target => {
        const event = { type: 'click', target, defaultPrevented: false, stopped: false,
            preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
        doc.dispatchEvent(event); return event;
    };
    return { actions, auth, myPlaylists, doc, nodes, calls, invalidations, logs, liked, state, menu, click,
        result: () => results.at(-1), results,
        dialog: () => doc.querySelector('dialog'), message: () => nodes['song-action-message'].textContent };
}

test('exports only the agreed service surface; initialize is idempotent and initially hides static actions', t => {
    const f = fixture(t); f.actions.initialize(); f.actions.initialize();
    assert.deepEqual(Object.keys(f.actions).sort(), ['initialize', 'setCurrentTrack', 'reset', 'checkLikes', 'toggleLike', 'openPlaylistPicker', 'addToPlaylist'].sort());
    assert.equal(f.doc.listeners.get('click').size, 1); assert.equal(f.doc.listeners.get('toggle').size, 1);
    assert.equal(f.nodes['track-like'].hidden, true); assert.equal(f.nodes['track-collect'].disabled, true);
    assert.equal(f.nodes['track-song-actions'].hidden, true);
    assert.equal(f.calls.length, 0);
});

test('selected current track and metadata fallback show actions; local/no song hide and disable them', async t => {
    const f = fixture(t); f.actions.initialize();
    f.actions.setCurrentTrack({ netease: true, songData: { id: 21, name: 'Example' } }); await settle();
    assert.equal(f.nodes['track-like'].hidden, false); assert.equal(f.nodes['track-collect'].disabled, false);
    assert.equal(f.nodes['track-song-actions'].hidden, false);
    assert.deepEqual(JSON.parse(f.calls[0].body.ids), [21]);
    for (const value of [null, { songId: 21 }, { netease: false, songId: 21 }, { netease: true, songId: 0 }]) {
        f.actions.setCurrentTrack(value); assert.equal(f.nodes['track-like'].hidden, true); assert.equal(f.nodes['track-like'].disabled, true);
    }
});

for (const first of ['picker', 'mine']) {
    test(`both real entry points join one pending 31-row response, first=${first}`, async t => {
        const f = fixture(t, { complete: false }), response = deferred();
        f.state.handler = () => response.promise;
        const opening = first === 'picker' ? f.actions.openPlaylistPicker(song(1)) : f.myPlaylists.loadMyPlaylists();
        await settle();
        const joining = first === 'picker' ? f.myPlaylists.loadMyPlaylists() : f.actions.openPlaylistPicker(song(1));
        await settle(); assert.equal(f.calls.length, 1);
        response.resolve({ code: 200, playlist: Array.from({ length: 31 }, (_, index) => playlist(index + 1)), more: false });
        await Promise.all([opening, joining]); await settle();
        assert.equal(f.dialog().querySelectorAll('.song-actions-playlist').length, 31);
        assert.match(f.nodes['mylist-content'].innerHTML, /Playlist 31/);
        f.dialog().close(); await f.actions.openPlaylistPicker(song(2)); await f.myPlaylists.loadMyPlaylists();
        assert.equal(f.calls.length, 1, 'reopening either entry within TTL makes no additional catalog request');
    });
}

test('closing the picker while My Playlists is waiting keeps its shared request alive', async t => {
    const f = fixture(t, { complete: false }), response = deferred();
    f.state.handler = () => response.promise;
    const opening = f.actions.openPlaylistPicker(song(1));
    const mine = f.myPlaylists.loadMyPlaylists(); await settle();
    f.dialog().querySelector('.song-actions-close').dispatchEvent({ type: 'click' });
    assert.equal(await opening, false); assert.equal(f.calls[0].options.signal.aborted, false);
    response.resolve({ code: 200, more: false, playlist: [playlist(9)] });
    await mine; await settle();
    assert.match(f.nodes['mylist-content'].innerHTML, /Playlist 9/);
    assert.equal(f.dialog().querySelectorAll('.song-actions-playlist').length, 0); assert.equal(f.calls.length, 1);
});

test('twenty quick picker reopens share the pending read and only the last song receives its rows', async t => {
    const f = fixture(t, { complete: false }), response = deferred(), openings = [];
    f.state.handler = () => response.promise;
    for (let id = 1; id <= 20; id++) {
        openings.push(f.actions.openPlaylistPicker(song(id)));
        await Promise.resolve();
    }
    await settle(); assert.equal(f.calls.length, 1);
    response.resolve({ code: 200, more: false, playlist: [playlist(9)] });
    const finished = await Promise.all(openings);
    assert.equal(finished.filter(Boolean).length, 1); assert.equal(finished.at(-1), true);
    assert.equal(f.dialog().querySelector('.song-actions-song').textContent, 'Song 20');
    assert.equal(f.dialog().querySelectorAll('.song-actions-playlist').length, 1);
    assert.equal(f.calls.length, 1);
});

test('first-page picker rows remain focused and actionable while later pages are pending', async t => {
    const f = fixture(t, { complete: false }), second = deferred();
    f.state.handler = call => call.path !== '/user/playlist' ? { code: 200 }
        : call.body.offset === 0 ? { code: 200, more: true, playlist: [playlist(9)] } : second.promise;
    const opening = f.actions.openPlaylistPicker(song(1)); await settle();
    const row = f.dialog().querySelector('.song-actions-playlist');
    assert.ok(row); assert.equal(row.disabled, false); row.focus();
    second.resolve({ code: 200, more: false, playlist: [playlist(10)] }); await opening;
    assert.equal(f.dialog().querySelector('.song-actions-playlist'), row); assert.equal(f.doc.activeElement, row);
    assert.deepEqual(f.calls.map(call => call.body.offset), [0, 30]);
});

test('a known owned first-page target can be collected without waiting for or duplicating later reads', async t => {
    const f = fixture(t, { complete: false }), second = deferred();
    f.state.handler = call => call.path !== '/user/playlist' ? { code: 200 }
        : call.body.offset === 0 ? { code: 200, more: true, playlist: [playlist(9)] } : second.promise;
    const opening = f.actions.openPlaylistPicker(song(1)); await settle();
    f.dialog().querySelector('.song-actions-playlist').dispatchEvent({ type: 'click' }); await settle();
    assert.equal(f.dialog().open, false); assert.equal(await opening, false);
    assert.deepEqual(f.calls.map(call => call.path), ['/user/playlist', '/user/playlist', '/playlist/tracks']);
    second.resolve({ code: 200, more: false, playlist: [playlist(10)] }); await settle();
});

for (const temporary of [false, true]) {
    test(`persistence restores an idle NetEase collection target without audio playback, temporary=${temporary}`, async t => {
        const f = fixture(t, { shared: [playlist(9)] });
        const localStorage = storage(), playback = { playbackState: { status: 'idle' }, setPlaybackStatus(status) { this.playbackState.status = status; } };
        const queue = createQueue({ songActions: f.actions, content: { clearMusicQueueFeedback() {} } });
        const storedTrack = id => ({ type: 'netease', id, title: `Restored ${id}`, artists: [], album: {} });
        localStorage.setItem('aurora_playlist_snapshot_v3', JSON.stringify({ schema: 3, listId: 'restored', revision: 1,
            selectedIndex: 1, tracks: [storedTrack(1), storedTrack(2)],
            ...(temporary ? { manual: { current: storedTrack(3), pending: [] } } : {}) }));
        const globals = { localStorage, window: { crypto: globalThis.crypto, addEventListener() {} } };
        for (const [key, value] of Object.entries(globals)) {
            const before = Object.getOwnPropertyDescriptor(globalThis, key);
            Object.defineProperty(globalThis, key, { configurable: true, value });
            t.after(() => before ? Object.defineProperty(globalThis, key, before) : delete globalThis[key]);
        }
        const persistence = createPersistence({ queue, playback, cache: { openIdb: async () => null },
            content: { setMainMusicEntityLinks() {}, updateMusicMiniPlayer() {} }, dom: { el: { title: {}, img: { style: {} } } },
            covers: { setMainCover() {} }, lyrics: { setArtistTag() {} }, imports: {},
            playlistView: { renderPlaylist() {} }, onlinePlaylist: { restoreQueueSource() {} }, debug: { log() {} } });
        f.actions.initialize(); persistence.initialize(); await settle();
        const id = temporary ? 3 : 2;
        assert.equal(playback.playbackState.status, 'idle'); assert.equal(queue.currentTrack.songId, id);
        assert.equal(f.nodes['track-collect'].hidden, false); assert.equal(f.nodes['track-collect'].disabled, false);
        const download = createDownload({}); download._currentPlaying = null;
        assert.equal(f.nodes['track-collect'].hidden, false, 'clearing audio/download state does not hide the selected target');
        f.click(f.nodes['track-collect']); await settle();
        assert.equal(f.dialog().querySelector('.song-actions-song').textContent, `Restored ${id}`);
        f.dialog().querySelector('.song-actions-playlist').dispatchEvent({ type: 'click' }); await settle();
        const writes = f.calls.filter(call => call.path === '/playlist/tracks');
        assert.equal(writes.length, 1); assert.equal(writes[0].body.tracks, String(id));
        assert.ok(f.calls.every(call => ['/song/like/check', '/playlist/tracks'].includes(call.path)), 'no audio URL, audio file or catalog read is needed');
    });
}

test('queue selection, source replacement and clearing update collection targets without playback', async t => {
    const f = fixture(t);
    const queue = createQueue({ songActions: f.actions, content: { clearMusicQueueFeedback() {} }, prefetch: { retargetNextPreload() {} } });
    queue.playlist = [track(1), track(2)]; queue.curIdx = 1; await settle();
    assert.equal(queue.currentTrack.songId, 2); assert.equal(f.nodes['track-collect'].hidden, false);
    queue.replaceBaseTracks([track(4)], 0); await settle();
    await f.actions.openPlaylistPicker(queue.currentTrack);
    assert.equal(f.dialog().querySelector('.song-actions-song').textContent, 'Song 4');
    f.dialog().close(); queue.playlist = []; await settle();
    assert.equal(queue.currentTrack, null); assert.equal(f.nodes['track-collect'].hidden, true);
    queue.playlist = [{ name: 'Local.wav' }]; queue.curIdx = 0;
    assert.equal(f.nodes['track-collect'].hidden, true);
});

test('batch checks dedupe numeric IDs, cache in bounded memory and reject invalid ID coercions', async t => {
    const f = fixture(t); f.liked.add(2);
    const result = await f.actions.checkLikes([1, '2', 2, null, true, [], [3], {}, '1.5', 'Infinity', 0, -3, 1.3]);
    assert.deepEqual([...result], [[1, false], [2, true]]);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.ids, '[1,2]');
    await f.actions.checkLikes([1, 2]); assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url.includes('synthetic'), false);
});

test('large input uses bounded batches, never per-song requests or persistent cache writes', async t => {
    const f = fixture(t);
    const result = await f.actions.checkLikes(Array.from({ length: 5000 }, (_, i) => i + 1));
    assert.equal(result.size, 1000); assert.equal(f.calls.length, 5);
    assert.ok(f.calls.every(call => JSON.parse(call.body.ids).length === 200));
    assert.equal(f.invalidations.length, 0);
});

test('overlapping in-flight batch checks share work', async t => {
    const f = fixture(t), response = deferred(); f.state.handler = () => response.promise;
    const first = f.actions.checkLikes([1, 2]), second = f.actions.checkLikes([2, 3]);
    await settle(); assert.deepEqual(f.calls.map(call => JSON.parse(call.body.ids)), [[1, 2], [3]]);
    response.resolve({ code: 200, data: [2] });
    assert.deepEqual([...(await first)], [[1, false], [2, true]]);
    assert.deepEqual([...(await second)], [[2, true], [3, false]]);
});

test('menus check lazily on details open, update duplicate controls, and never check on initialization', async t => {
    const f = fixture(t), menu = f.menu([1, 2, 1]); f.liked.add(1); f.actions.initialize();
    assert.equal(f.calls.length, 0);
    f.doc.dispatchEvent({ type: 'toggle', target: menu }); await settle(); assert.equal(f.calls.length, 0);
    menu.open = true; f.doc.dispatchEvent({ type: 'toggle', target: menu }); await settle();
    assert.equal(f.calls.length, 1);
    assert.ok(menu.querySelectorAll('[data-song-like="1"]').every(button => button.getAttribute('aria-pressed') === 'true'));
    f.doc.dispatchEvent({ type: 'toggle', target: menu }); await settle(); assert.equal(f.calls.length, 1);
});

test('delegated clicks are captured, suppress row play/dismissal and leave details open', async t => {
    const f = fixture(t), menu = f.menu(); f.actions.initialize(); menu.open = true;
    f.doc.dispatchEvent({ type: 'toggle', target: menu }); await settle();
    const child = f.doc.createElement('span'); menu.querySelector('[data-song-like]').appendChild(child);
    const event = f.click(child); await settle();
    assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true); assert.equal(menu.open, true);
    assert.equal(f.calls.filter(call => call.path === '/song/like').length, 1);
});

test('like/unlike payloads are strings, state is optimistic and rollback handles nested business failure', async t => {
    const f = fixture(t); f.actions.setCurrentTrack(track(1)); await settle();
    const response = deferred(), previous = f.state.handler;
    f.state.handler = call => call.path === '/song/like' ? response.promise : previous(call);
    const result = f.actions.toggleLike(song(1)); await settle();
    assert.equal(f.nodes['track-like'].getAttribute('aria-pressed'), 'true'); assert.equal(f.nodes['track-like'].disabled, true);
    assert.equal(f.calls.at(-1).body.like, 'true');
    response.resolve({ status: 200, body: { body: { code: 500, msg: 'cookie=secret' } } });
    assert.equal(await result, false);
    assert.equal(f.nodes['track-like'].getAttribute('aria-pressed'), 'false'); assert.equal(f.nodes['track-like'].disabled, false);
    assert.match(f.message(), /500/); assert.equal(f.message().includes('secret'), false); assert.equal(f.invalidations.length, 0);
    f.state.handler = previous;
    assert.equal(await f.actions.toggleLike(song(1)), true);
    assert.equal(await f.actions.toggleLike(song(1)), true);
    assert.equal(f.calls.at(-1).body.like, 'false'); assert.equal(f.invalidations.length, 0);
    assert.equal(f.myPlaylists.myPlaylistsCache, null);
});

test('per-song locks serialize competing like/collect operations without extra writes', async t => {
    const f = fixture(t, { shared: [playlist(9)] }), response = deferred(); await f.actions.checkLikes([1]);
    const old = f.state.handler; f.state.handler = call => call.path === '/song/like' ? response.promise : old(call);
    const first = f.actions.toggleLike(song(1)), second = f.actions.toggleLike(song(1)), third = f.actions.addToPlaylist(song(1), 9);
    assert.equal(first, second); assert.equal(await third, false); await settle(); assert.equal(f.calls.length, 2);
    response.resolve({ code: 200 }); assert.equal(await first, true);
});

test('a focused favorite button retains keyboard focus while its pending action stays locked', async t => {
    const f = fixture(t), response = deferred();
    f.actions.setCurrentTrack({ ...song(1), netease: true }); await settle();
    f.nodes['track-like'].focus();
    const previous = f.state.handler;
    f.state.handler = call => call.path === '/song/like' ? response.promise : previous(call);
    const pending = f.actions.toggleLike(song(1)); await settle();
    assert.equal(f.nodes['track-like'].disabled, false);
    assert.equal(f.nodes['track-like'].getAttribute('aria-disabled'), 'true');
    assert.equal(f.nodes['track-like'].getAttribute('aria-busy'), 'true');
    assert.equal(f.actions.toggleLike(song(1)), pending);
    assert.equal(f.calls.filter(call => call.path === '/song/like').length, 1);
    response.resolve({ code: 200 }); await pending;
    assert.equal(f.nodes['track-like'].getAttribute('aria-disabled'), 'false');
});

test('toggle waits for an existing check without a duplicate lookup or stale overwrite', async t => {
    const f = fixture(t), response = deferred(); const old = f.state.handler;
    f.state.handler = call => call.path === '/song/like/check' ? response.promise : old(call);
    const check = f.actions.checkLikes([1]); const toggle = f.actions.toggleLike(song(1)); await settle();
    response.resolve({ code: 200, data: [1] }); await check; assert.equal(await toggle, true);
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].body.like, 'false');
});

test('unknown/failed like check never guesses the inverse or writes', async t => {
    const f = fixture(t); f.state.handler = () => ({ code: 200, data: { nonsense: true } });
    assert.equal(await f.actions.toggleLike(song(1)), false);
    assert.equal(f.calls.length, 1); assert.match(f.message(), /失败/);
});

test('uncertain writes roll back, invalidate like knowledge, and a manual retry checks before mutating', async t => {
    const f = fixture(t); f.actions.setCurrentTrack(track(1)); await settle(); const old = f.state.handler;
    f.state.handler = call => { if (call.path === '/song/like') { f.liked.add(1); throw new TypeError('cookie=synthetic'); } return old(call); };
    assert.equal(await f.actions.toggleLike(song(1)), false);
    assert.equal(f.nodes['track-like'].getAttribute('aria-pressed'), 'false'); assert.match(f.message(), /未确认/);
    f.state.handler = old; assert.equal(await f.actions.toggleLike(song(1)), true);
    assert.deepEqual(f.calls.slice(-2).map(call => call.path), ['/song/like/check', '/song/like']);
    assert.equal(f.calls.at(-1).body.like, 'false');
});

test('local/invalid songs and signed-out accounts never dispatch account requests', async t => {
    const f = fixture(t);
    for (const value of [null, true, [], { id: true }, { id: 'bad' }, { netease: false, id: 1 }]) assert.equal(await f.actions.toggleLike(value), false);
    f.auth.neteaseUser = null; f.auth.neteaseCookie = '';
    f.actions.setCurrentTrack(track(1));
    assert.equal(f.nodes['track-like'].disabled, false);
    assert.equal(await f.actions.toggleLike(song(1)), false); assert.equal(await f.actions.openPlaylistPicker(song(1)), false);
    assert.equal((await f.actions.checkLikes([1])).size, 0); assert.equal(f.calls.length, 0);
});

test('guest buttons open the existing login only on click and never resume a mutation automatically', async t => {
    const f = fixture(t), menu = f.menu(); let logins = 0;
    f.auth.showLogin = () => { logins++; };
    f.auth.neteaseUser = null; f.auth.neteaseCookie = '';
    f.actions.initialize(); f.actions.setCurrentTrack(track(1)); await settle();
    assert.equal(f.nodes['track-like'].disabled, false); assert.equal(logins, 0);
    f.click(f.nodes['track-like']); f.click(menu.querySelector('[data-song-collect]'));
    assert.equal(logins, 2); assert.equal(f.calls.length, 0);
    assert.equal(f.message(), ''); assert.equal(f.nodes['song-action-message'].hidden, true);
    await f.actions.openPlaylistPicker(track(1)); await f.actions.toggleLike(track(1));
    assert.equal(logins, 4); assert.equal(f.message(), ''); assert.equal(f.calls.length, 0);
    f.auth.generation++; f.actions.reset();
    f.auth.neteaseUser = { userId: 7 }; f.auth.neteaseCookie = 'MUSIC_U=new-synthetic';
    await settle(); assert.equal(f.calls.length, 0);
    f.click(menu.querySelector('[data-song-like]')); await settle();
    assert.deepEqual(f.calls.map(call => call.path), ['/song/like/check', '/song/like']);
});

test('reset waits for the identity commit before repainting menu auth state and captures no old snapshot', async t => {
    const f = fixture(t), menu = f.menu();
    const capture = f.auth.captureAuthSnapshot; let snapshots = 0;
    f.auth.captureAuthSnapshot = function() { snapshots++; return capture.call(this); };
    f.auth.generation++; f.actions.reset();
    f.auth.neteaseUser = null; f.auth.neteaseCookie = '';
    await settle(); assert.equal(snapshots, 0); assert.equal(f.calls.length, 0);
    assert.match(menu.querySelector('[data-song-like]').title, /登录/);
    assert.equal(menu.querySelector('[data-song-like]').disabled, false);
});

test('complete shared playlists avoid reads and include only playlists created by current user', async t => {
    const f = fixture(t, { shared: [playlist(1), playlist(2, 8), playlist(3, '7'), { id: 4 }, playlist(0)] });
    assert.equal(await f.actions.openPlaylistPicker(song(5)), true);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.dialog().querySelectorAll('.song-actions-playlist').map(node => node.dataset.playlistId), ['1', '3']);
});

test('playlist picker retains cover and track count from shared data without extra API reads', async t => {
    const cover = 'https://p3.music.126.net/picker-cover/123456.jpg';
    const f = fixture(t, { shared: [playlist(9, 7, { name: 'Long <playlist> title', coverImgUrl: cover, trackCount: 1234 }),
        playlist(10, 7, { coverImgUrl: 'javascript:alert(1)' }), playlist(11, 7, { trackCount: '0' })] });
    await f.actions.openPlaylistPicker(song(1));
    const rows = f.dialog().querySelectorAll('.song-actions-playlist');
    assert.equal(rows[0].querySelector('.song-actions-playlist-name').textContent, 'Long <playlist> title');
    assert.equal(rows[0].querySelector('.song-actions-playlist-count').textContent, '1234 首');
    assert.equal(rows[0].title, 'Long <playlist> title');
    const image = rows[0].querySelector('img');
    assert.equal(image.src, cover + '?param=100y100');
    assert.equal(image.loading, 'lazy'); assert.equal(image.decoding, 'async');
    assert.equal(image.width, 40); assert.equal(image.height, 40); assert.equal(image.alt, '');
    assert.equal(image.referrerPolicy, 'no-referrer');
    assert.equal(rows[1].querySelectorAll('img').length, 0);
    assert.equal(rows[1].querySelector('.song-actions-playlist-count').hidden, true);
    assert.equal(rows[2].querySelector('.song-actions-playlist-count').hidden, false);
    assert.equal(rows[2].querySelector('.song-actions-playlist-count').textContent, '0 首');
    image.dispatchEvent({ type: 'error' });
    assert.equal(image.hidden, true); assert.ok(rows[0].querySelector('.song-actions-playlist-cover'));
    assert.equal(f.calls.length, 0);
    f.dialog().close(); await f.actions.openPlaylistPicker(song(2));
    assert.equal(f.calls.length, 0, 'reopening reuses the same account playlist cache');
});

test('picker markup shares the cloud-music close style and list-only scrolling keeps it outside rows', async () => {
    const source = await fs.readFile(new URL('../src/netease/song-actions.js', import.meta.url), 'utf8');
    assert.match(source, /class="song-actions-close netease-close"/);
    const css = await fs.readFile(new URL('../src/styles/song-actions.css', import.meta.url), 'utf8');
    assert.match(css, /\.song-actions-dialog\[open\][^{]*\{[^}]*display: flex/);
    assert.match(css, /\.song-actions-list\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto/);
    assert.doesNotMatch(css, /\.song-actions-close:hover/);
});

test('partial shared playlists resume pagination and dedupe records without invoking the main loader', async t => {
    const shared = Array.from({ length: 30 }, (_, i) => playlist(i + 1));
    const f = fixture(t, { shared, complete: false });
    let fail = true;
    f.state.handler = call => {
        assert.equal(call.path, '/user/playlist');
        if (call.body.offset === 0) return { code: 200, playlist: shared, more: true };
        if (fail) return { code: 500 };
        return { code: 200, playlist: [playlist(31), playlist(32, 8)], more: false };
    };
    await f.myPlaylists.loadMyPlaylists(); await settle();
    assert.equal(f.myPlaylists.myPlaylistsComplete, false);
    f.myPlaylists.loadMyPlaylists = () => assert.fail('Must not use the main UI loader');
    fail = false;
    await f.actions.openPlaylistPicker(song(1));
    assert.deepEqual(f.calls.map(call => call.body.offset), [0, 30, 30]);
    assert.equal(f.dialog().querySelectorAll('.song-actions-playlist').length, 31);
});

test('unknown completeness loads every additional page and caches only in memory', async t => {
    const f = fixture(t, { complete: false }); delete f.myPlaylists.myPlaylistsComplete;
    f.state.handler = call => ({ status: 200, body: { code: 200,
        playlist: call.body.offset === 0 ? Array.from({ length: 30 }, (_, i) => playlist(i + 1)) : [playlist(31)],
        more: call.body.offset === 0 } });
    await f.actions.openPlaylistPicker(song(1));
    assert.deepEqual(f.calls.map(call => call.body.offset), [0, 30]);
    assert.equal(f.dialog().querySelectorAll('.song-actions-playlist').length, 31);
    f.dialog().close(); await f.actions.openPlaylistPicker(song(2)); assert.equal(f.calls.length, 2);
});

test('ordinary collection uses playlist/tracks op add and refuses non-owned target playlists', async t => {
    const f = fixture(t, { shared: [playlist(9), playlist(10, 8)] });
    assert.equal(await f.actions.addToPlaylist(song(1), '9'), true);
    assert.equal(f.calls[0].path, '/playlist/tracks'); assert.equal(f.calls[0].body.op, 'add');
    assert.equal(f.calls[0].body.tracks, '1'); assert.equal(f.calls[0].body.pid, 9);
    assert.equal(await f.actions.addToPlaylist(song(1), 10), false); assert.equal(f.calls.length, 1);
    assert.equal(f.invalidations.length, 0);
});

test('an uncertain add retry confirms membership without repeating the write', async t => {
    const f = fixture(t, { shared: [playlist(9)] });
    f.state.handler = () => { throw new TypeError('Network failed after committing'); };
    assert.equal(await f.actions.addToPlaylist(song(1), 9), false);
    f.state.handler = call => {
        assert.equal(call.path, '/playlist/detail');
        assert.equal(call.body.id, 9); assert.equal(call.body.s, 0);
        return { status: 200, body: playlistDetail([2, 1, 3]) };
    };
    assert.equal(await f.actions.addToPlaylist(song(1), 9), true);
    assert.deepEqual(f.calls.map(call => call.path), ['/playlist/tracks', '/playlist/detail']);
    assert.equal(f.result().kind, 'already'); assert.equal(f.message(), '');
    assert.equal(f.myPlaylists.myPlaylistsCache, null);
});

test('a complete absent result permits one explicit retry write, with no automatic retries', async t => {
    const f = fixture(t, { shared: [playlist(9)] });
    f.state.handler = () => ({ data: {} });
    assert.equal(await f.actions.addToPlaylist(song(1), 9), false);
    assert.equal(f.calls.length, 1);
    f.state.handler = call => call.path === '/playlist/detail'
        ? playlistDetail([], { trackCount: '0' }) : { code: 200 };
    assert.equal(await f.actions.addToPlaylist(song(1), 9), true);
    assert.deepEqual(f.calls.map(call => call.path), ['/playlist/tracks', '/playlist/detail', '/playlist/tracks']);
    assert.equal(f.result().kind, 'added'); assert.equal(f.message(), '');
});

test('failed confirmation preserves the uncertain marker for the next attempt', async t => {
    const f = fixture(t, { shared: [playlist(9)] });
    f.state.handler = () => { throw new TypeError('Network failed'); };
    assert.equal(await f.actions.addToPlaylist(song(1), 9), false);
    f.state.handler = () => ({ code: 500 });
    assert.equal(await f.actions.addToPlaylist(song(1), 9), false);
    f.state.handler = () => playlistDetail([1]);
    assert.equal(await f.actions.addToPlaylist(song(1), 9), true);
    assert.deepEqual(f.calls.map(call => call.path), ['/playlist/tracks', '/playlist/detail', '/playlist/detail']);
});

for (const [name, response] of [
    ['missing trackIds', { code: 200, playlist: { id: 9, trackCount: 1, tracks: [song(2)] } }],
    ['missing trackCount', { code: 200, playlist: { id: 9, trackIds: [{ id: 2 }] } }],
    ['null trackCount', playlistDetail([], { trackCount: null })],
    ['truncated IDs without the requested song', playlistDetail([2], { trackCount: 2 })],
    ['more IDs than the reported count', playlistDetail([2, 3], { trackCount: 1 })],
    ['wrong playlist identity', playlistDetail([1], { id: 10 })],
    ['missing playlist identity', playlistDetail([1], { id: undefined })],
    ['duplicate track IDs', playlistDetail([2, 2])],
    ['invalid track ID', playlistDetail([2, false])],
    ['explicit additional results', playlistDetail([2], { more: true })],
    ['empty partial result', playlistDetail([], { trackCount: 1 })],
    ['malformed count', playlistDetail([2], { trackCount: '1 item' })]
]) test(`uncertain add cannot write or claim membership with ${name}`, async t => {
    const f = fixture(t, { shared: [playlist(9)] });
    f.state.handler = () => { throw new TypeError('Network failed'); };
    assert.equal(await f.actions.addToPlaylist(song(1), 9), false);
    f.state.handler = () => response;
    assert.equal(await f.actions.addToPlaylist(song(1), 9), false);
    assert.equal(await f.actions.addToPlaylist(song(1), 9), false);
    assert.deepEqual(f.calls.map(call => call.path), ['/playlist/tracks', '/playlist/detail', '/playlist/detail']);
    assert.equal(f.result().kind, 'unconfirmed'); assert.equal(f.result().retry, 'check'); assert.equal(f.message(), '');
});

for (const [name, response] of [
    ['visible tracks without trackIds', { code: 200, playlist: { id: 9, trackCount: 2, tracks: [song(1)] } }],
    ['missing count', playlistDetail([1], { trackCount: undefined })],
    ['mismatched count', playlistDetail([1], { trackCount: 1000 })],
    ['duplicate IDs', playlistDetail([1, 1])],
    ['another invalid ID', playlistDetail([false, 1])],
    ['more pages', playlistDetail([1], { more: true })],
    ['malformed count', playlistDetail([1], { trackCount: 'unknown' })]
]) test(`positive membership is confirmed from ${name} without another write`, async t => {
    const f = fixture(t, { shared: [playlist(9)] });
    f.state.handler = () => { throw new TypeError('Network failed'); };
    assert.equal(await f.actions.addToPlaylist(song(1), 9), false);
    f.state.handler = () => response;
    assert.equal(await f.actions.addToPlaylist(song(1), 9), true);
    assert.equal(f.result().kind, 'already');
    assert.deepEqual(f.calls.map(call => call.path), ['/playlist/tracks', '/playlist/detail']);
    assert.equal(f.message(), '');
});

for (const failure of [{ code: 502 }, { code: 512 }, { code: 500, msg: '歌曲已存在，请勿重复收藏' }, { code: 500, msg: 'Song already exists' }]) {
    test(`duplicate response ${failure.code}/${failure.msg || 'code'} requires confirmed membership`, async t => {
        const f = fixture(t, { shared: [playlist(9)] });
        f.state.handler = call => call.path === '/playlist/tracks' ? { body: failure } : playlistDetail([1]);
        assert.equal(await f.actions.addToPlaylist(song(1), 9), true);
        assert.deepEqual(f.calls.map(call => call.path), ['/playlist/tracks', '/playlist/detail']);
        assert.equal(f.result().kind, 'already'); assert.equal(f.message(), '');
    });
}

test('duplicate codes alone cannot confirm success when complete membership is absent', async t => {
    const f = fixture(t, { shared: [playlist(9)] });
    f.state.handler = call => call.path === '/playlist/tracks' ? { code: 512 } : playlistDetail([2]);
    assert.equal(await f.actions.addToPlaylist(song(1), 9), false);
    assert.equal(f.result().kind, 'absent'); assert.equal(f.message(), '');
    assert.ok(f.logs.some(([message]) => message.includes('512')));
    assert.deepEqual(f.calls.map(call => call.path), ['/playlist/tracks', '/playlist/detail']);
    assert.equal(f.myPlaylists.myPlaylistsCache, 'rendered');
});

test('an unverifiable duplicate stays guarded and the next retry reads before any write', async t => {
    const f = fixture(t, { shared: [playlist(9)] });
    f.state.handler = call => call.path === '/playlist/tracks' ? { code: 502 } : playlistDetail([2], { trackCount: 2 });
    assert.equal(await f.actions.addToPlaylist(song(1), 9), false);
    f.state.handler = () => playlistDetail([1]);
    assert.equal(await f.actions.addToPlaylist(song(1), 9), true);
    assert.deepEqual(f.calls.map(call => call.path), ['/playlist/tracks', '/playlist/detail', '/playlist/detail']);
});

test('uncertain add records are isolated by song and playlist', async t => {
    const f = fixture(t, { shared: [playlist(9), playlist(10)] });
    f.state.handler = () => { throw new TypeError('Network failed'); };
    assert.equal(await f.actions.addToPlaylist(song(1), 9), false);
    f.state.handler = call => call.path === '/playlist/detail' ? playlistDetail([1]) : { code: 200 };
    assert.equal(await f.actions.addToPlaylist(song(1), 10), true);
    assert.equal(await f.actions.addToPlaylist(song(2), 9), true);
    assert.equal(await f.actions.addToPlaylist(song(1), 9), true);
    assert.deepEqual(f.calls.map(call => call.path), ['/playlist/tracks', '/playlist/tracks', '/playlist/tracks', '/playlist/detail']);
});

test('uncertain add memory is bounded without evicting unresolved writes', async t => {
    const f = fixture(t, { shared: [playlist(9)] });
    f.state.handler = () => { throw new TypeError('Network failed'); };
    for (let id = 1; id <= 200; id++) assert.equal(await f.actions.addToPlaylist(song(id), 9), false);
    assert.equal(await f.actions.addToPlaylist(song(201), 9), false);
    assert.equal(f.calls.length, 200); assert.match(f.result().message, /待确认的收藏过多/); assert.equal(f.message(), '');
    f.state.handler = call => call.path === '/playlist/detail' ? playlistDetail([1]) : { code: 200 };
    assert.equal(await f.actions.addToPlaylist(song(1), 9), true);
    assert.equal(await f.actions.addToPlaylist(song(201), 9), true);
    assert.deepEqual(f.calls.slice(-2).map(call => call.path), ['/playlist/detail', '/playlist/tracks']);
});

test('reset clears uncertain adds and stale confirmation cannot write for the next account', async t => {
    const f = fixture(t, { shared: [playlist(9)] }), response = deferred();
    f.state.handler = () => { throw new TypeError('Network failed'); };
    assert.equal(await f.actions.addToPlaylist(song(1), 9), false);
    f.state.handler = () => response.promise;
    const retry = f.actions.addToPlaylist(song(1), 9); await settle();
    assert.equal(f.calls.at(-1).path, '/playlist/detail');
    f.auth.generation++; f.actions.reset(); f.auth.neteaseCookie = 'MUSIC_U=another-synthetic';
    assert.equal(await retry, false);
    f.state.handler = () => ({ code: 200 });
    assert.equal(await f.actions.addToPlaylist(song(1), 9), true);
    response.resolve(playlistDetail([])); await settle();
    assert.deepEqual(f.calls.map(call => call.path), ['/playlist/tracks', '/playlist/detail', '/playlist/tracks']);
    assert.equal(f.result().kind, 'added'); assert.equal(f.message(), '');
});

test('specialType 5 collection uses redheart like endpoint, not playlist/tracks', async t => {
    const f = fixture(t, { shared: [playlist(9, 7, { specialType: 5 })] });
    const menu = f.menu();
    assert.equal(await f.actions.addToPlaylist(song(1), 9), true);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/song/like'); assert.equal(f.calls[0].body.like, 'true');
    assert.equal(menu.querySelector('[data-song-like]').getAttribute('aria-pressed'), 'true');
});

test('post-write invalidation invokes an optional hook without requiring unknown static service members', async t => {
    const f = fixture(t, { shared: [playlist(9)] }), writes = [];
    f.myPlaylists.invalidateAfterSongWrite = detail => writes.push(detail);
    assert.equal(await f.actions.addToPlaylist(song(1), 9), true);
    assert.deepEqual(writes, [{ songId: 1, playlistId: 9, liked: undefined }]);
});

test('a targeted cache invalidation failure never purges public caches or misreports a committed write', async t => {
    const f = fixture(t, { shared: [playlist(9)] });
    f.myPlaylists.invalidateAfterSongWrite = () => Promise.reject(new Error('cookie=secret'));
    assert.equal(await f.actions.addToPlaylist(song(1), 9), true); await settle();
    assert.equal(f.invalidations.length, 0); assert.equal(f.logs.length, 1);
    assert.equal(f.logs.flat().join().includes('secret'), false);
});

test('playlist failure cannot masquerade as success or invalidate caches', async t => {
    const f = fixture(t, { shared: [playlist(9)] });
    f.state.handler = () => ({ code: 200, data: { code: 500 } });
    assert.equal(await f.actions.addToPlaylist(song(1), 9), false); assert.equal(f.invalidations.length, 0);
    assert.equal(f.result().kind, 'unconfirmed'); assert.equal(f.message(), '');
});

test('picker supports inline load error, retry, safe text labels and empty state', async t => {
    const f = fixture(t, { complete: false }); let fail = true;
    f.state.handler = () => fail ? { code: 500 } : { code: 200, playlist: [playlist(9, 7, { name: '<img onerror=secret>' })], more: false };
    await f.actions.openPlaylistPicker({ id: 1, name: '<script>secret</script>' });
    assert.equal(f.dialog().querySelector('.song-actions-retry').hidden, false);
    assert.match(f.dialog().querySelector('.song-actions-status').textContent, /加载失败/);
    fail = false; f.dialog().querySelector('.song-actions-retry').dispatchEvent({ type: 'click' }); await settle();
    assert.equal(f.dialog().querySelector('.song-actions-retry').hidden, true);
    assert.equal(f.dialog().querySelector('.song-actions-playlist-name').textContent, '<img onerror=secret>');
    assert.equal(f.dialog().querySelector('.song-actions-song').textContent, '<script>secret</script>');
    f.actions.reset(); f.myPlaylists.invalidateAfterSongWrite();
    f.state.handler = () => ({ code: 200, playlist: [], more: false });
    await f.actions.openPlaylistPicker(song(2)); assert.match(f.dialog().querySelector('.song-actions-status').textContent, /暂无/);
});

test('picker mutation failure stays open with retry and pending rows disabled, success closes it', async t => {
    const f = fixture(t, { shared: [playlist(9)] }), response = deferred();
    await f.actions.openPlaylistPicker(song(1));
    f.state.handler = () => response.promise;
    f.dialog().querySelector('.song-actions-playlist').dispatchEvent({ type: 'click' }); await settle();
    assert.equal(f.dialog().querySelector('.song-actions-playlist').disabled, true);
    response.resolve({ code: 500 }); await settle();
    assert.equal(f.dialog().open, true); assert.equal(f.dialog().querySelector('.song-actions-retry').hidden, false);
    assert.equal(f.dialog().querySelector('.song-actions-playlist').disabled, false);
    assert.equal(f.dialog().querySelector('.song-actions-retry').textContent, '检查收藏状态');
    assert.equal(f.message(), '');
    f.state.handler = call => call.path === '/playlist/detail' ? playlistDetail([]) : { code: 200 };
    f.dialog().querySelector('.song-actions-retry').dispatchEvent({ type: 'click' }); await settle();
    assert.equal(f.dialog().open, true);
    assert.equal(f.dialog().querySelector('.song-actions-retry').textContent, '重新收藏');
    assert.equal(f.calls.filter(call => call.path === '/playlist/tracks').length, 1);
    f.dialog().querySelector('.song-actions-retry').dispatchEvent({ type: 'click' }); await settle();
    assert.equal(f.dialog().open, false); assert.equal(f.message(), '');
    assert.equal(f.calls.filter(call => call.path === '/playlist/tracks').length, 2);
});

test('picker retry confirms an uncertain addition, closes and restores focus without another write', async t => {
    const f = fixture(t, { shared: [playlist(9)] });
    f.actions.setCurrentTrack(track(1)); await settle();
    f.nodes['track-collect'].focus();
    await f.actions.openPlaylistPicker(song(1));
    f.state.handler = () => { throw new TypeError('Network failed after committing'); };
    f.dialog().querySelector('.song-actions-playlist').dispatchEvent({ type: 'click' }); await settle();
    assert.equal(f.dialog().open, true); assert.equal(f.dialog().querySelector('.song-actions-retry').hidden, false);
    f.state.handler = () => playlistDetail([1]);
    f.dialog().querySelector('.song-actions-retry').dispatchEvent({ type: 'click' }); await settle();
    assert.equal(f.dialog().open, false); assert.equal(f.message(), '');
    assert.equal(f.doc.activeElement, f.nodes['track-collect']);
    assert.equal(f.calls.filter(call => call.path === '/playlist/tracks').length, 1);
});

for (const [body, kind] of [
    [{ code: 502, msg: '参数错误' }, 'invalid'],
    [{ code: 512, msg: '歌单已满' }, 'full'],
    [{ code: 500, msg: '没有权限' }, 'forbidden'],
    [{ code: 502, msg: '歌曲不存在' }, 'unavailable'],
    [{ code: 429, msg: '请求过于频繁' }, 'rate-limited']
]) test(`definite ${kind} errors stay local and do not trigger duplicate verification`, async t => {
    const f = fixture(t, { shared: [playlist(9)] });
    f.state.handler = () => body;
    assert.equal(await f.actions.addToPlaylist(song(1), 9), false);
    assert.equal(f.result().kind, kind); assert.equal(f.result().retry, null);
    assert.deepEqual(f.calls.map(call => call.path), ['/playlist/tracks']);
    assert.equal(f.message(), '');
});

test('picker confirms a partial positive response without showing the old main-page warning', async t => {
    const f = fixture(t, { shared: [playlist(9)] });
    f.state.handler = call => call.path === '/playlist/tracks' ? { code: 512 }
        : playlistDetail([1], { trackCount: 4000, more: true });
    await f.actions.openPlaylistPicker(song(1));
    f.dialog().querySelector('.song-actions-playlist').dispatchEvent({ type: 'click' }); await settle();
    assert.equal(f.dialog().open, false); assert.equal(f.message(), '');
    assert.deepEqual(f.calls.map(call => call.path), ['/playlist/tracks', '/playlist/detail']);
});

test('unconfirmed membership stays inside the picker and records only safe diagnostics', async t => {
    const f = fixture(t, { shared: [playlist(9)] });
    f.state.handler = call => call.path === '/playlist/tracks' ? { code: 502, msg: 'cookie=synthetic-secret' }
        : playlistDetail([2], { trackCount: 100 });
    await f.actions.openPlaylistPicker(song(1));
    f.dialog().querySelector('.song-actions-playlist').dispatchEvent({ type: 'click' }); await settle();
    assert.equal(f.dialog().open, true); assert.equal(f.message(), '');
    assert.match(f.dialog().querySelector('.song-actions-status').textContent, /暂时无法确认收藏状态/);
    assert.equal(f.dialog().querySelector('.song-actions-retry').textContent, '检查收藏状态');
    assert.ok(f.logs.some(([message]) => message.includes('100') && message.includes('ID 数量 1')));
    assert.doesNotMatch(JSON.stringify(f.logs), /synthetic|cookie|secret/);
    f.state.handler = () => playlistDetail([1]);
    f.dialog().querySelector('.song-actions-retry').dispatchEvent({ type: 'click' }); await settle();
    assert.equal(f.dialog().open, false);
    assert.equal(f.calls.filter(call => call.path === '/playlist/tracks').length, 1);
});

test('picker login recovery is explicit and never resumes a collection automatically', async t => {
    const f = fixture(t, { shared: [playlist(9)] }); let logins = 0;
    f.auth.showLogin = () => { logins++; };
    f.state.handler = () => ({ code: 301 });
    await f.actions.openPlaylistPicker(song(1));
    f.dialog().querySelector('.song-actions-playlist').dispatchEvent({ type: 'click' }); await settle();
    assert.equal(f.dialog().querySelector('.song-actions-retry').textContent, '重新登录');
    assert.equal(f.message(), ''); assert.equal(logins, 0);
    f.dialog().querySelector('.song-actions-retry').dispatchEvent({ type: 'click' }); await settle();
    assert.equal(logins, 1); assert.equal(f.dialog().open, false); assert.equal(f.calls.length, 1);
});

test('special liked playlist checks an uncertain like without writing it again', async t => {
    const f = fixture(t, { shared: [playlist(9, 7, { specialType: 5 })] });
    const handler = f.state.handler;
    f.state.handler = call => {
        if (call.path === '/song/like') { f.liked.add(1); throw new TypeError('Network failed'); }
        return handler(call);
    };
    await f.actions.openPlaylistPicker(song(1));
    f.dialog().querySelector('.song-actions-playlist').dispatchEvent({ type: 'click' }); await settle();
    assert.equal(f.dialog().querySelector('.song-actions-retry').textContent, '检查收藏状态');
    f.dialog().querySelector('.song-actions-retry').dispatchEvent({ type: 'click' }); await settle();
    assert.equal(f.dialog().open, false); assert.equal(f.message(), '');
    assert.deepEqual(f.calls.map(call => call.path), ['/song/like', '/song/like/check']);
});

test('a fresh liked-playlist verification cannot be overwritten by an older check', async t => {
    const f = fixture(t, { shared: [playlist(9, 7, { specialType: 5 })] }), response = deferred();
    let checks = 0;
    f.state.handler = call => {
        assert.equal(call.path, '/song/like/check');
        return ++checks === 1 ? response.promise : { code: 200, data: [1] };
    };
    f.actions.setCurrentTrack(track(1)); await settle();
    assert.equal(await f.actions.addToPlaylist(song(1), 9, { verifyOnly: true }), true);
    assert.equal(f.nodes['track-like'].getAttribute('aria-pressed'), 'true');
    response.resolve({ code: 200, data: [] }); await settle();
    assert.equal(f.nodes['track-like'].getAttribute('aria-pressed'), 'true');
    assert.equal(f.calls.length, 2); assert.equal(f.message(), '');
});

test('late collection errors never overwrite a newly opened picker', async t => {
    const f = fixture(t, { shared: [playlist(9)] }), response = deferred();
    f.state.handler = () => response.promise;
    await f.actions.openPlaylistPicker(song(1));
    f.dialog().querySelector('.song-actions-playlist').dispatchEvent({ type: 'click' }); await settle();
    f.dialog().querySelector('.song-actions-close').dispatchEvent({ type: 'click' });
    await f.actions.openPlaylistPicker(song(2));
    response.resolve({ code: 500 }); await settle();
    assert.equal(f.dialog().open, true);
    assert.equal(f.dialog().querySelector('.song-actions-song').textContent, 'Song 2');
    assert.equal(f.dialog().querySelector('.song-actions-status').textContent, '');
    assert.equal(f.message(), '');
});

test('Escape/close returns focus, detaches the picker and ignores late shared responses', async t => {
    const f = fixture(t, { complete: false }), response = deferred();
    f.actions.setCurrentTrack(track(1)); await settle();
    f.state.handler = () => response.promise;
    const opener = f.nodes['track-collect']; opener.focus();
    const opening = f.actions.openPlaylistPicker(song(1)); await settle();
    assert.equal(f.doc.activeElement, f.dialog().querySelector('.song-actions-close'));
    let prevented = false; f.dialog().dispatchEvent({ type: 'cancel', preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(f.dialog().open, false); assert.equal(f.doc.activeElement, opener);
    assert.equal(f.calls.at(-1).options.signal.aborted, false); assert.equal(await opening, false);
    response.resolve({ code: 200, playlist: [playlist(9)], more: false }); await settle();
    assert.equal(f.dialog().querySelectorAll('.song-actions-playlist').length, 0);
});

test('rapid picker reopen ignores an old asynchronous native close event', async t => {
    const f = fixture(t, { shared: [playlist(9)] }); await f.actions.openPlaylistPicker(song(1));
    f.dialog().close = function() { this.open = false; };
    await f.actions.openPlaylistPicker(song(2));
    f.dialog().dispatchEvent({ type: 'close' });
    assert.equal(f.dialog().open, true); assert.equal(f.dialog().querySelectorAll('.song-actions-playlist').length, 1);
});

test('reset cancels every read/write, clears account memory and closes picker without stale UI resurrection', async t => {
    const f = fixture(t, { complete: false }), response = deferred();
    f.actions.setCurrentTrack(track(1)); await settle(); f.state.handler = () => response.promise;
    const mutation = f.actions.toggleLike(song(1)), opening = f.actions.openPlaylistPicker(song(1)); await settle();
    f.auth.generation++; f.auth.neteaseUser = null; f.auth.neteaseCookie = ''; f.actions.reset(); f.myPlaylists.reset();
    assert.equal(await mutation, false); assert.equal(await opening, false);
    assert.equal(f.dialog().open, false); assert.equal(f.nodes['track-like'].hidden, true);
    assert.equal(f.dialog().querySelector('.song-actions-song').textContent, '');
    assert.equal(f.dialog().querySelector('.song-actions-status').textContent, '');
    assert.equal(f.auth.accountAbortControllers.size, 0); assert.equal(f.message(), '');
    response.resolve({ code: 200, playlist: [playlist(9)], more: false }); await settle();
    assert.equal(f.message(), ''); assert.equal(f.invalidations.length, 0);
});

test('a queued mutation cannot optimistically resurrect state after reset', async t => {
    const f = fixture(t); await f.actions.checkLikes([1]);
    const mutation = f.actions.toggleLike(song(1)); f.actions.reset();
    assert.equal(await mutation, false); assert.equal(f.calls.length, 1);
    assert.equal((await f.actions.checkLikes([1])).get(1), false);
});

test('account changes without an explicit reset never accept an old read or write', async t => {
    const f = fixture(t), response = deferred(); f.state.handler = () => response.promise;
    const check = f.actions.checkLikes([1]); await settle(); f.auth.generation++; f.auth.neteaseUser = { userId: 8 };
    response.resolve({ code: 200, data: [1] }); assert.equal((await check).size, 0);
    f.state.handler = () => ({ code: 200, data: [] }); assert.equal((await f.actions.checkLikes([1])).get(1), false);
});

test('track changes do not let a late write change the new track status or controls', async t => {
    const f = fixture(t), response = deferred(); f.actions.setCurrentTrack(track(1)); await settle(); const old = f.state.handler;
    f.state.handler = call => call.path === '/song/like' ? response.promise : old(call);
    const mutation = f.actions.toggleLike(song(1)); await settle(); f.actions.setCurrentTrack(track(2)); await settle();
    response.resolve({ code: 200 }); assert.equal(await mutation, true);
    assert.equal(f.nodes['track-like'].getAttribute('aria-pressed'), 'false'); assert.equal(f.message(), '');
});

test('pathological playlist paging stops with inline retry instead of an infinite loop', async t => {
    const f = fixture(t, { complete: false });
    f.state.handler = () => ({ code: 200, playlist: Array.from({ length: 30 }, (_, i) => playlist(i + 1)), more: true });
    await f.actions.openPlaylistPicker(song(1));
    assert.equal(f.calls.length, 2); assert.equal(f.dialog().querySelector('.song-actions-retry').hidden, false);
});

test('CSS is scoped and provides 44px hit areas and constrained mobile dialog overflow', async () => {
    const css = await fs.readFile(new URL('../src/styles/song-actions.css', import.meta.url), 'utf8');
    assert.match(css, /min-height: 44px/); assert.match(css, /100dvh/); assert.match(css, /overflow-wrap: anywhere/);
    assert.match(css, /border-radius: 8px/); assert.match(css, /focus-visible/);
    assert.doesNotMatch(css, /(?:^|\n)(?:body|button|dialog|svg|h2)\s*\{/);
});

test('shared favorite controls stay anchored to the playback row without duplicating desktop/mobile actions', async () => {
    const html = await fs.readFile(new URL('../src/index.html', import.meta.url), 'utf8');
    const header = html.slice(html.indexOf('<div class="track-header">'), html.indexOf('<div class="lyrics-area">'));
    const controls = html.slice(html.indexOf('<div class="controls-row">'), html.indexOf('<footer class="project-footer"'));
    assert.doesNotMatch(header, /id="track-(?:like|collect|song-actions)"/);
    assert.ok(controls.indexOf('id="track-song-actions"') > controls.indexOf('id="lyric-toggle-btn"'));
    for (const id of ['track-song-actions', 'track-like', 'track-collect']) {
        assert.equal(html.split(`id="${id}"`).length - 1, 1);
        assert.ok(controls.includes(`id="${id}"`));
    }
    assert.match(controls, /id="track-collect"[^>]*class="btn"[^>]*aria-label="加入歌单"/);
});

test('desktop favorites share the mobile glass capsule and leave the playback row while mobile stays left-aligned', async () => {
    const css = await fs.readFile(new URL('../src/styles/song-actions.css', import.meta.url), 'utf8');
    const desktop = css.slice(css.indexOf('@media (min-width: 901px)'), css.indexOf('@media (max-width: 900px)'));
    const mobile = css.slice(css.indexOf('@media (max-width: 900px)'), css.indexOf('.song-actions-dialog {'));
    assert.match(css, /\.track-song-actions\s*\{[^}]*position: absolute;[^}]*flex-direction: column/);
    assert.match(css, /\.controls-row \.track-song-actions \.btn\s*\{[^}]*width: 44px; height: 44px/);
    assert.match(desktop, /\.track-song-actions\s*\{\s*right: 0; bottom:/);
    assert.match(desktop, /bottom: calc\(100% \+ clamp\(52px, calc\(10vh - 24px\), 72px\)\)/);
    assert.doesNotMatch(desktop, /display: none|--controls-width|gap:/);
    assert.match(mobile, /left: 0; bottom: calc\(100% \+ 6px\)/);
});

test('desktop capsule is dim by default and wakes on hover, keyboard focus and account operations', async () => {
    const css = await fs.readFile(new URL('../src/styles/song-actions.css', import.meta.url), 'utf8');
    const idle = css.slice(css.indexOf('@media (min-width: 901px) and (hover: hover)'), css.indexOf('@media (max-width: 900px)'));
    assert.match(idle, /\.track-song-actions\s*\{\s*opacity: \.3; transition: opacity 800ms/);
    assert.match(idle, /\.track-song-actions:hover,/);
    assert.match(idle, /opacity: 1; transition-duration: 150ms/);
    assert.match(idle, /:has\(\[aria-busy="true"\]\)/);
    assert.match(idle, /:has\(:focus-visible\)/);
    assert.doesNotMatch(idle, /pointer-events|display: none|will-change|transform|backdrop-filter/);
    assert.doesNotMatch(css, /song-actions-idle|:focus-within/);
});

test('capsule visibility does not subscribe to toolbar activity or playback status', async () => {
    const toolbar = await fs.readFile(new URL('../src/ui/toolbar-visibility.js', import.meta.url), 'utf8');
    const controls = await fs.readFile(new URL('../src/ui/controls.js', import.meta.url), 'utf8');
    assert.doesNotMatch(toolbar, /capsule|song-actions-idle/);
    assert.doesNotMatch(controls, /capsule:/);
});
