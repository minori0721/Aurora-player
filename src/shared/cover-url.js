import { toHttps } from './text.js';

const ALIAS_LIMIT = 512;
const isNetEase = url => /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.port
    && /(^|\.)music\.126\.net$/i.test(url.hostname);
const isStill = url => !/\.(gif|apng|webp)$/i.test(url.pathname);
const squareSize = url => {
    const sizes = url.searchParams.getAll('param');
    return sizes.length === 1 && /^([1-9]\d*)y\1$/.test(sizes[0]);
};
const canAlias = url => isNetEase(url) && /^p[1-9]\d*\.music\.126\.net$/i.test(url.hostname)
    && /^\/[\w-]+={0,2}\/\d+\.(jpg|jpeg|png)$/i.test(url.pathname) && !url.hash
    && (!url.search || (squareSize(url) && [...url.searchParams.keys()].every(name => name === 'param')));

export function coverImageKey(source) {
    try {
        const url = new URL(toHttps(source));
        if (canAlias(url)) url.hostname = 'p3.music.126.net';
        if (isNetEase(url) && isStill(url) && squareSize(url)) url.searchParams.delete('param');
        return url.href;
    } catch (_) { return source; }
}

export function createCoverImageUrls() {
    const aliases = new Map();
    function remember(url) {
        const key = coverImageKey(url.href);
        aliases.delete(key);
        aliases.set(key, url.hostname);
        if (aliases.size > ALIAS_LIMIT) aliases.delete(aliases.keys().next().value);
    }
    function imageUrl(source, size = 0) {
        const src = toHttps(source);
        try {
            const url = new URL(src);
            if (!isNetEase(url) || !isStill(url)) return src;
            // Keep the first CDN host for a plain catalog image, across display sizes.
            if (canAlias(url)) {
                const key = coverImageKey(src), host = aliases.get(key) || url.hostname;
                url.hostname = host;
                remember(url);
            }
            if (Number.isInteger(size) && size > 0) url.searchParams.set('param', `${size}y${size}`);
            return url.href;
        } catch (_) { return src; }
    }
    function retryUrl(source) {
        try {
            const url = new URL(source);
            if (!canAlias(url)) return '';
            url.hostname = url.hostname === 'p3.music.126.net' ? 'p4.music.126.net' : 'p3.music.126.net';
            remember(url);
            return url.href;
        } catch (_) { return ''; }
    }
    return { url: imageUrl, retryUrl };
}

const shared = createCoverImageUrls();
export const coverImageUrl = shared.url;
export const retryCoverImageUrl = shared.retryUrl;
