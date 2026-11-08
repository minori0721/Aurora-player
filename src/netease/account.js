import { cleanCookie, toHttps } from '../shared/text.js';
import { MUSIC_ROUTE_PREFIX, parseMusicRoute } from './routes.js';
import { createLoginPage, LOGIN_TIMEOUT_MS } from './login.js';
import { getMembershipStatus, parseMembership } from './membership.js';

export const VIP_REFRESH_INTERVAL_MS = 5 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

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
    publicProfile: publicProfileService,
    resolver: resolverService,
    queue: queueService,
    songActions: songActionsService,
    cloud: cloudService
} = {}) {
    // ========== 网易云登录系统 ==========
    let neteaseUser = null;

    let storedNeteaseCookie = localStorage.getItem('netease_cookie') || '';
    let neteaseCookie = cleanCookie(storedNeteaseCookie);

    // 0=普通 1=VIP 2=SVIP 3=音乐包，null=尚未确认
    let neteaseVipType = 0;
    let vipInfoPending = false;
    let membership = null;
    let membershipClockOffset = 0;
    let lastKnownVipType = null;
    let lastVipRefreshAt = -Infinity;
    let vipInfoRequest = null;
    let vipExpiryTimer = null;

    // 当前播放音质，默认极高。
    let neteaseQuality = localStorage.getItem('netease_quality') || 'exhigh';

    let authGeneration = 0;
    let loginStatusRequest = null;
    let loginStatusConfirmed = null;
    let loginStatus = neteaseCookie ? 'pending' : 'guest';

    const accountAbortControllers = new Set();
    let accountRequestSequence = 0;
    const loginPage = createLoginPage({
        api: apiService, browser: browserService, dom: domService, publicProfile: publicProfileService,
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
        songActionsService?.reset();
        cloudService?.reset();
        const generation = authGeneration;
        Promise.resolve().then(() => {
            if (generation === authGeneration) songActionsService?.setCurrentTrack(queueService?.currentTrack);
        });
        loginStatusRequest = null;
        loginStatusConfirmed = null;
        loginStatus = neteaseCookie ? 'pending' : 'guest';
        clearVipExpiryTimer();
        membership = null;
        membershipClockOffset = 0;
        lastKnownVipType = null;
        lastVipRefreshAt = -Infinity;
        vipInfoRequest = null;
        vipInfoPending = false;
        neteaseVipType = 0;
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
        myPlaylistsService.reset();
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
                if (!response.ok && response.status !== 301) throw new Error(`HTTP ${response.status}`);
                const json = await response.json();
                if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { apiCode: Number(json.data?.code ?? json.code) });
                return json;
            })()]);
        } finally {
            window.clearTimeout(timer);
            controller.signal.removeEventListener('abort', abort);
            accountAbortControllers.delete(controller);
        }
    }

    function clearVipExpiryTimer() {
        if (vipExpiryTimer !== null) window.clearTimeout(vipExpiryTimer);
        vipExpiryTimer = null;
    }

    function updateMembershipStatus() {
        clearVipExpiryTimer();
        const now = Date.now() + membershipClockOffset;
        const status = getMembershipStatus(membership, now);
        neteaseVipType = status.type;
        if (status.type !== null) {
            if (lastKnownVipType !== null && lastKnownVipType !== status.type) {
                resolverService.clearNeteaseResolvedAudioCache({ entitlementsChanged: true });
                prefetchService.cancelNextPreload({ resetDetails: false });
            }
            lastKnownVipType = status.type;
        }
        if (status.expiresAt && !document.hidden) {
            const snapshot = captureAuthSnapshot();
            vipExpiryTimer = window.setTimeout(() => {
                vipExpiryTimer = null;
                if (!isAuthSnapshotCurrent(snapshot)) return;
                updateMembershipStatus();
                updateUserUI();
                if (Date.now() + membershipClockOffset >= status.expiresAt && !document.hidden) {
                    void refreshVipInfo({ force: true });
                }
            }, Math.min(MAX_TIMER_MS, status.expiresAt - now));
        }
        return status;
    }

    function refreshVipInfo({ force = false } = {}) {
        if (!neteaseUser || !neteaseCookie) return Promise.resolve(false);
        if (membership) {
            const previous = neteaseVipType;
            updateMembershipStatus();
            if (previous !== neteaseVipType) force = true;
        }
        if (vipInfoRequest) return vipInfoRequest.promise;
        if (!force && Date.now() - lastVipRefreshAt < VIP_REFRESH_INTERVAL_MS) {
            updateUserUI();
            return Promise.resolve(false);
        }
        const snapshot = captureAuthSnapshot();
        const job = { promise: null };
        vipInfoRequest = job;
        lastVipRefreshAt = Date.now();
        if (!membership) neteaseVipType = null;
        vipInfoPending = true;
        updateUserUI();
        job.promise = fetchVipInfo(snapshot).finally(() => {
            if (vipInfoRequest === job && isAuthSnapshotCurrent(snapshot)) {
                vipInfoRequest = null;
                vipInfoPending = false;
                updateUserUI();
            }
        });
        return job.promise;
    }

    function commitLogin(cookie, profile, isCurrent) {
        if (!isCurrent()) return null;
        advanceAuthGeneration();
        neteaseCookie = cleanCookie(cookie);
        neteaseUser = profile;
        loginStatusConfirmed = true;
        loginStatus = 'authenticated';
        try { localStorage.setItem('netease_cookie', neteaseCookie); }
        catch (_) { debugService.log('登录状态无法保存，关闭网页后需重新登录', 'warn'); }
        const snapshot = captureAuthSnapshot();
        void refreshVipInfo({ force: true });
        void onlinePlaylistService.refreshQueueSource();
        return snapshot;
    }

    // 检查登录状态
    function waitForLoginStatus() {
        if (loginStatusRequest) return loginStatusRequest;
        if (loginStatusConfirmed !== null) return Promise.resolve(loginStatusConfirmed);
        const snapshot = captureAuthSnapshot();
        const promise = checkLoginStatus().then(valid => {
            if (isAuthSnapshotCurrent(snapshot)) loginStatusConfirmed = valid;
            return valid;
        }).finally(() => {
            if (loginStatusRequest === promise) loginStatusRequest = null;
        });
        loginStatusRequest = promise;
        return promise;
    }

    async function checkLoginStatus() {
        if (!neteaseCookie) {
            loginStatus = 'guest';
            neteaseUser = null;
            neteaseVipType = 0;
            updateUserUI();
            return false;
        }

        const snapshot = captureAuthSnapshot();
        try {
            const json = await accountPost('/login/status', { cookie: cleanCookie(snapshot.cookie) });
            if (!isAuthSnapshotCurrent(snapshot)) return false;
            if (Number(json.data?.code ?? json.code ?? 200) === 200
                && Number.isSafeInteger(Number(json.data?.profile?.userId)) && Number(json.data.profile.userId) > 0) {
                neteaseUser = json.data.profile;
                loginStatus = 'authenticated';
                songActionsService?.setCurrentTrack(queueService?.currentTrack);
                void refreshVipInfo({ force: true });
                debugService.log(`已登录：${neteaseUser.nickname}`, 'success');
                const currentRoute = parseMusicRoute();
                if (currentRoute?.kind === 'playlist-mine' && domService.neteasePanel.classList.contains('show')) {
                    void browserService.renderMusicRoute(currentRoute, domService.neteaseBrowserScroll.scrollTop);
                }
                return true;
            }
            const code = Number(json.data?.code ?? json.code);
            loginStatus = code === 301 || code === 200 && json.data?.profile === null ? 'expired' : 'unavailable';
            neteaseUser = null;
            neteaseVipType = 0;
            updateUserUI();
        } catch (e) {
            if (isAuthSnapshotCurrent(snapshot)) {
                loginStatus = e.apiCode === 301 ? 'expired' : 'unavailable';
                if (e.name !== 'AbortError') debugService.log('登录状态检查失败：' + e.message, 'error');
            }
        }
        return false;
    }

    // 获取VIP信息
    async function fetchVipInfo(snapshot = captureAuthSnapshot()) {
        try {
            const json = await accountPost('/vip/info', { cookie: cleanCookie(snapshot.cookie) });
            if (!isAuthSnapshotCurrent(snapshot)) return false;
            const parsed = Number(json.code) === 200 ? parseMembership(json.data) : null;
            if (!parsed) throw new Error('会员信息响应无效');
            membership = parsed;
            membershipClockOffset = parsed.serverNow === null ? 0 : parsed.serverNow - Date.now();
            updateMembershipStatus();
            neteaseQuality = localStorage.getItem('netease_quality') || (neteaseVipType > 0 ? 'lossless' : 'exhigh');
            domService.qualitySelect.value = neteaseQuality;
            localStorage.setItem('netease_quality', neteaseQuality);
            return true;
        } catch (e) {
            if (isAuthSnapshotCurrent(snapshot)) {
                clearVipExpiryTimer();
                membership = null;
                neteaseVipType = null;
                if (e.name !== 'AbortError') debugService.log('会员信息获取失败', 'warn');
            }
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
        showLogin(mode) {
            if (!domService.neteasePanel.classList.contains('show')) browserService.openMusicBrowser?.();
            return loginPage.open(mode);
        },
        refreshQRCode: loginPage.refreshQRCode,
        refreshVipInfo,
        waitForLoginStatus,
        neteaseLogout,
        get neteaseUser() { return neteaseUser; },
        get neteaseCookie() { return neteaseCookie; },
        get loginStatus() { return loginStatus; },
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
            const onForeground = () => {
                if (document.hidden) clearVipExpiryTimer();
                else void refreshVipInfo();
            };
            document.addEventListener('visibilitychange', onForeground);
            window.addEventListener('focus', onForeground);

            domService.qualitySelect.onchange = () => {
                neteaseQuality = domService.qualitySelect.value;
                prefetchService.cancelNextPreload();
                resolverService.clearNeteaseResolvedAudioCache();
                localStorage.setItem('netease_quality', neteaseQuality);
                debugService.log(`音质设置: ${domService.qualitySelect.options[domService.qualitySelect.selectedIndex].text}`);
            };

            // 初始化时检查登录状态
            void waitForLoginStatus();
        }
    };
}
