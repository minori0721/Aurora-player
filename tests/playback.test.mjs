import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayback } from '../src/audio/playback.js';
import { FakeAudioContext, FakeElement } from './helpers/host.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
beforeEach(() => {
    globalThis.window = { AudioContext: FakeAudioContext };
    globalThis.document = { getElementById: () => new FakeElement(), querySelector: () => null };
    Object.defineProperty(globalThis, 'navigator', { value: { mediaSession: {} }, configurable: true });
});

function fixture() {
    const el = Object.fromEntries(['coverWrap', 'loadTip', 'playBtn', 'currTime', 'totalTime', 'bufferLine'].map(name => [name, new FakeElement()]));
    const queue = { playlist: [{ name: 'first' }, { name: 'second' }], curIdx: 0, playMode: 0, playlistPendingAdvance: false, handleNext() {} };
    const loop = { loopState: { active: false } };
    const player = createPlayback({
        dom: { el }, queue, loop, download: {},
        analysis: { cancelPreviewTimer() {}, cancelLoopAnalysisRun() {} },
        controls: { cancelProgressDrag() {} }, lyrics: { cancelLocalLyricSession() {} },
        content: { updateMusicMiniPlayer() {} }, onlinePlaylist: { currentPlaylistData: null },
        debug: { log() {} }, render: { scheduleRender() {}, setPlaybackProgress() {} }
    });
    player.initialize();
    return { player, queue, loop, audio: FakeAudioContext.instances.at(-1) };
}

test('pause during loading retains download and compressed data until resume', async () => {
    const { player, audio } = fixture();
    const token = player.beginPlaybackAction(), load = player.getPlaybackLoad(token);
    const controller = new AbortController();
    player.currentAbortController = controller;
    player.requestPlaybackPause();
    const compressed = new ArrayBuffer(16);
    const decode = player.decodePlaybackLoad(load, compressed);
    await tick();
    assert.equal(controller.signal.aborted, false);
    assert.equal(audio.decodeCalls.length, 0);
    await player.requestPlaybackPlay();
    const decoded = await decode;
    assert.equal(audio.decodeCalls.length, 1);
    assert.equal(audio.decodeCalls[0], compressed);
    player.audioBuffer = decoded;
    player.finishPlaybackLoad(load);
    assert.equal(player.playbackState.status, 'playing');
});

test('paused stale load wakes and cannot decode or overwrite the next song', async () => {
    const { player, audio, queue } = fixture();
    const token = player.beginPlaybackAction(), load = player.getPlaybackLoad(token);
    player.requestPlaybackPause();
    const result = player.decodePlaybackLoad(load, new ArrayBuffer(8)).catch(error => error);
    await tick();
    queue.curIdx = 1;
    player.beginPlaybackAction();
    assert.equal((await result).stale, true);
    assert.equal(audio.decodeCalls.length, 0);
});

test('pause during decode stays paused after decode and resume reuses AudioBuffer', async () => {
    const { player, audio } = fixture();
    const token = player.beginPlaybackAction(), load = player.getPlaybackLoad(token);
    let finish;
    audio.decodeHook = () => new Promise(resolve => { finish = resolve; });
    const decode = player.decodePlaybackLoad(load, new ArrayBuffer(16));
    player.requestPlaybackPause();
    finish(audio.decoded);
    player.audioBuffer = await decode;
    player.finishPlaybackLoad(load);
    assert.equal(player.playbackState.status, 'paused');
    await player.requestPlaybackPlay();
    assert.equal(audio.decodeCalls.length, 1);
    assert.equal(player.playbackState.status, 'playing');
});

test('single-track and custom loop keep sample-level Web Audio loop configuration', () => {
    const { player, queue, loop, audio } = fixture();
    player.audioBuffer = audio.decoded;
    player.playbackState.duration = 120;
    queue.playMode = 2;
    player.startAudio(125);
    assert.equal(player.sourceNode.loop, true);
    assert.equal(player.sourceNode.loopStart, 0);
    assert.equal(player.sourceNode.loopEnd, 120);
    assert.deepEqual(player.sourceNode.started, [0, 5]);
    loop.loopState = { active: true, start: 10, end: 100 };
    player.startAudio(105);
    assert.equal(player.sourceNode.loopStart, 10);
    assert.equal(player.sourceNode.loopEnd, 100);
    assert.deepEqual(player.sourceNode.started, [0, 15]);
    loop.loopState.active = false;
    queue.playMode = 0;
    player.startAudio(0);
    assert.equal(player.sourceNode.loop, false);
});

test('repeated play requests share the pending unlock and stale unlock cannot restart audio', async () => {
    const { player, audio, queue } = fixture();
    player.beginPlaybackAction();
    player.audioBuffer = audio.decoded;
    audio.state = 'suspended';
    let unlock;
    audio.resumeHook = () => new Promise(resolve => { unlock = () => { audio.state = 'running'; resolve(); }; });
    const first = player.requestPlaybackPlay(), second = player.requestPlaybackPlay();
    assert.equal(first, second);
    queue.curIdx = 1;
    player.beginPlaybackAction();
    unlock();
    await first;
    assert.notEqual(player.playbackState.status, 'playing');
});

test('system media controls follow PCM single-loop wrap, pause, seek zero and resume without another decode', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const handlers = new Map(), positions = [];
    navigator.mediaSession = { setActionHandler: (name, callback) => handlers.set(name, callback),
        setPositionState: state => positions.push(state) };
    const { player, queue, audio } = fixture();
    t.after(() => player.stopAudio('idle'));
    player.audioBuffer = audio.decoded;
    player.playbackState.duration = 120;
    queue.playMode = 2;
    player.startAudio(119.5);
    const loopingSource = player.sourceNode;
    assert.equal(positions.at(-1).position, 119.5);
    audio.currentTime += 1;
    t.mock.timers.tick(1000);
    assert.equal(positions.at(-1).position, 0.5);
    assert.equal(player.sourceNode, loopingSource);
    handlers.get('pause')(); handlers.get('pause')();
    const sourcesBeforeSeek = audio.sources.length;
    handlers.get('seekto')({ seekTime: 0 });
    assert.equal(player.getCurrentTime(), 0);
    assert.equal(positions.at(-1).position, 0);
    assert.equal(audio.sources.length, sourcesBeforeSeek);
    assert.equal(player.playbackState.status, 'paused');
    await handlers.get('play')();
    assert.equal(player.playbackState.status, 'playing');
    assert.equal(player.sourceNode.loop, true);
    assert.equal(player.sourceNode.loopEnd, 120);
    assert.equal(audio.decodeCalls.length, 0);
});

test('system seeks retain custom A/B loop normalization and report its actual resumed position', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const handlers = new Map(), positions = [];
    navigator.mediaSession = { setActionHandler: (name, callback) => handlers.set(name, callback),
        setPositionState: state => positions.push(state) };
    const { player, loop, audio } = fixture();
    t.after(() => player.stopAudio('idle'));
    player.audioBuffer = audio.decoded;
    player.playbackState.duration = 120;
    loop.loopState = { active: true, start: 10, end: 100 };
    player.startAudio(20);
    handlers.get('seekto')({ seekTime: 110 });
    assert.equal(player.getCurrentTime(), 20);
    assert.equal(positions.at(-1).position, 20);
    assert.equal(player.sourceNode.loopStart, 10);
    assert.equal(player.sourceNode.loopEnd, 100);
    assert.equal(player.playbackState.status, 'playing');
});
