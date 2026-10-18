export const DEFAULT_CONFIG = Object.freeze({
    API_BASE_URL: 'https://musicproxy.minori.eu.cc',
    DOWNLOAD_PROXY_URL: 'https://proxy.minori0721.dpdns.org'
});

export function readPublicConfig(env = {}) {
    return Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([name, fallback]) => {
        const value = String(env[name] || fallback).trim().replace(/\/+$/, '');
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
