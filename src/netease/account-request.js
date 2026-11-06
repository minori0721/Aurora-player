import { cleanCookie } from '../shared/text.js';

function requestError(message, { name = 'AccountRequestError', apiCode = null, status = null, uncertain = false } = {}) {
    return Object.assign(new Error(message), { name, apiCode, status, uncertain });
}

function safeApiMessage(value, fallback) {
    if (typeof value !== 'string') return fallback;
    return value.slice(0, 2000)
        .replace(/(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>"']+/gi, '[URL]')
        .replace(/\b(?:cookie|set-cookie|[a-z_]*token|authorization|password|secret|csrf|__csrf|music_[a-z_]+)\b["']?\s*(?:[=:]|%3d|\s)\s*[^\r\n]*/gi, '[REDACTED]')
        .replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200) || fallback;
}

// Some endpoints wrap an entire upstream response in body, more than once.
export function normalizeApiBody(payload, { status = null } = {}) {
    let body = payload, confirmed = false;
    const seen = new Set();
    function inspect(value, depth = 0) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 8 || seen.has(value)) {
            throw requestError('账号接口返回格式异常，结果未确认', { status, uncertain: true });
        }
        seen.add(value);
        if (value.code !== undefined) {
            const code = Number(value.code);
            if (code !== 200) throw requestError(safeApiMessage(value.msg ?? value.message, '账号操作失败'), { status, apiCode: Number.isFinite(code) ? code : null });
            confirmed = true;
        }
        if (value.status !== undefined) {
            const innerStatus = Number(value.status);
            if (!Number.isInteger(innerStatus) || innerStatus < 200 || innerStatus >= 300) {
                throw requestError(safeApiMessage(value.msg ?? value.message, '账号操作失败'), { status, apiCode: Number.isFinite(innerStatus) ? innerStatus : null });
            }
        }
        if (value.success === false) throw requestError(safeApiMessage(value.msg ?? value.message, '账号操作失败'), { status });
        if (value.body !== undefined) inspect(value.body, depth + 1);
        if (value.data && typeof value.data === 'object' && !Array.isArray(value.data)
            && ('code' in value.data || 'body' in value.data || 'success' in value.data)) inspect(value.data, depth + 1);
    }
    inspect(payload);
    while (body.body !== undefined) body = body.body;
    if (!confirmed) throw requestError('账号操作结果未确认，请先检查再重试', { status, uncertain: true });
    return body.code === undefined ? { ...body, code: 200 } : body;
}

export function createAccountRequest({ api, auth } = {}) {
    const nonce = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let sequence = 0;
    return async function request(path, data = {}, { signal, timeoutMs = 15000 } = {}) {
        const snapshot = auth.captureAuthSnapshot();
        const controller = new AbortController();
        let timer, abortListener, timedOut = false, started = false, status = null;
        const isCurrent = () => auth.isAuthSnapshotCurrent(snapshot);
        const abortExternal = () => controller.abort();
        const abortedError = () => requestError(timedOut ? '账号请求超时，请先检查操作结果' : '账号请求已取消', {
            name: timedOut ? 'TimeoutError' : 'AbortError', status, uncertain: timedOut && started && (status === null || status >= 200 && status < 300)
        });
        if (signal?.aborted || !isCurrent()) throw abortedError();
        // Account credentials must never enter URLs, including caller-supplied query strings.
        const parsed = new URL(path, 'https://account.invalid');
        if (!path.startsWith('/') || path.startsWith('//') || parsed.hash
            || [...parsed.searchParams.keys()].some(key => /cookie|token|password|csrf/i.test(key))) {
            throw requestError('账号请求路径无效');
        }
        const separator = path.includes('?') ? '&' : '?';
        const url = api.buildApiUrl(`${path}${separator}timestamp=${Date.now()}&accountNonce=${nonce}-${++sequence}`);
        const body = JSON.stringify({ ...data, cookie: cleanCookie(snapshot.cookie) });
        const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 120000) : 15000;
        signal?.addEventListener('abort', abortExternal, { once: true });
        auth.accountAbortControllers?.add(controller);
        const stopped = new Promise((_, reject) => {
            abortListener = () => reject(abortedError());
            controller.signal.addEventListener('abort', abortListener, { once: true });
            timer = setTimeout(() => { timedOut = true; controller.abort(); }, duration);
        });
        try {
            return await Promise.race([stopped, (async () => {
                started = true;
                let response;
                try {
                    response = await fetch(url, {
                        method: 'POST', credentials: 'omit', cache: 'no-store',
                        headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal
                    });
                } catch (_) {
                    if (controller.signal.aborted) throw abortedError();
                    throw requestError('账号请求连接失败，请先检查操作结果', { uncertain: true });
                }
                status = response.status;
                let payload;
                try { payload = await response.json(); }
                catch (_) {
                    if (controller.signal.aborted) throw abortedError();
                    throw requestError(response.ok
                        ? '账号接口响应不完整，请先检查操作结果'
                        : `账号请求失败（HTTP ${status}）`, { status, uncertain: response.ok });
                }
                if (controller.signal.aborted || !isCurrent()) throw abortedError();
                let normalized;
                try { normalized = normalizeApiBody(payload, { status }); }
                catch (error) { if (!response.ok) error.uncertain = false; throw error; }
                if (!response.ok) throw requestError(`账号请求失败（HTTP ${status}）`, { status });
                return normalized;
            })()]);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abortExternal);
            controller.signal.removeEventListener('abort', abortListener);
            auth.accountAbortControllers?.delete(controller);
        }
    };
}
