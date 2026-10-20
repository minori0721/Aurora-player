import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLoginPage, normalizeLoginPhone, LOGIN_TIMEOUT_MS, SMS_RESEND_MS } from '../src/netease/login.js';
import { createHost } from './helpers/host.mjs';

const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

function fixture({ mobile = true } = {}) {
    const { host, elements } = createHost(html), requests = [], commits = [], navigations = [], timers = new Map(), handlers = new Map();
    let now = 1000, sequence = 0, generation = 1, cookie = '';
    const node = id => elements.get(id), scroller = { scrollTop: 42 }, savedScroll = [];
    node('login-country').value = '86'; node('netease-panel').classList.add('show');
    const browser = {
        musicBrowserState: { navToken: 1, authReturnHash: '' },
        currentMusicNavigationIs: (token, hash) => token === browser.musicBrowserState.navToken && hash === host.location.hash,
        saveMusicScrollState: () => savedScroll.push(browser.musicBrowserState.authReturnContext?.scrollTop ?? scroller.scrollTop),
        navigateMusic: (...args) => { navigations.push(args); page.cancel(); }
    };
    host.location.hash = '#music/album/12';
    const snapshot = () => ({ generation, cookie });
    const environment = {
        location: host.location, Date: { now: () => now }, matchMedia: () => ({ matches: mobile }),
        setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; },
        clearTimeout: id => timers.delete(id),
        fetch: async (url, options) => {
            const path = new URL(url).pathname; requests.push({ url, options, path });
            if (handlers.has(path)) return handlers.get(path)(options);
            if (path === '/login/qr/key') return response({ code: 200, data: { unikey: 'synthetic-qr-key' } });
            if (path === '/login/qr/create') return response({ code: 200, data: { qrimg: 'data:image/png;base64,AA==' } });
            if (path === '/login/qr/check') return response({ code: 801 });
            if (path === '/login/cellphone') return response({ code: 200, cookie: 'MUSIC_U=synthetic; Path=/; HttpOnly' });
            if (path === '/login/status') return response({ data: { code: 200, profile: { userId: 123, nickname: 'Test' } } });
            return response({ code: 200 });
        }
    };
    const page = createLoginPage({ api: { buildApiUrl: path => 'https://api.test' + path },
        dom: { neteasePanel: node('netease-panel'), neteaseBrowserScroll: scroller, neteasePageTitle: node('netease-page-title') },
        browser, captureAuthSnapshot: snapshot, isAuthSnapshotCurrent: value => value.generation === generation && value.cookie === cookie,
        commitLogin: (next, profile, current) => {
            if (!current()) return null;
            cookie = next; generation++; commits.push({ cookie, profile }); return snapshot();
        }
    }, { environment, document: host.document });
    page.initialize();
    const input = (id, value) => { node(id).value = value; node(id).oninput?.(); };
    const tick = async duration => {
        const end = now + duration;
        while (true) {
            const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            now = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
        }
        now = end; await flush();
    };
    return { page, node, requests, commits, navigations, timers, browser, input, tick, scroller, savedScroll,
        send: () => node('login-send-code').onclick(), submit: () => node('sms-login-form').onsubmit({ preventDefault() {} }),
        phone: () => input('login-phone', '13800138000'), code: () => input('login-captcha', '001234'),
        on: (path, handler) => handlers.set(path, handler), invalidateAuth() { generation++; },
        jumpClock(ms) { now += ms; }, get now() { return now; } };
}

test('login numbers normalize international prefixes without coercing leading zeroes', () => {
    assert.deepEqual(normalizeLoginPhone('+86', '+86 138-0013-8000'), { phone: '13800138000', countrycode: '86', key: '86:13800138000' });
    assert.equal(normalizeLoginPhone('86', '123'), null);
    assert.equal(normalizeLoginPhone('86', '+1 5551234567'), null);
    assert.equal(normalizeLoginPhone('001', '5551234567'), null);
    assert.equal(normalizeLoginPhone('44', '02012345678').phone, '02012345678');
});

test('mobile opens SMS without issuing a request; desktop opens QR', async () => {
    const f = fixture(); f.page.open();
    assert.equal(f.node('login-mode-sms').getAttribute('aria-pressed'), 'true'); assert.equal(f.requests.length, 0);
    assert.equal(f.node('login-send-code').disabled, true); f.page.cancel();
    const desktop = fixture({ mobile: false }); await desktop.page.open();
    assert.deepEqual(desktop.requests.map(r => r.path), ['/login/qr/key', '/login/qr/create']); desktop.page.cancel();
});

test('SMS sends once, keeps a deadline through switching and reopening, and permits sending after expiry', async () => {
    const f = fixture(); f.page.open(); f.phone();
    await Promise.all([f.send(), f.send()]); assert.equal(f.requests.length, 1);
    assert.equal(f.node('login-send-code').textContent, '60 秒后重发');
    f.node('login-mode-qr').onclick(); await flush(); f.node('login-mode-sms').onclick();
    assert.equal(f.node('login-send-code').textContent, '60 秒后重发');
    f.page.cancel(); f.jumpClock(20000); f.page.open();
    assert.equal(f.node('login-send-code').textContent, '40 秒后重发');
    await f.tick(40000); assert.equal(f.node('login-send-code').disabled, false);
    await f.send(); assert.equal(f.requests.filter(r => r.path === '/captcha/sent/v1').length, 2); f.page.cancel();
});

test('clock throttling cannot extend the resend countdown', async () => {
    const f = fixture(); f.page.open(); f.phone(); await f.send();
    f.jumpClock(SMS_RESEND_MS); f.input('login-captcha', '1234');
    assert.equal(f.node('login-send-code').disabled, false); f.page.cancel();
});

test('SMS timeout preserves cooldown, enables code entry, and never falls back or resends automatically', async () => {
    const f = fixture(); f.on('/captcha/sent/v1', () => new Promise(() => {})); f.page.open(); f.phone();
    const pending = f.send(); await f.tick(LOGIN_TIMEOUT_MS); await pending;
    assert.match(f.node('sms-login-status').textContent, /可能已发送/);
    assert.equal(f.node('login-captcha').readOnly, false); assert.equal(f.node('login-send-code').disabled, true);
    f.code(); await f.submit(); assert.equal(f.commits.length, 1);
    assert.equal(f.requests.filter(r => r.path.startsWith('/captcha/')).length, 1); f.page.cancel();
});

test('SMS validates the profile before committing once and returns to the original page', async () => {
    const f = fixture(); f.page.open(); f.phone(); f.code();
    await Promise.all([f.submit(), f.submit()]);
    assert.deepEqual(f.requests.map(r => r.path), ['/login/cellphone', '/login/status']);
    assert.equal(f.commits.length, 1); assert.equal(f.commits[0].cookie, 'MUSIC_U=synthetic');
    assert.equal(f.node('login-captcha').value, '');
    await f.tick(600); assert.equal(f.navigations[0][0].kind, 'album'); assert.equal(f.navigations[0][0].id, 12);
    assert.equal(f.navigations[0][1].restoreScroll, 42); assert.equal(f.timers.size, 0);
});

test('account validation failure retries only status, not login or SMS', async () => {
    const f = fixture(); let attempts = 0;
    f.on('/login/status', () => { if (!attempts++) throw new TypeError('Synthetic offline'); return response({ data: { profile: { userId: 123 } } }); });
    f.page.open(); f.phone(); f.code(); await f.submit();
    assert.equal(f.commits.length, 0); assert.equal(f.node('login-retry').hidden, false);
    await f.node('login-retry').onclick(); assert.equal(f.commits.length, 1);
    assert.deepEqual(f.requests.map(r => r.path), ['/login/cellphone', '/login/status', '/login/status']); f.page.cancel();
});

test('closing during login drops late results even if transport ignores abort', async () => {
    const f = fixture(), pending = deferred(); f.on('/login/cellphone', () => pending.promise);
    f.page.open(); f.phone(); f.code(); const submit = f.submit(); f.page.cancel();
    pending.resolve(response({ code: 200, cookie: 'MUSIC_U=synthetic' })); await submit;
    assert.equal(f.commits.length, 0); assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0);
});

test('phone edits abort the previous operation and retain per-number cooldowns', async () => {
    const f = fixture(), pending = deferred(); f.on('/captcha/sent/v1', () => pending.promise);
    f.page.open(); f.phone(); const send = f.send();
    f.input('login-phone', '13900139000'); assert.equal(f.requests[0].options.signal.aborted, true);
    pending.resolve(response({ code: 200 })); await send;
    assert.equal(f.node('sms-login-status').textContent, ''); assert.equal(f.node('login-send-code').disabled, false);
    f.phone(); assert.equal(f.node('login-send-code').disabled, true); f.page.cancel();
});

test('stale profile responses cannot commit after navigation or logout', async () => {
    for (const invalidate of ['navigation', 'auth']) {
        const f = fixture(), pending = deferred(); f.on('/login/status', () => pending.promise);
        f.page.open(); f.phone(); f.code(); const submit = f.submit(); await flush();
        if (invalidate === 'navigation') f.browser.musicBrowserState.navToken++;
        else f.invalidateAuth();
        pending.resolve(response({ data: { profile: { userId: 123 } } })); await submit;
        assert.equal(f.commits.length, 0); f.page.cancel(); assert.equal(f.timers.size, 0);
    }
});

test('missing cookies and invalid profiles never show a successful login', async () => {
    const f = fixture(); f.page.open(); f.phone(); f.code();
    f.on('/login/cellphone', () => response({ code: 200 })); await f.submit(); assert.equal(f.commits.length, 0);
    f.on('/login/cellphone', () => response({ code: 200, cookie: 'MUSIC_U=synthetic' }));
    f.on('/login/status', () => response({ data: { code: 200, profile: null } })); await f.submit();
    assert.equal(f.commits.length, 0); assert.match(f.node('sms-login-status').textContent, /失效/); f.page.cancel();
});

test('all login credentials use uncached POST bodies, unique request URLs and leading-zero codes', async () => {
    const f = fixture(); f.page.open(); f.phone(); await f.send(); f.code(); await f.submit();
    for (const r of f.requests) {
        assert.equal(r.options.method, 'POST'); assert.equal(r.options.cache, 'no-store'); assert.equal(r.options.credentials, 'omit');
        assert.equal(/13800138000|001234|MUSIC_U|cookie=|phone=|captcha=/.test(r.url), false);
    }
    assert.equal(new Set(f.requests.map(r => r.url)).size, f.requests.length);
    assert.equal(JSON.parse(f.requests[0].options.body).ctcode, '86');
    assert.equal(JSON.parse(f.requests[1].options.body).countrycode, '86');
    assert.equal(JSON.parse(f.requests[1].options.body).captcha, '001234'); f.page.cancel();
});

test('safe UI errors do not echo backend HTML, numbers, codes or candidate cookies', async () => {
    const f = fixture(); f.page.open(); f.phone(); f.code();
    f.on('/login/cellphone', () => response({ code: 400, message: '<script>13800138000 001234 MUSIC_U=synthetic</script>' }));
    await f.submit(); assert.equal(/13800138000|001234|MUSIC_U|script/.test(f.node('sms-login-status').textContent), false);
    f.on('/login/cellphone', () => response({ code: 415, message: '需要滑块安全验证' }));
    await f.submit(); assert.match(f.node('sms-login-status').textContent, /扫码/); f.page.cancel();
});

test('QR polling and SMS share account validation; switching modes stops old polling', async () => {
    const f = fixture({ mobile: false }); await f.page.open();
    f.on('/login/qr/check', () => response({ code: 803, cookie: 'MUSIC_U=synthetic' }));
    await f.tick(2000); assert.equal(f.commits.length, 1); assert.equal(f.requests.at(-1).path, '/login/status');
    f.page.cancel(); assert.equal(f.timers.size, 0);
    const other = fixture({ mobile: false }); await other.page.open(); other.node('login-mode-sms').onclick();
    await other.tick(10000); assert.equal(other.requests.some(r => r.path === '/login/qr/check'), false); other.page.cancel();
});

test('QR expiry stops polling and a new refresh cannot be painted by an old key response', async () => {
    const f = fixture({ mobile: false }); await f.page.open();
    f.on('/login/qr/check', () => response({ code: 800 })); await f.tick(2000); assert.equal(f.timers.size, 0);
    assert.match(f.node('qrcode-status').textContent, /过期/);
    const pending = deferred(); f.on('/login/qr/key', () => pending.promise);
    const refresh = f.page.refreshQRCode(); f.node('login-mode-sms').onclick();
    pending.resolve(response({ data: { unikey: 'old' } })); await refresh;
    assert.equal(f.node('login-mode-sms').getAttribute('aria-pressed'), 'true'); f.page.cancel();
});

test('server Retry-After takes precedence over the default SMS interval', async () => {
    const f = fixture();
    f.on('/captcha/sent/v1', () => new Response(JSON.stringify({ code: 429, message: '请求频繁' }), { status: 429, headers: { 'Retry-After': '120' } }));
    f.page.open(); f.phone(); await f.send();
    assert.equal(f.node('login-send-code').textContent, '120 秒后重发');
    await f.tick(60000); assert.equal(f.node('login-send-code').disabled, true); f.page.cancel();
});

test('the login deadline covers a stalled JSON body as well as response headers', async () => {
    const f = fixture(); f.on('/login/cellphone', () => ({ ok: true, json: () => new Promise(() => {}) }));
    f.page.open(); f.phone(); f.code(); const pending = f.submit(); await f.tick(LOGIN_TIMEOUT_MS); await pending;
    assert.equal(f.commits.length, 0); assert.equal(f.node('login-submit').disabled, false);
    assert.match(f.node('sms-login-status').textContent, /重试/); f.page.cancel();
});

test('explicitly rejected login credentials are discarded instead of offered for endless status retries', async () => {
    const f = fixture(); f.on('/login/status', () => response({ code: 401 }, 401));
    f.page.open(); f.phone(); f.code(); await f.submit();
    assert.equal(f.node('login-retry').hidden, true); assert.equal(f.node('login-submit').disabled, false);
    assert.match(f.node('sms-login-status').textContent, /失效/); f.page.cancel();
});

test('server-side status errors do not discard a candidate or consume another one-time login', async () => {
    const f = fixture(); f.on('/login/status', () => response({ code: 503 }));
    f.page.open(); f.phone(); f.code(); await f.submit();
    assert.equal(f.node('login-retry').hidden, false); assert.equal(f.commits.length, 0);
    f.on('/login/status', () => response({ data: { code: 200, profile: { userId: 123 } } }));
    await f.node('login-retry').onclick(); assert.equal(f.commits.length, 1);
    assert.equal(f.requests.filter(r => r.path === '/login/cellphone').length, 1);
    f.page.cancel();
});

test('login return context survives phone edits, mode switches and QR refreshes', async () => {
    const f = fixture(); f.scroller.scrollTop = 540; f.page.open();
    f.scroller.scrollTop = 0; f.phone();
    await f.node('login-mode-qr').onclick(); await flush();
    await f.page.refreshQRCode(); f.node('login-mode-sms').onclick();
    f.code(); await f.submit(); await f.tick(600);
    assert.equal(f.navigations[0][1].restoreScroll, 540);
    assert.deepEqual(f.savedScroll, [540]);
    assert.equal(f.browser.musicBrowserState.authReturnContext, null);
});

test('closing a login journey clears its return context; reopening captures the new page', () => {
    const f = fixture(); f.scroller.scrollTop = 540; f.page.open(); f.page.cancel();
    f.scroller.scrollTop = 180; f.page.open();
    assert.equal(f.browser.musicBrowserState.authReturnContext.scrollTop, 180);
    assert.deepEqual(f.savedScroll, [540, 180]); f.page.cancel();
});

test('non-JSON HTTP errors retain Retry-After without echoing their bodies', async () => {
    for (const body of ['<html>13800138000 Too Many Requests</html>', '', '{broken']) {
        const f = fixture();
        f.on('/captcha/sent/v1', () => new Response(body, { status: 429, headers: { 'Retry-After': '180' } }));
        f.page.open(); f.phone(); await f.send();
        assert.equal(f.node('login-send-code').textContent, '180 秒后重发');
        assert.match(f.node('sms-login-status').textContent, /频繁/);
        assert.doesNotMatch(f.node('sms-login-status').textContent, /可能已发送|13800138000|html/);
        f.page.cancel();
    }
});

test('Retry-After accepts HTTP dates and never shortens the local cooldown', async () => {
    for (const [header, seconds] of [[new Date(181000).toUTCString(), 180], ['2', 60], ['bad-date', 60]]) {
        const f = fixture();
        f.on('/captcha/sent/v1', () => new Response('', { status: 429, headers: { 'Retry-After': header } }));
        f.page.open(); f.phone(); await f.send();
        assert.equal(f.node('login-send-code').textContent, `${seconds} 秒后重发`); f.page.cancel();
    }
});

test('a non-JSON status failure preserves the candidate but HTTP 401 discards it', async () => {
    for (const status of [503, 401]) {
        const f = fixture(); f.on('/login/status', () => new Response('<html>unavailable</html>', { status }));
        f.page.open(); f.phone(); f.code(); await f.submit();
        assert.equal(f.node('login-retry').hidden, status === 401); assert.equal(f.commits.length, 0);
        assert.equal(f.requests.filter(r => r.path === '/login/cellphone').length, 1); f.page.cancel();
    }
});

test('HTTP rate limit metadata survives a stalled error body until the request deadline', async () => {
    const f = fixture();
    f.on('/captcha/sent/v1', () => ({ ok: false, status: 429, headers: new Headers({ 'Retry-After': '180' }), json: () => new Promise(() => {}) }));
    f.page.open(); f.phone(); const sending = f.send(); await flush();
    await f.tick(LOGIN_TIMEOUT_MS); await sending;
    assert.equal(f.node('login-send-code').textContent, '165 秒后重发');
    assert.match(f.node('sms-login-status').textContent, /频繁/); f.page.cancel();
});
