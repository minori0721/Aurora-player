import { escapeHtml } from '../shared/text.js';
import { coverImageUrl } from '../shared/cover-url.js';
import { positiveMusicInteger } from './routes.js';
import { createAccountRequest } from './account-request.js';

const PAGE_SIZE = 30;
const PLAYLIST_LIMIT = 3000;
const PLAYLIST_TTL = 60_000;

export function createMyPlaylists({
    api: apiService,
    auth: authService,
    content: contentService
} = {}) {
    const request = createAccountRequest({ api: apiService, auth: authService });
    const consumers = new Set();
    let myPlaylistsCache = null, myPlaylistsData = [];
    let identity = null, job = null, view = null;
    let complete = false, loading = false, error = null, updatedAt = 0, nextOffset = 0;
    let restart = true;
    let songWriteRevision = '', songWriteSequence = 0;

    function snapshot() {
        return { items: myPlaylistsData, complete, loading, error, updatedAt, nextOffset };
    }

    function notify() {
        const state = snapshot();
        for (const consumer of consumers) consumer.update(state);
    }

    function reset() {
        const previous = job;
        job = null;
        previous?.controller.abort();
        view?.controller.abort();
        view = null;
        identity = null;
        myPlaylistsCache = null;
        myPlaylistsData = [];
        complete = loading = false;
        error = null;
        updatedAt = nextOffset = 0;
        restart = true;
    }

    function currentIdentity() {
        const userId = positiveMusicInteger(authService.neteaseUser?.userId, 0);
        if (identity && (identity.userId !== userId || !authService.isAuthSnapshotCurrent(identity.auth))) reset();
        if (!identity && userId) identity = { userId, auth: authService.captureAuthSnapshot() };
        return identity;
    }

    function invalidateAfterSongWrite() {
        songWriteRevision = `${Date.now()}-${++songWriteSequence}`;
        const previous = job;
        job = null;
        previous?.controller.abort();
        view?.controller.abort();
        view = null;
        complete = loading = false;
        updatedAt = nextOffset = 0;
        restart = true;
        error = null;
        myPlaylistsCache = null;
    }

    function startLoad(owner) {
        const active = { controller: new AbortController() };
        const isCurrent = () => job === active && identity === owner
            && !active.controller.signal.aborted && authService.isAuthSnapshotCurrent(owner.auth)
            && positiveMusicInteger(authService.neteaseUser?.userId, 0) === owner.userId;
        const items = new Map((restart ? [] : myPlaylistsData).map(item => [positiveMusicInteger(item.id, 0), item]));
        if (restart) nextOffset = 0;
        restart = false;
        complete = false;
        loading = true;
        error = null;
        job = active;
        active.promise = Promise.resolve().then(async () => {
            try {
                while (isCurrent() && consumers.size) {
                    if (nextOffset >= PLAYLIST_LIMIT) throw new Error('歌单数量达到加载上限');
                    const offset = nextOffset;
                    const body = await request('/user/playlist', { uid: owner.userId, limit: PAGE_SIZE, offset,
                        ...(songWriteRevision ? { songWriteRevision } : {}) }, { signal: active.controller.signal });
                    if (!isCurrent()) throw new DOMException('Cancelled', 'AbortError');
                    if (!Array.isArray(body.playlist) || body.playlist.some(item => !positiveMusicInteger(item?.id, 0))
                        || body.more !== undefined && typeof body.more !== 'boolean') throw new Error('歌单数据格式异常');
                    const page = body.playlist;
                    const more = body.more ?? (page.length >= PAGE_SIZE);
                    const before = items.size;
                    for (const item of page) {
                        items.set(positiveMusicInteger(item.id, 0), item);
                        if (items.size > PLAYLIST_LIMIT) throw new Error('歌单数量超出加载上限');
                    }
                    if (more && (!page.length || items.size === before)) throw new Error('歌单分页未取得进展，请重试');
                    // Offset describes the requested window, not the number of returned or deduplicated rows.
                    nextOffset = offset + PAGE_SIZE;
                    myPlaylistsData = [...items.values()];
                    complete = !more;
                    if (complete) updatedAt = Date.now();
                    notify();
                    if (complete) break;
                }
            } catch (cause) {
                if (isCurrent() && cause.name !== 'AbortError') error = cause;
                throw cause;
            } finally {
                if (job === active) {
                    job = null;
                    loading = false;
                    notify();
                }
            }
            return snapshot();
        });
        return active;
    }

    function ensurePlaylists({ signal, onUpdate } = {}) {
        const owner = currentIdentity();
        if (!owner) return Promise.reject(Object.assign(new Error('请先登录网易云账号'), { name: 'AccountRequestError', apiCode: 301 }));
        if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
        return new Promise((resolve, reject) => {
            const consumer = { update(state) {
                try { onUpdate?.(state); }
                catch (cause) { release(); reject(cause); }
            } };
            const release = () => { consumers.delete(consumer); signal?.removeEventListener('abort', abort); };
            const abort = () => { release(); reject(new DOMException('Cancelled', 'AbortError')); };
            consumers.add(consumer);
            signal?.addEventListener('abort', abort, { once: true });
            const age = Date.now() - updatedAt;
            const fresh = complete && age >= 0 && age < PLAYLIST_TTL;
            if (!fresh && complete) restart = true;
            const active = job || (!fresh ? startLoad(owner) : null);
            consumer.update(snapshot());
            (active?.promise || Promise.resolve(snapshot())).then(state => { release(); resolve(state); }, cause => { release(); reject(cause); });
        });
    }

    function buildMyPlaylistsHtml(playlists, userId, status = {}, owner = '我') {
        const list = Array.isArray(playlists) ? playlists : [];
        if (!list.length && !status.loading && !status.error) return '<div class="netease-empty">暂无歌单</div>';

        let html = '';
        if (status.loading) {
            html += `<div class="playlist-load-status"><span class="playlist-load-message">已加载 ${list.length} 个歌单，后台继续加载...</span></div>`;
        } else if (status.error) {
            html += `<div class="playlist-load-status"><span class="playlist-load-message">${escapeHtml(status.error)}</span><button type="button" class="music-retry-btn" data-my-playlists-retry>重试</button></div>`;
        }

        const created = list.filter(p => positiveMusicInteger(p.creator?.userId, 0) === userId);
        const collected = list.filter(p => positiveMusicInteger(p.creator?.userId, 0) !== userId);
        const renderPlaylist = (p, isCollected) => {
            const id = positiveMusicInteger(p?.id, 0);
            if (!id) return '';
            const cover = coverImageUrl(p.coverImgUrl, 100);
            const subtitle = isCollected
                ? `${escapeHtml(p.trackCount || 0)} 首 · ${escapeHtml(p.creator?.nickname || '')}`
                : `${escapeHtml(p.trackCount || 0)} 首`;
            return `
                <div class="netease-item" data-action="load-playlist" data-id="${id}">
                    <span class="netease-item-cover-link music-image-frame"><img class="netease-item-cover" data-src="${escapeHtml(cover)}" referrerpolicy="no-referrer" alt=""></span>
                    <div class="netease-item-info">
                        <div class="netease-item-name">${escapeHtml(p.name || '未命名歌单')}</div>
                        <div class="netease-item-artist">${subtitle}</div>
                    </div>
                </div>`;
        };

        if (created.length) {
            html += `<div class="my-playlists-title">${escapeHtml(owner)}创建的歌单</div>`;
            html += created.map(p => renderPlaylist(p, false)).join('');
        }
        if (collected.length) {
            html += `<div class="my-playlists-title" style="margin-top:15px">${escapeHtml(owner)}收藏的歌单</div>`;
            html += collected.map(p => renderPlaylist(p, true)).join('');
        }
        return html || '<div class="netease-empty">暂无歌单</div>';
    }

    function renderMyPlaylistsView(userId, state, signal) {
        const container = document.getElementById('mylist-content');
        const html = !state.items.length && state.loading ? '<div class="netease-loading">正在加载首批歌单...</div>'
            : buildMyPlaylistsHtml(state.items, userId, { loading: state.loading && !state.complete,
                error: state.error ? `歌单加载失败，已显示 ${state.items.length} 个` : null });
        if (container.innerHTML !== html) {
            contentService.clearMusicImages(container);
            container.innerHTML = html;
            contentService.observeMusicImages(container);
            container.querySelector('[data-my-playlists-retry]')?.addEventListener('click', () => { void loadMyPlaylists({ signal }); });
        }
        myPlaylistsCache = html;
    }

    function loadMyPlaylists({ signal } = {}) {
        const container = document.getElementById('mylist-content');
        if (!authService.neteaseUser) {
            contentService.clearMusicImages(container);
            container.innerHTML = '<div class="netease-empty">请先登录网易云账号</div>';
            return Promise.resolve();
        }
        currentIdentity();
        if (view && !view.controller.signal.aborted) return view.ready;
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (signal?.aborted) controller.abort();
        else signal?.addEventListener('abort', abort, { once: true });
        let ready;
        const active = { controller, ready: new Promise(resolve => { ready = resolve; }) };
        const owner = identity;
        const initialItems = myPlaylistsData;
        view = active;
        void ensurePlaylists({ signal: controller.signal, onUpdate(state) {
            if (view !== active || identity !== owner || controller.signal.aborted) return;
            renderMyPlaylistsView(owner.userId, state, signal);
            if (state.items !== initialItems || state.complete || state.error) ready();
        } }).catch(() => {}).finally(() => {
            signal?.removeEventListener('abort', abort);
            if (view === active) view = null;
            ready();
        });
        return active.ready;
    }

    return {
        get myPlaylistsCache() { return myPlaylistsCache; },
        get myPlaylistsData() { currentIdentity(); return myPlaylistsData; },
        get myPlaylistsComplete() { return complete; },
        get myPlaylistsLoading() { return loading; },
        get playlistsState() { currentIdentity(); return snapshot(); },
        ensurePlaylists,
        buildPlaylistsHtml: buildMyPlaylistsHtml,
        reset,
        invalidateAfterSongWrite,
        loadMyPlaylists
    };
}
