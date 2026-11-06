import test from 'node:test';
import assert from 'node:assert/strict';
import { mp3Fixture } from './helpers/mp3.mjs';
import { planSourceUpdate, probeSource, renderSourceCatalog, runSourceAudit, formatSourceReport } from '../scripts/update-match-sources.mjs';

const orders = names => Object.fromEntries(['balanced', 'lossless', 'hires'].map(profile => [profile, [...names, null]]));
const rows = (source, format, extra = {}) => Array.from({ length: 3 }, (_, i) => ({ source, id: i + 1,
    ok: true, format, bits: 16, sampleRate: 44100, elapsedMs: 500, ...extra }));
const json = data => new Response(JSON.stringify(data));

function flacHeader(rate = 44100, bits = 16, seconds = 100) {
    const bytes = new Uint8Array(42);
    bytes.set([102, 76, 97, 67, 128, 0, 0, 34]);
    bytes[18] = rate >> 12; bytes[19] = rate >> 4;
    bytes[20] = (rate & 15) << 4 | 2 | (bits - 1) >> 4;
    bytes[21] = (bits - 1 & 15) << 4 | Math.floor(rate * seconds / 4294967296);
    new DataView(bytes.buffer).setUint32(22, rate * seconds % 4294967296);
    return bytes.buffer;
}

function partial(buffer, size) {
    return new Response(buffer, { status: 206,
        headers: { 'content-range': `bytes 0-${buffer.byteLength - 1}/${size}`, 'content-length': String(buffer.byteLength),
            'access-control-allow-origin': '*' } });
}

test('catalog planning removes retired providers and admits only proven new ones', () => {
    const original = orders(['retired', 'mp3']);
    const snapshot = structuredClone(original);
    const result = planSourceUpdate(['mp3', 'flac', 'unproven'], [
        ...rows('mp3', 'mp3'), ...rows('flac', 'flac'), ...rows('unproven', 'flac').slice(0, 1)
    ], original);
    assert.equal(result.status, 'ready'); assert.equal(result.changed, true);
    assert.deepEqual(result.orders.balanced, ['mp3', 'flac', null]);
    assert.deepEqual(result.orders.lossless, ['flac', 'mp3', null]);
    assert.deepEqual(original, snapshot);
});

test('Hi-Res ranking uses measured precision while lossless ties keep the previous order', () => {
    const result = planSourceUpdate(['a', 'b', 'c'], [
        ...rows('a', 'flac'), ...rows('b', 'flac', { bits: 24, sampleRate: 48000 }), ...rows('c', 'mp3')
    ], orders(['a', 'b', 'c']));
    assert.equal(result.orders.lossless[0], 'a');
    assert.equal(result.orders.hires[0], 'b');
    assert.equal(result.orders.balanced[0], 'c');
});

test('ordinary timing noise preserves the catalog while persistent multi-second stalls affect tied sources', () => {
    const initial = orders(['a', 'b']);
    const close = planSourceUpdate(['a', 'b'], [...rows('a', 'flac', { elapsedMs: 1000 }), ...rows('b', 'flac', { elapsedMs: 600 })], initial);
    assert.equal(close.changed, false);
    const slow = planSourceUpdate(['a', 'b'], [...rows('a', 'flac', { elapsedMs: 6000 }), ...rows('b', 'flac')], initial);
    assert.equal(slow.orders.lossless[0], 'b');
});

test('temporary failures keep existing providers rather than treating them as removed modules', () => {
    const initial = orders(['bad', 'good']);
    const result = planSourceUpdate(['bad', 'good'], [...rows('bad', 'mp3', { ok: false }), ...rows('good', 'mp3')], initial);
    assert.deepEqual(result.orders.balanced, ['good', 'bad', null]);
    for (const input of [[], rows('bad', 'mp3', { ok: false }), rows('good', 'mp3').slice(0, 1)]) {
        const uncertain = planSourceUpdate(['bad', 'good'], input, initial);
        assert.equal(uncertain.status, 'inconclusive'); assert.equal(uncertain.changed, false);
        assert.equal(uncertain.orders, initial);
    }
});

test('catalog rendering is deterministic and never interpolates executable upstream names', () => {
    const good = orders(['msls', 'byfuns']);
    assert.equal(renderSourceCatalog(good), renderSourceCatalog(structuredClone(good)));
    assert.match(renderSourceCatalog(good), /balanced: \['msls', 'byfuns', null\]/);
    for (const values of [['bad\'; throw 1;//', null], ['x', 'x', null], ['x'], [null, 'x', null]]) {
        assert.throws(() => renderSourceCatalog({ ...good, balanced: values }), /INVALID_SOURCE_ORDER/);
    }
});

function network() {
    const calls = [];
    const samples = [{ id: 101, name: 'Sample A' }, { id: 102, name: 'Sample B' }];
    const fetchImpl = async (raw, options) => {
        const url = new URL(raw); calls.push({ url, options });
        assert.equal(options.headers?.Authorization, undefined);
        assert.equal(options.headers?.Cookie, undefined);
        if (url.hostname === 'api.github.com') return json(['msls', 'newflac', 'ddyr'].map(name => ({ type: 'file', name: `${name}.js` })));
        assert.equal(options.credentials, 'omit');
        if (url.pathname === '/song/detail') return json({ songs: samples.map(sample => ({ id: sample.id, fee: 1, dt: 100000 })) });
        if (url.pathname === '/song/url/match') {
            assert.equal(url.searchParams.has('cookie'), false);
            const source = url.searchParams.get('source');
            return json({ code: 200, data: `https://cdn.test/${source}/${url.searchParams.get('id')}?key=synthetic-signed-secret` });
        }
        assert.equal(url.hostname, 'cdn.test');
        assert.equal(options.headers.Range, 'bytes=0-4095');
        assert.equal(options.headers.Origin, 'https://music.moerika.com');
        if (url.pathname.includes('msls')) return partial(mp3Fixture({ bitrate: 320 }), 4000000);
        return partial(flacHeader(48000, url.pathname.includes('ddyr') ? 24 : 16), 10000000);
    };
    return { calls, samples, fetchImpl };
}

test('end-to-end audit uses the deployed API, validates small headers and reports no signed URLs', async () => {
    const f = network(), updates = [];
    const result = await runSourceAudit({ apiBase: 'https://api.test', fetchImpl: f.fetchImpl,
        delayMs: 0, samples: f.samples, orders: orders(['retired', 'msls']), onProgress: row => updates.push(row) });
    assert.equal(result.status, 'ready'); assert.equal(result.changed, true);
    assert.equal(result.rows.length, 6); assert.ok(result.rows.every(row => row.ok));
    assert.equal(updates.length, 6);
    assert.equal(result.orders.hires[0], 'ddyr');
    assert.deepEqual(result.orders.balanced, ['msls', 'ddyr', 'newflac', null]);
    assert.equal(f.calls.filter(call => call.url.pathname === '/song/url/match').length, 6);
    assert.equal(f.calls.filter(call => call.url.hostname === 'cdn.test').length, 6);
    assert.ok(f.calls.every(call => call.url.searchParams.get('source') !== 'retired'));
    assert.doesNotMatch(JSON.stringify(result), /synthetic-signed-secret|https:\/\/cdn/);
    assert.doesNotMatch(formatSourceReport(result), /synthetic-signed-secret|https:\/\/cdn/);
});

test('API-wide rate limiting stops the remaining matrix and never proposes an update', async () => {
    const f = network(); let matches = 0;
    const fetchImpl = (raw, options) => {
        if (new URL(raw).pathname === '/song/url/match') { matches++; return json({ code: 429 }); }
        return f.fetchImpl(raw, options);
    };
    const result = await runSourceAudit({ apiBase: 'https://api.test', fetchImpl, delayMs: 0, samples: f.samples });
    assert.equal(matches, 1); assert.equal(result.status, 'inconclusive'); assert.equal(result.changed, false);
    assert.equal(result.reason, 'API_RATE_LIMITED');
});

test('daily sampling caps concurrent probes at two and preserves the request budget', async () => {
    const f = network(); let active = 0, peak = 0, matches = 0;
    const fetchImpl = async (raw, options) => {
        if (new URL(raw).pathname !== '/song/url/match') return f.fetchImpl(raw, options);
        active++; matches++; peak = Math.max(peak, active);
        try {
            await new Promise(resolve => setTimeout(resolve, 5));
            return await f.fetchImpl(raw, options);
        } finally { active--; }
    };
    const result = await runSourceAudit({ apiBase: 'https://api.test', fetchImpl, delayMs: 0,
        concurrency: 2, samples: f.samples });
    assert.equal(result.status, 'ready'); assert.equal(matches, 6);
    assert.equal(peak, 2); assert.equal(active, 0);
    assert.equal(f.calls.filter(call => call.url.pathname === '/song/detail').length, 1);
});

test('daily rate limiting finishes at most the already active probes and performs no retries', async () => {
    const f = network(); let matches = 0;
    const result = await runSourceAudit({ apiBase: 'https://api.test', delayMs: 0, concurrency: 2, samples: f.samples,
        fetchImpl: async (raw, options) => {
            if (new URL(raw).pathname !== '/song/url/match') return f.fetchImpl(raw, options);
            matches++;
            return json({ code: 429 });
        } });
    assert.ok(matches <= 2); assert.equal(result.status, 'inconclusive');
    assert.equal(result.reason, 'API_RATE_LIMITED');
    assert.equal(result.apiHost, 'api.test'); assert.equal(result.samples.length, 2);
});

test('the audit deadline reports missing evidence instead of ranking a partial matrix', async () => {
    const f = network();
    const result = await runSourceAudit({ apiBase: 'https://api.test', fetchImpl: f.fetchImpl,
        delayMs: 0, samples: f.samples, deadlineMs: 0 });
    assert.equal(result.status, 'inconclusive'); assert.equal(result.reason, 'AUDIT_DEADLINE');
    assert.equal(result.changed, false); assert.equal(result.rows.length, 0);
    assert.equal(f.calls.filter(call => call.url.pathname === '/song/url/match').length, 0);
    await assert.rejects(runSourceAudit({ concurrency: 3 }), /INVALID_CONCURRENCY/);
});

test('invalid sample metadata or oversized directories fail before source probes', async () => {
    for (const mode of ['samples', 'directory']) {
        const f = network(); let matches = 0;
        const fetchImpl = (raw, options) => {
            const url = new URL(raw);
            if (mode === 'directory' && url.hostname === 'api.github.com') return json(Array.from({ length: 13 }, (_, i) => ({ type: 'file', name: `source${i}.js` })));
            if (mode === 'samples' && url.pathname === '/song/detail') return json({ songs: [] });
            if (url.pathname === '/song/url/match') matches++;
            return f.fetchImpl(raw, options);
        };
        await assert.rejects(runSourceAudit({ apiBase: 'https://api.test', fetchImpl, delayMs: 0, samples: f.samples }), /LIMIT|SAMPLES/);
        assert.equal(matches, 0);
    }
});

test('range-ignoring media is cancelled without reading an entire file', async () => {
    let cancelled = false, mediaCalls = 0;
    const result = await probeSource({ source: 'example', sample: { id: 1, durationMs: 100000 }, apiBase: 'https://api.test',
        fetchImpl: async raw => {
            if (new URL(raw).pathname === '/song/url/match') return json({ code: 200, data: 'https://cdn.test/audio' });
            mediaCalls++;
            return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 });
        } });
    assert.equal(mediaCalls, 1); assert.equal(cancelled, true); assert.equal(result.ok, false);
    assert.equal(result.reason, 'AUDIO_RANGE');
});

test('audio that cannot be fetched from the player origin never qualifies a provider', async () => {
    for (const allowed of [null, 'https://other.test', 'https://music.moerika.com']) {
        const result = await probeSource({ source: 'example', sample: { id: 1, durationMs: 100000 }, apiBase: 'https://api.test',
            fetchImpl: async raw => {
                if (new URL(raw).pathname === '/song/url/match') return json({ code: 200, data: 'https://cdn.test/audio' });
                const response = partial(flacHeader(), 10000000);
                if (allowed) response.headers.set('access-control-allow-origin', allowed);
                else response.headers.delete('access-control-allow-origin');
                return response;
            } });
        assert.equal(result.ok, allowed === 'https://music.moerika.com');
        if (!result.ok) assert.equal(result.reason, 'AUDIO_CORS');
    }
});

test('private redirect targets and trial links cannot qualify a provider', async () => {
    for (const mode of ['redirect', 'trial', 'duration']) {
        let mediaCalls = 0;
        const result = await probeSource({ source: 'example', sample: { id: 1, durationMs: 100000 }, apiBase: 'https://api.test',
            fetchImpl: async raw => {
                if (new URL(raw).pathname === '/song/url/match') return json({ code: 200,
                    data: `https://cdn.test/${mode === 'trial' ? 'jd-musicrep-ts/clip.mp3' : 'audio'}` });
                mediaCalls++;
                return mode === 'redirect' ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })
                    : partial(flacHeader(44100, 16, 30), 1000000);
            } });
        assert.equal(result.ok, false); assert.ok(mediaCalls <= 1);
        assert.equal(result.reason, ({ redirect: 'UNSUPPORTED_URL', trial: 'TRIAL_LINK', duration: 'DURATION_MISMATCH' })[mode]);
    }
});
