import { cleanCookie, toHttps } from '../shared/text.js';
import { MUSIC_ROUTE_PREFIX, parseMusicRoute } from './routes.js';
import { createLoginPage, LOGIN_TIMEOUT_MS } from './login.js';

export function createAuth({
    api: apiService,
    browser: browserService,
    cache: cacheService,
    content: contentService,
    debug: debugService,
    dom: domService,
    download: downloadService,
    myPlaylists: myPlaylistsService,
    onlinePlaylist: onlinePlaylistService,
    playback: playbackService,
    prefetch: prefetchService,
    resolver: resolverService
} = {}) {
    // ========== 网易云登录系统 ==========
    let neteaseUser = null;

    let storedNeteaseCookie = localStorage.getItem('netease_cookie') || '';
    let neteaseCookie = cleanCookie(storedNeteaseCookie);

    // 当前播放音质
    let neteaseVipType = 0;
    let vipInfoPending = false;

    // 0=普通 1=VIP 2=SVIP 3=音乐包
    let neteaseQuality = localStorage.getItem('netease_quality') || 'exhigh';

    // 默认极高
    let authGeneration = 0;

    const accountAbortControllers = new Set();
    let accountRequestSequence = 0;
    const loginPage = createLoginPage({
        api: apiService, browser: browserService, dom: domService,
        captureAuthSnapshot, isAuthSnapshotCurrent, commitLogin
    });

    function abortAccountRequests() {
        accountAbortControllers.forEach(controller => {
            try { controller.abort(); } catch (_) {}
        });
        accountAbortControllers.clear();
    }

    function advanceAuthGeneration() {
        authGeneration++;
        downloadService.cancelDownloadProbes();
        onlinePlaylistService.cancelPlaylistLoad('auth-changed');
        abortAccountRequests();
        prefetchService.cancelNextPreload();
        if (playbackService.currentAbortController) {
            playbackService.currentAbortController.abort();
            playbackService.currentAbortController = null;
            if (playbackService.playbackState.status === 'loading' && typeof playbackService.setPlaybackStatus === 'function') playbackService.setPlaybackStatus('paused');
        }
        cacheService.clearAccountJsonCache();
        resolverService.clearNeteaseResolvedAudioCache();
        prefetchService.resetNeteaseDetailPrefetchState();
        if (myPlaylistsService.myPlaylistsAbortController) {
            try { myPlaylistsService.myPlaylistsAbortController.abort(); } catch (_) {}
            myPlaylistsService.myPlaylistsAbortController = null;
        }
        myPlaylistsService.myPlaylistsLoadToken++;
        myPlaylistsService.myPlaylistsCache = null;
        myPlaylistsService.myPlaylistsData = [];
        myPlaylistsService.myPlaylistsLoading = false;
        myPlaylistsService.myPlaylistsLoadPromise = null;
        return authGeneration;
    }

    function captureAuthSnapshot() {
        return { generation: authGeneration, cookie: neteaseCookie };
    }

    function isAuthSnapshotCurrent(snapshot) {
        return snapshot && snapshot.generation === authGeneration && snapshot.cookie === neteaseCookie;
    }

    async function accountFetch(url, options = {}) {
        const controller = new AbortController();
        const externalSignal = options.signal;
        const abortFromExternal = () => controller.abort();
        if (externalSignal) {
            if (externalSignal.aborted) controller.abort();
            else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
        }
        accountAbortControllers.add(controller);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            accountAbortControllers.delete(controller);
            if (externalSignal) externalSignal.removeEventListener('abort', abortFromExternal);
        }
    }

    async function accountPost(path, data) {
        const controller = new AbortController();
        let timer, abort;
        const stopped = new Promise((_, reject) => {
            abort = () => reject(new DOMException('Cancelled', 'AbortError'));
            controller.signal.addEventListener('abort', abort, { once: true });
            timer = window.setTimeout(() => {
                reject(Object.assign(new Error('请求超时'), { name: 'TimeoutError' }));
                controller.abort();
            }, LOGIN_TIMEOUT_MS);
        });
        accountAbortControllers.add(controller);
        try {
            return await Promise.race([stopped, (async () => {
                const response = await fetch(apiService.buildApiUrl(`${path}?timestamp=${Date.now()}&accountNonce=${++accountRequestSequence}`), {
                    method: 'POST', cache: 'no-store', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data), signal: controller.signal
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return await response.json();
            })()]);
        } finally {
            window.clearTimeout(timer);
            controller.signal.removeEventListener('abort', abort);
            accountAbortControllers.delete(controller);
        }
    }

    function refreshVipInfo(snapshot) {
        neteaseVipType = null;
        vipInfoPending = true;
        updateUserUI();
        void fetchVipInfo(snapshot).then(() => {
            if (!isAuthSnapshotCurrent(snapshot)) return;
            vipInfoPending = false;
            updateUserUI();
        });
    }

    function commitLogin(cookie, profile, isCurrent) {
        if (!isCurrent()) return null;
        advanceAuthGeneration();
        neteaseCookie = cleanCookie(cookie);
        neteaseUser = profile;
        try { localStorage.setItem('netease_cookie', neteaseCookie); }
        catch (_) { debugService.log('登录状态无法保存，关闭网页后需重新登录', 'warn'); }
        const snapshot = captureAuthSnapshot();
        refreshVipInfo(snapshot);
        return snapshot;
    }

    // 检查登录状态
    async function checkLoginStatus() {
        if (!neteaseCookie) {
            neteaseUser = null;
            neteaseVipType = 0;
            updateUserUI();
            return false;
        }

        const snapshot = captureAuthSnapshot();
        try {
            const json = await accountPost('/login/status', { cookie: cleanCookie(snapshot.cookie) });
            if (!isAuthSnapshotCurrent(snapshot)) return false;
            if (Number.isSafeInteger(Number(json.data?.profile?.userId)) && Number(json.data.profile.userId) > 0) {
                neteaseUser = json.data.profile;
                refreshVipInfo(snapshot);
                debugService.log(`已登录：${neteaseUser.nickname}`, 'success');
                const currentRoute = parseMusicRoute();
                if (currentRoute?.kind === 'playlist-mine' && domService.neteasePanel.classList.contains('show')) {
                    void myPlaylistsService.loadMyPlaylists();
                }
                return true;
            }
            neteaseUser = null;
            neteaseVipType = 0;
            updateUserUI();
        } catch (e) {
            if (e.name !== 'AbortError' && isAuthSnapshotCurrent(snapshot)) debugService.log('登录状态检查失败：' + e.message, 'error');
        }
        return false;
    }

    // 获取VIP信息
    async function fetchVipInfo(snapshot = captureAuthSnapshot()) {
        try {
            const json = await accountPost('/vip/info', { cookie: cleanCookie(snapshot.cookie) });
            if (!isAuthSnapshotCurrent(snapshot)) return false;
            // redVipLevel: 0=普通 1=VIP; musicPackage=音乐包
            const vipInfo = json.data;
            if (!vipInfo || typeof vipInfo !== 'object') return false;
            if (vipInfo.redVipLevel >= 7) {
                neteaseVipType = 2; // SVIP
                neteaseQuality = localStorage.getItem('netease_quality') || 'lossless';
            } else if (vipInfo.redVipLevel >= 1) {
                neteaseVipType = 1; // VIP
                neteaseQuality = localStorage.getItem('netease_quality') || 'lossless';
            } else if (vipInfo.musicPackage?.vipCode) {
                neteaseVipType = 3; // 音乐包
                neteaseQuality = localStorage.getItem('netease_quality') || 'lossless';
            } else {
                neteaseVipType = 0; // 普通
                neteaseQuality = localStorage.getItem('netease_quality') || 'exhigh';
            }
            domService.qualitySelect.value = neteaseQuality;
            localStorage.setItem('netease_quality', neteaseQuality);
            return true;
        } catch (e) {
            if (e.name !== 'AbortError' && isAuthSnapshotCurrent(snapshot)) debugService.log('会员信息获取失败', 'warn');
        }
        return false;
    }

    // 更新用户界面
    function updateUserUI() {
        const userBar = document.getElementById('netease-user-bar');
        const loginBtn = document.getElementById('netease-login-btn');
        const qualityBar = document.getElementById('netease-quality-bar');

        if (neteaseUser) {
            document.getElementById('netease-avatar').src = toHttps(neteaseUser.avatarUrl);
            document.getElementById('netease-nickname').textContent = neteaseUser.nickname;
            document.getElementById('netease-user-id').textContent = 'ID: ' + neteaseUser.userId;

            // 显示VIP状态
            const userTypeEl = document.getElementById('netease-user-type');
            const typeMap = {
                0: { text: '普通用户', cls: 'normal' },
                1: { text: 'VIP会员', cls: 'vip' },
                2: { text: 'SVIP会员', cls: 'svip' },
                3: { text: '音乐包', cls: 'music-pack' }
            };
            const typeInfo = neteaseVipType === null
                ? { text: vipInfoPending ? '会员状态查询中' : '会员状态暂不可用', cls: 'normal' }
                : typeMap[neteaseVipType] || typeMap[0];
            userTypeEl.textContent = typeInfo.text;
            userTypeEl.className = 'netease-user-type ' + typeInfo.cls;

            userBar.style.display = 'flex';
            loginBtn.style.display = 'none';
            qualityBar.style.display = 'flex';
        } else {
            userBar.style.display = 'none';
            loginBtn.style.display = 'block';
            qualityBar.style.display = 'none';
        }
    }

    // 退出登录
    const neteaseLogout = async function() {
        neteaseCookie = '';
        advanceAuthGeneration();
        loginPage.cancel();
        neteaseUser = null;
        neteaseVipType = 0;
        vipInfoPending = false;
        localStorage.removeItem('netease_cookie');
        await cacheService.purgeSensitiveIdbCache();
        updateUserUI();
        contentService.clearMusicImages(document.getElementById('mylist-content'));
        document.getElementById('mylist-content').innerHTML = '<div class="netease-empty">请先登录网易云账号</div>';
        if (window.location.hash.startsWith(MUSIC_ROUTE_PREFIX) && domService.neteasePanel.classList.contains('show')) {
            browserService.renderMusicRoute(parseMusicRoute(), domService.neteaseBrowserScroll.scrollTop);
        }
        debugService.log('已退出登录');
    };

    let initialized = false;
    return {
        showLogin: loginPage.open,
        refreshQRCode: loginPage.refreshQRCode,
        neteaseLogout,
        get neteaseUser() { return neteaseUser; },
        get neteaseCookie() { return neteaseCookie; },
        cancelLoginSession: loginPage.cancel,
        get neteaseQuality() { return neteaseQuality; },
        get authGeneration() { return authGeneration; },
        get accountAbortControllers() { return accountAbortControllers; },
        captureAuthSnapshot,
        isAuthSnapshotCurrent,
        accountFetch,
        initialize() {
            if (initialized) return;
            initialized = true;
            if (storedNeteaseCookie !== neteaseCookie) {
                try {
                    if (neteaseCookie) localStorage.setItem('netease_cookie', neteaseCookie);
                    else localStorage.removeItem('netease_cookie');
                } catch (_) { debugService.log('登录凭据已规范化，但无法保存到本地', 'warn'); }
            }
            storedNeteaseCookie = '';
            loginPage.initialize();
            domService.qualitySelect.value = neteaseQuality;

            domService.qualitySelect.onchange = () => {
                neteaseQuality = domService.qualitySelect.value;
                prefetchService.cancelNextPreload();
                resolverService.clearNeteaseResolvedAudioCache();
                localStorage.setItem('netease_quality', neteaseQuality);
                debugService.log(`音质设置: ${domService.qualitySelect.options[domService.qualitySelect.selectedIndex].text}`);
            };

            // 初始化时检查登录状态
            checkLoginStatus();
        }
    };
}
