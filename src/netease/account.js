import { cleanCookie, escapeHtml, toHttps } from '../shared/text.js';
import { MUSIC_ROUTE_PREFIX, parseMusicRoute } from './routes.js';

export function createAuth({
    api: apiService,
    browser: browserService,
    cache: cacheService,
    debug: debugService,
    dom: domService,
    download: downloadService,
    myPlaylists: myPlaylistsService,
    onlinePlaylist: onlinePlaylistService,
    playback: playbackService,
    prefetch: prefetchService,
    resolver: resolverService
} = {}) {
    let neteaseQrAbortController = null;

    // ========== 网易云登录系统 ==========
    let neteaseUser = null;

    let neteaseCookie = localStorage.getItem('netease_cookie') || '';

    let qrCheckTimer = null;

    let qrLoginSession = null;

    function cancelQRCodeSession(clearReturn = true) {
        const session = qrLoginSession;
        qrLoginSession = null;
        session?.controller.abort();
        clearTimeout(session?.timer);
        clearTimeout(session?.returnTimer);
        clearTimeout(qrCheckTimer);
        qrCheckTimer = null;
        neteaseQrAbortController = null;
        if (clearReturn) browserService.musicBrowserState.authReturnHash = '';
    }

    function isQRCodeSessionCurrent(session) {
        return qrLoginSession === session && !session.controller.signal.aborted
            && browserService.currentMusicNavigationIs(session.navToken, session.hash)
            && domService.neteasePanel.classList.contains('show') && isAuthSnapshotCurrent(session.authSnapshot);
    }

    // 当前播放音质
    let neteaseVipType = 0;

    // 0=普通 1=VIP 2=SVIP 3=音乐包
    let neteaseQuality = localStorage.getItem('netease_quality') || 'exhigh';

    // 默认极高
    let authGeneration = 0;

    const accountAbortControllers = new Set();

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
        try { prefetchService.cancelNextPreload(); } catch (_) {}
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
            const resp = await accountFetch(apiService.buildApiUrl(`/login/status?cookie=${encodeURIComponent(cleanCookie(snapshot.cookie))}`));
            if (resp.ok) {
                const json = await resp.json();
                if (!isAuthSnapshotCurrent(snapshot)) return false;
                if (json.data?.profile) {
                    await fetchVipInfo(snapshot);
                    if (!isAuthSnapshotCurrent(snapshot)) return false;
                    neteaseUser = json.data.profile;
                    updateUserUI();
                    debugService.log(`Logged in as: ${neteaseUser.nickname}`, 'success');
                    const currentRoute = parseMusicRoute();
                    if (currentRoute?.kind === 'playlist-mine' && domService.neteasePanel.classList.contains('show')) {
                        void myPlaylistsService.loadMyPlaylists();
                    }
                    return true;
                }
                neteaseUser = null;
                neteaseVipType = 0;
                updateUserUI();
            }
        } catch (e) {
            if (e.name !== 'AbortError' && isAuthSnapshotCurrent(snapshot)) debugService.log('Login check failed: ' + e.message, 'error');
        }
        return false;
    }

    // 获取VIP信息
    async function fetchVipInfo(snapshot = captureAuthSnapshot()) {
        try {
            const resp = await accountFetch(apiService.buildApiUrl(`/vip/info?cookie=${encodeURIComponent(cleanCookie(snapshot.cookie))}`));
            if (resp.ok) {
                const json = await resp.json();
                if (!isAuthSnapshotCurrent(snapshot)) return false;
                // redVipLevel: 0=普通 1=VIP; musicPackage=音乐包
                const vipInfo = json.data;
                if (vipInfo?.redVipLevel >= 7) {
                    neteaseVipType = 2; // SVIP
                    neteaseQuality = localStorage.getItem('netease_quality') || 'lossless';
                } else if (vipInfo?.redVipLevel >= 1) {
                    neteaseVipType = 1; // VIP
                    neteaseQuality = localStorage.getItem('netease_quality') || 'lossless';
                } else if (vipInfo?.musicPackage?.vipCode) {
                    neteaseVipType = 3; // 音乐包
                    neteaseQuality = localStorage.getItem('netease_quality') || 'lossless';
                } else {
                    neteaseVipType = 0; // 普通
                    neteaseQuality = localStorage.getItem('netease_quality') || 'exhigh';
                }
                domService.qualitySelect.value = neteaseQuality;
                localStorage.setItem('netease_quality', neteaseQuality);
                return true;
            }
        } catch (e) {
            if (e.name !== 'AbortError' && isAuthSnapshotCurrent(snapshot)) debugService.log('VIP info fetch failed', 'warn');
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
            const typeInfo = typeMap[neteaseVipType] || typeMap[0];
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

    // 显示二维码登录
    async function showQRLogin() {
        if (!browserService.musicBrowserState.authReturnHash && window.location.hash.startsWith(MUSIC_ROUTE_PREFIX)) {
            browserService.musicBrowserState.authReturnHash = window.location.hash;
        }
        // 切换到登录Tab
        document.querySelectorAll('.netease-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.netease-tab-content').forEach(c => c.style.display = 'none');
        document.getElementById('tab-qrlogin').style.display = 'block';
        domService.neteasePageTitle.textContent = '扫码登录';

        await generateQRCode();
    }

    async function generateQRCode() {
        cancelQRCodeSession(false);
        const session = {
            controller: new AbortController(), timer: null, returnTimer: null, completed: false,
            navToken: browserService.musicBrowserState.navToken, hash: window.location.hash,
            authSnapshot: captureAuthSnapshot(),
            returnHash: browserService.musicBrowserState.authReturnHash || window.location.hash,
            returnScroll: domService.neteaseBrowserScroll.scrollTop
        };
        qrLoginSession = session;
        neteaseQrAbortController = session.controller;
        const qrSignal = session.controller.signal;
        const imgWrap = document.getElementById('qrcode-img-wrap');
        const status = document.getElementById('qrcode-status');
        imgWrap.innerHTML = '<div class="netease-loading">生成二维码中...</div>';
        status.textContent = '等待扫描...';
        status.className = 'qrcode-status waiting';

        try {
            const keyResp = await fetch(apiService.buildApiUrl(`/login/qr/key?timestamp=${Date.now()}`), { signal: qrSignal });
            if (!keyResp.ok) throw new Error('无法获取二维码');
            const keyJson = await keyResp.json();
            if (!isQRCodeSessionCurrent(session)) return;
            if (!keyJson.data?.unikey) throw new Error('无法获取二维码key');
            const qrKey = keyJson.data.unikey;
            const imgResp = await fetch(apiService.buildApiUrl(`/login/qr/create?key=${qrKey}&qrimg=true&timestamp=${Date.now()}`), { signal: qrSignal });
            if (!imgResp.ok) throw new Error('无法生成二维码图片');
            const imgJson = await imgResp.json();
            if (!isQRCodeSessionCurrent(session)) return;
            if (!imgJson.data?.qrimg) throw new Error('无法生成二维码');
            imgWrap.innerHTML = `<img src="${escapeHtml(toHttps(imgJson.data.qrimg))}" alt="QR Code">`;
            const schedulePoll = () => {
                session.timer = setTimeout(poll, 2000);
                qrCheckTimer = session.timer;
            };
            const poll = async () => {
                try {
                    if (!isQRCodeSessionCurrent(session) || session.completed) return;
                    const response = await fetch(apiService.buildApiUrl(`/login/qr/check?key=${qrKey}&timestamp=${Date.now()}&noCookie=true`), { signal: qrSignal });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const json = await response.json();
                    if (!isQRCodeSessionCurrent(session) || session.completed) return;
                    if (json.code === 800) {
                        session.completed = true;
                        status.textContent = '二维码已过期，请刷新';
                        status.className = 'qrcode-status expired';
                    } else if (json.code === 801) {
                        status.textContent = '等待扫描...';
                        status.className = 'qrcode-status waiting';
                    } else if (json.code === 802) {
                        status.textContent = '已扫描，请在手机上确认登录';
                        status.className = 'qrcode-status scanned';
                    } else if (json.code === 803) {
                        session.completed = true;
                        qrCheckTimer = null;
                        status.textContent = '登录成功！';
                        status.className = 'qrcode-status success';
                        const nextCookie = cleanCookie(json.cookie || '');
                        advanceAuthGeneration();
                        neteaseCookie = nextCookie;
                        session.authSnapshot = captureAuthSnapshot();
                        localStorage.setItem('netease_cookie', neteaseCookie);
                        await checkLoginStatus();
                        if (!isQRCodeSessionCurrent(session)) return;
                        session.returnTimer = setTimeout(() => {
                            if (!isQRCodeSessionCurrent(session)) return;
                            const parsed = parseMusicRoute(session.returnHash);
                            const route = parsed && parsed.kind !== 'invalid' ? parsed
                                : { kind: 'search', q: '', type: 'all', page: 1 };
                            browserService.musicBrowserState.authReturnHash = '';
                            browserService.navigateMusic(route, { replace: true, restoreScroll: session.returnScroll });
                        }, 1000);
                    }
                } catch (error) {
                    if (error?.name === 'AbortError') return;
                }
                if (isQRCodeSessionCurrent(session) && !session.completed) schedulePoll();
            };
            schedulePoll();
        } catch (error) {
            if (!isQRCodeSessionCurrent(session) || error?.name === 'AbortError') return;
            imgWrap.innerHTML = '<div class="netease-empty">生成失败: ' + escapeHtml(error.message) + '</div>';
            debugService.log('QR generate error: ' + error.message, 'error');
        }
    }

    // 刷新二维码
    const refreshQRCode = generateQRCode;

    // 退出登录
    const neteaseLogout = async function() {
        neteaseCookie = '';
        advanceAuthGeneration();
        cancelQRCodeSession();
        neteaseUser = null;
        neteaseVipType = 0;
        localStorage.removeItem('netease_cookie');
        await cacheService.purgeSensitiveIdbCache();
        updateUserUI();
        document.getElementById('mylist-content').innerHTML = '<div class="netease-empty">请先登录网易云账号</div>';
        if (window.location.hash.startsWith(MUSIC_ROUTE_PREFIX) && domService.neteasePanel.classList.contains('show')) {
            browserService.renderMusicRoute(parseMusicRoute(), domService.neteaseBrowserScroll.scrollTop);
        }
        debugService.log('Logged out');
    };

    let initialized = false;
    return {
        showQRLogin,
        refreshQRCode,
        neteaseLogout,
        get neteaseUser() { return neteaseUser; },
        get neteaseCookie() { return neteaseCookie; },
        cancelQRCodeSession,
        get neteaseQuality() { return neteaseQuality; },
        get authGeneration() { return authGeneration; },
        get accountAbortControllers() { return accountAbortControllers; },
        captureAuthSnapshot,
        isAuthSnapshotCurrent,
        accountFetch,
        initialize() {
            if (initialized) return;
            initialized = true;
            domService.qualitySelect.value = neteaseQuality;

            domService.qualitySelect.onchange = () => {
                neteaseQuality = domService.qualitySelect.value;
                try { prefetchService.cancelNextPreload(); } catch (_) {}
                resolverService.clearNeteaseResolvedAudioCache();
                localStorage.setItem('netease_quality', neteaseQuality);
                debugService.log(`音质设置: ${domService.qualitySelect.options[domService.qualitySelect.selectedIndex].text}`);
            };

            // 初始化时检查登录状态
            checkLoginStatus();
        }
    };
}
