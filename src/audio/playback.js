import { getNeteaseSongArtists } from '../lyrics/matching.js';
import { createMediaTransport, pcmSizeEstimate, readPlaybackPreference } from './media.js';
import { createMediaSession } from './media-session.js';
import { fmtTime } from '../shared/text.js';

export function createPlayback({
    analysis: analysisService,
    content: contentService,
    controls: controlsService,
    debug: debugService,
    dom: domService,
    download: downloadService,
    loop: loopService,
    lyrics: lyricsService,
    onlinePlaylist: onlinePlaylistService,
    queue: queueService,
    render: renderService
} = {}) {
    let _currentPlayActionToken = 0;

    let _playActionTokenSeed = 0;

    const AudioContext = window.AudioContext || window.webkitAudioContext;

    let actx = new AudioContext();

    let audioBuffer = null, sourceNode = null, gainNode = actx.createGain(), analyser = actx.createAnalyser();

    let lastAudioUnlockWarnAt = 0;

    function logAudioUnlockWarning(message) {
        const now = Date.now();
        if (now - lastAudioUnlockWarnAt < 2500) return;
        lastAudioUnlockWarnAt = now;
        debugService.log(message, 'warn');
    }

    function playSilentUnlockBuffer() {
        if (!actx || typeof actx.createBufferSource !== 'function') return;
        const buffer = actx.createBuffer(1, 1, actx.sampleRate || 44100);
        const source = actx.createBufferSource();
        source.buffer = buffer;
        source.connect(actx.destination);
        source.start(0);
        source.onended = () => {
            try { source.disconnect(); } catch (_) {}
        };
    }

    async function unlockAudioContext(reason = 'play') {
        if (!actx || actx.state === 'closed') return false;
        try { playSilentUnlockBuffer(); } catch (_) {}
        if (actx.state === 'running') return true;

        try {
            if (typeof actx.resume === 'function') await actx.resume();
            try { playSilentUnlockBuffer(); } catch (_) {}
            if (actx.state !== 'running') {
                logAudioUnlockWarning(`AudioContext 未启动(${reason})，iOS Safari 可能需要再点一次播放`);
            }
            return actx.state === 'running';
        } catch (e) {
            logAudioUnlockWarning(`AudioContext 解锁失败(${reason}): ${e && e.message ? e.message : e}`);
            return false;
        }
    }

    let activePlaybackLoad = null;

    let playbackWantsPlay = false;

    let transportVersion = 0;

    let pendingTransportPlay = null;

    let pausedPlaylistAdvance = null;

    const PLAYBACK_STATUSES = new Set(['idle', 'loading', 'playing', 'paused', 'error']);

    let playbackState = { status: 'idle', startTime: 0, pauseTime: 0, isPlaying: false, duration: 0, error: '' };

    let currentAbortController = null;

    // 用于取消之前的网络请求
    let playbackMetadataController = null;

    let playbackPreference = readPlaybackPreference();
    let streamSession = null, onlineResource = null, completePreparation = null, completeActivation = null;

    function updateEngineLabel(message = '') {
        const label = document.getElementById('playback-engine');
        if (label) label.textContent = message || (streamSession ? '流式播放' : audioBuffer ? '完整播放' : '');
    }

    function disposeStream() {
        const session = streamSession;
        streamSession = null;
        if (session?.resumeOnline) window.removeEventListener?.('online', session.resumeOnline);
        session?.media.dispose();
        if (session) onlineResource?.releaseEncoded?.();
    }

    function releaseOnlineResource() {
        disposeStream();
        onlineResource?.dispose?.();
        onlineResource = null;
        completePreparation = null;
        completeActivation = null;
    }

    function assertPcmBudget(duration, channels = 2) {
        const compact = typeof matchMedia === 'function' && matchMedia('(max-width: 700px)').matches;
        const lowMemory = Number(navigator.deviceMemory) > 0 && Number(navigator.deviceMemory) <= 4;
        const limit = (compact || lowMemory ? 128 : 256) * 1024 * 1024;
        if (pcmSizeEstimate(duration, actx.sampleRate, channels) > limit) throw new Error('完整解码预计占用过高，请选择较短的音频或继续流式播放');
    }

    async function decodeCompleteData(data, duration, channels = 2) {
        assertPcmBudget(duration, channels);
        return actx.decodeAudioData(data);
    }

    function ensureCompleteAudio(reason = '精确播放') {
        if (audioBuffer) return Promise.resolve(audioBuffer);
        if (completePreparation) return completePreparation;
        const resource = onlineResource, token = _currentPlayActionToken;
        if (!resource) return Promise.reject(new Error('没有可完整加载的音频'));
        updateEngineLabel(`准备完整音频 · ${reason}`);
        const work = Promise.resolve().then(() => {
            assertPlaybackActionCurrent(token);
            assertPcmBudget(playbackState.duration);
            return resource.loadComplete();
        }).then(result => {
            assertPlaybackActionCurrent(token);
            if (onlineResource !== resource) throw Object.assign(new Error('stale'), { stale: true });
            resource.onComplete?.(result);
            audioBuffer = result.buffer;
            return audioBuffer;
        }).finally(() => {
            if (completePreparation === work) { completePreparation = null; updateEngineLabel(); }
        });
        completePreparation = work;
        return work;
    }

    function activateCompleteAudio(reason = '精确播放', offset = null) {
        if (completeActivation) return completeActivation;
        const token = _currentPlayActionToken;
        const work = (async () => {
            await ensureCompleteAudio(reason);
            assertPlaybackActionCurrent(token);
            const position = offset ?? (streamSession?.media.ended ? 0 : getCurrentTime());
            disposeStream();
            playbackState.duration = audioBuffer.duration;
            playbackState.pauseTime = Math.min(position, audioBuffer.duration);
            updateEngineLabel();
            if (playbackWantsPlay) startAudio(playbackState.pauseTime);
            else setPlaybackStatus('paused');
        })().finally(() => { if (completeActivation === work) completeActivation = null; });
        completeActivation = work;
        return work;
    }

    async function prepareStream(load, options) {
        const media = options.media || createMediaTransport(options.url);
        const session = { media, token: load.token, recovering: false, fallbackUsed: false };
        streamSession = session;
        onlineResource = options;
        const current = () => streamSession === session && isPlaybackActionCurrent(load.token);
        const syncDuration = () => {
            if (!current() || !media.duration) return;
            playbackState.duration = media.duration;
            domService.el.totalTime.textContent = fmtTime(media.duration);
            mediaSession.sync();
        };
        const recover = async error => {
            if (!current() || session.recovering || error?.name === 'AbortError') return;
            if (error?.name === 'NotAllowedError') {
                playbackWantsPlay = false;
                setPlaybackStatus('error', { error: '浏览器阻止了音频播放，请点击播放重试' });
                return;
            }
            session.pendingError = error;
            if (navigator.onLine === false) {
                setPlaybackStatus(playbackWantsPlay ? 'loading' : 'paused');
                if (!session.resumeOnline) {
                    session.resumeOnline = () => {
                        window.removeEventListener?.('online', session.resumeOnline);
                        session.resumeOnline = null;
                        if (current() && playbackWantsPlay) recover(error);
                    };
                    window.addEventListener?.('online', session.resumeOnline);
                }
                return;
            }
            if (!playbackWantsPlay) { setPlaybackStatus('paused'); return; }
            if (session.fallbackUsed) { setPlaybackStatus('error', { error: error.message }); return; }
            session.pendingError = null;
            session.fallbackUsed = true;
            playbackState.pauseTime = getCurrentTime();
            session.recovering = true;
            media.pause();
            setPlaybackStatus(playbackWantsPlay ? 'loading' : 'paused');
            debugService.log(`流式播放失败，尝试完整加载一次: ${error.message}`, 'warn');
            try { await activateCompleteAudio('流式回退'); }
            catch (failure) {
                if (!current()) return;
                session.failure = failure;
                session.recovering = false;
                setPlaybackStatus('error', { error: failure.message });
                debugService.log(`完整加载失败: ${failure.message}`, 'error');
            }
        };
        session.recover = recover;
        media.observe({
            state(status) {
                if (!current() || session.recovering || !playbackWantsPlay) return;
                setPlaybackStatus(status);
            },
            duration: syncDuration,
            progress() {
                if (current() && playbackState.duration) domService.el.bufferLine.style.width = `${Math.min(100, media.bufferedEnd() / playbackState.duration * 100)}%`;
            },
            seek() { if (current()) { playbackState.pauseTime = media.time; mediaSession.sync(); renderService.scheduleRender?.(true); lyricsService.syncWordLyricPlayback?.(); } },
            suspended: () => !playbackWantsPlay || actx.state !== 'running',
            error: recover,
            ended() {
                if (!current() || !playbackWantsPlay || session.recovering) return;
                playbackState.pauseTime = media.time;
                if (queueService.playMode === 2 || loopService.preparingLoop) {
                    setPlaybackStatus('loading');
                    if (queueService.playMode === 2) activateCompleteAudio('单曲无缝循环', 0).catch(recover);
                } else queueService.handleNext();
            }
        });
        try { await media.ready; }
        catch (error) {
            if (!current()) throw Object.assign(new Error('stale'), { stale: true });
            await recover(error);
            if (!audioBuffer && !session.pendingError) throw session.failure || error;
            return;
        }
        assertPlaybackActionCurrent(load.token);
        syncDuration();
        try { media.connect(actx, gainNode); } catch (error) { await recover(error); }
        updateEngineLabel();
    }

    function seekAudio(offset) {
        const time = Math.max(0, Math.min(Number(offset) || 0, playbackState.duration));
        playbackState.pauseTime = time;
        if (streamSession) streamSession.media.seek(time);
        else if (playbackState.isPlaying) startAudio(time);
        mediaSession.sync();
        renderService.scheduleRender?.(true);
        return time;
    }

    function beginPlaybackAction() {
        mediaSession.reset();
        releaseOnlineResource();
        const previousLoad = activePlaybackLoad;
        activePlaybackLoad = null;
        previousLoad?.resume?.();
        currentAbortController?.abort();
        currentAbortController = null;
        playbackWantsPlay = true;
        transportVersion++;
        pendingTransportPlay = null;
        pausedPlaylistAdvance = null;
        analysisService.cancelPreviewTimer();
        controlsService.cancelProgressDrag();
        analysisService.cancelLoopAnalysisRun();
        lyricsService.cancelLocalLyricSession();
        downloadService._currentPlaying = null;
        playbackMetadataController?.abort();
        playbackMetadataController = null;
        _playActionTokenSeed = (_playActionTokenSeed || 0) + 1;
        _currentPlayActionToken = _playActionTokenSeed;
        return _currentPlayActionToken;
    }

    function setCurrentDownloadTrack(track, token, netease = !!track?.netease) {
        if (!track || !isPlaybackActionCurrent(token)) return;
        const songData = track.songData || (netease ? track : null);
        downloadService._currentPlaying = {
            playToken: token,
            netease,
            songData,
            songId: track.songId || songData?.id || track.id || null,
            name: track.name || songData?.name || '',
            artists: getNeteaseSongArtists(songData || track).join(', '),
            file: track.file || null
        };
    }

    function invalidatePlaybackAction() {
        return beginPlaybackAction();
    }

    function isPlaybackActionCurrent(token, track = null) {
        return _currentPlayActionToken === token && (!track || queueService.playlist[queueService.curIdx] === track);
    }

    function assertPlaybackActionCurrent(token, track = null) {
        if (isPlaybackActionCurrent(token, track)) return;
        const error = new Error('stale');
        error.stale = true;
        throw error;
    }

    function getPlaybackLoad(token, track = queueService.playlist[queueService.curIdx] || null) {
        if (activePlaybackLoad?.token === token) return activePlaybackLoad;
        const load = { token, track, queue: queueService.playlist, phase: 'loading', resume: null };
        activePlaybackLoad = load;
        return load;
    }

    function isPlaybackLoadCurrent(load) {
        return !!load && activePlaybackLoad === load && load.queue === queueService.playlist
            && isPlaybackActionCurrent(load.token, load.track);
    }

    async function decodePlaybackLoad(load, data) {
        // Keep the compressed buffer in this task, not a second cache, while paused.
        while (isPlaybackLoadCurrent(load) && (!playbackWantsPlay || pendingTransportPlay)) {
            load.phase = 'ready';
            await new Promise(resolve => { load.resume = resolve; });
            load.resume = null;
        }
        assertPlaybackActionCurrent(load.token, load.track);
        if (!isPlaybackLoadCurrent(load)) throw Object.assign(new Error('stale'), { stale: true });
        load.phase = 'decoding';
        return actx.decodeAudioData(data);
    }

    function finishPlaybackLoad(load, offset = 0) {
        if (!isPlaybackLoadCurrent(load)) return;
        activePlaybackLoad = null;
        if (playbackWantsPlay && !pendingTransportPlay) startAudio(offset);
        else setPlaybackStatus('paused');
    }

    function releasePlaybackLoad(load) {
        if (activePlaybackLoad !== load) return;
        activePlaybackLoad = null;
        load.resume?.();
        load.resume = null;
    }

    function requestPlaybackPause() {
        analysisService.cancelPreviewTimer();
        controlsService.cancelProgressDrag();
        const data = onlinePlaylistService.currentPlaylistData;
        if ((queueService.playlistPendingAdvance || data?.pendingAdvance) && data?.queueRef === queueService.playlist) {
            pausedPlaylistAdvance = { data, queue: queueService.playlist, index: queueService.curIdx };
        }
        queueService.playlistPendingAdvance = false;
        if (data?.queueRef === queueService.playlist) data.pendingAdvance = false;
        if (playbackState.isPlaying) playbackState.pauseTime = getCurrentTime();
        stopAudio('paused', { preserveLoad: true });
    }

    function requestPlaybackPlay() {
        analysisService.cancelPreviewTimer();
        controlsService.cancelProgressDrag();
        if (playbackState.isPlaying || (playbackWantsPlay && (activePlaybackLoad || pendingTransportPlay || queueService.playlistPendingAdvance))) {
            return pendingTransportPlay || Promise.resolve(true);
        }
        const waiting = pausedPlaylistAdvance;
        if (waiting && waiting.queue === queueService.playlist && waiting.index === queueService.curIdx && waiting.data === onlinePlaylistService.currentPlaylistData
            && waiting.data.imported && waiting.data.importToken === queueService.activePlaylistQueueToken) {
            pausedPlaylistAdvance = null;
            playbackWantsPlay = true;
            const version = ++transportVersion;
            const token = _currentPlayActionToken;
            queueService.playlistPendingAdvance = waiting.data.pendingAdvance = true;
            setPlaybackStatus('loading');
            // Unlock in the user gesture, even if the next metadata batch is still pending.
            const request = unlockAudioContext('playlist-resume').then(unlocked => {
                if (version !== transportVersion || !isPlaybackActionCurrent(token) || waiting.queue !== queueService.playlist) return false;
                if (!unlocked) {
                    requestPlaybackPause();
                    setPlaybackStatus('error', { error: '浏览器阻止了音频播放' });
                }
                return unlocked;
            }).finally(() => {
                if (pendingTransportPlay === request) {
                    pendingTransportPlay = null;
                    updatePlayIcon();
                }
            });
            pendingTransportPlay = request;
            onlinePlaylistService.settlePlaylistAdvance(waiting.data);
            return request;
        }
        const load = activePlaybackLoad;
        if (!load && !audioBuffer && !streamSession) {
            if (!queueService.playlist.length) return Promise.resolve(false);
            const index = queueService.curIdx >= 0 && queueService.curIdx < queueService.playlist.length ? queueService.curIdx : 0;
            return queueService.playTrackFromPlaylist(index);
        }
        playbackWantsPlay = true;
        const version = ++transportVersion;
        const token = _currentPlayActionToken;
        const queue = queueService.playlist, track = queueService.playlist[queueService.curIdx], buffer = audioBuffer;
        const guard = () => version === transportVersion && playbackWantsPlay
            && queue === queueService.playlist && track === queueService.playlist[queueService.curIdx] && isPlaybackActionCurrent(token)
            && (!!load || buffer === audioBuffer);
        const unlockPromise = unlockAudioContext('play-button');
        if (load) setPlaybackStatus('loading');
        const request = unlockPromise.then(unlocked => {
            if (!guard()) return false;
            if (!unlocked) {
                playbackWantsPlay = false;
                setPlaybackStatus('error', { error: '浏览器阻止了音频播放' });
                return false;
            }
            if (isPlaybackLoadCurrent(load)) load.resume?.();
            else if (audioBuffer || streamSession) startAudio(playbackState.pauseTime);
            return true;
        }).finally(() => {
            if (pendingTransportPlay === request) {
                pendingTransportPlay = null;
                if (isPlaybackLoadCurrent(load)) load.resume?.();
                else if (guard() && (audioBuffer || streamSession) && !playbackState.isPlaying) startAudio(playbackState.pauseTime);
                updatePlayIcon();
            }
        });
        pendingTransportPlay = request;
        updatePlayIcon();
        return request;
    }

    function togglePlayback() {
        if (playbackState.isPlaying || playbackWantsPlay && (activePlaybackLoad || pendingTransportPlay || queueService.playlistPendingAdvance)) {
            requestPlaybackPause();
        } else return requestPlaybackPlay();
    }

    function getActiveCustomLoop() {
        const duration = Number(audioBuffer?.duration || 0);
        const start = Number(loopService.loopState.start);
        const end = Number(loopService.loopState.end);
        if(!loopService.loopState.active || !duration || !Number.isFinite(start) || !Number.isFinite(end)) return null;
        if(start < 0 || end <= start || end > duration) return null;
        return { start, end };
    }

    function normalizeAudioOffset(offset, customLoop, isSingleTrackLooping) {
        const duration = Number(audioBuffer?.duration || 0);
        let normalized = Number(offset);
        if(!Number.isFinite(normalized)) normalized = 0;
        normalized = Math.max(0, normalized);

        if(customLoop && normalized >= customLoop.end) {
            const loopDuration = customLoop.end - customLoop.start;
            normalized = customLoop.start + ((normalized - customLoop.start) % loopDuration + loopDuration) % loopDuration;
        } else if(isSingleTrackLooping && duration > 0) {
            normalized %= duration;
        }

        return Math.min(normalized, duration);
    }

    function startAudio(offset) {
        if (streamSession && !loopStateRequiresPcm()) {
            const session = streamSession;
            const version = ++transportVersion;
            playbackWantsPlay = true;
            playbackState.pauseTime = Number(offset) || 0;
            setPlaybackStatus('loading');
            if (session.pendingError) { session.recover(session.pendingError); return true; }
            session.media.play(offset, () => streamSession === session && transportVersion === version && playbackWantsPlay).catch(error => {
                if (streamSession === session && transportVersion === version) session.recover(error);
            });
            return true;
        }
        if (streamSession && !audioBuffer) {
            playbackWantsPlay = true;
            seekAudio(offset);
            activateCompleteAudio('精确循环').catch(error => {
                if (!error.stale && error.name !== 'AbortError') debugService.log(error.message, 'error');
            });
            return true;
        }
        if (streamSession) disposeStream();
        if (!audioBuffer || !Number.isFinite(audioBuffer.duration) || audioBuffer.duration <= 0) {
            setPlaybackStatus('error', { error: '没有可播放的音频数据' });
            return false;
        }
        playbackWantsPlay = true;
        transportVersion++;
        pendingTransportPlay = null;
        if(sourceNode) {
            try { sourceNode.onended = null; sourceNode.stop(); } catch(e) {}
            try { sourceNode.disconnect(); } catch(e) {}
        }
        sourceNode = actx.createBufferSource();
        sourceNode.buffer = audioBuffer;
        sourceNode.connect(gainNode);

        const customLoop = getActiveCustomLoop();
        const isCustomLooping = !!customLoop;
        const isSingleTrackLooping = !isCustomLooping && queueService.playMode === 2 && audioBuffer.duration > 0;
        const isLooping = isCustomLooping || isSingleTrackLooping;
        const startOffset = normalizeAudioOffset(offset, customLoop, isSingleTrackLooping);

        if(isLooping) {
            sourceNode.loop = true;
            sourceNode.loopStart = isCustomLooping ? customLoop.start : 0;
            sourceNode.loopEnd = isCustomLooping ? customLoop.end : audioBuffer.duration;
            document.getElementById('loop-status').style.display = isCustomLooping ? 'inline' : 'none';
        } else {
            sourceNode.loop = false;
            document.getElementById('loop-status').style.display = 'none';
        }
        sourceNode.start(0, startOffset);
        const startedSource = sourceNode;
        playbackState.startTime = actx.currentTime - startOffset;
        playbackState.pauseTime = startOffset;
        setPlaybackStatus('playing');
        updateEngineLabel();

        if (actx.state !== 'running') {
            unlockAudioContext('start-audio').then(unlocked => {
                if (unlocked || sourceNode !== startedSource || !playbackState.isPlaying) return;
                try { startedSource.onended = null; startedSource.stop(); } catch (_) {}
                try { startedSource.disconnect(); } catch (_) {}
                sourceNode = null;
                setPlaybackStatus('error', { error: '浏览器阻止了音频播放' });
                logAudioUnlockWarning('音频被浏览器拦截了，请再点一次播放按钮');
            });
        }

        // 使用闭包保存循环状态，避免后续状态变化影响判断
        const wasCustomLooping = isCustomLooping;
        const wasSingleTrackLooping = isSingleTrackLooping;
        sourceNode.onended = () => {
            // 如果是循环模式，onended 不应该触发切歌
            // 但某些浏览器可能在精度问题下意外触发，这里重新启动循环
            if(wasCustomLooping && loopService.loopState.active && playbackState.isPlaying) {
                debugService.log("Loop interrupted, restarting...", 'warn');
                startAudio(loopService.loopState.start);
                return;
            }
            if(wasSingleTrackLooping && queueService.playMode === 2 && playbackState.isPlaying) {
                debugService.log("Single loop interrupted, restarting...", 'warn');
                startAudio(0);
                return;
            }
            // 非循环模式下，检查是否真的播放完了
            if(playbackState.isPlaying && (getCurrentTime() >= playbackState.duration - 0.5)) {
                queueService.handleNext();
            }
        };
        return true;
    }

    function stopAudio(nextStatus = 'paused', { preserveLoad = false } = {}) {
        if (nextStatus === 'paused') {
            playbackWantsPlay = false;
            transportVersion++;
            pendingTransportPlay = null;
        }
        if(sourceNode) { try{sourceNode.onended=null; sourceNode.stop()}catch(e){}; sourceNode.disconnect(); sourceNode=null; }
        streamSession?.media.pause();
        setPlaybackStatus(nextStatus);
        // 取消当前的网络请求
        if(currentAbortController && !preserveLoad) {
            currentAbortController.abort();
            currentAbortController = null;
        }
    }

    function getCurrentTime() {
        if (streamSession && !streamSession.recovering) return streamSession.media.time;
        if(!playbackState.isPlaying) return playbackState.pauseTime;
        let t = actx.currentTime - playbackState.startTime;
        const customLoop = getActiveCustomLoop();
        if(customLoop && sourceNode?.loop && t >= customLoop.end) { const dur = customLoop.end - customLoop.start; t = customLoop.start + (t - customLoop.end) % dur; }
        else if(!customLoop && queueService.playMode === 2 && sourceNode?.loop && playbackState.duration > 0 && t >= playbackState.duration) t %= playbackState.duration;
        else if (t > playbackState.duration) t = playbackState.duration;
        return t;
    }

    function loopStateRequiresPcm() { return queueService.playMode === 2 || loopService.loopState.active; }

    function updatePlayIcon() {
        const canPause = playbackState.isPlaying || playbackWantsPlay
            && (playbackState.status === 'loading' || !!pendingTransportPlay);
        domService.el.playBtn.innerHTML = canPause ? '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
        domService.el.playBtn.setAttribute('aria-label', canPause ? '暂停' : '播放');
        domService.el.playBtn.title = domService.el.playBtn.getAttribute('aria-label');
        domService.el.playBtn.disabled = false;
        if (typeof contentService.updateMusicMiniPlayer === 'function') contentService.updateMusicMiniPlayer();
    }

    function setPlaybackStatus(status, options = {}) {
        const nextStatus = PLAYBACK_STATUSES.has(status) ? status : 'error';
        playbackState.status = nextStatus;
        playbackState.isPlaying = nextStatus === 'playing';
        playbackState.error = nextStatus === 'error' ? String(options.error || '') : '';
        domService.el.coverWrap.classList.toggle('playing', nextStatus === 'playing');
        domService.el.loadTip.style.display = nextStatus === 'loading' ? 'block' : 'none';
        document.querySelector('.main-container')?.setAttribute('aria-busy', nextStatus === 'loading' ? 'true' : 'false');
        mediaSession.sync();
        updatePlayIcon();
        if (typeof renderService.scheduleRender === 'function') renderService.scheduleRender(true);
        lyricsService.syncWordLyricPlayback?.();
        return nextStatus;
    }

    function resetPlaybackTimeline() {
        playbackState.startTime = 0;
        playbackState.pauseTime = 0;
        playbackState.duration = 0;
        renderService._lastTimeStr = '00:00';
        domService.el.currTime.textContent = '00:00';
        domService.el.totalTime.textContent = '00:00';
        renderService.setPlaybackProgress(0);
        domService.el.bufferLine.style.width = '0%';
        mediaSession.sync();
        updateEngineLabel();
    }

    const mediaSession = createMediaSession({
        readState: () => ({ status: playbackState.status, hasAudio: !!audioBuffer || !!streamSession,
            duration: playbackState.duration, position: getCurrentTime(), running: actx.state === 'running' }),
        seekTo: seekAudio,
        play: requestPlaybackPlay,
        pause: requestPlaybackPause,
        previous: () => document.getElementById('prev-btn')?.click(),
        next: () => document.getElementById('next-btn')?.click()
    });

    let initialized = false;
    return {
        get _currentPlayActionToken() { return _currentPlayActionToken; },
        get audioBuffer() { return audioBuffer; },
        set audioBuffer(value) { audioBuffer = value; },
        get sourceNode() { return sourceNode; },
        get isStreaming() { return !!streamSession; },
        get canWarmNextStream() { return !streamSession || streamSession.media.bufferedEnd() >= Math.min(playbackState.duration, getCurrentTime() + 5); },
        get hasAudio() { return !!audioBuffer || !!streamSession; },
        get playbackPreference() { return playbackPreference; },
        get preparingCompleteAudio() { return !!completePreparation; },
        prepareStream,
        ensureCompleteAudio,
        activateCompleteAudio,
        decodeCompleteData,
        seekAudio,
        get gainNode() { return gainNode; },
        get analyser() { return analyser; },
        unlockAudioContext,
        get playbackWantsPlay() { return playbackWantsPlay; },
        get transportVersion() { return transportVersion; },
        get playbackState() { return playbackState; },
        get audioContextRunning() { return actx.state === 'running'; },
        get currentAbortController() { return currentAbortController; },
        set currentAbortController(value) { currentAbortController = value; },
        get playbackMetadataController() { return playbackMetadataController; },
        set playbackMetadataController(value) { playbackMetadataController = value; },
        beginPlaybackAction,
        setCurrentDownloadTrack,
        invalidatePlaybackAction,
        isPlaybackActionCurrent,
        assertPlaybackActionCurrent,
        getPlaybackLoad,
        decodePlaybackLoad,
        finishPlaybackLoad,
        releasePlaybackLoad,
        requestPlaybackPause,
        requestPlaybackPlay,
        togglePlayback,
        getActiveCustomLoop,
        startAudio,
        stopAudio,
        getCurrentTime,
        setPlaybackStatus,
        resetPlaybackTimeline,
        initialize() {
            if (initialized) return;
            initialized = true;
            mediaSession.initialize();
            const modeSelect = document.getElementById('playback-mode');
            if (modeSelect) {
                modeSelect.value = playbackPreference;
                modeSelect.addEventListener('change', () => {
                    playbackPreference = modeSelect.value === 'stream' ? 'stream' : 'complete';
                    try { localStorage.setItem('aurora_playback_mode', playbackPreference); } catch (_) {}
                    debugService.log(`后续在线播放: ${playbackPreference === 'stream' ? '流式优先' : '完整加载'}`);
                });
            }
            actx.addEventListener?.('statechange', () => {
                mediaSession.sync();
                lyricsService.syncWordLyricPlayback?.();
                renderService.scheduleRender?.(true);
            });
            gainNode.connect(analyser);

            analyser.connect(actx.destination);

            analyser.fftSize = 512;
        }
    };
}
