import { cleanCookie } from '../shared/text.js';
import { formatSampleRate, inferAudioTypeFromUrl } from '../audio/quality.js';
import { getNeteaseSongArtists } from '../lyrics/matching.js';

export function createDownload({
    api: apiService,
    auth: authService,
    cache: cacheService,
    debug: debugService,
    dom: domService,
    panels: panelsService,
    playback: playbackService,
    resolver: resolverService
} = {}) {
    let _currentPlaying = null;

    const QUALITY_LEVELS = [
        { key: 'standard', label: '标准 (128kbps)' },
        { key: 'higher', label: '较高 (192kbps)' },
        { key: 'exhigh', label: '极高 (320kbps)' },
        { key: 'lossless', label: '无损 (FLAC)' },
        { key: 'hires', label: 'Hi-Res' }
    ];

    let downloadProbeToken = 0;

    let downloadProbeController = null;

    function cancelDownloadProbes() {
        downloadProbeToken++;
        downloadProbeController?.abort();
        downloadProbeController = null;
    }

    function extractNeteaseQualityDetail(payload, level) {
        const roots = [payload?.data, payload?.result, payload].filter(Boolean);
        const aliases = {
            standard: ['standard', 'low', 'l'],
            higher: ['higher', 'medium', 'm'],
            exhigh: ['exhigh', 'high', 'h'],
            lossless: ['lossless', 'sq'],
            hires: ['hires', 'hr']
        };
        for (const root of roots) {
            const qualityMap = root.qualities || root.quality || root;
            for (const key of aliases[level] || [level]) {
                const value = qualityMap?.[key];
                if (value && typeof value === 'object') return value;
            }
        }
        return null;
    }

    function formatNeteaseQualityDetail(detail) {
        if (!detail) return '';
        const parts = [];
        const br = Number(detail.br || 0);
        const size = Number(detail.size || 0);
        const sr = Number(detail.sr || 0);
        if (br > 0) parts.push(`${Math.round(br / 1000)}kbps`);
        if (sr > 0) parts.push(formatSampleRate(sr));
        if (size > 0) parts.push(`${(size / 1024 / 1024).toFixed(1)}MB`);
        return parts.join(' · ');
    }

    function closeDownloadModal() {
        cancelDownloadProbes();
        panelsService.modalController.close(domService.downloadModal);
        domService.downloadListEl.innerHTML = '';
    }

    let initialized = false;
    return {
        get _currentPlaying() { return _currentPlaying; },
        set _currentPlaying(value) { _currentPlaying = value; },
        cancelDownloadProbes,
        initialize() {
            if (initialized) return;
            initialized = true;
            domService.downloadClose.onclick = closeDownloadModal;

            domService.downloadCancel.onclick = closeDownloadModal;

            domService.downloadModal.addEventListener('click', event => {
                if (event.target === domService.downloadModal) closeDownloadModal();
            });

            // 移动端按钮触发桌面下载逻辑（复用同一逻辑）
            if (domService.downloadBtnMobile) {
                domService.downloadBtnMobile.onclick = () => { if (domService.downloadBtn) domService.downloadBtn.click(); };
            }

            // 弹出下载模态并检测各音质可用性
            domService.downloadBtn.onclick = async function() {
                const playing = _currentPlaying || null;
                if (!playing || playing.playToken !== playbackService._currentPlayActionToken) {
                    alert('当前没有正在播放的可下载歌曲');
                    return;
                }
                if (!playing.netease) {
                    alert('当前仅支持网易云在线歌曲下载');
                    return;
                }
                const songId = playing.songId || playing.id || (playing.songData && (playing.songData.id || playing.songData.songId));
                const songName = playing.songData?.name || playing.name || 'Unknown';
                const artists = getNeteaseSongArtists(playing.songData || playing).join(', ');

                domService.downloadTitle.textContent = '下载音质';
                domService.downloadTrackInfo.textContent = `${songName}${artists ? ' — ' + artists : ''}`;
                panelsService.modalController.open(domService.downloadModal, closeDownloadModal);

                domService.downloadListEl.innerHTML = '';
                const cookieParam = authService.neteaseCookie ? `&cookie=${encodeURIComponent(cleanCookie(authService.neteaseCookie))}` : '';
                cancelDownloadProbes();
                const probeController = new AbortController();
                downloadProbeController = probeController;
                const probeSignal = probeController.signal;
                const probeToken = ++downloadProbeToken;
                const probeAuth = authService.captureAuthSnapshot();
                const probeIsCurrent = () => probeToken === downloadProbeToken && !probeSignal.aborted && authService.isAuthSnapshotCurrent(probeAuth);
                const probeOptions = { useQueue: true, signal: probeSignal, priority: 'normal' };
                const qualityDetailPromise = cacheService.cachedFetchJson(
                    apiService.buildApiUrl(`/song/music/detail?id=${songId}${cookieParam}`),
                    probeOptions,
                    300_000
                ).catch(error => {
                    if (error?.name !== 'AbortError') debugService.log(`歌曲音质详情读取失败: ${error?.message || error}`, 'warn');
                    return null;
                });

                const probeJobs = [];
                for (const q of QUALITY_LEVELS) {
                    const item = document.createElement('div');
                    item.className = 'quality-item';
                    item.dataset.level = q.key;
                    const left = document.createElement('div');
                    left.innerHTML = `<div style="font-weight:600">${q.label}</div><div class="quality-meta">检测中…</div>`;
                    const right = document.createElement('div');
                    right.className = 'quality-action';
                    const checkBtn = document.createElement('button');
                    checkBtn.className = 'glass-btn';
                    checkBtn.textContent = '检测';
                    right.appendChild(checkBtn);
                    item.appendChild(left);
                    item.appendChild(right);
                    domService.downloadListEl.appendChild(item);

                    probeJobs.push(() => (async function(it, level){
                        try {
                            const metaEl = it.querySelector('.quality-meta');
                            const rightArea = it.querySelector('.quality-action');
                            const detailPayload = await qualityDetailPromise;
                            if (!probeIsCurrent()) return;
                            const detail = extractNeteaseQualityDetail(detailPayload, level);
                            const detailText = formatNeteaseQualityDetail(detail);
                            if (detailText) metaEl.textContent = `${detailText} · 检测下载链接…`;

                            let data = null;
                            let useMatchForVip = false;
                            let matchSource = '';

                            // 1. 优先尝试官方客户端下载接口；如果只有试听或没有链接，再交给 match 兜底。
                            try {
                                const downloadJson = await cacheService.cachedFetchJson(apiService.buildApiUrl(`/song/download/url/v1?id=${songId}&level=${level}${cookieParam}`), probeOptions, 30_000);
                                if (!probeIsCurrent()) return;
                                if (downloadJson?.data?.url && !resolverService.isNeteaseTrialOnly(downloadJson.data)) {
                                    data = downloadJson.data;
                                }
                            } catch(e) {
                                if (e?.name === 'AbortError' || !probeIsCurrent()) return;
                                // 接口拉取失败
                            }

                            // 2. 如果官方下载接口没拿到完整音频，无缝切入 match 接口兜底。
                            if (!data || !data.url) {
                                useMatchForVip = true;
                                try {
                                    const matchResult = await resolverService.fetchNeteaseMatchAudio(songId, cookieParam, probeOptions, 30_000, resolverService.getNeteaseMatchStrategy(level));
                                    if (!probeIsCurrent()) return;
                                    if (matchResult.audioUrl) {
                                        const matchUrl = matchResult.audioUrl;
                                        let matchExt = inferAudioTypeFromUrl(matchUrl);
                                        matchSource = matchResult.source || '';

                                        data = {
                                            url: matchUrl,
                                            br: 0,
                                            size: 0,
                                            type: matchExt, // 根据实际链接动态判断格式
                                            fee: 1
                                        };
                                    }
                                } catch(e) {
                                    if (e?.name === 'AbortError' || !probeIsCurrent()) return;
                                    // match 接口也获取失败
                                }
                            }

                            if (!probeIsCurrent()) return;
                            // === 判断是否成功获取链接 ===
                            // 判断请求是否成功且有数据
                            if (data && data.url) {
                                // ----------------- 成功获取链接 -----------------

                                // 1. 移除禁用状态（防止重试时状态残留）
                                it.classList.remove('disabled');

                                // 2. 智能推断真实格式
                                const urlLower = data.url.toLowerCase();
                                const br = data.br || detail?.br || 0;
                                const size = data.size || detail?.size || 0;
                                const sampleRate = data.sr || detail?.sr || 0;

                                let realExt = 'mp3'; // 默认格式
                                let isLossless = false;

                                // 判定逻辑：URL含flac / API类型为flac / 文件体积巨大
                                if (urlLower.includes('.flac')) { realExt = 'flac'; isLossless = true; }
                                else if (data.type && data.type.toLowerCase() === 'flac') { realExt = 'flac'; isLossless = true; }
                                else if (size > 20 * 1024 * 1024) { realExt = 'flac'; isLossless = true; }
                                else if (urlLower.includes('.m4a') || (data.type && data.type.toLowerCase() === 'm4a')) { realExt = 'm4a'; }
                                else if (urlLower.includes('.ogg') || (data.type && data.type.toLowerCase() === 'ogg')) { realExt = 'ogg'; }
                                else if (urlLower.includes('.wav') || (data.type && data.type.toLowerCase() === 'wav')) { realExt = 'wav'; isLossless = true; }

                                // 3. 构建用户易读的信息文本
                                let metaText = realExt.toUpperCase();

                                // 如果使用了 match 接口兜底
                                if (useMatchForVip) {
                                    metaText += matchSource ? ` (match兜底/${matchSource})` : " (match兜底)";
                                }

                                // 检测是否发生了“越级”获取（例如点标准音质，实际给了无损）
                                const isUpgrade = (level === 'standard' || level === 'higher') && isLossless;
                                if (isUpgrade) {
                                    metaText += " (自动升级)"; // 提示
                                }

                                // 拼接码率 (例如: 320kbps)
                                if (br > 0) metaText += ` ${Math.round(br/1000)}kbps`;
                                if (sampleRate > 0) metaText += ` ${formatSampleRate(sampleRate)}`;

                                // 拼接大小 (例如: 12.5MB)
                                if (size > 0) {
                                    const sizeMB = (size / 1024 / 1024).toFixed(1);
                                    metaText += ` ${sizeMB}MB`;
                                }

                                // 4. 更新界面显示
                                metaEl.textContent = metaText;
                                // 根据不同情况设置颜色：match 兜底用绿色，升级用红色
                                if (useMatchForVip) {
                                    metaEl.style.color = '#27ae60'; // 绿色表示已通过 match 兜底
                                } else if (isUpgrade) {
                                    metaEl.style.color = '#e74c3c'; // 红色表示音质升级
                                } else {
                                    metaEl.style.color = 'var(--text-sub)'; // 默认颜色
                                }

                                // 5. 生成下载按钮
                                rightArea.innerHTML = '';
                                const dlBtn = document.createElement('button');
                                dlBtn.className = 'glass-btn';
                                dlBtn.textContent = '下载';

                                // 绑定下载事件 (保持你之前的 Worker 代理逻辑)
                                dlBtn.onclick = () => {
                                    const safeName = (songName + ' - ' + artists).replace(/[\\/:*?"<>|]+/g, '_').slice(0,120);
                                    const fileName = `${safeName} [${level}].${realExt}`;

                                    // 使用配置好的 Worker 地址，如果没有则回退到相对路径
                                    const baseUrl = window.DOWNLOAD_PROXY_URL || '/proxy-download';
                                    const proxyUrl = `${baseUrl}?url=${encodeURIComponent(data.url)}&filename=${encodeURIComponent(fileName)}`;

                                    const a = document.createElement('a');
                                    a.href = proxyUrl;
                                    a.target = '_blank';
                                    a.download = fileName;
                                    document.body.appendChild(a);
                                    a.click();
                                    a.remove();
                                };
                                rightArea.appendChild(dlBtn);

                            } else {
                                // ----------------- 获取失败 (变灰处理) -----------------

                                // 1. 给整行添加 disabled 类 (CSS中需设置 opacity: 0.5; pointer-events: none;)
                                it.classList.add('disabled');

                                // 2. 更新文本提示
                                metaEl.textContent = '暂无资源 / 需VIP';
                                metaEl.style.color = 'var(--text-sub)'; // 恢复默认颜色

                                // 3. 显示不可用按钮
                                rightArea.innerHTML = '';
                                const noBtn = document.createElement('button');
                                noBtn.className = 'glass-btn';
                                noBtn.textContent = '不可用';
                                noBtn.disabled = true; // 禁用按钮交互
                                noBtn.style.background = 'rgba(0,0,0,0.05)'; // 按钮颜色稍微变淡
                                rightArea.appendChild(noBtn);
                            }
                        } catch (e) {
                            if (e?.name === 'AbortError' || !probeIsCurrent()) return;
                            it.classList.add('disabled');
                            const metaEl = it.querySelector('.quality-meta'); if (metaEl) metaEl.textContent = 'Err';
                            const rightArea = it.querySelector('.quality-action'); rightArea.innerHTML = '';
                        }
                    })(item, q.key));
                }
                const runProbes = async () => {
                    while (probeIsCurrent() && probeJobs.length) await probeJobs.shift()();
                };
                await Promise.all([runProbes(), runProbes()]);
                if (downloadProbeController === probeController) downloadProbeController = null;
            };
        }
    };
}
