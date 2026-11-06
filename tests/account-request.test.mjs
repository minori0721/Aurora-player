import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountRequest, normalizeApiBody } from '../src/netease/account-request.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

function fixture(t) {
    const calls = [], auth = { generation: 1, neteaseCookie: 'MUSIC_U=synthetic; Path=/; Secure', accountAbortControllers: new Set(),
        captureAuthSnapshot() { return { generation: this.generation, cookie: this.neteaseCookie }; },
        isAuthSnapshotCurrent(value) { return value.generation === this.generation && value.cookie === this.neteaseCookie; } };
    const state = { handler: () => ({ code: 200, data: [] }) };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) });
        const value = await state.handler(calls.at(-1));
        return value?.json ? value : { ok: true, status: 200, json: async () => value };
    });
    const api = { buildApiUrl: path => `https://fixture.invalid${path}&randomCNIP=true` };
    return { calls, auth, state, api, request: createAccountRequest({ api, auth }) };
}

test('POST credentials are body-only, cleaned, non-cacheable and not caller-overridable', async t => {
    const f = fixture(t);
    await f.request('/song/like', { id: 12, like: 'false', cookie: 'wrong' });
    const { url, options, body } = f.calls[0];
    assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(body.cookie, 'MUSIC_U=synthetic'); assert.equal(body.like, 'false');
    assert.equal(new URL(url).searchParams.has('cookie'), false);
    assert.equal(url.includes('synthetic'), false);
    assert.equal(f.auth.accountAbortControllers.size, 0);
});

test('requests and helper instances have distinct cache-busting nonces even at the same timestamp', async t => {
    const f = fixture(t);
    t.mock.method(Date, 'now', () => 1234);
    await f.request('/song/like', {}); await f.request('/song/like', {});
    await createAccountRequest(f)('/song/like', {});
    const urls = f.calls.map(call => new URL(call.url));
    assert.equal(new Set(urls.map(url => url.searchParams.get('accountNonce'))).size, 3);
    assert.deepEqual(urls.map(url => url.searchParams.get('timestamp')), ['1234', '1234', '1234']);
});

test('normalizer is idempotent, retains business code/data and unwraps nested bodies', () => {
    const business = { code: 200, data: [12, 30] };
    assert.deepEqual(normalizeApiBody(business), business);
    const result = normalizeApiBody({ status: 200, body: { code: 200, body: { body: business } } });
    assert.deepEqual(result, business); assert.deepEqual(normalizeApiBody(result), result);
    assert.deepEqual(normalizeApiBody({ code: 200, body: { data: [] } }), { code: 200, data: [] });
});

test('outer200 cannot hide complete/data.code500 or nested playlist failures', () => {
    for (const payload of [
        { code: 200, data: { code: 500, message: 'MUSIC_U=synthetic' } },
        { status: 200, body: { status: 200, body: { code: 512 } } },
        { code: 200, body: { data: { body: { code: 301 } } } }
    ]) {
        assert.throws(() => normalizeApiBody(payload), error => {
            assert.equal(error.uncertain, false); assert.equal(error.message.includes('synthetic'), false);
            assert.ok([500, 512, 301].includes(error.apiCode)); return true;
        });
    }
});

test('HTTP success alone, false success, malformed envelopes and cyclic bodies cannot confirm success', () => {
    const cycle = { code: 200 }; cycle.body = cycle;
    for (const payload of [null, [], 'ok', {}, { status: 200, body: {} }, { code: 200, data: { success: false } }, cycle]) {
        assert.throws(() => normalizeApiBody(payload));
    }
    let payload = { code: 200 }; for (let i = 0; i < 10; i++) payload = { body: payload };
    assert.throws(() => normalizeApiBody(payload));
});

test('HTTP errors retain both HTTP status and inner apiCode without server messages', async t => {
    const f = fixture(t);
    f.state.handler = () => ({ ok: false, status: 401, json: async () => ({ body: { code: 301, msg: 'token=synthetic' } }) });
    await assert.rejects(f.request('/song/like', {}), error => {
        assert.equal(error.status, 401); assert.equal(error.apiCode, 301); assert.equal(error.uncertain, false);
        assert.equal(error.message.includes('synthetic'), false); return true;
    });
    f.state.handler = () => ({ ok: false, status: 503, json: async () => ({ code: 200 }) });
    await assert.rejects(f.request('/song/like'), error => error.status === 503 && !error.uncertain);
});

test('network failures are uncertain and sanitized with no retries', async t => {
    const f = fixture(t);
    f.state.handler = () => { throw new TypeError('https://secret.invalid?cookie=synthetic'); };
    await assert.rejects(f.request('/song/like'), error => {
        assert.equal(error.uncertain, true); assert.equal(error.apiCode, null);
        assert.equal(error.message.includes('synthetic'), false); assert.equal(error.cause, undefined); return true;
    });
    assert.equal(f.calls.length, 1); assert.equal(f.auth.accountAbortControllers.size, 0);
});

test('truncated successful JSON is uncertain because the mutation may have committed', async t => {
    const f = fixture(t);
    f.state.handler = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('secret'); } });
    await assert.rejects(f.request('/song/like'), error => error.uncertain && error.status === 200 && !error.message.includes('secret'));
});

test('a non-JSON HTTP404 retains its definite status for known cloud-import fallback', async t => {
    const f = fixture(t);
    f.state.handler = () => ({ ok: false, status: 404, json: async () => { throw new SyntaxError('<html>secret</html>'); } });
    await assert.rejects(f.request('/cloud/import'), error => error.status === 404 && !error.uncertain && !error.message.includes('secret'));
});

test('unconfirmed HTTP200 is uncertain; safe unsupported-import messages remain available to fallback', async t => {
    const f = fixture(t);
    f.state.handler = () => ({ data: {} });
    await assert.rejects(f.request('/cloud/import'), error => error.uncertain && error.status === 200);
    const unsupported = '不支持导入';
    f.state.handler = () => ({ code: 500, message: `${unsupported} https://secret.invalid?key=secret token=synthetic` });
    await assert.rejects(f.request('/cloud/import'), error => {
        assert.ok(error.message.includes(unsupported)); assert.equal(error.uncertain, false);
        assert.equal(error.message.includes('secret'), false); assert.equal(error.message.includes('synthetic'), false);
        assert.equal(error.message.includes('https://'), false); assert.ok(error.message.length <= 200); return true;
    });
});

test('timeout covers JSON consumption and unregisters its controller, even when JSON ignores abort', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t), json = deferred(), jsonStarted = deferred();
    f.state.handler = () => ({ ok: true, status: 200, json: () => { jsonStarted.resolve(); return json.promise; } });
    const result = f.request('/song/like', {}, { timeoutMs: 15 });
    const assertion = assert.rejects(result, error => error.name === 'TimeoutError' && error.uncertain && error.status === 200);
    await jsonStarted.promise; assert.equal(f.auth.accountAbortControllers.size, 1);
    t.mock.timers.tick(15);
    await assertion;
    assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.auth.accountAbortControllers.size, 0);
    json.resolve({ code: 200 }); await settle();
});

test('external cancellation settles an uncooperative fetch without retrying', async t => {
    const f = fixture(t), response = deferred(), controller = new AbortController();
    f.state.handler = () => response.promise;
    const result = f.request('/song/like', {}, { signal: controller.signal });
    const assertion = assert.rejects(result, error => error.name === 'AbortError' && !error.uncertain);
    await settle(); controller.abort(); await assertion;
    assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.auth.accountAbortControllers.size, 0);
    response.resolve({ code: 200 }); await settle(); assert.equal(f.calls.length, 1);
});

test('pre-aborted requests do not dispatch or register controllers', async t => {
    const f = fixture(t), controller = new AbortController(); controller.abort();
    await assert.rejects(f.request('/song/like', {}, { signal: controller.signal }), { name: 'AbortError', uncertain: false });
    assert.equal(f.calls.length, 0); assert.equal(f.auth.accountAbortControllers.size, 0);
});

test('auth controller remains registered throughout JSON and logout cancellation', async t => {
    const f = fixture(t), json = deferred();
    f.state.handler = () => ({ ok: true, status: 200, json: () => json.promise });
    const result = f.request('/song/like');
    const assertion = assert.rejects(result, { name: 'AbortError' });
    await settle(); assert.equal(f.auth.accountAbortControllers.size, 1);
    for (const controller of f.auth.accountAbortControllers) controller.abort();
    await assertion; assert.equal(f.auth.accountAbortControllers.size, 0);
    json.resolve({ code: 200 });
});

test('a changed snapshot rejects a late JSON result even without controller cancellation', async t => {
    const f = fixture(t), json = deferred();
    f.state.handler = () => ({ ok: true, status: 200, json: () => json.promise });
    const result = f.request('/song/like');
    const assertion = assert.rejects(result, { name: 'AbortError' });
    await settle(); f.auth.generation++; json.resolve({ code: 200 }); await assertion;
});

test('helper works without an auth controller registry and rejects credential-bearing paths', async t => {
    const f = fixture(t); delete f.auth.accountAbortControllers;
    assert.equal((await f.request('/user/playlist?limit=30')).code, 200);
    for (const path of ['/song/like?cookie=synthetic', '//other.invalid/api', 'https://other.invalid', '/song/like#x']) {
        await assert.rejects(f.request(path), error => !error.message.includes('synthetic'));
    }
    assert.equal(f.calls.length, 1);
});
