import { cleanCookie, escapeHtml, fmtTime, toHttps } from '../shared/text.js';
import { createAudioQualityProbe, describeAudioQualityFromBuffer, describeAudioQualityFromInfo, inferAudioTypeFromUrl, parseFlacStreamInfoFromBuffer } from './quality.js';
import { getNeteaseSongArtists } from '../lyrics/matching.js';

export function createOnlinePlayback({
    analysis: analysisService,
    auth: authService,
    content: contentService,
    covers: coversService,
    debug: debugService,
    dom: domService,
    download: downloadService,
    loop: loopService,
    lyrics: lyricsService,
    metadata: metadataService,
    playback: playbackService,
    playlistView: playlistViewService,
    prefetch: prefetchService,
    queue: queueService,
    songDetails: songDetailsService,
    resolver: resolverService,
    transfer: transferService
} = {}) {
    async function supplementPlayingSongDetail(songId, token, onDetail) {
        const controller = new AbortController();
        let coverRequested = false;
        playbackService.playbackMetadataController?.abort();
        playbackService.playbackMetadataController = controller;
        try {
            const detail = await songDetailsService.getSongDetail(songId, { signal: controller.signal, priority: 'normal' });
            if (controller.signal.aborted || !playbackService.isPlaybackActionCurrent(token)) return;
            if (!detail) return;
            onDetail(detail);
            prefetchService.applyNeteaseSongDetailToPlaylist(detail);
            domService.el.title.textContent = detail.name || domService.el.title.textContent;
            contentService.setMainMusicEntityLinks(detail);
            if (downloadService._currentPlaying?.songId === songId) downloadService._currentPlaying.songData = detail;
            const cover = toHttps(detail.album?.picUrl || detail.al?.picUrl || '');
            if (cover) {
                coverRequested = true;
                coversService.setMainCover(cover, { onLoad: () => {
                    if (!playbackService.isPlaybackActionCurrent(token)) return;
                    domService.el.img.style.opacity = 1;
                } });
            }
            metadataService.updateMediaSession();
            contentService.updateMusicMiniPlayer();
        } catch (error) {
            if (error?.name !== 'AbortError' && playbackService.isPlaybackActionCurrent(token)) debugService.log(`歌曲详情补全失败: ${error?.message || error}`, 'warn');
        } finally {
            if (!coverRequested && !controller.signal.aborted && playbackService.isPlaybackActionCurrent(token)
                && playbackService.playbackMetadataController === controller) coversService.setMainCover();
            if (playbackService.playbackMetadataController === controller) playbackService.playbackMetadataController = null;
        }
    }

    // 播放网易云歌曲
    async function playNeteaseSong(song, existingPlayToken = null) {
        // play token 防止旧的播放请求完成后覆盖新的播放
        if (existingPlayToken !== null && !playbackService.isPlaybackActionCurrent(existingPlayToken)) return;
        const myPlayToken = existingPlayToken === null ? playbackService.beginPlaybackAction() : existingPlayToken;
        const load = playbackService.getPlaybackLoad(myPlayToken);
        const unlockVersion = playbackService.transportVersion;
        playbackService.stopAudio(playbackService.playbackWantsPlay ? 'loading' : 'paused', { preserveLoad: true });
        analysisService.resetLoopAnalysisWorkerAudio();
        playbackService.audioBuffer = null;
        playbackService.resetPlaybackTimeline();
        loopService.resetLoopUI();
        lyricsService.resetTrackLyrics();
        const audioUnlockPromise = playbackService.unlockAudioContext('netease-song');
        prefetchService.prefetchAttempted = false; // 确保新歌开始时，允许触发预加载

        playbackService.setCurrentDownloadTrack(song, myPlayToken, true);

        const songId = song.id;
        const preferStream = playbackService.playbackPreference === 'stream' && queueService.playMode !== 2;
        let songName = song.name;
        let artists = getNeteaseSongArtists(song).join(', ');
        let cover = toHttps(song.album?.picUrl || song.al?.picUrl || '');

        // A prefetch for a different song must not keep competing with the
        // interactive playback request. The matching target is deliberately
        // preserved so this play action can take it over without a second GET.
        const preloadTrack = queueService.playlist[prefetchService.nextPreloadIndex];
        const preloadMatchesCurrent = prefetchService.isNextPreloadCompatible(queueService.playlist, prefetchService.nextPreloadIndex, preloadTrack)
            && prefetchService.nextPreloadSongId === Number(songId);
        if (!preloadMatchesCurrent && prefetchService.nextPreloadKind !== 'none') {
            try { prefetchService.cancelNextPreload({ resetAttempted: false, silent: true, resetDetails: false }); } catch (_) {}
        }

        debugService.log(`正在播放：${songName} - ${artists}`);

        if (cover) {
            coversService.setMainCover(cover, { onLoad: () => {
                if (!playbackService.isPlaybackActionCurrent(myPlayToken)) return;
                domService.el.img.style.opacity = 1;
            } });
        } else {
            domService.el.img.style.opacity = 0;
            coversService.setMainCover('', { pending: true });
        }

        const audioUnlocked = await audioUnlockPromise;
        if (!playbackService.isPlaybackActionCurrent(myPlayToken)) return;
        if (!audioUnlocked && playbackService.playbackWantsPlay && playbackService.transportVersion === unlockVersion) {
            if (!cover) coversService.setMainCover();
            playbackService.setPlaybackStatus('error', { error: '浏览器阻止了音频播放' });
            playbackService.releasePlaybackLoad(load);
            return;
        }

        // 更新UI
        domService.el.title.textContent = songName;
        contentService.setMainMusicEntityLinks(song);
        domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">🔄 获取音频...</div>';
        const controller = new AbortController();
        playbackService.currentAbortController = controller;
        const signal = controller.signal;
        const prefetchedLyric = lyricsService.takePrefetchedLyric(songId, { signal });
        if (!cover) supplementPlayingSongDetail(songId, myPlayToken, detail => { song = detail; });
        const recoveryBudget = preloadMatchesCurrent && prefetchService.nextPreloadRecoveryBudget
            ? prefetchService.nextPreloadRecoveryBudget : { urlRefreshUsed: false, stallRecoveryUsed: false };

        async function useStream(initialResolved, rawData = null, media = null) {
            const cookie = authService.neteaseCookie, generation = authService.authGeneration, level = authService.neteaseQuality;
            let resolved = initialResolved, blob = rawData ? new Blob([rawData]) : null;
            rawData = null;
            let objectUrl = blob ? URL.createObjectURL(blob) : '';
            let completeWork = null;
            const guard = () => {
                playbackService.assertPlaybackActionCurrent(myPlayToken);
                if (signal.aborted) throw signal.reason || new DOMException('aborted', 'AbortError');
                if (generation !== authService.authGeneration || cookie !== authService.neteaseCookie) throw new Error('账号状态已改变，请重新播放');
            };
            const releaseEncoded = () => {
                blob = null;
                if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = ''; }
            };
            const loadComplete = () => {
                if (completeWork) return completeWork;
                completeWork = (async () => {
                    guard();
                    let ab, loadedUrl = resolved.candidates[0];
                    if (blob) ab = await blob.arrayBuffer();
                    else {
                        const compact = typeof matchMedia === 'function' && matchMedia('(max-width: 700px)').matches;
                        const maxBytes = (compact || Number(navigator.deviceMemory) > 0 && Number(navigator.deviceMemory) <= 4 ? 64 : 128) * 1024 * 1024;
                        while (true) {
                            try {
                                if (Number(resolved.audioInfo?.size) > maxBytes) throw new Error('完整音频超过安全加载上限，请继续流式播放');
                                const result = await transferService.fetchAudioDataWithFallback(resolved.candidates, { signal, maxBytes });
                                if (result.tooLarge) throw new Error('完整音频超过安全加载上限，请继续流式播放');
                                ab = result.buffer; loadedUrl = result.audioUrl;
                                break;
                            } catch (error) {
                                guard();
                                if (!recoveryBudget.urlRefreshUsed && [401, 403, 404, 410].includes(Number(error.status))) {
                                    recoveryBudget.urlRefreshUsed = true;
                                    await resolverService.invalidateNeteaseResolvedAudioCache(songId, level, cookie);
                                    guard();
                                    const cookieParam = cookie ? `&cookie=${encodeURIComponent(cleanCookie(cookie))}` : '';
                                    resolved = await resolverService.resolveNeteaseAudioUrlWithTimeout(songId, cookieParam, level,
                                        { signal, useQueue: true, cacheScope: 'none' }, 0, resolverService.getNeteaseMatchStrategy(level));
                                    guard();
                                    if (!resolved.candidates?.length) throw new Error('NO_URL_FROM_OFFICIAL');
                                    continue;
                                }
                                if (!recoveryBudget.stallRecoveryUsed && error.code === 'AUDIO_STALLED') {
                                    recoveryBudget.stallRecoveryUsed = true;
                                    continue;
                                }
                                throw error;
                            }
                        }
                    }
                    guard();
                    const info = resolved.audioInfo || {};
                    const probe = createAudioQualityProbe(ab, loadedUrl, info);
                    const buffer = await playbackService.decodeCompleteData(ab, playbackService.playbackState.duration || Number(song.dt || song.duration || 0) / 1000,
                        probe.flacInfo?.channels || probe.wavInfo?.channels || 2);
                    guard();
                    return { buffer, quality: describeAudioQualityFromBuffer(ab, loadedUrl, buffer, { ...info, _qualityProbe: probe }) };
                })();
                return completeWork;
            };
            const supplementStreamQuality = async () => {
                if (inferAudioTypeFromUrl(resolved.candidates[0], resolved.audioInfo?.type) !== 'flac' || playbackService.audioBuffer) return;
                const header = blob ? await blob.slice(0, 4096).arrayBuffer()
                    : await transferService.fetchAudioHeader(resolved.candidates[0], { signal });
                guard();
                if (!header || playbackService.audioBuffer || !playbackService.isStreaming) return;
                const streamInfo = parseFlacStreamInfoFromBuffer(header);
                if (!streamInfo) return;
                metadataService.currentAudioQuality = describeAudioQualityFromInfo(resolved.audioInfo, resolved.candidates[0], streamInfo).label;
                lyricsService.setArtistTag('网易云', metadataService.currentAudioQuality);
            };
            await playbackService.prepareStream(load, {
                url: objectUrl || resolved.candidates[0], media, loadComplete, releaseEncoded,
                dispose() { controller.abort(); releaseEncoded(); },
                onComplete(result) {
                    guard();
                    metadataService.currentAudioQuality = result.quality.label;
                    lyricsService.setArtistTag('网易云', metadataService.currentAudioQuality);
                }
            });
            guard();
            if (!playbackService.audioBuffer) {
                metadataService.currentAudioQuality = describeAudioQualityFromInfo(resolved.audioInfo, resolved.candidates[0]).label;
                lyricsService.setArtistTag('网易云', metadataService.currentAudioQuality);
            }
            playbackService.finishPlaybackLoad(load);
            metadataService.updateMediaSession();
            lyricsService.fetchLyricById(songId, { signal, prefetched: prefetchedLyric, isCurrent: () => playbackService.isPlaybackActionCurrent(myPlayToken) });
            prefetchService.prewarmNextNeteaseSongUrl();
            prefetchService.prefetchUpcomingNeteaseDetails();
            supplementStreamQuality().catch(() => {});
        }
        try {

            // 如果预取目标仍是当前歌曲，则复用完整音频或已预热的 URL。
            // 正式播放会接管同一个下载 Promise，不因短暂等待而取消它。
            let prewarmedResolved = null;
            let prewarmedMedia = null;
            try {
                const preloadIndex = prefetchService.nextPreloadIndex;
                const preloadTrack = queueService.playlist[preloadIndex];
                const nextPrefetchMatches = prefetchService.isNextPreloadCompatible(queueService.playlist, preloadIndex, preloadTrack)
                    && prefetchService.nextPreloadSongId === Number(songId);
                if (nextPrefetchMatches) {
                    const preloadToken = prefetchService.nextPreloadToken;
                    let res = null;
                    if (prefetchService.hasPreloaded && prefetchService.nextSongRawData) {
                        res = { ab: prefetchService.nextSongRawData, ...(prefetchService.nextSongPreloadMeta || {}) };
                    } else if (prefetchService.prefetchInProgress && prefetchService.nextSongFetchPromise) {
                        const preloadPromise = prefetchService.nextSongFetchPromise;
                        try {
                            res = await transferService.awaitWithSignal(preloadPromise, signal);
                        } catch (error) {
                            if (!playbackService.isPlaybackActionCurrent(myPlayToken) || signal.aborted) return;
                            if (error?.name === 'AbortError' || error?.stale) throw error;
                            debugService.log(`预取任务未完成，将由正式播放重试: ${error?.message || error}`, 'warn');
                        }
                        if (!playbackService.isPlaybackActionCurrent(myPlayToken)) return;
                    }

                    if (!res?.ab && prefetchService.nextPreloadKind === 'netease-url') {
                        const warmed = preferStream ? prefetchService.takeNextStreamWarm?.(songId) : null;
                        prewarmedMedia = warmed?.media || null;
                        prewarmedResolved = warmed?.resolved || prefetchService.takeNextPrewarmedNeteaseUrl(songId, authService.neteaseQuality);
                    }

                    if (res?.ab && prefetchService.isNextPreloadSnapshotCurrent(preloadToken, queueService.playlist, preloadIndex, preloadTrack, songId, authService.neteaseQuality, authService.authGeneration)) {
                        // Promise 恰好在提交回调前完成时，先把结果补进统一状态，再由同一入口消费。
                        if (!prefetchService.hasPreloaded) {
                            prefetchService.nextSongRawData = res.ab;
                            prefetchService.nextSongPreloadMeta = { ...res };
                            prefetchService.hasPreloaded = true;
                            prefetchService.nextPreloadStatus = 'ready';
                        }
                        const consumed = prefetchService.takeNextPreloadedRawData(preloadIndex, preloadTrack, songId, authService.neteaseQuality);
                        if (!consumed?.ab) {
                            try { prefetchService.cancelNextPreload(); } catch(e) {}
                        } else {
                        if (preferStream) {
                            await useStream({ ...consumed, candidates: consumed.candidates?.length ? consumed.candidates : [consumed.audioUrl] }, consumed.ab);
                            return;
                        }
                        domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">⏳ 使用预加载音频...</div>';
                        domService.el.bufferLine.style.width = '30%';

                        const ab = consumed.ab;

                        domService.el.bufferLine.style.width = '60%';
                        const preloadedProbe = createAudioQualityProbe(ab, consumed.audioUrl || '', consumed.audioInfo || {});
                        const decodedBuffer = await playbackService.decodePlaybackLoad(load, ab);
                        playbackService.assertPlaybackActionCurrent(myPlayToken);
                        playbackService.audioBuffer = decodedBuffer;
                        const preloadedQuality = describeAudioQualityFromBuffer(ab, consumed.audioUrl || '', decodedBuffer, { ...(consumed.audioInfo || {}), _qualityProbe: preloadedProbe });
                        metadataService.currentAudioQuality = preloadedQuality.label;
                        lyricsService.setArtistTag('网易云', metadataService.currentAudioQuality);
                        debugService.log(`音质：${metadataService.currentAudioQuality}`, 'success');
                        domService.el.bufferLine.style.width = '100%';
                        playbackService.playbackState.duration = playbackService.audioBuffer.duration;
                        domService.el.totalTime.textContent = fmtTime(playbackService.playbackState.duration);


                        if (queueService.playlist[queueService.curIdx]) {
                            const track = queueService.playlist[queueService.curIdx];
                            if (!songDetailsService.isReady(track.songData)) track.songData = song;
                            playlistViewService.refreshPlaylistItem(queueService.curIdx);
                        }
                        playlistViewService.ensurePlaylistRenderedAndActive();

                        playbackService.finishPlaybackLoad(load);
                        metadataService.updateMediaSession();

                        try { lyricsService.fetchLyricById(songId, { signal, prefetched: prefetchedLyric, isCurrent: () => playbackService.isPlaybackActionCurrent(myPlayToken) }); } catch(_) {}

                        // 批量预取后续详情，但仍只预热下一首音频 URL。
                        try {
                            prefetchService.prewarmNextNeteaseSongUrl();
                            prefetchService.prefetchUpcomingNeteaseDetails();
                        } catch (_) {}

                        return;
                        }
                    } else if (!prewarmedResolved) {
                        // 预取失败或只有过期状态时才清理；正常下载不会在等待阈值
                        // 到达时被取消，因此正式播放不会重新发起重复 GET。
                        try { prefetchService.cancelNextPreload(); } catch(e) {}
                    }
                }
            } catch (e) {
                if (!playbackService.isPlaybackActionCurrent(myPlayToken) || signal.aborted) return;
                if (e.stale || e.message === 'stale') return;
                if (e.code === 'AUDIO_STALLED') recoveryBudget.stallRecoveryUsed = true;
                debugService.log('预取数据复用失败，回退正常加载：' + (e && e.message), 'warn');
                try { prefetchService.cancelNextPreload(); } catch(e) {}
            }

            // 获取音频URL - 使用新版API指定音质，优先从缓存获取（短时缓存）
            const cookieParam = authService.neteaseCookie ? `&cookie=${encodeURIComponent(cleanCookie(authService.neteaseCookie))}` : '';
            if (playbackService._currentPlayActionToken !== myPlayToken) throw new Error('stale');

            let resolved = prewarmedResolved || await resolverService.resolveNeteaseAudioUrlWithTimeout(
                songId,
                cookieParam,
                authService.neteaseQuality,
                { signal, useQueue: true },
                30_000,
                resolverService.getNeteaseMatchStrategy(authService.neteaseQuality)
            );
            if (playbackService._currentPlayActionToken !== myPlayToken) { controller.abort(); throw new Error('stale'); }

            if (resolved.trialOnly || resolved.needsUnblock) {
                debugService.log(resolved.trialOnly ? '官方接口只返回试听片段，尝试使用match接口获取完整音频...' : '官方接口无可播放链接，尝试使用match接口兜底...', 'info');
            }
            if (resolved.skippedTrial) {
                debugService.log('Match返回了疑似试听片段，已跳过并尝试其他音源', 'warn');
            }
            if (resolved.usedMatch) {
                debugService.log(`成功通过match接口获取完整音频链接${resolved.matchSource ? ` (${resolved.matchSource})` : ''}`, 'success');
            }

            let audioInfo = resolved.audioInfo || null;
            let audioCandidates = resolved.candidates || [];
            if (!audioInfo || !audioCandidates.length) {
                throw new Error('NO_URL_FROM_OFFICIAL');
            }
            if (preferStream) {
                await useStream(resolved, null, prewarmedMedia);
                return;
            }
            let audioUrl = audioCandidates[0];
            debugService.log(`音频链接：${audioCandidates[0]}`);

            domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">⏳ 加载音频...</div>';
            domService.el.bufferLine.style.width = '30%';
            // 获取音频数据
            // 二次检查：确保仍是当前播放请求
            if (playbackService._currentPlayActionToken !== myPlayToken) { controller.abort(); throw new Error('stale'); }
            let audioFetchResult;
            while (true) {
                try {
                    audioFetchResult = await transferService.fetchAudioDataWithFallback(audioCandidates, { signal });
                    break;
                } catch (audioError) {
                    playbackService.assertPlaybackActionCurrent(myPlayToken);
                    if (signal.aborted) throw signal.reason || audioError;
                    const shouldRefreshUrl = !recoveryBudget.urlRefreshUsed && [401, 403, 404, 410].includes(Number(audioError?.status));
                    if (shouldRefreshUrl) {
                        recoveryBudget.urlRefreshUsed = true;
                        debugService.log(`音频链接已失效 (HTTP ${audioError.status})，正在重新解析一次...`, 'warn');
                        await resolverService.invalidateNeteaseResolvedAudioCache(songId, authService.neteaseQuality, authService.neteaseCookie);
                        playbackService.assertPlaybackActionCurrent(myPlayToken);
                        resolved = await resolverService.resolveNeteaseAudioUrlWithTimeout(
                            songId, cookieParam, authService.neteaseQuality,
                            { signal, useQueue: true, cacheScope: 'none' }, 0, resolverService.getNeteaseMatchStrategy(authService.neteaseQuality)
                        );
                        playbackService.assertPlaybackActionCurrent(myPlayToken);
                        audioInfo = resolved.audioInfo || null;
                        audioCandidates = resolved.candidates || [];
                        if (!audioInfo || !audioCandidates.length) throw new Error('NO_URL_FROM_OFFICIAL');
                        continue;
                    }
                    if (audioError.code === 'AUDIO_STALLED' && !recoveryBudget.stallRecoveryUsed) {
                        recoveryBudget.stallRecoveryUsed = true;
                        debugService.log('音频传输停滞，使用现有链接恢复一次...', 'warn');
                        continue;
                    }
                    throw audioError;
                }
            }
            const { buffer: ab, audioUrl: loadedAudioUrl } = audioFetchResult;
            if (playbackService._currentPlayActionToken !== myPlayToken) { controller.abort(); throw new Error('stale'); }
            audioUrl = loadedAudioUrl;

            domService.el.bufferLine.style.width = '60%';
            if (playbackService._currentPlayActionToken !== myPlayToken) { controller.abort(); throw new Error('stale'); }

            domService.el.bufferLine.style.width = '80%';
            const actualProbe = createAudioQualityProbe(ab, audioUrl, audioInfo || {});
            const decodedBuffer = await playbackService.decodePlaybackLoad(load, ab);
            if (playbackService._currentPlayActionToken !== myPlayToken) { controller.abort(); throw new Error('stale'); }
            playbackService.audioBuffer = decodedBuffer;
            const actualQuality = describeAudioQualityFromBuffer(ab, audioUrl, decodedBuffer, { ...(audioInfo || {}), _qualityProbe: actualProbe });
            metadataService.currentAudioQuality = actualQuality.label;
            lyricsService.setArtistTag('网易云', metadataService.currentAudioQuality);
            debugService.log(`音质：${metadataService.currentAudioQuality}`, 'success');
            domService.el.bufferLine.style.width = '100%';
            playbackService.playbackState.duration = playbackService.audioBuffer.duration;
            domService.el.totalTime.textContent = fmtTime(playbackService.playbackState.duration);

            // 更新当前播放项的 songData（不覆盖整个播放列表）
            if (queueService.playlist[queueService.curIdx]) {
                const track = queueService.playlist[queueService.curIdx];
                if (!songDetailsService.isReady(track.songData)) track.songData = song;
            }
            playlistViewService.refreshPlaylistItem(queueService.curIdx);
            playlistViewService.ensurePlaylistRenderedAndActive();

            playbackService.finishPlaybackLoad(load);
            metadataService.updateMediaSession();

            // 直接用歌曲ID获取歌词（已知ID无需搜索）
            try { lyricsService.fetchLyricById(songId, { signal, prefetched: prefetchedLyric, isCurrent: () => playbackService.isPlaybackActionCurrent(myPlayToken) }); } catch(_) {}

                // 批量预取后续详情，但仍只预热下一首音频 URL。
                try {
                    prefetchService.prewarmNextNeteaseSongUrl();
                    prefetchService.prefetchUpcomingNeteaseDetails();
                } catch (_) {}

        } catch (e) {
            if (!playbackService.isPlaybackActionCurrent(myPlayToken)) return;
            if (e.message === 'stale' || (e.name === 'AbortError' && !e.timeout)) {
                // 过期或被取消，不记录为错误
                debugService.log('播放请求已取消或失效');
                return;
            }
            debugService.log('播放失败：' + e.message, 'error');
            domService.el.lyricBox.innerHTML = `<div class="lyric-line active" style="margin-top:100px">❌ ${escapeHtml(e?.message || String(e))}</div>`;
            playbackService.setPlaybackStatus('error', { error: e?.message || String(e) });
        } finally {
            if (playbackService.currentAbortController === controller) playbackService.currentAbortController = null;
            playbackService.releasePlaybackLoad(load);
        }
    }

    let initialized = false;
    return {
        playNeteaseSong,
        initialize() {
            if (initialized) return;
            initialized = true;

        }
    };
}
