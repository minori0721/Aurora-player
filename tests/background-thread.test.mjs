import test from 'node:test';
import assert from 'node:assert/strict';
import { createThreadedBackground } from '../src/ui/background-thread.js';
const state = { playing: true, hidden: false, reduced: false, width: 1440, height: 900 };

function fixture(t) {
    const messages = [], classes = new Set(), offscreen = {}, canvas = { dataset: {}, transferControlToOffscreen: () => offscreen };
    let created = 0, terminated = 0;
    const worker = { postMessage: (data, transfer) => messages.push({ data, transfer }), terminate: () => terminated++ };
    const background = createThreadedBackground(canvas, { body: { classList: { toggle(name, show) { if (show) classes.add(name); else classes.delete(name); } } }, workerFactory: () => { created++; return worker; } });
    t.after(() => background.dispose());
    return { background, worker, messages, canvas, offscreen, classes, created: () => created, terminated: () => terminated };
}

test('threaded background transfers once, deduplicates state and ignores stale theme replies', t => {
    const f = fixture(t); f.background.setTheme({ colors: ['rgb(0,0,0)'] });
    f.background.setState({ ...state, reduced: true }); assert.equal(f.created(), 0);
    f.background.setState(state); assert.equal(f.created(), 1);
    assert.deepEqual(f.messages[0].transfer, [f.offscreen]);
    f.background.setState({ ...state }); assert.equal(f.messages.length, 1);
    f.background.setTheme({ colors: ['rgb(255,255,255)'] });
    f.worker.onmessage({ data: { type: 'status', revision: 1, stats: { ready: true } } });
    assert.equal(f.canvas.hidden, true);
    f.worker.onmessage({ data: { type: 'status', revision: 2, stats: { ready: true, width: 512, height: 320 } } });
    assert.equal(f.canvas.hidden, false); assert.equal(f.canvas.dataset.bufferWidth, '512');
    f.background.setState({ ...state, hidden: true }); assert.equal(f.canvas.hidden, true);
    f.background.setState(state); assert.equal(f.canvas.hidden, false);
    f.background.setState({ ...state, hidden: true });
    f.background.setTheme({ colors: ['rgb(0,255,0)'] }); f.background.setState(state);
    assert.equal(f.canvas.hidden, true, 'visibility restore must not reveal an obsolete worker frame');
    f.worker.onmessage({ data: { type: 'status', revision: 3, stats: { ready: true, width: 512, height: 320 } } });
    assert.equal(f.canvas.hidden, false);
    f.background.dispose(); assert.equal(f.terminated(), 1);
    f.background.setState(state); f.background.setTheme({}); assert.equal(f.created(), 1);
});

test('worker errors fall back once and cannot revive the disposed renderer', t => {
    const f = fixture(t); f.background.setState(state);
    f.worker.onerror({ preventDefault() {} });
    assert.equal(f.canvas.hidden, true); assert.equal(f.classes.size, 0); assert.equal(f.terminated(), 1);
    f.background.setState(state); assert.equal(f.created(), 1);
    f.worker.onmessage({ data: { type: 'status', revision: 0, stats: { ready: true } } });
    assert.equal(f.canvas.hidden, true);
    const unsupported = createThreadedBackground({ hidden: false }, { body: null });
    unsupported.setState(state); assert.equal(unsupported.getStats().failed, true); unsupported.dispose();
});

test('theme messages clone the small sample without transferring or detaching cached bytes', t => {
    const f = fixture(t);
    f.background.setState(state);
    const sample = { width: 64, height: 64, format: 'srgb-rgba8', data: new Uint8Array(16384).fill(90) };
    const theme = { spatial: sample };
    f.background.setTheme(theme);
    const message = f.messages.at(-1);
    assert.equal(message.transfer, undefined);
    const cloned = structuredClone(message.data);
    cloned.theme.spatial.data.fill(0);
    assert.equal(sample.data.byteLength, 16384);
    assert.equal(sample.data[0], 90);
    f.background.setTheme(theme);
    assert.equal(f.messages.at(-1), message);
});
