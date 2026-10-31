import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createQueueFeedback } from '../src/netease/queue-feedback.js';
import { FakeElement } from './helpers/host.mjs';

function fixture() {
    const element = new FakeElement(), document = new FakeElement(), timers = new Map();
    const state = { active: true, reduced: false };
    let now = 0, sequence = 0;
    document.hidden = false;
    const feedback = createQueueFeedback({ element, isActive: () => state.active, env: {
        document, matchMedia: () => ({ matches: state.reduced }),
        setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, due: now + delay }); return id; },
        clearTimeout: id => timers.delete(id)
    } });
    feedback.initialize();
    function advance(ms) {
        const end = now + ms;
        while (true) {
            const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
            if (!next || next[1].due > end) break;
            now = next[1].due; timers.delete(next[0]); next[1].callback();
        }
        now = end;
    }
    return { feedback, element, document, timers, state, advance };
}

test('queue feedback stays visible for three seconds and clears after the short fade', () => {
    const f = fixture(); f.feedback.show('已设为下一首');
    assert.equal(f.element.textContent, '已设为下一首');
    f.advance(2999); assert.equal(f.element.classList.contains('show'), true);
    f.advance(1); assert.equal(f.element.classList.contains('show'), false);
    assert.equal(f.element.textContent, '已设为下一首');
    f.advance(150); assert.equal(f.element.textContent, ''); assert.equal(f.timers.size, 0);
});

test('repeated actions replace the message and restart one expiry timer', () => {
    const f = fixture(); f.feedback.show('已设为下一首'); f.advance(2500);
    f.feedback.show('已加入 12 首歌曲');
    assert.equal(f.timers.size, 1); f.advance(2999);
    assert.equal(f.element.textContent, '已加入 12 首歌曲');
    assert.equal(f.element.classList.contains('show'), true);
    f.advance(151); assert.equal(f.element.textContent, '');
});

test('a stale expiry or fade callback cannot erase or hide a newer action', () => {
    const f = fixture(); f.feedback.show('first');
    const oldExpiry = [...f.timers.values()][0].callback;
    f.advance(3000);
    const oldFade = [...f.timers.values()][0].callback;
    f.feedback.show('second'); oldExpiry(); oldFade();
    assert.equal(f.element.textContent, 'second');
    assert.equal(f.element.classList.contains('show'), true); assert.equal(f.timers.size, 1);
    f.advance(3150); assert.equal(f.element.textContent, '');
});

test('explicit clear cancels both visible and fading feedback without leaving a timer', () => {
    for (const elapsed of [0, 3000]) {
        const f = fixture(); f.feedback.show('first'); f.advance(elapsed);
        const old = [...f.timers.values()][0].callback;
        f.feedback.clear(); assert.equal(f.element.textContent, '');
        assert.equal(f.element.classList.contains('show'), false); assert.equal(f.timers.size, 0);
        f.feedback.show('second'); old();
        assert.equal(f.element.textContent, 'second');
    }
});

test('entering the background clears feedback and returning cannot replay it', () => {
    const f = fixture(); f.feedback.show('first'); f.document.hidden = true;
    f.document.dispatchEvent({ type: 'visibilitychange' });
    assert.equal(f.element.textContent, ''); assert.equal(f.timers.size, 0);
    f.feedback.show('hidden action'); assert.equal(f.timers.size, 0);
    f.document.hidden = false; f.document.dispatchEvent({ type: 'visibilitychange' });
    assert.equal(f.element.textContent, '');
});

test('empty messages and inactive music panels do not display or schedule feedback', () => {
    const f = fixture(); f.feedback.show(''); assert.equal(f.timers.size, 0);
    f.state.active = false; f.feedback.show('action');
    assert.equal(f.element.textContent, ''); assert.equal(f.timers.size, 0);
});

test('reduced motion skips the fading timer and clears at the expiry deadline', () => {
    const f = fixture(); f.state.reduced = true; f.feedback.show('action'); f.advance(3000);
    assert.equal(f.element.textContent, ''); assert.equal(f.timers.size, 0);
});

test('initialization is idempotent and disposal releases the listener and timer', () => {
    const f = fixture(); f.feedback.initialize();
    assert.equal(f.document.listeners.get('visibilitychange').size, 1);
    f.feedback.show('action'); f.feedback.dispose();
    assert.equal(f.timers.size, 0); assert.equal(f.document.listeners.get('visibilitychange').size, 0);
    assert.equal(f.element.textContent, '');
});

test('feedback uses an atomic live region and a zero-height, non-interactive overlay', () => {
    const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
    const css = fs.readFileSync(new URL('../src/styles/music.css', import.meta.url), 'utf8');
    assert.match(html, /id="music-queue-feedback"[^>]*role="status"[^>]*aria-atomic="true"/);
    assert.match(css, /\.music-queue-feedback-anchor\s*\{[^}]*flex:\s*0 0 0[^}]*pointer-events:\s*none/);
    assert.match(css, /\.music-queue-feedback\s*\{[^}]*position:\s*absolute[^}]*pointer-events:\s*none/);
});
