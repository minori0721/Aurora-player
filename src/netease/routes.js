const MUSIC_ROUTE_PREFIX = '#music/';

const MUSIC_SEARCH_TYPES = new Set(['all', 'song', 'album', 'artist']);

const MUSIC_ARTIST_VIEWS = new Set(['overview', 'songs', 'albums', 'mvs']);

function positiveMusicInteger(value, fallback = null) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function parseMusicRoute(hash = window.location.hash) {
    if (!hash || !hash.startsWith(MUSIC_ROUTE_PREFIX)) return null;
    const source = hash.slice(MUSIC_ROUTE_PREFIX.length);
    const splitAt = source.indexOf('?');
    const path = (splitAt >= 0 ? source.slice(0, splitAt) : source).replace(/^\/+|\/+$/g, '');
    const params = new URLSearchParams(splitAt >= 0 ? source.slice(splitAt + 1) : '');
    const parts = path.split('/').filter(Boolean);

    if (parts[0] === 'search' && parts.length === 1) {
        const type = MUSIC_SEARCH_TYPES.has(params.get('type')) ? params.get('type') : 'all';
        return {
            kind: 'search',
            q: (params.get('q') || '').slice(0, 200),
            type,
            page: positiveMusicInteger(params.get('page'), 1)
        };
    }
    if (parts[0] === 'album' && parts.length === 2) {
        const id = positiveMusicInteger(parts[1]);
        return id ? { kind: 'album', id } : { kind: 'invalid', reason: '专辑 ID 无效' };
    }
    if (parts[0] === 'artist' && parts.length === 2) {
        const id = positiveMusicInteger(parts[1]);
        if (!id) return { kind: 'invalid', reason: '歌手 ID 无效' };
        const view = MUSIC_ARTIST_VIEWS.has(params.get('view')) ? params.get('view') : 'overview';
        return { kind: 'artist', id, view, page: positiveMusicInteger(params.get('page'), 1) };
    }
    if (path === 'playlists/import') return { kind: 'playlist-import' };
    if (path === 'playlists/mine') return { kind: 'playlist-mine' };
    return { kind: 'invalid', reason: '这个音乐页面不存在' };
}

function buildMusicHash(route) {
    if (!route || route.kind === 'search') {
        const params = new URLSearchParams();
        const query = String(route?.q || '').slice(0, 200);
        const type = MUSIC_SEARCH_TYPES.has(route?.type) ? route.type : 'all';
        const page = positiveMusicInteger(route?.page, 1);
        if (query) params.set('q', query);
        params.set('type', type);
        params.set('page', String(page));
        return `${MUSIC_ROUTE_PREFIX}search?${params.toString()}`;
    }
    if (route.kind === 'album') return `${MUSIC_ROUTE_PREFIX}album/${positiveMusicInteger(route.id, 0)}`;
    if (route.kind === 'artist') {
        const params = new URLSearchParams();
        params.set('view', MUSIC_ARTIST_VIEWS.has(route.view) ? route.view : 'overview');
        params.set('page', String(positiveMusicInteger(route.page, 1)));
        return `${MUSIC_ROUTE_PREFIX}artist/${positiveMusicInteger(route.id, 0)}?${params.toString()}`;
    }
    if (route.kind === 'playlist-import') return `${MUSIC_ROUTE_PREFIX}playlists/import`;
    if (route.kind === 'playlist-mine') return `${MUSIC_ROUTE_PREFIX}playlists/mine`;
    return `${MUSIC_ROUTE_PREFIX}search?type=all&page=1`;
}

function getMusicRouteTitle(route) {
    if (!route) return '网易云音乐';
    if (route.kind === 'search') return route.q ? `搜索：${route.q}` : '网易云音乐';
    if (route.kind === 'album') return '专辑';
    if (route.kind === 'artist') return '歌手';
    if (route.kind === 'playlist-import') return '导入歌单';
    if (route.kind === 'playlist-mine') return '我的歌单';
    return '页面不可用';
}

export { MUSIC_ROUTE_PREFIX, buildMusicHash, getMusicRouteTitle, parseMusicRoute, positiveMusicInteger };
