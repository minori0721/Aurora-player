import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEffectsMenu } from '../src/ui/effects-menu.js';
import { FakeElement } from './helpers/host.mjs';

const names = { none: '无特效', snow: '凛冬飞雪', bars: '律动频谱', waves: '极光波浪' };
function fixture() {
    const ids = ['effect-menu', 'effect-menu-trigger', 'effect-current-label', 'effect-current-icon',
        ...Object.keys(names).flatMap(mode => [`effect-option-${mode}`, `effect-icon-${mode}`])];
    const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
    const document = new FakeElement(), compact = new FakeElement(), select = new FakeElement();
    document.hidden = false; compact.matches = false; select.hidden = false; select.value = 'none';
    document.getElementById = id => elements.get(id);
    const menu = elements.get('effect-menu'), trigger = elements.get('effect-menu-trigger');
    menu.hidden = true; menu.open = false;
    menu.children.push(trigger);
    let focused = 0, changes = 0;
    trigger.focus = () => { focused++; document.activeElement = trigger; };
    for (const mode of Object.keys(names)) {
        const input = elements.get(`effect-option-${mode}`);
        input.value = mode; menu.children.push(input);
        elements.get(`effect-icon-${mode}`).cloneNode = () => Object.assign(new FakeElement(), { mode });
    }
    select.addEventListener('change', () => { changes++; });
    const controller = createEffectsMenu({ select, env: { document, Event, matchMedia: () => compact } });
    controller.initialize();
    return { controller, select, document, compact, menu, trigger, elements,
        get changes() { return changes; }, get focused() { return focused; },
        input: mode => elements.get(`effect-option-${mode}`),
        label: elements.get('effect-current-label'), icon: elements.get('effect-current-icon') };
}

test('effects enhance the native select without changing its value or dispatching a renderer event', () => {
    const f = fixture();
    assert.equal(f.select.value, 'none'); assert.equal(f.changes, 0);
    assert.equal(f.select.hidden, true); assert.equal(f.menu.hidden, false);
    assert.equal(f.label.textContent, names.none); assert.equal(f.input('none').checked, true);
});

test('each effect selects its own SVG and emits only one change for a native click/change pair', () => {
    const f = fixture();
    for (const [index, mode] of ['snow', 'bars', 'waves', 'none'].entries()) {
        f.menu.open = true; f.input(mode).click(); f.input(mode).dispatchEvent({ type: 'change' });
        assert.equal(f.select.value, mode); assert.equal(f.changes, index + 1);
        assert.equal(f.label.textContent, names[mode]); assert.equal(f.icon.children.length, 1);
        assert.equal(f.icon.children[0].mode, mode); assert.equal(f.menu.open, false);
        assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
    }
    assert.equal(f.focused, 4);
    f.input('none').click(); assert.equal(f.changes, 4);
});

test('native/mobile changes synchronize the menu while arrow selection stays open until confirmation', () => {
    const f = fixture(); f.select.value = 'waves'; f.select.dispatchEvent({ type: 'change' });
    assert.equal(f.input('waves').checked, true); assert.equal(f.label.textContent, names.waves);
    f.menu.open = true; f.input('snow').dispatchEvent({ type: 'change' });
    assert.equal(f.select.value, 'snow'); assert.equal(f.menu.open, true);
    f.input('snow').dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
    assert.equal(f.menu.open, false); assert.equal(f.focused, 1);
});

test('the synthetic click from native arrow navigation does not close the effect picker', () => {
    const f = fixture(); f.menu.open = true;
    f.input('none').dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
    f.input('snow').dispatchEvent({ type: 'click', detail: 0 });
    f.input('snow').dispatchEvent({ type: 'change' });
    assert.equal(f.select.value, 'snow'); assert.equal(f.menu.open, true);
    assert.equal(f.changes, 1);
    f.input('snow').dispatchEvent({ type: 'keyup', key: 'ArrowDown' });
    f.input('snow').dispatchEvent({ type: 'click', detail: 0 });
    assert.equal(f.menu.open, false);
    assert.equal(f.changes, 1);
});

test('Escape restores focus without affecting the selected effect or outside keyboard actions', () => {
    const f = fixture(); f.menu.open = true;
    let prevented = 0, stopped = 0;
    f.document.dispatchEvent({ type: 'keydown', key: 'Escape', target: f.input('none'),
        preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
    assert.equal(f.menu.open, false); assert.equal(f.focused, 1);
    assert.equal(prevented, 1); assert.equal(stopped, 1); assert.equal(f.changes, 0);
    f.menu.open = true;
    f.document.dispatchEvent({ type: 'keydown', key: 'Escape', target: new FakeElement() });
    assert.equal(f.menu.open, true);
});

test('outside clicks, focus leaving, backgrounding and switching to mobile dismiss the menu', () => {
    const f = fixture();
    for (const dismiss of [
        () => f.document.dispatchEvent({ type: 'click', target: new FakeElement() }),
        () => f.menu.dispatchEvent({ type: 'focusout', relatedTarget: new FakeElement() }),
        () => { f.document.hidden = true; f.document.dispatchEvent({ type: 'visibilitychange' }); },
        () => { f.compact.matches = true; f.compact.dispatchEvent({ type: 'change' }); }
    ]) { f.menu.open = true; dismiss(); assert.equal(f.menu.open, false); }
    assert.equal(f.changes, 0); assert.equal(f.focused, 0);
});

test('effect enhancement initializes once and disposal restores the native fallback', () => {
    const f = fixture(); f.controller.initialize();
    assert.equal(f.input('snow').listeners.get('click').size, 1);
    f.controller.dispose();
    assert.equal(f.select.hidden, false); assert.equal(f.menu.hidden, true);
    assert.equal(f.document.listeners.get('click').size, 0);
    f.input('snow').click(); assert.equal(f.select.value, 'none');
});

test('desktop controls preserve the original corner radius and keep lyric modes in the playback row', () => {
    const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
    const base = fs.readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
    const css = fs.readFileSync(new URL('../src/styles/controls.css', import.meta.url), 'utf8');
    assert.match(base, /\.glass-btn\s*\{[^}]*border-radius:\s*20px/);
    assert.doesNotMatch(css, /\.top-bar \.glass-btn\s*\{[^}]*min-height:\s*44px/);
    assert.match(css, /\.top-bar \.glass-btn\s*\{[^}]*height:\s*38px/);
    assert.ok(html.indexOf('id="lyric-toggle-btn"') > html.indexOf('id="download-btn"'));
    for (const mode of Object.keys(names)) assert.match(html, new RegExp(`<svg id="effect-icon-${mode}"[^>]*aria-hidden="true"`));
});
