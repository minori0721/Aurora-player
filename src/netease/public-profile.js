import { escapeHtml } from '../shared/text.js';
import { coverImageUrl } from '../shared/cover-url.js';
import { positiveMusicInteger } from './routes.js';
import { GUEST_PLAYLIST_COOKIE } from './playlist-access.js';

const STORAGE_KEY = 'aurora_public_profile';
const PAGE_SIZE = 30;
const SEARCH_SIZE = 20;
const CACHE_TTL = 60_000;

export function parsePublicProfileInput(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    if (/^\d+$/.test(text)) {
        const id = positiveMusicInteger(text);
        return id ? { id } : null;
    }
    if (/^(?:https?:\/\/|(?:y\.)?music\.163\.com\/)/i.test(text)) {
        try {
            const url = new URL(/^https?:/i.test(text) ? text : `https://${text}`);
            if (!['music.163.com', 'y.music.163.com'].includes(url.hostname) || url.username || url.password) return null;
            const route = url.hash.startsWith('#/') ? new URL(url.hash.slice(1), url.origin) : url;
            const id = /\/(?:m\/)?user\/home\/?$/.test(route.pathname) ? positiveMusicInteger(route.searchParams.get('id')) : null;
            return id ? { id } : null;
        } catch (_) { return null; }
    }
    return { query: text.slice(0, 200) };
}

export function normalizePublicProfile(value) {
    const userId = positiveMusicInteger(value?.userId);
    if (!userId) return null;
    const avatar = String(value.avatarUrl || '');
    return { userId, nickname: String(value.nickname || `用户 ${userId}`).slice(0, 100),
        avatarUrl: /^https?:\/\//i.test(avatar) ? coverImageUrl(avatar, 100) : '' };
}

export function createPublicProfile({
    api, auth, browser, content, myPlaylists, transfer
} = {}, { document: doc = document, storage = localStorage, now = () => Date.now() } = {}) {
    const node = id => doc.getElementById(id);
    const cache = new Map();
    let remembered = null, selected = null, pendingSelection = null, search = null, initialized = false;
    try { remembered = normalizePublicProfile(JSON.parse(storage.getItem(STORAGE_KEY))); } catch (_) {}

    async function request(path, params, signal, valid) {
        const query = new URLSearchParams({ ...params, cookie: GUEST_PLAYLIST_COOKIE, noCookie: 'true' });
        const url = api.buildApiUrl(`${path}?${query}`);
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const cached = cache.get(url);
        if (cached && now() - cached.at < CACHE_TTL) return cached.data;
        // This explicit guest cookie also overrides any account configured on the API server.
        const json = await transfer.fetchJsonWithStageTimeout(url, { signal, credentials: 'omit', cache: 'no-store' }, 15000, '公开资料获取超时');
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const data = json?.body || json;
        if (Number(data?.code) !== 200) throw new Error(Number(data?.code) === 301 ? '该内容未公开或需要登录' : '公开资料获取失败，请重试');
        if (!valid(data)) throw new Error('公开资料返回不完整，请重试');
        cache.delete(url); cache.set(url, { at: now(), data });
        while (cache.size > 24) cache.delete(cache.keys().next().value);
        return data;
    }

    function remember(profile) {
        try {
            if (profile) storage.setItem(STORAGE_KEY, JSON.stringify(profile));
            else storage.removeItem(STORAGE_KEY);
            remembered = profile;
            return true;
        } catch (_) { return false; }
    }

    function status(message = '', error = false) {
        const target = node('public-profile-status');
        target.textContent = message;
        target.dataset.state = error ? 'error' : '';
    }

    function replaceImages(target, html) {
        content.clearMusicImages(target);
        target.innerHTML = html;
        content.observeMusicImages(target);
    }

    function choose(userId) {
        pendingSelection = { userId, remember: node('public-profile-remember').checked };
        browser.navigateMusic({ kind: 'user-playlists', id: userId });
    }

    function profileButton(profile) {
        return `<button type="button" class="public-profile-result" data-public-user="${profile.userId}" aria-label="查看 ${escapeHtml(profile.nickname)} 的公开歌单">
            <span class="public-profile-avatar music-image-frame">${profile.avatarUrl ? `<img data-src="${escapeHtml(profile.avatarUrl)}" alt="" referrerpolicy="no-referrer">` : ''}</span>
            <span class="public-profile-info"><strong>${escapeHtml(profile.nickname)}</strong><small>UID ${profile.userId}</small></span>
            <span class="public-profile-arrow" aria-hidden="true">›</span></button>`;
    }

    function cancelSearch() {
        const previous = search;
        search = null;
        previous?.controller.abort();
        if (initialized) node('public-profile-submit').disabled = false;
    }

    async function loadSearch(value, offset) {
        if (search !== value || value.busy) return;
        value.busy = true;
        node('public-profile-submit').disabled = true;
        node('public-profile-results').querySelector('[data-public-more]')?.setAttribute('disabled', '');
        status('正在查找用户...');
        try {
            const data = await request('/search', { keywords: value.query, type: '1002', limit: String(SEARCH_SIZE), offset: String(offset) },
                value.controller.signal, data => Array.isArray(data.result?.userprofiles));
            if (search !== value) return;
            for (const raw of data.result.userprofiles) {
                const profile = normalizePublicProfile(raw);
                if (profile) value.items.set(profile.userId, profile);
            }
            const more = data.result.hasMore ?? (Number(data.result.userprofileCount) > offset + SEARCH_SIZE);
            const target = node('public-profile-results');
            replaceImages(target, [...value.items.values()].map(profileButton).join('')
                + (more ? '<button type="button" class="login-secondary public-profile-more" data-public-more>更多结果</button>' : ''));
            target.querySelector('[data-public-more]')?.addEventListener('click', () => { void loadSearch(value, offset + SEARCH_SIZE); });
            status(value.items.size ? '' : '未找到用户，请换个昵称或输入用户 ID');
        } catch (error) {
            if (search === value && error.name !== 'AbortError') status(error.message, true);
        } finally {
            if (search === value) {
                value.busy = false;
                node('public-profile-submit').disabled = false;
                node('public-profile-results').querySelector('[data-public-more]')?.removeAttribute('disabled');
            }
        }
    }

    function submit(event) {
        event?.preventDefault();
        if (search?.busy) return;
        const input = parsePublicProfileInput(node('public-profile-query').value);
        cancelSearch(); status();
        replaceImages(node('public-profile-results'), '');
        if (!input) { status('请输入有效的昵称、用户 ID 或网易云用户主页链接', true); return; }
        if (input.id) { choose(input.id); return; }
        search = { query: input.query, controller: new AbortController(), busy: false, items: new Map() };
        return loadSearch(search, 0);
    }

    function openSearch() {
        cancelSearch(); status();
        replaceImages(node('public-profile-results'), remembered
            ? `<div class="public-profile-saved-label">已记住的主页</div>${profileButton(remembered)}` : '');
    }

    async function renderPlaylistsPage(userId, { signal } = {}) {
        const target = node('mylist-content');
        if (!userId) {
            replaceImages(target, '<div class="netease-empty"><p>尚未选择公开主页</p><button type="button" class="music-action-btn" data-action="browse-public">免登录浏览</button></div>');
            return;
        }
        replaceImages(target, '<div class="netease-loading">正在读取公开歌单...</div>');
        const items = new Map();
        let profile = null, offset = 0, more = true, busy = false, error = '';
        const validPage = data => Array.isArray(data.playlist) && data.playlist.every(item => positiveMusicInteger(item?.id))
            && (data.more === undefined || typeof data.more === 'boolean');

        function paint() {
            if (signal.aborted) return;
            const isRemembered = remembered?.userId === profile.userId;
            const header = `<div class="public-profile-header">
                <span class="public-profile-avatar music-image-frame">${profile.avatarUrl ? `<img data-src="${escapeHtml(profile.avatarUrl)}" alt="" referrerpolicy="no-referrer">` : ''}</span>
                <div class="public-profile-info"><small>公开浏览</small><strong>${escapeHtml(profile.nickname)}</strong><small>UID ${profile.userId}</small></div>
                <div class="public-profile-tools"><button type="button" class="music-action-btn" data-public-remember>${isRemembered ? '取消记住' : '记住主页'}</button><button type="button" class="music-action-btn" data-action="browse-public">更换用户</button></div>
                </div>`;
            replaceImages(target, header + (items.size ? myPlaylists.buildPlaylistsHtml([...items.values()], profile.userId, {}, 'TA')
                : '<div class="netease-empty">暂无公开歌单</div>')
                + `<div class="public-profile-footer"><span role="status">${escapeHtml(error || `已显示 ${items.size} 个歌单`)}</span>${more ? `<button type="button" class="music-action-btn" data-public-page${busy ? ' disabled' : ''}>${busy ? '加载中...' : error ? '重试' : '加载更多'}</button>` : ''}</div>`);
            for (const row of target.querySelectorAll('[data-action="load-playlist"]')) {
                row.tabIndex = 0;
                row.setAttribute('role', 'button');
                row.onkeydown = event => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); }
                };
            }
            target.querySelector('[data-public-remember]').onclick = () => {
                if (!remember(isRemembered ? null : profile)) error = '无法记住此主页，下次需重新选择';
                paint();
            };
            target.querySelector('[data-public-page]')?.addEventListener('click', () => { void nextPage(); });
        }

        function appendPage(data) {
            const before = items.size;
            for (const item of data.playlist) if (Number(item.privacy) !== 10) items.set(Number(item.id), item);
            more = data.more ?? (data.playlist.length >= PAGE_SIZE);
            if (more && items.size === before) throw new Error('歌单分页未取得进展，请重试');
            offset += PAGE_SIZE;
        }

        async function nextPage() {
            if (busy || !more || signal.aborted) return;
            busy = true; error = ''; paint();
            try {
                const data = await request('/user/playlist', { uid: String(userId), limit: String(PAGE_SIZE), offset: String(offset) }, signal, validPage);
                if (!signal.aborted) appendPage(data);
            } catch (cause) { if (!signal.aborted) error = cause.message; }
            finally { busy = false; paint(); }
        }

        try {
            const [detail, page] = await Promise.all([
                request('/user/detail', { uid: String(userId) }, signal, data => normalizePublicProfile(data.profile)?.userId === userId),
                request('/user/playlist', { uid: String(userId), limit: String(PAGE_SIZE), offset: '0' }, signal, validPage)
            ]);
            if (signal.aborted) return;
            profile = normalizePublicProfile(detail.profile);
            appendPage(page);
            selected = profile;
            if (!auth.neteaseUser) {
                const tab = doc.querySelector('.netease-tab[data-tab="mylist"]');
                if (tab) tab.textContent = '公开歌单';
            }
            if (pendingSelection?.userId === userId) {
                if (pendingSelection.remember && !remember(profile)) error = '无法记住此主页，下次需重新选择';
                pendingSelection = null;
            }
            paint();
        } catch (cause) {
            if (signal.aborted) return;
            replaceImages(target, `<div class="music-browser-state"><strong>${escapeHtml(cause.message)}</strong><button type="button" class="music-action-btn" data-public-retry>重试</button><button type="button" class="music-action-btn" data-action="browse-public">更换用户</button></div>`);
            target.querySelector('[data-public-retry]').onclick = () => { void renderPlaylistsPage(userId, { signal }); };
        }
    }

    return {
        get currentUserId() { return selected?.userId || remembered?.userId || null; },
        cancelSearch, openSearch, renderPlaylistsPage,
        initialize() {
            if (initialized) return;
            initialized = true;
            node('public-profile-form').onsubmit = submit;
            node('public-profile-query').oninput = () => { cancelSearch(); status(); replaceImages(node('public-profile-results'), ''); };
            node('public-profile-results').addEventListener('click', event => {
                const userId = positiveMusicInteger(event.target.closest?.('[data-public-user]')?.dataset.publicUser);
                if (userId) choose(userId);
            });
        }
    };
}
