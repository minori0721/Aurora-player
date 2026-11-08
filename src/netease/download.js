import { cleanCookie } from '../shared/text.js';
import { formatSampleRate, inferAudioTypeFromUrl, parseFlacStreamInfoFromBuffer } from '../audio/quality.js';
import { readMp3StreamInfo } from '../audio/mp3.js';
import { getNeteaseSongArtists } from '../lyrics/matching.js';

export function createDownload({
    api: apiService,
    auth: authService,
    cache: cacheService,
    debug: debugService,
    dom: domService,
    panels: panelsService,
    playback: playbackService,
    resolver: resolverService,
    cloud: cloudService,
    transfer: transferService
} = {}) {
    let _currentPlaying = null;
    let destination = 'device';

    function openCloudTasks() {
        cancelDownloadProbes();
        domService.downloadTitle.textContent = '云盘任务';
        domService.downloadTrackInfo.textContent = '';
        domService.downloadListEl.hidden = true;
        if (domService.downloadDestination) domService.downloadDestination.hidden = true;
        panelsService.modalController.open(domService.downloadModal, closeDownloadModal);
    }

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
            domService.downloadDestination?.addEventListener('change', event => {
                if (!['device', 'cloud'].includes(event.target.value)) return;
                destination = event.target.value;
                domService.downloadListEl.querySelectorAll('[data-quality-download]').forEach(button => {
                    button.textContent = destination === 'cloud' ? '存入云盘' : '下载';
                });
            });
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
                if ((!playing || playing.playToken !== playbackService._currentPlayActionToken || !playing.netease)
                    && cloudService.getSnapshot().length) {
                    openCloudTasks();
                    return;
                }
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

                domService.downloadListEl.hidden = false;
                if (domService.downloadDestination) domService.downloadDestination.hidden = false;
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
                const matchJobs = new Map(), headerJobs = new Map(), metadataUpdates = [];
                const inspectMatch = audioUrl => {
                    if (headerJobs.has(audioUrl)) return headerJobs.get(audioUrl);
                    const job = (async () => {
                        let size = 0;
                        const readRange = start => transferService.fetchAudioHeader(audioUrl, {
                            signal: probeSignal, start,
                            onMetadata(info) { if (info.size > 0) size = info.size; }
                        });
                        const header = await readRange(0);
                        if (!header) return {};
                        const flac = parseFlacStreamInfoFromBuffer(header);
                        if (flac) return { type: 'flac', sr: flac.sampleRate, bitsPerSample: flac.bitsPerSample, size };
                        const mp3 = await readMp3StreamInfo(readRange, { header, totalBytes: size });
                        return mp3 ? { type: 'mp3', sr: mp3.sampleRate, br: mp3.bitrateKbps ? mp3.bitrateKbps * 1000 : 0,
                            mode: mp3.mode, size } : { size };
                    })();
                    headerJobs.set(audioUrl, job);
                    return job;
                };
                let qualityDetailPromise;
                const getQualityDetail = () => qualityDetailPromise ||= cacheService.cachedFetchJson(
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
                            let data = null;
                            let useMatchForVip = false;
                            let matchSource = '';
                            let matchFailure = null;

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
                                    const strategy = resolverService.getNeteaseMatchStrategy(level);
                                    const key = JSON.stringify(strategy);
                                    if (!matchJobs.has(key)) matchJobs.set(key,
                                        resolverService.fetchNeteaseMatchAudio(songId, probeOptions, 30_000, strategy, level));
                                    const matchResult = await matchJobs.get(key);
                                    if (!probeIsCurrent()) return;
                                    matchFailure = matchResult.error || null;
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
                                // 官方档位描述不一定属于 match 返回的实际文件。
                                let fallbackDetail = null;
                                let realExt = inferAudioTypeFromUrl(data.url, data.type);
                                const updateMeta = () => {
                                    const br = data.br || fallbackDetail?.br || 0;
                                    const size = data.size || fallbackDetail?.size || 0;
                                    const sampleRate = data.sr || fallbackDetail?.sr || 0;
                                    const parts = [realExt ? realExt.toUpperCase() : '格式未知'];
                                    const notes = [];
                                    if (br > 0 && (realExt !== 'flac' || !sampleRate)) parts.push(`${Math.round(br / 1000)}kbps`);
                                    else if (data.mode === 'VBR') parts.push('VBR');
                                    if (sampleRate > 0) parts.push(`${formatSampleRate(sampleRate)}${realExt === 'flac' && data.bitsPerSample ? `/${data.bitsPerSample}bit` : ''}`);
                                    if (size > 0) parts.push(`${(size / 1024 / 1024).toFixed(1)}MB`);
                                    if (useMatchForVip) notes.push(matchSource ? `(match兜底/${matchSource})` : '(match兜底)');
                                    if (['lossless', 'hires'].includes(level) && realExt === 'mp3') notes.push('· 未取得无损');
                                    else if (level === 'hires' && realExt === 'flac' && data.bitsPerSample
                                        && data.bitsPerSample <= 16 && sampleRate <= 48000) notes.push('· 实际为无损');
                                    const isUpgrade = ['standard', 'higher'].includes(level) && realExt === 'flac';
                                    if (isUpgrade) notes.push('(自动升级)');
                                    metaEl.replaceChildren();
                                    [parts.join(' '), ...notes].forEach((text, index) => {
                                        if (index) metaEl.appendChild(document.createTextNode(' '));
                                        const part = document.createElement('span');
                                        part.className = index ? 'quality-meta-note' : 'quality-meta-details';
                                        part.textContent = text;
                                        metaEl.appendChild(part);
                                    });
                                    metaEl.style.color = useMatchForVip ? '#27ae60' : isUpgrade ? '#e74c3c' : 'var(--text-sub)';
                                };
                                updateMeta();

                                // 5. 生成下载按钮
                                rightArea.innerHTML = '';
                                const dlBtn = document.createElement('button');
                                dlBtn.className = 'glass-btn';
                                dlBtn.dataset.qualityDownload = level;
                                dlBtn.textContent = destination === 'cloud' ? '存入云盘' : '下载';

                                    // 设备下载经代理设置附件文件名，云盘任务使用独立传输路径。
                                dlBtn.onclick = async () => {
                                    if (!probeIsCurrent()) return;
                                    if (destination === 'cloud') {
                                        try {
                                            await cloudService.start({ songId, songData: playing.songData || playing,
                                                level, source: useMatchForVip ? matchSource || 'auto' : '', audioInfo: { ...data } });
                                        } catch (error) {
                                            metaEl.textContent = error.message || '云盘任务启动失败';
                                        }
                                        return;
                                    }
                                    const safeName = (songName + ' - ' + artists).replace(/[\\/:*?"<>|]+/g, '_').slice(0,120);
                                    const fileName = `${safeName} [${level}]${realExt ? `.${realExt}` : ''}`;

                                    const baseUrl = window.DOWNLOAD_PROXY_URL || '/proxy-download';
                                    const proxyUrl = `${baseUrl}?url=${encodeURIComponent(data.url)}&filename=${encodeURIComponent(fileName)}`;

                                    const a = document.createElement('a');
                                    a.href = proxyUrl;
                                    a.target = '_blank';
                                    a.rel = 'noopener';
                                    a.download = fileName;
                                    document.body.appendChild(a);
                                    a.click();
                                    a.remove();
                                };
                                rightArea.appendChild(dlBtn);
                                if (useMatchForVip) metadataUpdates.push(inspectMatch(data.url).then(info => {
                                    if (!probeIsCurrent()) return;
                                    data = { ...data, ...info };
                                    realExt = info.type || realExt;
                                    updateMeta();
                                }).catch(() => {}));
                                else if (data.level === level && (!data.br || !data.sr || !data.size)) {
                                    metadataUpdates.push(getQualityDetail().then(payload => {
                                        if (!probeIsCurrent()) return;
                                        fallbackDetail = extractNeteaseQualityDetail(payload, level);
                                        updateMeta();
                                    }));
                                }

                            } else {
                                // ----------------- 获取失败 (变灰处理) -----------------

                                // 1. 给整行添加 disabled 类 (CSS中需设置 opacity: 0.5; pointer-events: none;)
                                it.classList.add('disabled');

                                // 2. 更新文本提示
                                metaEl.textContent = matchFailure?.failures?.some(failure => !['empty', 'trial'].includes(failure.kind))
                                    ? '音源暂不可用，请稍后重试' : '暂无完整音频资源';
                                metaEl.title = matchFailure?.message || '';
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
                await Promise.all(metadataUpdates);
                if (downloadProbeController === probeController) downloadProbeController = null;
            };
        }
    };
}
