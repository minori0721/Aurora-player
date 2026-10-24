import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAuth } from '../src/netease/account.js';
import { LOGIN_TIMEOUT_MS } from '../src/netease/login.js';
import { createHost } from './helpers/host.mjs';

const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

function fixture(t) {
    const { host, elements, timers } = createHost(html), handlers = new Map(), requests = [], mutations = [];
    host.localStorage.setItem('netease_cookie', 'MUSIC_U=synthetic');
    const globals = { window: host, document: host.document, localStorage: host.localStorage,
        fetch: async (url, options) => {
            const path = new URL(url).pathname; requests.push({ path, options });
            if (handlers.has(path)) return handlers.get(path)(options);
            if (path === '/login/status') return response({ data: { code: 200, profile: { userId: 123, nickname: 'Synthetic' } } });
            return response({ data: { redVipLevel: 1 } });
        } };
    const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    const change = () => mutations.push('auth-change');
    const playback = { currentAbortController: new AbortController(), playbackState: { status: 'loading' }, setPlaybackStatus: change };
    const browser = { musicBrowserState: {}, renderMusicRoute() {} };
    const dom = { qualitySelect: elements.get('netease-quality-select'), neteasePanel: elements.get('netease-panel') };
    const auth = createAuth({ api: { buildApiUrl: path => 'https://api.test' + path }, browser, dom, playback,
        content: { clearMusicImages() {} },
        download: { cancelDownloadProbes: change }, onlinePlaylist: { cancelPlaylistLoad: change },
        prefetch: { cancelNextPreload: change, resetNeteaseDetailPrefetchState: change },
        cache: { clearAccountJsonCache: change, purgeSensitiveIdbCache: async () => {} },
        resolver: { clearNeteaseResolvedAudioCache: change }, myPlaylists: { myPlaylistsLoadToken: 0 }, debug: { log() {} } });
    t.after(async () => {
        for (const controller of auth.accountAbortControllers) controller.abort();
        await flush();
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });
    const expire = async () => {
        for (const [id, timer] of [...timers]) if (timer.delay === LOGIN_TIMEOUT_MS) { timers.delete(id); timer.callback(); }
        await flush();
    };
    return { auth, host, dom, playback, elements, requests, mutations, timers, expire, on: (path, handler) => handlers.set(path, handler) };
}

test('restored identity is usable before VIP replies and never cancels audio loading', async t => {
    const f = fixture(t); f.on('/vip/info', () => new Promise(() => {}));
    f.auth.initialize(); await flush(); await flush();
    assert.equal(f.auth.neteaseUser.userId, 123); assert.equal(f.auth.authGeneration, 0);
    assert.equal(f.elements.get('netease-user-bar').style.display, 'flex');
    assert.match(f.elements.get('netease-user-type').textContent, /查询中/);
    assert.equal(f.playback.currentAbortController.signal.aborted, false); assert.deepEqual(f.mutations, []);
    assert.equal(f.auth.accountAbortControllers.size, 1);
    await f.expire();
    assert.equal(f.auth.accountAbortControllers.size, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.auth.neteaseUser.userId, 123); assert.match(f.elements.get('netease-user-type').textContent, /暂不可用/);
});

test('account deadlines cover response bodies, abort transport and keep saved login on timeout', async t => {
    const f = fixture(t); f.on('/login/status', () => ({ ok: true, json: () => new Promise(() => {}) }));
    f.auth.initialize(); await flush(); await f.expire();
    assert.equal(f.requests[0].options.signal.aborted, true);
    assert.equal(f.auth.accountAbortControllers.size, 0);
    assert.equal(f.host.localStorage.getItem('netease_cookie'), 'MUSIC_U=synthetic');
    assert.equal(f.requests.length, 1); assert.equal(f.auth.neteaseUser, null);
});

test('a stalled VIP body cannot block the restored account or leak an active request', async t => {
    const f = fixture(t); f.on('/vip/info', () => ({ ok: true, json: () => new Promise(() => {}) }));
    f.auth.initialize(); await flush(); await flush(); await f.expire();
    assert.equal(f.auth.neteaseUser.userId, 123); assert.equal(f.requests.at(-1).options.signal.aborted, true);
    assert.equal(f.auth.accountAbortControllers.size, 0); assert.equal(f.timers.size, 0);
});

test('late VIP results after logout cannot restore a badge or change quality', async t => {
    const f = fixture(t), pending = deferred(); f.on('/vip/info', () => pending.promise);
    f.auth.initialize(); await flush(); await flush(); await f.auth.neteaseLogout();
    pending.resolve(response({ data: { redVipLevel: 9 } })); await flush();
    assert.equal(f.auth.neteaseUser, null); assert.equal(f.auth.neteaseCookie, '');
    assert.equal(f.elements.get('netease-user-bar').style.display, 'none');
    assert.equal(f.auth.neteaseQuality, 'exhigh'); assert.equal(f.auth.accountAbortControllers.size, 0);
});

test('late login status after logout cannot restore an old identity', async t => {
    const f = fixture(t), pending = deferred(); f.on('/login/status', () => pending.promise);
    f.auth.initialize(); await f.auth.neteaseLogout();
    pending.resolve(response({ data: { profile: { userId: 123 } } })); await flush();
    assert.equal(f.auth.neteaseUser, null); assert.equal(f.requests.length, 1);
});

test('VIP completion preserves the quality selected while the query was pending', async t => {
    const f = fixture(t), pending = deferred(); f.on('/vip/info', () => pending.promise);
    f.auth.initialize(); await flush(); await flush();
    f.host.localStorage.setItem('netease_quality', 'hires'); f.dom.qualitySelect.value = 'hires';
    pending.resolve(response({ data: { redVipLevel: 9 } })); await flush();
    assert.equal(f.auth.neteaseQuality, 'hires'); assert.equal(f.dom.qualitySelect.value, 'hires');
    assert.equal(f.elements.get('netease-user-type').textContent, 'SVIP会员'); assert.deepEqual(f.mutations, []);
});

test('malformed profiles never restore an identity or request VIP data', async t => {
    const f = fixture(t); f.on('/login/status', () => response({ data: { profile: { userId: 'bad' } } }));
    f.auth.initialize(); await flush(); await flush();
    assert.equal(f.auth.neteaseUser, null); assert.equal(f.requests.length, 1);
});
