import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLyrics } from '../src/lyrics/controller.js';
import { createDom } from '../src/ui/elements.js';
import { createHost, FakeElement } from './helpers/host.mjs';

const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { playing = true, stream = true, fail = false, normalize = value => value } = {}) {
    const { host } = createHost(html), previous = new Map();
    host.document.createTextNode = text => Object.assign(new FakeElement(), { textContent: text });
    for (const [key, value] of Object.entries({ window: host, document: host.document, localStorage: host.localStorage,
        requestAnimationFrame: host.requestAnimationFrame, cancelAnimationFrame: host.cancelAnimationFrame })) {
        previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    const calls = [], warnings = [], state = { duration: 120, isPlaying: playing };
    let time = 7, version = 0, lyrics;
    t.after(() => {
        lyrics?.resetTrackLyrics();
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });
    const playback = {
        hasAudio: true, playbackState: state, getCurrentTime: () => time,
        seekAudio(value) { calls.push(['seek', value]); if (fail) throw new Error('seek rejected'); time = playing ? normalize(value) : value; },
        startAudio(value) { calls.push(['play', value]); const stamp = ++version;
            if (stream) { state.isPlaying = false; queueMicrotask(() => { if (stamp === version) { time = normalize(value); state.isPlaying = true; } }); }
            else { time = normalize(value); state.isPlaying = true; }
            return true;
        }
    };
    const dom = createDom();
    const query = dom.el.lyricBox.querySelectorAll.bind(dom.el.lyricBox);
    dom.el.lyricBox.querySelectorAll = selector => selector === '[data-lyric-time]'
        ? dom.el.lyricBox.children.filter(line => line.dataset.lyricTime !== undefined) : query(selector);
    lyrics = createLyrics({ dom, playback, metadata: {}, debug: { log: (...args) => warnings.push(args) } });
    lyrics.initialize(); lyrics.lyricDisplayMode = 'both';
    lyrics.parseAndRenderLyrics('[00:00.000]first\n[00:30.000]middle\n[01:00.000]target', 'test', '[00:30.000]translation\n[01:00.000]translated target');
    const lines = [...dom.el.lyricBox.children];
    const click = index => {
        const line = lines[index]; line.closest = () => line;
        dom.el.lyricBox.dispatchEvent({ type: 'click', target: line, preventDefault() {} });
    };
    return { playback, lyrics, state, calls, warnings, lines, click, get time() { return time; } };
}

for (const stream of [false, true]) for (const playing of [false, true]) {
    test(`lyric click commits time before highlighting and preserves play-on-click (${stream ? 'stream' : 'PCM'}, ${playing ? 'playing' : 'paused'})`, async t => {
        const f = fixture(t, { stream, playing });
        f.click(2);
        assert.equal(f.time, 60);
        assert.equal(f.lines[2].getAttribute('aria-current'), 'true');
        assert.equal(f.lines[0].getAttribute('aria-current'), null);
        assert.deepEqual(f.calls, [['seek', 60], ...(!playing ? [['play', 60]] : [])]);
        await tick(); assert.equal(f.time, 60); assert.equal(f.state.isPlaying, true);
    });
}

test('rapid lyric clicks do not let a pending native play restore an earlier position', async t => {
    const f = fixture(t, { playing: false }); f.click(1); f.click(2);
    assert.equal(f.lines[2].getAttribute('aria-current'), 'true');
    await tick(); assert.equal(f.time, 60);
    assert.deepEqual(f.calls, [['seek', 30], ['play', 30], ['seek', 60], ['play', 60]]);
});

test('rejected seeks retain the current highlight and do not attempt playback', t => {
    const f = fixture(t, { playing: false, fail: true }); f.click(2);
    assert.equal(f.time, 7); assert.equal(f.lines[0].getAttribute('aria-current'), 'true');
    assert.equal(f.state.isPlaying, false); assert.deepEqual(f.calls, [['seek', 60]]);
    assert.match(f.warnings.at(-1)[0], /歌词跳转失败/);
});

test('lyric highlights use the loop-normalized effective time, not the originally requested row', t => {
    const f = fixture(t, { stream: false, normalize: value => value >= 60 ? 30 : value }); f.click(2);
    assert.equal(f.time, 30); assert.equal(f.lines[1].getAttribute('aria-current'), 'true');
    assert.equal(f.lines[2].getAttribute('aria-current'), null);
});
