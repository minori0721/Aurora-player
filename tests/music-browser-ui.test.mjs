import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/styles/music.css', import.meta.url), 'utf8');
const block = selector => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `Missing ${selector}`);
    return css.slice(start, css.indexOf('}', start) + 1);
};

test('music primary tabs use an underline while search categories retain segmented selection', () => {
    assert.match(block('.netease-tab'), /background: transparent/);
    assert.doesNotMatch(block('.netease-tab'), /flex: 1|linear-gradient|box-shadow/);
    assert.match(block('.netease-tab.active::after'), /background: var\(--accent\)/);
    assert.match(block('.netease-search-kinds'), /padding: 3px; border-radius: var\(--music-radius\)/);
    assert.match(block('.netease-kind-btn.active'), /background: #fff/);
});

test('music commands share light or flat surfaces instead of independent gradients and lifting', () => {
    for (const selector of ['.netease-search-btn', '.netease-login-btn', '.netease-import-btn']) {
        assert.match(block(selector), /min-height: 44px/);
        assert.match(block(selector), /border-radius: var\(--music-radius\)/);
        assert.doesNotMatch(block(selector), /linear-gradient|box-shadow|translate/);
    }
    assert.match(block('.netease-login-btn'), /background: var\(--music-control-bg\)/);
    assert.match(block('.netease-search-btn'), /background: var\(--accent\)/);
});

test('real account and playback selectors keep their IDs, labels and option values in one settings group', () => {
    const preferences = html.slice(html.indexOf('<div class="netease-preferences">'), html.indexOf('<div class="netease-tabs"'));
    for (const id of ['netease-quality-select', 'playback-mode']) {
        assert.equal(html.split(`id="${id}"`).length - 1, 1);
        assert.ok(preferences.includes(`id="${id}"`));
        assert.ok(preferences.includes(`for="${id}"`));
    }
    for (const value of ['standard','higher','exhigh','lossless','hires','stream','complete']) assert.ok(preferences.includes(`value="${value}"`));
    assert.match(block('.netease-quality-select'), /appearance: none/);
    assert.match(css, /:is\([^)]*\.netease-select-wrap[^)]*\) svg\s*\{[^}]*pointer-events: none/);
});

test('music navigation and mini player use accessible inline icons without changing action targets', () => {
    for (const id of ['netease-nav-back','netease-nav-forward','netease-close','music-mini-artist','music-mini-play','music-mini-next']) {
        const start = html.indexOf(`id="${id}"`), button = html.slice(start, html.indexOf('</button>', start));
        assert.ok(start >= 0); assert.match(button, /aria-label=/);
        assert.match(button, /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
    }
    assert.match(css, /stroke-width: 1\.8/);
    assert.match(css, /stroke-linecap: round; stroke-linejoin: round; pointer-events: none/);
});

test('browser styling does not import prototype data or replace actual account and search bindings', () => {
    assert.doesNotMatch(html, /10086001|Aurora 试听账号|preview\.js|preview\.css/);
    for (const id of ['netease-user-bar','netease-nickname','netease-user-type','netease-user-id','netease-login-btn','netease-search-input','netease-search-btn']) {
        assert.equal(html.split(`id="${id}"`).length - 1, 1);
    }
    assert.match(block('.netease-preferences'), /min-width: 0/);
    assert.match(block('.netease-search-field'), /min-width: 0/);
    assert.match(css, /\.netease-preferences \{ flex: 1 1 100%; width: 100%/);
});
