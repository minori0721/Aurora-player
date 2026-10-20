import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransfer } from '../src/audio/transfer.js';
import { createPrefetch } from '../src/audio/prefetch.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const transfer = createTransfer();

test('audio transfer respects both declared and streaming size limits', async () => {
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]));
    const complete = await transfer.fetchAudioDataWithFallback(['https://cdn.test/a'], { maxBytes: 10 });
    assert.equal(complete.buffer.byteLength, 4);
    const limited = await transfer.fetchAudioDataWithFallback(['https://cdn.test/a'], { maxBytes: 2 });
    assert.equal(limited.tooLarge, true);
    assert.equal(limited.buffer, null);
    globalThis.fetch = async () => new Response(null, { headers: { 'content-length': '1000' } });
    assert.equal((await transfer.fetchAudioDataWithFallback(['https://cdn.test/a'], { maxBytes: 10 })).tooLarge, true);
});

test('header/body stalls time out, and cancellation interrupts backoff immediately', async () => {
    globalThis.fetch = () => new Promise(() => {});
    await assert.rejects(transfer.fetchAudioDataWithFallback(['https://cdn.test/a'], { headerTimeoutMs: 5 }), error => error.code === 'AUDIO_STALLED');
    globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }));
    await assert.rejects(transfer.fetchAudioDataWithFallback(['https://cdn.test/a'], { idleTimeoutMs: 5 }), error => error.code === 'AUDIO_STALLED');
    const controller = new AbortController();
    const waiting = transfer.abortableDelay(10000, controller.signal);
    controller.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
});

function prefetchFixture(size = 1024, lyrics) {
    globalThis.window = {};
    globalThis.matchMedia = () => ({ matches: false });
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    const auth = { neteaseQuality: 'exhigh', neteaseCookie: '', authGeneration: 1 };
    const queue = { playlist: [{ name: 'current' }, { netease: true, songId: 2, name: 'next', songData: { id: 2, size } }], curIdx: 0, playMode: 0 };
    const calls = { urls: 0, bodies: 0, invalidations: 0 };
    const resolved = { audioInfo: { url: 'https://cdn.test/a', size }, audioUrl: 'https://cdn.test/a', candidates: ['https://cdn.test/a'] };
    const resolver = {
        getNeteaseMatchStrategy: () => 'balanced',
        resolveNeteaseAudioUrlWithTimeout: async () => { calls.urls++; return resolved; },
        invalidateNeteaseResolvedAudioCache: async () => { calls.invalidations++; }
    };
    const transfers = {
        awaitWithSignal: transfer.awaitWithSignal,
        fetchAudioDataWithFallback: async () => { calls.bodies++; return { buffer: new ArrayBuffer(8), byteLength: 8, audioUrl: 'https://cdn.test/a' }; }
    };
    const playback = { getActiveCustomLoop: () => null, playbackState: { isPlaying: true } };
    const prefetch = createPrefetch({ auth, queue, resolver, playback, lyrics, transfer: transfers, debug: { log() {} } });
    return { prefetch, auth, queue, calls, resolver, transfers, resolved, playback };
}

test('lyrics start with full next-audio prefetch, not URL prewarm, and do not delay the audio', async () => {
    const ids = []; let active = false;
    const lyrics = { prefetchLyricById(id) { ids.push(id); active = true; }, cancelLyricPrefetch() { active = false; } };
    const { prefetch, calls } = prefetchFixture(1024, lyrics);
    prefetch.prewarmNextNeteaseSongUrl(); await tick(); assert.deepEqual(ids, []);
    await prefetch.prefetchNextSong(1); await prefetch.nextSongFetchPromise; await tick();
    assert.deepEqual(ids, [2]); assert.equal(prefetch.hasPreloaded, true); assert.equal(active, true);
    await prefetch.prefetchNextSong(1); assert.deepEqual(ids, [2]); assert.equal(calls.bodies, 1);
    prefetch.cancelNextPreload(); assert.equal(active, false);
});

test('local files and loop modes never launch next-song lyric prefetch', async () => {
    const ids = [], lyrics = { prefetchLyricById: id => ids.push(id), cancelLyricPrefetch() {} };
    const local = prefetchFixture(1024, lyrics);
    local.queue.playlist[1] = { name: 'local.wav', file: { size: 8, arrayBuffer: async () => new ArrayBuffer(8) } };
    await local.prefetch.prefetchNextSong(1); await local.prefetch.nextSongFetchPromise; await tick();
    assert.deepEqual(ids, []);
    for (const custom of [false, true]) {
        const f = prefetchFixture(1024, lyrics); f.queue.playMode = custom ? 0 : 2;
        f.playback.getActiveCustomLoop = () => custom ? { start: 1, end: 2 } : null;
        await f.prefetch.prefetchNextSong(1);
    }
    assert.deepEqual(ids, []);
});

test('URL prewarm and body download share one resolution; repeated requests do not redownload', async () => {
    const { prefetch, calls, queue } = prefetchFixture();
    prefetch.prewarmNextNeteaseSongUrl();
    await tick();
    await prefetch.prefetchNextSong(1);
    await prefetch.nextSongFetchPromise;
    await tick();
    assert.equal(calls.urls, 1);
    assert.equal(calls.bodies, 1);
    assert.equal(prefetch.hasPreloaded, true);
    await prefetch.prefetchNextSong(1);
    assert.equal(calls.bodies, 1);
    const compressed = prefetch.takeNextPreloadedRawData(1, queue.playlist[1], 2, 'exhigh');
    assert.ok(compressed);
    assert.equal(calls.bodies, 1);
});

test('oversize online audio keeps only the URL, never opens the body request', async () => {
    const { prefetch, calls } = prefetchFixture(100 * 1024 * 1024);
    await prefetch.prefetchNextSong(1);
    await prefetch.nextSongFetchPromise;
    await tick();
    assert.equal(calls.urls, 1);
    assert.equal(calls.bodies, 0);
    assert.equal(prefetch.nextPreloadStatus, 'url-ready');
    assert.equal(prefetch.nextSongRawData, null);
});

test('an expired URL refreshes once; an account change prevents late preload adoption', async () => {
    const state = prefetchFixture();
    state.transfers.fetchAudioDataWithFallback = async () => { state.calls.bodies++; throw Object.assign(new Error('expired'), { status: 403 }); };
    await state.prefetch.prefetchNextSong(1);
    await state.prefetch.nextSongFetchPromise.catch(() => {});
    await tick();
    assert.equal(state.calls.invalidations, 1);
    assert.equal(state.calls.urls, 2);
    assert.equal(state.calls.bodies, 2);
    assert.equal(state.prefetch.nextPreloadStatus, 'failed');
    const late = prefetchFixture();
    let finish;
    late.transfers.fetchAudioDataWithFallback = () => new Promise(resolve => { finish = resolve; });
    await late.prefetch.prefetchNextSong(1);
    await tick();
    late.auth.authGeneration++;
    finish({ buffer: new ArrayBuffer(8), audioUrl: 'https://cdn.test/a' });
    await late.prefetch.nextSongFetchPromise.catch(() => {});
    await tick();
    assert.equal(late.prefetch.hasPreloaded, false);
    assert.equal(late.prefetch.nextSongRawData, null);
    late.prefetch.cancelNextPreload();
});
