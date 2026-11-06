const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, If-Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Disposition, Accept-Ranges',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
};
const AUDIO_HEADERS = ['Content-Type', 'Content-Length', 'Content-Range', 'Content-Encoding', 'Accept-Ranges', 'ETag', 'Last-Modified'];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function audioTarget(raw, base) {
    const url = new URL(raw, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && url.port !== '443') {
        throw new Error('Invalid audio URL');
    }
    if (url.hostname !== 'music.126.net' && !url.hostname.endsWith('.music.126.net')) throw new Error('Unsupported audio host');
    url.protocol = 'https:';
    url.hash = '';
    return url;
}

function attachmentName(raw) {
    const name = Array.from((raw || 'music.mp3').replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '_').trim()).slice(0, 180).join('') || 'music.mp3';
    const ascii = name.replace(/[^\x20-\x7e]/g, '_');
    const encoded = encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function proxyDownload(request, { fetchImpl = fetch, headerTimeoutMs = 15_000 } = {}) {
    const headers = new Headers(CORS_HEADERS);
    const reply = (message, status) => {
        headers.set('Content-Type', 'text/plain; charset=utf-8');
        return new Response(request.method === 'HEAD' ? null : message, { status, headers });
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!['GET', 'HEAD'].includes(request.method)) {
        headers.set('Allow', 'GET, HEAD, OPTIONS');
        return reply('不支持的请求方法', 405);
    }
    const params = new URL(request.url).searchParams;
    if (!params.get('url')) return reply('缺少音频地址', 400);
    let target;
    try { target = audioTarget(params.get('url')); }
    catch { return reply('仅支持网易云音频 CDN 地址', 400); }
    const upstreamHeaders = new Headers({ Referer: 'https://music.163.com/',
        'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' });
    const range = request.headers.get('Range');
    if (range) {
        if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return reply('无效的 Range', 400);
        upstreamHeaders.set('Range', range);
        if (request.headers.has('If-Range')) upstreamHeaders.set('If-Range', request.headers.get('If-Range'));
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const timeout = setTimeout(() => controller.abort(), headerTimeoutMs);
    let upstream;
    try {
        // Validate every redirect before fetching; never forward account headers or buffer audio.
        for (let hop = 0; hop <= 3; hop++) {
            upstream = await fetchImpl(target.href, { method: request.method, headers: upstreamHeaders, redirect: 'manual',
                signal, cf: { cacheTtl: 0 } });
            if (!REDIRECTS.has(upstream.status)) break;
            await upstream.body?.cancel();
            if (hop === 3 || !upstream.headers.has('Location')) return reply('音频重定向异常', 502);
            try { target = audioTarget(upstream.headers.get('Location'), target); }
            catch { return reply('音频重定向地址不受支持', 502); }
        }
    } catch {
        return reply(controller.signal.aborted ? '音频源响应超时，请重试' : '音频源连接失败，请重试', controller.signal.aborted ? 504 : 502);
    } finally {
        clearTimeout(timeout);
    }
    if (![200, 206].includes(upstream.status)) {
        await upstream.body?.cancel();
        if (upstream.status === 416 && upstream.headers.has('Content-Range')) headers.set('Content-Range', upstream.headers.get('Content-Range'));
        return reply('音频源暂不可用，请重新获取下载链接', upstream.status >= 400 ? upstream.status : 502);
    }
    if (/^(?:text\/|application\/(?:json|xml))/i.test(upstream.headers.get('Content-Type') || '')) {
        await upstream.body?.cancel();
        return reply('音频源返回了非音频内容', 502);
    }
    for (const name of AUDIO_HEADERS) if (upstream.headers.has(name)) headers.set(name, upstream.headers.get(name));
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
    headers.set('Content-Disposition', attachmentName(params.get('filename')));
    if (request.method === 'HEAD') await upstream.body?.cancel();
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
}
