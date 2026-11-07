import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrackHeaderLayout } from '../src/ui/track-header.js';
import { FakeElement } from './helpers/host.mjs';

function fixture() {
    const title = new FakeElement(), header = new FakeElement(), frame = new FakeElement(), toolbar = new FakeElement();
    const doc = new FakeElement(), environment = new FakeElement(), desktop = new FakeElement(), observed = [];
    let top = 100, callback, writes = 0, disconnected = false;
    title.offsetHeight = 62.4; title.closest = () => header; header.parentElement = frame;
    header.style = { setProperty(name, value) { this[name] = value; writes++; }, removeProperty(name) { delete this[name]; } };
    frame.getBoundingClientRect = () => ({ top }); toolbar.offsetTop = 20; toolbar.offsetHeight = 40;
    doc.hidden = false; doc.fonts = new FakeElement(); doc.querySelector = () => toolbar;
    desktop.matches = true; environment.matchMedia = () => desktop;
    environment.getComputedStyle = () => ({ lineHeight: '62.4px' });
    environment.ResizeObserver = class {
        constructor(fn) { callback = fn; }
        observe(node) { observed.push(node); }
        disconnect() { disconnected = true; }
    };
    const view = createTrackHeaderLayout(title, { environment, document: doc });
    return { title, header, frame, toolbar, doc, environment, desktop, observed, view,
        notify: () => callback(), setTop: value => { top = value; },
        lift: () => header.style['--track-header-lift'], writes: () => writes, disconnected: () => disconnected };
}

test('desktop lifts a wrapped title and its information block by ten pixels, not single-line titles', () => {
    const f = fixture(); assert.equal(f.lift(), '0px');
    f.title.offsetHeight = 124.8; f.notify(); assert.equal(f.lift(), '10px');
    const writes = f.writes(); f.notify(); f.notify(); assert.equal(f.writes(), writes);
    f.title.offsetHeight = 62.4; f.notify(); assert.equal(f.lift(), '0px');
    assert.deepEqual(f.observed, [f.title, f.frame, f.toolbar]); f.view.dispose();
});

test('header lift respects the toolbar gap and updates on position-only window resizing', () => {
    const f = fixture(); f.title.offsetHeight = 124.8;
    f.setTop(73); f.environment.dispatchEvent({type: 'resize'}); assert.equal(f.lift(), '5px');
    f.setTop(65); f.environment.dispatchEvent({type: 'resize'}); assert.equal(f.lift(), '0px');
    f.setTop(100); f.environment.dispatchEvent({type: 'resize'}); assert.equal(f.lift(), '10px');
    f.view.dispose();
});

test('mobile and hidden pages do not acquire a desktop lift, and disposal removes work', () => {
    const f = fixture(); f.title.offsetHeight = 124.8;
    f.doc.hidden = true; f.notify(); assert.equal(f.lift(), '0px');
    f.doc.hidden = false; f.doc.dispatchEvent({type: 'visibilitychange'}); assert.equal(f.lift(), '10px');
    f.desktop.matches = false; f.desktop.dispatchEvent({type: 'change'}); assert.equal(f.lift(), '0px');
    f.view.dispose(); const writes = f.writes();
    f.desktop.matches = true; f.notify(); f.environment.dispatchEvent({type:'resize'});
    assert.equal(f.writes(), writes); assert.equal(f.lift(), undefined); assert.equal(f.disconnected(), true);
});
