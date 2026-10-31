import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createControls } from '../src/ui/controls.js';
import { createDom } from '../src/ui/elements.js';
import { createHost, FakeElement } from './helpers/host.mjs';

const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');

function fixture(t, { playing = true, duration = 100 } = {}) {
    const { host } = createHost(html), saved = new Map();
    for (const [key, value] of Object.entries({ document: host.document, Element: FakeElement, window: host })) {
        saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    t.after(() => {
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    const dom = createDom(), progress = new FakeElement(), calls = [];
    const start = { parentNode: dom.el.currTime }, end = { parentNode: dom.el.totalTime };
    for (const node of [dom.el.progBg, dom.el.currTime, dom.el.totalTime]) node.parentNode = progress;
    progress.contains = node => {
        for (let current = node; current; current = current.parentNode) if (current === progress) return true;
        return false;
    };
    dom.el.progBg.closest = selector => selector === '.progress-section' ? progress : null;
    let ranges = [], cleared = 0;
    host.document.getSelection = () => ({
        rangeCount: ranges.length, getRangeAt: index => ranges[index],
        removeAllRanges() { ranges = []; cleared++; }
    });
    const state = { duration, pauseTime: 0, isPlaying: playing };
    const queue = { playlist: [{}], curIdx: 0 };
    const playback = {
        playbackState: state, playbackWantsPlay: playing, _currentPlayActionToken: 1, hasAudio: true,
        stopAudio(status) { calls.push(['stop', status]); state.isPlaying = false; },
        seekAudio(time) { calls.push(['seek', time]); state.pauseTime = time; },
        startAudio(time) { calls.push(['start', time]); state.pauseTime = time; state.isPlaying = true; },
        setPlaybackStatus(status) { calls.push(['status', status]); state.isPlaying = status === 'playing'; },
        getCurrentTime: () => state.pauseTime,
        gainNode: { gain: { value: 1 } }
    };
    const lyrics = { neteaseSearchEnabled: false, setLyricDisplayMode: mode => calls.push(['lyric-mode', mode]),
        cycleLyricDisplayMode: () => calls.push(['lyric-cycle']) };
    const controls = createControls({ dom, playback, queue,
        analysis: { cancelPreviewTimer() {} }, debug: { log: message => calls.push(['log', message]) }, lyrics, playlistView: {},
        panels: { modalController: { active: null } }, render: { setPlaybackProgress() {} } });
    controls.initialize();
    const pointer = (type, x = 100, overrides = {}) => {
        const event = { type, clientX: x, pointerId: 1, button: 0, target: dom.el.progBg,
            defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...overrides };
        if (type === 'pointerdown') progress.dispatchEvent(event);
        dom.el.progBg.dispatchEvent(event);
        return event;
    };
    return { dom, progress, start, end, playback, state, queue, calls, controls, lyrics, pointer, doc: host.document,
        select: (...next) => { ranges = next; }, get ranges() { return ranges; }, get cleared() { return cleared; } };
}

test('desktop and mobile native settings bind once and dispatch a single state update per action', t => {
    const f = fixture(t); f.controls.initialize();
    assert.equal(f.dom.cloudLyricsSwitches.length, 2);
    for (const input of f.dom.cloudLyricsSwitches) {
        assert.equal(input.listeners.get('change').size, 1);
        input.checked = true; input.dispatchEvent({ type: 'change', target: input });
        assert.equal(f.lyrics.neteaseSearchEnabled, true);
    }
    assert.equal(f.calls.filter(call => call[0] === 'log').length, 2);
    assert.equal(f.dom.lyricModeInputs.length, 3);
    for (const input of f.dom.lyricModeInputs) {
        input.value = 'roma'; input.checked = true;
        assert.equal(input.listeners.get('change').size, 1);
        input.dispatchEvent({ type: 'change', target: input });
    }
    assert.equal(f.calls.filter(call => call[0] === 'lyric-mode').length, 3);
    assert.equal(f.dom.lyricToggleBtn.listeners.get('click').size, 1);
    f.dom.lyricToggleBtn.click();
    assert.equal(f.calls.filter(call => call[0] === 'lyric-cycle').length, 1);
});

test('progress CSS disables only control text selection and keeps the native slider keyboard entry', () => {
    const css = fs.readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
    const rule = css.match(/\.progress-section\s*\{([^}]*)\}/)?.[1];
    assert.match(rule, /-webkit-user-select:\s*none/);
    assert.match(rule, /(?:^|;)\s*user-select:\s*none/);
    assert.match(html, /id="prog-bg"[^>]+role="slider"[^>]+tabindex="0"/);
});

test('loop status sits above the time labels without adding a grid row or changing cover layout', () => {
    const css = fs.readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
    const time = css.match(/\.time-display\s*\{([^}]*)\}/)?.[1];
    const status = css.match(/#loop-status\s*\{([^}]*)\}/)?.[1];
    assert.match(time, /position:\s*relative/);
    assert.match(status, /position:\s*absolute/);
    assert.match(status, /right:\s*0/);
    assert.doesNotMatch(status, /grid-area|margin|padding/);
});

test('mobile player budgets one viewport for playback and leaves the project footer in document flow', () => {
    const base = fs.readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
    const css = fs.readFileSync(new URL('../src/styles/responsive.css', import.meta.url), 'utf8');
    assert.match(base, /\.player-stage\s*\{\s*display:\s*contents/);
    assert.match(css, /\.player-stage\s*\{[^}]*height:\s*100dvh;[^}]*min-height:\s*min-content/);
    assert.match(css, /\.right-panel\s*\{[^}]*flex:\s*1 0 auto/);
    assert.match(css, /\.project-footer\s*\{[^}]*position:\s*static/);
    assert.match(html, /class="player-stage"/);
    assert.match(html, /<\/div>\s*<\/div>\s*<footer class="project-footer"/);
    assert.match(css, /max-height:\s*500px\) and \(orientation:\s*landscape\)/);
});

test('mobile lyric return keeps its original size and translucent glass without reserving a lyric row', () => {
    const css = fs.readFileSync(new URL('../src/styles/responsive.css', import.meta.url), 'utf8');
    const mobile = css.slice(css.indexOf('@media screen and (max-width: 900px)'));
    assert.match(mobile, /\.lyrics-area\s*\{[^}]*margin-bottom:\s*0/);
    assert.match(mobile, /\.lyric-return,\s*\.lyric-browse-time\s*\{[^}]*height:\s*44px/);
    assert.doesNotMatch(mobile, /\.lyric-return::after/);
    const glass = mobile.match(/\.lyric-return\s*\{([^}]+)\}/)[1];
    assert.match(glass, /backdrop-filter:/);
    assert.doesNotMatch(glass, /(?:^|;)\s*(?:opacity|animation|transform):/);
});

test('owned progress selection clears even before audio loads and time clicks do not seek', t => {
    const f = fixture(t, { duration: 0 });
    f.select({ startContainer: f.start, endContainer: f.end });
    f.progress.dispatchEvent({ type: 'pointerdown', button: 0, target: f.dom.el.currTime });
    assert.equal(f.cleared, 1);
    assert.deepEqual(f.calls, []);
});

test('collapsed and multiple owned ranges clear without installing duplicate listeners', t => {
    const f = fixture(t, { duration: 0 });
    f.controls.initialize();
    assert.equal(f.progress.listeners.get('pointerdown').size, 1);
    f.select({ startContainer: f.start, endContainer: f.start }, { startContainer: f.end, endContainer: f.end });
    f.pointer('pointerdown');
    assert.equal(f.cleared, 1);
    assert.deepEqual(f.ranges, []);
});

for (const outside of ['lyrics', 'input']) {
    test(`${outside} selection survives a progress gesture`, t => {
        const f = fixture(t);
        const node = new FakeElement(outside), range = { startContainer: node, endContainer: node };
        f.select(range);
        f.pointer('pointerdown'); f.pointer('pointerup');
        assert.equal(f.cleared, 0);
        assert.deepEqual(f.ranges, [range]);
        assert.ok(f.calls.some(call => call[0] === 'seek'), 'selection must not block seeking');
    });
}

for (const reverse of [false, true]) {
    test(`cross-region selection stays intact (${reverse ? 'outside to progress' : 'progress to outside'})`, t => {
        const f = fixture(t), outside = new FakeElement();
        const range = { startContainer: reverse ? outside : f.start, endContainer: reverse ? f.end : outside };
        f.select(range); f.pointer('pointerdown');
        assert.equal(f.cleared, 0);
        assert.deepEqual(f.ranges, [range]);
    });
}

test('a second range outside progress prevents clearing any of a multi-range selection', t => {
    const f = fixture(t), outside = new FakeElement();
    f.select({ startContainer: f.start, endContainer: f.end }, { startContainer: outside, endContainer: outside });
    f.pointer('pointerdown');
    assert.equal(f.cleared, 0);
    assert.equal(f.ranges.length, 2);
});

test('right click preserves both the selection and playback state', t => {
    const f = fixture(t);
    f.select({ startContainer: f.start, endContainer: f.end });
    const event = f.pointer('pointerdown', 100, { button: 2 });
    assert.equal(f.cleared, 0);
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(f.calls, []);
});

test('an unavailable or empty Selection API does not interfere with dragging', t => {
    const f = fixture(t);
    delete f.doc.getSelection;
    assert.doesNotThrow(() => { f.pointer('pointerdown'); f.pointer('pointerup'); });
    f.doc.getSelection = () => null;
    assert.doesNotThrow(() => { f.pointer('pointerdown'); f.pointer('pointerup'); });
});

for (const playing of [false, true]) for (const finish of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    test(`progress ${finish} keeps the last position and prior ${playing ? 'playing' : 'paused'} state`, t => {
        const f = fixture(t, { playing });
        f.select({ startContainer: f.start, endContainer: f.end });
        f.pointer('pointerdown', 100);
        f.pointer('pointermove', 300);
        f.pointer(finish, 300);
        assert.equal(f.cleared, 1);
        assert.equal(f.state.pauseTime, 75);
        assert.equal(f.state.isPlaying, playing);
        assert.deepEqual(f.calls, [...(playing ? [['stop', 'paused']] : []), ['seek', 75],
            playing ? ['start', 75] : ['status', 'paused']]);
        f.pointer('pointerup', 300);
        assert.equal(f.calls.filter(call => call[0] === 'seek').length, 1);
    });
}

test('switching tracks during progress drag cannot seek or restart the new track', t => {
    const f = fixture(t);
    f.pointer('pointerdown');
    f.playback._currentPlayActionToken++;
    f.queue.playlist[0] = {};
    f.pointer('pointermove', 300); f.pointer('pointerup', 300);
    assert.deepEqual(f.calls, [['stop', 'paused']]);
});

for (const playing of [false, true]) {
    test(`progress arrow/Home/End keyboard seeking keeps ${playing ? 'playing' : 'paused'} intent`, t => {
        const f = fixture(t, { playing });
        f.select({ startContainer: f.start, endContainer: f.end });
        for (const [key, expected] of [['ArrowRight', 5], ['ArrowLeft', 0], ['End', 100], ['Home', 0]]) {
            let prevented = false;
            f.dom.el.progBg.dispatchEvent({ type: 'keydown', key, preventDefault() { prevented = true; } });
            assert.equal(prevented, true);
            assert.equal(f.state.pauseTime, expected);
        }
        assert.equal(f.cleared, 0, 'keyboard operations must not change text selections');
        assert.equal(f.calls.filter(call => call[0] === 'start').length, playing ? 4 : 0);
    });
}
