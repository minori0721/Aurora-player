import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyrics } from '../src/lyrics/controller.js';
import { createRender } from '../src/ui/render.js';
import { createHost, FakeElement } from './helpers/host.mjs';

function globals(t, values) {
    const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => {
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
}

test('a lyric update fault logs once and cannot stop playback; rebuilding lyrics permits recovery', t => {
    const { host } = createHost(), errors = [], box = new FakeElement();
    globals(t, { document: host.document, localStorage: host.localStorage });
    let broken = true;
    const lyrics = createLyrics({ playback: { getCurrentTime() { if (broken) throw new Error('synthetic lyric fault'); return 0; } },
        metadata: {}, debug: { log: text => errors.push(text) }, dom: { el: { lyricBox: box, artist: new FakeElement() } } });
    lyrics.parseAndRenderLyrics('[00:00.000]first\n[00:01.000]second', 'test');
    lyrics.refreshLyricHighlightAndCenter(); lyrics.refreshLyricHighlightAndCenter();
    assert.equal(errors.filter(text => text.includes('synthetic lyric fault')).length, 1);
    broken = false;
    lyrics.parseAndRenderLyrics('[00:00.000]rebuilt', 'test');
    lyrics.refreshLyricHighlightAndCenter();
    assert.equal(box.children[0].getAttribute('aria-current'), 'true');
});

test('next cue is read-only and follows actual time through pauses, seeks, loops and resets', t => {
    const { host } = createHost(); host.document.createTextNode = () => new FakeElement();
    globals(t, { document: host.document, localStorage: host.localStorage });
    let time = 0;
    const lyrics = createLyrics({ playback: { getCurrentTime: () => time }, metadata: {}, debug: { log() {} },
        dom: { el: { lyricBox: new FakeElement(), artist: new FakeElement() } } });
    assert.equal(lyrics.getNextLyricTime(), null);
    lyrics.parseAndRenderLyrics('[00:00.000]first\n[00:01.000]second\n[00:02.000]third', 'test');
    assert.equal(lyrics.getNextLyricTime(), 1);
    time = .999;
    lyrics.refreshLyricHighlightAndCenter(); assert.equal(lyrics.getNextLyricTime(), 1);
    assert.equal(lyrics.getNextLyricTime(), 1, 'reading a deadline must not advance the active cursor');
    time = 1;
    lyrics.refreshLyricHighlightAndCenter(); assert.equal(lyrics.getNextLyricTime(), 2);
    time = 2.5;
    lyrics.refreshLyricHighlightAndCenter(true); assert.equal(lyrics.getNextLyricTime(), null);
    time = .2;
    lyrics.refreshLyricHighlightAndCenter(); assert.equal(lyrics.getNextLyricTime(), 1);
    lyrics.resetTrackLyrics(); assert.equal(lyrics.getNextLyricTime(), null);
    lyrics.parseAndRenderLyrics('plain untimed text', 'test'); assert.equal(lyrics.getNextLyricTime(), null);
});

test('scroll wakes 15ms early once, without advancing highlight or word timing', t => {
    const { host } = createHost(); host.document.createTextNode = () => new FakeElement();
    globals(t, { document: host.document, localStorage: host.localStorage });
    let time = 0;
    const playbackState = { isPlaying: true }, content = new FakeElement();
    const lyrics = createLyrics({ playback: { playbackState, getCurrentTime: () => time }, metadata: {}, debug: { log() {} },
        dom: { el: { lyricBox: content, artist: new FakeElement() } } });
    lyrics.parseAndRenderLyrics('[00:00.000]first\n[00:01.000]second\n[00:02.000]third', 'test');
    assert.equal(lyrics.getNextLyricUpdateTime(), .985);
    time = .95; lyrics.refreshLyricHighlightAndCenter();
    time = .984; lyrics.refreshLyricHighlightAndCenter();
    assert.equal(lyrics.getNextLyricUpdateTime(), .985);
    time = .985; lyrics.refreshLyricHighlightAndCenter();
    assert.equal(content.children[0].getAttribute('aria-current'), 'true');
    assert.equal(content.children[1].getAttribute('aria-current'), null);
    assert.equal(lyrics.getNextLyricTime(), 1); assert.equal(lyrics.getNextLyricUpdateTime(), 1);
    playbackState.isPlaying = false; lyrics.refreshLyricHighlightAndCenter();
    assert.equal(lyrics.getNextLyricUpdateTime(), 1);
    playbackState.isPlaying = true;
    assert.equal(lyrics.getNextLyricUpdateTime(), .985);
    time = 1; lyrics.refreshLyricHighlightAndCenter();
    assert.equal(content.children[1].getAttribute('aria-current'), 'true');
    assert.equal(lyrics.getNextLyricUpdateTime(), 1.985);
    lyrics.resetTrackLyrics(); assert.equal(lyrics.getNextLyricUpdateTime(), null);
    time = 0;
    lyrics.parseAndRenderLyrics('[00:00.000]first\n[00:00.030]short\n[00:02.000]third', 'test');
    assert.equal(lyrics.getNextLyricUpdateTime(), .03, 'very short cues must not be skipped by anticipation');
});

test('main lyrics, subtitles and unchanged timed words share one inner visual wrapper', t => {
    const { host } = createHost(); host.document.createTextNode = () => new FakeElement();
    globals(t, { document: host.document, localStorage: host.localStorage });
    const content = new FakeElement();
    const lyrics = createLyrics({ playback: { getCurrentTime: () => 0 }, metadata: {}, debug: { log() {} },
        dom: { el: { lyricBox: content, artist: new FakeElement() } } });
    lyrics.lyricDisplayMode = 'both';
    lyrics.parseAndRenderLyrics('[00:00.000]intro\n[00:01.000]First longword', 'test', '[00:01.000]translation', '[00:01.000]roman', [
        { t: 1, words: [{ txt: 'First ', start: 1000, dur: 250 }, { txt: 'longword', start: 1250, dur: 700 }] }
    ]);
    const line = content.children[1], visual = line.children[0], original = visual.querySelector('.lyric-original');
    assert.equal(line.children.length, 1); assert.equal(visual.className, 'lyric-visual');
    assert.equal(line.getAttribute('role'), 'button'); assert.equal(line.dataset.lyricTime, 1);
    assert.equal(visual.querySelector('.lyric-translation').textContent, 'translation');
    assert.deepEqual(original.children.map(word => [word.textContent, word.dataset.start, word.dataset.dur]), [['First ', 0, 250], ['longword', 250, 700]]);
});

function renderer(t, cues = [.05, .4]) {
    const { host, frames, timers } = createHost();
    let clock = 100, offset = clock, paused = 0, current = -1, frozen = false;
    const basic = [], highlights = [];
    const playbackState = { isPlaying: true, duration: 20 };
    const getCurrentTime = () => playbackState.isPlaying && !frozen ? (clock - offset) / 1000 : paused;
    globals(t, { window: host, document: host.document, ColorThief: class {}, performance: { now: () => clock },
        requestAnimationFrame: host.requestAnimationFrame, cancelAnimationFrame: host.cancelAnimationFrame,
        setTimeout: (callback, delay) => { const id = host.setTimeout(callback, delay); timers.get(id).at = clock + delay; return id; }, clearTimeout: host.clearTimeout });
    const el = Object.fromEntries(['canvas', 'progLine', 'progBg', 'currTime', 'effectSel'].map(key => [key, new FakeElement()]));
    el.effectSel.value = 'none';
    Object.defineProperty(el.currTime, 'textContent', { set() { basic.push(clock); } });
    const lyricService = {
        getNextLyricUpdateTime: () => cues[current + 1] ?? null,
        refreshLyricHighlightAndCenter() {
            const time = getCurrentTime();
            let next = -1;
            while (next + 1 < cues.length && cues[next + 1] <= time) next++;
            if (next !== current) highlights.push({ at: clock, index: next });
            current = next;
        }
    };
    const analyser = { frequencyBinCount: 8, getByteFrequencyData() {} };
    const render = createRender({ dom: { el }, playback: { playbackState, getCurrentTime, analyser }, lyrics: lyricService,
        queue: { playlist: [] }, prefetch: { getLikelyNextPlaylistIndex: () => null, warmNextStreamIfNeeded() {} } });
    render.initialize();
    const frame = at => {
        clock = at;
        for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.callback(); }
        for (const [id, callback] of [...frames]) { frames.delete(id); callback(clock); }
    };
    const status = (playing, time = getCurrentTime()) => {
        paused = time; offset = clock - time * 1000; playbackState.isPlaying = playing; render.scheduleRender(true);
    };
    return { frame, render, highlights, basic, timers, frames, el, host, playbackState,
        status, setCues(next) { cues = next; current = -1; }, freeze() { paused = getCurrentTime(); frozen = true; } };
}

test('a lyric deadline wakes before the basic UI tick, never before its actual cue', t => {
    const f = renderer(t); f.frame(100);
    assert.equal([...f.timers.values()][0].at, 150);
    f.frame(149); assert.equal(f.highlights.length, 0);
    f.frame(150); assert.deepEqual(f.highlights, [{ at: 150, index: 0 }]);
    assert.equal(f.basic.length, 1, 'a lyric-only frame must not rewrite the time/progress UI');
    assert.equal([...f.timers.values()][0].at, 166);
    assert.equal(f.timers.size, 1); assert.equal(f.frames.size, 0);
});

test('pause cancels a scheduled boundary immediately and leaves no idle frames or timers', t => {
    const f = renderer(t); f.frame(100); f.status(false);
    assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 1);
    f.frame(170); f.frame(1000);
    assert.equal(f.highlights.length, 0); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
    f.status(true); f.frame(1010); f.frame(1050);
    assert.deepEqual(f.highlights, [{ at: 1050, index: 0 }]);
});

test('seeks and replacing lyrics use fresh cues rather than an old timer snapshot', t => {
    const f = renderer(t); f.frame(100); f.status(true, 2); f.frame(110);
    assert.deepEqual(f.highlights, [{ at: 110, index: 1 }]);
    f.status(true, 0); f.frame(120); assert.equal(f.highlights.at(-1).index, -1);
    f.setCues([.015, .2]); f.frame(170);
    assert.equal(f.highlights.at(-1).index, 0); assert.equal(f.timers.size, 1);
});

test('hidden pages cancel all render work and restore from the current clock', t => {
    const f = renderer(t); f.frame(100);
    f.host.document.hidden = true; f.host.document.dispatchEvent({ type: 'visibilitychange' });
    assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
    f.frame(1000); assert.equal(f.highlights.length, 0);
    f.host.document.hidden = false; f.host.document.dispatchEvent({ type: 'visibilitychange' }); f.frame(1010);
    assert.equal(f.highlights.at(-1).index, 1); assert.equal(f.timers.size, 1);
});

test('no lyrics and visual effects keep the existing basic cadence and idle behavior', t => {
    const f = renderer(t, []); f.frame(100);
    assert.equal([...f.timers.values()][0].at, 166);
    f.el.effectSel.value = 'bars'; f.frame(166);
    assert.equal(f.frames.size, 1); assert.equal(f.timers.size, 0);
    f.status(false); f.el.effectSel.value = 'none'; f.frame(200);
    assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
});

test('a suspended audio clock does not cause a persistent near-boundary animation-frame loop', t => {
    const f = renderer(t); f.frame(100); f.freeze(); f.frame(150);
    assert.equal(f.frames.size, 0); assert.equal([...f.timers.values()][0].at, 166);
    f.frame(166); assert.equal([...f.timers.values()][0].at, 232);
    assert.equal(f.highlights.length, 0);
});
