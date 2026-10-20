import test from 'node:test';
import assert from 'node:assert/strict';
import { createWordLyricMotion } from '../src/lyrics/word-motion.js';
import { FakeElement } from './helpers/host.mjs';

function fixture(t) {
    const doc = new FakeElement(), media = new FakeElement(), made = [];
    const clock = { audio: 1250, wall: 5000, frameAge: 0, playing: true, running: true, transport: 0 };
    doc.hidden = false; media.matches = false;
    doc.timeline = { get currentTime() { return clock.wall - clock.frameAge; } };
    let observe;
    const observed = new Set();
    const environment = { performance: { now: () => clock.wall }, matchMedia: () => media, IntersectionObserver: class {
        constructor(callback) { observe = callback; }
        observe(node) { observed.add(node); } unobserve(node) { observed.delete(node); } disconnect() { observed.clear(); }
    } };
    const row = (start = 1, spec = [[0, 500], [500, 500], [1000, 0]]) => {
        const line = new FakeElement(); line.dataset.time = start;
        for (const [offset, duration] of spec) {
            const node = new FakeElement(); node.className = 'yrc-char'; node.dataset.start = offset; node.dataset.dur = duration;
            node.animate = (keyframes, options) => {
                const animation = { keyframes, options, cancelled: false, startTime: clock.wall, override: null,
                    get currentTime() { return this.cancelled ? null : this.override ?? clock.wall - clock.frameAge - this.startTime; },
                    cancel() { this.cancelled = true; } };
                made.push(animation); return animation;
            };
            line.appendChild(node);
        }
        return line;
    };
    const motion = createWordLyricMotion(new FakeElement(), { document: doc, environment,
        getTime: () => clock.audio / 1000, isPlaying: () => clock.playing,
        isClockRunning: () => clock.running, getTransportVersion: () => clock.transport });
    t.after(() => motion.dispose());
    return { motion, clock, doc, media, made, row, observed, intersection: (target, isIntersecting) => observe([{ target, isIntersecting }]),
        advance(ms) { clock.wall += ms; if (clock.playing && clock.running) clock.audio += ms; } };
}

test('words start at the current audio phase immediately on one shared timeline without animation frames', t => {
    const f = fixture(t), line = f.row(); f.motion.activate(line);
    assert.equal(f.made.length, 2);
    assert.deepEqual(f.made.map(animation => animation.options.delay), [-250, 250]);
    assert.ok(f.made.every(animation => animation.startTime === 5000));
    assert.equal(f.made[0].currentTime - f.made[0].options.delay, 250);
    f.advance(100); f.motion.sync(); assert.equal(f.made.length, 2, 'continuous updates must not recreate animations');
});

test('pause freezes the exact phase; resume creates only unfinished words and preserves their timing', t => {
    const f = fixture(t), line = f.row(); f.motion.activate(line); f.advance(400);
    f.clock.playing = false; f.motion.sync();
    assert.ok(f.made.every(animation => animation.cancelled));
    assert.equal(line.children[0].style.backgroundPosition, '0.000% 0px');
    assert.equal(line.children[1].style.backgroundPosition, '70.000% 0px');
    f.advance(500); f.motion.sync(); assert.equal(line.children[1].style.backgroundPosition, '70.000% 0px');
    f.clock.playing = true; f.motion.sync();
    assert.equal(f.made.length, 3); assert.equal(f.made[2].options.delay, -150);
});

test('same-line seeks and backwards loop jumps re-anchor without old callbacks or delayed fills', t => {
    const f = fixture(t), line = f.row(); f.motion.activate(line);
    f.clock.audio = 1800; f.clock.transport++; f.motion.sync();
    assert.equal(f.made.at(-1).options.delay, -300);
    f.clock.audio = 1100; f.motion.sync();
    assert.equal(f.made.at(-2).options.delay, -100);
    assert.equal(f.made.at(-1).options.delay, 400);
});

test('hidden and offscreen lines release their animations and resume from current audio time', t => {
    const f = fixture(t), line = f.row(); f.motion.activate(line);
    f.intersection(line, false); assert.ok(f.made.every(animation => animation.cancelled));
    f.advance(500); f.motion.sync(); assert.equal(f.made.length, 2);
    f.intersection(line, true); assert.equal(f.made.at(-1).options.delay, -250);
    f.doc.hidden = true; f.doc.dispatchEvent({ type: 'visibilitychange' });
    assert.ok(f.made.every(animation => animation.cancelled));
    f.advance(500); f.doc.hidden = false; f.doc.dispatchEvent({ type: 'visibilitychange' });
    assert.equal(line.children[2].style.backgroundPosition, '0.000% 0px');
    assert.equal(f.made.length, 3, 'completed words need no new animation');
});

test('a suspended audio clock freezes and resuming re-aligns the same word', t => {
    const f = fixture(t), line = f.row(); f.motion.activate(line);
    f.clock.running = false; f.motion.sync(); f.advance(1000); f.motion.sync();
    assert.equal(line.children[0].style.backgroundPosition, '50.000% 0px');
    assert.ok(f.made.every(animation => animation.cancelled));
    f.clock.running = true; f.motion.sync(); assert.equal(f.made.at(-2).options.delay, -250);
});

test('reduced motion steps at real word starts without animations; restoring motion reuses the current phase', t => {
    const f = fixture(t), line = f.row(); f.media.matches = true; f.motion.activate(line);
    assert.equal(f.made.length, 0);
    assert.equal(line.children[0].style.backgroundPosition, '0.000% 0px');
    assert.equal(line.children[1].style.backgroundPosition, '100.000% 0px');
    f.advance(300); f.motion.sync(); assert.equal(line.children[1].style.backgroundPosition, '0.000% 0px');
    f.media.matches = false; f.media.dispatchEvent({ type: 'change' });
    assert.equal(f.made.at(-1).options.delay, -50);
});

test('short durations are not extended and zero durations become complete at their exact boundary', t => {
    const f = fixture(t), line = f.row(1, [[250, 20], [270, 0]]); f.motion.activate(line);
    assert.equal(f.made.length, 1); assert.equal(f.made[0].options.duration, 20);
    f.advance(20); f.clock.playing = false; f.motion.sync();
    assert.ok(line.children.every(node => node.style.backgroundPosition === '0.000% 0px'));
});

test('reset, row replacement and stale observer events cannot retain old animations or inline color', t => {
    const f = fixture(t), first = f.row(), second = f.row(2); f.motion.activate(first); f.motion.activate(second);
    assert.ok(first.children.every(node => node.style.backgroundPosition === ''));
    const count = f.made.length; f.intersection(first, false); assert.equal(f.made.length, count);
    f.motion.reset(); assert.ok(f.made.every(animation => animation.cancelled));
    assert.equal(f.observed.size, 0); assert.ok(second.children.every(node => node.style.backgroundPosition === ''));
    f.doc.dispatchEvent({ type: 'visibilitychange' }); f.motion.sync(); assert.equal(f.made.length, count);
});

test('missing or failing Web Animations safely falls back to the existing update cadence', t => {
    const f = fixture(t), line = f.row(); line.children[0].animate = undefined;
    f.motion.activate(line); assert.equal(f.made.length, 0);
    assert.equal(line.children[0].style.backgroundPosition, '50.000% 0px');
    f.advance(100); f.motion.sync(); assert.equal(line.children[0].style.backgroundPosition, '30.000% 0px');
    const failing = f.row(); failing.children[0].animate = () => { throw new Error('unsupported property'); };
    assert.doesNotThrow(() => f.motion.activate(failing));
    assert.equal(failing.children[0].style.backgroundPosition, '30.000% 0px');
});

test('large animation-clock drift is corrected, normal clock jitter does not recreate the row', t => {
    const f = fixture(t), line = f.row(); f.motion.activate(line);
    f.made[0].override = 20; f.motion.sync(); assert.equal(f.made.length, 2);
    f.made[0].override = 100; f.motion.sync(); assert.equal(f.made.length, 4);
    assert.ok(f.made.slice(0, 2).every(animation => animation.cancelled));
});

test('a stale document frame does not shift the shared anchor or trigger false drift corrections', t => {
    const f = fixture(t), line = f.row(); f.clock.frameAge = 80; f.motion.activate(line);
    assert.ok(f.made.every(animation => animation.startTime === f.clock.wall));
    f.advance(100); f.motion.sync();
    assert.equal(f.made.length, 2, 'frame age is not audio-clock drift');
    f.clock.frameAge = 0; f.motion.sync();
    assert.equal(f.made.length, 2);
    assert.equal(f.made[0].currentTime - f.made[0].options.delay, 350);
});
