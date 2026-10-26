import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyricRequests, isLyricResponse, lyricCacheTtl } from '../src/lyrics/requests.js';
import { createLyrics } from '../src/lyrics/controller.js';
import { createCache } from '../src/storage/cache.js';
import { createTransfer } from '../src/audio/transfer.js';
import { createHost, FakeElement } from './helpers/host.mjs';

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const payload = () => ({ code: 200, lrc: { lyric: '[00:00.000]windsound\n[00:02.000]second' },
    tlyric: { lyric: '[00:00.000]translation' }, romalrc: { lyric: '[00:00.000]romanization' },
    yrc: { lyric: '[0,2000,0](0,900,0)wind(900,1100,0)sound' } });
const transfer = createTransfer();

function globals(t, values) {
    const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => { for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
    } });
}

function fixture(t) {
    const calls = [], state = { handler: () => payload() };
    const api = { buildApiUrl: value => 'https://fixture.invalid' + value };
    const cache = { async cachedFetchJson(url, options, ttl) {
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        calls.push({ url, options, ttl });
        return transfer.awaitWithSignal(Promise.resolve(state.handler(url)), options.signal);
    } };
    const requests = createLyricRequests({ api, cache });
    t.after(() => { requests.cancelPrefetch(); requests.cancelTaken(); });
    return { requests, api, cache, calls, state };
}

function controllerFixture(t) {
    const f = fixture(t), { host } = createHost();
    host.document.createTextNode = text => Object.assign(new FakeElement(), { textContent: text });
    globals(t, { window: host, document: host.document, localStorage: host.localStorage,
        requestAnimationFrame: host.requestAnimationFrame });
    const box = new FakeElement(); box.innerHTML = 'current lyrics';
    const lyrics = createLyrics({ api: f.api, cache: f.cache, playback: { getCurrentTime: () => 0, playbackState: { isPlaying: false } },
        dom: { el: { lyricBox: box, artist: new FakeElement() } }, metadata: {}, debug: { log() {} } });
    t.after(() => { lyrics.cancelLyricPrefetch(); lyrics.resetTrackLyrics(); });
    return { ...f, lyrics, box };
}

test('lyric payload validation accepts text and no-lyrics flags, never API failures', () => {
    for (const value of [payload(), { code: 200, nolyric: true }, { uncollected: true }, { lrc: { lyric: '' } }]) assert.equal(isLyricResponse(value), true);
    for (const value of [null, {}, { code: 500, lrc: { lyric: 'error' } }, { code: 200, data: 'error' }]) assert.equal(isLyricResponse(value), false);
});

test('one raw lyric request covers all languages/YRC and deduplicates the same background target', async t => {
    const { requests, calls } = fixture(t);
    assert.equal(requests.prefetch(0), false); assert.equal(requests.prefetch('2'), false);
    requests.prefetch(2); requests.prefetch(2); await settle();
    assert.equal(calls.length, 1); assert.match(calls[0].url, /\/lyric\/new\?id=2$/);
    assert.equal(calls[0].ttl, lyricCacheTtl);
    assert.equal(calls[0].ttl(payload()), 24 * 3600_000);
    assert.equal(calls[0].ttl({ nolyric: true }), 3600_000);
    assert.equal(calls[0].options.staleWhileRevalidate, true);
    assert.equal(calls[0].options.priority, 'idle');
    assert.equal(calls[0].options.requestPriority.value, 'idle');
    assert.deepEqual(await requests.take(2), payload());
});

test('background prefetch never parses lyrics, changes tags or replaces the current lyric view', async t => {
    const { lyrics, calls, box } = controllerFixture(t);
    lyrics.prefetchLyricById(2); await settle();
    assert.equal(calls.length, 1); assert.equal(box.innerHTML, 'current lyrics');
    assert.equal(box.children.length, 0); assert.equal(lyrics.originalLyricsArr.length, 0);
});

test('foreground takes the pending subscription before background cancellation, without a second request', async t => {
    const { requests, calls, state } = fixture(t), response = deferred();
    state.handler = () => response.promise;
    requests.prefetch(2); await settle();
    assert.equal(requests.take(3), null);
    const foreground = requests.take(2);
    assert.equal(calls[0].options.requestPriority.value, 'interactive');
    requests.cancelPrefetch();
    assert.equal(calls[0].options.signal.aborted, false);
    response.resolve(payload()); assert.deepEqual(await foreground, payload()); assert.equal(calls.length, 1);
});

test('handoff is safe even before the asynchronous cache lookup has started', async t => {
    const { requests, calls } = fixture(t);
    requests.prefetch(2); const foreground = requests.take(2); requests.cancelPrefetch();
    assert.deepEqual(await foreground, payload());
    assert.equal(calls.length, 1); assert.equal(calls[0].options.signal.aborted, false);
    assert.equal(calls[0].options.requestPriority.value, 'interactive');
});

test('new background targets cancel old background requests, not the adopted foreground', async t => {
    const { requests, calls, state } = fixture(t), response = deferred(); state.handler = () => response.promise;
    requests.prefetch(2); await settle(); requests.prefetch(3); await settle();
    assert.equal(calls[0].options.signal.aborted, true);
    const foreground = requests.take(3);
    requests.prefetch(4); await settle(); requests.cancelPrefetch();
    assert.equal(calls[1].options.signal.aborted, false); assert.equal(calls[2].options.signal.aborted, true);
    response.resolve(payload()); await foreground;
});

test('foreground cancellation and a track reset release an adopted request', async t => {
    const { lyrics, calls, state } = controllerFixture(t), response = deferred(); state.handler = () => response.promise;
    lyrics.prefetchLyricById(2); await settle();
    const parent = new AbortController(), foreground = lyrics.takePrefetchedLyric(2, { signal: parent.signal });
    parent.abort(); await assert.rejects(foreground, { name: 'AbortError' });
    assert.equal(calls[0].options.signal.aborted, true);
    lyrics.prefetchLyricById(3); await settle();
    const next = lyrics.takePrefetchedLyric(3); lyrics.resetTrackLyrics();
    await assert.rejects(next, { name: 'AbortError' }); assert.equal(calls[1].options.signal.aborted, true);
});

test('background timeout releases the request and permits a foreground retry', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { requests, calls, state } = fixture(t); state.handler = () => new Promise(() => {});
    requests.prefetch(2); await settle(); t.mock.timers.tick(12_001); await settle();
    assert.equal(calls[0].options.signal.aborted, true); assert.equal(requests.take(2), null);
    state.handler = () => payload(); assert.deepEqual(await requests.load(2), payload()); assert.equal(calls.length, 2);
});

test('cached success is reused; malformed success responses are not cached', async t => {
    const urls = []; let data = payload();
    globals(t, { window: { location: { href: 'https://fixture.invalid/' } }, fetch: async url => {
        urls.push(url); return Response.json(data);
    } });
    const cache = createCache({ transfer }), requests = createLyricRequests({ cache, api: { buildApiUrl: value => 'https://fixture.invalid' + value } });
    t.after(() => { requests.cancelPrefetch(); requests.cancelTaken(); });
    requests.prefetch(2); await settle(); await requests.take(2);
    await requests.load(2); assert.equal(urls.length, 1);
    data = { code: 200, data: 'not a lyric response' }; await requests.load(3); await requests.load(3);
    assert.equal(urls.length, 3);
});

test('completed prefetch renders translation, romanization and timed words only on foreground use', async t => {
    const { lyrics, calls, box } = controllerFixture(t);
    lyrics.prefetchLyricById(2); await settle();
    const prefetched = lyrics.takePrefetchedLyric(2); lyrics.cancelLyricPrefetch();
    assert.equal(await lyrics.fetchLyricById(2, { prefetched }), true);
    assert.equal(calls.length, 1); assert.equal(lyrics.originalLyricsArr.length, 2);
    assert.equal(lyrics.translatedLyricsArr[0].txt, 'translation');
    assert.equal(box.querySelectorAll('.yrc-char').length, 2);
    assert.equal(box.querySelectorAll('.yrc-char')[1].dataset.start, 900);
});

test('failed and invalid prefetch results fall back once to the ordinary foreground request', async t => {
    const { lyrics, calls, state } = controllerFixture(t);
    for (const mode of ['reject', 'invalid']) {
        state.handler = () => mode === 'reject' ? Promise.reject(new Error('offline')) : { code: 500 };
        lyrics.prefetchLyricById(2); await settle(); const prefetched = lyrics.takePrefetchedLyric(2);
        const before = calls.length; state.handler = () => payload();
        assert.equal(await lyrics.fetchLyricById(2, { prefetched }), true);
        assert.equal(calls.length, before + 1);
    }
});

test('real-shaped two-field YRC takes timing authority and retains subtitles without duplicate rows', async t => {
    const { lyrics, state, box } = controllerFixture(t);
    state.handler = () => ({ code: 200, lrc: { lyric: '[00:00.000]composer\n[00:01.430]rain fall' },
        tlyric: { lyric: '[00:01.430]translation' }, romalrc: { lyric: '[00:01.430]roman' },
        yrc: { lyric: '[1170,1440](1170,260,0)rain (1430,1180,0)fall' } });
    lyrics.lyricDisplayMode = 'both';
    lyrics.prefetchLyricById(2); await settle();
    assert.equal(await lyrics.fetchLyricById(2, { prefetched: lyrics.takePrefetchedLyric(2) }), true);
    assert.deepEqual(lyrics.originalLyricsArr.map(line => line.t), [0, 1.17]);
    assert.equal(lyrics.translatedLyricsArr[0].t, 1.17);
    const row = box.children[1];
    assert.equal(row.querySelector('.lyric-translation').textContent, 'translation');
    assert.deepEqual(row.querySelectorAll('.yrc-char').map(word => [word.dataset.start, word.dataset.dur]), [[0, 260], [260, 1180]]);
});

test('valid word-only responses render even when ordinary LRC is absent', async t => {
    const { lyrics, state, box } = controllerFixture(t);
    state.handler = () => ({ code: 200, yrc: { lyric: '[1170,1000](1170,1000,0)word' } });
    assert.equal(await lyrics.fetchLyricById(2), true);
    assert.equal(lyrics.originalLyricsArr[0].t, 1.17);
    assert.equal(box.querySelectorAll('.yrc-char').length, 1);
});

test('paired subtitles render on YRC rows without original-timeline duplicates', async t => {
    const { lyrics, state, box } = controllerFixture(t);
    state.handler = () => ({ code: 200, lrc: { lyric: '[00:00.780]one\n[00:07.298]two' },
        tlyric: { lyric: '[00:00.780]old one\n[00:07.298]old two' },
        yrc: { lyric: '[930,6000](930,6000,0)one\n[7400,7000](7400,7000,0)two' },
        ytlrc: { lyric: '[00:00.930]paired one\n[00:07.400]paired two' } });
    lyrics.lyricDisplayMode = 'both';
    lyrics.prefetchLyricById(2); await settle();
    assert.equal(await lyrics.fetchLyricById(2, { prefetched: lyrics.takePrefetchedLyric(2) }), true);
    assert.equal(box.children.length, 2);
    assert.deepEqual(box.querySelectorAll('.lyric-translation').map(line => line.textContent), ['paired one', 'paired two']);
});

test('credits and very short cues do not acquire a neighboring row of timed words', async t => {
    const { lyrics, state, box } = controllerFixture(t);
    state.handler = () => ({ code: 200, lrc: { lyric: '[00:00.990]Composer: Example\n[00:01.000]one\n[00:01.030]two' },
        yrc: { lyric: '[1000,30](1000,30,0)one\n[1030,30](1030,30,0)two' },
        ytlrc: { lyric: '[00:01.000]first\n[00:01.030]second' } });
    lyrics.lyricDisplayMode = 'both';
    await lyrics.fetchLyricById(2);
    assert.equal(box.querySelectorAll('.yrc-char').length, 2);
    assert.equal(box.children[0].querySelector('.yrc-line'), null);
    assert.equal(box.children[1].querySelector('.yrc-char').textContent, 'one');
    assert.equal(box.children[2].querySelector('.yrc-char').textContent, 'two');
    assert.deepEqual(box.querySelectorAll('.lyric-translation').map(line => line.textContent), ['first', 'second']);
});

test('local-file cloud matching uses the same paired YRC tracks as direct online playback', async t => {
    const { lyrics, state, box } = controllerFixture(t);
    state.handler = url => url.includes('/lyric/new') ? { code: 200,
        lrc: { lyric: '[00:00.780]one\n[00:07.298]two' },
        yrc: { lyric: '[930,6000](930,6000,0)one\n[7400,7000](7400,7000,0)two' },
        ytlrc: { lyric: '[00:00.930]paired one\n[00:07.400]paired two' }
    } : { code: 200, result: { songs: [{ id: 2, name: 'fixture', ar: [{ name: 'Example' }] }] } };
    lyrics.neteaseSearchEnabled = true; lyrics.lyricDisplayMode = 'both';
    const session = lyrics.createLocalLyricSession({}, () => true);
    lyrics.applyLocalLyricMetadata(session, { title: 'fixture', artist: 'Example' }, 'local');
    await settle();
    assert.equal(session.source, 'cloud');
    assert.equal(box.children.length, 2);
    assert.deepEqual(box.querySelectorAll('.lyric-translation').map(line => line.textContent), ['paired one', 'paired two']);
});

test('no-lyrics responses are reused without retry or stale text', async t => {
    const { lyrics, state, calls, box } = controllerFixture(t); state.handler = () => ({ code: 200, nolyric: true });
    lyrics.prefetchLyricById(2); await settle(); const prefetched = lyrics.takePrefetchedLyric(2);
    assert.equal(await lyrics.fetchLyricById(2, { prefetched }), false);
    assert.equal(calls.length, 1); assert.match(box.innerHTML, /纯音乐/);
});

test('late or cancelled foreground results cannot overwrite new lyrics or start fallback requests', async t => {
    const { lyrics, state, calls, box } = controllerFixture(t), response = deferred(); state.handler = () => response.promise;
    lyrics.prefetchLyricById(2); await settle();
    const parent = new AbortController(), prefetched = lyrics.takePrefetchedLyric(2, { signal: parent.signal });
    let current = true;
    const foreground = lyrics.fetchLyricById(2, { prefetched, signal: parent.signal, isCurrent: () => current });
    current = false; box.innerHTML = 'new song lyrics'; parent.abort(); response.resolve(payload());
    assert.equal(await foreground, false); assert.equal(calls.length, 1); assert.equal(box.innerHTML, 'new song lyrics');
});
