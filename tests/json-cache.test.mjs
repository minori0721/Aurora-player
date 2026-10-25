import test from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../src/storage/cache.js';
import { canRevalidateJson, describeJsonCache, jsonCacheEntryBytes, jsonCacheEvictions, JSON_CACHE_LIMITS } from '../src/storage/cache-policy.js';
import { createLyricRequests, lyricCacheTtl } from '../src/lyrics/requests.js';
import { createTransfer } from '../src/audio/transfer.js';
import { createMemoryIndexedDb } from './helpers/indexeddb.mjs';
import { isMusicStaticResponse } from '../src/netease/content.js';

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const albumUrl = id => `https://fixture.invalid/album?id=${id}`;
const staleOptions = { staleWhileRevalidate: true };
const payload = name => ({ code: 200, name });
const response = data => ({ ok: true, json: async () => data });

function fixture(t) {
    const indexedDB = createMemoryIndexedDb(), calls = [], state = { now: Date.now(), handler: () => response(payload('new')) };
    t.mock.method(Date, 'now', () => state.now);
    for (const [name, value] of Object.entries({ indexedDB, window: { location: { href: 'https://fixture.invalid/' } },
        navigator: { onLine: true }, fetch: (url, options) => { calls.push({ url, options }); return Promise.resolve(state.handler(url, options)); } })) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
    }
    const cache = createCache({ transfer: createTransfer() });
    const seed = (url, data = payload('old'), age = 2000, bytes) => {
        const entry = { ts: state.now - age, data };
        if (bytes !== undefined) entry.bytes = bytes;
        indexedDB.stores.get('metadata').set(describeJsonCache(url).key, entry);
        return entry;
    };
    return { cache, indexedDB, calls, state, seed };
}

test('stale reuse requires opt-in, a public static endpoint and a credential-free GET', t => {
    fixture(t);
    for (const path of ['/album', '/artists', '/artist/detail', '/artist/top/song', '/artist/songs', '/artist/album', '/artist/mv', '/lyric/new']) {
        assert.equal(canRevalidateJson('https://fixture.invalid/api' + path, 'public', staleOptions), true);
    }
    for (const path of ['/cloudsearch', '/song/detail', '/song/url/v1', '/song/url/match', '/album/sub', '/album/detail/dynamic', '/artist/detail/dynamic', '/login/status']) {
        assert.equal(canRevalidateJson('https://fixture.invalid' + path, 'public', staleOptions), false);
    }
    assert.equal(canRevalidateJson(albumUrl(1), 'public', {}), false);
    for (const options of [{ method: 'POST' }, { headers: { Authorization: 'fake' } }, { headers: { Cookie: 'fake' } }]) {
        assert.equal(canRevalidateJson(albumUrl(1), 'public', { ...staleOptions, ...options }), false);
    }
    assert.equal(canRevalidateJson(albumUrl(1), 'account', staleOptions), false);
});

test('entry bytes use UTF-8 and are measured once, without serializing cache hits again', () => {
    let calls = 0;
    const data = { toJSON() { calls++; return { name: '\u6b4c\u66f2' }; } }, entry = { data };
    assert.equal(jsonCacheEntryBytes(entry), Buffer.byteLength('{"name":"\u6b4c\u66f2"}'));
    assert.equal(jsonCacheEntryBytes(entry), entry.bytes); assert.equal(calls, 1);
});

test('static entity validation rejects malformed HTTP 200 responses but accepts empty lists', () => {
    for (const path of ['/album', '/artists', '/artist/detail', '/artist/songs', '/artist/top/song', '/artist/album', '/artist/mv']) {
        assert.equal(isMusicStaticResponse(path, { code: 200 }), false);
    }
    assert.equal(isMusicStaticResponse('/album?id=1', { album: { id: 1 }, songs: [] }), true);
    assert.equal(isMusicStaticResponse('/artist/album?id=1', { hotAlbums: [] }), true);
    assert.equal(isMusicStaticResponse('/artists?id=1', { artist: { id: 1 } }), true);
});

test('disk pruning combines age, entry count and bytes, retaining unsized legacy data', () => {
    const now = 2_000_000_000, mb = 1024 * 1024;
    const entries = [{ key: 'new', ts: now, bytes: 40 * mb }, { key: 'large', ts: now - 1, bytes: 40 * mb },
        { key: 'legacy', ts: now - 2 }, { key: 'small', ts: now - 3, bytes: mb },
        { key: 'old', ts: now - JSON_CACHE_LIMITS.maxAge - 1, bytes: 1 }];
    assert.deepEqual(jsonCacheEvictions(entries, now).map(entry => entry.key), ['large', 'old']);
    assert.equal(jsonCacheEvictions(Array.from({ length: 201 }, (_, index) => ({ key: index, ts: now - index, bytes: 1 })), now).length, 1);
});

test('fresh public cache survives a new cache instance and makes no extra GETs', async t => {
    const f = fixture(t), url = albumUrl(1);
    await f.cache.cachedFetchJson(url, staleOptions, 1000);
    for (let i = 0; i < 20; i++) await f.cache.cachedFetchJson(url, staleOptions, 1000);
    const reloaded = createCache({ transfer: createTransfer() });
    assert.equal((await reloaded.cachedFetchJson(url, staleOptions, 1000)).name, 'new'); assert.equal(f.calls.length, 1);
});

test('twenty stale readers share one refresh, and refresh only changes future loads', async t => {
    const f = fixture(t), url = albumUrl(1), pending = deferred(); f.seed(url); f.state.handler = () => pending.promise;
    const values = await Promise.all(Array.from({ length: 20 }, () => f.cache.cachedFetchJson(url, staleOptions, 1000)));
    await settle(); assert.equal(f.calls.length, 1); assert.ok(values.every(value => value.name === 'old'));
    const old = values[0]; pending.resolve(response(payload('updated'))); await settle();
    assert.equal((await f.cache.cachedFetchJson(url, staleOptions, 1000)).name, 'updated');
    assert.equal(old.name, 'old'); assert.equal(f.calls.length, 1);
    for (const name of ['staleWhileRevalidate', 'readResponse', 'onRequestStart']) assert.equal(name in f.calls[0].options, false);
    assert.equal(f.calls[0].url, url);
});

test('manual refresh joins an in-flight background request instead of issuing a second one', async t => {
    const f = fixture(t), url = albumUrl(1), pending = deferred(); f.seed(url); f.state.handler = () => pending.promise;
    await f.cache.cachedFetchJson(url, staleOptions, 1000); await settle();
    const manual = f.cache.cachedFetchJson(url, { ...staleOptions, forceRefresh: true }, 1000);
    pending.resolve(response(payload('manual')));
    assert.equal((await manual).name, 'manual'); assert.equal(f.calls.length, 1);
});

test('failed manual static refresh bypasses reads but retains the previous good cache', async t => {
    const f = fixture(t), url = albumUrl(1); f.seed(url, payload('old'), 1);
    f.state.handler = () => { throw new Error('offline'); };
    await assert.rejects(f.cache.cachedFetchJson(url, { ...staleOptions, forceRefresh: true }, 1000), /offline/);
    assert.equal((await f.cache.cachedFetchJson(url, staleOptions, 1000)).name, 'old');
    assert.equal(f.calls.length, 1);
    assert.equal(f.indexedDB.stores.get('metadata').get(describeJsonCache(url).key).data.name, 'old');
});

test('audio URL forced refresh still invalidates the previous address on failure', async t => {
    const f = fixture(t), url = 'https://fixture.invalid/song/url/v1?id=1'; f.seed(url, payload('old'), 1);
    f.state.handler = () => { throw new Error('offline'); };
    await assert.rejects(f.cache.cachedFetchJson(url, { ...staleOptions, forceRefresh: true }, 1000), /offline/);
    assert.equal(f.indexedDB.stores.get('metadata').has(describeJsonCache(url).key), false);
    f.state.handler = () => response(payload('new'));
    assert.equal((await f.cache.cachedFetchJson(url, {}, 1000)).name, 'new'); assert.equal(f.calls.length, 2);
});

test('audio URL force invalidates old disk data even when joining a pending request', async t => {
    const f = fixture(t), url = 'https://fixture.invalid/song/url/v1?id=1', pending = deferred(); f.seed(url);
    f.state.handler = () => pending.promise;
    const normal = f.cache.cachedFetchJson(url, {}, 1000); await settle();
    const forced = f.cache.cachedFetchJson(url, { forceRefresh: true }, 1000);
    const outcome = Promise.allSettled([normal, forced]); await settle();
    assert.equal(f.indexedDB.stores.get('metadata').has(describeJsonCache(url).key), false);
    pending.reject(new Error('offline'));
    assert.ok((await outcome).every(result => result.status === 'rejected')); assert.equal(f.calls.length, 1);
});

test('failed refresh keeps the old success and cools down for five minutes without a retry timer', async t => {
    const f = fixture(t), url = albumUrl(1); f.seed(url); f.state.handler = () => { throw new Error('offline'); };
    assert.equal((await f.cache.cachedFetchJson(url, staleOptions, 1000)).name, 'old'); await settle();
    for (let i = 0; i < 20; i++) await f.cache.cachedFetchJson(url, staleOptions, 1000);
    assert.equal(f.calls.length, 1); f.state.now += 300_001; assert.equal(f.calls.length, 1);
    await f.cache.cachedFetchJson(url, staleOptions, 1000); await settle(); assert.equal(f.calls.length, 2);
});

test('malformed or unsuccessful JSON cannot overwrite a valid stale entry', async t => {
    const f = fixture(t), url = albumUrl(1); f.seed(url); f.state.handler = () => response({ code: 500 });
    await f.cache.cachedFetchJson(url, staleOptions, 1000); await settle();
    assert.equal(f.indexedDB.stores.get('metadata').get(describeJsonCache(url).key).data.name, 'old');
    await f.cache.cachedFetchJson(url, staleOptions, 1000); assert.equal(f.calls.length, 1);
});

test('endpoint predicates protect the old data from structurally invalid success responses', async t => {
    const f = fixture(t), url = albumUrl(1), good = { code: 200, album: { id: 1 }, songs: [] }; f.seed(url, good);
    f.state.handler = () => response({ code: 200 });
    const options = { ...staleOptions, cachePredicate: data => isMusicStaticResponse('/album', data) };
    assert.deepEqual(await f.cache.cachedFetchJson(url, options, 1000), good); await settle();
    assert.deepEqual(f.indexedDB.stores.get('metadata').get(describeJsonCache(url).key).data, good);
});

test('a manual retry bypasses cooldown and a missing entry is never blocked', async t => {
    const f = fixture(t), url = albumUrl(1); f.seed(url); f.state.handler = () => { throw new Error('offline'); };
    await f.cache.cachedFetchJson(url, staleOptions, 1000); await settle();
    f.state.handler = () => response(payload('recovered'));
    assert.equal((await f.cache.cachedFetchJson(url, { ...staleOptions, forceRefresh: true }, 1000)).name, 'recovered');
    assert.equal((await f.cache.cachedFetchJson(albumUrl(2), staleOptions, 1000)).name, 'recovered'); assert.equal(f.calls.length, 3);
});

test('search, audio URLs, dynamic endpoints and expired accounts never return stale data', async t => {
    const f = fixture(t);
    for (const path of ['/cloudsearch?q=x', '/song/url/v1?id=1', '/album/detail/dynamic?id=1']) {
        const url = 'https://fixture.invalid' + path; f.seed(url);
        assert.equal((await f.cache.cachedFetchJson(url, staleOptions, 1000)).name, 'new');
    }
    const url = albumUrl(9) + '&cookie=fake'; await f.cache.cachedFetchJson(url, staleOptions, 1000);
    f.state.now += 2000; f.state.handler = () => response(payload('account-new'));
    assert.equal((await f.cache.cachedFetchJson(url, staleOptions, 1000)).name, 'account-new');
    assert.equal([...f.indexedDB.stores.get('metadata').keys()].some(key => key.includes('cookie') || key.includes('json-account')), false);
});

test('data older than seven days is fetched normally, not served as a stale success', async t => {
    const f = fixture(t), url = albumUrl(1); f.seed(url, payload('old'), JSON_CACHE_LIMITS.maxAge + 1);
    assert.equal((await f.cache.cachedFetchJson(url, staleOptions, 1000)).name, 'new');
});

test('known offline state serves the old static data without starting a request', async t => {
    const f = fixture(t), url = albumUrl(1); f.seed(url); navigator.onLine = false;
    assert.equal((await f.cache.cachedFetchJson(url, staleOptions, 1000)).name, 'old'); assert.equal(f.calls.length, 0);
});

test('a sent public refresh survives navigation and is reused on reopening', async t => {
    const f = fixture(t), url = albumUrl(1), pending = deferred(), controller = new AbortController();
    f.seed(url); f.state.handler = () => pending.promise;
    await f.cache.cachedFetchJson(url, { ...staleOptions, signal: controller.signal }, 1000); await settle();
    controller.abort(); assert.equal(f.calls[0].options.signal.aborted, false);
    await f.cache.cachedFetchJson(url, staleOptions, 1000); pending.resolve(response(payload('finished'))); await settle();
    assert.equal((await f.cache.cachedFetchJson(url, staleOptions, 1000)).name, 'finished'); assert.equal(f.calls.length, 1);
});

test('navigation cancels queued refreshes before they make any request', async t => {
    const f = fixture(t), blockers = [], url = albumUrl(1), controller = new AbortController(); f.seed(url);
    f.state.handler = () => { const pending = deferred(); blockers.push(pending); return pending.promise; };
    const first = [1, 2, 3].map(id => f.cache.cachedFetchJson(`https://fixture.invalid/block/${id}`, { cacheScope: 'none' }));
    await settle(); await f.cache.cachedFetchJson(url, { ...staleOptions, signal: controller.signal }, 1000); controller.abort();
    await settle(); blockers.forEach(task => task.resolve(response(payload('done'))));
    await Promise.all(first); await settle(); assert.equal(f.calls.length, 3);
});

test('refresh timeout covers a stalled body and releases the idle queue without retrying', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t), url = albumUrl(1); f.seed(url);
    f.state.handler = () => ({ ok: true, json: () => new Promise(() => {}) });
    await f.cache.cachedFetchJson(url, staleOptions, 1000); await settle(); t.mock.timers.tick(12_001); await settle();
    assert.equal(f.calls[0].options.signal.aborted, true);
    await f.cache.cachedFetchJson(url, staleOptions, 1000); assert.equal(f.calls.length, 1);
    f.state.handler = () => response(payload('next'));
    await f.cache.cachedFetchJson(albumUrl(2), { cacheScope: 'none', priority: 'idle' }); assert.equal(f.calls.length, 2);
});

test('two refreshes cannot occupy the idle slot together while the first JSON body is pending', async t => {
    const f = fixture(t), pending = deferred(); f.seed(albumUrl(1)); f.seed(albumUrl(2));
    f.state.handler = () => f.calls.length === 1 ? { ok: true, json: () => pending.promise } : response(payload('second'));
    await f.cache.cachedFetchJson(albumUrl(1), staleOptions, 1000);
    await f.cache.cachedFetchJson(albumUrl(2), staleOptions, 1000); await settle(); assert.equal(f.calls.length, 1);
    pending.resolve(payload('first')); await settle(); assert.equal(f.calls.length, 2);
    assert.equal((await f.cache.cachedFetchJson(albumUrl(2), staleOptions, 1000)).name, 'second');
});

test('disk cleanup respects its byte budget and never evicts player snapshots', async t => {
    const f = fixture(t), values = f.indexedDB.stores.get('metadata'), player = f.indexedDB.stores.get('player-state');
    f.seed(albumUrl(1), payload('newer'), 1, 40 * 1024 * 1024);
    f.seed(albumUrl(2), payload('older'), 2, 40 * 1024 * 1024);
    player.set('current-playlist', { tracks: [1, 2, 3] }); f.cache.initialize(); await settle();
    assert.equal(values.has(describeJsonCache(albumUrl(1)).key), true);
    assert.equal(values.has(describeJsonCache(albumUrl(2)).key), false);
    assert.deepEqual(player.get('current-playlist'), { tracks: [1, 2, 3] });
});

test('legacy sizes are backfilled lazily without touching player state', async t => {
    const f = fixture(t), url = albumUrl(1); f.seed(url, payload('fresh'), 1); f.seed(albumUrl(2), payload('untouched'), 1);
    f.indexedDB.stores.get('player-state').set('current-playlist', { tracks: [{ name: 'saved' }] });
    f.cache.initialize(); await settle();
    assert.equal(f.indexedDB.stores.get('metadata').get(describeJsonCache(url).key).bytes, undefined);
    await f.cache.cachedFetchJson(url, staleOptions, 1000); await settle();
    assert.ok(f.indexedDB.stores.get('metadata').get(describeJsonCache(url).key).bytes > 0);
    assert.equal(f.indexedDB.stores.get('metadata').get(describeJsonCache(albumUrl(2)).key).bytes, undefined);
    assert.deepEqual(f.indexedDB.stores.get('player-state').get('current-playlist'), { tracks: [{ name: 'saved' }] }); assert.equal(f.calls.length, 0);
});

test('public memory obeys its byte budget independently of the disk cache', async t => {
    const f = fixture(t);
    for (let id = 0; id < 9; id++) { f.seed(albumUrl(id), payload(String(id)), 1, 2 * 1024 * 1024); await f.cache.cachedFetchJson(albumUrl(id), {}, 1000); }
    const before = f.indexedDB.stats.reads; await f.cache.cachedFetchJson(albumUrl(0), {}, 1000);
    assert.equal(f.indexedDB.stats.reads, before + 1); assert.equal(f.calls.length, 0);
});

test('account memory has a separate byte budget and is never persisted', async t => {
    const f = fixture(t), text = 'x'.repeat(2 * 1024 * 1024); f.state.handler = () => response({ code: 200, text });
    for (let id = 0; id < 9; id++) await f.cache.cachedFetchJson(albumUrl(id) + '&cookie=fake', {}, 1000);
    await f.cache.cachedFetchJson(albumUrl(0) + '&cookie=fake', {}, 1000);
    assert.equal(f.calls.length, 10); assert.equal(f.indexedDB.stores.get('metadata').size, 0);
    f.cache.clearAccountJsonCache(); await f.cache.cachedFetchJson(albumUrl(8) + '&cookie=fake', {}, 1000); assert.equal(f.calls.length, 11);
});

test('logout aborts in-flight account work and a late response cannot restore its cache', async t => {
    const f = fixture(t), pending = deferred(), url = albumUrl(1) + '&cookie=fake'; f.state.handler = () => pending.promise;
    const request = f.cache.cachedFetchJson(url); await settle(); f.cache.clearAccountJsonCache();
    await assert.rejects(request, { name: 'AbortError' }); pending.resolve(response(payload('old-account'))); await settle();
    f.state.handler = () => response(payload('new-account'));
    assert.equal((await f.cache.cachedFetchJson(url)).name, 'new-account'); assert.equal(f.calls.length, 2);
});

test('lyric text stays fresh for a day while empty and no-lyrics results expire after an hour', async t => {
    const f = fixture(t), requests = createLyricRequests({ cache: f.cache, api: { buildApiUrl: path => 'https://fixture.invalid' + path } });
    f.state.handler = () => response({ code: 200, lrc: { lyric: '[00:01]words' } });
    await requests.load(1); f.state.now += 2 * 3600_000; await requests.load(1); assert.equal(f.calls.length, 1);
    assert.equal(lyricCacheTtl({ code: 200, lrc: { lyric: '' } }), 3600_000);
    assert.equal(lyricCacheTtl({ code: 200, nolyric: true }), 3600_000);
    assert.equal(lyricCacheTtl({ code: 200, lrc: { lyric: 5 }, yrc: { lyric: 'words' } }), 24 * 3600_000);
    f.state.handler = () => response({ code: 200, nolyric: true });
    await requests.load(2); f.state.now += 3600_001; await requests.load(2); await settle(); assert.equal(f.calls.length, 3);
});
