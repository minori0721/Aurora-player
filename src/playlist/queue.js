import { normalizeMusicSong } from '../netease/models.js';

export function createQueue({
    content: contentService,
    covers: coversService,
    debug: debugService,
    dom: domService,
    imports: importsService,
    localPlayback: localPlaybackService,
    onlinePlayback: onlinePlaybackService,
    onlinePlaylist: onlinePlaylistService,
    persistence: persistenceService,
    playback: playbackService,
    playlistView: playlistViewService,
    prefetch: prefetchService,
    songDetails: songDetailsService
} = {}) {
    let playlist = [], curIdx = -1, playMode = 0;

    function handleNext(e) {
        if (playlist.length === 0) {
            playbackService.setPlaybackStatus('idle');
            return;
        }

        const isAuto = !e; // 自动触发（播放结束）时为 true

        // 仅在自动触发且为单曲循环时，直接重放内存中的已解码音频（瞬时，无网络/解码开销）
        if (isAuto && playMode === 2 && playbackService.audioBuffer) {
            debugService.log('Single Loop: Auto Replay ⚡️');
            playbackService.startAudio(0);
            return;
        }

        const loadingImportedPlaylist = onlinePlaylistService.currentPlaylistData?.imported
            && onlinePlaylistService.currentPlaylistData.importToken === activePlaylistQueueToken
            && onlinePlaylistService.currentPlaylistData.queueRef === playlist
            && onlinePlaylistService.currentPlaylistData.loading
            && playMode === 0
            && curIdx >= playlist.length - 1;
        if (loadingImportedPlaylist) {
            playlistPendingAdvance = true;
            onlinePlaylistService.currentPlaylistData.pendingAdvance = true;
            playbackService.stopAudio('loading');
            importsService.showImportSummary('正在等待歌单继续加载下一首…', false);
            debugService.log('Playlist reached loaded end; waiting for the next batch', 'success');
            return;
        }
        // 确定目标下一首索引（在决定后再评估是否取消预取，以便在手动切歌时复用预加载）
        let nextIdx;
        if (playMode === 1) {
            if (playlist.length === 1) {
                if (playbackService.audioBuffer || playbackService.isStreaming) playbackService.startAudio(0);
                else playTrackFromPlaylist(0);
                return;
            }
            // 随机目标一旦被预热或完整预加载就锁定，自动切歌必须使用同一个目标。
            if (prefetchService.hasLockedNextPreloadTarget(playlist, prefetchService.nextPreloadIndex) && prefetchService.nextPreloadIndex !== curIdx) nextIdx = prefetchService.nextPreloadIndex;
            else {
                nextIdx = Math.floor(Math.random() * playlist.length);
                if (nextIdx === curIdx) nextIdx = (nextIdx + 1) % playlist.length;
            }
        } else {
            nextIdx = curIdx + 1 >= playlist.length ? 0 : curIdx + 1;
        }

        // 目标改变时无论手动还是自动都取消旧预取；目标一致时保留以复用。
        const prefetchMatchesTarget = prefetchService.hasLockedNextPreloadTarget(playlist, prefetchService.nextPreloadIndex)
            && prefetchService.nextPreloadIndex === nextIdx;
        const hasAnyPreload = prefetchService.nextPreloadKind !== 'none' && prefetchService.nextPreloadStatus !== 'idle';
        const hasOngoingPrefetch = prefetchService.prefetchInProgress || prefetchService.hasPreloaded || !!prefetchService.nextSongFetchPromise || hasAnyPreload;
        if (!prefetchMatchesTarget && hasOngoingPrefetch) {
            try { prefetchService.cancelNextPreload(); } catch(err) {}
        }

        playTrackFromPlaylist(nextIdx);
    }

    let activePlaylistQueueToken = null;

    let playlistPendingAdvance = false;

    // 从播放列表播放（支持本地和网易云）
    async function playTrackFromPlaylist(i) {
        if (i < 0 || i >= playlist.length) return;
        const track = playlist[i];
        const selectionToken = playbackService.beginPlaybackAction();
        const importedQueue = onlinePlaylistService.currentPlaylistData?.imported
            && onlinePlaylistService.currentPlaylistData.importToken === activePlaylistQueueToken
            && onlinePlaylistService.currentPlaylistData.queueRef === playlist;
        if (importedQueue) {
            playlistPendingAdvance = false;
            onlinePlaylistService.currentPlaylistData.pendingAdvance = false;
        }
        curIdx = i;
        playlistViewService.ensurePlaylistRenderedAndActive();

        let coverKnown = false;
        if (track.netease && track.songData) {
            const pendingSong = normalizeMusicSong(track.songData);
            domService.el.title.textContent = pendingSong.name;
            contentService.setMainMusicEntityLinks(pendingSong.songData);
            if (pendingSong.picUrl) {
                coverKnown = true;
                coversService.setMainCover(pendingSong.picUrl);
                domService.el.img.style.opacity = 1;
            }
            contentService.updateMusicMiniPlayer();
        }
        if (track.netease && !coverKnown) {
            domService.el.img.style.opacity = 0;
            coversService.setMainCover('', { pending: true });
        }

        if (track.netease) {
            const load = playbackService.getPlaybackLoad(selectionToken, track);
            const unlockVersion = playbackService.transportVersion;
            playbackService.stopAudio('loading');
            playbackService.audioBuffer = null;
            playbackService.resetPlaybackTimeline();
            prefetchService.prefetchUpcomingNeteaseDetails?.();
            try {
                const unlocked = await playbackService.unlockAudioContext('netease-playlist');
                if (!playbackService.isPlaybackActionCurrent(selectionToken, track)) return;
                if (!unlocked && playbackService.playbackWantsPlay && playbackService.transportVersion === unlockVersion) {
                    if (!coverKnown) coversService.setMainCover();
                    playbackService.setPlaybackStatus('error', { error: '浏览器阻止了音频播放' });
                    return;
                }
                if (!track.songData) {
                    domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">🔄 获取歌曲信息...</div>';
                    const controller = new AbortController();
                    playbackService.currentAbortController = controller;
                    let detail;
                    try {
                        detail = await songDetailsService.getSongDetail(Number(track.songId), { signal: controller.signal });
                    } finally {
                        if (playbackService.currentAbortController === controller) playbackService.currentAbortController = null;
                    }
                    if (!playbackService.isPlaybackActionCurrent(selectionToken, track)) return;
                    if (!detail) throw new Error('未找到歌曲信息');
                    track.songData = detail;
                    persistenceService.schedulePlaylistTrackSave(i);
                }
                await onlinePlaybackService.playNeteaseSong(track.songData, selectionToken);
            } catch (e) {
                if (!playbackService.isPlaybackActionCurrent(selectionToken, track)) return;
                if (e?.name === 'AbortError') return;
                if (!coverKnown) coversService.setMainCover();
                playbackService.setPlaybackStatus('error', { error: e?.message || String(e) });
                debugService.log('Error: ' + e.message, 'error');
            } finally {
                playbackService.releasePlaybackLoad(load);
            }
        } else {
            // 本地文件
            await localPlaybackService.playTrack(i, selectionToken);
            if (playbackService.isPlaybackActionCurrent(selectionToken, track)) prefetchService.prefetchUpcomingNeteaseDetails?.();
        }
    }

    let modeChangeVersion = 0;

    function updatePlayModeUI() {
        ['icon-list-loop', 'icon-random', 'icon-single'].forEach(id => document.getElementById(id).style.display = 'none');
        document.getElementById(['icon-list-loop', 'icon-random', 'icon-single'][playMode]).style.display = 'block';
        const modeNames = ['列表循环', '随机播放', '单曲循环'];
        domService.el.modeBtn.setAttribute('aria-label', `播放模式：${modeNames[playMode]}`);
        domService.el.modeBtn.title = modeNames[playMode];
    }

    async function cyclePlayMode() {
        const version = ++modeChangeVersion;
        const token = playbackService._currentPlayActionToken;
        const currentTime = playbackService.getCurrentTime();
        const previousMode = playMode;
        const hasCustomLoop = !!playbackService.getActiveCustomLoop();
        playMode = (playMode + 1) % 3;
        updatePlayModeUI();
        prefetchService.prefetchAttempted = false;
        if(playMode === 2) {
            try { prefetchService.cancelNextPreload(); } catch(_) {}
        }
        const singleLoopModeChanged = (previousMode === 2) !== (playMode === 2);
        if(playbackService.audioBuffer && playbackService.playbackState.isPlaying && !hasCustomLoop && singleLoopModeChanged) {
            playbackService.startAudio(currentTime);
        }
        if (playlist[curIdx]?.netease && playMode !== 2) prefetchService.prewarmNextNeteaseSongUrl();
        prefetchService.prefetchUpcomingNeteaseDetails?.();
        if (playMode === 2 && playbackService.isStreaming && !hasCustomLoop) {
            try {
                await playbackService.ensureCompleteAudio('单曲无缝循环');
                if (version !== modeChangeVersion || !playbackService.isPlaybackActionCurrent(token) || playMode !== 2) return;
                await playbackService.activateCompleteAudio('单曲无缝循环');
            } catch (error) {
                if (version !== modeChangeVersion || !playbackService.isPlaybackActionCurrent(token)) return;
                playMode = previousMode;
                updatePlayModeUI();
                if (!playbackService.playbackState.isPlaying) playbackService.setPlaybackStatus('error', { error: error.message });
                debugService.log(`无法启用无缝循环: ${error.message}`, 'error');
            }
        }
    }

    let initialized = false;
    return {
        get playlist() { return playlist; },
        set playlist(value) { playlist = value; },
        get curIdx() { return curIdx; },
        set curIdx(value) { curIdx = value; },
        get playMode() { return playMode; },
        handleNext,
        get activePlaylistQueueToken() { return activePlaylistQueueToken; },
        set activePlaylistQueueToken(value) { activePlaylistQueueToken = value; },
        get playlistPendingAdvance() { return playlistPendingAdvance; },
        set playlistPendingAdvance(value) { playlistPendingAdvance = value; },
        playTrackFromPlaylist,
        initialize() {
            if (initialized) return;
            initialized = true;

            document.getElementById('prev-btn').onclick = () => {
                if (playlist.length === 0) return;
                try { prefetchService.cancelNextPreload(); } catch(e) {}
                playTrackFromPlaylist(curIdx - 1 < 0 ? playlist.length - 1 : curIdx - 1);
            };

            document.getElementById('next-btn').onclick = handleNext;
            domService.el.modeBtn.onclick = cyclePlayMode;
        }
    };
}
