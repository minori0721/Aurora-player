import { escapeHtml, fmtTime } from '../shared/text.js';
import { createAudioQualityProbe, describeAudioQualityFromBuffer, parseFlacTagsFromArrayBuffer } from './quality.js';
import { extractLyricsText } from '../lyrics/parser.js';

export function createLocalPlayback({
    analysis: analysisService,
    content: contentService,
    covers: coversService,
    debug: debugService,
    dom: domService,
    imports: importsService,
    loop: loopService,
    lyrics: lyricsService,
    metadata: metadataService,
    persistence: persistenceService,
    playback: playbackService,
    playlistView: playlistViewService,
    prefetch: prefetchService,
    queue: queueService
} = {}) {
    async function playTrack(i, existingPlayToken = null) {
        if(i < 0 || i >= queueService.playlist.length) return;
        const track = queueService.playlist[i];
        const queueRef = queueService.playlist;
        if (existingPlayToken !== null && !playbackService.isPlaybackActionCurrent(existingPlayToken, track)) return;
        const myPlayToken = existingPlayToken === null ? playbackService.beginPlaybackAction() : existingPlayToken;
        queueService.curIdx = i;
        const load = playbackService.getPlaybackLoad(myPlayToken, track);
        const unlockVersion = playbackService.transportVersion;
        const loopEditVersion = loopService.getLoopEditVersion(track);
        const isCurrent = () => queueRef === queueService.playlist && playbackService.isPlaybackActionCurrent(myPlayToken, track);
        playbackService.stopAudio('loading');
        analysisService.resetLoopAnalysisWorkerAudio();
        playbackService.audioBuffer = null;
        playbackService.resetPlaybackTimeline();
        loopService.resetLoopUI();
        lyricsService.resetTrackLyrics();
        domService.el.img.style.opacity = 0;
        coversService.setMainCover('', { pending: true });
        const lyricSession = lyricsService.createLocalLyricSession(track, isCurrent);
        playbackService.setCurrentDownloadTrack(track, myPlayToken, false);
        domService.el.title.textContent = track.name;
        playlistViewService.ensurePlaylistRenderedAndActive();
        domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">Parsing...</div>';
        const audioUnlockPromise = playbackService.unlockAudioContext('local-track');
        if (!track.file && track.fileHandle && typeof track.fileHandle.getFile === 'function') {
            try {
                const handle = track.fileHandle;
                let permission = 'prompt';
                // Request in the click's call stack, before any permission query or audio-unlock wait.
                if (typeof handle.requestPermission === 'function' && navigator.userActivation?.isActive) {
                    permission = await handle.requestPermission({ mode: 'read' });
                } else if (typeof handle.queryPermission === 'function') {
                    permission = await handle.queryPermission({ mode: 'read' });
                }
                if (!isCurrent()) return;
                let file = null;
                if (permission === 'granted' || typeof handle.requestPermission !== 'function') {
                    file = await handle.getFile();
                }
                if (!isCurrent()) return;
                track.file = file;
                if (track.file) {
                    track.needsFile = false;
                    playlistViewService.refreshPlaylistItem(i);
                    if (typeof persistenceService.schedulePlaylistStateSave === 'function') persistenceService.schedulePlaylistStateSave();
                }
            } catch (error) {
                if (!isCurrent()) return;
                debugService.log(`本地文件权限获取失败: ${error?.message || error}`, 'warn');
            }
        }
        if (!isCurrent()) return;
        if (!track.file) {
            coversService.setMainCover();
            const label = track.asset?.relativePath || track.name || '本地文件';
            const message = track.fileHandle
                ? `本地文件需要授权，请点击播放并允许访问：${label}`
                : `本地文件未恢复，请重新导入：${label}`;
            playbackService.setPlaybackStatus('error', { error: message });
            domService.el.lyricBox.innerHTML = `<div class="lyric-line active" style="margin-top:100px">${escapeHtml(message)}</div>`;
            importsService.showImportSummary(message, true);
            playbackService.releasePlaybackLoad(load);
            return;
        }
        const unlocked = await audioUnlockPromise;
        if (!isCurrent()) return;
        if (!unlocked && playbackService.playbackWantsPlay && playbackService.transportVersion === unlockVersion) {
            coversService.setMainCover();
            playbackService.setPlaybackStatus('error', { error: '浏览器阻止了音频播放' });
            playbackService.releasePlaybackLoad(load);
            return;
        }
        prefetchService.prefetchAttempted = false; // 新增：无论怎么切歌，先重置预加载状态
        queueService.curIdx = i; playlistViewService.ensurePlaylistRenderedAndActive();
        playbackService.setCurrentDownloadTrack(track, myPlayToken, false);
        metadataService.currentAudioQuality = ''; // 先清除，后面会根据文件信息设置
        metadataService.pendingQualityInfo = null;

        contentService.setMainMusicEntityLinks(null);
        domService.el.title.textContent = track.name; domService.el.artist.textContent = "Loading...";
        domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">Parsing...</div>';
        debugService.log(`Track: ${track.name}`);

        try {
            let ab = null;
            // 只复用当前队列中身份一致的预加载目标，等待不超过 1 秒，超时立即回退到本地读取。
            const localPreloadMatches = prefetchService.hasLockedNextPreloadTarget(queueService.playlist, i, track) && prefetchService.nextPreloadKind === 'local';
            if (localPreloadMatches) {
                try {
                    if (prefetchService.hasPreloaded && prefetchService.nextSongRawData) {
                        // 直接使用
                    } else if (prefetchService.prefetchInProgress) {
                        const preloadToken = prefetchService.nextPreloadToken;
                        const ok = await prefetchService.waitForPrefetchCompletion(prefetchService.LOCAL_PREFETCH_TRIGGER_SEC * 100, preloadToken);
                        playbackService.assertPlaybackActionCurrent(myPlayToken, track);
                        if (!ok || !prefetchService.hasPreloaded || !prefetchService.nextSongRawData) {
                            try { prefetchService.cancelNextPreload(); } catch(e) {}
                        }
                    }

                    const preloaded = prefetchService.takeNextPreloadedRawData(i, track);
                    if (preloaded?.ab) {
                        ab = preloaded.ab;
                        debugService.log('Using preloaded raw data for local track', 'success');
                    } else {
                        ab = await track.file.arrayBuffer();
                        playbackService.assertPlaybackActionCurrent(myPlayToken, track);
                    }
                } catch (e) {
                    if (!isCurrent()) return;
                    if (e.stale || e.message === 'stale') throw e;
                    debugService.log('Error while attempting to use preloaded local data, fallback: ' + (e && e.message), 'warn');
                    try { prefetchService.cancelNextPreload(); } catch(_) {}
                    ab = await track.file.arrayBuffer();
                    playbackService.assertPlaybackActionCurrent(myPlayToken, track);
                }
            } else {
                ab = await track.file.arrayBuffer();
                playbackService.assertPlaybackActionCurrent(myPlayToken, track);
            }
            playbackService.assertPlaybackActionCurrent(myPlayToken, track);
            domService.el.bufferLine.style.width = '30%';
            let meta = null;
            if(track.file.name.toLowerCase().endsWith('.flac')) {
                debugService.log("Detect FLAC. Using Native Parser...");
                meta = parseFlacTagsFromArrayBuffer(ab, undefined, debugService.log);
                playbackService.assertPlaybackActionCurrent(myPlayToken, track);
                // 计算FLAC比特率（文件大小 / 时长）
                if (meta) {
                    meta.fileSize = track.file.size;
                } else coversService.setMainCover();
            } else {
                // 对于MP3等文件，计算比特率
                const fileSize = track.file.size;
                const ext = track.file.name.split('.').pop().toUpperCase();
                metadataService.pendingQualityInfo = { size: fileSize, ext: ext, fileName: track.file.name };

                jsmediatags.read(track.file, {
                    onSuccess: (tag) => {
                        if (!playbackService.isPlaybackActionCurrent(myPlayToken, track)) return;
                        const c = {
                            title: tag.tags.title,
                            artist: tag.tags.artist,
                            album: tag.tags.album,
                            lyrics: extractLyricsText(tag.tags.lyrics) || extractLyricsText(tag.tags.USLT?.data),
                            picture: tag.tags.picture,
                            fileSize: fileSize,
                            fileExt: ext
                        };
                        metadataService.applyMetadata(c, "ID3", isCurrent, lyricSession);
                    },
                    onError: () => {
                        if (!playbackService.isPlaybackActionCurrent(myPlayToken, track)) return;
                        coversService.setMainCover();
                        lyricsService.applyLocalLyricMetadata(lyricSession, {}, 'ID3');
                    }
                });
            }
            if(meta) metadataService.applyMetadata(meta, "Native", isCurrent, lyricSession);

            domService.el.bufferLine.style.width = '60%';
            const localQualityProbe = createAudioQualityProbe(ab, track.file.name, { type: track.file.name.split('.').pop().toLowerCase(), size: track.file.size });
            const decodedBuffer = await playbackService.decodePlaybackLoad(load, ab);
            playbackService.assertPlaybackActionCurrent(myPlayToken, track);
            playbackService.audioBuffer = decodedBuffer;
            domService.el.bufferLine.style.width = '100%';
            playbackService.playbackState.duration = playbackService.audioBuffer.duration;
            domService.el.totalTime.textContent = fmtTime(playbackService.playbackState.duration);

            // 根据不同格式计算并显示音质信息
            if (metadataService.pendingQualityInfo && playbackService.playbackState.duration > 0) {
                const ext = metadataService.pendingQualityInfo.ext;
                const localQuality = describeAudioQualityFromBuffer(
                    ab,
                    metadataService.pendingQualityInfo.fileName || '',
                    playbackService.audioBuffer,
                    { type: ext.toLowerCase(), size: metadataService.pendingQualityInfo.size, _qualityProbe: localQualityProbe }
                );
                metadataService.currentAudioQuality = localQuality.label;
                debugService.log(`Audio: ${metadataService.currentAudioQuality}`);
                metadataService.pendingQualityInfo = null;
            }

            if(domService.el.artist.textContent === "Loading...") domService.el.artist.textContent = "Ready";
            if (loopService.getLoopEditVersion(track) === loopEditVersion) loopService.applySliLoopForTrack(track, myPlayToken);
            playbackService.finishPlaybackLoad(load);
            metadataService.updateMediaSession();
            if(track.lrcFile) lyricsService.readLrcFile(track.lrcFile, isCurrent, lyricSession);
            else lyricsService.updateLocalLyrics(lyricSession);
        } catch(e) {
            if (!isCurrent()) return;
            if (e.stale || e.message === 'stale') return;
            coversService.setMainCover();
            metadataService.pendingQualityInfo = null;
            domService.el.bufferLine.style.width = '0%';
            domService.el.artist.textContent = '无法播放';
            domService.el.lyricBox.innerHTML = `<div class="lyric-line active" style="margin-top:100px">❌ ${escapeHtml(e?.message || String(e))}</div>`;
            playbackService.setPlaybackStatus('error', { error: e?.message || String(e) });
            debugService.log("Err: " + e, 'error');
            alert("播放失败，请查看Debug窗口");
        } finally {
            playbackService.releasePlaybackLoad(load);
        }
    }

    let initialized = false;
    return {
        playTrack,
        initialize() {
            if (initialized) return;
            initialized = true;

        }
    };
}
