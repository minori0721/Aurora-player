import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBrowser } from '../src/netease/navigation.js';
import { createHost } from './helpers/host.mjs';

const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('music browser reserves its mini player in flex layout instead of covering the scrollbar', () => {
    const css = fs.readFileSync(new URL('../src/styles/music.css', import.meta.url), 'utf8');
    const mini = css.match(/\.music-mini-player\s*\{([^}]+)\}/)[1];
    assert.match(mini, /position:\s*relative/); assert.match(mini, /flex:\s*0 0 auto/);
    assert.doesNotMatch(mini, /position:\s*(absolute|fixed)/);
    assert.match(css, /\.netease-browser-scroll\s*\{[^}]*min-height:\s*0/);
    assert.doesNotMatch(css, /padding:[^;}]*\b(?:90|96)px/);
});

function fixture(t) {
    const { host, elements, frames } = createHost(html), scroller = { scrollTop: 540 };
    const imageLifecycle = [];
    host.location.href = 'http://localhost/#music/album/12'; host.location.hash = '#music/album/12';
    const panel = elements.get('netease-panel'); panel.classList.add('show');
    host.history.length = 2; host.history.go = () => {};
    host.history.state = { auroraMusic: { sessionId: 'synthetic', depth: 0, hasParentEntry: true, scrollTop: 0 } };
    const writeHistory = (value, _, url) => {
        host.history.state = value;
        if (url) { host.location.href = url; host.location.hash = new URL(url).hash; }
    };
    host.history.replaceState = writeHistory; host.history.pushState = writeHistory;
    const globals = { window: host, document: host.document, history: host.history, sessionStorage: host.sessionStorage,
        requestAnimationFrame: host.requestAnimationFrame };
    const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => {
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });
    const browser = createBrowser({
        dom: { neteasePanel: panel, neteaseBrowserScroll: scroller, neteasePageTitle: elements.get('netease-page-title'), neteaseTabs: [],
            neteaseBrowserView: elements.get('netease-browser-view'), searchBtn: elements.get('netease-search-btn'), searchInput: elements.get('netease-search-input') },
        auth: { cancelLoginSession() { browser.musicBrowserState.authReturnContext = null; browser.musicBrowserState.authReturnHash = ''; } },
        panels: { modalController: { open() { panel.classList.add('show'); }, close() { panel.classList.remove('show'); } } },
        content: { async renderMusicAlbumPage() {}, updateMusicMiniPlayer() {},
            clearMusicImages() { imageLifecycle.push('clear'); }, pauseMusicImages() { imageLifecycle.push('pause'); },
            resumeMusicImages() { imageLifecycle.push('resume'); } }
    });
    const paint = async () => { await flush(); for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } };
    return { host, scroller, browser, panel, elements, paint, imageLifecycle };
}

test('saving history while login is open preserves the source page instead of the login scroll', t => {
    const f = fixture(t);
    f.browser.musicBrowserState.authReturnContext = { hash: '#music/album/12', scrollTop: 540 };
    f.scroller.scrollTop = 0; f.browser.saveMusicScrollState();
    assert.equal(f.host.history.state.auroraMusic.scrollTop, 540);
    f.browser.musicBrowserState.authReturnContext = { hash: '#music/album/13', scrollTop: 900 };
    f.scroller.scrollTop = 180; f.browser.saveMusicScrollState();
    assert.equal(f.host.history.state.auroraMusic.scrollTop, 180);
});

test('return navigation stores restored position in history before rendering completes', async t => {
    const f = fixture(t);
    f.browser.musicBrowserState.authReturnContext = { hash: '#music/album/12', scrollTop: 540 };
    f.scroller.scrollTop = 0;
    f.browser.navigateMusic({ kind: 'album', id: 12 }, { replace: true, restoreScroll: 540 });
    assert.equal(f.host.history.state.auroraMusic.scrollTop, 540); await f.paint();
    assert.equal(f.scroller.scrollTop, 540);
    assert.equal(f.browser.musicBrowserState.authReturnContext, null);
});

test('closing login saves its source position before cancellation clears the journey', t => {
    const f = fixture(t);
    f.browser.musicBrowserState.authReturnContext = { hash: '#music/album/12', scrollTop: 540 };
    f.scroller.scrollTop = 0; f.browser.closeMusicBrowser();
    assert.equal(f.host.history.state.auroraMusic.scrollTop, 540);
    assert.equal(f.browser.musicBrowserState.authReturnContext, null); assert.equal(f.panel.classList.contains('show'), false);
});

test('closing a direct-link login and reopening restores its source scroll', async t => {
    const f = fixture(t); f.browser.initialize(); await f.paint();
    f.host.history.state.auroraMusic.hasParentEntry = false;
    f.browser.musicBrowserState.authReturnContext = { hash: '#music/album/12', scrollTop: 540 };
    f.scroller.scrollTop = 0; f.browser.closeMusicBrowser();
    assert.equal(f.host.location.hash, '');
    f.elements.get('toggle-netease-panel').onclick(); await f.paint();
    assert.equal(f.host.location.hash, '#music/album/12'); assert.equal(f.scroller.scrollTop, 540);
    assert.equal(f.host.history.state.auroraMusic.scrollTop, 540);
});

test('navigation clears old image subscriptions before resuming and closing releases them again', async t => {
    const f = fixture(t);
    await f.browser.renderMusicRoute({ kind: 'album', id: 12 });
    assert.deepEqual(f.imageLifecycle, ['clear', 'resume']);
    f.browser.closeMusicBrowser();
    assert.deepEqual(f.imageLifecycle.slice(-2), ['pause', 'clear']);
    await f.browser.renderMusicRoute(null);
    assert.deepEqual(f.imageLifecycle.slice(-2), ['pause', 'clear']);
});
