import { cleanCookie, escapeHtml, toHttps } from '../shared/text.js';
import { positiveMusicInteger } from './routes.js';
import { normalizeMusicSong } from './models.js';

export function createOnlinePlaylist({
    api: apiService,
    auth: authService,
    browser: browserService,
    content: contentService,
    debug: debugService,
    dom: domService,
    imports: importsService,
    panels: panelsService,
    playback: playbackService,
    playlistView: playlistViewService,
    queue: queueService,
    prefetch: prefetchService,
    transfer: transferService
} = {}) {
    let _currentPlaylistLoadToken = 0;

    let _playlistLoadTokenSeed = 0;

    let currentPlaylistAbortController = null;

    let currentPlaylistSongs = [];

    // 当前歌单的所有歌曲
    let currentPage = 0;

    // 当前页码
    const SONGS_PER_PAGE = 50;

    // 点击歌单加载
    const loadPlaylistById = async function(id) {
        browserService.navigateMusic({ kind: 'playlist-import' });
        document.getElementById('netease-playlist-input').value = id;
        await fetchPlaylist(id);
    };

    // 当前加载的歌单数据
    let currentPlaylistData = null;

    let playlistLoadJob = null;

    // 取消歌单请求
    const cancelPlaylistRequest = function() {
        if (!cancelPlaylistLoad('cancelled')) {
            contentService.clearMusicImages(domService.playlistResults);
            domService.playlistResults.innerHTML = '<div class="netease-empty">请求已取消</div>';
        }
    };

    function finishPlaylistLoad(job, outcome) {
        if (!job || job.settled) return;
        job.settled = true;
        const data = job.data;
        if (data) {
            data.loading = false;
            data.cancelled = outcome !== 'completed';
            data.tracksLoadIncomplete = data.loadedCount < data.totalCount || data.failedBatches.length > 0;
            const ownsQueue = data.imported && data.importToken === queueService.activePlaylistQueueToken && data.queueRef === queueService.playlist;
            if (data.cancelled && ownsQueue) {
                const wasWaiting = queueService.playlistPendingAdvance || !!data.pendingAdvance;
                data.pendingAdvance = false;
                queueService.playlistPendingAdvance = false;
                if (wasWaiting && playbackService.playbackState.status === 'loading') playbackService.setPlaybackStatus('paused');
            }
        }
        if (playlistLoadJob !== job || job.token !== _currentPlaylistLoadToken) return;
        domService.playlistBtn.disabled = false;
        if (data && currentPlaylistData === data) {
            renderPlaylistLoadProgress(data, job.token);
            if (data.cancelled) {
                const message = outcome === 'auth-changed' ? '账号状态已变化，保留已加载歌曲' : '加载已结束，保留已加载歌曲';
                updatePlaylistLoadStatus(message, data.loadedCount, data.totalCount, job.token, 'done');
            }
        }
    }

    function cancelPlaylistLoad(reason = 'cancelled') {
        const job = playlistLoadJob;
        if (!job || job.settled) return false;
        job.controller.abort(transferService.createAbortError(reason));
        finishPlaylistLoad(job, reason);
        return true;
    }

    function updatePlaylistLoadStatus(message, loaded = 0, total = 0, token = _currentPlaylistLoadToken, action = 'cancel') {
        if (token !== _currentPlaylistLoadToken) return;
        let status = domService.playlistResults.querySelector('.playlist-load-status');
        if (!status) {
            status = document.createElement('div');
            status.className = 'playlist-load-status';
            status.innerHTML = '<span class="playlist-load-message"></span><button type="button" class="music-retry-btn">取消</button>';
            domService.playlistResults.prepend(status);
        }
        status.querySelector('.playlist-load-message').textContent = total > 0 ? `${message} ${loaded}/${total}` : message;
        const actionButton = status.querySelector('button');
        if (action === 'cancel') {
            actionButton.textContent = '取消';
            actionButton.disabled = false;
            actionButton.onclick = cancelPlaylistRequest;
        } else {
            actionButton.textContent = '已结束';
            actionButton.disabled = true;
            actionButton.onclick = null;
        }
    }

    function getPlaylistTrackIds(data) {
        return (Array.isArray(data?.trackIds) ? data.trackIds : [])
            .map(item => positiveMusicInteger(typeof item === 'object' ? item?.id : item, 0))
            .filter(Boolean);
    }

    function buildPlaylistSongDetailBatches(ids, cookieParam = '') {
        const batches = [];
        const maxUrlLength = 7000;
        let batch = [];
        ids.forEach(id => {
            const candidate = [...batch, id];
            const path = `/song/detail?ids=${encodeURIComponent(candidate.join(','))}${cookieParam}`;
            if (batch.length && apiService.buildApiUrl(path).length > maxUrlLength) {
                batches.push(batch);
                batch = [id];
            } else {
                batch = candidate;
            }
        });
        if (batch.length) batches.push(batch);
        return batches;
    }

    function createOnlinePlaylistEntry(song, slotIndex = -1) {
        const normalized = normalizeMusicSong(song);
        const artists = normalized.artists.map(artist => artist.name).join(', ');
        return {
            name: `${normalized.name}${artists ? ` - ${artists}` : ''}`,
            netease: true,
            songId: normalized.id,
            songData: normalized.songData,
            playlistSlot: slotIndex
        };
    }

    function getLoadedPlaylistTracks(data) {
        return Array.isArray(data?.tracks) ? data.tracks.filter(Boolean) : [];
    }

    function getContiguousPlaylistCount(data) {
        if (!Array.isArray(data?.tracks)) return 0;
        let count = 0;
        while (count < data.tracks.length && data.tracks[count]) count++;
        return count;
    }

    function getPlaylistImportWindow(data) {
        if (!Array.isArray(data?.tracks)) return { endSlot: 0, count: 0 };
        if (data.loading) {
            const count = getContiguousPlaylistCount(data);
            return { endSlot: count, count };
        }
        let count = 0;
        for (const song of data.tracks) if (song) count++;
        return { endSlot: data.tracks.length, count };
    }

    function updatePlaylistImportButton(data) {
        const button = domService.playlistPreview.querySelector('.netease-import-btn');
        if (!button) return;
        const loaded = Number(data?.loadedCount || 0);
        const total = Number(data?.totalCount || 0);
        const importWindow = getPlaylistImportWindow(data);
        button.disabled = importWindow.count <= 0;
        if (data?.imported) {
            button.textContent = data.loading
                ? `已导入 ${queueService.playlist.length}/${total} 首 · 后台加载中`
                : `已导入 ${queueService.playlist.length}/${total || loaded} 首`;
        } else if (!loaded) {
            button.textContent = '等待首批歌曲…';
        } else if (data.loading) {
            button.textContent = `播放已加载 ${importWindow.count}/${total} 首`;
        } else if (data.tracksLoadIncomplete) {
            button.textContent = `导入已加载 ${loaded}/${total} 首`;
        } else {
            button.textContent = `导入全部 ${loaded} 首`;
        }
    }

    function settlePlaylistAdvance(data) {
        if (!data?.importToken || queueService.activePlaylistQueueToken !== data.importToken || data.queueRef !== queueService.playlist) return;
        const waiting = queueService.playlistPendingAdvance || !!data.pendingAdvance;
        if (!waiting) return;

        if (queueService.curIdx + 1 < queueService.playlist.length) {
            queueService.playlistPendingAdvance = false;
            data.pendingAdvance = false;
            queueService.playTrackFromPlaylist(queueService.curIdx + 1);
            return;
        }

        if (data.loading) {
            playbackService.setPlaybackStatus('loading');
            importsService.showImportSummary('正在等待歌单继续加载下一首…', false);
            return;
        }

        queueService.playlistPendingAdvance = false;
        data.pendingAdvance = false;
        if (data.cancelled || data.tracksLoadIncomplete) {
            playbackService.setPlaybackStatus('paused');
            importsService.showImportSummary(`歌单加载已结束，当前没有可播放的下一首（已加载 ${data.loadedCount}/${data.totalCount} 首）`, false);
            debugService.log('Playlist advance stopped because the remaining tracks are unavailable', 'warn');
            return;
        }
        queueService.handleNext();
    }

    function appendLoadedTracksToImportedQueue(data) {
        if (!data?.importToken || queueService.activePlaylistQueueToken !== data.importToken || data.queueRef !== queueService.playlist) return;
        const previousLength = queueService.playlist.length;
        while (data.nextQueueSlot < data.tracks.length) {
            const song = data.tracks[data.nextQueueSlot];
            if (!song && data.loading) break;
            if (song) queueService.playlist.push(createOnlinePlaylistEntry(song, data.nextQueueSlot));
            data.nextQueueSlot++;
        }
        if (queueService.playlist.length === previousLength) {
            settlePlaylistAdvance(data);
            return;
        }

        if (domService.el.plContainer.children.length === previousLength) playlistViewService.appendPlaylistRows(previousLength);
        else playlistViewService.renderPlaylist();
        debugService.log(`歌单后台追加 ${queueService.playlist.length - previousLength} 首，当前 ${queueService.playlist.length}/${data.totalCount} 首`, 'success');
        updatePlaylistImportButton(data);
        prefetchService.prefetchUpcomingNeteaseDetails();
        settlePlaylistAdvance(data);
    }

    function renderPlaylistLoadProgress(data, token) {
        if (!data || token !== _currentPlaylistLoadToken) return;
        const loadedTracks = getLoadedPlaylistTracks(data);
        const pageCount = Math.max(1, Math.ceil(loadedTracks.length / SONGS_PER_PAGE));
        const page = Math.min(typeof contentService.renderSongList._page === 'number' ? contentService.renderSongList._page : 0, pageCount - 1);
        contentService.renderSongList(loadedTracks, domService.playlistResults, page);
        const message = data.loading
            ? (data.imported ? '后台加载歌曲...' : '可导入已加载歌曲...')
            : (data.tracksLoadIncomplete ? '歌单加载完成，但有歌曲未获取...' : '歌单歌曲加载完成');
        updatePlaylistLoadStatus(message, data.loadedCount, data.totalCount, token, data.loading ? 'cancel' : 'done');
        updatePlaylistImportButton(data);
        appendLoadedTracksToImportedQueue(data);
    }

    async function fetchPlaylist(input) {
        cancelPlaylistLoad('replaced');
        _playlistLoadTokenSeed = (_playlistLoadTokenSeed || 0) + 1;
        const myLoadToken = _playlistLoadTokenSeed;
        _currentPlaylistLoadToken = myLoadToken;

        const rawInput = String(input || '').trim();
        const match = rawInput.match(/playlist[?/].*?id[=/]?(\d+)/i) || rawInput.match(/(\d{5,})/);
        const playlistId = match ? match[1] : rawInput;
        if (!/^\d+$/.test(playlistId)) {
            contentService.clearMusicImages(domService.playlistResults);
            domService.playlistResults.innerHTML = '<div class="netease-empty">无效的歌单链接或ID</div>';
            return;
        }

        const controller = new AbortController();
        const signal = controller.signal;
        const job = { controller, token: myLoadToken, generation: authService.authGeneration, data: null, settled: false };
        playlistLoadJob = job;
        currentPlaylistAbortController = controller;
        authService.accountAbortControllers.add(controller);
        domService.playlistBtn.disabled = true;
        currentPlaylistData = null;
        domService.playlistPreview.innerHTML = '';
        contentService.clearMusicImages(domService.playlistResults);
        domService.playlistResults.innerHTML = '';
        updatePlaylistLoadStatus('正在获取歌单信息...', 0, 0, myLoadToken);

        const isCurrent = () => !signal.aborted && !job.settled && playlistLoadJob === job
            && job.generation === authService.authGeneration && myLoadToken === _currentPlaylistLoadToken;
        const cookieSnapshot = authService.neteaseCookie;
        const cookieParam = cookieSnapshot ? `&cookie=${encodeURIComponent(cleanCookie(cookieSnapshot))}` : '';

        try {
            const detailUrl = apiService.buildApiUrl(`/playlist/detail?id=${playlistId}&s=0${cookieParam}`);
            const detailJson = await transferService.fetchJsonWithStageTimeout(detailUrl, { signal }, 15_000, '获取歌单信息超时');
            if (!isCurrent()) return;
            if (detailJson.code !== 200 || !detailJson.playlist) throw new Error('歌单不存在或当前账号无权访问');

            const detail = detailJson.playlist;
            const trackIds = getPlaylistTrackIds(detail);
            const totalCount = trackIds.length || Math.max(0, Number(detail.trackCount) || 0);
            const slots = new Array(totalCount).fill(null);
            const slotIndexesById = new Map();
            trackIds.forEach((id, index) => {
                if (!slotIndexesById.has(id)) slotIndexesById.set(id, []);
                slotIndexesById.get(id).push(index);
            });
            const data = {
                ...detail,
                playlistId,
                trackIds,
                totalCount,
                tracks: slots,
                loadedCount: 0,
                loading: true,
                tracksLoadIncomplete: false,
                failedBatches: [],
                slotIndexesById,
                imported: false,
                importToken: null,
                queueRef: null,
                nextQueueSlot: 0,
                loadToken: myLoadToken
            };
            job.data = data;
            currentPlaylistData = data;
            domService.playlistPreview.innerHTML = `
                <div class="netease-playlist-info">
                    <img class="netease-playlist-cover" src="${escapeHtml(toHttps(data.coverImgUrl))}?param=200y200" loading="lazy" decoding="async" alt="歌单封面">
                    <div class="netease-playlist-meta">
                        <div class="netease-playlist-name">${escapeHtml(data.name)}</div>
                    <div class="netease-playlist-desc">${totalCount} 首歌曲 · ${data.playCount ? Math.floor(data.playCount / 10000) + '万播放' : ''}</div>
                        <button class="netease-import-btn" data-action="import-playlist" disabled>等待首批歌曲…</button>
                    </div>
                </div>`;

            if (!totalCount) {
                finishPlaylistLoad(job, 'completed');
                contentService.clearMusicImages(domService.playlistResults);
                domService.playlistResults.innerHTML = '<div class="netease-empty">这个歌单没有歌曲</div>';
                return;
            }

            const assignSongs = songs => {
                if (!trackIds.length) {
                    (Array.isArray(songs) ? songs : []).forEach(song => {
                        const emptyIndex = data.tracks.findIndex(item => !item);
                        if (emptyIndex >= 0) {
                            data.tracks[emptyIndex] = song;
                            data.loadedCount++;
                        }
                    });
                    return;
                }
                (Array.isArray(songs) ? songs : []).forEach(song => {
                    const id = positiveMusicInteger(song?.id, 0);
                    const slotsForId = data.slotIndexesById.get(id) || [];
                    for (const slotIndex of slotsForId) {
                        if (!data.tracks[slotIndex]) {
                            data.tracks[slotIndex] = song;
                            data.loadedCount++;
                        }
                    }
                });
            };

            assignSongs(Array.isArray(detail.tracks) ? detail.tracks : []);
            if (data.loadedCount) renderPlaylistLoadProgress(data, myLoadToken);
            domService.playlistBtn.disabled = false;

            const missingIds = [];
            const missingSet = new Set();
            data.tracks.forEach((song, index) => {
                if (song) return;
                const id = trackIds[index];
                if (id && !missingSet.has(id)) {
                    missingSet.add(id);
                    missingIds.push(id);
                }
            });
            const legacyBaseOffset = data.loadedCount;

            const fetchBatch = async (ids, batchIndex, legacy = false) => {
                const path = legacy
                    ? `/playlist/track/all?id=${playlistId}&limit=50&offset=${legacyBaseOffset + batchIndex * 50}${cookieParam}`
                    : `/song/detail?ids=${encodeURIComponent(ids.join(','))}${cookieParam}`;
                const url = apiService.buildApiUrl(path);
                let delay = 300;
                let lastError = null;
                for (let attempt = 0; attempt < 4; attempt++) {
                    if (!isCurrent()) throw new DOMException('aborted', 'AbortError');
                    try {
                        const json = await transferService.fetchJsonWithStageTimeout(url, { signal }, 12_000, `歌曲批次 ${batchIndex + 1} 超时`);
                        if (!Array.isArray(json.songs)) throw new Error('歌曲批次响应无效');
                        return json.songs;
                    } catch (error) {
                        if (error.name === 'AbortError' || signal.aborted) throw error;
                        lastError = error;
                        if (attempt >= 3 || (!error.retryable && !error.timeout && !/fetch|network/i.test(error.message))) break;
                        await transferService.abortableDelay(delay + Math.floor(Math.random() * 150), signal);
                        delay *= 2;
                    }
                }
                throw lastError || new Error('歌曲批次加载失败');
            };

            const batches = trackIds.length
                ? buildPlaylistSongDetailBatches(missingIds, cookieParam)
                : Array.from({ length: Math.ceil(Math.max(0, totalCount - data.loadedCount) / 50) }, (_, index) => index);
            let cursor = 0;
            const worker = async () => {
                while (isCurrent()) {
                    const batchIndex = cursor++;
                    if (batchIndex >= batches.length) return;
                    try {
                        const songs = trackIds.length
                            ? await fetchBatch(batches[batchIndex], batchIndex)
                            : await fetchBatch([], batchIndex, true);
                        if (!isCurrent()) return;
                        assignSongs(songs);
                    } catch (error) {
                        if (error.name === 'AbortError' || signal.aborted) return;
                        data.failedBatches.push(batchIndex);
                        debugService.log(`歌单批次 ${batchIndex + 1} 加载失败: ${error.message}`, 'warn');
                    }
                    renderPlaylistLoadProgress(data, myLoadToken);
                }
            };

            await Promise.all(Array.from({ length: Math.min(2, batches.length) }, () => worker()));
            if (!isCurrent()) return;
            finishPlaylistLoad(job, 'completed');
            if (data.tracksLoadIncomplete) {
                const warning = document.createElement('div');
                warning.className = 'netease-empty';
                warning.textContent = `歌单加载不完整：已加载 ${data.loadedCount}/${totalCount} 首，可先导入已加载歌曲。`;
                domService.playlistResults.prepend(warning);
            }
        } catch (error) {
            finishPlaylistLoad(job, signal.aborted ? 'cancelled' : 'failed');
            if (!isCurrent() && error.name === 'AbortError') return;
            if (playlistLoadJob === job && myLoadToken === _currentPlaylistLoadToken && job.generation === authService.authGeneration) {
                contentService.clearMusicImages(domService.playlistResults);
                domService.playlistResults.innerHTML = `<div class="netease-empty">${signal.aborted ? '请求已取消' : '获取失败: ' + escapeHtml(error.message)}</div>`;
            }
        } finally {
            finishPlaylistLoad(job, signal.aborted ? 'cancelled' : 'failed');
            authService.accountAbortControllers.delete(controller);
            if (currentPlaylistAbortController === controller) currentPlaylistAbortController = null;
            if (playlistLoadJob === job) playlistLoadJob = null;
            if (myLoadToken === _currentPlaylistLoadToken) domService.playlistBtn.disabled = false;
        }
    }

    // 导入歌单到播放队列
    const importPlaylistToQueue = async function() {
        const data = currentPlaylistData;
        if (!data || !Array.isArray(data.tracks)) return;
        if (data.imported) {
            appendLoadedTracksToImportedQueue(data);
            return;
        }

        const importWindow = getPlaylistImportWindow(data);
        if (!importWindow.count) {
            alert(data.loading ? '首批歌曲还没有加载完成，请稍候再试。' : '没有成功加载的歌曲可以导入。');
            return;
        }

        const importToken = `playlist-${data.loadToken}-${Date.now()}`;
        queueService.playlist = [];
        for (let slot = 0; slot < importWindow.endSlot; slot++) {
            if (data.tracks[slot]) queueService.playlist.push(createOnlinePlaylistEntry(data.tracks[slot], slot));
        }
        queueService.activePlaylistQueueToken = importToken;
        queueService.playlistPendingAdvance = false;
        data.imported = true;
        data.importToken = importToken;
        data.queueRef = queueService.playlist;
        data.nextQueueSlot = importWindow.endSlot;
        queueService.curIdx = -1;
        playlistViewService.renderPlaylist();
        browserService.closeMusicBrowser();
        panelsService.setFloatingPanel('playlist-sidebar', true);
        playlistViewService.observePlaylistCovers();

        updatePlaylistImportButton(data);
        debugService.log(`Imported ${queueService.playlist.length}/${data.totalCount} songs${data.loading ? '; background loading continues' : ''}`, 'success');
        importsService.showImportSummary(`已导入 ${queueService.playlist.length}/${data.totalCount} 首${data.loading ? '，剩余歌曲后台加载中' : (data.tracksLoadIncomplete ? '，未加载歌曲已跳过' : '')}`, false);
        // 自动播放第一首
        if (queueService.playlist.length > 0) {
            queueService.playTrackFromPlaylist(0);
        }
    };

    let initialized = false;
    return {
        loadPlaylistById,
        cancelPlaylistRequest,
        importPlaylistToQueue,
        get currentPlaylistSongs() { return currentPlaylistSongs; },
        set currentPlaylistSongs(value) { currentPlaylistSongs = value; },
        get currentPage() { return currentPage; },
        set currentPage(value) { currentPage = value; },
        get SONGS_PER_PAGE() { return SONGS_PER_PAGE; },
        get currentPlaylistData() { return currentPlaylistData; },
        cancelPlaylistLoad,
        settlePlaylistAdvance,
        initialize() {
            if (initialized) return;
            initialized = true;
            // 歌单按钮和回车
            domService.playlistBtn.onclick = () => fetchPlaylist(domService.playlistInput.value);

            domService.playlistInput.onkeypress = (e) => { if (e.key === 'Enter') fetchPlaylist(domService.playlistInput.value); };
        }
    };
}
