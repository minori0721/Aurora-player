import test from 'node:test';
import assert from 'node:assert/strict';
import { createMyPlaylists } from '../src/netease/my-playlists.js';
import { FakeElement } from './helpers/host.mjs';

function fixture(t, fetcher) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const element = new FakeElement();
    globalThis.document = { getElementById: () => element };
    t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
    const urls = [];
    const service = createMyPlaylists({ api: { buildApiUrl: path => 'https://api.test' + path },
        auth: { neteaseUser: { userId: 4 }, captureAuthSnapshot: () => ({ cookie: '' }), isAuthSnapshotCurrent: () => true,
            async accountFetch(url, options) { urls.push(url); const index = urls.length; return { ok: true, json: async () => fetcher(index, options) }; } },
        content: { clearMusicImages() {}, observeMusicImages() {} } });
    return { service, urls };
}
const playlist = name => ({ code: 200, more: false, playlist: [{ id: 50, name, creator: { userId: 4 } }] });

test('song write invalidates catalog and next load bypasses old backend URL cache', async t => {
    const f = fixture(t, count => playlist(count === 1 ? 'Before' : 'After'));
    await f.service.loadMyPlaylists(); assert.equal(f.service.myPlaylistsComplete, true);
    f.service.invalidateAfterSongWrite({ songId: 1, playlistId: 50 });
    assert.equal(f.service.myPlaylistsComplete, false); assert.deepEqual(f.service.myPlaylistsData, []);
    await f.service.loadMyPlaylists();
    assert.equal(f.service.myPlaylistsData[0].name, 'After');
    assert.equal(new URL(f.urls[0]).searchParams.has('songWriteRevision'), false);
    assert.equal(new URL(f.urls[1]).searchParams.has('songWriteRevision'), true);
});

test('catalog response from before a song write cannot overwrite refreshed data', async t => {
    let resolveOld;
    const f = fixture(t, count => count === 1 ? new Promise(resolve => { resolveOld = resolve; }) : playlist('New'));
    const old = f.service.loadMyPlaylists();
    f.service.invalidateAfterSongWrite();
    await f.service.loadMyPlaylists();
    resolveOld(playlist('Stale')); await old;
    assert.equal(f.service.myPlaylistsData[0].name, 'New'); assert.equal(f.service.myPlaylistsComplete, true);
});
