import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolbarVisibility } from '../src/ui/toolbar-visibility.js';
import { FakeElement } from './helpers/host.mjs';

function fixture() {
    const doc = new FakeElement(), toolbar = new FakeElement(), capsule = new FakeElement(), env = new FakeElement();
    const timers = new Map(), media = new FakeElement();
    let now = 0, sequence = 0;
    const state = { status: 'playing', blocked: false, focused: true };
    doc.hidden = false; doc.hasFocus = () => state.focused; doc.activeElement = null;
    env.document = doc; env.performance = { now: () => now }; media.matches = false;
    env.matchMedia = () => media;
    env.setTimeout = (callback, ms) => { const id = ++sequence; timers.set(id, { callback, due: now + ms }); return id; };
    env.clearTimeout = id => timers.delete(id);
    const controller = createToolbarVisibility({ toolbar, capsule, env, readStatus: () => state.status, isBlocked: () => state.blocked });
    function advance(ms) {
        const end = now + ms;
        while (true) {
            const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
            if (!next || next[1].due > end) break;
            now = next[1].due; timers.delete(next[0]); next[1].callback();
        }
        now = end;
    }
    const event = (target, type, extra = {}) => target.dispatchEvent({ type, ...extra });
    return { doc, toolbar, capsule, env, media, state, timers, controller, advance, event,
        get hidden() { return toolbar.classList.contains('toolbar-hidden'); },
        get dimmed() { return capsule.classList.contains('song-actions-idle'); } };
}

test('desktop playback hides at four seconds and activity immediately restores hit testing', () => {
    const f = fixture(); f.advance(3999); assert.equal(f.hidden, false);
    f.advance(1); assert.equal(f.hidden, true); assert.equal(f.toolbar.inert, true);
    f.event(f.doc, 'pointermove'); assert.equal(f.hidden, false); assert.equal(f.toolbar.inert, false);
});

test('frequent movement extends a single timer rather than adding animation loops', () => {
    const f = fixture();
    for (let i = 0; i < 1000; i++) { f.advance(2); f.event(f.doc, 'pointermove'); }
    assert.equal(f.timers.size, 1); f.advance(3999); assert.equal(f.hidden, false);
    f.advance(1); assert.equal(f.hidden, true); assert.equal(f.timers.size, 0);
});

test('pause, loading, errors, small screens and touch-only devices retain the toolbar', () => {
    for (const status of ['idle', 'paused', 'loading', 'error']) {
        const f = fixture(); f.state.status = status; f.controller.sync(); f.advance(9000);
        assert.equal(f.hidden, false); assert.equal(f.timers.size, 0);
    }
    const f = fixture(); f.media.matches = true; f.event(f.media, 'change'); f.advance(9000);
    assert.equal(f.hidden, false); assert.equal(f.timers.size, 0);
});

test('toolbar hover, keyboard focus, text input, open panels and native selectors lock visibility', () => {
    for (const kind of ['hover', 'keyboard', 'input', 'panel', 'select']) {
        const f = fixture(), control = new FakeElement(); f.toolbar.children.push(control);
        if (kind === 'hover') f.event(f.toolbar, 'pointerenter');
        if (kind === 'keyboard') { f.doc.activeElement = control; f.event(f.doc, 'keydown'); }
        if (kind === 'input') { control.tagName = 'INPUT'; f.doc.activeElement = control; }
        if (kind === 'panel') f.state.blocked = true;
        if (kind === 'select') { control.tagName = 'SELECT'; f.event(f.toolbar, 'pointerdown', { target: control }); }
        f.advance(9000); assert.equal(f.hidden, false, kind);
    }
});

test('window blur does not immediately hide, and focus return shows controls', () => {
    const f = fixture(); f.state.focused = false; f.event(f.env, 'blur');
    f.advance(3999); assert.equal(f.hidden, false); f.advance(1); assert.equal(f.hidden, true);
    f.state.focused = true; f.event(f.env, 'focus'); assert.equal(f.hidden, false);
});

test('hidden pages have no pending visual timers and keyboard wakes before Tab default handling', () => {
    const f = fixture(); f.doc.hidden = true; f.event(f.doc, 'visibilitychange');
    assert.equal(f.timers.size, 0); f.doc.hidden = false; f.event(f.doc, 'visibilitychange');
    f.advance(4000); assert.equal(f.hidden, true);
    f.event(f.doc, 'keydown', { key: 'Tab' }); assert.equal(f.hidden, false); assert.equal(f.toolbar.inert, false);
    f.controller.dispose(); assert.equal(f.timers.size, 0);
    assert.ok([...f.doc.listeners.values()].every(listeners => listeners.size === 0));
});

test('restoring toolbar visibility never removes an external modal inert lock', () => {
    const f = fixture(); f.toolbar.inert = true; f.state.blocked = true;
    f.controller.sync(); f.advance(4000);
    assert.equal(f.hidden, false); assert.equal(f.toolbar.inert, true);
    f.event(f.doc, 'pointermove'); assert.equal(f.toolbar.inert, true);
    f.controller.dispose(); assert.equal(f.toolbar.inert, true);
});

test('dismissed native select does not indefinitely prevent idle hiding', () => {
    const f = fixture(), select = new FakeElement(); select.tagName = 'SELECT';
    f.event(f.toolbar, 'pointerdown', { target: select }); f.advance(4000);
    assert.equal(f.hidden, false);
    f.event(f.doc, 'keydown', { key: 'Escape' });
    f.event(f.doc, 'pointerdown', { target: f.doc }); f.advance(4000);
    assert.equal(f.hidden, true);
});

test('favorite capsule shares the four-second clock without disabling its hit area or keyboard access', () => {
    const f = fixture(); f.advance(3999); assert.equal(f.dimmed, false);
    f.advance(1); assert.equal(f.dimmed, true); assert.equal(f.hidden, true);
    assert.notEqual(f.capsule.inert, true); assert.equal(f.timers.size, 0);
    f.event(f.doc, 'pointermove'); assert.equal(f.dimmed, false); assert.equal(f.timers.size, 1);
});

test('hovering the capsule and keyboard focus keep it clear without pinning the separate toolbar', () => {
    for (const kind of ['hover', 'keyboard']) {
        const f = fixture(), button = new FakeElement(); f.capsule.children.push(button);
        if (kind === 'hover') f.event(f.capsule, 'pointerenter');
        else { f.doc.activeElement = button; f.event(f.doc, 'keydown', { key: 'Tab' }); }
        f.advance(9000); assert.equal(f.dimmed, false); assert.equal(f.hidden, true);
        f.doc.activeElement = null;
        f.event(kind === 'hover' ? f.capsule : f.doc, kind === 'hover' ? 'pointerleave' : 'focusout');
        f.advance(4000); assert.equal(f.dimmed, true);
    }
});

test('open panels, pause, loading, errors and hidden pages keep the capsule clear', () => {
    for (const status of ['idle', 'paused', 'loading', 'error']) {
        const f = fixture(); f.advance(4000); assert.equal(f.dimmed, true);
        f.state.status = status; f.controller.sync(); f.advance(9000);
        assert.equal(f.dimmed, false); assert.equal(f.timers.size, 0);
    }
    const f = fixture(); f.state.blocked = true; f.advance(4000); assert.equal(f.dimmed, false);
    f.state.blocked = false; f.controller.sync(); f.advance(4000); assert.equal(f.dimmed, true);
    f.doc.hidden = true; f.event(f.doc, 'visibilitychange');
    assert.equal(f.dimmed, false); assert.equal(f.timers.size, 0);
});

test('wheel input wakes the capsule and repeated scrolling still uses only the existing single timer', () => {
    const f = fixture(); f.advance(4000); assert.equal(f.dimmed, true);
    for (let i = 0; i < 1000; i++) { f.event(f.doc, 'wheel'); f.advance(2); }
    assert.equal(f.dimmed, false); assert.equal(f.timers.size, 1);
    f.advance(4000); assert.equal(f.dimmed, true); assert.equal(f.timers.size, 0);
    f.controller.dispose(); assert.equal(f.dimmed, false);
    assert.ok([...f.capsule.listeners.values()].every(listeners => listeners.size === 0));
});

test('stale mouse hover cannot pin the capsule when the window loses focus', () => {
    const f = fixture(); f.event(f.capsule, 'pointerenter');
    f.state.focused = false; f.event(f.env, 'blur'); f.advance(4000);
    assert.equal(f.dimmed, true);
    f.state.focused = true; f.event(f.env, 'focus'); assert.equal(f.dimmed, false);
});
