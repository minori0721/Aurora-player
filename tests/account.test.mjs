import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAuth, VIP_REFRESH_INTERVAL_MS } from '../src/netease/account.js';
import { LOGIN_TIMEOUT_MS } from '../src/netease/login.js';
import { createHost } from './helpers/host.mjs';

const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

function fixture(t, cookie = 'MUSIC_U=synthetic') {
    const { host, elements, timers } = createHost(html), handlers = new Map(), requests = [], mutations = [];
    const state = { now: 1_800_000_000_000, playlistRefreshes: 0 };
    t.mock.method(Date, 'now', () => state.now);
    host.localStorage.setItem('netease_cookie', cookie);
    const globals = { window: host, document: host.document, localStorage: host.localStorage,
        fetch: async (url, options) => {
            const path = new URL(url).pathname; requests.push({ path, options });
            if (handlers.has(path)) return handlers.get(path)(options);
            if (path === '/login/status') return response({ data: { code: 200, profile: { userId: 123, nickname: 'Synthetic' } } });
            return response({ code: 200, data: { redVipLevel: 1, associator: { expireTime: state.now + 3600_000 } } });
        } };
    host.fetch = globals.fetch;
    const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    const change = () => mutations.push('auth-change'), resolverResets = [], prefetchResets = [];
    const playback = { currentAbortController: new AbortController(), playbackState: { status: 'loading' }, setPlaybackStatus: change };
    const browser = { musicBrowserState: {}, renderMusicRoute() {}, currentMusicNavigationIs: () => true,
        saveMusicScrollState() {}, navigateMusic() {} };
    const dom = { qualitySelect: elements.get('netease-quality-select'), neteasePanel: elements.get('netease-panel'),
        neteasePageTitle: elements.get('netease-page-title'), neteaseBrowserScroll: elements.get('netease-browser-scroll') };
    const auth = createAuth({ api: { buildApiUrl: path => 'https://api.test' + path }, browser, dom, playback,
        content: { clearMusicImages() {} },
        download: { cancelDownloadProbes: change }, onlinePlaylist: { cancelPlaylistLoad: change, refreshQueueSource() { state.playlistRefreshes++; } },
        prefetch: { cancelNextPreload: options => { prefetchResets.push(options); change(); }, resetNeteaseDetailPrefetchState: change },
        cache: { clearAccountJsonCache: change, purgeSensitiveIdbCache: async () => {} },
        resolver: { clearNeteaseResolvedAudioCache: options => { resolverResets.push(options); change(); } }, myPlaylists: { myPlaylistsLoadToken: 0 }, debug: { log() {} } });
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
    return { auth, host, dom, playback, elements, requests, mutations, timers, expire, state, resolverResets, prefetchResets,
        on: (path, handler) => handlers.set(path, handler) };
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
    pending.resolve(response({ code: 200, data: { redVipLevel: 9, redplus: { expireTime: f.state.now + 3600_000 } } })); await flush();
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

test('playlist identity waits share the initial login request and do not wait for VIP', async t => {
    const f = fixture(t), pending = deferred();
    f.on('/login/status', () => pending.promise);
    f.on('/vip/info', () => new Promise(() => {}));
    f.auth.initialize();
    const first = f.auth.waitForLoginStatus(), second = f.auth.waitForLoginStatus();
    assert.equal(f.auth.loginStatus, 'pending');
    assert.equal(first, second); assert.equal(f.requests.length, 1);
    pending.resolve(response({ data: { code: 200, profile: { userId: 123 } } }));
    assert.equal(await first, true);
    assert.equal(f.auth.loginStatus, 'authenticated');
    assert.equal(await f.auth.waitForLoginStatus(), true);
    assert.equal(f.requests.filter(request => request.path === '/login/status').length, 1);
    assert.equal(f.requests.filter(request => request.path === '/vip/info').length, 1);
});

test('failed identity checks are reused without silently requesting a guest list or retrying', async t => {
    const f = fixture(t);
    f.on('/login/status', () => response({ data: { code: 301, profile: { userId: 123 } } }));
    f.auth.initialize();
    assert.equal(await f.auth.waitForLoginStatus(), false);
    assert.equal(await f.auth.waitForLoginStatus(), false);
    assert.equal(f.auth.neteaseUser, null); assert.equal(f.requests.length, 1);
    assert.equal(f.auth.loginStatus, 'expired');
});

test('logout invalidates a pending shared identity result', async t => {
    const f = fixture(t), pending = deferred(); f.on('/login/status', () => pending.promise);
    f.auth.initialize(); const identity = f.auth.waitForLoginStatus();
    await f.auth.neteaseLogout();
    pending.resolve(response({ data: { profile: { userId: 123 } } }));
    assert.equal(await identity, false);
    assert.equal(await f.auth.waitForLoginStatus(), false);
    assert.equal(f.auth.neteaseUser, null); assert.equal(f.requests.length, 1);
    assert.equal(f.auth.loginStatus, 'guest');
});

test('login status distinguishes a missing account from network, firewall and service errors', async t => {
    const f = fixture(t); f.on('/login/status', () => response({ data: { code: 200, profile: null } }));
    f.auth.initialize(); assert.equal(await f.auth.waitForLoginStatus(), false);
    assert.equal(f.auth.loginStatus, 'expired');
});

for (const status of [403, 429, 500]) {
    test(`HTTP ${status} never becomes an expired identity`, async t => {
        const f = fixture(t); f.on('/login/status', () => new Response('unavailable', { status }));
        f.auth.initialize(); assert.equal(await f.auth.waitForLoginStatus(), false);
        assert.equal(f.auth.loginStatus, 'unavailable');
        assert.equal(f.auth.neteaseCookie, 'MUSIC_U=synthetic');
    });
}

test('HTTP 301 needs an API login error body before marking credentials expired', async t => {
    const f = fixture(t);
    f.on('/login/status', () => new Response(JSON.stringify({ code: 301 }), { status: 301, headers: { 'Content-Type': 'application/json' } }));
    f.auth.initialize(); assert.equal(await f.auth.waitForLoginStatus(), false);
    assert.equal(f.auth.loginStatus, 'expired');
});

test('a completed explicit login refreshes a linked playlist once using the new identity', async t => {
    const f = fixture(t, ''); f.host.matchMedia = () => ({ matches: true });
    f.on('/login/cellphone', () => response({ code: 200, cookie: 'MUSIC_U=new-synthetic' }));
    f.auth.initialize(); await f.auth.waitForLoginStatus();
    f.dom.neteasePanel.classList.add('show'); await f.auth.showLogin();
    f.elements.get('login-country').value = '86'; f.elements.get('login-phone').value = '13800138000';
    f.elements.get('login-captcha').value = '123456';
    await f.elements.get('sms-login-form').onsubmit({ preventDefault() {} });
    assert.equal(f.auth.loginStatus, 'authenticated'); assert.equal(f.auth.neteaseUser.userId, 123);
    assert.equal(f.state.playlistRefreshes, 1); assert.equal(await f.auth.waitForLoginStatus(), true);
    f.auth.cancelLoginSession();
});

test('VIP completion preserves the quality selected while the query was pending', async t => {
    const f = fixture(t), pending = deferred(); f.on('/vip/info', () => pending.promise);
    f.auth.initialize(); await flush(); await flush();
    f.host.localStorage.setItem('netease_quality', 'hires'); f.dom.qualitySelect.value = 'hires';
    pending.resolve(response({ code: 200, data: { redVipLevel: 9, redplus: { expireTime: f.state.now + 3600_000 } } })); await flush();
    assert.equal(f.auth.neteaseQuality, 'hires'); assert.equal(f.dom.qualitySelect.value, 'hires');
    assert.equal(f.elements.get('netease-user-type').textContent, 'SVIP会员'); assert.deepEqual(f.mutations, []);
});

test('malformed profiles never restore an identity or request VIP data', async t => {
    const f = fixture(t); f.on('/login/status', () => response({ data: { profile: { userId: 'bad' } } }));
    f.auth.initialize(); await flush(); await flush();
    assert.equal(f.auth.neteaseUser, null); assert.equal(f.requests.length, 1);
});

test('restored duplicate cookies migrate once before any account request', async t => {
    const f = fixture(t, 'MUSIC_U=old; ; Path=/; MUSIC_U=synthetic==; custom=a=b; HttpOnly');
    f.auth.initialize(); await flush(); await flush();
    const expected = 'MUSIC_U=synthetic==; custom=a=b';
    assert.equal(f.auth.neteaseCookie, expected);
    assert.equal(f.host.localStorage.getItem('netease_cookie'), expected);
    assert.equal(JSON.parse(f.requests[0].options.body).cookie, expected);
    assert.equal(f.auth.authGeneration, 0); assert.deepEqual(f.mutations, []);
});

test('an attribute-only stored cookie is removed without issuing an account request', async t => {
    const f = fixture(t, 'Secure; Path=/; ; HttpOnly'); f.auth.initialize(); await flush();
    assert.equal(f.auth.neteaseCookie, ''); assert.equal(f.host.localStorage.getItem('netease_cookie'), null);
    assert.equal(f.requests.length, 0);
});

for (const [name, data, text] of [
    ['expired membership with a retained level', { redVipLevel: 7, associator: { expireTime: 1 } }, '普通用户'],
    ['V7 with only a VIP plan', { redVipLevel: 7, associator: { expireTime: 1_900_000_000_000 } }, 'VIP会员'],
    ['SVIP with a low growth level', { redVipLevel: 0, redplus: { expireTime: 1_900_000_000_000 } }, 'SVIP会员'],
    ['an expired music package code', { musicPackage: { vipCode: 220, expireTime: 1 } }, '普通用户'],
    ['an active music package', { musicPackage: { vipCode: 220, expireTime: 1_900_000_000_000 } }, '音乐包'],
    ['membership fields missing from a response', { redVipLevel: 9 }, '会员状态暂不可用']
]) {
    test(`account badge uses current entitlements: ${name}`, async t => {
        const f = fixture(t); f.on('/vip/info', () => response({ code: 200, data }));
        f.auth.initialize(); await flush(); await flush();
        assert.equal(f.elements.get('netease-user-type').textContent, text);
        assert.equal(f.auth.neteaseUser.userId, 123);
    });
}

test('successful HTTP with an API error never becomes a valid member badge', async t => {
    const f = fixture(t); f.on('/vip/info', () => response({ code: 500, data: { redplus: { expireTime: f.state.now + 1000 } } }));
    f.auth.initialize(); await flush(); await flush();
    assert.equal(f.elements.get('netease-user-type').textContent, '会员状态暂不可用');
    assert.equal(f.auth.neteaseUser.userId, 123);
});

test('member refreshes are five-minute event-driven requests with one shared pending job', async t => {
    const f = fixture(t); f.auth.initialize(); await flush(); await flush();
    await f.auth.refreshVipInfo(); assert.equal(f.requests.length, 2);
    f.state.now += VIP_REFRESH_INTERVAL_MS;
    const pending = deferred(); f.on('/vip/info', () => pending.promise);
    const a = f.auth.refreshVipInfo(), b = f.auth.refreshVipInfo();
    assert.equal(a, b); assert.equal(f.requests.length, 3);
    pending.resolve(response({ code: 200, data: { associator: { expireTime: f.state.now + 3600_000 } } }));
    assert.equal(await a, true);
    assert.ok(f.requests.every(({ options }) => options.method === 'POST' && options.cache === 'no-store'));
    assert.equal(f.timers.size, 1);
    assert.deepEqual(f.mutations, []);
});

test('hidden pages do no member work and foreground/focus events share the due refresh', async t => {
    const f = fixture(t); f.auth.initialize(); f.auth.initialize(); await flush(); await flush();
    f.host.document.hidden = true; f.host.document.dispatchEvent({ type: 'visibilitychange' });
    assert.equal(f.timers.size, 0);
    f.state.now += VIP_REFRESH_INTERVAL_MS;
    f.host.document.dispatchEvent({ type: 'focus' }); assert.equal(f.requests.length, 2);
    f.host.document.hidden = false;
    f.host.document.dispatchEvent({ type: 'visibilitychange' }); f.host.document.dispatchEvent({ type: 'focus' });
    await flush(); await flush();
    assert.equal(f.requests.length, 3);
    assert.equal(f.host.document.listeners.get('visibilitychange').size, 1);
    assert.equal(f.host.document.listeners.get('focus').size, 1);
});

test('local expiry downgrades SVIP to remaining VIP without touching playback or a saved quality', async t => {
    const f = fixture(t), deadline = f.state.now + 1000;
    f.host.localStorage.setItem('netease_quality', 'hires');
    const data = { redplus: { expireTime: deadline }, associator: { expireTime: f.state.now + 3600_000 } };
    f.on('/vip/info', () => response({ code: 200, data }));
    f.auth.initialize(); await flush(); await flush();
    assert.equal(f.elements.get('netease-user-type').textContent, 'SVIP会员');
    const pending = deferred(); f.on('/vip/info', () => pending.promise);
    const [id, timer] = [...f.timers][0]; assert.equal(timer.delay, 1000);
    f.state.now = deadline; f.timers.delete(id); timer.callback();
    assert.equal(f.elements.get('netease-user-type').textContent, 'VIP会员');
    assert.equal(f.requests.length, 3);
    assert.equal(f.auth.authGeneration, 0); assert.equal(f.playback.currentAbortController.signal.aborted, false);
    assert.equal(f.playback.playbackState.status, 'loading'); assert.equal(f.auth.neteaseQuality, 'hires');
    assert.equal(f.host.localStorage.getItem('netease_quality'), 'hires');
    assert.deepEqual(f.resolverResets, [{ entitlementsChanged: true }]);
    assert.deepEqual(f.prefetchResets, [{ resetDetails: false }]);
    pending.resolve(response({ code: 200, data })); await flush(); await flush();
    assert.equal(f.resolverResets.length, 1); assert.equal(f.auth.accountAbortControllers.size, 0);
});

test('expiry while hidden is reconciled immediately on return even within the refresh interval', async t => {
    const f = fixture(t), deadline = f.state.now + 1000;
    f.on('/vip/info', () => response({ code: 200, data: { associator: { expireTime: deadline } } }));
    f.auth.initialize(); await flush(); await flush();
    f.host.document.hidden = true; f.host.document.dispatchEvent({ type: 'visibilitychange' });
    f.state.now = deadline;
    f.host.document.hidden = false; f.host.document.dispatchEvent({ type: 'visibilitychange' });
    await flush(); await flush();
    assert.equal(f.elements.get('netease-user-type').textContent, '普通用户');
    assert.equal(f.requests.length, 3); assert.equal(f.timers.size, 0);
    assert.equal(f.auth.neteaseUser.userId, 123); assert.equal(f.playback.currentAbortController.signal.aborted, false);
});

test('a far-future expiry timer is chunked without an early network refresh', async t => {
    const f = fixture(t);
    f.on('/vip/info', () => response({ code: 200, data: { associator: { expireTime: f.state.now + 40 * 24 * 3600_000 } } }));
    f.auth.initialize(); await flush(); await flush();
    const [id, timer] = [...f.timers][0]; assert.equal(timer.delay, 2 ** 31 - 1);
    f.state.now += timer.delay; f.timers.delete(id); timer.callback();
    assert.equal(f.requests.length, 2); assert.equal(f.timers.size, 1);
    assert.equal(f.elements.get('netease-user-type').textContent, 'VIP会员');
});

test('server time, when supplied, determines the remaining lifetime', async t => {
    const f = fixture(t), serverNow = f.state.now - 3600_000;
    f.on('/vip/info', () => response({ code: 200, data: { now: serverNow, associator: { expireTime: serverNow + 1000 } } }));
    f.auth.initialize(); await flush(); await flush();
    assert.equal(f.elements.get('netease-user-type').textContent, 'VIP会员');
    assert.equal([...f.timers.values()][0].delay, 1000);
});

test('renewal invalidates only future audio and unchanged refreshes do not repeat the invalidation', async t => {
    const f = fixture(t); f.on('/vip/info', () => response({ code: 200, data: { associator: { expireTime: 0 } } }));
    f.host.localStorage.setItem('netease_quality', 'lossless');
    f.auth.initialize(); await flush(); await flush();
    f.on('/vip/info', () => response({ code: 200, data: { associator: { expireTime: f.state.now + 3600_000 } } }));
    f.state.now += VIP_REFRESH_INTERVAL_MS; await f.auth.refreshVipInfo();
    assert.equal(f.elements.get('netease-user-type').textContent, 'VIP会员');
    assert.deepEqual(f.resolverResets, [{ entitlementsChanged: true }]);
    assert.deepEqual(f.prefetchResets, [{ resetDetails: false }]);
    assert.equal(f.auth.authGeneration, 0); assert.equal(f.playback.currentAbortController.signal.aborted, false);
    f.state.now += VIP_REFRESH_INTERVAL_MS; await f.auth.refreshVipInfo();
    assert.equal(f.resolverResets.length, 1); assert.equal(f.auth.neteaseQuality, 'lossless');
});

test('failed member refreshes show unknown without logging out and do not retry on every focus', async t => {
    const f = fixture(t); f.auth.initialize(); await flush(); await flush();
    f.on('/vip/info', () => { throw new Error('synthetic network failure'); });
    f.state.now += VIP_REFRESH_INTERVAL_MS; await f.auth.refreshVipInfo();
    assert.equal(f.elements.get('netease-user-type').textContent, '会员状态暂不可用');
    assert.equal(f.timers.size, 0); assert.equal(f.auth.neteaseUser.userId, 123);
    for (let i = 0; i < 10; i++) f.host.document.dispatchEvent({ type: 'focus' });
    await flush(); assert.equal(f.requests.length, 3);
    assert.equal(f.playback.currentAbortController.signal.aborted, false);
});

test('logout clears the expiry timer and foreground events cannot query or restore the old account', async t => {
    const f = fixture(t); f.auth.initialize(); await flush(); await flush();
    assert.equal(f.timers.size, 1); await f.auth.neteaseLogout();
    assert.equal(f.timers.size, 0);
    f.state.now += VIP_REFRESH_INTERVAL_MS;
    f.host.document.dispatchEvent({ type: 'visibilitychange' }); f.host.document.dispatchEvent({ type: 'focus' });
    await flush(); assert.equal(f.requests.length, 2); assert.equal(f.auth.neteaseUser, null);
});
