import test from 'node:test';
import assert from 'node:assert/strict';
import { createBottomSheet, settleSheetHeight } from '../src/ui/bottom-sheet.js';
import { createHost, FakeElement } from './helpers/host.mjs';

function fixture({ mobile = true, label = '智能分析', toolbarBottom } = {}) {
    const { host: env, frames } = createHost();
    const compact = new FakeElement(), viewport = new FakeElement(), captures = new Set();
    const panel = new FakeElement(), header = new FakeElement(), handle = new FakeElement(), body = new FakeElement(), controls = new FakeElement();
    const writes = [];
    compact.matches = mobile;
    viewport.height = 844; viewport.offsetTop = 0;
    env.innerHeight = 844; env.visualViewport = viewport; env.matchMedia = () => compact;
    let row = { top: 760, bottom: 812 };
    controls.getBoundingClientRect = () => row;
    panel.style.removeProperty = name => { delete panel.style[name]; };
    const setProperty = panel.style.setProperty.bind(panel.style);
    panel.style.setProperty = (name, value) => { writes.push([name, value]); setProperty(name, value); };
    handle.setPointerCapture = id => captures.add(id);
    handle.hasPointerCapture = id => captures.has(id);
    handle.releasePointerCapture = id => { captures.delete(id); handle.dispatchEvent({ type: 'lostpointercapture', pointerId: id }); };
    handle.focus = () => { env.document.activeElement = handle; };
    body.scrollTop = 0; body.scrollHeight = 1000;
    let observing = false;
    env.ResizeObserver = class { observe() { observing = true; } disconnect() { observing = false; } };
    const toolbar = toolbarBottom === undefined ? undefined : { getBoundingClientRect: () => ({ bottom: toolbarBottom }) };
    const sheet = createBottomSheet({ panel, header, handle, body, controls, toolbar, label, env });
    sheet.initialize();
    const flush = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(performance.now()); } };
    const pointer = (type, y = 200, overrides = {}) => {
        const event = { type, pointerId: 1, clientX: 100, clientY: y, button: 0, target: handle, preventDefault() {}, ...overrides };
        header.dispatchEvent(event); return event;
    };
    const height = () => parseFloat(panel.style['--bottom-sheet-height']);
    const dragTo = value => {
        const y = 200 + height() - value;
        pointer('pointerdown'); pointer('pointermove', y); flush(); pointer('pointerup', y); flush();
        handle.dispatchEvent({ type: 'click', detail: 1, preventDefault() {} });
    };
    return { env, frames, compact, viewport, panel, header, handle, body, writes, sheet, pointer, flush, height, dragTo,
        setRow: next => { row = next; }, get observing() { return observing; } };
}

test('free heights only snap near the nearest endpoint, including short ranges', () => {
    for (const [value, expected] of [[0, 56], [73, 56], [75, 75], [300, 300], [581, 581], [583, 600], [900, 600]]) {
        assert.equal(settleSheetHeight(value, 56, 600), expected);
    }
    assert.equal(settleSheetHeight(68, 56, 70), 70);
    assert.equal(settleSheetHeight(58, 56, 70), 56);
});

test('desktop initialization does not add layout writes, observation or frames', () => {
    const f = fixture({ mobile: false }); f.sheet.setOpen(true);
    assert.deepEqual(f.writes, []); assert.equal(f.frames.size, 0); assert.equal(f.observing, false);
    assert.equal(f.panel.classList.contains('bottom-sheet-ready'), false);
    f.sheet.dispose();
});

test('opening docks above the playback row and remains idle at rest', () => {
    const f = fixture(); f.sheet.setOpen(true);
    assert.equal(f.height(), 844 * .7);
    assert.equal(f.panel.style['--bottom-sheet-bottom'], '94px');
    assert.equal(f.handle.getAttribute('aria-expanded'), 'true');
    assert.equal(f.body.inert, false); assert.equal(f.observing, true); assert.equal(f.frames.size, 0);
    f.sheet.dispose();
});

test('the default opening height fits short content and is stable across viewport updates', () => {
    const f = fixture(); f.body.scrollHeight = 220; f.sheet.setOpen(true);
    assert.equal(f.height(), 276);
    f.viewport.dispatchEvent({ type: 'resize' }); assert.equal(f.frames.size, 1); f.flush();
    assert.equal(f.height(), 276); f.sheet.dispose();
});

test('arbitrary drag height survives click, close, and reopen without rebuilding content', () => {
    const f = fixture(); const input = new FakeElement(); input.value = '123.456'; f.body.appendChild(input);
    f.sheet.setOpen(true); f.dragTo(321.5);
    assert.equal(f.height(), 321.5); assert.equal(f.frames.size, 0);
    assert.equal(f.panel.classList.contains('bottom-sheet-collapsed'), false);
    f.body.scrollTop = 137; f.sheet.setOpen(false);
    assert.equal(f.observing, false); assert.equal(f.frames.size, 0);
    f.sheet.setOpen(true);
    assert.equal(f.height(), 321.5); assert.equal(f.body.children[0], input);
    assert.equal(input.value, '123.456'); assert.equal(f.body.scrollTop, 137);
    f.sheet.dispose();
});

test('many pointer moves coalesce into one height write per frame', () => {
    const f = fixture(); f.sheet.setOpen(true); f.pointer('pointerdown');
    const before = f.writes.length;
    for (let i = 0; i < 100; i++) f.pointer('pointermove', 210 + i);
    assert.equal(f.frames.size, 1); assert.equal(f.writes.length, before);
    f.flush(); assert.equal(f.writes.length, before + 1);
    f.pointer('pointerup', 309); f.flush(); assert.equal(f.frames.size, 0);
    f.sheet.dispose();
});

test('collapse makes only the body inert and a keyboard click restores the last expanded height', () => {
    const f = fixture(); f.sheet.setOpen(true); f.dragTo(400);
    f.handle.dispatchEvent({ type: 'click', detail: 0 }); f.flush();
    assert.equal(f.height(), 56); assert.equal(f.body.inert, true);
    assert.equal(f.handle.getAttribute('aria-expanded'), 'false');
    assert.equal(f.panel.inert, undefined);
    f.handle.dispatchEvent({ type: 'click', detail: 0 }); f.flush();
    assert.equal(f.height(), 400); assert.equal(f.body.inert, false);
    f.sheet.dispose();
});

for (const type of ['pointercancel', 'lostpointercapture']) {
    test(`${type} restores the pre-gesture height and clears queued writes`, () => {
        const f = fixture(); f.sheet.setOpen(true); f.dragTo(390);
        f.pointer('pointerdown'); f.pointer('pointermove', 300); f.flush();
        assert.notEqual(f.height(), 390);
        if (type === 'pointercancel') f.pointer(type, 300);
        else f.handle.dispatchEvent({ type, pointerId: 1 });
        assert.equal(f.height(), 390); assert.equal(f.frames.size, 0);
        f.sheet.dispose();
    });
}

test('unrelated pointers, right click and the close button cannot start a drag', () => {
    const f = fixture(); f.sheet.setOpen(true); const initial = f.height();
    f.pointer('pointerdown', 200, { button: 2 }); f.pointer('pointermove', 400); f.flush();
    assert.equal(f.height(), initial);
    f.pointer('pointerdown', 200, { target: { closest: () => ({}) } }); f.pointer('pointermove', 400); f.flush();
    assert.equal(f.height(), initial);
    f.pointer('pointerdown'); f.pointer('pointermove', 400, { pointerId: 2 }); f.flush();
    assert.equal(f.height(), initial); f.pointer('pointercancel');
    f.sheet.dispose();
});

test('visual viewport changes clamp temporarily and restore the chosen height after keyboard dismissal', () => {
    const f = fixture(); f.sheet.setOpen(true); f.dragTo(400);
    f.viewport.height = 360; f.viewport.dispatchEvent({ type: 'resize' }); f.flush();
    assert.ok(Math.abs(f.height() - 252) < .001); assert.equal(f.panel.style['--bottom-sheet-bottom'], '496px');
    f.viewport.height = 844; f.viewport.dispatchEvent({ type: 'resize' }); f.flush();
    assert.equal(f.height(), 400); assert.equal(f.panel.style['--bottom-sheet-bottom'], '94px');
    f.sheet.dispose();
});

test('a playback row outside the visible viewport uses an on-screen bottom margin', () => {
    const f = fixture(); f.setRow({ top: 1200, bottom: 1252 }); f.sheet.setOpen(true);
    assert.equal(f.panel.style['--bottom-sheet-bottom'], '12px');
    assert.equal(f.height(), 844 * .7); f.sheet.dispose();
});

test('short landscape sheets keep the grip and close button below the toolbar', () => {
    const f = fixture({ toolbarBottom: 52 });
    f.env.innerHeight = f.viewport.height = 390;
    f.setRow({ top: 294, bottom: 366 }); f.sheet.setOpen(true);
    assert.equal(f.height(), 224); assert.equal(f.panel.style['--bottom-sheet-bottom'], '106px');
    assert.equal(390 - 106 - f.height(), 60); f.sheet.dispose();
});

test('switching to desktop restores its CSS and switching back restores the chosen mobile height', () => {
    const f = fixture(); f.sheet.setOpen(true); f.dragTo(350);
    f.compact.matches = false; f.compact.dispatchEvent({ type: 'change' });
    assert.equal(f.panel.classList.contains('bottom-sheet-ready'), false);
    assert.equal(f.panel.style['--bottom-sheet-height'], undefined); assert.equal(f.body.inert, false);
    assert.equal(f.observing, false);
    f.compact.matches = true; f.compact.dispatchEvent({ type: 'change' });
    assert.equal(f.height(), 350); assert.equal(f.observing, true); f.sheet.dispose();
});

test('backgrounding, closing during a drag, and disposal leave no pending frames or viewport listeners', () => {
    const f = fixture(); f.sheet.setOpen(true);
    f.pointer('pointerdown'); f.pointer('pointermove', 300);
    f.env.document.hidden = true; f.env.document.dispatchEvent({ type: 'visibilitychange' });
    assert.equal(f.frames.size, 0);
    f.env.document.hidden = false; f.env.document.dispatchEvent({ type: 'visibilitychange' }); f.flush();
    f.pointer('pointerdown'); f.pointer('pointermove', 300); f.sheet.setOpen(false);
    assert.equal(f.frames.size, 0); assert.equal(f.viewport.listeners.get('resize').size, 0);
    f.sheet.dispose();
    assert.equal(f.header.listeners.get('pointerdown').size, 0); assert.equal(f.handle.listeners.get('click').size, 0);
    assert.equal(f.compact.listeners.get('change').size, 0); assert.equal(f.observing, false);
});

test('initialization is idempotent and focus adjustment only scrolls the sheet body', () => {
    const f = fixture(); f.sheet.initialize();
    assert.equal(f.header.listeners.get('pointerdown').size, 1);
    f.sheet.setOpen(true);
    const input = new FakeElement(); input.matches = () => true;
    input.getBoundingClientRect = () => ({ top: 270, bottom: 310 });
    f.body.getBoundingClientRect = () => ({ top: 120, bottom: 280 });
    f.body.appendChild(input); f.env.document.activeElement = input;
    f.body.dispatchEvent({ type: 'focusin' }); f.flush();
    assert.equal(f.body.scrollTop, 38); f.sheet.dispose();
});

test('analysis and loop drawers keep their own height, labels and collapsed state', () => {
    const analysis = fixture(), loop = fixture({ label: '循环设定' });
    analysis.sheet.setOpen(true); analysis.dragTo(340); analysis.sheet.setOpen(false);
    loop.sheet.setOpen(true); loop.dragTo(220);
    assert.equal(loop.handle.title, '收拢循环设定');
    loop.handle.dispatchEvent({ type: 'click', detail: 0 }); loop.flush();
    assert.equal(loop.height(), 56); assert.equal(loop.handle.title, '展开循环设定');
    analysis.sheet.setOpen(true); assert.equal(analysis.height(), 340);
    assert.equal(analysis.handle.title, '收拢智能分析'); assert.equal(analysis.body.inert, false);
    loop.sheet.setOpen(false); loop.sheet.setOpen(true); assert.equal(loop.height(), 56);
    analysis.sheet.dispose(); loop.sheet.dispose();
});
