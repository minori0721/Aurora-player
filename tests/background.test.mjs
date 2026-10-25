import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundSize, flowTheme, createFlowPainter, createFlowBackground } from '../src/ui/background.js';

test('background backing pixels are bounded independently of DPR and preserve aspect ratio', () => {
    for (const [width, height] of [[1440, 900], [3840, 2160], [390, 844], [320, 700], [1, 1]]) {
        const size = backgroundSize(width, height);
        assert.ok(size.width >= 1 && size.height >= 1);
        assert.ok(Math.max(size.width, size.height) <= (width <= 768 ? 384 : 512));
        assert.ok(Math.abs(size.width / size.height - width / height) < 0.01);
    }
    assert.deepEqual(backgroundSize(NaN, Infinity), { width: 1, height: 1, fps: 24 });
});

test('flow themes contain only bounded linear colors and normalized weights', () => {
    for (const theme of [{}, { colors: ['rgb(12,40,180)', 'rgba(220,100,50,0.4)', '#ffffff', '#000000'], weights: [0.4, 0.3, 0.2, 0.1] },
        { colors: ['bad', 'rgb(NaN,0,0)'], weights: [NaN, -1, Infinity, 0] }]) {
        const data = flowTheme(theme);
        assert.equal(data.colors.length, 12);
        assert.ok(data.colors.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
        assert.ok(data.weights.every(value => value > 0));
        assert.ok(Math.abs(data.weights.reduce((sum, value) => sum + value, 0) - 1) < 1e-6);
    }
});

test('hex base colors are honored when compositing transparent theme colors', () => {
    const colors = Array(4).fill('rgba(255,0,0,0)');
    assert.deepEqual(flowTheme({ base: '#123456', colors }), flowTheme({ base: 'rgb(18,52,86)', colors }));
    assert.deepEqual(flowTheme({ base: '#123', colors }), flowTheme({ base: 'rgb(17,34,51)', colors }));
    assert.notDeepEqual(flowTheme({ base: '#123456', colors }), flowTheme({ colors }));
});

function clocked(run) {
    const saved = Object.fromEntries(['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, globalThis[key]]));
    const originalNow = performance.now;
    let now = 0, seed = 0;
    const timers = new Map(), frames = new Map();
    globalThis.setTimeout = (callback, delay) => { const id = ++seed; timers.set(id, { callback, at: now + delay }); return id; };
    globalThis.clearTimeout = id => timers.delete(id);
    globalThis.requestAnimationFrame = callback => { const id = ++seed; frames.set(id, callback); return id; };
    globalThis.cancelAnimationFrame = id => frames.delete(id);
    performance.now = () => now;
    try { run({ tick(ms) {
        now += ms;
        for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
        for (const [id, callback] of [...frames]) { frames.delete(id); callback(now); }
    }, pending: () => timers.size + frames.size }); }
    finally {
        performance.now = originalNow;
        for (const [key, value] of Object.entries(saved)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
}

function fixture() {
    const events = new Map(), classes = new Set(), drawn = [], themes = [];
    const canvas = { width: 1, height: 1,
        addEventListener: (event, callback) => events.set(event, callback), removeEventListener: event => events.delete(event) };
    let allocations = 0, disposals = 0;
    const background = createFlowBackground(canvas, { body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
        makePainter: () => { allocations++; return {
            setTheme: (theme, now) => themes.push({ theme, now }),
            finishTransition() {},
            draw: (colors, weights, phase) => drawn.push({ colors: [...colors], weights: [...weights], phase }),
            dispose: () => disposals++
        }; } });
    const state = { playing: false, hidden: false, reduced: false, width: 1440, height: 900 };
    return { background, state, drawn, themes, events, classes, canvas, allocations: () => allocations, disposals: () => disposals };
}

test('idle allocates no context; pause, hidden and reduced motion stop pending animation', () => clocked(clock => {
    const f = fixture(); f.background.setState(f.state);
    assert.equal(f.allocations(), 0); assert.equal(clock.pending(), 0);
    f.state.playing = true; f.state.reduced = true; f.background.setState(f.state);
    assert.equal(f.allocations(), 0); assert.equal(clock.pending(), 0);
    f.state.reduced = false; f.background.setState(f.state); clock.tick(35);
    assert.equal(f.allocations(), 1); assert.ok(f.drawn.length >= 2);
    f.state.playing = false; f.background.setState(f.state);
    const paused = f.background.getStats(); clock.tick(1000);
    assert.equal(f.background.getStats().draws, paused.draws); assert.equal(clock.pending(), 0);
    f.state.playing = true; f.background.setState(f.state); clock.tick(35);
    assert.ok(f.background.getStats().phase < paused.phase + 0.1, 'resume must not include wall-clock pause');
    f.state.hidden = true; f.background.setState(f.state); const hidden = f.background.getStats(); clock.tick(1000);
    assert.equal(f.background.getStats().draws, hidden.draws); assert.equal(clock.pending(), 0);
    f.state.hidden = false; f.state.reduced = true; f.background.setState(f.state);
    assert.equal(clock.pending(), 0);
    f.background.dispose(); assert.equal(f.disposals(), 1); assert.equal(f.canvas.width, 1); assert.equal(f.events.size, 0);
}));

test('rapid theme replacement starts from the current interpolation and settles while paused', () => clocked(clock => {
    const f = fixture(); f.state.playing = true; f.background.setState(f.state);
    f.background.setTheme({ colors: Array(4).fill('rgb(255,100,100)') }); clock.tick(500);
    const middle = f.drawn.at(-1).colors;
    f.background.setTheme({ colors: Array(4).fill('rgb(100,255,100)') });
    assert.deepEqual(f.drawn.at(-1).colors, middle);
    f.state.playing = false; f.background.setState(f.state); clock.tick(1100);
    assert.equal(clock.pending(), 0);
    const target = flowTheme({ colors: Array(4).fill('rgb(100,255,100)') });
    assert.deepEqual(f.drawn.at(-1).colors, [...target.colors]);
    f.background.dispose();
}));

test('theme transition stays active beyond 650ms and settles in 1000ms plus one frame', () => clocked(clock => {
    const f = fixture(); f.state.playing = true; f.background.setState(f.state);
    const theme = { colors: Array(4).fill('rgb(255,70,70)') };
    const target = [...flowTheme(theme).colors];
    f.background.setTheme(theme);
    f.state.playing = false; f.background.setState(f.state);
    for (let elapsed = 10; elapsed <= 990; elapsed += 10) clock.tick(10);
    assert.notDeepEqual(f.drawn.at(-1).colors, target);
    clock.tick(40);
    assert.deepEqual(f.drawn.at(-1).colors, target);
    assert.equal(clock.pending(), 0);
    const phase = f.background.getStats().phase;
    clock.tick(1000);
    assert.equal(f.background.getStats().phase, phase);
    f.background.dispose();
}));

test('context loss cancels rendering; restoration recreates once; disposal prevents revival', () => clocked(clock => {
    const f = fixture(); f.state.playing = true; f.background.setState(f.state);
    let prevented = false;
    f.events.get('webglcontextlost')({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true); assert.equal(clock.pending(), 0); assert.equal(f.canvas.hidden, true);
    assert.equal(f.classes.size, 0); clock.tick(500);
    const restore = f.events.get('webglcontextrestored'); restore();
    assert.equal(f.allocations(), 2); assert.equal(f.canvas.hidden, false);
    f.background.dispose(); restore();
    f.background.setState({ ...f.state, width: 3840 });
    f.background.setTheme({ colors: Array(4).fill('rgb(255,0,0)') });
    assert.equal(f.canvas.width, 1); assert.equal(f.allocations(), 2); assert.equal(clock.pending(), 0);
}));

test('unsupported WebGL and shader failure stay static and release partial resources', () => clocked(clock => {
    assert.equal(createFlowPainter({ getContext: () => null }), null);
    let deleted = 0;
    assert.equal(createFlowPainter({ getContext: () => ({ createShader: () => ({}), shaderSource() {}, compileShader() {}, getShaderParameter: () => false, deleteShader: () => deleted++ }) }), null);
    assert.equal(deleted, 1);
    const canvas = { width: 1, height: 1, getContext: () => null };
    const background = createFlowBackground(canvas, { body: null });
    background.setState({ playing: true, hidden: false, reduced: false, width: 1440, height: 900 });
    assert.equal(background.getStats().failed, true); assert.equal(canvas.hidden, true); assert.equal(clock.pending(), 0);
    background.dispose();
}));

test('spatial changes with identical palettes reach the painter and survive context restoration', () => clocked(clock => {
    const f = fixture();
    const theme = { colors: Array(4).fill('rgb(100,100,100)'), spatial: { data: new Uint8Array(16384) } };
    f.background.setTheme(theme);
    f.state.playing = true;
    f.background.setState(f.state);
    assert.equal(f.themes.at(-1).theme, theme);
    const next = { ...theme, spatial: { data: new Uint8Array(16384).fill(80) } };
    f.background.setTheme(next);
    assert.equal(f.themes.at(-1).theme, next);
    f.state.playing = false;
    f.background.setState(f.state);
    clock.tick(750);
    assert.ok(clock.pending() > 0, 'the spatial-only transition must not finish at 650ms');
    clock.tick(300);
    assert.equal(clock.pending(), 0);
    f.events.get('webglcontextlost')({ preventDefault() {} });
    f.state.playing = true;
    f.background.setState(f.state);
    f.events.get('webglcontextrestored')();
    assert.equal(f.themes.at(-1).theme, next);
    f.background.dispose();
}));

test('continuous resizing preserves motion time and the same context without uploading another theme', () => clocked(clock => {
    const f = fixture(); f.state.playing = true; f.background.setState(f.state);
    clock.tick(40);
    const before = f.background.getStats(), themes = f.themes.length;
    for (let i = 1; i <= 10; i++) {
        clock.tick(16);
        f.background.setState({ ...f.state, width: 1440 - i * 25 });
    }
    const after = f.background.getStats();
    assert.ok(after.phase >= before.phase + .159 && after.phase <= before.phase + .161);
    assert.equal(f.allocations(), 1);
    assert.equal(f.themes.length, themes);
    f.background.setState({ ...f.state, playing: false }); clock.tick(2000);
    const paused = f.background.getStats().phase;
    f.background.setState({ ...f.state, width: 390, height: 844 }); clock.tick(45);
    assert.ok(f.background.getStats().phase < paused + .1, 'resume must not include the pause');
    f.background.dispose();
}));
