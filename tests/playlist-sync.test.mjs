import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaylistSync } from '../src/netease/playlist-sync.js';
import { createPersistence } from '../src/storage/playlist.js';
import { pickNewestPlaylistState } from '../src/storage/playlist-schema.js';
import { createHost, FakeElement } from './helpers/host.mjs';
import { createPlaylistView } from '../src/playlist/view.js';
import { PlaybackPlan } from '../src/playlist/plan.js';

const song = (id, extra = {}) => ({ id, name: `Song ${id}`, ar: [{ id: 8, name: 'Artist' }],
    al: { id: 9, name: 'Album', picUrl: `https://cover.test/${id}.jpg` }, dt: 120000, ...extra });
const entry = id => ({ netease: true, songId: id, songData: song(id), name: `Song ${id} - Artist`, detailCheckedAt: Date.now() });
const source = { type: 'netease-playlist', id: '436233910', loadedCount: 3, totalCount: 3, loading: false };
const reply = (ids, tracks = []) => ({ code: 200, playlist: { trackCount: ids.length, trackIds: ids.map(id => ({ id })), tracks } });
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

function fixture(ids = [1, 2, 3]) {
    const calls = [], events = [], changes = [];
    const queue = { playlist: ids.map(entry), curIdx: Math.min(1, ids.length - 1) };
    const auth = { authGeneration: 1, neteaseCookie: 'MUSIC_U=synthetic-only', accountAbortControllers: new Set() };
    const state = { handler: url => url.pathname === '/playlist/detail' ? reply(ids) : { code: 200, songs: [] }, visible: [] };
    const services = {
        api: { buildApiUrl: path => `https://api.test${path}` }, auth,
        cache: { cachedFetchJson: async (raw, options) => { const url = new URL(raw); calls.push({ url, options }); return state.handler(url, options); } },
        content: { setMainMusicEntityLinks: () => events.push('links'), updateMusicMiniPlayer: () => events.push('mini') },
        covers: { setMainCover: () => events.push('cover') },
        debug: { log: text => events.push(text) }, dom: { el: { title: new FakeElement() } },
        lyrics: { setArtistTag: (...args) => events.push(['artist', ...args]) },
        metadata: { currentAudioQuality: 'MP3 192kbps', updateMediaSession: () => events.push('media') },
        persistence: { schedulePlaylistStateSave: () => events.push('save') },
        playback: { playbackState: { status: 'idle' }, stopAudio: status => events.push(`stop:${status}`), setPlaybackStatus: status => events.push(`status:${status}`) },
        playlistView: { getVisiblePlaylistIndexes: () => state.visible,
            renderPlaylist: () => events.push('render'), refreshPlaylistItem: index => changes.push(index) },
        prefetch: { cancelNextPreload: () => events.push('cancel-next') }, queue,
        transfer: { withRequestTimeout: (signal, ms, message, work) => work(signal) }
    };
    const sync = createPlaylistSync(services);
    return { ...services, sync, calls, events, changes, state };
}

test('unchanged restored playlist makes one low-priority check without rebuilding rows or covers', async () => {
    const f = fixture(), tracks = f.queue.playlist.slice(), data = tracks.map(track => track.songData);
    await f.sync.restore(source, f.queue.playlist);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url.pathname, '/playlist/detail');
    assert.equal(f.calls[0].options.priority, 'idle');
    assert.equal(f.calls[0].options.cacheScope, 'none');
    assert.deepEqual(f.queue.playlist, tracks);
    assert.ok(f.queue.playlist.every((track, index) => track === tracks[index] && track.songData === data[index]));
    assert.equal(f.events.includes('render'), false); assert.equal(f.events.includes('cover'), false);
    assert.equal(f.auth.accountAbortControllers.size, 0);
    assert.equal(f.sync.getSource().id, source.id);
});

test('manual queue does not detach the source or let a base refresh replace active manual playback', async () => {
    const f = fixture(), model = new PlaybackPlan(); model.reset(f.queue.playlist); model.select(0);
    Object.defineProperties(f.queue, {
        playlist: { get: () => model.items }, basePlaylist: { get: () => model.base },
        curIdx: { get: () => model.index, set: index => model.setIndex(index) },
        baseCurIdx: { get: () => model.baseIndex }, isTemporary: { get: () => model.isTemporary }
    });
    f.queue.reconcileBasePlaylist = index => model.reconcile(index);
    f.sync.remember(source, model.base);
    const manual = entry(90); model.playNow(manual); model.enqueue([entry(91)]);
    assert.equal(f.sync.getSource().id, source.id);
    f.playback.playbackState.status = 'playing';
    f.state.handler = () => reply([3, 1, 2], [song(1, { name: 'Changed base title' })]);
    await f.sync.restore(source, model.base);
    assert.equal(model.current, manual); assert.equal(f.sync.getSource().id, source.id);
    assert.deepEqual(model.base.map(track => track.songId), [3, 1, 2]);
    assert.equal(f.events.includes('cover'), false); assert.equal(model.pending[0].songId, 91);
});

test('removing a base anchor during manual playback resumes at its surviving next song', async () => {
    const f = fixture(), model = new PlaybackPlan(); model.reset(f.queue.playlist); model.select(0);
    Object.defineProperties(f.queue, {
        playlist: { get: () => model.items }, basePlaylist: { get: () => model.base },
        curIdx: { get: () => model.index, set: index => model.setIndex(index) },
        baseCurIdx: { get: () => model.baseIndex }, isTemporary: { get: () => model.isTemporary }
    });
    f.queue.reconcileBasePlaylist = index => model.reconcile(index);
    model.playNow(entry(90)); f.playback.playbackState.status = 'playing';
    f.state.handler = () => reply([3, 2]);
    await f.sync.restore(source, model.base);
    assert.equal(model.current.songId, 90);
    assert.deepEqual(model.base.map(track => track.songId), [3, 2]);
    assert.equal(model.items[model.nextIndex()].songId, 2);
});

test('all ordered IDs, not just count, drive add/remove/reorder; only new details are requested', async () => {
    const f = fixture(), current = f.queue.playlist[1], oldThird = f.queue.playlist[2], queueRef = f.queue.playlist;
    f.playback.playbackState.status = 'playing';
    f.state.handler = url => url.pathname === '/playlist/detail' ? reply([3, 4, 2]) : { code: 200, songs: [song(4)] };
    await f.sync.restore(source, queueRef);
    assert.equal(f.queue.playlist, queueRef); assert.deepEqual(queueRef.map(track => track.songId), [3, 4, 2]);
    assert.equal(queueRef[0], oldThird); assert.equal(queueRef[2], current); assert.equal(f.queue.curIdx, 2);
    assert.equal(f.calls[1].url.searchParams.get('ids'), '4');
    assert.equal(f.events.some(event => typeof event === 'string' && event.startsWith('stop:')), false);
});

test('unchanged duplicate IDs preserve object order and the selected occurrence', async () => {
    const f = fixture([1, 1, 2]), original = f.queue.playlist.slice();
    await f.sync.restore(source, f.queue.playlist);
    assert.ok(f.queue.playlist.every((track, index) => track === original[index]));
    assert.equal(f.queue.curIdx, 1); assert.equal(f.events.includes('render'), false);
});

test('reducing duplicate occurrences retains the active object rather than another copy', async () => {
    const f = fixture([1, 1, 2]), selected = f.queue.playlist[1];
    f.playback.playbackState.status = 'paused';
    f.state.handler = () => reply([1, 2]);
    await f.sync.restore(source, f.queue.playlist);
    assert.equal(f.queue.playlist[0], selected); assert.equal(f.queue.curIdx, 0);
});

test('removed playing track finishes uninterrupted and is removed when choosing another song', async () => {
    const f = fixture(), selected = f.queue.playlist[1];
    f.playback.playbackState.status = 'playing'; f.state.handler = () => reply([3, 1]);
    await f.sync.restore(source, f.queue.playlist);
    assert.equal(f.queue.playlist[f.queue.curIdx], selected);
    const target = f.queue.playlist[2], index = f.sync.resolveSelection(2);
    assert.equal(f.queue.playlist[index], target); assert.deepEqual(f.queue.playlist.map(track => track.songId), [3, 1]);
    assert.equal(f.sync.getSource().totalCount, 2);
    assert.equal(f.events.some(event => typeof event === 'string' && event.startsWith('stop:')), false);
});

test('valid empty remote playlist clears idle snapshot but lets current playback finish first', async () => {
    for (const active of [false, true]) {
        const f = fixture(); f.state.handler = () => reply([]);
        if (active) f.playback.playbackState.status = 'playing';
        await f.sync.restore(source, f.queue.playlist);
        assert.equal(f.queue.playlist.length, active ? 1 : 0);
        assert.equal(f.sync.getSource().totalCount, 0);
        if (active) {
            assert.equal(f.sync.finishEmptyQueue(), true);
            assert.equal(f.queue.playlist.length, 0); assert.ok(f.events.includes('stop:idle'));
        }
    }
});

test('unlinked, local and invalid-source queues never start a network refresh', async () => {
    for (const invalid of [null, { type: 'album', id: '9' }, { ...source, id: 'bad' }]) {
        const f = fixture(); await f.sync.restore(invalid, f.queue.playlist); assert.equal(f.calls.length, 0);
    }
    const f = fixture(); f.queue.playlist.push({ name: 'local.wav' });
    await f.sync.restore(source, f.queue.playlist); assert.equal(f.calls.length, 0);
});

test('metadata refresh is bounded to stale current/visible songs, not the whole large playlist', async () => {
    const ids = Array.from({ length: 2000 }, (_, index) => index + 1), f = fixture(ids);
    f.queue.playlist.forEach(track => { track.detailCheckedAt = 1; });
    f.state.visible = [100, 101];
    f.state.handler = url => url.pathname === '/playlist/detail' ? reply(ids)
        : { code: 200, songs: url.searchParams.get('ids').split(',').map(id => song(Number(id))) };
    await f.sync.restore(source, f.queue.playlist);
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].url.searchParams.get('ids'), '2,101,102');
    assert.equal(f.events.includes('render'), false); assert.equal(f.events.includes('cover'), false);
});

test('same cover metadata changes do not reload the image, changed cover updates once', async () => {
    for (const changeCover of [false, true]) {
        const f = fixture(), selected = f.queue.playlist[1];
        f.state.handler = () => reply([1, 2, 3], [song(2, { name: 'Renamed',
            ...(changeCover ? { al: { id: 9, name: 'Album', picUrl: 'https://cover.test/new.jpg' } } : {}) })]);
        await f.sync.restore(source, f.queue.playlist);
        assert.equal(f.queue.playlist[1], selected); assert.equal(f.dom.el.title.textContent, 'Renamed');
        assert.equal(f.events.filter(event => event === 'cover').length, changeCover ? 1 : 0);
        assert.deepEqual(f.events.find(event => Array.isArray(event) && event[0] === 'artist'), ['artist', '网易云', 'MP3 192kbps']);
        assert.equal(f.events.includes('render'), false);
    }
});

test('source survives queue saves but detaches on manual array mutation', () => {
    const f = fixture(); f.sync.remember(source);
    assert.equal(f.sync.getSource().id, source.id);
    f.queue.playlist.reverse(); assert.equal(f.sync.getSource(), null);
});

test('visible metadata selection respects the sidebar viewport, filtering and the 20-song cap', t => {
    const sidebar = new FakeElement(), container = new FakeElement();
    const host = createHost().host;
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: host });
    t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : delete globalThis.window);
    sidebar.getBoundingClientRect = () => ({ top: 0, bottom: 1000 });
    container.children = Array.from({ length: 100 }, (_, index) => {
        const row = new FakeElement();
        row.hidden = index % 2 === 0;
        row.getBoundingClientRect = () => ({ top: index * 10 - 100, bottom: index * 10 - 90 });
        return row;
    });
    const view = createPlaylistView({ dom: { el: { plSidebar: sidebar, plContainer: container } }, queue: { playlist: [] } });
    assert.deepEqual(view.getVisiblePlaylistIndexes(), []);
    sidebar.classList.add('show');
    const visible = view.getVisiblePlaylistIndexes();
    assert.equal(visible.length, 20); assert.equal(visible[0], 11);
    assert.ok(visible.every(index => index % 2 === 1));
});

test('delayed response cannot overwrite a new queue, in-place edits, or changed account', async () => {
    for (const change of ['queue', 'edit', 'generation', 'cookie', 'abort']) {
        const f = fixture(); let release;
        f.state.handler = () => new Promise(resolve => { release = resolve; });
        const promise = f.sync.restore(source, f.queue.playlist);
        if (change === 'queue') f.queue.playlist = [entry(90)];
        if (change === 'edit') f.queue.playlist.reverse();
        if (change === 'generation') f.auth.authGeneration++;
        if (change === 'cookie') f.auth.neteaseCookie = '';
        if (change === 'abort') for (const controller of f.auth.accountAbortControllers) controller.abort();
        const expected = f.queue.playlist.slice();
        release(reply([4], [song(4)])); await promise;
        assert.deepEqual(f.queue.playlist, expected, change); assert.equal(f.events.includes('render'), false, change);
    }
});

test('offline, unavailable or incomplete responses preserve the entire local snapshot', async () => {
    for (const response of [new Error('offline'), { code: 403 }, { code: 200, playlist: { trackCount: 3 } },
        { code: 200, playlist: { trackCount: 3, trackIds: [{ id: 1 }] } }, reply([0]), reply([4])]) {
        const f = fixture(), expected = f.queue.playlist.slice();
        f.state.handler = url => { if (response instanceof Error) throw response;
            return url.pathname === '/playlist/detail' ? response : { code: 200, songs: [] }; };
        await f.sync.restore(source, f.queue.playlist);
        assert.deepEqual(f.queue.playlist, expected); assert.equal(f.events.includes('render'), false);
    }
});

test('only missing new IDs are batched, sequentially, at no more than 64 IDs', async () => {
    const ids = Array.from({ length: 140 }, (_, index) => index + 1), f = fixture();
    f.state.handler = url => url.pathname === '/playlist/detail' ? reply(ids, [song(4), song(5)])
        : { code: 200, songs: url.searchParams.get('ids').split(',').map(id => song(Number(id))) };
    await f.sync.restore(source, f.queue.playlist);
    assert.equal(f.calls.length, 4);
    const batches = f.calls.slice(1).map(call => call.url.searchParams.get('ids').split(',').map(Number));
    assert.deepEqual(batches.map(batch => batch.length), [64, 64, 7]);
    assert.ok(batches.flat().every(id => id > 5));
});

test('freshness and empty linked snapshots survive normalization without reviving older lists', () => {
    const old = { schema: 3, listId: 'old', revision: 1, tracks: [{ type: 'netease', id: 1, title: 'A', detailCheckedAt: 100 }] };
    assert.equal(pickNewestPlaylistState(old).tracks[0].detailCheckedAt, 100);
    const empty = { schema: 3, listId: 'empty', revision: 2, source, tracks: [] };
    assert.equal(pickNewestPlaylistState(old, empty).listId, 'empty');
    assert.equal(pickNewestPlaylistState({ ...empty, source: null }), null);
});

test('persistence restores immediately, hands source to background sync, and saves it again', async t => {
    const host = createHost().host, selected = song(2), queue = { playlist: [], curIdx: -1 };
    const saved = { schema: 3, revision: 1, savedAt: 1, listId: 'restore', selectedIndex: 0, source,
        tracks: [{ type: 'netease', id: 2, title: selected.name, displayName: 'Song 2 - Artist', durationMs: 120000,
            artists: selected.ar, album: selected.al, detailCheckedAt: 123 }] };
    host.localStorage.setItem('aurora_playlist_snapshot_v3', JSON.stringify(saved));
    for (const [key, value] of Object.entries({ window: host, localStorage: host.localStorage })) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
    }
    t.mock.method(console, 'warn', () => {});
    let restored = null, linked = null, status = '';
    const persistence = createPersistence({ queue,
        cache: { openIdb: async () => { throw new Error('IDB unavailable'); } },
        content: { setMainMusicEntityLinks() {}, updateMusicMiniPlayer() {} }, covers: { setMainCover() {} },
        dom: { el: { title: new FakeElement(), img: new FakeElement() } }, imports: {},
        lyrics: { setArtistTag() {} }, debug: { log() {} }, playlistView: { renderPlaylist() {} },
        playback: { setPlaybackStatus: value => { status = value; } },
        onlinePlaylist: { restoreQueueSource: (value, ref) => { restored = { value, ref, status }; linked = value; },
            getPersistedQueueSource: () => linked }
    });
    persistence.initialize(); await settle();
    assert.equal(restored.status, 'idle'); assert.equal(restored.ref, queue.playlist);
    assert.equal(restored.value.id, source.id); assert.equal(queue.playlist[0].detailCheckedAt, 123);
    assert.equal(queue.playlist[0].songData.dt, 120000);
    host.document.dispatchEvent({ type: 'pagehide' }); await settle();
    const next = JSON.parse(host.localStorage.getItem('aurora_playlist_snapshot_v3'));
    assert.equal(next.source.id, source.id); assert.equal(next.tracks[0].title, 'Song 2');
    assert.equal(next.tracks[0].durationMs, 120000);
});

test('persistence saves and restores manual current and pending independently of the linked base', async t => {
    const host = createHost().host, model = new PlaybackPlan();
    const stored = id => ({ type: 'netease', id, title: `Song ${id}`, artists: [], album: {} });
    host.localStorage.setItem('aurora_playlist_snapshot_v3', JSON.stringify({ schema: 3, revision: 1,
        listId: 'two-layer', selectedIndex: 1, source, tracks: [stored(1), stored(2), stored(3)],
        manual: { current: stored(90), pending: [stored(91), stored(92)] } }));
    for (const [key, value] of Object.entries({ window: host, localStorage: host.localStorage })) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
    }
    t.mock.method(console, 'warn', () => {});
    const queue = {
        get playlist() { return model.items; }, set playlist(value) { model.reset(value); },
        get basePlaylist() { return model.base; }, get baseCurIdx() { return model.baseIndex; },
        get curIdx() { return model.index; }, set curIdx(value) { model.setIndex(value); },
        get manualState() { return { current: model.isTemporary ? model.current : null, pending: model.pending }; },
        restoreManualState: state => model.restoreManual(state)
    };
    let linked = null;
    const persistence = createPersistence({ queue, cache: { openIdb: async () => { throw new Error('offline'); } },
        content: { setMainMusicEntityLinks() {}, updateMusicMiniPlayer() {} }, covers: { setMainCover() {} },
        dom: { el: { title: new FakeElement(), img: new FakeElement() } }, imports: {},
        lyrics: { setArtistTag() {} }, debug: { log() {} }, playlistView: { renderPlaylist() {} },
        playback: { setPlaybackStatus() {} },
        onlinePlaylist: { restoreQueueSource(value, ref) { linked = value; assert.equal(ref, model.base); }, getPersistedQueueSource: () => linked }
    });
    persistence.initialize(); await settle();
    assert.equal(model.current.songId, 90); assert.equal(model.baseIndex, 1);
    assert.deepEqual(model.pending.map(track => track.songId), [91, 92]);
    model.select(model.nextIndex());
    host.document.dispatchEvent({ type: 'pagehide' }); await settle();
    const next = JSON.parse(host.localStorage.getItem('aurora_playlist_snapshot_v3'));
    assert.deepEqual(next.tracks.map(track => track.id), [1, 2, 3]);
    assert.equal(next.source.id, source.id); assert.equal(next.manual.current.id, 91);
    assert.deepEqual(next.manual.pending.map(track => track.id), [92]);
    assert.equal(JSON.parse(host.localStorage.getItem('aurora_playlist_selection_v1')).selectedIndex, 1);
});
