// Preserve unknown cookie names and values; remove Set-Cookie attributes and keep the last duplicate.
function cleanCookie(cookieStr) {
    if (typeof cookieStr !== 'string') return '';
    const attributes = new Set(['max-age', 'expires', 'path', 'domain', 'samesite', 'httponly', 'secure', 'priority', 'partitioned']);
    const cookies = new Map();
    for (const part of cookieStr.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 1) continue;
        const name = part.slice(0, separator).trim();
        if (!name || attributes.has(name.toLowerCase()) || /[\s\x00-\x1f\x7f]/.test(name)) continue;
        const value = part.slice(separator + 1).trim();
        if (/[\x00-\x1f\x7f]/.test(value)) continue;
        cookies.set(name, value);
    }
    return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

function redactDiagnosticText(value) {
    return String(value ?? '')
        .replace(/https?:\/\/[^\s<>"']+/gi, raw => {
            try {
                const url = new URL(raw);
                if (url.username || url.password) { url.username = 'REDACTED'; url.password = ''; }
                for (const name of [...url.searchParams.keys()]) {
                    if (/^(?:cookie|token|key|csrf|__csrf|music_[a-z_]+|captcha|password|phone)$/i.test(name)) url.searchParams.set(name, '[REDACTED]');
                }
                return url.toString();
            } catch (_) { return '[无效地址]'; }
        })
        .replace(/\b(?:cookie|token|key|csrf|__csrf|music_[a-z_]+|captcha|password)\s*(?:=|:|%3d)[^\r\n]*/gi, match => `${match.split(/=|:|%3d/i)[0].trim()}=[REDACTED]`);
}

// 强制将第三方资源 URL 统一升级为 https，避免 Mixed Content
function toHttps(url) {
    return (url || '').replace(/^http:\/\//i, 'https://');
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[ch]);
}

function hashCacheScope(value) {
    let hash = 0;
    const input = String(value || '');
    for (let i = 0; i < input.length; i++) hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
    return Math.abs(hash).toString(36);
}

function fmtTime(s) { const m = Math.floor(s/60); const sc = Math.floor(s%60); return `${m.toString().padStart(2,'0')}:${sc.toString().padStart(2,'0')}`; }

export { cleanCookie, escapeHtml, fmtTime, hashCacheScope, redactDiagnosticText, toHttps };
