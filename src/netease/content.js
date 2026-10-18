import { cleanCookie, escapeHtml, fmtTime, toHttps } from '../shared/text.js';
import { parseMusicRoute, positiveMusicInteger } from './routes.js';
import { normalizeMusicAlbum, normalizeMusicArtist, normalizeMusicSong } from './models.js';

export function createContent({
    api: apiService,
    auth: authService,
    browser: browserService,
    cache: cacheService,
    covers: coversService,
    debug: debugService,
    dom: domService,
    onlinePlaylist: onlinePlaylistService,
    playback: playbackService,
    playlistView: playlistViewService,
    prefetch: prefetchService,
    queue: queueService
} = {}) {
    const MUSIC_FALLBACK_COVER = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" rx="12" fill="#e8edf3"/><circle cx="80" cy="80" r="42" fill="#c7d2de"/><circle cx="80" cy="80" r="12" fill="#f8fbff"/></svg>');

    const MUSIC_FALLBACK_ARTIST = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" rx="80" fill="#e8edf3"/><circle cx="80" cy="62" r="28" fill="#c7d2de"/><path d="M31 145c5-31 24-48 49-48s44 17 49 48" fill="#c7d2de"/></svg>');

    const musicImageObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const image = entry.target;
            const source = image.dataset.src;
            if (source) image.src = toHttps(source);
            image.removeAttribute('data-src');
            observer.unobserve(image);
        });
    }, { rootMargin: '240px 0px', threshold: 0.01 });

    function observeMusicImages(root = document) {
        root.querySelectorAll?.('img[data-src]').forEach(image => musicImageObserver.observe(image));
    }

    function musicArtistLinksHtml(artists) {
        const list = (artists || []).filter(artist => artist?.name);
        if (!list.length) return '<span>未知歌手</span>';
        return list.map((artist, index) => {
            const separator = index ? '<span class="music-separator">,</span>' : '';
            if (!artist.id) return `${separator}<span>${escapeHtml(artist.name)}</span>`;
            return `${separator}<button class="music-link" data-music-artist="${artist.id}">${escapeHtml(artist.name)}</button>`;
        }).join('');
    }

    function musicAlbumLinkHtml(album) {
        if (!album?.name) return '';
        if (!album.id) return `<span>${escapeHtml(album.name)}</span>`;
        return `<button class="music-link" data-music-album="${album.id}">${escapeHtml(album.name)}</button>`;
    }

    const MUSIC_CONTEXT_MAX_ENTRIES = 24;

    function getMusicContextStableKey(meta = {}) {
        if (meta.contextKey) return String(meta.contextKey);
        if (!meta.sourceType) return '';
        return [meta.sourceType, meta.sourceId || meta.title || '', meta.page || 0].join('|');
    }

    function registerMusicContext(songs, meta = {}) {
        const normalized = (songs || []).map(normalizeMusicSong).filter(song => song.id);
        const stableKey = getMusicContextStableKey(meta);
        const id = stableKey ? `music-context-${stableKey}` : `music-context-${++browserService.musicBrowserState.contextSeed}`;
        browserService.musicBrowserState.contexts.delete(id);
        browserService.musicBrowserState.contexts.set(id, { songs: normalized, meta });
        while (browserService.musicBrowserState.contexts.size > MUSIC_CONTEXT_MAX_ENTRIES) {
            browserService.musicBrowserState.contexts.delete(browserService.musicBrowserState.contexts.keys().next().value);
        }
        return id;
    }

    function renderMusicSongRows(songs, container, meta = {}, queueSongs = songs) {
        const normalizedRows = (songs || []).map(normalizeMusicSong).filter(song => song.id);
        const contextId = registerMusicContext(queueSongs, meta);
        const queue = browserService.musicBrowserState.contexts.get(contextId)?.songs || [];
        const queueIndexById = new Map();
        queue.forEach((song, index) => { if (!queueIndexById.has(song.id)) queueIndexById.set(song.id, index); });
        const fragment = document.createDocumentFragment();

        normalizedRows.forEach(song => {
            const queueIndex = queueIndexById.get(song.id) ?? 0;
            const item = document.createElement('div');
            item.className = 'netease-item';
            item.dataset.musicContext = contextId;
            item.dataset.musicIndex = String(queueIndex);
            const cover = song.picUrl ? `${song.picUrl}?param=120y120` : MUSIC_FALLBACK_COVER;
            const coverHtml = song.album.id
                ? `<button class="netease-item-cover-link" data-music-album="${song.album.id}" aria-label="打开专辑 ${escapeHtml(song.album.name)}"><img class="netease-item-cover" data-src="${escapeHtml(cover)}" loading="lazy" referrerpolicy="no-referrer" alt=""></button>`
                : `<span class="netease-item-cover-link"><img class="netease-item-cover" data-src="${escapeHtml(cover)}" loading="lazy" referrerpolicy="no-referrer" alt=""></span>`;
            item.innerHTML = `
                ${coverHtml}
                <div class="netease-item-info">
                    <button class="netease-item-name-btn" data-music-play aria-label="播放 ${escapeHtml(song.name)}">${escapeHtml(song.name)}</button>
                    <div class="netease-item-secondary">
                        ${musicArtistLinksHtml(song.artists)}
                        ${song.album.name ? `<span class="music-separator">&middot;</span>${musicAlbumLinkHtml(song.album)}` : ''}
                    </div>
                </div>
                <span class="netease-item-duration">${fmtTime(song.durationMs / 1000)}</span>
                <button class="netease-item-play" data-music-play aria-label="播放 ${escapeHtml(song.name)}">&#9654;</button>`;
            item.querySelectorAll('img').forEach(image => {
                image.addEventListener('error', () => { image.src = MUSIC_FALLBACK_COVER; }, { once: true });
            });
            fragment.appendChild(item);
        });
        container.appendChild(fragment);
        observeMusicImages(container);
        return contextId;
    }

    function renderMusicPagination(container, page, hasNext, onPage, total = 0) {
        if (page <= 1 && !hasNext) return;
        const pagination = document.createElement('div');
        pagination.className = 'music-pagination';
        const previous = document.createElement('button');
        previous.textContent = '上一页';
        previous.disabled = page <= 1;
        previous.onclick = () => onPage(page - 1);
        const label = document.createElement('span');
        label.textContent = total ? `第 ${page} 页，共 ${total} 项` : `第 ${page} 页`;
        const next = document.createElement('button');
        next.textContent = '下一页';
        next.disabled = !hasNext;
        next.onclick = () => onPage(page + 1);
        pagination.append(previous, label, next);
        container.appendChild(pagination);
    }

    async function activateOnlineMusicContext(contextId, selectedIndex = 0, shuffle = false) {
        const context = browserService.musicBrowserState.contexts.get(contextId);
        if (!context?.songs?.length) return;
        let songs = context.songs.slice();
        let index = Math.max(0, Math.min(songs.length - 1, Number(selectedIndex) || 0));
        if (shuffle) {
            for (let i = songs.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [songs[i], songs[j]] = [songs[j], songs[i]];
            }
            index = 0;
        }
        try { prefetchService.cancelNextPreload(); } catch (_) {}
        playbackService.beginPlaybackAction();
        queueService.playlist = songs.map(song => ({
            name: `${song.name} - ${song.artists.map(artist => artist.name).join(', ')}`,
            netease: true,
            songId: song.id,
            songData: song.songData,
            context: { ...context.meta }
        }));
        queueService.activePlaylistQueueToken = null;
        queueService.playlistPendingAdvance = false;
        queueService.curIdx = -1;
        playlistViewService.renderPlaylist();
        await queueService.playTrackFromPlaylist(index);
        updateMusicMiniPlayer();
    }

    async function fetchMusicSearch(type, keyword, limit, offset, signal) {
        const endpointTypes = { song: 1, album: 10, artist: 100 };
        const apiType = endpointTypes[type];
        if (!apiType) throw new Error('不支持的搜索类型');
        const path = `/cloudsearch?keywords=${encodeURIComponent(keyword)}&type=${apiType}&limit=${limit}&offset=${offset}`;
        const json = await cacheService.cachedFetchJson(apiService.buildApiUrl(path), { signal, useQueue: true }, 300_000);
        if (json?.code !== 200 || !json.result) throw new Error('搜索接口返回异常');
        if (type === 'song') return { items: json.result.songs || [], total: Number(json.result.songCount || 0) };
        if (type === 'album') return { items: json.result.albums || [], total: Number(json.result.albumCount || 0) };
        return { items: json.result.artists || [], total: Number(json.result.artistCount || 0) };
    }

    function renderMusicAlbumCards(albums, container) {
        const grid = document.createElement('div');
        grid.className = 'music-card-grid';
        (albums || []).map(normalizeMusicAlbum).filter(album => album.id).forEach(album => {
            const card = document.createElement('div');
            card.className = 'music-card';
            const cover = album.picUrl ? `${album.picUrl}?param=320y320` : MUSIC_FALLBACK_COVER;
            card.innerHTML = `
                <button class="music-card-button" data-music-album="${album.id}" aria-label="打开专辑 ${escapeHtml(album.name)}">
                    <img class="music-card-image" data-src="${escapeHtml(cover)}" loading="lazy" referrerpolicy="no-referrer" alt="">
                    <div class="music-card-title">${escapeHtml(album.name)}</div>
                </button>
                <div class="music-card-subtitle">${musicArtistLinksHtml(album.artists)}</div>`;
            card.querySelector('img').addEventListener('error', event => { event.currentTarget.src = MUSIC_FALLBACK_COVER; }, { once: true });
            grid.appendChild(card);
        });
        container.appendChild(grid);
        observeMusicImages(grid);
    }

    function renderMusicArtistCards(artists, container) {
        const grid = document.createElement('div');
        grid.className = 'music-card-grid';
        (artists || []).map(normalizeMusicArtist).filter(artist => artist.id).forEach(artist => {
            const card = document.createElement('div');
            card.className = 'music-card artist';
            const cover = artist.picUrl ? `${artist.picUrl}?param=320y320` : MUSIC_FALLBACK_ARTIST;
            card.innerHTML = `
                <button class="music-card-button" data-music-artist="${artist.id}" aria-label="打开歌手 ${escapeHtml(artist.name)}">
                    <img class="music-card-image" data-src="${escapeHtml(cover)}" loading="lazy" referrerpolicy="no-referrer" alt="">
                    <div class="music-card-title">${escapeHtml(artist.name)}</div>
                    <div class="music-card-subtitle">${artist.albumSize ? `${artist.albumSize} 张专辑` : '歌手'}</div>
                </button>`;
            card.querySelector('img').addEventListener('error', event => { event.currentTarget.src = MUSIC_FALLBACK_ARTIST; }, { once: true });
            grid.appendChild(card);
        });
        container.appendChild(grid);
        observeMusicImages(grid);
    }

    function createMusicSection(title, more = null) {
        const section = document.createElement('section');
        section.className = 'music-section';
        const header = document.createElement('div');
        header.className = 'music-section-header';
        header.innerHTML = `<h4 class="music-section-title">${escapeHtml(title)}</h4>`;
        if (more) {
            const button = document.createElement('button');
            button.className = 'music-section-more';
            button.textContent = '查看全部';
            button.onclick = more;
            header.appendChild(button);
        }
        section.appendChild(header);
        return section;
    }

    async function searchNeteaseSongs(keyword, type = 'all', page = 1, token = browserService.musicBrowserState.navToken, signal = browserService.musicBrowserState.controller?.signal) {
        const query = String(keyword || '').trim().slice(0, 200);
        if (!query) return;
        domService.searchResults.innerHTML = '<div class="netease-loading">搜索中...</div>';
        domService.searchBtn.disabled = true;
        const hash = window.location.hash;
        try {
            if (type === 'all') {
                const settled = await Promise.allSettled([
                    fetchMusicSearch('song', query, 8, 0, signal),
                    fetchMusicSearch('album', query, 6, 0, signal),
                    fetchMusicSearch('artist', query, 6, 0, signal)
                ]);
                if (!browserService.currentMusicNavigationIs(token, hash)) return;
                domService.searchResults.innerHTML = '';
                const definitions = [
                    { name: '歌曲', type: 'song', result: settled[0] },
                    { name: '专辑', type: 'album', result: settled[1] },
                    { name: '歌手', type: 'artist', result: settled[2] }
                ];
                let visibleSections = 0;
                definitions.forEach(definition => {
                    const section = createMusicSection(definition.name, () => browserService.navigateMusic({ kind: 'search', q: query, type: definition.type, page: 1 }));
                    if (definition.result.status === 'rejected') {
                        section.insertAdjacentHTML('beforeend', `<div class="music-browser-state">${escapeHtml(definition.name)}加载失败<br><button class="music-retry-btn" data-music-reload>重试</button></div>`);
                    } else if (!definition.result.value.items.length) {
                        section.insertAdjacentHTML('beforeend', '<div class="netease-empty">没有结果</div>');
                    } else {
                        visibleSections++;
                        if (definition.type === 'song') renderMusicSongRows(definition.result.value.items, section, { sourceType: 'search', title: query });
                        else if (definition.type === 'album') renderMusicAlbumCards(definition.result.value.items, section);
                        else renderMusicArtistCards(definition.result.value.items, section);
                    }
                    domService.searchResults.appendChild(section);
                });
                if (!visibleSections && settled.every(result => result.status === 'fulfilled')) {
                    domService.searchResults.innerHTML = '<div class="netease-empty">没有找到相关内容</div>';
                }
                return;
            }

            const limit = 30;
            const result = await fetchMusicSearch(type, query, limit, (page - 1) * limit, signal);
            if (!browserService.currentMusicNavigationIs(token, hash)) return;
            domService.searchResults.innerHTML = '';
            if (!result.items.length) {
                domService.searchResults.innerHTML = '<div class="netease-empty">没有找到相关内容</div>';
                return;
            }
            if (type === 'song') renderMusicSongRows(result.items, domService.searchResults, { sourceType: 'search', title: query, page });
            else if (type === 'album') renderMusicAlbumCards(result.items, domService.searchResults);
            else renderMusicArtistCards(result.items, domService.searchResults);
            renderMusicPagination(
                domService.searchResults,
                page,
                page * limit < result.total,
                nextPage => browserService.navigateMusic({ kind: 'search', q: query, type, page: nextPage }),
                result.total
            );
        } finally {
            if (browserService.currentMusicNavigationIs(token, hash)) domService.searchBtn.disabled = false;
        }
    }

    // 歌单预览沿用本地分页，但歌曲行接入统一的实体跳转和播放队列。
    function renderSongList(songs, container, page = 0) {
        renderSongList._page = page;
        onlinePlaylistService.currentPlaylistSongs = songs;
        onlinePlaylistService.currentPage = page;
        const start = page * onlinePlaylistService.SONGS_PER_PAGE;
        const pageSongs = songs.slice(start, start + onlinePlaylistService.SONGS_PER_PAGE);
        container.innerHTML = '';
        renderMusicSongRows(pageSongs, container, { sourceType: 'playlist-preview', page }, pageSongs);
        renderMusicPagination(
            container,
            page + 1,
            start + onlinePlaylistService.SONGS_PER_PAGE < songs.length,
            nextPage => renderSongList(songs, container, nextPage - 1),
            songs.length
        );
    }

    function withMusicCookie(path) {
        if (!authService.neteaseCookie) return path;
        const separator = path.includes('?') ? '&' : '?';
        return `${path}${separator}cookie=${encodeURIComponent(cleanCookie(authService.neteaseCookie))}`;
    }

    async function fetchMusicStatic(path, signal, ttl = 1_800_000, options = {}) {
        const requestOptions = {
            useQueue: true,
            priority: options.priority || 'interactive',
            cacheScope: options.cacheScope || 'public',
            forceRefresh: !!options.forceRefresh
        };
        if (signal) requestOptions.signal = signal;
        const json = await cacheService.cachedFetchJson(apiService.buildApiUrl(path), requestOptions, ttl);
        if (!json || (json.code !== undefined && json.code !== 200)) throw new Error(json?.message || '接口返回异常');
        return json;
    }

    async function fetchMusicDynamic(path, signal, options = {}) {
        const snapshot = authService.captureAuthSnapshot();
        const requestOptions = {
            useQueue: true,
            priority: options.priority || 'interactive',
            cacheScope: 'account',
            forceRefresh: !!options.forceRefresh
        };
        if (signal) requestOptions.signal = signal;
        const json = await cacheService.cachedFetchJson(
            apiService.buildApiUrl(withMusicCookie(path)),
            requestOptions,
            15_000
        );
        if (!authService.isAuthSnapshotCurrent(snapshot)) throw new DOMException('stale account response', 'AbortError');
        if (json?.code !== 200) throw new Error(json?.message || '状态接口返回异常');
        return json;
    }

    function fetchMusicDynamicShared(path, options = {}) {
        return fetchMusicDynamic(path, options.signal || null, options);
    }

    function formatMusicCount(value) {
        const number = Number(value || 0);
        if (number >= 100000000) return `${(number / 100000000).toFixed(number >= 1000000000 ? 0 : 1)}亿`;
        if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)}万`;
        return String(number);
    }

    function renderMusicMvCards(mvs, container) {
        const grid = document.createElement('div');
        grid.className = 'music-card-grid';
        (mvs || []).filter(mv => positiveMusicInteger(mv.id, 0)).forEach(mv => {
            const image = toHttps(mv.imgurl || mv.cover || mv.coverUrl || '');
            const card = document.createElement('div');
            card.className = 'music-card mv';
            card.innerHTML = `
                <a class="music-card-button" href="https://music.163.com/#/mv?id=${positiveMusicInteger(mv.id, 0)}" target="_blank" rel="noopener noreferrer" aria-label="在网易云音乐打开 MV ${escapeHtml(mv.name || '')}">
                    <img class="music-card-image" data-src="${escapeHtml(image || MUSIC_FALLBACK_COVER)}" loading="lazy" referrerpolicy="no-referrer" alt="">
                    <div class="music-card-title">${escapeHtml(mv.name || '未命名 MV')}</div>
                    <div class="music-card-subtitle">${mv.playCount ? `${formatMusicCount(mv.playCount)} 次播放` : 'MV'}</div>
                </a>`;
            card.querySelector('img').addEventListener('error', event => { event.currentTarget.src = MUSIC_FALLBACK_COVER; }, { once: true });
            grid.appendChild(card);
        });
        container.appendChild(grid);
        observeMusicImages(grid);
    }

    function musicEntityActionsHtml(contextId, options = {}) {
        const playDisabled = contextId ? '' : 'disabled';
        const subscriptionState = options.subscriptionState || (options.subscriptionAvailable === false ? 'loading' : 'known');
        const subscriptionDisabled = subscriptionState === 'loading' ? 'disabled' : '';
        const subscriptionLabel = subscriptionState === 'unknown'
            ? '重试状态'
            : (options.active ? options.activeLabel : options.inactiveLabel);
        const followButton = options.subscriptionType ? `
            <button class="music-action-btn" data-music-subscription="${options.subscriptionType}" data-music-subscription-state="${subscriptionState}" data-music-id="${options.entityId}" data-active="${options.active ? 'true' : 'false'}" ${subscriptionDisabled}>
                ${subscriptionLabel}
            </button>` : '';
        return `
            <div class="music-entity-actions">
                <button class="music-action-btn primary" data-music-play-context="${escapeHtml(contextId || '')}" ${playDisabled}>播放</button>
                <button class="music-action-btn" data-music-shuffle-context="${escapeHtml(contextId || '')}" ${playDisabled}>随机播放</button>
                ${followButton}
            </div>`;
    }

    async function renderMusicAlbumPage(route, token, signal, options = {}) {
        const hash = window.location.hash;
        domService.neteaseBrowserView.innerHTML = '<div class="netease-loading">正在载入专辑...</div>';
        const [albumResult, dynamicResult] = await Promise.allSettled([
            fetchMusicStatic(`/album?id=${route.id}`, signal, 1_800_000, options),
            fetchMusicDynamic(`/album/detail/dynamic?id=${route.id}`, signal, options)
        ]);
        if (!browserService.currentMusicNavigationIs(token, hash)) return;
        if (albumResult.status === 'rejected') throw albumResult.reason;
        const data = albumResult.value;
        if (!data.album) throw new Error('没有找到这张专辑');
        const album = normalizeMusicAlbum(data.album);
        const songs = data.songs || [];
        const dynamic = dynamicResult.status === 'fulfilled' ? dynamicResult.value : null;
        const contextId = songs.length ? registerMusicContext(songs, { sourceType: 'album', sourceId: album.id, title: album.name }) : '';
        const year = album.publishTime ? new Date(album.publishTime).getFullYear() : '';
        const meta = [album.subType, year, songs.length ? `${songs.length} 首歌曲` : '', album.company].filter(Boolean).join(' · ');
        const cover = album.picUrl ? `${album.picUrl}?param=500y500` : MUSIC_FALLBACK_COVER;
        domService.neteasePageTitle.textContent = album.name;
        domService.neteaseBrowserView.innerHTML = `
            <section class="music-entity-hero">
                <img class="music-entity-cover" src="${escapeHtml(cover)}" referrerpolicy="no-referrer" alt="${escapeHtml(album.name)}">
                <div class="music-entity-info">
                    <div class="music-entity-kind">专辑</div>
                    <h2 class="music-entity-name">${escapeHtml(album.name)}</h2>
                    <div class="music-entity-meta">${musicArtistLinksHtml(album.artists)}${meta ? `<br>${escapeHtml(meta)}` : ''}${dynamic?.subCount ? `<br>${formatMusicCount(dynamic.subCount)} 人收藏` : ''}</div>
                </div>
                ${album.description ? `<p class="music-entity-description">${escapeHtml(album.description)}</p>` : ''}
                ${musicEntityActionsHtml(contextId, {
                    subscriptionType: 'album', entityId: album.id, active: !!dynamic?.isSub,
                    activeLabel: '取消收藏', inactiveLabel: '收藏',
                    subscriptionState: dynamicResult.status === 'fulfilled' ? 'known' : (authService.neteaseUser ? 'unknown' : 'guest')
                })}
            </section>`;
        domService.neteaseBrowserView.querySelector('.music-entity-cover').addEventListener('error', event => { event.currentTarget.src = MUSIC_FALLBACK_COVER; }, { once: true });

        const tracksSection = createMusicSection('曲目');
        if (songs.length) renderMusicSongRows(songs, tracksSection, { sourceType: 'album', sourceId: album.id, title: album.name }, songs);
        else tracksSection.insertAdjacentHTML('beforeend', '<div class="netease-empty">这张专辑没有可用曲目</div>');
        domService.neteaseBrowserView.appendChild(tracksSection);
    }

    function artistSubnavHtml(route) {
        const tabs = [
            ['overview', '概览'], ['songs', '全部歌曲'], ['albums', '专辑 / EP'], ['mvs', 'MV']
        ];
        return `<nav class="music-subnav" aria-label="歌手内容">${tabs.map(([view, label]) => `
            <button class="music-subnav-btn ${route.view === view ? 'active' : ''}" data-music-artist-view="${view}" data-music-id="${route.id}" aria-current="${route.view === view ? 'page' : 'false'}">${label}</button>`).join('')}</nav>`;
    }

    function musicPartialFailure(label, retryView = '') {
        const retryAttribute = retryView
            ? `data-music-retry-view="${escapeHtml(retryView)}"`
            : 'data-music-reload';
        return `<div class="music-browser-state">${escapeHtml(label)}加载失败<br><button class="music-retry-btn" ${retryAttribute}>重试</button></div>`;
    }

    function fulfilledMusicResult(value) {
        return { status: 'fulfilled', value };
    }

    async function fetchArtistBaseData(artistId, signal, options = {}) {
        const baseOptions = {
            ...options,
            forceRefresh: !!options.forceRefresh || !!options.forceRefreshBase
        };
        let aggregate = null;
        let aggregateError = null;
        try {
            aggregate = await fetchMusicStatic(`/artists?id=${artistId}`, signal, 1_800_000, baseOptions);
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            aggregateError = error;
        }

        const aggregateArtist = aggregate?.artist || aggregate?.data?.artist || null;
        const aggregateSongs = Array.isArray(aggregate?.hotSongs) ? aggregate.hotSongs : null;
        let detailResult = aggregateArtist
            ? fulfilledMusicResult({ code: 200, data: { artist: aggregateArtist } })
            : null;
        let topResult = aggregateSongs
            ? fulfilledMusicResult({ code: 200, songs: aggregateSongs, more: false })
            : null;

        const fallbackTasks = [];
        if (!detailResult) {
            fallbackTasks.push({
                type: 'detail',
                promise: fetchMusicStatic(`/artist/detail?id=${artistId}`, signal, 1_800_000, baseOptions)
            });
        }
        if (!topResult) {
            fallbackTasks.push({
                type: 'top',
                promise: fetchMusicStatic(`/artist/top/song?id=${artistId}`, signal, 1_800_000, baseOptions)
            });
        }
        if (fallbackTasks.length) {
            const settled = await Promise.allSettled(fallbackTasks.map(task => task.promise));
            settled.forEach((result, index) => {
                const task = fallbackTasks[index];
                if (task.type === 'detail') detailResult = result;
                else topResult = result;
            });
        }

        return {
            detailResult: detailResult || { status: 'rejected', reason: aggregateError || new Error('没有找到这位歌手') },
            topResult: topResult || { status: 'rejected', reason: aggregateError || new Error('热门歌曲加载失败') }
        };
    }

    async function fetchArtistViewData(route, signal, options = {}) {
        const forcedViews = options.forceRefreshViews instanceof Set ? options.forceRefreshViews : new Set();
        if (route.view === 'overview') {
            const albumsPath = `/artist/album?id=${route.id}&limit=30&offset=0`;
            const mvsPath = `/artist/mv?id=${route.id}&limit=30&offset=0`;
            const [albumsResult, mvsResult] = await Promise.allSettled([
                fetchMusicStatic(albumsPath, signal, 1_800_000, {
                    ...options,
                    forceRefresh: forcedViews.has('albums')
                }),
                fetchMusicStatic(mvsPath, signal, 1_800_000, {
                    ...options,
                    forceRefresh: forcedViews.has('mvs')
                })
            ]);
            return { albumsResult, mvsResult };
        }

        const limit = route.view === 'songs' ? 50 : 30;
        const endpoint = route.view === 'songs'
            ? `/artist/songs?id=${route.id}&order=hot&limit=${limit}&offset=${(route.page - 1) * limit}`
            : route.view === 'albums'
                ? `/artist/album?id=${route.id}&limit=${limit}&offset=${(route.page - 1) * limit}`
                : `/artist/mv?id=${route.id}&limit=${limit}&offset=${(route.page - 1) * limit}`;
        const result = await fetchMusicStatic(endpoint, signal, 1_800_000, {
            ...options,
            forceRefresh: !!options.forceRefresh || forcedViews.has(route.view)
        });
        return { result };
    }

    function updateArtistSubnav(route) {
        domService.neteaseBrowserView.querySelectorAll('[data-music-artist-view]').forEach(button => {
            const active = button.dataset.musicArtistView === route.view;
            button.classList.toggle('active', active);
            button.setAttribute('aria-current', active ? 'page' : 'false');
        });
    }

    function updateArtistDynamicState(session, dynamic) {
        if (!dynamic || !session) return;
        session.dynamic = dynamic;
        const button = domService.neteaseBrowserView.querySelector(`[data-music-subscription="artist"][data-music-id="${session.id}"]`);
        if (!button) return;
        const followed = !!dynamic.followed;
        button.dataset.active = followed ? 'true' : 'false';
        button.dataset.musicSubscriptionState = 'known';
        button.disabled = false;
        button.textContent = followed ? '取消关注' : '关注';
    }

    function updateArtistDynamicUnavailable(session) {
        if (!session) return;
        const button = domService.neteaseBrowserView.querySelector(`[data-music-subscription="artist"][data-music-id="${session.id}"]`);
        if (!button) return;
        const loggedIn = !!(authService.neteaseUser && authService.neteaseCookie);
        button.dataset.musicSubscriptionState = loggedIn ? 'unknown' : 'guest';
        button.disabled = false;
        button.textContent = loggedIn ? '重试状态' : '关注';
    }

    function createArtistSession(baseData, artistId) {
        const detail = baseData.detailResult.status === 'fulfilled'
            ? baseData.detailResult.value?.data?.artist
            : null;
        if (!detail) {
            throw baseData.detailResult.reason || new Error('没有找到这位歌手');
        }
        const artist = normalizeMusicArtist(detail);
        const topSongs = baseData.topResult.status === 'fulfilled'
            ? (baseData.topResult.value?.songs || [])
            : [];
        const topContextId = topSongs.length
            ? registerMusicContext(topSongs, { sourceType: 'artist-top', sourceId: artist.id, title: artist.name })
            : '';
        return {
            id: artistId,
            artist,
            topSongs,
            topContextId,
            topError: baseData.topResult.status === 'rejected' ? baseData.topResult.reason : null,
            dynamic: null
        };
    }

    function renderArtistShell(session, route, dynamic = null) {
        const { artist, topSongs, topContextId } = session;
        const cover = artist.picUrl ? `${artist.picUrl}?param=500y500` : MUSIC_FALLBACK_ARTIST;
        const meta = [
            `${artist.musicSize || topSongs.length} 首歌曲`,
            artist.albumSize ? `${artist.albumSize} 张专辑` : '',
            artist.mvSize ? `${artist.mvSize} 个 MV` : ''
        ].filter(Boolean).join(' · ');
        domService.neteasePageTitle.textContent = artist.name;
        domService.neteaseBrowserView.dataset.musicEntityKind = 'artist';
        domService.neteaseBrowserView.dataset.musicEntityId = String(artist.id);
        domService.neteaseBrowserView.innerHTML = `
            <section class="music-entity-hero">
                <img class="music-entity-cover artist" src="${escapeHtml(cover)}" referrerpolicy="no-referrer" alt="${escapeHtml(artist.name)}">
                <div class="music-entity-info">
                    <div class="music-entity-kind">歌手</div>
                    <h2 class="music-entity-name">${escapeHtml(artist.name)}</h2>
                    <div class="music-entity-meta">${escapeHtml(meta)}</div>
                </div>
                ${artist.briefDesc ? `<p class="music-entity-description">${escapeHtml(artist.briefDesc)}</p>` : ''}
                ${musicEntityActionsHtml(topContextId, {
                    subscriptionType: 'artist', entityId: artist.id, active: !!dynamic?.followed,
                    activeLabel: '取消关注', inactiveLabel: '关注',
                    subscriptionState: dynamic ? 'known' : (authService.neteaseUser ? 'loading' : 'guest')
                })}
            </section>
            ${artistSubnavHtml(route)}
            <div id="music-artist-content" aria-live="polite"></div>`;
        const image = domService.neteaseBrowserView.querySelector('.music-entity-cover');
        image?.addEventListener('error', event => { event.currentTarget.src = MUSIC_FALLBACK_ARTIST; }, { once: true });
        updateArtistSubnav(route);
        if (dynamic) updateArtistDynamicState(session, dynamic);
    }

    function renderArtistContent(session, route, viewData, token, hash) {
        if (!browserService.currentMusicNavigationIs(token, hash)) return;
        const content = domService.neteaseBrowserView.querySelector('#music-artist-content');
        if (!content) return;
        content.innerHTML = '';
        const { artist, topSongs, topError } = session;

        if (route.view === 'overview') {
            const songsSection = createMusicSection('热门歌曲', () => browserService.navigateMusic({ kind: 'artist', id: artist.id, view: 'songs', page: 1 }));
            if (topSongs.length) renderMusicSongRows(topSongs.slice(0, 10), songsSection, { sourceType: 'artist-top', sourceId: artist.id, title: artist.name }, topSongs);
            else if (topError) songsSection.insertAdjacentHTML('beforeend', musicPartialFailure('热门歌曲', 'top'));
            else songsSection.insertAdjacentHTML('beforeend', '<div class="netease-empty">暂无歌曲</div>');
            content.appendChild(songsSection);

            const albumsSection = createMusicSection('专辑与 EP', () => browserService.navigateMusic({ kind: 'artist', id: artist.id, view: 'albums', page: 1 }));
            if (viewData.albumsResult.status === 'rejected') albumsSection.insertAdjacentHTML('beforeend', musicPartialFailure('专辑', 'albums'));
            else if (viewData.albumsResult.value.hotAlbums?.length) renderMusicAlbumCards(viewData.albumsResult.value.hotAlbums.slice(0, 6), albumsSection);
            else albumsSection.insertAdjacentHTML('beforeend', '<div class="netease-empty">暂无专辑</div>');
            content.appendChild(albumsSection);

            const mvsSection = createMusicSection('MV', () => browserService.navigateMusic({ kind: 'artist', id: artist.id, view: 'mvs', page: 1 }));
            if (viewData.mvsResult.status === 'rejected') mvsSection.insertAdjacentHTML('beforeend', musicPartialFailure('MV', 'mvs'));
            else if (viewData.mvsResult.value.mvs?.length) renderMusicMvCards(viewData.mvsResult.value.mvs.slice(0, 6), mvsSection);
            else mvsSection.insertAdjacentHTML('beforeend', '<div class="netease-empty">暂无 MV</div>');
            content.appendChild(mvsSection);
            return;
        }

        const extra = viewData.result;
        if (route.view === 'songs') {
            const songs = extra.songs || [];
            if (songs.length) renderMusicSongRows(songs, content, { sourceType: 'artist-songs', sourceId: artist.id, title: artist.name, page: route.page }, songs);
            else content.innerHTML = '<div class="netease-empty">这一页没有歌曲</div>';
            renderMusicPagination(content, route.page, !!extra.more, page => browserService.navigateMusic({ kind: 'artist', id: artist.id, view: 'songs', page }), Number(extra.total || 0));
        } else if (route.view === 'albums') {
            const albums = extra.hotAlbums || [];
            if (albums.length) renderMusicAlbumCards(albums, content);
            else content.innerHTML = '<div class="netease-empty">这一页没有专辑</div>';
            renderMusicPagination(content, route.page, !!extra.more, page => browserService.navigateMusic({ kind: 'artist', id: artist.id, view: 'albums', page }));
        } else {
            const mvs = extra.mvs || [];
            if (mvs.length) renderMusicMvCards(mvs, content);
            else content.innerHTML = '<div class="netease-empty">这一页没有 MV</div>';
            renderMusicPagination(content, route.page, !!extra.hasMore, page => browserService.navigateMusic({ kind: 'artist', id: artist.id, view: 'mvs', page }));
        }
    }

    async function renderMusicArtistPage(route, token, signal, options = {}) {
        const hash = window.location.hash;
        const session = browserService.musicBrowserState.artistSession;
        const sameEntity = !options.forceRefresh && !options.forceRefreshBase && session?.id === Number(route.id)
            && domService.neteaseBrowserView.dataset.musicEntityId === String(route.id)
            && !!domService.neteaseBrowserView.querySelector('#music-artist-content');
        const dynamicPromise = fetchMusicDynamicShared(`/artist/detail/dynamic?id=${route.id}`, {
            signal,
            forceRefresh: !!options.forceRefreshDynamic
        })
            .catch(error => {
                if (error?.name !== 'AbortError' && browserService.currentMusicNavigationIs(token, hash)) debugService.log(`歌手状态读取失败: ${error?.message || error}`, 'warn');
                return null;
            });

        let activeSession = sameEntity ? session : null;
        if (!activeSession) {
            domService.neteaseBrowserView.innerHTML = '<div class="netease-loading">正在载入歌手...</div>';
            const baseData = await fetchArtistBaseData(route.id, signal, options);
            if (!browserService.currentMusicNavigationIs(token, hash)) return;
            activeSession = createArtistSession(baseData, Number(route.id));
            browserService.musicBrowserState.artistSession = activeSession;
            renderArtistShell(activeSession, route);
        } else {
            updateArtistSubnav(route);
        }

        dynamicPromise.then(dynamic => {
            if (dynamic && browserService.currentMusicNavigationIs(token, hash) && browserService.musicBrowserState.artistSession === activeSession) {
                updateArtistDynamicState(activeSession, dynamic);
            } else if (!dynamic && browserService.currentMusicNavigationIs(token, hash) && browserService.musicBrowserState.artistSession === activeSession) {
                updateArtistDynamicUnavailable(activeSession);
            }
        });

        const content = domService.neteaseBrowserView.querySelector('#music-artist-content');
        if (content) {
            content.setAttribute('aria-busy', 'true');
            content.innerHTML = '<div class="netease-loading">正在载入内容...</div>';
        }
        const viewData = await fetchArtistViewData(route, signal, options);
        if (!browserService.currentMusicNavigationIs(token, hash) || browserService.musicBrowserState.artistSession !== activeSession) return;
        renderArtistContent(activeSession, route, viewData, token, hash);
        content?.removeAttribute('aria-busy');
    }

    async function refreshMusicSubscriptionState(button) {
        const type = button.dataset.musicSubscription;
        const id = positiveMusicInteger(button.dataset.musicId);
        if (!id || !['album', 'artist'].includes(type)) return;
        const snapshot = authService.captureAuthSnapshot();
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = '读取中...';
        try {
            const endpoint = type === 'album' ? '/album/detail/dynamic' : '/artist/detail/dynamic';
            const dynamic = await fetchMusicDynamic(`${endpoint}?id=${id}`, browserService.musicBrowserState.controller?.signal, { forceRefresh: true });
            if (!authService.isAuthSnapshotCurrent(snapshot)) return;
            const active = type === 'album' ? !!dynamic.isSub : !!dynamic.followed;
            button.dataset.active = active ? 'true' : 'false';
            button.dataset.musicSubscriptionState = 'known';
            button.disabled = false;
            button.textContent = active ? (type === 'album' ? '取消收藏' : '取消关注') : (type === 'album' ? '收藏' : '关注');
        } catch (error) {
            if (error?.name === 'AbortError') return;
            button.dataset.musicSubscriptionState = 'unknown';
            button.disabled = false;
            button.textContent = '重试状态';
            if (originalText !== '重试状态') debugService.log(`账号状态重试失败: ${error?.message || error}`, 'warn');
        }
    }

    async function performMusicSubscription(button) {
        const type = button.dataset.musicSubscription;
        const id = positiveMusicInteger(button.dataset.musicId);
        if (!id || !['album', 'artist'].includes(type)) return;
        if (!authService.neteaseUser || !authService.neteaseCookie) {
            browserService.musicBrowserState.authReturnHash = window.location.hash;
            await authService.showQRLogin();
            return;
        }
        if (button.dataset.musicSubscriptionState === 'unknown') {
            await refreshMusicSubscriptionState(button);
            return;
        }
        const wasActive = button.dataset.active === 'true';
        const originalText = button.textContent;
        const snapshot = authService.captureAuthSnapshot();
        button.disabled = true;
        button.textContent = '处理中...';
        try {
            const endpoint = type === 'album' ? '/album/sub' : '/artist/sub';
            const path = `${endpoint}?id=${id}&t=${wasActive ? 0 : 1}&cookie=${encodeURIComponent(cleanCookie(authService.neteaseCookie))}&timestamp=${Date.now()}`;
            const response = await authService.accountFetch(apiService.buildApiUrl(path), { cache: 'no-store' });
            const json = await response.json();
            if (!authService.isAuthSnapshotCurrent(snapshot)) throw new DOMException('stale account response', 'AbortError');
            if (!response.ok || json?.code !== 200) {
                if ([301, 302].includes(json?.code)) {
                    await authService.neteaseLogout();
                    browserService.musicBrowserState.authReturnHash = window.location.hash;
                    await authService.showQRLogin();
                    return;
                }
                throw new Error(json?.message || `HTTP ${response.status}`);
            }
            cacheService.clearAccountJsonCache();
            const scrollTop = domService.neteaseBrowserScroll.scrollTop;
            await browserService.renderMusicRoute(parseMusicRoute(), scrollTop);
            debugService.log(`${type === 'album' ? '专辑收藏' : '歌手关注'}已更新`, 'success');
        } catch (error) {
            if (error?.name === 'AbortError') return;
            button.disabled = false;
            button.textContent = originalText;
            debugService.log(`账号操作失败: ${error?.message || error}`, 'error');
        }
    }

    function setMainMusicEntityLinks(song = null) {
        const normalized = song ? normalizeMusicSong(song) : null;
        const albumId = normalized?.album?.id || 0;
        if (albumId) {
            domService.el.coverWrap.dataset.musicAlbumId = String(albumId);
            domService.el.coverWrap.classList.add('music-album-link');
            domService.el.coverWrap.tabIndex = 0;
            domService.el.coverWrap.setAttribute('role', 'button');
            domService.el.coverWrap.setAttribute('aria-label', `打开专辑 ${normalized.album.name}`);
        } else {
            delete domService.el.coverWrap.dataset.musicAlbumId;
            domService.el.coverWrap.classList.remove('music-album-link');
            domService.el.coverWrap.removeAttribute('tabindex');
            domService.el.coverWrap.removeAttribute('role');
            domService.el.coverWrap.removeAttribute('aria-label');
        }
        if (normalized) domService.el.artist.innerHTML = musicArtistLinksHtml(normalized.artists);
    }

    function openMainPlayerAlbum() {
        const albumId = positiveMusicInteger(domService.el.coverWrap.dataset.musicAlbumId);
        if (albumId) browserService.navigateMusic({ kind: 'album', id: albumId });
    }

    function updateMusicMiniPlayer() {
        const mini = document.getElementById('music-mini-player');
        const track = queueService.playlist[queueService.curIdx];
        if (!mini || !track) {
            if (mini) {
                mini.classList.remove('show');
                document.getElementById('music-mini-cover')?.removeAttribute('src');
            }
            return;
        }
        const song = track.netease && track.songData ? normalizeMusicSong(track.songData) : null;
        const title = song?.name || domService.el.title.textContent || track.name || '未命名歌曲';
        const artists = song?.artists?.map(artist => artist.name).join(', ') || domService.el.artist.textContent || '';
        const currentCover = coversService.mainCoverTrackId && coversService.mainCoverTrackIds.get(track) === coversService.mainCoverTrackId ? domService.el.img.getAttribute('src') : '';
        const cover = currentCover || coversService.coverDisplayUrl(song?.picUrl || MUSIC_FALLBACK_COVER);
        document.getElementById('music-mini-title').textContent = title;
        document.getElementById('music-mini-artists').textContent = artists;
        document.getElementById('music-mini-cover').src = cover;
        const miniPlay = document.getElementById('music-mini-play');
        miniPlay.textContent = domService.el.playBtn.getAttribute('aria-label') === '暂停' ? '❚❚' : '▶';
        miniPlay.setAttribute('aria-label', domService.el.playBtn.getAttribute('aria-label'));
        miniPlay.disabled = false;
        const artistButton = document.getElementById('music-mini-artist');
        const artistId = song?.artists?.find(artist => artist.id)?.id || 0;
        artistButton.dataset.musicArtistId = artistId ? String(artistId) : '';
        artistButton.style.display = artistId ? '' : 'none';
        mini.classList.add('show');
    }

    // 懒加载图片实现
    const lazyLoadImages = () => observeMusicImages(document);

    let initialized = false;
    return {
        observeMusicImages,
        searchNeteaseSongs,
        renderSongList,
        renderMusicAlbumPage,
        renderMusicArtistPage,
        setMainMusicEntityLinks,
        updateMusicMiniPlayer,
        initialize() {
            if (initialized) return;
            initialized = true;
            domService.neteasePanel.addEventListener('click', event => {
                const artistLink = event.target.closest('[data-music-artist]');
                if (artistLink) {
                    event.stopPropagation();
                    browserService.navigateMusic({ kind: 'artist', id: positiveMusicInteger(artistLink.dataset.musicArtist), view: 'overview', page: 1 });
                    return;
                }
                const albumLink = event.target.closest('[data-music-album]');
                if (albumLink) {
                    event.stopPropagation();
                    browserService.navigateMusic({ kind: 'album', id: positiveMusicInteger(albumLink.dataset.musicAlbum) });
                    return;
                }
                const artistView = event.target.closest('[data-music-artist-view]');
                if (artistView) {
                    browserService.navigateMusic({ kind: 'artist', id: positiveMusicInteger(artistView.dataset.musicId), view: artistView.dataset.musicArtistView, page: 1 });
                    return;
                }
                const subscription = event.target.closest('[data-music-subscription]');
                if (subscription) {
                    performMusicSubscription(subscription);
                    return;
                }
                const playContext = event.target.closest('[data-music-play-context]');
                if (playContext?.dataset.musicPlayContext) {
                    activateOnlineMusicContext(playContext.dataset.musicPlayContext, 0, false);
                    return;
                }
                const shuffleContext = event.target.closest('[data-music-shuffle-context]');
                if (shuffleContext?.dataset.musicShuffleContext) {
                    activateOnlineMusicContext(shuffleContext.dataset.musicShuffleContext, 0, true);
                    return;
                }
                if (event.target.closest('[data-music-home]')) {
                    browserService.navigateMusic({ kind: 'search', q: '', type: 'all', page: 1 });
                    return;
                }
                const retryView = event.target.closest('[data-music-retry-view]')?.dataset.musicRetryView;
                if (retryView) {
                        const route = parseMusicRoute();
                    if (route?.kind === 'artist') {
                        const options = retryView === 'albums' || retryView === 'mvs'
                            ? { forceRefreshViews: new Set([retryView]) }
                            : { forceRefreshBase: true };
                        browserService.renderMusicRoute(route, domService.neteaseBrowserScroll.scrollTop, options);
                    }
                    return;
                }
                if (event.target.closest('[data-music-reload]')) {
                    browserService.renderMusicRoute(parseMusicRoute(), domService.neteaseBrowserScroll.scrollTop, { forceRefresh: true });
                    return;
                }
                const row = event.target.closest('.netease-item[data-music-context]');
                if (row && (event.target.closest('[data-music-play]') || !event.target.closest('button, a, input, select'))) {
                    activateOnlineMusicContext(row.dataset.musicContext, Number(row.dataset.musicIndex) || 0, false);
                }
            });

            domService.el.coverWrap.addEventListener('click', openMainPlayerAlbum);

            domService.el.coverWrap.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openMainPlayerAlbum();
                }
            });

            domService.el.artist.addEventListener('click', event => {
                const artist = event.target.closest('[data-music-artist]');
                if (artist) browserService.navigateMusic({ kind: 'artist', id: positiveMusicInteger(artist.dataset.musicArtist), view: 'overview', page: 1 });
            });

            document.getElementById('music-mini-main').onclick = browserService.closeMusicBrowser;

            document.getElementById('music-mini-play').onclick = () => domService.el.playBtn.click();

            document.getElementById('music-mini-next').onclick = () => document.getElementById('next-btn').click();

            document.getElementById('music-mini-artist').onclick = event => {
                const id = positiveMusicInteger(event.currentTarget.dataset.musicArtistId);
                if (id) browserService.navigateMusic({ kind: 'artist', id, view: 'overview', page: 1 });
            };

            // 初始化懒加载
            lazyLoadImages();
        }
    };
}
