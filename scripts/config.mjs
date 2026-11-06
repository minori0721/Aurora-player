export const DEFAULT_CONFIG = Object.freeze({
    API_BASE_URL: 'https://musicproxy.minori.eu.cc',
    DOWNLOAD_PROXY_URL: 'https://music.moerika.com/proxy-download'
});

export function isCloudflareBuild(env = {}) {
    return env.CF_PAGES === '1' || env.WORKERS_CI === '1';
}

export function readPublicConfig(env = {}, { cloudflare = isCloudflareBuild(env) } = {}) {
    return Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([name, fallback]) => {
        const configured = String(env[name] || '').trim();
        if (name === 'DOWNLOAD_PROXY_URL' && !configured && cloudflare) return [name, '/proxy-download'];
        const value = (configured || fallback).replace(/\/+$/, '');
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            throw new Error(`${name} must be an HTTP(S) base URL without credentials, query or fragment`);
        }
        return [name, value];
    }));
}

export function inlineScript(source) {
    return source.replace(/<\/script/gi, '<\\/script');
}
