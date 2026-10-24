import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaSession } from '../src/audio/media-session.js';

function fixture(overrides = {}) {
    const handlers = new Map(), registrations = [], positions = [], timers = new Map(), calls = [];
    const state = { hasAudio: true, status: 'playing', duration: 120, position: 30, running: true };
    let sequence = 0;
    const session = { playbackState: 'none',
        setActionHandler(name, callback) { registrations.push(name); handlers.set(name, callback); },
        setPositionState(value) { positions.push(value); }
    };
    Object.assign(session, overrides.session);
    const adapter = createMediaSession({
        readState: () => state,
        play() { calls.push('play'); state.status = 'playing'; },
        pause() { calls.push('pause'); state.status = 'paused'; },
        previous() { calls.push('previous'); }, next() { calls.push('next'); },
        seekTo(value) { calls.push(value); state.position = value; },
        ...overrides.actions
    }, { session: overrides.absent ? null : session,
        setTimer(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
        clearTimer(id) { timers.delete(id); }
    });
    Object.assign(state, overrides.state);
    adapter.initialize();
    return { adapter, session, handlers, registrations, positions, timers, state, calls,
        fire() { const [id, task] = [...timers][0]; timers.delete(id); task.callback(); } };
}

test('media controls register once, report the real timeline and share playback commands', () => {
    const f = fixture();
    f.adapter.initialize();
    assert.equal(f.registrations.length, 7);
    assert.equal(f.session.playbackState, 'playing');
    assert.deepEqual(f.positions.at(-1), { duration: 120, position: 30, playbackRate: 1 });
    f.handlers.get('pause')(); f.handlers.get('pause')();
    assert.equal(f.session.playbackState, 'paused');
    assert.equal(f.timers.size, 0);
    f.handlers.get('play')(); f.handlers.get('previoustrack')(); f.handlers.get('nexttrack')();
    assert.deepEqual(f.calls, ['pause', 'pause', 'play', 'previous', 'next']);
    assert.equal(f.timers.size, 1);
});

test('system seeking accepts zero, clamps endpoints and never starts paused audio', () => {
    const f = fixture({ state: { status: 'paused' } });
    for (const seekTime of [0, -100, 300, 18.25]) f.handlers.get('seekto')({ seekTime, fastSeek: true });
    assert.deepEqual(f.calls, [0, 0, 120, 18.25]);
    assert.equal(f.state.status, 'paused');
    assert.equal(f.timers.size, 0);
    assert.equal(f.positions.at(-1).position, 18.25);
});

test('relative system seeks honor valid offsets, default to ten seconds and stay bounded', () => {
    const f = fixture();
    f.handlers.get('seekforward')({ seekOffset: 3 });
    f.handlers.get('seekbackward')({ seekOffset: 2 });
    f.handlers.get('seekbackward')({ seekOffset: 0 });
    f.handlers.get('seekforward')({ seekOffset: Infinity });
    f.handlers.get('seekforward')({ seekOffset: 1000 });
    f.handlers.get('seekbackward')({ seekOffset: 1000 });
    assert.deepEqual(f.calls, [33, 31, 21, 31, 120, 0]);
});

test('malformed seek requests or unknown durations cannot seek, play or submit invalid state', () => {
    const f = fixture();
    for (const seekTime of [NaN, Infinity, -Infinity, '10', null, undefined]) f.handlers.get('seekto')({ seekTime });
    for (const duration of [0, -1, Infinity, NaN]) {
        f.state.duration = duration; f.adapter.sync();
        f.handlers.get('seekforward')(); f.handlers.get('seekto')({ seekTime: 1 });
    }
    assert.deepEqual(f.calls, []);
    assert.equal(f.positions.at(-1), undefined);
    assert.equal(f.timers.size, 0);
    f.state.duration = 120; f.state.hasAudio = false;
    f.handlers.get('seekto')({ seekTime: 10 });
    assert.deepEqual(f.calls, []);
});

test('position corrections use one one-second timer and follow PCM loop wraps without RAF', () => {
    const f = fixture({ state: { position: 119.8 } });
    f.adapter.sync(); f.adapter.sync();
    assert.equal(f.timers.size, 1);
    assert.equal([...f.timers.values()][0].delay, 1000);
    f.state.position = 0.8; f.fire();
    assert.equal(f.positions.at(-1).position, 0.8);
    assert.equal(f.timers.size, 1);
    f.state.position = 10.5; f.state.duration = 90; f.fire();
    assert.equal(f.positions.at(-1).duration, 90);
    assert.equal(f.positions.at(-1).position, 10.5);
});

test('pause, loading, suspension and failure stop polling; resume uses the current clock', () => {
    const f = fixture();
    for (const status of ['paused', 'loading', 'error', 'idle']) {
        f.state.status = status; f.adapter.sync();
        assert.equal(f.timers.size, 0);
        assert.notEqual(f.session.playbackState, 'playing');
        f.state.status = 'playing'; f.adapter.sync();
        assert.equal(f.timers.size, 1);
    }
    f.state.running = false; f.adapter.sync();
    assert.equal(f.session.playbackState, 'paused');
    assert.equal(f.timers.size, 0);
    f.state.running = true; f.state.position = 66; f.adapter.sync();
    assert.equal(f.positions.at(-1).position, 66);
    assert.equal(f.session.playbackState, 'playing');
});

test('switching tracks clears the previous position and stale timer callbacks cannot revive it', () => {
    const f = fixture();
    const stale = [...f.timers.values()][0].callback;
    f.adapter.reset();
    assert.equal(f.session.playbackState, 'none');
    assert.equal(f.positions.at(-1), undefined);
    const writes = f.positions.length;
    stale();
    assert.equal(f.positions.length, writes);
    assert.equal(f.timers.size, 0);
    f.state.position = 0; f.state.duration = 200; f.adapter.sync();
    stale();
    assert.equal(f.timers.size, 1);
    assert.equal(f.positions.at(-1).duration, 200);
});

test('absent APIs, unsupported actions and unavailable position reporting do not break playback', () => {
    const absent = fixture({ absent: true });
    assert.equal(absent.handlers.size, 0); assert.equal(absent.timers.size, 0);
    const positions = fixture({ session: { setPositionState: undefined } });
    positions.handlers.get('pause')(); positions.handlers.get('play')();
    assert.deepEqual(positions.calls, ['pause', 'play']);
    assert.equal(positions.timers.size, 0);
    const actions = fixture({ session: { setActionHandler(name) { if (name === 'seekto') throw new Error('unsupported'); } } });
    assert.doesNotThrow(() => actions.adapter.sync());
    assert.equal(actions.timers.size, 1);
    const failing = fixture({ session: { setPositionState() { throw new Error('unsupported'); } } });
    failing.handlers.get('pause')();
    assert.deepEqual(failing.calls, ['pause']); assert.equal(failing.timers.size, 0);
});

test('late async control completion cannot restart position polling after reset or disposal', async () => {
    let finish;
    const f = fixture({ actions: { play: () => new Promise(resolve => { finish = resolve; }) } });
    const pending = f.handlers.get('play')();
    f.adapter.reset();
    const writes = f.positions.length;
    finish(); await pending;
    assert.equal(f.positions.length, writes); assert.equal(f.timers.size, 0);
    const oldPause = f.handlers.get('pause');
    f.adapter.dispose(); oldPause(); f.adapter.sync();
    assert.equal(f.handlers.get('pause'), null);
    assert.deepEqual(f.calls, []);
    assert.equal(f.timers.size, 0);
});

test('rejected playback commands are contained and paused timelines are not kept alive', async () => {
    const f = fixture({ state: { status: 'paused' }, actions: { play: () => Promise.reject(new Error('autoplay')) } });
    await assert.doesNotReject(async () => f.handlers.get('play')());
    assert.equal(f.session.playbackState, 'paused');
    assert.equal(f.timers.size, 0);
});
