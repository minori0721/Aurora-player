import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createOnlinePlaylist } from '../src/netease/playlist.js';
import { createDom } from '../src/ui/elements.js';
import { createHost, FakeElement, withBaseQueue } from './helpers/host.mjs';

const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const song = id => ({ id, name: `Song ${id}`, ar: [], al: {}, dt: 120000 });
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

function fixture(t, guest = false) {
    const { host } = createHost(html);
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: host.document });
    t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
    const dom = createDom(), status = new FakeElement(), message = new FakeElement(), button = new FakeElement();
    status.querySelector = selector => selector === '.playlist-load-message' ? message : button;
    dom.playlistResults.querySelector = selector => selector === '.playlist-load-status' ? status : null;
    dom.playlistPreview.querySelector = selector => selector === '.netease-import-btn' ? button : null;
    const queue = withBaseQueue({ playlist: [], curIdx: -1, confirmReplaceQueue: async () => true, playTrackFromPlaylist() {} });
    const auth = { neteaseCookie: guest ? '' : 'MUSIC_U=synthetic', authGeneration: 1, accountAbortControllers: new Set(),
        neteaseUser: guest ? null : { userId: 123 }, loginStatus: guest ? 'guest' : 'authenticated', waitForLoginStatus: async () => !guest };
    const calls = [], saves = [];
    const service = createOnlinePlaylist({ dom, queue, auth,
        api: { buildApiUrl: path => `https://api.test${path}` },
        transfer: { fetchJsonWithStageTimeout: async (raw, options) => {
            const url = new URL(raw); calls.push({ url, options });
            return url.pathname === '/playlist/detail'
                ? { code: 200, playlist: { id: 436233910, privacy: 0, name: 'Fixture', trackIds: [{ id: 1 }, { id: 2 }], trackCount: 2, tracks: [song(1)] } }
                : { code: 200, songs: [song(2)] };
        } },
        content: { clearMusicImages() {}, renderSongList() {} },
        browser: { navigateMusic() {}, closeMusicBrowser() {} }, panels: { setFloatingPanel() {} },
        playlistView: { renderPlaylist() {}, observePlaylistCovers() {}, appendPlaylistRows() {}, getRenderedPlaylistLength: () => 0 },
        prefetch: { prefetchUpcomingNeteaseDetails() {} }, playback: { playbackState: { status: 'idle' } },
        persistence: { schedulePlaylistStateSave: value => saves.push(value) },
        debug: { log() {} }, imports: { showImportSummary() {} }
    });
    return { service, queue, auth, calls, saves };
}

for (const guest of [false, true]) {
    test(`explicit ${guest ? 'guest' : 'account'} import persists privacy and read identity without credentials`, async t => {
        const f = fixture(t, guest);
        await f.service.loadPlaylistById('436233910'); await f.service.importPlaylistToQueue();
        const source = f.service.getPersistedQueueSource();
        assert.equal(source.readAs, guest ? 'guest' : 123); assert.equal(source.privacy, 0);
        assert.deepEqual(f.queue.playlist.map(track => track.songId), [1, 2]);
        assert.equal(/MUSIC_U|synthetic|cookie/i.test(JSON.stringify(source)), false);
        assert.equal(f.calls.length, 2);
        assert.equal(f.calls[0].options.cache, 'no-store');
        assert.ok(Number(f.calls[0].url.searchParams.get('timestamp')) > 0);
        assert.ok(f.calls.every(call => call.options.credentials === 'omit' && call.url.searchParams.get('noCookie') === 'true'));
        assert.equal(f.calls[0].url.searchParams.get('cookie'), guest ? 'os=pc' : 'MUSIC_U=synthetic');
    });
}

test('identity confirmation after loading completes still updates an explicitly imported source', async t => {
    const f = fixture(t); let confirm;
    f.auth.loginStatus = 'pending'; f.auth.neteaseUser = null;
    f.auth.waitForLoginStatus = () => new Promise(resolve => { confirm = resolve; });
    await f.service.loadPlaylistById('436233910'); await f.service.importPlaylistToQueue();
    assert.equal(f.service.getPersistedQueueSource().readAs, null);
    f.auth.neteaseUser = { userId: 123 }; f.auth.loginStatus = 'authenticated';
    confirm(true); await settle();
    assert.equal(f.service.getPersistedQueueSource().readAs, 123);
    assert.deepEqual(f.saves, [true]);
});

test('late identity confirmation cannot rebind a playlist after user edits detach it', async t => {
    const f = fixture(t); let confirm;
    f.auth.loginStatus = 'pending'; f.auth.neteaseUser = null;
    f.auth.waitForLoginStatus = () => new Promise(resolve => { confirm = resolve; });
    await f.service.loadPlaylistById('436233910'); await f.service.importPlaylistToQueue();
    f.queue.sortBaseTracks((a, b) => b.songId - a.songId);
    f.auth.neteaseUser = { userId: 123 }; confirm(true); await settle();
    assert.equal(f.service.getPersistedQueueSource(), null);
    assert.deepEqual(f.queue.playlist.map(track => track.songId), [2, 1]);
});
