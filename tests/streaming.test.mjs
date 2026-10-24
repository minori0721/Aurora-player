import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaTransport, pcmSizeEstimate, readPlaybackPreference } from '../src/audio/media.js';
import { createPlayback } from '../src/audio/playback.js';
import { FakeAudioContext, FakeElement, storage } from './helpers/host.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
class Media extends FakeElement {
    constructor() {
        super(); this.duration = 120; this.currentTime = 0; this.paused = true; this.ended = false; this.plays = 0;
        this.readyState = 4; this.buffered = { length: 1, start: () => 0, end: () => 120 };
    }
    load() { if (this.src && !this.manual) queueMicrotask(() => this.dispatchEvent({ type: 'loadedmetadata' })); }
    async play() {
        if (this.failure) throw this.failure;
        this.plays++; this.paused = false; this.dispatchEvent({ type: 'playing' });
    }
    pause() { this.paused = true; }
}
class Audio extends FakeAudioContext {
    createMediaElementSource() { return { connect() {}, disconnect() {} }; }
}
beforeEach(() => {
    globalThis.window = { AudioContext: Audio };
    const events = new FakeElement();
    window.addEventListener = (...args) => events.addEventListener(...args);
    window.removeEventListener = (...args) => events.removeEventListener(...args);
    window.dispatchEvent = event => events.dispatchEvent(event);
    globalThis.document = { hidden: false, getElementById: () => new FakeElement(), querySelector: () => null };
    globalThis.localStorage = storage();
    Object.defineProperty(globalThis, 'navigator', { value: { mediaSession: {}, onLine: true }, configurable: true });
});
function fixture(t, mediaElement = new Media(), loadComplete) {
    const el = Object.fromEntries(['coverWrap', 'loadTip', 'playBtn', 'currTime', 'totalTime', 'bufferLine'].map(name => [name, new FakeElement()]));
    let nextCalls = 0, fullCalls = 0;
    const queue = { playlist: [{ name: 'one' }, { name: 'two' }], curIdx: 0, playMode: 0, handleNext() { nextCalls++; } };
    const player = createPlayback({
        dom: { el }, queue, loop: { loopState: { active: false } }, download: {},
        analysis: { cancelPreviewTimer() {}, cancelLoopAnalysisRun() {} }, controls: { cancelProgressDrag() {} },
        lyrics: { cancelLocalLyricSession() {}, syncWordLyricPlayback() {} }, content: { updateMusicMiniPlayer() {} },
        onlinePlaylist: {}, debug: { log() {} }, render: { scheduleRender() {}, setPlaybackProgress() {} }
    });
    player.initialize();
    const token = player.beginPlaybackAction(), load = player.getPlaybackLoad(token);
    const media = createMediaTransport('https://audio.invalid/file.mp3', { element: mediaElement });
    t.after(() => player.beginPlaybackAction());
    const ready = player.prepareStream(load, { media, loadComplete: () => {
        fullCalls++;
        return loadComplete ? loadComplete() : Promise.resolve({ buffer: { duration: 120 } });
    } });
    return { player, queue, media, element: mediaElement, load, ready, get nextCalls() { return nextCalls; }, get fullCalls() { return fullCalls; } };
}

function clockFixture(t, started = false) {
    let now = 0, suspended = false;
    t.mock.method(performance, 'now', () => now);
    t.mock.timers.enable({ apis: ['setInterval'] });
    const element = new Media(); element.manual = true;
    element.buffered = { length: started ? 1 : 0, start: () => 0, end: () => 60 };
    const media = createMediaTransport('https://audio.invalid/file.mp3', { element });
    const errors = [];
    media.ready.catch(error => errors.push(error));
    media.observe({ error: error => errors.push(error), suspended: () => suspended });
    if (started) { element.paused = false; element.dispatchEvent({ type: 'loadedmetadata' }); }
    t.after(() => media.dispose());
    return { element, errors, set suspended(value) { suspended = value; }, advance(milliseconds) {
        while (milliseconds > 0) {
            const step = Math.min(1000, milliseconds);
            now += step; t.mock.timers.tick(step); milliseconds -= step;
        }
    } };
}

test('native startup watchdog uses 10 seconds without progress after its first baseline poll', async t => {
    const f = clockFixture(t);
    f.advance(1000); f.advance(9000); await tick();
    assert.equal(f.errors.length, 0);
    f.advance(1000); await tick();
    assert.equal(f.errors.length, 1); assert.equal(f.errors[0].timeout, true);
});

test('native playback watchdog uses 15 seconds without progress after its first baseline poll', t => {
    const f = clockFixture(t, true);
    f.advance(1000); f.advance(14000); assert.equal(f.errors.length, 0);
    f.advance(1000); assert.equal(f.errors.length, 1); assert.equal(f.errors[0].timeout, true);
});

test('advancing playback or growing buffered data resets the shorter stall timeout', t => {
    const f = clockFixture(t, true);
    f.advance(1000); f.advance(14000);
    f.element.currentTime = 1; f.advance(1000);
    f.advance(14000); assert.equal(f.errors.length, 0);
    f.element.buffered.end = () => 61; f.advance(1000);
    f.advance(14000); assert.equal(f.errors.length, 0);
    f.advance(1000); assert.equal(f.errors.length, 1);
});

for (const state of ['paused', 'offline', 'hidden', 'context-suspended']) {
    test(`the shorter native watchdog excludes ${state} time`, t => {
        const f = clockFixture(t, true); f.advance(1000);
        if (state === 'offline') navigator.onLine = false;
        else if (state === 'hidden') document.hidden = true;
        else { f.suspended = true; if (state === 'paused') f.element.paused = true; }
        f.advance(40000); assert.equal(f.errors.length, 0);
        navigator.onLine = true; document.hidden = false; f.suspended = false; f.element.paused = false;
        f.advance(14000); assert.equal(f.errors.length, 0);
        f.advance(1000); assert.equal(f.errors.length, 1);
    });
}

test('streaming is the default while explicit complete preference survives reloads', () => {
    assert.equal(readPlaybackPreference(), 'stream');
    localStorage.setItem('aurora_playback_mode', 'complete');
    assert.equal(readPlaybackPreference(), 'complete');
    localStorage.setItem('aurora_playback_mode', 'stream');
    assert.equal(readPlaybackPreference(), 'stream');
    localStorage.setItem('aurora_playback_mode', 'invalid');
    assert.equal(readPlaybackPreference(), 'stream');
    assert.equal(readPlaybackPreference({ getItem() { throw new Error(); } }), 'stream');
    assert.equal(pcmSizeEstimate(240), 92160000);
});

test('stream playback begins without a full fetch or PCM decode; pause/resume keeps the same element', async t => {
    const f = fixture(t); await f.ready; f.player.finishPlaybackLoad(f.load); await tick();
    assert.equal(f.player.isStreaming, true); assert.equal(f.player.playbackState.status, 'playing');
    assert.equal(f.fullCalls, 0); assert.equal(Audio.instances.at(-1).decodeCalls.length, 0);
    f.element.currentTime = 27;
    f.player.requestPlaybackPause();
    assert.equal(f.player.getCurrentTime(), 27);
    await f.player.requestPlaybackPlay(); await tick();
    assert.equal(f.element.plays, 2); assert.equal(f.player.getCurrentTime(), 27);
});

test('standard media controls keep the real timeline across stream-to-PCM promotion without a silent element', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const handlers = new Map(), positions = [];
    navigator.mediaSession = { setActionHandler: (name, callback) => handlers.set(name, callback),
        setPositionState: state => positions.push(state) };
    const f = fixture(t); await f.ready; f.player.finishPlaybackLoad(f.load); await tick();
    assert.equal(navigator.mediaSession.playbackState, 'playing');
    handlers.get('seekto')({ seekTime: 23 });
    assert.equal(f.element.currentTime, 23);
    assert.equal(positions.at(-1).position, 23);
    assert.equal(f.fullCalls, 0);
    f.queue.playMode = 2;
    await f.player.activateCompleteAudio('test');
    assert.equal(f.fullCalls, 1);
    assert.equal(f.player.isStreaming, false);
    assert.equal(f.media.disposed, true);
    assert.equal(f.player.sourceNode.loop, true);
    assert.equal(positions.at(-1).position, 23);
    handlers.get('pause')();
    handlers.get('seekto')({ seekTime: 0 });
    assert.equal(f.player.playbackState.status, 'paused');
    assert.equal(f.player.getCurrentTime(), 0);
    await handlers.get('play')();
    assert.equal(f.player.playbackState.status, 'playing');
    assert.equal(f.fullCalls, 1);
    assert.equal(f.player.sourceNode.loopEnd, 120);
    assert.equal(handlers.size, 7);
});

test('pause before metadata does not let the old pending play restart audio', async t => {
    const element = new Media(); element.manual = true;
    const f = fixture(t, element);
    f.player.requestPlaybackPause();
    element.dispatchEvent({ type: 'loadedmetadata' });
    await f.ready; f.player.finishPlaybackLoad(f.load); await tick();
    assert.equal(element.plays, 0); assert.equal(f.player.playbackState.status, 'paused');
    await f.player.requestPlaybackPlay(); await tick(); assert.equal(element.plays, 1);
});

test('pause immediately after start defeats a pending native play microtask', async t => {
    const f = fixture(t); await f.ready; f.player.finishPlaybackLoad(f.load);
    f.player.requestPlaybackPause(); await tick();
    assert.equal(f.element.plays, 0); assert.equal(f.player.playbackState.status, 'paused');
});

test('seeking a paused stream changes its real position without starting it', async t => {
    const f = fixture(t); await f.ready; f.player.finishPlaybackLoad(f.load); await tick();
    f.player.requestPlaybackPause(); f.player.seekAudio(63); await tick();
    assert.equal(f.player.getCurrentTime(), 63); assert.equal(f.element.paused, true);
});

test('complete preparation is shared and activation preserves a later pause and seek', async t => {
    let finish;
    const f = fixture(t, new Media(), () => new Promise(resolve => { finish = resolve; }));
    await f.ready; f.player.finishPlaybackLoad(f.load); await tick();
    const first = f.player.activateCompleteAudio('loop');
    const second = f.player.activateCompleteAudio('loop');
    assert.equal(first, second); await tick();
    f.player.requestPlaybackPause(); f.player.seekAudio(61);
    finish({ buffer: { duration: 120 } }); await first;
    assert.equal(f.fullCalls, 1); assert.equal(f.player.isStreaming, false);
    assert.equal(f.player.playbackState.status, 'paused'); assert.equal(f.player.getCurrentTime(), 61);
});

test('late complete preparation cannot replace the newly selected track', async t => {
    let finish;
    const f = fixture(t, new Media(), () => new Promise(resolve => { finish = resolve; }));
    await f.ready;
    const pending = f.player.ensureCompleteAudio(); await tick();
    f.queue.curIdx = 1; f.player.beginPlaybackAction();
    finish({ buffer: { duration: 120 } });
    await assert.rejects(pending, error => error.stale === true);
    assert.equal(f.player.audioBuffer, null); assert.equal(f.media.disposed, true);
});

test('autoplay rejection does not trigger a full download', async t => {
    const element = new Media(); element.failure = new DOMException('user gesture required', 'NotAllowedError');
    const f = fixture(t, element); await f.ready; f.player.finishPlaybackLoad(f.load); await tick();
    assert.equal(f.fullCalls, 0); assert.equal(f.player.playbackState.status, 'error');
    assert.equal(f.player.playbackWantsPlay, false);
});

test('a stream error falls back once to the complete engine at the current position', async t => {
    const f = fixture(t); await f.ready; f.player.finishPlaybackLoad(f.load); await tick();
    f.element.currentTime = 39; f.element.error = { code: 3 };
    f.element.dispatchEvent({ type: 'error' }); await tick(); await tick();
    assert.equal(f.fullCalls, 1); assert.equal(f.player.isStreaming, false);
    assert.equal(f.player.sourceNode.started[1], 39);
    f.element.dispatchEvent({ type: 'error' }); await tick(); assert.equal(f.fullCalls, 1);
});

test('native end advances once and events from a disposed media cannot advance the new song', async t => {
    const f = fixture(t); await f.ready; f.player.finishPlaybackLoad(f.load); await tick();
    f.element.ended = true; f.element.dispatchEvent({ type: 'ended' });
    assert.equal(f.nextCalls, 1); f.player.beginPlaybackAction();
    f.element.dispatchEvent({ type: 'ended' }); assert.equal(f.nextCalls, 1);
});

test('PCM budget refuses unsafe promotion before decode', async t => {
    const f = fixture(t); await f.ready;
    await assert.rejects(f.player.decodeCompleteData(new ArrayBuffer(4), 36000), /占用过高/);
    assert.equal(Audio.instances.at(-1).decodeCalls.length, 0);
});

test('a buffered seek returns to playing even without a fresh playing event', async t => {
    const f = fixture(t); await f.ready; f.player.finishPlaybackLoad(f.load); await tick();
    f.element.dispatchEvent({ type: 'seeking' }); assert.equal(f.player.playbackState.status, 'loading');
    f.element.dispatchEvent({ type: 'seeked' }); assert.equal(f.player.playbackState.status, 'playing');
});

test('a paused media error waits for user resume before full fallback', async t => {
    const f = fixture(t); await f.ready; f.player.finishPlaybackLoad(f.load); await tick();
    f.player.requestPlaybackPause(); f.element.dispatchEvent({ type: 'error' }); await tick();
    assert.equal(f.fullCalls, 0); assert.equal(f.player.playbackState.status, 'paused');
    await f.player.requestPlaybackPlay(); await tick(); await tick();
    assert.equal(f.fullCalls, 1); assert.equal(f.player.isStreaming, false);
});

test('offline media errors defer network recovery until online and preserve pause intent', async t => {
    const f = fixture(t); await f.ready; f.player.finishPlaybackLoad(f.load); await tick();
    navigator.onLine = false; f.element.dispatchEvent({ type: 'error' }); await tick();
    assert.equal(f.fullCalls, 0);
    f.player.requestPlaybackPause(); navigator.onLine = true; window.dispatchEvent({ type: 'online' }); await tick();
    assert.equal(f.fullCalls, 0);
    await f.player.requestPlaybackPlay(); await tick(); await tick(); assert.equal(f.fullCalls, 1);
});
