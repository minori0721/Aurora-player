import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaylistSync } from '../src/netease/playlist-sync.js';
import { createPersistence } from '../src/storage/playlist.js';
import { pickNewestPlaylistState } from '../src/storage/playlist-schema.js';
import { createHost, FakeElement, withBaseQueue } from './helpers/host.mjs';
import { createPlaylistView } from '../src/playlist/view.js';
import { PlaybackPlan } from '../src/playlist/plan.js';

const song = (id, extra = {}) => ({ id, name: `Song ${id}`, ar: [{ id: 8, name: 'Artist' }],
    al: { id: 9, name: 'Album', picUrl: `https://cover.test/${id}.jpg` }, dt: 120000, ...extra });
const entry = id => ({ netease: true, songId: id, songData: song(id), name: `Song ${id} - Artist`, detailCheckedAt: Date.now() });
const source = { type: 'netease-playlist', id: '436233910', loadedCount: 3, totalCount: 3, loading: false, readAs: 123, privacy: 0 };
const reply = (ids, tracks = []) => ({ code: 200, playlist: { trackCount: ids.length, trackIds: ids.map(id => ({ id })), tracks } });
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

function fixture(ids = [1, 2, 3]) {
    const calls = [], events = [], changes = [];
    const queue = withBaseQueue({ playlist: ids.map(entry), curIdx: Math.min(1, ids.length - 1) });
    const auth = { authGeneration: 1, neteaseCookie: 'MUSIC_U=synthetic-only', accountAbortControllers: new Set(),
        neteaseUser: { userId: 123 }, loginStatus: 'authenticated', waitForLoginStatus: async () => true };
    const state = { handler: url => url.pathname === '/playlist/detail' ? reply(ids) : { code: 200, songs: [] }, visible: [] };
    const services = {
        api: { buildApiUrl: path => `https://api.test${path}` }, auth,
        cache: { cachedFetchJson: async (raw, options) => { const url = new URL(raw); calls.push({ url, options }); return state.handler(url, options); } },
        content: { setMainMusicEntityLinks: () => events.push('links'), updateMusicMiniPlayer: () => events.push('mini') },
        covers: { setMainCover: () => events.push('cover') },
        debug: { log: text => events.push(text) }, dom: { el: { title: new FakeElement() } },
        lyrics: { setArtistTag: (...args) => events.push(['artist', ...args]) },
        metadata: { currentAudioQuality: 'MP3 192kbps', updateMediaSession: () => events.push('media') },
        persistence: { schedulePlaylistStateSave: () => events.push('save'), schedulePlaylistTrackSave() {} },
        playback: { playbackState: { status: 'idle' }, stopAudio: status => events.push(`stop:${status}`), setPlaybackStatus: status => events.push(`status:${status}`) },
        playlistView: { getVisiblePlaylistIndexes: () => state.visible,
            renderPlaylist: () => events.push('render'), refreshPlaylistItem: index => changes.push(index) },
        prefetch: { cancelNextPreload: () => events.push('cancel-next'), nextPreloadIndex: null,
            hasLockedNextPreloadTarget: () => false, isNextPreloadCompatible: () => false }, queue,
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
    assert.equal(f.calls[0].options.cache, 'no-store');
    assert.ok(Number(f.calls[0].url.searchParams.get('timestamp')) > 0);
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
        baseCurIdx: { get: () => model.baseIndex }, isTemporary: { get: () => model.isTemporary },
        baseStructureRevision: { get: () => model.baseStructureRevision }
    });
    f.queue.replaceBaseTracks = (tracks, index) => model.replaceBaseTracks(tracks, index);
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
        baseCurIdx: { get: () => model.baseIndex }, isTemporary: { get: () => model.isTemporary },
        baseStructureRevision: { get: () => model.baseStructureRevision }
    });
    f.queue.replaceBaseTracks = (tracks, index) => model.replaceBaseTracks(tracks, index);
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

test('source survives queue saves but detaches on a base structure mutation', () => {
    const f = fixture(); f.sync.remember(source);
    assert.equal(f.sync.getSource().id, source.id);
    f.queue.sortBaseTracks((a, b) => b.songId - a.songId); assert.equal(f.sync.getSource(), null);
});

test('reading a source repeatedly does not walk a large unchanged queue', () => {
    const f = fixture(Array.from({ length: 10000 }, (_, index) => index + 1));
    f.sync.remember(source);
    let reads = 0;
    const original = f.queue.playlist;
    f.queue.playlist = new Proxy(original, { get(target, key) { if (/^\d+$/.test(String(key))) reads++; return Reflect.get(target, key); } });
    // Bind once against the real public array; subsequent reads are constant-time.
    f.sync.remember(source); reads = 0;
    for (let i = 0; i < 1000; i++) assert.equal(f.sync.getSource().id, source.id);
    assert.equal(reads, 0);
});

test('visible metadata selection respects the sidebar viewport, filtering and the 20-song cap', t => {
    const sidebar = new FakeElement(), container = new FakeElement();
    const host = createHost().host;
    const previous = Object.fromEntries(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries({ window: host, document: host.document })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    } });
    sidebar.getBoundingClientRect = () => ({ top: 0, bottom: 1000 });
    const queue = withBaseQueue({ playlist: Array.from({ length: 100 }, (_, index) => ({ name: index % 2 ? 'odd' : 'even' })) });
    const view = createPlaylistView({ dom: { el: { plSidebar: sidebar, plContainer: container } }, queue,
        persistence: { schedulePlaylistStateSave() {}, schedulePlaylistTrackSave() {} } });
    view.renderPlaylist(); view.setSearchQuery('odd');
    container.children.forEach((row, index) => {
        row.getBoundingClientRect = () => ({ top: index * 10 - 100, bottom: index * 10 - 90 });
    });
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
        await settle();
        if (change === 'queue') f.queue.playlist = [entry(90)];
        if (change === 'edit') f.queue.sortBaseTracks((a, b) => b.songId - a.songId);
        if (change === 'generation') f.auth.authGeneration++;
        if (change === 'cookie') f.auth.neteaseCookie = '';
        if (change === 'abort') for (const controller of f.auth.accountAbortControllers) controller.abort();
        const expected = f.queue.playlist.slice();
        release(reply([4], [song(4)])); await promise;
        assert.deepEqual(f.queue.playlist, expected, change); assert.equal(f.events.includes('render'), false, change);
    }
});

test('offline, unavailable or malformed member responses preserve the entire local snapshot', async () => {
    for (const response of [new Error('offline'), { code: 403 }, { code: 200, playlist: { trackCount: 3 } },
        { code: 200, playlist: { trackCount: 3, trackIds: [] } },
        { code: 200, playlist: { trackIds: [] } }, { ...reply([1]), playlist: { ...reply([1]).playlist, id: 9 } }, reply([0])]) {
        const f = fixture(), expected = f.queue.playlist.slice();
        f.state.handler = url => { if (response instanceof Error) throw response;
            return url.pathname === '/playlist/detail' ? response : { code: 200, songs: [] }; };
        await f.sync.restore(source, f.queue.playlist);
        assert.deepEqual(f.queue.playlist, expected); assert.equal(f.events.includes('render'), false);
    }
});

test('reported totals are advisory for nonempty ordered member lists', async () => {
    for (const trackCount of [4, 2, undefined]) {
        const f = fixture(), selected = f.queue.playlist[1];
        f.state.handler = () => ({ code: 200, playlist: { trackCount, trackIds: [{ id: 3 }, { id: 4 }, { id: 2 }], tracks: [song(4)] } });
        await f.sync.restore(source, f.queue.playlist);
        assert.deepEqual(f.queue.playlist.map(track => track.songId), [3, 4, 2]);
        assert.equal(f.queue.playlist[f.queue.curIdx], selected);
        assert.equal(f.sync.getSource().totalCount, 3);
        assert.equal(f.calls.length, 1);
    }
});

test('1181 reported tracks and 1180 valid IDs still synchronize additions, deletions and order', async () => {
    const original = Array.from({ length: 1180 }, (_, index) => index + 1), f = fixture(original);
    const remote = [90001, ...original.slice(1).reverse()], selected = f.queue.playlist[1];
    f.state.handler = () => ({ ...reply(remote, [song(90001)]), playlist: {
        ...reply(remote, [song(90001)]).playlist, trackCount: 1181
    } });
    await f.sync.restore(source, f.queue.playlist);
    assert.deepEqual(f.queue.playlist.map(track => track.songId), remote);
    assert.equal(f.queue.playlist[f.queue.curIdx], selected);
    assert.equal(f.calls.length, 1);
    assert.equal(f.events.filter(event => event === 'render').length, 1);
    assert.equal(f.events.includes('cover'), false);
    assert.ok(f.events.some(event => typeof event === 'string' && /1181.*1180/.test(event)));
});

test('members commit before details complete; failed and partial batches do not roll back the queue', async () => {
    const f = fixture(), ids = [2, 3, ...Array.from({ length: 66 }, (_, index) => index + 4)];
    const selected = f.queue.playlist[1];
    let release;
    f.state.handler = url => {
        if (url.pathname === '/playlist/detail') return reply(ids);
        if (url.searchParams.get('ids').startsWith('4,')) return new Promise(resolve => { release = resolve; });
        return { code: 200, songs: [song(69)] };
    };
    const pending = f.sync.restore(source, f.queue.playlist);
    await settle();
    assert.deepEqual(f.queue.playlist.map(track => track.songId), ids);
    assert.ok(f.events.includes('save'));
    assert.equal(f.queue.playlist.find(track => track.songId === 4).songData, undefined);
    release({ code: 500 }); await pending;
    assert.deepEqual(f.queue.playlist.map(track => track.songId), ids);
    assert.equal(f.queue.playlist[f.queue.curIdx], selected);
    assert.equal(f.queue.playlist.find(track => track.songId === 69).name, 'Song 69 - Artist');
    assert.equal(f.queue.playlist.find(track => track.songId === 68).songData, undefined);
    assert.equal(f.calls.length, 3);
    assert.ok(f.events.some(event => typeof event === 'string' && /2 批歌曲详情/.test(event)));
    assert.equal(f.events.filter(event => event === 'render').length, 1);
});

test('missing details are retried for existing placeholders and never fabricated', async () => {
    for (const malformedTracks of [undefined, {}]) {
        const f = fixture(); delete f.queue.playlist[1].songData;
        f.state.handler = url => url.pathname === '/playlist/detail'
            ? { ...reply([1, 2, 3]), playlist: { ...reply([1, 2, 3]).playlist, tracks: malformedTracks } }
            : { code: 200, songs: [song(2)] };
        await f.sync.restore(source, f.queue.playlist);
        assert.equal(f.calls[1].url.searchParams.get('ids'), '2');
        assert.equal(f.queue.playlist[1].songData.name, 'Song 2');
        assert.equal(f.queue.playlist[1].name, 'Song 2 - Artist');
    }
});

test('late detail batches cannot modify a replacement queue or a changed account', async () => {
    for (const change of ['queue', 'edit', 'generation', 'cookie', 'abort']) {
        const f = fixture(); let release;
        f.state.handler = url => url.pathname === '/playlist/detail' ? reply([2, 4])
            : new Promise(resolve => { release = resolve; });
        const pending = f.sync.restore(source, f.queue.playlist); await settle();
        assert.deepEqual(f.queue.playlist.map(track => track.songId), [2, 4]);
        if (change === 'queue') f.queue.playlist = [entry(90)];
        if (change === 'edit') f.queue.sortBaseTracks((a, b) => b.songId - a.songId);
        if (change === 'generation') f.auth.authGeneration++;
        if (change === 'cookie') f.auth.neteaseCookie = '';
        if (change === 'abort') for (const controller of f.auth.accountAbortControllers) controller.abort();
        const before = f.queue.playlist.map(track => ({ ...track }));
        release({ code: 200, songs: [song(4)] }); await pending;
        assert.deepEqual(f.queue.playlist, before, change);
        assert.equal(f.auth.accountAbortControllers.size, 0);
    }
});

test('public playlist commits one ordered snapshot without waiting for login identity', async () => {
    const f = fixture(); let checks = 0;
    f.auth.loginStatus = 'pending'; f.auth.neteaseUser = null;
    f.auth.waitForLoginStatus = () => { checks++; return new Promise(() => {}); };
    f.state.handler = () => reply([3, 4, 2], [song(4)]);
    await f.sync.restore(source, f.queue.playlist);
    assert.equal(checks, 0);
    assert.deepEqual(f.queue.playlist.map(track => track.songId), [3, 4, 2]);
    assert.equal(f.sync.getSource().readAs, 123);
    assert.equal(f.calls.length, 1);
    assert.equal(f.events.filter(event => event === 'render').length, 1);
});

test('unavailable login still synchronizes public membership and order without a guest retry', async () => {
    for (const failure of [false, new Error('offline')]) {
        const f = fixture(); f.auth.loginStatus = 'unavailable'; f.auth.neteaseUser = null;
        f.auth.waitForLoginStatus = async () => { if (failure instanceof Error) throw failure; return failure; };
        f.state.handler = () => reply([3, 4, 2], [song(4)]);
        await f.sync.restore(source, f.queue.playlist);
        assert.equal(f.calls.length, 1); assert.deepEqual(f.queue.playlist.map(track => track.songId), [3, 4, 2]);
        assert.equal(f.auth.accountAbortControllers.size, 0);
    }
});

test('logout while a newly private response waits for identity cannot commit stale membership', async () => {
    const f = fixture(); let confirm;
    f.auth.loginStatus = 'pending'; f.auth.neteaseUser = null;
    f.auth.waitForLoginStatus = () => new Promise(resolve => { confirm = resolve; });
    f.state.handler = () => ({ ...reply([3, 4], [song(4)]), playlist: { ...reply([3, 4], [song(4)]).playlist, privacy: 10 } });
    const pending = f.sync.restore(source, f.queue.playlist);
    await settle();
    f.auth.authGeneration++; f.auth.neteaseCookie = '';
    confirm(true); await pending;
    assert.equal(f.calls.length, 1); assert.deepEqual(f.queue.playlist.map(track => track.songId), [1, 2, 3]);
});

test('guest sync does not request login status or send an account cookie', async () => {
    const f = fixture(); f.auth.neteaseCookie = '';
    f.auth.waitForLoginStatus = () => { throw new Error('unexpected login check'); };
    f.state.handler = () => reply([3, 2]);
    await f.sync.restore({ ...source, readAs: 'guest' }, f.queue.playlist);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url.searchParams.get('cookie'), 'os=pc');
    assert.equal(f.calls[0].url.searchParams.get('noCookie'), 'true');
    assert.equal(f.calls[0].options.credentials, 'omit');
    assert.deepEqual(f.queue.playlist.map(track => track.songId), [3, 2]);
});

test('a successful public snapshot does not need a second read when an independent login check expires', async () => {
    for (const previousReader of [123, 'guest']) {
        const f = fixture(); f.auth.loginStatus = 'pending';
        f.auth.waitForLoginStatus = () => { throw new Error('unexpected duplicate login check'); };
        f.state.handler = () => { f.auth.loginStatus = 'expired'; f.auth.neteaseUser = null; return reply([3, 4, 2], [song(4)]); };
        await f.sync.restore({ ...source, readAs: previousReader }, f.queue.playlist);
        assert.equal(f.calls.length, 1);
        assert.deepEqual(f.queue.playlist.map(track => track.songId), [3, 4, 2]);
    }
});

test('a known expired credential reads public content directly as guest without a doomed account request', async () => {
    const f = fixture(); f.auth.loginStatus = 'expired'; f.auth.neteaseUser = null;
    f.auth.waitForLoginStatus = () => { throw new Error('duplicate login check'); };
    f.state.handler = () => reply([3, 2]);
    await f.sync.restore({ ...source, readAs: 'guest' }, f.queue.playlist);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url.searchParams.get('cookie'), 'os=pc');
    assert.deepEqual(f.queue.playlist.map(track => track.songId), [3, 2]);
});

test('explicit API login errors permit one guest retry, never a retry loop', async () => {
    for (const guestResponse of [reply([3, 2]), { code: 301 }]) {
        const f = fixture(); f.state.handler = url => url.searchParams.get('cookie') === 'os=pc' ? guestResponse : { code: 301 };
        await f.sync.restore({ ...source, readAs: 'guest' }, f.queue.playlist);
        assert.equal(f.calls.length, 2);
        assert.deepEqual(f.queue.playlist.map(track => track.songId), guestResponse.code === 200 ? [3, 2] : [1, 2, 3]);
    }
});

test('HTTP login redirects require a separately confirmed expired login before a guest retry', async () => {
    for (const status of ['expired', 'unavailable']) {
        const f = fixture(); f.auth.loginStatus = 'pending';
        f.auth.waitForLoginStatus = async () => { f.auth.loginStatus = status; f.auth.neteaseUser = null; return false; };
        f.state.handler = url => {
            if (url.searchParams.get('cookie') === 'os=pc') return reply([3, 2]);
            throw Object.assign(new Error('HTTP 301'), { status: 301 });
        };
        await f.sync.restore({ ...source, readAs: 'guest' }, f.queue.playlist);
        assert.equal(f.calls.length, status === 'expired' ? 2 : 1);
    }
});

test('HTTP firewall errors, throttling, server failures and timeouts do not change identity or add guest requests', async () => {
    for (const status of [403, 429, 500, 503, undefined]) {
        const f = fixture(), original = f.queue.playlist.slice();
        f.state.handler = () => { throw Object.assign(new Error('unavailable'), { status }); };
        await f.sync.restore(source, f.queue.playlist);
        assert.equal(f.calls.length, 1); assert.deepEqual(f.queue.playlist, original);
        assert.equal(f.sync.getSource().readAs, 123);
    }
});

test('known private playlists require an identity and never attempt a guest read', async () => {
    for (const status of ['guest', 'expired', 'unavailable']) {
        const f = fixture(); f.auth.loginStatus = status; f.auth.neteaseUser = null;
        if (status === 'guest') f.auth.neteaseCookie = '';
        f.auth.waitForLoginStatus = async () => false;
        await f.sync.restore({ ...source, privacy: 10 }, f.queue.playlist);
        assert.equal(f.calls.length, 0); assert.equal(f.queue.playlist.length, 3);
    }
});

test('a private response is not applied while identity remains unconfirmed', async () => {
    const f = fixture(); f.auth.loginStatus = 'unavailable'; f.auth.neteaseUser = null;
    f.auth.waitForLoginStatus = async () => false;
    f.state.handler = () => ({ code: 200, playlist: { ...reply([4], [song(4)]).playlist, privacy: 10 } });
    await f.sync.restore(source, f.queue.playlist);
    assert.equal(f.calls.length, 1); assert.deepEqual(f.queue.playlist.map(track => track.songId), [1, 2, 3]);
});

test('a validated empty public snapshot clears account membership while keeping the active song until it finishes', async () => {
    const f = fixture(); f.auth.neteaseCookie = ''; f.playback.playbackState.status = 'playing';
    f.state.handler = () => reply([]);
    await f.sync.restore(source, f.queue.playlist);
    assert.deepEqual(f.queue.playlist.map(track => track.songId), [2]);
    assert.equal(f.sync.getSource().totalCount, 0);
    assert.equal(f.events.includes('stop:idle'), false);
    assert.equal(f.sync.finishEmptyQueue(), true);
    assert.equal(f.queue.playlist.length, 0);
});

test('switching accounts synchronizes a valid public snapshot and establishes its current reader', async () => {
    const f = fixture(); f.auth.neteaseUser = { userId: 456 };
    f.state.handler = () => reply([3, 4, 2], [song(4)]);
    await f.sync.restore(source, f.queue.playlist);
    assert.deepEqual(f.queue.playlist.map(track => track.songId), [3, 4, 2]);
    assert.equal(f.sync.getSource().readAs, 456);
    assert.equal(f.events.filter(event => event === 'render').length, 1);
});

test('unknown legacy readers accept removals without requiring a lossless snapshot or reimport', async () => {
    const f = fixture(); f.state.handler = () => reply([3, 4, 2], [song(4)]);
    await f.sync.restore({ ...source, readAs: undefined }, f.queue.playlist);
    await f.sync.refresh();
    assert.equal(f.sync.getSource().readAs, 123);
    assert.deepEqual(f.queue.playlist.map(track => track.songId), [3, 4, 2]);
    f.state.handler = () => reply([4, 3, 2, 1]); await f.sync.refresh();
    assert.equal(f.sync.getSource().readAs, 123);
    f.state.handler = () => reply([3, 2]); await f.sync.refresh();
    assert.deepEqual(f.queue.playlist.map(track => track.songId), [3, 2]);
});

test('explicit partial snapshots use remote order without deleting missing members or accumulating duplicates', async () => {
    for (const level of ['root', 'playlist']) {
        const f = fixture();
        f.state.handler = () => {
            const result = reply([4, 1, 3], [song(4)]);
            if (level === 'root') result.more = true; else result.playlist.more = true;
            return result;
        };
        await f.sync.restore(source, f.queue.playlist);
        assert.deepEqual(f.queue.playlist.map(track => track.songId), [4, 1, 2, 3]);
        await f.sync.refresh();
        assert.deepEqual(f.queue.playlist.map(track => track.songId), [4, 1, 2, 3]);
        assert.equal(f.events.filter(event => event === 'render').length, 1);
        f.state.handler = () => reply([4, 1, 3]);
        await f.sync.refresh();
        assert.deepEqual(f.queue.playlist.map(track => track.songId), [4, 1, 3]);
        assert.equal(f.calls.length, 3);
    }
});

test('a changed-reader prepend goes to the remote head, and repeated identical refreshes reuse rows', async () => {
    const f = fixture(); f.auth.neteaseCookie = '';
    f.state.handler = () => reply([4, 1, 2, 3], [song(4)]);
    await f.sync.restore(source, f.queue.playlist);
    const tracks = f.queue.playlist.slice();
    assert.deepEqual(tracks.map(track => track.songId), [4, 1, 2, 3]);
    assert.equal(f.sync.getSource().readAs, 'guest');
    await f.sync.refresh();
    assert.ok(f.queue.playlist.every((track, index) => track === tracks[index]));
    assert.equal(f.events.filter(event => event === 'render').length, 1);
    assert.equal(f.calls.length, 2);
});

test('sync retains the same next preload after a prepend and only cancels when the target changes', async () => {
    for (const remote of [[4, 1, 2, 3], [1, 2, 4, 3]]) {
        const f = fixture(), target = f.queue.playlist[2];
        f.prefetch.nextPreloadIndex = 2;
        f.prefetch.hasLockedNextPreloadTarget = (tracks, index) => tracks[index] === target;
        f.prefetch.isNextPreloadCompatible = () => true;
        f.queue.getNextPlaylistIndex = () => (f.queue.curIdx + 1) % f.queue.playlist.length;
        const replace = f.queue.replaceBaseTracks.bind(f.queue);
        f.queue.replaceBaseTracks = (tracks, index) => {
            replace(tracks, index);
            f.prefetch.nextPreloadIndex = f.queue.playlist.indexOf(target);
        };
        f.state.handler = () => reply(remote, [song(4)]);
        await f.sync.restore(source, f.queue.playlist);
        assert.deepEqual(f.queue.playlist.map(track => track.songId), remote);
        assert.equal(f.events.filter(event => event === 'cancel-next').length, remote[0] === 4 ? 0 : 1);
    }
});

test('a partial response reintroducing the previously removed current song clears its temporary removal marker', async () => {
    const f = fixture(); f.playback.playbackState.status = 'playing';
    f.state.handler = () => reply([1, 3]);
    await f.sync.restore(source, f.queue.playlist);
    f.state.handler = () => ({ ...reply([1, 2, 3]), more: true });
    await f.sync.refresh();
    const index = f.sync.resolveSelection(2);
    assert.equal(index, 2); assert.deepEqual(f.queue.playlist.map(track => track.songId), [1, 2, 3]);
});

test('twenty overlapping refreshes commit only the latest snapshot even when old responses arrive last', async () => {
    const f = fixture(), requests = [];
    f.state.handler = (url, options) => new Promise(resolve => requests.push({ resolve, signal: options.signal }));
    const jobs = [f.sync.restore(source, f.queue.playlist)];
    for (let index = 1; index < 20; index++) jobs.push(f.sync.refresh());
    assert.equal(requests.length, 20);
    requests.at(-1).resolve(reply([99, 1, 2, 3], [song(99)]));
    await jobs.at(-1);
    for (let index = 18; index >= 0; index--) requests[index].resolve(reply([100 + index], [song(100 + index)]));
    await Promise.all(jobs);
    assert.deepEqual(f.queue.playlist.map(track => track.songId), [99, 1, 2, 3]);
    assert.equal(f.events.filter(event => event === 'render').length, 1);
    assert.ok(requests.slice(0, -1).every(item => item.signal.aborted));
    assert.equal(f.auth.accountAbortControllers.size, 0);
    assert.equal(f.calls.length, 20);
});

test('returning to the original account completes a protected refresh without touching active audio', async () => {
    const f = fixture(), selected = f.queue.playlist[1]; f.auth.neteaseCookie = ''; f.playback.playbackState.status = 'playing';
    f.state.handler = () => reply([3, 4, 2], [song(4)]);
    await f.sync.restore(source, f.queue.playlist);
    f.auth.authGeneration++; f.auth.neteaseCookie = 'MUSIC_U=new-synthetic';
    f.auth.loginStatus = 'authenticated'; f.auth.neteaseUser = { userId: 123 };
    await f.sync.refresh();
    assert.deepEqual(f.queue.playlist.map(track => track.songId), [3, 4, 2]);
    assert.equal(f.queue.playlist[f.queue.curIdx], selected); assert.equal(f.calls.length, 2);
    assert.equal(f.events.some(event => typeof event === 'string' && event.startsWith('stop:')), false);
});

test('late guest fallback responses cannot modify a queue after an account change', async () => {
    const f = fixture(); let release;
    f.state.handler = url => url.searchParams.get('cookie') === 'os=pc'
        ? new Promise(resolve => { release = resolve; }) : { code: 301 };
    const pending = f.sync.restore(source, f.queue.playlist); await settle();
    f.auth.authGeneration++; f.auth.neteaseCookie = 'MUSIC_U=other-synthetic';
    release(reply([4], [song(4)])); await pending;
    assert.deepEqual(f.queue.playlist.map(track => track.songId), [1, 2, 3]);
    assert.equal(f.auth.accountAbortControllers.size, 0);
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
    const host = createHost().host, selected = song(2), queue = withBaseQueue({ playlist: [], curIdx: -1 });
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

test('pending song details survive compact persistence and restoration without becoming fake songData', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const host = createHost().host, queue = withBaseQueue({ playlist: [], curIdx: -1 });
    const name = 'Song 4 (pending)';
    host.localStorage.setItem('aurora_playlist_snapshot_v3', JSON.stringify({ schema: 3, revision: 1,
        listId: 'pending', source, selectedIndex: 0,
        tracks: [{ type: 'netease', id: 4, title: name, displayName: name, detailPending: true, artists: [], album: {} }] }));
    for (const [key, value] of Object.entries({ window: host, localStorage: host.localStorage })) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
    }
    t.mock.method(console, 'warn', () => {});
    let restored = false;
    const title = new FakeElement();
    const persistence = createPersistence({ queue, cache: { openIdb: async () => { throw new Error('offline'); } },
        content: { setMainMusicEntityLinks() {}, updateMusicMiniPlayer() {} }, covers: { setMainCover() {} },
        dom: { el: { title, img: new FakeElement() } }, imports: {}, lyrics: { setArtistTag() {} }, debug: { log() {} },
        playlistView: { renderPlaylist() {} }, playback: { setPlaybackStatus() {} },
        onlinePlaylist: { restoreQueueSource() { restored = true; }, getPersistedQueueSource: () => source }
    });
    persistence.initialize(); await settle();
    assert.equal(restored, true); assert.equal(title.textContent, name);
    assert.equal(queue.playlist[0].songId, 4); assert.equal(queue.playlist[0].songData, undefined);
    host.document.dispatchEvent({ type: 'pagehide' }); await settle();
    let next = JSON.parse(host.localStorage.getItem('aurora_playlist_snapshot_v3'));
    assert.equal(next.tracks[0].detailPending, true);
    assert.equal(pickNewestPlaylistState(next).tracks[0].detailPending, true);
    queue.playlist[0].songData = song(4); queue.playlist[0].name = 'Song 4 - Artist';
    persistence.schedulePlaylistStateSave(true);
    host.document.dispatchEvent({ type: 'pagehide' }); await settle();
    next = JSON.parse(host.localStorage.getItem('aurora_playlist_snapshot_v3'));
    assert.equal(next.tracks[0].detailPending, undefined); assert.equal(next.tracks[0].title, 'Song 4');
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
