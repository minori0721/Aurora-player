import test from 'node:test';
import assert from 'node:assert/strict';
import { createMyPlaylists } from '../src/netease/my-playlists.js';
import { FakeElement } from './helpers/host.mjs';

function fixture(t, fetcher) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const element = new FakeElement();
    globalThis.document = { getElementById: () => element };
    t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
    const urls = [], calls = [];
    const auth = { generation: 0, neteaseCookie: 'MUSIC_U=synthetic', neteaseUser: { userId: 4 }, accountAbortControllers: new Set(),
        captureAuthSnapshot() { return { generation: this.generation, cookie: this.neteaseCookie }; },
        isAuthSnapshotCurrent(value) { return value.generation === this.generation && value.cookie === this.neteaseCookie; } };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        urls.push(url);
        const call = { body: JSON.parse(options.body), options }; calls.push(call);
        return { ok: true, status: 200, json: async () => fetcher(calls.length, call) };
    });
    const service = createMyPlaylists({ api: { buildApiUrl: path => 'https://api.test' + path }, auth,
        content: { clearMusicImages() {}, observeMusicImages() {} } });
    t.after(() => service.reset());
    return { service, urls, calls, auth, element };
}
const playlist = name => ({ code: 200, more: false, playlist: [{ id: 50, name, creator: { userId: 4 } }] });

test('song write invalidates catalog and next load bypasses old backend URL cache', async t => {
    const f = fixture(t, count => playlist(count === 1 ? 'Before' : 'After'));
    await f.service.loadMyPlaylists(); assert.equal(f.service.myPlaylistsComplete, true);
    f.service.invalidateAfterSongWrite({ songId: 1, playlistId: 50 });
    assert.equal(f.service.myPlaylistsComplete, false); assert.equal(f.service.myPlaylistsData[0].name, 'Before');
    await f.service.loadMyPlaylists();
    assert.equal(f.service.myPlaylistsData[0].name, 'After');
    assert.equal(f.calls[0].body.songWriteRevision, undefined);
    assert.equal(typeof f.calls[1].body.songWriteRevision, 'string');
    assert.ok(f.urls.every(url => !/cookie|synthetic/i.test(url)));
});

test('catalog response from before a song write cannot overwrite refreshed data', async t => {
    let resolveOld;
    const f = fixture(t, count => count === 1 ? new Promise(resolve => { resolveOld = resolve; }) : playlist('New'));
    const old = f.service.loadMyPlaylists();
    await Promise.resolve();
    f.service.invalidateAfterSongWrite();
    await f.service.loadMyPlaylists();
    resolveOld(playlist('Stale')); await old;
    assert.equal(f.service.myPlaylistsData[0].name, 'New'); assert.equal(f.service.myPlaylistsComplete, true);
});

const rows = (from, count) => Array.from({ length: count }, (_, index) => ({ id: from + index, name: `List ${from + index}`, creator: { userId: 4 } }));
const settle = async () => { for (let index = 0; index < 12; index++) await new Promise(resolve => setImmediate(resolve)); };

test('31 successful rows with more false finish after one POST and reuse the same data for both consumers', async t => {
    const f = fixture(t, () => ({ code: 200, more: false, playlist: rows(1, 31) }));
    await Promise.all([f.service.loadMyPlaylists(), f.service.ensurePlaylists()]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].options.method, 'POST'); assert.equal(f.calls[0].body.limit, 30);
    assert.equal(f.service.myPlaylistsData.length, 31); assert.equal(f.service.myPlaylistsComplete, true);
    await f.service.ensurePlaylists(); await f.service.loadMyPlaylists();
    assert.equal(f.calls.length, 1);
});

test('shared pagination advances requested windows and deduplicates an extra overlapping row', async t => {
    const f = fixture(t, (_, call) => ({ code: 200, playlist: call.body.offset === 0 ? rows(1, 31) : rows(31, 2), more: call.body.offset === 0 }));
    const updates = [];
    await Promise.all([f.service.ensurePlaylists({ onUpdate: state => updates.push(state.items.length) }), f.service.ensurePlaylists()]);
    assert.deepEqual(f.calls.map(call => call.body.offset), [0, 30]);
    assert.equal(f.service.myPlaylistsData.length, 32); assert.ok(updates.includes(31));
});

test('missing more falls back to page length; a short final page ends the shared load', async t => {
    const f = fixture(t, (_, call) => ({ code: 200, playlist: call.body.offset === 0 ? rows(1, 30) : rows(31, 1) }));
    await f.service.ensurePlaylists();
    assert.deepEqual(f.calls.map(call => call.body.offset), [0, 30]);
    assert.equal(f.service.myPlaylistsComplete, true);
});

test('later business failure retains partial data and error HTML never means complete; retry resumes the failed window', async t => {
    let fail = true;
    const f = fixture(t, (_, call) => call.body.offset === 0 ? { code: 200, more: true, playlist: rows(1, 30) }
        : fail ? { code: 502 } : { code: 200, more: false, playlist: rows(31, 1) });
    await f.service.loadMyPlaylists(); await settle();
    assert.equal(f.service.myPlaylistsComplete, false); assert.equal(f.service.myPlaylistsData.length, 30);
    assert.match(f.element.innerHTML, /加载失败/); assert.ok(f.service.myPlaylistsCache);
    fail = false;
    await f.service.ensurePlaylists();
    assert.deepEqual(f.calls.map(call => call.body.offset), [0, 30, 30]);
    assert.equal(f.service.myPlaylistsComplete, true); assert.equal(f.service.myPlaylistsData.length, 31);
});

for (const page of [[], rows(1, 30)]) {
    test(`empty/repeated page with more true stops without caching a complete result: ${page.length}`, async t => {
        const f = fixture(t, (_, call) => ({ code: 200, more: true, playlist: call.body.offset === 0 ? rows(1, 30) : page }));
        await assert.rejects(f.service.ensurePlaylists(), /未取得进展/);
        assert.equal(f.calls.length, 2); assert.equal(f.service.myPlaylistsComplete, false);
        assert.equal(f.service.myPlaylistsData.length, 30); assert.equal(f.service.playlistsState.nextOffset, 30);
    });
}

test('closing one consumer does not abort the shared page needed by the other', async t => {
    let respond;
    const f = fixture(t, () => new Promise(resolve => { respond = resolve; }));
    const controller = new AbortController();
    const first = f.service.ensurePlaylists({ signal: controller.signal });
    const cancelled = assert.rejects(first, { name: 'AbortError' });
    const second = f.service.ensurePlaylists();
    await settle(); controller.abort(); await cancelled;
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.signal.aborted, false);
    respond({ code: 200, more: false, playlist: rows(1, 31) });
    assert.equal((await second).items.length, 31);
});

test('when the last consumer leaves, finish only the current page and resume later without rereading it', async t => {
    let respond;
    const f = fixture(t, count => count === 1 ? new Promise(resolve => { respond = resolve; }) : { code: 200, more: false, playlist: rows(31, 1) });
    const controller = new AbortController();
    const first = f.service.ensurePlaylists({ signal: controller.signal });
    const cancelled = assert.rejects(first, { name: 'AbortError' });
    await settle(); controller.abort(); await cancelled;
    respond({ code: 200, more: true, playlist: rows(1, 30) }); await settle();
    assert.equal(f.calls.length, 1); assert.equal(f.service.myPlaylistsComplete, false);
    await f.service.ensurePlaylists();
    assert.deepEqual(f.calls.map(call => call.body.offset), [0, 30]);
});

test('expired cache refreshes once from offset zero and callers continue sharing that refresh', async t => {
    let now = 100_000;
    t.mock.method(Date, 'now', () => now);
    const f = fixture(t, count => playlist(`Version ${count}`));
    await f.service.ensurePlaylists();
    now += 59_999; await f.service.ensurePlaylists(); assert.equal(f.calls.length, 1);
    now += 1;
    await Promise.all([f.service.ensurePlaylists(), f.service.loadMyPlaylists()]);
    assert.equal(f.calls.length, 2); assert.deepEqual(f.calls.map(call => call.body.offset), [0, 0]);
    assert.equal(f.service.myPlaylistsData[0].name, 'Version 2');
});

test('old account response cannot overwrite a new catalog, even if the old transport ignores cancellation', async t => {
    let respond;
    const f = fixture(t, count => count === 1 ? new Promise(resolve => { respond = resolve; }) : playlist('New account'));
    const old = f.service.ensurePlaylists(), cancelled = assert.rejects(old, { name: 'AbortError' });
    await settle();
    f.auth.generation++; f.auth.neteaseCookie = 'MUSIC_U=other-synthetic'; f.auth.neteaseUser = { userId: 5 };
    await f.service.ensurePlaylists();
    respond(playlist('Old account')); await cancelled; await settle();
    assert.equal(f.service.myPlaylistsData[0].name, 'New account'); assert.equal(f.service.myPlaylistsComplete, true);
});

test('one failed renderer cannot cancel the other consumer or turn a valid catalog into an API failure', async t => {
    const f = fixture(t, () => playlist('Valid'));
    const broken = f.service.ensurePlaylists({ onUpdate(state) { if (state.items.length) throw new Error('render failed'); } });
    const rejected = assert.rejects(broken, /render failed/);
    const healthy = f.service.ensurePlaylists();
    await rejected; const state = await healthy;
    assert.equal(f.calls.length, 1); assert.equal(state.complete, true); assert.equal(state.loading, false);
    assert.equal(state.error, null); assert.equal(state.items[0].name, 'Valid');
});

test('shared account page timeout covers a stalled body and leaves a retryable incomplete result', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, () => new Promise(() => {}));
    const result = f.service.ensurePlaylists(), rejected = assert.rejects(result, { name: 'TimeoutError' });
    await settle(); t.mock.timers.tick(15_000); await rejected;
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.signal.aborted, true);
    assert.equal(f.service.myPlaylistsComplete, false); assert.equal(f.service.myPlaylistsLoading, false);
    assert.equal(f.auth.accountAbortControllers.size, 0);
});

for (const body of [{ code: 200 }, { code: 200, playlist: [null], more: false }, { code: 200, playlist: [], more: 'false' }]) {
    test(`malformed successful catalog response is never cached as an empty complete list: ${JSON.stringify(body)}`, async t => {
        const f = fixture(t, () => body);
        await assert.rejects(f.service.ensurePlaylists(), /格式异常/);
        assert.equal(f.service.myPlaylistsComplete, false); assert.deepEqual(f.service.myPlaylistsData, []);
    });
}
