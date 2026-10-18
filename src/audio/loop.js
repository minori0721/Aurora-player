export function createLoop({
    debug: debugService,
    dom: domService,
    lyrics: lyricsService,
    playback: playbackService,
    playlistView: playlistViewService,
    queue: queueService
} = {}) {
    const loopEditVersions = new WeakMap();

    // 网易云歌词搜索开关，默认关闭
    let loopState = { active: false, start: 0, end: 0, source: null };

    function getLoopEditVersion(track) {
        return track ? loopEditVersions.get(track) || 0 : 0;
    }

    function markLoopUserEdit() {
        const track = queueService.playlist[queueService.curIdx];
        if (track) loopEditVersions.set(track, getLoopEditVersion(track) + 1);
    }

    function resolveTrackSliLoop(track) {
        if (!track?.sliData || track.sliData.status !== 'valid') return { status: 'invalid', error: track?.sliMessage || 'SLI 未正确解析' };
        const rate = Number.parseInt(domService.el.baseRateInput.value, 10) || 44100;
        if (!Number.isFinite(rate) || rate <= 0) return { status: 'invalid', error: 'Base Rate 必须大于 0' };
        const start = track.sliData.toSamples / rate;
        let end = track.sliData.fromSamples / rate;
        const duration = Number(playbackService.audioBuffer?.duration || playbackService.playbackState.duration || 0);
        if (!(start >= 0 && end > start)) return { status: 'invalid', error: '循环区间无效' };
        if (duration > 0 && end > duration) {
            const tolerance = (1 / rate) + 1e-9;
            if (end - duration <= tolerance) end = duration;
            else return { status: 'invalid', error: `循环终点 ${end.toFixed(3)}s 超过音频时长 ${duration.toFixed(3)}s` };
        }
        return { status: 'valid', start, end, rate };
    }

    function applySliLoopForTrack(track, playToken = null) {
        if (playToken !== null && !playbackService.isPlaybackActionCurrent(playToken, track)) return false;
        if (!track || queueService.playlist[queueService.curIdx] !== track || track.sliStatus !== 'valid') {
            if (track?.sliStatus === 'invalid') domService.el.loopMsg.textContent = track.sliMessage || 'SLI 无效';
            return false;
        }
        const resolved = resolveTrackSliLoop(track);
        if (resolved.status !== 'valid') {
            track.sliRuntimeError = resolved.error;
            domService.el.loopMsg.textContent = resolved.error;
            debugService.log(`SLI 无效: ${track.sliAsset?.relativePath || track.name} (${resolved.error})`, 'error');
            playlistViewService.refreshPlaylistItem(queueService.curIdx);
            return false;
        }
        track.sliRuntimeError = '';
        if (loopState.active && loopState.source === 'sli'
            && loopState.start === resolved.start && loopState.end === resolved.end) {
            domService.el.loopMsg.textContent = 'SLI Loaded';
            return true;
        }
        if (applyLoop(resolved.start, resolved.end, 'sli')) {
            domService.el.loopMsg.textContent = 'SLI Loaded';
            return true;
        }
        return false;
    }

    function syncCurrentTrackCompanions(track, changes = { sliChanged: true, lrcChanged: true }, token = playbackService._currentPlayActionToken) {
        if (!track || !playbackService.isPlaybackActionCurrent(token, track)) return;
        if (changes.sliChanged && playbackService.audioBuffer) {
            if (track.sliStatus === 'valid') {
                applySliLoopForTrack(track, token);
            } else if (loopState.active && loopState.source === 'sli') {
                const currentTime = playbackService.getCurrentTime();
                const wasPlaying = playbackService.playbackState.isPlaying;
                resetLoopUI();
                if (wasPlaying) playbackService.startAudio(currentTime);
            }
        }
        const session = lyricsService.localLyricSession;
        if (!changes.lrcChanged || session?.track !== track || !lyricsService.isLocalLyricSessionCurrent(session)) return;
        if (track.lrcFile) lyricsService.readLrcFile(track.lrcFile, session.isCurrent, session);
        else {
            session.lrcVersion++;
            session.lrcFile = null;
            session.lrcPending = false;
            if (session.source === 'lrc') {
                session.source = null;
                lyricsService.resetTrackLyrics();
                domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">暂无歌词</div>';
            }
            lyricsService.updateLocalLyrics(session);
        }
    }

    function applyLoop(s, e, source = 'manual') {
        if (source !== 'sli') markLoopUserEdit();
        const currentTime = playbackService.getCurrentTime();
        const previousLoop = playbackService.getActiveCustomLoop();
        const duration = Number(playbackService.audioBuffer?.duration || playbackService.playbackState.duration || 0);
        const isValid = Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e > s && (!duration || e <= duration);
        if(!isValid) {
            loopState = { active: false, start: Number(s) || 0, end: Number(e) || 0, source: null };
            domService.el.loopEnable.checked = false;
            domService.el.loopMsg.textContent = '循环区间无效';
            updateLoopMarkers();
            if(previousLoop && playbackService.playbackState.isPlaying) playbackService.startAudio(currentTime);
            return false;
        }
        domService.el.loopStart.value = s.toFixed(3); domService.el.loopEnd.value = e.toFixed(3);
        domService.el.loopEnable.checked = true; loopState = { active: true, start: s, end: e, source };
        domService.el.loopMsg.textContent = '';
        updateLoopMarkers();
        if(playbackService.playbackState.isPlaying) playbackService.startAudio(currentTime);
        return true;
    }

    const setLoopPoint = function(t) {
        const now = playbackService.getCurrentTime();
        if(t==='a') domService.el.loopStart.value=now.toFixed(3); else domService.el.loopEnd.value=now.toFixed(3);
        domService.el.loopEnable.checked = true; domService.el.loopEnable.dispatchEvent(new Event('change'));
    };

    function resetLoopUI() { loopState.active=false; loopState.source=null; domService.el.loopEnable.checked=false; domService.el.loopMsg.textContent=''; updateLoopMarkers(); }

    function updateLoopMarkers() {
        if(!loopState.active) { domService.el.markerA.style.display='none'; domService.el.markerB.style.display='none'; document.getElementById('loop-status').style.display='none'; return; }
        const d = playbackService.playbackState.duration || 1;
        domService.el.markerA.style.left = (loopState.start/d)*100+'%'; domService.el.markerB.style.left = (loopState.end/d)*100+'%';
        domService.el.markerA.style.display='block'; domService.el.markerB.style.display='block'; document.getElementById('loop-status').style.display='inline';
    }

    let initialized = false;
    return {
        setLoopPoint,
        get loopState() { return loopState; },
        getLoopEditVersion,
        applySliLoopForTrack,
        syncCurrentTrackCompanions,
        applyLoop,
        resetLoopUI,
        initialize() {
            if (initialized) return;
            initialized = true;
            domService.el.loopEnable.addEventListener('change', e => {
                if(e.target.checked) {
                    const s = parseFloat(domService.el.loopStart.value), e_val = parseFloat(domService.el.loopEnd.value);
                    applyLoop(s, e_val);
                } else {
                    markLoopUserEdit();
                    const currentTime = playbackService.getCurrentTime();
                    const wasActive = !!playbackService.getActiveCustomLoop();
                    loopState.active = false;
                    loopState.source = null;
                    if(wasActive && playbackService.playbackState.isPlaying) playbackService.startAudio(currentTime);
                    updateLoopMarkers();
                }
            });
        }
    };
}
