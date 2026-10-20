import { escapeHtml } from '../shared/text.js';
import { MUSIC_ROUTE_PREFIX, buildMusicHash, getMusicRouteTitle, parseMusicRoute } from './routes.js';

export function createBrowser({
    auth: authService,
    content: contentService,
    dom: domService,
    myPlaylists: myPlaylistsService,
    panels: panelsService
} = {}) {
    const musicBrowserState = {
        route: null,
        renderedHash: '',
        navToken: 0,
        controller: null,
        navigationControllers: new Set(),
        contexts: new Map(),
        contextSeed: 0,
        artistSession: null,
        artistPrefetchTimer: null,
        artistPrefetchController: null,
        authReturnHash: '',
        authReturnContext: null,
        lastMusicPosition: null,
        lastNonMusicHash: '',
        lastSearchRoute: null,
        restoringHistory: false,
        sessionSeed: 0,
        closingSessionId: ''
    };

    function createMusicSessionId() {
        musicBrowserState.sessionSeed++;
        return `aurora-${Date.now().toString(36)}-${musicBrowserState.sessionSeed.toString(36)}`;
    }

    function getMusicHistoryState() {
        const value = history.state?.auroraMusic;
        return value && typeof value.sessionId === 'string' ? value : null;
    }

    function ensureMusicHistoryState() {
        if (!window.location.hash.startsWith(MUSIC_ROUTE_PREFIX)) return null;
        const existing = getMusicHistoryState();
        if (existing) return existing;
        const baseUrl = window.location.href.split('#')[0];
        const state = {
            sessionId: createMusicSessionId(), depth: 0, scrollTop: 0,
            parentUrl: baseUrl, hasParentEntry: false, routeHash: window.location.hash
        };
        history.replaceState({ ...(history.state || {}), auroraMusic: state }, '', window.location.href);
        return state;
    }

    function saveMusicScrollState() {
        if (!window.location.hash.startsWith(MUSIC_ROUTE_PREFIX)) return;
        try {
            const current = ensureMusicHistoryState() || {};
            const loginReturn = musicBrowserState.authReturnContext;
            const scrollTop = loginReturn?.hash === window.location.hash ? loginReturn.scrollTop : domService.neteaseBrowserScroll.scrollTop;
            musicBrowserState.lastMusicPosition = { hash: window.location.hash, scrollTop };
            const state = { ...(history.state || {}), auroraMusic: { ...current, scrollTop, routeHash: window.location.hash } };
            history.replaceState(state, '', window.location.href);
        } catch (_) {}
    }

    function setMusicBrowserTab(tabName) {
        document.querySelectorAll('.netease-tab-content').forEach(content => { content.style.display = 'none'; });
        domService.neteaseTabs.forEach(tab => tab.classList.toggle('active', tab.dataset.tab === tabName));
        const content = document.getElementById(`tab-${tabName}`);
        if (content) content.style.display = 'flex';
    }

    function currentMusicNavigationIs(token, hash) {
        return token === musicBrowserState.navToken && hash === window.location.hash;
    }

    function abortMusicNavigationRequests() {
        const controllers = musicBrowserState.navigationControllers || new Set();
        controllers.forEach(controller => {
            try { controller.abort(); } catch (_) {}
        });
        controllers.clear();
        if (musicBrowserState.controller) {
            try { musicBrowserState.controller.abort(); } catch (_) {}
            musicBrowserState.controller = null;
        }
    }

    async function renderMusicRoute(route, restoreScroll = 0, options = {}) {
        if (!route) {
            panelsService.modalController.close(domService.neteasePanel, false);
            return;
        }
        const previousRoute = musicBrowserState.route;
        const sameArtistEntity = previousRoute?.kind === 'artist'
            && route.kind === 'artist'
            && Number(previousRoute.id) === Number(route.id);
        authService.cancelLoginSession();
        const preserveSameArtistRequests = sameArtistEntity && previousRoute?.kind === 'artist' && route.kind === 'artist';
        if (!preserveSameArtistRequests) abortMusicNavigationRequests();
        const controller = new AbortController();
        const token = ++musicBrowserState.navToken;
        const hash = window.location.hash;
        musicBrowserState.controller = controller;
        musicBrowserState.navigationControllers.add(controller);
        musicBrowserState.route = route;
        musicBrowserState.renderedHash = hash;
        if (!sameArtistEntity) {
            musicBrowserState.contexts.clear();
            if (route.kind !== 'artist') musicBrowserState.artistSession = null;
        }
        panelsService.modalController.open(domService.neteasePanel, closeMusicBrowser);
        document.getElementById('toggle-netease-panel').setAttribute('aria-expanded', 'true');
        domService.neteasePageTitle.textContent = getMusicRouteTitle(route);

        try {
            if (route.kind === 'search') {
                musicBrowserState.lastSearchRoute = { ...route };
                try { sessionStorage.setItem('aurora_music_last_search', buildMusicHash(route)); } catch (_) {}
                setMusicBrowserTab('search');
                domService.searchInput.value = route.q;
                document.querySelectorAll('.netease-kind-btn').forEach(button => {
                    const active = button.dataset.kind === route.type;
                    button.classList.toggle('active', active);
                    button.setAttribute('aria-selected', active ? 'true' : 'false');
                });
                if (route.q) {
                    await contentService.searchNeteaseSongs(route.q, route.type, route.page, token, controller.signal);
                } else {
                    domService.searchResults.innerHTML = '<div class="netease-empty">输入关键词开始搜索</div>';
                }
            } else if (route.kind === 'playlist-import') {
                setMusicBrowserTab('playlist');
            } else if (route.kind === 'playlist-mine') {
                setMusicBrowserTab('mylist');
                if (authService.neteaseUser && !myPlaylistsService.myPlaylistsCache) await myPlaylistsService.loadMyPlaylists();
                else if (!authService.neteaseUser) document.getElementById('mylist-content').innerHTML = '<div class="netease-empty">请先登录网易云账号</div>';
            } else if (route.kind === 'album') {
                setMusicBrowserTab('entity');
                await contentService.renderMusicAlbumPage(route, token, controller.signal, options);
            } else if (route.kind === 'artist') {
                setMusicBrowserTab('entity');
                await contentService.renderMusicArtistPage(route, token, controller.signal, options);
            } else {
                setMusicBrowserTab('entity');
                domService.neteaseBrowserView.innerHTML = `<div class="music-browser-state"><strong>${escapeHtml(route.reason || '页面不可用')}</strong><button class="music-retry-btn" data-music-home>返回搜索</button></div>`;
            }
        } catch (error) {
            if (error?.name !== 'AbortError' && currentMusicNavigationIs(token, hash)) {
                const target = route.kind === 'search' ? domService.searchResults : domService.neteaseBrowserView;
                target.innerHTML = `<div class="music-browser-state"><strong>加载失败</strong>${escapeHtml(error?.message || '未知错误')}<br><button class="music-retry-btn" data-music-reload>重试</button></div>`;
            }
        }

        if (!currentMusicNavigationIs(token, hash)) {
            musicBrowserState.navigationControllers.delete(controller);
            return;
        }
        musicBrowserState.navigationControllers.delete(controller);
        requestAnimationFrame(() => {
            if (currentMusicNavigationIs(token, hash)) domService.neteaseBrowserScroll.scrollTop = Math.max(0, Number(restoreScroll) || 0);
        });
        contentService.updateMusicMiniPlayer();
    }

    function navigateMusic(route, options = {}) {
        saveMusicScrollState();
        const hash = buildMusicHash(route);
        const url = window.location.href.split('#')[0] + hash;
        const current = getMusicHistoryState();
        const currentRoute = parseMusicRoute();
        const sameArtistViewSwitch = currentRoute?.kind === 'artist'
            && route?.kind === 'artist'
            && Number(currentRoute.id) === Number(route.id)
            && currentRoute.view !== route.view;
        const replace = options.replace ?? sameArtistViewSwitch;
        const beginsSession = options.newSession || !window.location.hash.startsWith(MUSIC_ROUTE_PREFIX) || !current;
        const musicState = beginsSession ? {
            sessionId: createMusicSessionId(), depth: 0, scrollTop: Math.max(0, Number(options.restoreScroll) || 0),
            parentUrl: options.parentUrl || window.location.href,
            hasParentEntry: options.hasParentEntry !== false,
            routeHash: hash
        } : {
            ...current,
            depth: replace ? current.depth : current.depth + 1,
            scrollTop: Math.max(0, Number(options.restoreScroll) || 0),
            routeHash: hash
        };
        const state = { ...(history.state || {}), auroraMusic: musicState };
        if (replace) history.replaceState(state, '', url);
        else history.pushState(state, '', url);
        renderMusicRoute(parseMusicRoute(hash), options.restoreScroll || 0);
    }

    function openMusicBrowser() {
        document.getElementById('toggle-netease-panel').setAttribute('aria-expanded', 'true');
        if (window.location.hash.startsWith(MUSIC_ROUTE_PREFIX)) {
            renderMusicRoute(parseMusicRoute(), history.state?.auroraMusic?.scrollTop || 0);
            return;
        }
        musicBrowserState.lastNonMusicHash = window.location.hash;
        const parentUrl = window.location.href;
        let saved = '';
        try { saved = sessionStorage.getItem('aurora_music_last_route') || ''; } catch (_) {}
        const savedRoute = parseMusicRoute(saved);
        const lastPosition = musicBrowserState.lastMusicPosition;
        navigateMusic(savedRoute && savedRoute.kind !== 'invalid' ? savedRoute : { kind: 'search', q: '', type: 'all', page: 1 }, {
            newSession: true,
            parentUrl,
            hasParentEntry: true,
            restoreScroll: lastPosition?.hash === saved ? lastPosition.scrollTop : 0
        });
    }

    function closeMusicBrowser() {
        document.getElementById('toggle-netease-panel').setAttribute('aria-expanded', 'false');
        saveMusicScrollState();
        try { sessionStorage.setItem('aurora_music_last_route', window.location.hash); } catch (_) {}
        abortMusicNavigationRequests();
        authService.cancelLoginSession();
        panelsService.modalController.close(domService.neteasePanel);
        if (window.location.hash.startsWith(MUSIC_ROUTE_PREFIX)) {
            const state = ensureMusicHistoryState();
            musicBrowserState.closingSessionId = state?.sessionId || '';
            if (state?.hasParentEntry && history.length > 1) {
                history.go(-(Math.max(0, Number(state.depth) || 0) + 1));
            } else {
                const fallback = state?.parentUrl || window.location.href.split('#')[0];
                history.replaceState({ ...(history.state || {}), auroraMusic: undefined }, '', fallback);
                musicBrowserState.renderedHash = window.location.hash;
                musicBrowserState.closingSessionId = '';
            }
        }
    }

    function syncMusicRouteFromLocation() {
        const route = parseMusicRoute();
        if (!route) {
            abortMusicNavigationRequests();
            authService.cancelLoginSession();
            panelsService.modalController.close(domService.neteasePanel, false);
            document.getElementById('toggle-netease-panel').setAttribute('aria-expanded', 'false');
            musicBrowserState.renderedHash = window.location.hash;
            musicBrowserState.closingSessionId = '';
            return;
        }
        ensureMusicHistoryState();
        if (musicBrowserState.renderedHash === window.location.hash && domService.neteasePanel.classList.contains('show')) return;
        renderMusicRoute(route, history.state?.auroraMusic?.scrollTop || 0);
    }

    let initialized = false;
    return {
        get musicBrowserState() { return musicBrowserState; },
        currentMusicNavigationIs,
        saveMusicScrollState,
        renderMusicRoute,
        navigateMusic,
        closeMusicBrowser,
        initialize() {
            if (initialized) return;
            initialized = true;
            document.getElementById('toggle-netease-panel').onclick = openMusicBrowser;

            document.getElementById('netease-close').onclick = closeMusicBrowser;

            document.getElementById('netease-nav-back').onclick = () => {
                const state = ensureMusicHistoryState();
                if (state && Number(state.depth) > 0) history.back();
                else closeMusicBrowser();
            };

            document.getElementById('netease-nav-forward').onclick = () => history.forward();

            domService.neteasePanel.addEventListener('click', event => {
                if (event.target === domService.neteasePanel) closeMusicBrowser();
            });

            domService.neteaseTabs.forEach(tab => {
                tab.onclick = () => {
                    if (tab.dataset.route === 'search') {
                        let lastSearch = musicBrowserState.lastSearchRoute;
                        if (!lastSearch) {
                            try { lastSearch = parseMusicRoute(sessionStorage.getItem('aurora_music_last_search') || ''); } catch (_) {}
                        }
                        navigateMusic(lastSearch?.kind === 'search' ? lastSearch : { kind: 'search', q: domService.searchInput.value.trim(), type: 'all', page: 1 });
                    }
                    else if (tab.dataset.route === 'playlists/import') navigateMusic({ kind: 'playlist-import' });
                    else if (tab.dataset.route === 'playlists/mine') navigateMusic({ kind: 'playlist-mine' });
                };
            });

            document.querySelectorAll('.netease-kind-btn').forEach(button => {
                button.onclick = () => navigateMusic({ kind: 'search', q: domService.searchInput.value.trim(), type: button.dataset.kind, page: 1 });
            });

            window.addEventListener('popstate', syncMusicRouteFromLocation);

            window.addEventListener('hashchange', syncMusicRouteFromLocation);

            // 搜索按钮和回车
            domService.searchBtn.onclick = () => {
                const current = parseMusicRoute();
                navigateMusic({ kind: 'search', q: domService.searchInput.value.trim(), type: current?.kind === 'search' ? current.type : 'all', page: 1 });
            };

            domService.searchInput.onkeypress = (e) => {
                if (e.key === 'Enter') {
                    const current = parseMusicRoute();
                    navigateMusic({ kind: 'search', q: domService.searchInput.value.trim(), type: current?.kind === 'search' ? current.type : 'all', page: 1 });
                }
            };

            if (window.location.hash.startsWith(MUSIC_ROUTE_PREFIX)) syncMusicRouteFromLocation();
        }
    };
}
