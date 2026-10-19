import test from 'node:test';
import assert from 'node:assert/strict';
import { createSongDetails, planDetailWindow } from '../src/netease/song-details.js';
import { createTransfer } from '../src/audio/transfer.js';
import { createCache, createRequestPriority } from '../src/storage/cache.js';
import { createQueue } from '../src/playlist/queue.js';

const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };
const song = id => ({ id, name: `song-${id}`, ar: [{ id: 1, name: 'artist' }], al: { id: 1, name: 'album', picUrl: 'https://fixture.invalid/cover' }, dt: 180000 });
const entry = (id, full = false) => ({ netease: true, songId: id, name: `song-${id}`, songData: full ? song(id) : { id } });
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };

function fixture(t, length = 30) {
    const calls = [], updates = [], logs = [];
    const queue = { playlist: Array.from({ length }, (_, i) => entry(i + 1)), curIdx: 0, playMode: 0 };
    queue.playlist[0].songData = song(1);
    const auth = { authGeneration: 1, neteaseCookie: '', accountAbortControllers: new Set() };
    const playback = { playbackState: { status: 'playing' }, looping: false, getActiveCustomLoop() { return this.looping; } };
    const prefetch = { nextPreloadIndex: null, hasLockedNextPreloadTarget() { return this.nextPreloadIndex !== null; } };
    const onlinePlaylist = { currentPlaylistData: null };
    const state = { handler: ids => ({ code: 200, songs: ids.map(song) }), base: 'https://fixture.invalid' };
    const cache = { cachedFetchJson(url, options) {
        const ids = new URL(url).searchParams.get('ids').split(',').map(Number);
        calls.push({ ids, options });
        return state.handler(ids, options);
    } };
    const details = createSongDetails({ queue, auth, playback, prefetch, onlinePlaylist, cache,
        api: { buildApiUrl: path => state.base + path }, transfer: createTransfer(),
        content: { updateMusicMiniPlayer() {} }, debug: { log: (...args) => logs.push(args) },
        playlistView: { refreshPlaylistItem: index => updates.push(index) }
    });
    t.after(() => details.reset());
    return { details, queue, auth, playback, prefetch, onlinePlaylist, calls, updates, logs, state };
}

test('metadata window counts positions, not missing songs; duplicate/local entries do not extend it', () => {
    const list = [entry(1), entry(2, true), { name: 'local' }, entry(2), entry(3), entry(4), entry(5)];
    assert.deepEqual(planDetailWindow(list, 0, 0), list.slice(1, 6));
    assert.deepEqual(planDetailWindow(list, 5, 0, { loading: true }), [list[6]]);
    assert.deepEqual(planDetailWindow(list, 5, 0), [list[6], ...list.slice(0, 4)]);
    assert.deepEqual(planDetailWindow(list, 0, 1), []);
    assert.deepEqual(planDetailWindow(list, 0, 1, { nextIndex: 5 }), [list[5]]);
    assert.deepEqual(planDetailWindow(list, 0, 2), []);
    assert.deepEqual(planDetailWindow(list, 0, 0, { looping: true }), []);
});

test('metadata planner reads at most five positions, even in a fully known 50000-song queue', () => {
    let reads = 0;
    const list = new Proxy(new Array(50000), { get(target, key) {
        if (/^\d+$/.test(String(key))) { reads++; return entry(Number(key) + 1, true); }
        return Reflect.get(target, key);
    } });
    assert.equal(planDetailWindow(list, 0, 0).length, 5);
    assert.equal(reads, 5);
    reads = 0;
    assert.equal(planDetailWindow(list, 0, 1, { nextIndex: 40000 }).length, 1);
    assert.equal(reads, 1);
});

test('five/two scheduler uses seven batches and 23 details across the first 20 tracks', async t => {
    const { details, queue, calls } = fixture(t, 1000);
    for (let index = 0; index < 20; index++) {
        queue.curIdx = index;
        queue.playlist[index].songData = song(index + 1);
        details.refresh();
        await settle();
    }
    assert.deepEqual(calls.map(call => call.ids), [[2,3,4,5,6], [7,8,9], [10,11,12], [13,14,15], [16,17,18], [19,20,21], [22,23,24]]);
    assert.equal(calls.reduce((count, call) => count + call.ids.length, 0), 23);
    assert.ok(calls.every(call => call.options.priority === 'idle'));
});

test('known details make no requests; positions with repeated IDs produce one request per ID', async t => {
    const { details, queue, calls, updates } = fixture(t);
    queue.playlist = [entry(1, true), entry(2), entry(2), entry(3, true), { name: 'local' }, entry(4), entry(2)];
    details.refresh();
    await settle();
    assert.deepEqual(calls.map(call => call.ids), [[2, 4]]);
    assert.equal(queue.playlist[6].songData.dt, 180000);
    assert.deepEqual(updates, [1, 2, 5, 6]);
    for (let i = 0; i < 5; i++) { details.refresh(); await settle(); }
    assert.equal(calls.length, 1);
});

test('foreground joins its pending batch and survives background cancellation', async t => {
    const { details, calls, state } = fixture(t);
    const response = deferred();
    state.handler = () => response.promise;
    details.refresh(); await settle();
    const foreground = details.getSongDetail(2);
    assert.equal(calls[0].options.requestPriority.value, 'interactive');
    details.cancelPrefetch(); await settle();
    assert.equal(calls[0].options.signal.aborted, false);
    response.resolve({ songs: [song(2), song(3), song(4), song(5), song(6)] });
    assert.equal((await foreground).id, 2);
    await settle();
    assert.equal(calls.length, 1);
});

test('overlapping windows keep the original batch and do not duplicate requests', async t => {
    const { details, queue, calls, state } = fixture(t);
    const response = deferred();
    state.handler = () => response.promise;
    details.refresh(); await settle();
    queue.curIdx = 3; queue.playlist[3].songData = song(4);
    details.refresh(); await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.signal.aborted, false);
    state.handler = ids => ({ songs: ids.map(song) });
    response.resolve({ songs: [2,3,4,5,6].map(song) });
    await settle();
    assert.deepEqual(calls.map(call => call.ids), [[2,3,4,5,6], [7,8,9]]);
});

test('queue replacement establishes new subscriptions before releasing matching old IDs', async t => {
    const { details, queue, calls, state } = fixture(t);
    const response = deferred(); state.handler = () => response.promise;
    details.refresh(); await settle();
    const old = queue.playlist;
    queue.playlist = [entry(1, true), entry(2), entry(3)];
    details.refresh(); await settle();
    assert.equal(calls[0].options.signal.aborted, false);
    response.resolve({ songs: [2,3,4,5,6].map(song) });
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(queue.playlist[1].songData.dt, 180000);
    assert.equal(old[1].songData.dt, undefined);
});

test('unrelated jumps cancel unused batches; stale responses cannot write to another queue', async t => {
    const { details, queue, calls, state } = fixture(t);
    const response = deferred(); state.handler = () => response.promise;
    details.refresh(); await settle();
    const old = queue.playlist;
    queue.playlist = [entry(20, true), entry(21), entry(22)];
    state.handler = ids => ({ songs: ids.map(song) });
    details.refresh(); await settle();
    assert.equal(calls[0].options.signal.aborted, true);
    response.resolve({ songs: [2,3,4,5,6].map(song) }); await settle();
    assert.equal(old[1].songData.dt, undefined);
    assert.equal(queue.playlist[1].songData.id, 21);
    assert.equal(calls.length, 2);
});

test('random only fetches the locked next item; loop modes do not prefetch', async t => {
    const { details, queue, prefetch, playback, calls } = fixture(t, 1000);
    queue.playMode = 1;
    details.refresh(); await settle(); assert.equal(calls.length, 0);
    prefetch.nextPreloadIndex = 876;
    details.refresh(); await settle(); assert.deepEqual(calls[0].ids, [877]);
    queue.playMode = 2; details.refresh(); await settle();
    queue.playMode = 0; playback.looping = true; details.refresh(); await settle();
    assert.equal(calls.length, 1);
    playback.looping = false; details.refresh(); await settle();
    assert.equal(calls.length, 2);
});

test('importing queue does not wrap or race the importer; append triggers only eligible requests', async t => {
    const { details, queue, onlinePlaylist, calls } = fixture(t, 3);
    queue.playlist.forEach(track => { track.songData = song(track.songId); });
    queue.curIdx = 2;
    onlinePlaylist.currentPlaylistData = { queueRef: queue.playlist, loading: true };
    details.refresh(); await settle(); assert.equal(calls.length, 0);
    queue.playlist.push(entry(4, true), entry(5, true));
    details.refresh(); await settle(); assert.equal(calls.length, 0);
    queue.playlist.push(entry(6)); details.refresh(); await settle();
    assert.deepEqual(calls[0].ids, [6]);
});

test('successful empty fields are known, but omitted IDs cool down without retry loops', async t => {
    const { details, queue, calls, state } = fixture(t, 4);
    state.handler = () => ({ songs: [{ id: 2, name: 'no metadata', ar: [], al: {}, dt: 0 }] });
    details.refresh(); await settle();
    assert.equal(calls[0].options.cachePredicate({ songs: [song(2)] }), false);
    assert.equal(calls[0].options.cachePredicate({ songs: [2,3,4].map(song) }), true);
    assert.equal(details.isReady(queue.playlist[1].songData), true);
    for (let i = 0; i < 5; i++) { details.refresh(); await settle(); }
    assert.equal(calls.length, 1);
    state.handler = ids => ({ songs: ids.map(song) });
    assert.equal((await details.getSongDetail(3)).id, 3);
    assert.equal(calls.length, 2);
});

test('foreground audio loading blocks new metadata batches, and paused playback is not resumed', async t => {
    const { details, playback, calls } = fixture(t);
    playback.playbackState.status = 'loading';
    details.refresh(); await settle(); assert.equal(calls.length, 0);
    playback.playbackState.status = 'paused';
    details.refresh(); await settle(); assert.equal(calls.length, 1);
    assert.equal(playback.playbackState.status, 'paused');
});

test('metadata load cancellation leaves the queue paused and cannot launch online playback', async () => {
    const response = deferred();
    let played = 0, token = 0;
    const playback = {
        playbackState: { status: 'idle' }, playbackWantsPlay: true, transportVersion: 0,
        beginPlaybackAction() { this.currentAbortController?.abort(); return ++token; },
        getPlaybackLoad: () => ({}), isPlaybackActionCurrent: candidate => candidate === token,
        stopAudio(status) { this.playbackState.status = status; }, resetPlaybackTimeline() {},
        unlockAudioContext: async () => true, releasePlaybackLoad() {},
        setPlaybackStatus(status) { this.playbackState.status = status; }
    };
    const transfer = createTransfer();
    const queue = createQueue({ playback, prefetch: { prefetchUpcomingNeteaseDetails() {} },
        onlinePlaylist: {}, playlistView: { ensurePlaylistRenderedAndActive() {} },
        songDetails: { getSongDetail: (id, options) => transfer.awaitWithSignal(response.promise, options.signal) },
        dom: { el: { lyricBox: {}, img: { style: {} } } }, debug: { log() {} },
        covers: { setMainCover() {} },
        onlinePlayback: { playNeteaseSong() { played++; } }
    });
    queue.playlist = [{ netease: true, songId: 1 }];
    const pending = queue.playTrackFromPlaylist(0);
    await settle();
    assert.ok(playback.currentAbortController);
    playback.currentAbortController.abort();
    playback.setPlaybackStatus('paused');
    await pending;
    response.resolve(song(1)); await settle();
    assert.equal(played, 0);
    assert.equal(playback.playbackState.status, 'paused');
    assert.equal(playback.currentAbortController, null);
});

test('timeout covers pending JSON, releases its batch and uses a finite background cooldown', async t => {
    const { details, calls, state } = fixture(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    state.handler = () => new Promise(() => {});
    details.refresh(); await settle();
    t.mock.timers.tick(12001); await settle();
    assert.equal(calls[0].options.signal.aborted, true);
    details.refresh(); await settle(); assert.equal(calls.length, 1);
    state.handler = ids => ({ songs: ids.map(song) });
    t.mock.timers.tick(30001); details.refresh(); await settle();
    assert.equal(calls.length, 2);
});

test('account or API changes discard stale replies and cannot share the old ID task', async t => {
    const { details, auth, queue, calls, state } = fixture(t);
    const first = deferred(); state.handler = () => first.promise;
    details.refresh(); await settle();
    auth.authGeneration++;
    state.base = 'https://other.invalid';
    state.handler = ids => ({ songs: ids.map(song) });
    details.refresh(); await settle();
    first.resolve({ songs: [2,3,4,5,6].map(id => ({ ...song(id), name: 'stale' })) }); await settle();
    assert.equal(calls[0].options.signal.aborted, true);
    assert.equal(calls.length, 2);
    assert.equal(queue.playlist[1].songData.name, 'song-2');
});

test('cache promotes a queued batch without another GET and does not leak scheduler options to fetch', async t => {
    const saved = { fetch: globalThis.fetch, window: globalThis.window };
    globalThis.window = { location: { href: 'https://fixture.invalid/' } };
    const pending = [], urls = [], options = [];
    globalThis.fetch = (url, init) => { const task = deferred(); urls.push(url); options.push(init); pending.push(task); return task.promise; };
    t.after(() => { globalThis.fetch = saved.fetch; globalThis.window = saved.window; });
    const cache = createCache({ transfer: createTransfer() });
    const fetchJson = (id, extra = {}) => cache.cachedFetchJson(`https://fixture.invalid/${id}`, { cacheScope: 'none', ...extra });
    const first = [fetchJson(1), fetchJson(2), fetchJson(3)];
    await settle(); assert.equal(urls.length, 3);
    const priority = createRequestPriority('idle');
    const batch = fetchJson('batch', { priority: 'idle', requestPriority: priority });
    const normal = fetchJson('normal');
    await settle(); priority.promote('interactive');
    pending[0].resolve(new Response('{"code":200}')); await settle();
    assert.equal(urls[3], 'https://fixture.invalid/batch');
    assert.equal('requestPriority' in options[3], false);
    for (const task of pending) task.resolve(new Response('{"code":200}'));
    await settle();
    for (const task of pending) task.resolve(new Response('{"code":200}'));
    await Promise.all([...first, batch, normal]);
    assert.equal(urls.filter(url => url.endsWith('/batch')).length, 1);
});

test('joining a cached JSON request promotes its queue slot and one cancelled consumer cannot abort another', async t => {
    const saved = { fetch: globalThis.fetch, window: globalThis.window };
    globalThis.window = { location: { href: 'https://fixture.invalid/' } };
    const pending = [], urls = [], signals = [];
    globalThis.fetch = (url, init) => { const task = deferred(); urls.push(url); signals.push(init.signal); pending.push(task); return task.promise; };
    t.after(() => { globalThis.fetch = saved.fetch; globalThis.window = saved.window; });
    const cache = createCache({ transfer: createTransfer() });
    const request = (id, options = {}) => cache.cachedFetchJson(`https://fixture.invalid/${id}`, { cacheScope: 'none', ...options });
    const blockers = [request(1), request(2), request(3)]; await settle();
    const controller = new AbortController();
    const speculative = request('shared', { priority: 'idle', signal: controller.signal });
    const foreground = request('shared', { priority: 'interactive' });
    const normal = request('other'); await settle();
    controller.abort(); await assert.rejects(speculative, { name: 'AbortError' });
    pending[0].resolve(new Response('{"code":200}')); await settle();
    assert.equal(urls[3], 'https://fixture.invalid/shared');
    assert.equal(signals[3].aborted, false);
    for (const task of pending) task.resolve(new Response('{"code":200}'));
    await settle();
    for (const task of pending) task.resolve(new Response('{"code":200}'));
    await Promise.all([...blockers, foreground, normal]);
    assert.equal(urls.filter(url => url.endsWith('/shared')).length, 1);
});
