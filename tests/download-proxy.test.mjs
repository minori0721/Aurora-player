import test from 'node:test';
import assert from 'node:assert/strict';
import { proxyDownload } from '../server/download-proxy.js';
import worker from '../server/cloudflare.js';

const audioUrl = 'https://m701.music.126.net/signed/example.flac?key=example';
const request = (target = audioUrl, options = {}, filename = '音乐.flac') => {
    const url = new URL('https://player.example/proxy-download');
    if (target !== null) url.searchParams.set('url', target);
    url.searchParams.set('filename', filename);
    return new Request(url, options);
};

test('download proxy forwards a response stream and safe audio headers without buffering or caching', async () => {
    const bytes = new Uint8Array([102, 76, 97, 67]);
    const upstream = new Response(bytes, { headers: { 'Content-Type': 'audio/flac', 'Content-Length': '4',
        'Accept-Ranges': 'bytes', 'ETag': '"audio"', 'Set-Cookie': 'private=not-forwarded' } });
    upstream.clone = upstream.arrayBuffer = () => { throw new Error('Audio must not be copied or buffered'); };
    const response = await proxyDownload(request(audioUrl, { headers: { Cookie: 'private=not-forwarded', Authorization: 'not-forwarded' } }), {
        fetchImpl: async (url, options) => {
            assert.equal(url, audioUrl); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
            assert.equal(options.headers.get('Referer'), 'https://music.163.com/');
            assert.equal(options.headers.has('Cookie'), false); assert.equal(options.headers.has('Authorization'), false);
            assert.equal(options.cf.cacheTtl, 0);
            return upstream;
        }
    });
    assert.equal(response.body, upstream.body);
    assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Length'), '4');
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes'); assert.equal(response.headers.get('ETag'), '"audio"');
    assert.equal(response.headers.get('Set-Cookie'), null); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(response.headers.get('Content-Disposition'), /filename\*=UTF-8''%E9%9F%B3%E4%B9%90.flac/);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test('HEAD probes stay HEAD upstream and return audio size without downloading a body', async () => {
    const response = await proxyDownload(request(audioUrl, { method: 'HEAD' }), { fetchImpl: async (_, options) => {
        assert.equal(options.method, 'HEAD');
        return new Response(null, { headers: { 'Content-Length': '33554432', 'Content-Type': 'audio/flac' } });
    } });
    assert.equal(response.status, 200); assert.equal(response.body, null);
    assert.equal(response.headers.get('Content-Length'), '33554432');
});

for (const range of ['bytes=0-4095', 'bytes=4096-', 'bytes=-4096']) test(`download proxy preserves ${range} and partial response metadata`, async () => {
    const response = await proxyDownload(request(audioUrl, { headers: { Range: range, 'If-Range': '"version"' } }), {
        fetchImpl: async (_, options) => {
            assert.equal(options.headers.get('Range'), range); assert.equal(options.headers.get('If-Range'), '"version"');
            return new Response('part', { status: 206, headers: { 'Content-Type': 'audio/flac', 'Content-Range': 'bytes 0-3/100', 'Content-Length': '4' } });
        }
    });
    assert.equal(response.status, 206); assert.equal(response.headers.get('Content-Range'), 'bytes 0-3/100');
    assert.equal(await response.text(), 'part');
});

for (const target of [null, '', 'not-a-url', 'file:///etc/passwd', 'https://127.0.0.1/', 'https://[::1]/',
    'https://music.126.net.evil.example/a', 'https://other.126.net/a', 'https://music.126.net@evil.example/a',
    'https://user:password@m701.music.126.net/a', 'https://m701.music.126.net:8080/a']) {
    test(`download proxy rejects unsupported target ${target}`, async () => {
        const response = await proxyDownload(request(target), { fetchImpl: () => { throw new Error('Must not fetch'); } });
        assert.equal(response.status, 400);
    });
}

test('old HTTP audio URLs are upgraded to HTTPS before fetching', async () => {
    const response = await proxyDownload(request('http://m8.music.126.net/audio.mp3'), { fetchImpl: async url => {
        assert.equal(url, 'https://m8.music.126.net/audio.mp3'); return new Response('mp3', { headers: { 'Content-Type': 'audio/mpeg' } });
    } });
    assert.equal(response.status, 200); await response.body.cancel();
});

for (const target of ['https://evil.example/a', 'http://127.0.0.1/a', 'https://user:password@m8.music.126.net/a']) {
    test(`redirect validation stops unsupported destination ${target}`, async () => {
        let calls = 0;
        const response = await proxyDownload(request(), { fetchImpl: async () => {
            calls++; return new Response(null, { status: 302, headers: { Location: target } });
        } });
        assert.equal(response.status, 502); assert.equal(calls, 1);
    });
}

test('relative redirects keep the original method and range; redirect loops stop after four requests', async () => {
    let calls = 0;
    const response = await proxyDownload(request(audioUrl, { headers: { Range: 'bytes=0-3' } }), { fetchImpl: async (url, options) => {
        calls++; assert.equal(options.method, 'GET'); assert.equal(options.headers.get('Range'), 'bytes=0-3');
        if (calls === 1) return new Response('discard', { status: 302, headers: { Location: '/next.flac' } });
        assert.equal(url, 'https://m701.music.126.net/next.flac'); return new Response('flac', { headers: { 'Content-Type': 'audio/flac' } });
    } });
    assert.equal(response.status, 200); assert.equal(calls, 2); await response.body.cancel();
    calls = 0;
    const loop = await proxyDownload(request(), { fetchImpl: async () => {
        calls++; return new Response(null, { status: 302, headers: { Location: '/again' } });
    } });
    assert.equal(loop.status, 502); assert.equal(calls, 4);
});

test('OPTIONS, unsupported methods, and invalid ranges never contact the CDN', async () => {
    let calls = 0;
    const options = { fetchImpl: async () => { calls++; throw new Error('Must not fetch'); } };
    const preflight = await proxyDownload(request(null, { method: 'OPTIONS' }), options);
    assert.equal(preflight.status, 204); assert.equal(preflight.body, null);
    assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /If-Range/);
    const post = await proxyDownload(request(audioUrl, { method: 'POST' }), options);
    assert.equal(post.status, 405); assert.equal(post.headers.get('Allow'), 'GET, HEAD, OPTIONS');
    const badRange = await proxyDownload(request(audioUrl, { headers: { Range: 'bytes=0-1,3-4' } }), options);
    assert.equal(badRange.status, 400); assert.equal(calls, 0);
});

test('filename sanitization preserves Unicode, limits length and cannot inject response headers', async () => {
    const name = '曲目/"\r\nX-Bad: yes ' + '🎵'.repeat(180) + '.flac';
    const response = await proxyDownload(request(audioUrl, {}, name), { fetchImpl: async () => new Response('audio', { headers: { 'Content-Type': 'audio/flac' } }) });
    const disposition = response.headers.get('Content-Disposition');
    assert.doesNotMatch(disposition, /[\r\n]/); assert.equal(response.headers.has('X-Bad'), false);
    const decoded = decodeURIComponent(disposition.split("filename*=UTF-8''")[1]);
    assert.equal(Array.from(decoded).length, 180); assert.match(decoded, /^曲目___/);
    await response.body.cancel();
});

test('CDN failure statuses are preserved without exposing its response body or cookies', async () => {
    for (const status of [401, 403, 404, 410, 416, 429, 500, 503]) {
        const response = await proxyDownload(request(), { fetchImpl: async () => new Response('private upstream details', {
            status, headers: { 'Content-Length': '123456', 'Content-Range': 'bytes */100', 'Set-Cookie': 'private' }
        }) });
        assert.equal(response.status, status); assert.equal(response.headers.has('Content-Length'), false);
        assert.equal(response.headers.has('Set-Cookie'), false);
        if (status === 416) assert.equal(response.headers.get('Content-Range'), 'bytes */100');
        assert.doesNotMatch(await response.text(), /private upstream details/);
    }
});

test('HTML challenge pages are not offered as successful audio downloads', async () => {
    const response = await proxyDownload(request(), { fetchImpl: async () => new Response('<html>challenge</html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    }) });
    assert.equal(response.status, 502);
});

test('the passthrough retains upstream content encoding metadata when the source sends it', async () => {
    const response = await proxyDownload(request(), { fetchImpl: async () => new Response(new Uint8Array([1, 2]), {
        headers: { 'Content-Type': 'audio/flac', 'Content-Encoding': 'gzip' }
    }) });
    assert.equal(response.headers.get('Content-Encoding'), 'gzip'); await response.body.cancel();
});

test('header timeouts cancel stalled upstream requests and network failures do not expose signed URLs', async () => {
    const response = await proxyDownload(request(), { headerTimeoutMs: 5, fetchImpl: (_, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    assert.equal(response.status, 504);
    const failure = await proxyDownload(request(), { fetchImpl: async () => { throw new Error(audioUrl); } });
    assert.equal(failure.status, 502); assert.doesNotMatch(await failure.text(), /key=example/);
});

test('the header deadline does not abort a slow body after headers arrive', async () => {
    let signal;
    const response = await proxyDownload(request(), { headerTimeoutMs: 5, fetchImpl: async (_, options) => {
        signal = options.signal;
        return new Response(new ReadableStream({ start(controller) {
            setTimeout(() => { controller.enqueue(new Uint8Array([1, 2])); controller.close(); }, 30);
        } }));
    } });
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2]));
    assert.equal(signal.aborted, false);
});

test('256 MiB audio can pass through in bounded chunks and downstream cancellation reaches the source', async () => {
    let pulls = 0, cancelled = false;
    const chunk = new Uint8Array(64 * 1024);
    const response = await proxyDownload(request(), { fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) { if (pulls++ < 4096) controller.enqueue(chunk); else controller.close(); },
        cancel() { cancelled = true; }
    })) });
    assert.ok(pulls <= 1, 'return headers before reading the whole file');
    const reader = response.body.getReader();
    let total = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; }
    assert.equal(total, 256 * 1024 * 1024); assert.equal(cancelled, false);
    const interrupted = await proxyDownload(request(), { fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(chunk); }, cancel() { cancelled = true; }
    })) });
    const next = interrupted.body.getReader(); await next.read(); await next.cancel();
    assert.equal(cancelled, true);
});

test('client abort remains connected to the upstream signal after headers arrive', async () => {
    const controller = new AbortController(); let upstreamSignal;
    const response = await proxyDownload(request(audioUrl, { signal: controller.signal }), { fetchImpl: async (_, options) => {
        upstreamSignal = options.signal; return new Response('audio', { headers: { 'Content-Type': 'audio/flac' } });
    } });
    controller.abort(); assert.equal(upstreamSignal.aborted, true); await response.body.cancel();
});

test('Cloudflare entry keeps the website on ASSETS and only handles the exact download path', async () => {
    let calls = 0;
    const env = { ASSETS: { fetch: async original => { calls++; return new Response(new URL(original.url).pathname); } } };
    for (const path of ['/', '/index.html', '/missing', '/proxy-download/other']) {
        const response = await worker.fetch(new Request(`https://player.example${path}`), env);
        assert.equal(await response.text(), path);
    }
    assert.equal(calls, 4);
    const preflight = await worker.fetch(request(null, { method: 'OPTIONS' }), env);
    assert.equal(preflight.status, 204); assert.equal(calls, 4);
});
