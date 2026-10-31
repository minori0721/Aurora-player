import { cleanCookie, escapeHtml, toHttps } from '../shared/text.js';
import { positiveMusicInteger } from './routes.js';

export function createMyPlaylists({
    api: apiService,
    auth: authService,
    content: contentService
} = {}) {
    let myPlaylistsCache = null;

    // 我的歌单缓存
    let myPlaylistsData = [];

    let myPlaylistsLoading = false;

    let myPlaylistsLoadPromise = null;

    let myPlaylistsLoadToken = 0;

    let myPlaylistsAbortController = null;

    function buildMyPlaylistsHtml(playlists, userId, status = {}) {
        const list = Array.isArray(playlists) ? playlists : [];
        if (!list.length && !status.loading && !status.error) return '<div class="netease-empty">暂无歌单</div>';

        let html = '';
        if (status.loading) {
            html += `<div class="playlist-load-status"><span class="playlist-load-message">已加载 ${list.length} 个歌单，后台继续加载...</span></div>`;
        } else if (status.error) {
            html += `<div class="playlist-load-status"><span class="playlist-load-message">${escapeHtml(status.error)}</span></div>`;
        }

        const created = list.filter(p => p.creator?.userId === userId);
        const collected = list.filter(p => p.creator?.userId !== userId);
        const renderPlaylist = (p, isCollected) => {
            const id = positiveMusicInteger(p?.id, 0);
            if (!id) return '';
            const cover = toHttps(p.coverImgUrl || '');
            const subtitle = isCollected
                ? `${escapeHtml(p.trackCount || 0)} 首 · ${escapeHtml(p.creator?.nickname || '')}`
                : `${escapeHtml(p.trackCount || 0)} 首`;
            return `
                <div class="netease-item" data-action="load-playlist" data-id="${id}">
                    <img class="netease-item-cover" data-src="${escapeHtml(cover)}?param=100y100" alt="歌单封面">
                    <div class="netease-item-info">
                        <div class="netease-item-name">${escapeHtml(p.name || '未命名歌单')}</div>
                        <div class="netease-item-artist">${subtitle}</div>
                    </div>
                </div>`;
        };

        if (created.length) {
            html += '<div class="my-playlists-title">📁 我创建的歌单</div>';
            html += created.map(p => renderPlaylist(p, false)).join('');
        }
        if (collected.length) {
            html += '<div class="my-playlists-title" style="margin-top:15px">❤️ 我收藏的歌单</div>';
            html += collected.map(p => renderPlaylist(p, true)).join('');
        }
        return html || '<div class="netease-empty">暂无歌单</div>';
    }

    function renderMyPlaylistsView(userId, status = {}) {
        const container = document.getElementById('mylist-content');
        const html = buildMyPlaylistsHtml(myPlaylistsData, userId, status);
        contentService.clearMusicImages(container);
        container.innerHTML = html;
        contentService.observeMusicImages(container);
        return html;
    }

    // 首屏只取一页，后续页在后台按 offset 继续加载。
    async function loadMyPlaylists() {
        const container = document.getElementById('mylist-content');
        if (!authService.neteaseUser) {
            contentService.clearMusicImages(container);
            container.innerHTML = '<div class="netease-empty">请先登录网易云账号</div>';
            return;
        }

        if (myPlaylistsCache) {
            contentService.clearMusicImages(container);
            container.innerHTML = myPlaylistsCache;
            contentService.observeMusicImages(container);
            return;
        }
        if (myPlaylistsLoadPromise) return myPlaylistsLoadPromise;
        if (myPlaylistsLoading) {
            renderMyPlaylistsView(authService.neteaseUser.userId, { loading: true });
            return;
        }

        const snapshot = authService.captureAuthSnapshot();
        const userId = authService.neteaseUser.userId;
        const loadToken = ++myPlaylistsLoadToken;
        const controller = new AbortController();
        myPlaylistsAbortController = controller;
        myPlaylistsData = [];
        myPlaylistsLoading = true;
        contentService.clearMusicImages(container);
        container.innerHTML = '<div class="netease-loading">正在加载首批歌单...</div>';

        const isCurrent = () => !controller.signal.aborted
            && loadToken === myPlaylistsLoadToken
            && authService.isAuthSnapshotCurrent(snapshot)
            && authService.neteaseUser?.userId === userId;
        const playlistMap = new Map();
        const mergePage = page => {
            (Array.isArray(page) ? page : []).forEach(item => {
                const id = positiveMusicInteger(item?.id, 0);
                if (id && !playlistMap.has(id)) playlistMap.set(id, item);
            });
            myPlaylistsData = Array.from(playlistMap.values());
        };
        const fetchPage = async offset => {
            const limit = 30;
            const cookieParam = snapshot.cookie ? `&cookie=${encodeURIComponent(cleanCookie(snapshot.cookie))}` : '';
            const url = apiService.buildApiUrl(`/user/playlist?uid=${userId}&limit=${limit}&offset=${offset}${cookieParam}`);
            const resp = await authService.accountFetch(url, { signal: controller.signal });
            if (!resp.ok) throw new Error(`获取歌单失败: HTTP ${resp.status}`);
            const json = await resp.json();
            if (!isCurrent()) throw new DOMException('stale playlist response', 'AbortError');
            const page = Array.isArray(json?.playlist) ? json.playlist : [];
            const more = json?.more === true || (json?.more === undefined && page.length >= limit);
            return { page, more };
        };

        let backgroundStarted = false;
        const loadMore = async (offset, more) => {
            try {
                let nextOffset = offset;
                let hasMore = more;
                let lastError = null;
                while (hasMore && isCurrent()) {
                    try {
                        const result = await fetchPage(nextOffset);
                        if (!isCurrent()) return;
                        mergePage(result.page);
                        renderMyPlaylistsView(userId, { loading: result.more });
                        nextOffset += result.page.length || 30;
                        hasMore = result.more && result.page.length > 0;
                    } catch (error) {
                        if (error?.name === 'AbortError' || controller.signal.aborted) return;
                        lastError = error;
                        break;
                    }
                }
                if (!isCurrent()) return;
                myPlaylistsLoading = false;
                const html = renderMyPlaylistsView(userId, lastError
                    ? { error: `歌单后台加载失败，已显示 ${myPlaylistsData.length} 个` }
                    : {});
                myPlaylistsCache = html;
            } finally {
                if (myPlaylistsAbortController === controller) myPlaylistsAbortController = null;
            }
        };

        const firstPagePromise = (async () => {
            try {
                const result = await fetchPage(0);
                if (!isCurrent()) return;
                mergePage(result.page);
                renderMyPlaylistsView(userId, { loading: result.more });
                const nextOffset = result.page.length || 30;
                if (result.more && result.page.length) {
                    backgroundStarted = true;
                    void loadMore(nextOffset, true);
                } else {
                    myPlaylistsLoading = false;
                    myPlaylistsCache = renderMyPlaylistsView(userId);
                }
            } catch (error) {
                if (error?.name === 'AbortError' || controller.signal.aborted) return;
                if (isCurrent()) {
                    myPlaylistsLoading = false;
                    contentService.clearMusicImages(container);
                    container.innerHTML = '<div class="netease-empty">加载失败: ' + escapeHtml(error.message) + '</div>';
                }
            } finally {
                if (!backgroundStarted && myPlaylistsAbortController === controller) myPlaylistsAbortController = null;
                if (myPlaylistsLoadPromise === firstPagePromise) myPlaylistsLoadPromise = null;
            }
        })();
        myPlaylistsLoadPromise = firstPagePromise;
        return firstPagePromise;
    }

    return {
        get myPlaylistsCache() { return myPlaylistsCache; },
        set myPlaylistsCache(value) { myPlaylistsCache = value; },
        get myPlaylistsData() { return myPlaylistsData; },
        set myPlaylistsData(value) { myPlaylistsData = value; },
        get myPlaylistsLoading() { return myPlaylistsLoading; },
        set myPlaylistsLoading(value) { myPlaylistsLoading = value; },
        get myPlaylistsLoadPromise() { return myPlaylistsLoadPromise; },
        set myPlaylistsLoadPromise(value) { myPlaylistsLoadPromise = value; },
        get myPlaylistsLoadToken() { return myPlaylistsLoadToken; },
        set myPlaylistsLoadToken(value) { myPlaylistsLoadToken = value; },
        get myPlaylistsAbortController() { return myPlaylistsAbortController; },
        set myPlaylistsAbortController(value) { myPlaylistsAbortController = value; },
        loadMyPlaylists
    };
}
