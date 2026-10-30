import test from 'node:test';
import assert from 'node:assert/strict';
import { createResolver } from '../src/netease/audio-url.js';
import { createCache } from '../src/storage/cache.js';
import { createTransfer } from '../src/audio/transfer.js';
import { createMemoryIndexedDb } from './helpers/indexeddb.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const good = () => response({ code: 200, data: 'https://cdn.test/full.flac' });
const idle = { priority: 'idle' };
const manual = { priority: 'normal' };

function fixture(t) {
    const calls = [], indexedDB = createMemoryIndexedDb();
    const state = { now: 2_000_000, handler: url => url.pathname === '/song/url/v1'
        ? response({ code: 200, data: [{ url: null, type: 'flac' }] }) : good() };
    t.mock.method(Date, 'now', () => state.now);
    for (const [name, value] of Object.entries({ indexedDB, window: { location: { href: 'https://player.test/' } },
        fetch: async (raw, options) => { const url = new URL(raw); calls.push({ url, options }); return state.handler(url, options); }
    })) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
    }
    const auth = { neteaseCookie: 'MUSIC_U=synthetic-account', neteaseQuality: 'lossless', authGeneration: 1 };
    const cache = createCache({ transfer: createTransfer() }), invalidations = [];
    const invalidate = cache.invalidateJsonCache;
    cache.invalidateJsonCache = (...args) => { invalidations.push(args[0]); return invalidate(...args); };
    const resolver = createResolver({ auth, cache, transfer: createTransfer(), api: { buildApiUrl: path => `https://api.test${path}` } });
    const match = (options = idle, sources = ['bikonoo', 'msls'], id = 1, level = auth.neteaseQuality) => resolver.fetchNeteaseMatchAudio(id, options, 30_000, sources, level);
    const resolve = (options = manual) => resolver.resolveNeteaseAudioUrlWithTimeout(1, `&cookie=${encodeURIComponent(auth.neteaseCookie)}`, auth.neteaseQuality, options, 30_000, ['bikonoo', 'msls']);
    return { auth, cache, calls, indexedDB, invalidations, resolver, state, match, resolve,
        get matchCalls() { return calls.filter(call => call.url.pathname === '/song/url/match'); } };
}

test('official requests retain account isolation while match GETs never carry credentials', async t => {
    const f = fixture(t), result = await f.resolve();
    assert.equal(result.usedMatch, true); assert.equal(result.matchSource, 'bikonoo');
    assert.equal(f.calls[0].url.searchParams.get('cookie'), f.auth.neteaseCookie);
    assert.equal(f.matchCalls.length, 1);
    assert.equal(f.matchCalls[0].url.searchParams.has('cookie'), false);
    assert.equal(f.matchCalls[0].options.body, undefined);
    assert.equal(f.matchCalls[0].options.method, undefined);
    assert.ok([...f.indexedDB.stores.get('metadata').keys()].every(key => !key.includes('synthetic-account')));
});

test('public match cache is shared across account changes and cleared resolver state', async t => {
    const f = fixture(t);
    await f.match(); f.auth.neteaseCookie = 'MUSIC_U=other-synthetic'; f.auth.authGeneration++;
    f.resolver.clearNeteaseResolvedAudioCache(); await f.match(manual);
    assert.equal(f.matchCalls.length, 1);
    assert.ok([...f.indexedDB.stores.get('metadata').keys()].some(key => key.includes('/song/url/match')));
});

test('cached successful resolutions avoid both official and matching requests', async t => {
    const f = fixture(t); const a = await f.resolve();
    a.candidates.length = 0; a.audioInfo.type = 'changed';
    const b = await f.resolve();
    assert.equal(f.calls.length, 2); assert.equal(b.candidates.length, 1); assert.equal(b.audioInfo.type, 'flac');
});

test('matching never rewrites the cached official response as a successful official URL', async t => {
    const f = fixture(t); await f.resolve();
    f.resolver.clearNeteaseResolvedAudioCache();
    const result = await f.resolve();
    assert.equal(result.usedMatch, true); assert.equal(result.needsUnblock, true);
    assert.equal(f.calls.length, 2);
});

test('expired URL invalidation targets the new public match key and permits one fresh resolution', async t => {
    const f = fixture(t); await f.resolve();
    await f.resolver.invalidateNeteaseResolvedAudioCache(1);
    const matchKeys = f.invalidations.filter(raw => new URL(raw).pathname === '/song/url/match');
    assert.ok(matchKeys.length > 0); assert.ok(matchKeys.every(raw => !new URL(raw).searchParams.has('cookie')));
    await f.resolve({ cacheScope: 'none' }); assert.equal(f.matchCalls.length, 2);
});

test('background 5xx failures cool for 30 seconds without another matching GET', async t => {
    const f = fixture(t); f.state.handler = () => response({ msg: 'cookie=synthetic-secret' }, 500);
    const first = await f.match(), second = await f.match();
    assert.equal(f.matchCalls.length, 2);
    assert.equal(first.error.failures.length, 2); assert.ok(first.error.failures.every(item => item.status === 500));
    assert.ok(second.error.failures.every(item => item.coolingDown));
    assert.ok(!JSON.stringify(first.error).includes('synthetic-secret'));
    f.state.now += 30_001; await f.match(); assert.equal(f.matchCalls.length, 4);
});

test('manual playback can immediately retry a background 5xx failure and clear it on success', async t => {
    const f = fixture(t); f.state.handler = () => response({}, 503);
    await f.match(idle, ['bikonoo']); f.state.handler = good;
    assert.equal((await f.match(manual, ['bikonoo'])).audioUrl, 'https://cdn.test/full.flac');
    assert.equal(f.matchCalls.length, 2);
    await f.match(idle, ['bikonoo']); assert.equal(f.matchCalls.length, 2);
});

test('a cooling source does not block later sources or change their configured order', async t => {
    const f = fixture(t); f.state.handler = url => url.searchParams.get('source') === 'bikonoo' ? response({}, 500) : good();
    const first = await f.match(); assert.equal(first.source, 'msls');
    await f.match();
    assert.deepEqual(f.matchCalls.map(call => call.url.searchParams.get('source')), ['bikonoo', 'msls']);
});

for (const retryAfter of ['90', new Date(2_000_000 + 90_000).toUTCString()]) {
    test(`429 preserves Retry-After for background and manual attempts (${retryAfter})`, async t => {
        const f = fixture(t); f.state.handler = () => response({}, 429, { 'Retry-After': retryAfter });
        await f.match(idle, ['bikonoo']); f.state.now += 30_001;
        const result = await f.match(manual, ['bikonoo']);
        assert.equal(f.matchCalls.length, 1); assert.equal(result.error.failures[0].status, 429);
        assert.match(result.error.message, /60秒/);
        f.state.now += 60_000; f.state.handler = good; await f.match(manual, ['bikonoo']);
        assert.equal(f.matchCalls.length, 2);
    });
}

test('429 without a valid Retry-After falls back to a short nonpersistent cooldown', async t => {
    const f = fixture(t); f.state.handler = () => response({}, 429, { 'Retry-After': 'invalid' });
    await f.match(idle, ['bikonoo']); await f.match(manual, ['bikonoo']); assert.equal(f.matchCalls.length, 1);
    f.state.now += 30_001; await f.match(manual, ['bikonoo']); assert.equal(f.matchCalls.length, 2);
});

test('cooldowns are scoped by song, source, quality and account session', async t => {
    const f = fixture(t); f.state.handler = () => response({}, 500);
    await f.match(idle, ['bikonoo'], 1); await f.match(idle, ['bikonoo'], 2);
    await f.match(idle, ['msls'], 1); await f.match(idle, ['bikonoo'], 1, 'exhigh');
    f.auth.authGeneration++; await f.match(idle, ['bikonoo'], 1);
    f.auth.neteaseCookie = 'MUSIC_U=other'; await f.match(idle, ['bikonoo'], 1);
    assert.equal(f.matchCalls.length, 6);
});

test('aborting an in-flight request records no failure cooldown', async t => {
    const f = fixture(t), controller = new AbortController();
    f.state.handler = () => new Promise(() => {});
    const pending = f.match({ ...idle, signal: controller.signal }, ['bikonoo']); await settle();
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    f.state.handler = good; await f.match(idle, ['bikonoo']); assert.equal(f.matchCalls.length, 2);
});

test('clear/logout prevents a late failure from repopulating a new session cooldown', async t => {
    const f = fixture(t); let finish;
    f.state.handler = () => new Promise(resolve => { finish = resolve; });
    const pending = f.match(idle, ['bikonoo']); await settle();
    f.resolver.clearNeteaseResolvedAudioCache(); finish(response({}, 500)); await pending;
    f.state.handler = good; await f.match(idle, ['bikonoo']); assert.equal(f.matchCalls.length, 2);
});

test('parallel matching requests share the same network request and preserve cancellation leases', async t => {
    const f = fixture(t), controller = new AbortController(); let finish;
    f.state.handler = () => new Promise(resolve => { finish = resolve; });
    const background = f.match({ ...idle, signal: controller.signal }, ['bikonoo']); await settle();
    const playback = f.match(manual, ['bikonoo']); await settle();
    controller.abort(); await assert.rejects(background, { name: 'AbortError' });
    finish(good()); assert.equal((await playback).source, 'bikonoo'); assert.equal(f.matchCalls.length, 1);
});

test('failure bookkeeping is bounded rather than accumulating every failed song', async t => {
    const f = fixture(t); f.state.handler = () => response({}, 500);
    for (let id = 0; id < 205; id++) await f.match(idle, ['bikonoo'], id);
    await f.match(idle, ['bikonoo'], 0); await f.match(idle, ['bikonoo'], 204);
    assert.equal(f.matchCalls.length, 206);
    assert.equal(f.indexedDB.stores.get('metadata').size, 0);
});

test('API errors and trial-only results stay distinguishable without retaining response text', async t => {
    const f = fixture(t); f.state.handler = () => response({ code: 500, msg: 'MUSIC_U=synthetic-secret' });
    const api = await f.match(idle, ['bikonoo']);
    assert.equal(api.error.failures[0].apiCode, 500); assert.ok(!api.error.message.includes('synthetic-secret'));
    f.resolver.clearNeteaseResolvedAudioCache(); f.state.handler = () => response({ code: 200, data: 'https://cdn.test/jd-musicrep-ts/trial.mp3' });
    const trial = await f.match(idle, ['bikonoo']); assert.equal(trial.skippedTrial, true); assert.match(trial.error.message, /试听/);
});

test('full resolution retains matching failure details instead of silently returning no URL', async t => {
    const f = fixture(t); f.state.handler = url => url.pathname === '/song/url/v1'
        ? response({ code: 200, data: [{ url: null }] }) : response({}, 500);
    const result = await f.resolve();
    assert.equal(result.candidates.length, 0); assert.equal(result.error.code, 'AUDIO_URL_UNAVAILABLE');
    assert.deepEqual(result.error.failures.map(item => item.status), [500, 500]);
    assert.match(result.error.message, /bikonoo: HTTP 500/);
});
