import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransfer } from '../src/audio/transfer.js';
import { createOnlinePlayback } from '../src/audio/online.js';
import { describeAudioQualityFromInfo, parseFlacStreamInfoFromBuffer } from '../src/audio/quality.js';
import { FakeElement } from './helpers/host.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const transfer = createTransfer();
function flacHeader(sampleRate = 44100, bits = 16, channels = 2) {
    const bytes = new Uint8Array(42);
    bytes.set([102, 76, 97, 67, 128, 0, 0, 34]);
    bytes[18] = sampleRate >> 12;
    bytes[19] = sampleRate >> 4;
    bytes[20] = (sampleRate & 15) << 4 | (channels - 1) << 1 | (bits - 1) >> 4;
    bytes[21] = (bits - 1 & 15) << 4;
    return bytes.buffer;
}
function partialResponse(buffer, headers = {}) {
    return new Response(buffer, { status: 206, headers: { 'content-range': `bytes 0-${buffer.byteLength - 1}/1000000`, ...headers } });
}

test('stream headers describe actual FLAC precision without assuming API or decoded precision', () => {
    for (const [rate, bits] of [[44100, 16], [96000, 24], [192000, 24]]) {
        const info = parseFlacStreamInfoFromBuffer(flacHeader(rate, bits));
        assert.deepEqual(info, { sampleRate: rate, bitsPerSample: bits, channels: 2 });
        const label = describeAudioQualityFromInfo({ type: 'flac', sr: 48000 }, 'https://cdn.test/a', info).label;
        assert.ok(label.endsWith(`/${bits}bit`));
        assert.ok(!label.includes('48kHz'));
    }
    assert.equal(describeAudioQualityFromInfo({ type: 'flac', sr: 44100, bits: 24 }).label, 'FLAC 44.1kHz');
    assert.equal(describeAudioQualityFromInfo({ type: 'mp3', br: 320000 }, '', { bitsPerSample: 24 }).label, 'MP3 320kbps');
});

test('truncated, invalid and corrupt STREAMINFO never yield a guessed bit depth', () => {
    const valid = flacHeader();
    for (let length = 0; length < valid.byteLength; length++) assert.equal(parseFlacStreamInfoFromBuffer(valid.slice(0, length)), null);
    assert.equal(parseFlacStreamInfoFromBuffer(flacHeader(0)), null);
    assert.equal(parseFlacStreamInfoFromBuffer(flacHeader(44100, 1)), null);
    const wrongSize = new Uint8Array(valid.slice(0)); wrongSize[7] = 33;
    assert.equal(parseFlacStreamInfoFromBuffer(wrongSize.buffer), null);
});

test('header probe requests only 4 KiB without credentials or full-file helpers', async t => {
    const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
    let calls = 0;
    globalThis.fetch = async (url, options) => {
        calls++;
        assert.equal(url, 'https://cdn.test/a.flac');
        assert.equal(options.headers.Range, 'bytes=0-4095'); assert.equal(options.credentials, 'omit');
        return partialResponse(flacHeader());
    };
    const header = await transfer.fetchAudioHeader('https://cdn.test/a.flac');
    assert.equal(calls, 1); assert.equal(header.byteLength, 42);
    assert.equal(parseFlacStreamInfoFromBuffer(header).bitsPerSample, 16);
});

test('ignored ranges and HTTP failures cancel before reading the body', async t => {
    const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
    for (const status of [200, 403, 404, 416, 500]) {
        let reads = 0, cancelled = 0;
        globalThis.fetch = async () => ({ status, headers: new Headers(), body: {
            getReader() { reads++; throw new Error('Must not read'); }, cancel: async () => { cancelled++; }
        }, arrayBuffer() { throw new Error('Must not assemble a full file'); } });
        assert.equal(await transfer.fetchAudioHeader('https://cdn.test/a.flac'), null);
        assert.equal(reads, 0); assert.equal(cancelled, 1);
    }
});

test('bad ranges and oversize bodies are refused, while CORS-hidden Content-Range is supported', async t => {
    const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
    for (const headers of [{ 'content-range': 'bytes 42-83/100' }, { 'content-range': 'bytes 0-5000/10000' }, { 'content-length': '1000000' }]) {
        globalThis.fetch = async () => partialResponse(flacHeader(), headers);
        assert.equal(await transfer.fetchAudioHeader('https://cdn.test/a.flac'), null);
    }
    globalThis.fetch = async () => new Response(new Uint8Array(4097), { status: 206 });
    assert.equal(await transfer.fetchAudioHeader('https://cdn.test/a.flac'), null);
    globalThis.fetch = async () => new Response(flacHeader(), { status: 206 });
    assert.equal((await transfer.fetchAudioHeader('https://cdn.test/a.flac')).byteLength, 42);
});

test('header probes stop at their cap and never use an unbounded arrayBuffer fallback', async t => {
    const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(4096)); }, cancel() { cancelled = true; }
    }), { status: 206 });
    assert.equal((await transfer.fetchAudioHeader('https://cdn.test/a.flac')).byteLength, 4096);
    assert.equal(cancelled, true);
    globalThis.fetch = async () => ({ status: 206, headers: new Headers(), arrayBuffer() { throw new Error('Unbounded read'); } });
    assert.equal(await transfer.fetchAudioHeader('https://cdn.test/a.flac'), null);
});

test('header/body stalls and cancellation are bounded and do not retry', async t => {
    const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
    let calls = 0;
    globalThis.fetch = () => { calls++; return new Promise(() => {}); };
    await assert.rejects(transfer.fetchAudioHeader('https://cdn.test/a.flac', { timeoutMs: 10 }), error => error.timeout);
    assert.equal(calls, 1);
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 206 });
    await assert.rejects(transfer.fetchAudioHeader('https://cdn.test/a.flac', { timeoutMs: 10 }), error => error.timeout);
    assert.equal(cancelled, true);
    const controller = new AbortController();
    const pending = transfer.fetchAudioHeader('https://cdn.test/a.flac', { signal: controller.signal });
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
});

function onlineFixture({ type = 'flac', header = async () => flacHeader(), preloaded = null } = {}) {
    let token = 0, options, headerCalls = 0, fullCalls = 0, starts = 0;
    const tags = [], errors = [];
    const resolved = { candidates: [`https://cdn.test/a.${type}`], audioInfo: { type, sr: 44100, br: 320000 } };
    const playback = {
        get _currentPlayActionToken() { return token; }, playbackPreference: 'stream', playbackWantsPlay: true,
        audioBuffer: null, isStreaming: false,
        beginPlaybackAction() { this.currentAbortController?.abort(); return ++token; }, getPlaybackLoad: () => ({}),
        assertPlaybackActionCurrent(value) { if (value !== token) throw Object.assign(new Error('stale'), { stale: true }); },
        isPlaybackActionCurrent: value => value === token, stopAudio() {}, resetPlaybackTimeline() {},
        unlockAudioContext: async () => true, setCurrentDownloadTrack() {},
        async prepareStream(load, config) { options = config; this.isStreaming = true; },
        finishPlaybackLoad() { starts++; }, setPlaybackStatus(status) { if (status === 'error') errors.push(status); }, releasePlaybackLoad() {}
    };
    const prefetch = { nextPreloadKind: preloaded ? 'netease' : 'none', nextPreloadIndex: 0, nextPreloadSongId: 1,
        hasPreloaded: !!preloaded, nextSongRawData: preloaded, nextSongPreloadMeta: { ...resolved, audioUrl: resolved.candidates[0] },
        isNextPreloadCompatible: () => !!preloaded, isNextPreloadSnapshotCurrent: () => true,
        takeNextPreloadedRawData: () => ({ ab: preloaded, ...resolved, audioUrl: resolved.candidates[0] }),
        prewarmNextNeteaseSongUrl() {}, prefetchUpcomingNeteaseDetails() {} };
    const auth = { neteaseCookie: '', authGeneration: 0, neteaseQuality: 'lossless' };
    const metadata = { updateMediaSession() {} };
    const online = createOnlinePlayback({ playback, prefetch, auth, metadata,
        queue: { playlist: [{ songId: 1 }], curIdx: 0, playMode: 0 },
        dom: { el: Object.fromEntries(['title', 'img', 'lyricBox'].map(key => [key, new FakeElement()])) },
        analysis: { resetLoopAnalysisWorkerAudio() {} }, loop: { resetLoopUI() {} }, covers: { setMainCover() {} },
        content: { setMainMusicEntityLinks() {} }, debug: { log() {} },
        lyrics: { resetTrackLyrics() {}, takePrefetchedLyric() {}, fetchLyricById() {}, setArtistTag(source, label) { tags.push(label); } },
        resolver: { getNeteaseMatchStrategy() {}, resolveNeteaseAudioUrlWithTimeout: async () => resolved },
        transfer: { async fetchAudioHeader(url, request) { headerCalls++; return header(url, request); },
            fetchAudioDataWithFallback() { fullCalls++; throw new Error('Unexpected full download'); } }
    });
    const start = () => online.playNeteaseSong({ id: 1, name: 'Test', ar: [], al: { picUrl: 'https://cdn.test/cover.jpg' } });
    return { start, playback, auth, metadata, tags, errors, get options() { return options; },
        get headerCalls() { return headerCalls; }, get fullCalls() { return fullCalls; }, get starts() { return starts; } };
}

test('FLAC labels update asynchronously without delaying playback or decoding a full file', async () => {
    let finish;
    const f = onlineFixture({ header: () => new Promise(resolve => { finish = resolve; }) });
    await f.start();
    assert.equal(f.starts, 1); assert.equal(f.metadata.currentAudioQuality, 'FLAC 44.1kHz');
    finish(flacHeader(96000, 24)); await tick();
    assert.equal(f.metadata.currentAudioQuality, 'FLAC 96kHz/24bit');
    assert.equal(f.playback.audioBuffer, null); assert.equal(f.fullCalls, 0); assert.equal(f.headerCalls, 1);
    assert.deepEqual(f.errors, []);
});

test('existing prefetch memory supplies FLAC precision without any extra network request', async () => {
    const f = onlineFixture({ preloaded: flacHeader(44100, 24) });
    await f.start(); await tick();
    assert.equal(f.metadata.currentAudioQuality, 'FLAC 44.1kHz/24bit');
    assert.equal(f.headerCalls, 0); assert.equal(f.fullCalls, 0); assert.equal(f.playback.audioBuffer, null);
    assert.deepEqual(f.errors, []);
    f.options.dispose();
});

test('lossy streams never probe or fabricate a bit-depth label', async () => {
    const f = onlineFixture({ type: 'mp3' }); await f.start(); await tick();
    assert.equal(f.metadata.currentAudioQuality, 'MP3 320kbps'); assert.equal(f.headerCalls, 0);
});

test('a failed or malformed header leaves the initial label and playback unchanged', async () => {
    for (const header of [async () => null, async () => new ArrayBuffer(3), async () => { throw new Error('CORS'); }]) {
        const f = onlineFixture({ header }); await f.start(); await tick();
        assert.equal(f.metadata.currentAudioQuality, 'FLAC 44.1kHz'); assert.equal(f.starts, 1);
        assert.equal(f.fullCalls, 0); assert.deepEqual(f.errors, []);
    }
});

test('a late probe cannot overwrite a different track, auth generation or complete-quality result', async () => {
    for (const kind of ['track', 'auth', 'complete']) {
        let finish;
        const f = onlineFixture({ header: () => new Promise(resolve => { finish = resolve; }) });
        await f.start();
        if (kind === 'track') f.playback.beginPlaybackAction();
        else if (kind === 'auth') f.auth.authGeneration++;
        else f.playback.audioBuffer = { duration: 120 };
        f.metadata.currentAudioQuality = 'newer quality';
        finish(flacHeader()); await tick();
        assert.equal(f.metadata.currentAudioQuality, 'newer quality'); assert.equal(f.tags.length, 1);
    }
});
