// 清洗 Cookie，只保留核心凭证（如 MUSIC_U、__csrf），去掉浏览器指令（Max-Age/Expires/Path/Domain/SameSite/Secure/HttpOnly）
function cleanCookie(cookieStr) {
    if (!cookieStr) return '';
    return cookieStr.split(';')
        .map(part => part.trim())
        .filter(part => {
            const lower = part.toLowerCase();
            return !lower.startsWith('max-age=') &&
                   !lower.startsWith('expires=') &&
                   !lower.startsWith('path=') &&
                   !lower.startsWith('domain=') &&
                   !lower.startsWith('samesite=') &&
                   !lower.startsWith('httponly') &&
                   !lower.startsWith('secure');
        })
        .join('; ');
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

export { cleanCookie, escapeHtml, fmtTime, hashCacheScope, toHttps };
