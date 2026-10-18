import { createLyricTimeLookup } from '../lyrics/parser.js';
import { fmtTime } from '../shared/text.js';

export function createControls({
    analysis: analysisService,
    debug: debugService,
    dom: domService,
    lyrics: lyricsService,
    panels: panelsService,
    playback: playbackService,
    playlistView: playlistViewService,
    queue: queueService,
    render: renderService
} = {}) {
    let volTimer = null;

    // 进度条拖动支持
    let isDraggingProgress = false;

    let wasPlayingBeforeDrag = false;

    let progressDragPointerId = null;

    let progressDragSnapshot = null;

    function cancelProgressDrag() {
        if (!isDraggingProgress) return;
        isDraggingProgress = false;
        const pointerId = progressDragPointerId;
        progressDragPointerId = null;
        progressDragSnapshot = null;
        try { domService.el.progBg.releasePointerCapture(pointerId); } catch (_) {}
    }

    function handleProgressSeek(e) {
        if(!playbackService.playbackState.duration) return;
        const rect = domService.el.progBg.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const pct = Math.max(0, Math.min(1, x / rect.width));
        const target = pct * playbackService.playbackState.duration;
        renderService.setPlaybackProgress(pct);
        domService.el.currTime.textContent = fmtTime(target);
        return target;
    }

    function finishProgressDrag(e) {
        if(!isDraggingProgress || e.pointerId !== progressDragPointerId) return;
        const snapshot = progressDragSnapshot;
        cancelProgressDrag();
        if (!snapshot || snapshot.token !== playbackService._currentPlayActionToken
            || snapshot.buffer !== playbackService.audioBuffer || snapshot.track !== queueService.playlist[queueService.curIdx]) return;
        if(wasPlayingBeforeDrag) {
            playbackService.startAudio(playbackService.playbackState.pauseTime);
        } else playbackService.setPlaybackStatus('paused');
    }

    function showKeyboardVolume() {
        panelsService.setFloatingPanel('vol-popup', true);
        clearTimeout(volTimer);
        volTimer = setTimeout(() => panelsService.setFloatingPanel('vol-popup', false), 2000);
    }

    function updateUI(t) { domService.el.currTime.textContent = fmtTime(t); renderService.setPlaybackProgress(t / playbackService.playbackState.duration); }

    let initialized = false;
    return {
        cancelProgressDrag,
        initialize() {
            if (initialized) return;
            initialized = true;
            domService.el.playBtn.onclick = playbackService.togglePlayback;

            domService.el.progBg.addEventListener('pointerdown', e => {
                if(!playbackService.playbackState.duration) return;
                if (isDraggingProgress) return;
                if (e.button !== undefined && e.button !== 0) return;
                analysisService.cancelPreviewTimer();
                isDraggingProgress = true;
                progressDragPointerId = e.pointerId;
                wasPlayingBeforeDrag = playbackService.playbackState.isPlaying;
                progressDragSnapshot = { token: playbackService._currentPlayActionToken, buffer: playbackService.audioBuffer, track: queueService.playlist[queueService.curIdx] };
                try { domService.el.progBg.setPointerCapture(e.pointerId); } catch (_) {}
                if(wasPlayingBeforeDrag) playbackService.stopAudio('paused');
                playbackService.playbackState.pauseTime = handleProgressSeek(e);
                e.preventDefault();
            });

            domService.el.progBg.addEventListener('pointermove', e => {
                if(!isDraggingProgress || e.pointerId !== progressDragPointerId) return;
                if (progressDragSnapshot?.token !== playbackService._currentPlayActionToken
                    || progressDragSnapshot?.buffer !== playbackService.audioBuffer || progressDragSnapshot?.track !== queueService.playlist[queueService.curIdx]) {
                    cancelProgressDrag();
                    return;
                }
                playbackService.playbackState.pauseTime = handleProgressSeek(e);
                e.preventDefault();
            });

            domService.el.progBg.addEventListener('pointerup', finishProgressDrag);

            domService.el.progBg.addEventListener('pointercancel', finishProgressDrag);

            domService.el.progBg.addEventListener('lostpointercapture', finishProgressDrag);

            domService.el.volBtn.onclick = () => {
                clearTimeout(volTimer);
                panelsService.toggleFloatingPanel('vol-popup');
            };

            domService.el.volRange.oninput = () => { playbackService.gainNode.gain.value = domService.el.volRange.value; };

            document.addEventListener('keydown', (e) => {
                const target = e.target instanceof Element ? e.target : null;
                if (panelsService.modalController.active || target?.closest('input, textarea, select, button, a[href], [contenteditable="true"], [role="button"], [role="slider"], [role="dialog"]')) return;
                if(e.code === 'Space') { e.preventDefault(); domService.el.playBtn.click(); }
                else if (e.code === 'ArrowLeft') { if (playbackService.audioBuffer) { const t = Math.max(0, playbackService.getCurrentTime() - 5); if (playbackService.playbackState.isPlaying) playbackService.startAudio(t); else { playbackService.playbackState.pauseTime = t; updateUI(t); } } }
                else if (e.code === 'ArrowRight') { if (playbackService.audioBuffer) { const t = Math.min(playbackService.playbackState.duration, playbackService.getCurrentTime() + 5); if (playbackService.playbackState.isPlaying) playbackService.startAudio(t); else { playbackService.playbackState.pauseTime = t; updateUI(t); } } }
                else if (e.code === 'ArrowUp') { e.preventDefault(); domService.el.volRange.value = Math.min(1, parseFloat(domService.el.volRange.value) + 0.05); playbackService.gainNode.gain.value = domService.el.volRange.value; showKeyboardVolume(); }
                else if (e.code === 'ArrowDown') { e.preventDefault(); domService.el.volRange.value = Math.max(0, parseFloat(domService.el.volRange.value) - 0.05); playbackService.gainNode.gain.value = domService.el.volRange.value; showKeyboardVolume(); }
            });

            domService.el.progBg.addEventListener('keydown', event => {
                if (!playbackService.audioBuffer || !playbackService.playbackState.duration) return;
                let target = null;
                if (event.key === 'ArrowLeft') target = Math.max(0, playbackService.getCurrentTime() - 5);
                else if (event.key === 'ArrowRight') target = Math.min(playbackService.playbackState.duration, playbackService.getCurrentTime() + 5);
                else if (event.key === 'Home') target = 0;
                else if (event.key === 'End') target = playbackService.playbackState.duration;
                if (target === null) return;
                event.preventDefault();
                analysisService.cancelPreviewTimer();
                if (playbackService.playbackState.isPlaying) playbackService.startAudio(target);
                else {
                    playbackService.playbackState.pauseTime = target;
                    updateUI(target);
                    renderService.scheduleRender(true);
                }
            });

            document.getElementById('toggle-list').onclick = () => panelsService.toggleFloatingPanel('playlist-sidebar');

            if (domService.el.plScrollCurrent) domService.el.plScrollCurrent.onclick = playlistViewService.scrollPlaylistToCurrent;

            if (domService.el.plScrollTop) domService.el.plScrollTop.onclick = playlistViewService.scrollPlaylistToTop;

            document.getElementById('toggle-loop-panel').onclick = () => panelsService.toggleFloatingPanel('loop-panel');

            document.getElementById('toggle-analyze').onclick = () => panelsService.toggleFloatingPanel('analyze-panel');

            document.addEventListener('click', event => {
                const closeButton = event.target.closest('.panel-float .panel-close');
                if (!closeButton) return;
                const panel = closeButton.closest('.panel-float');
                if (panel) panelsService.setFloatingPanel(panel.id, false);
            });

            document.getElementById('toggle-debug').onclick = () => {
                const dbg = document.getElementById('debug-console');
                dbg.style.display = (dbg.style.display === 'none' || dbg.style.display === '') ? 'block' : 'none';
                debugService.scheduleDebugScroll();
            };

            domService.neteaseBtn.onclick = () => {
                lyricsService.neteaseSearchEnabled = !lyricsService.neteaseSearchEnabled;
                domService.neteaseBtn.style.background = lyricsService.neteaseSearchEnabled ? '#27ae60' : '';
                domService.neteaseBtn.style.color = lyricsService.neteaseSearchEnabled ? '#fff' : '';
                domService.neteaseBtn.setAttribute('aria-pressed', lyricsService.neteaseSearchEnabled ? 'true' : 'false');
                debugService.log(`Netease lyrics search: ${lyricsService.neteaseSearchEnabled ? 'ON' : 'OFF'}`);
            };

            if (domService.advancedBtn && domService.advancedMenu) {
                domService.advancedBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    panelsService.toggleFloatingPanel('advanced-menu');
                });

                // 点击菜单项
                domService.advancedMenu.querySelectorAll('.advanced-menu-item').forEach(item => {
                    item.addEventListener('click', function(e) {
                        e.preventDefault();
                        e.stopPropagation();
                        const action = this.dataset.action;
                        panelsService.setFloatingPanel('advanced-menu', false);

                        if (action === 'debug') {
                            const dbg = document.getElementById('debug-console');
                            dbg.style.display = (dbg.style.display === 'none' || dbg.style.display === '') ? 'block' : 'none';
                            debugService.scheduleDebugScroll();
                        } else if (action === 'analyze') {
                            panelsService.toggleFloatingPanel('analyze-panel');
                        } else if (action === 'loop') {
                            panelsService.toggleFloatingPanel('loop-panel');
                        } else if (action === 'netease-lyrics') {
                            // 切换云词开关
                            lyricsService.neteaseSearchEnabled = !lyricsService.neteaseSearchEnabled;
                            domService.neteaseBtn.style.background = lyricsService.neteaseSearchEnabled ? '#27ae60' : '';
                            domService.neteaseBtn.style.color = lyricsService.neteaseSearchEnabled ? '#fff' : '';
                            domService.neteaseBtn.setAttribute('aria-pressed', lyricsService.neteaseSearchEnabled ? 'true' : 'false');
                            debugService.log(`Netease lyrics search: ${lyricsService.neteaseSearchEnabled ? 'ON' : 'OFF'}`);
                            alert(`云词搜索已${lyricsService.neteaseSearchEnabled ? '开启' : '关闭'}`);
                        } else if (action === 'effects') {
                            // 循环切换特效
                            const options = ['none', 'snow', 'bars', 'waves'];
                            const names = ['无特效', '凛冬飞雪', '律动频谱', '极光波浪'];
                            const current = options.indexOf(domService.el.effectSel.value);
                            const next = (current + 1) % options.length;
                            domService.el.effectSel.value = options[next];
                            domService.el.effectSel.dispatchEvent(new Event('change'));
                            alert(`特效: ${names[next]}`);
                        } else if (action === 'lyric-toggle') {
                            // 优先复用桌面按钮逻辑（如果存在）
                            if (domService.lyricToggleBtn) {
                                domService.lyricToggleBtn.click();
                            } else {
                                // 备用：直接切换状态并触发渲染/增量更新
                                lyricsService.lyricDisplayMode = lyricsService.lyricDisplayMode === 'original' ? 'both' : 'original';
                                localStorage.setItem('lyric_mode', lyricsService.lyricDisplayMode);
                                const lines = domService.el.lyricBox.querySelectorAll('.lyric-line');
                                if (lines && lines.length && (lyricsService.originalLyricsArr.some(l=>l.t>=0) || lyricsService.translatedLyricsArr.some(l=>l.t>=0))) {
                                    if (lyricsService.lyricDisplayMode === 'both') {
                                        const findTranslation = createLyricTimeLookup(lyricsService.translatedLyricsArr);
                                        lines.forEach(lineEl => {
                                            if (lineEl.querySelector('.lyric-translation')) return;
                                            const t = parseFloat(lineEl.dataset.time || -1);
                                            if (isNaN(t) || t < 0) return;
                                            const trans = findTranslation(t);
                                            if (trans && trans.txt) {
                                                const tdiv = document.createElement('div');
                                                tdiv.className = 'lyric-translation';
                                                tdiv.textContent = trans.txt;
                                                lineEl.appendChild(tdiv);
                                            }
                                        });
                                    } else {
                                        domService.el.lyricBox.querySelectorAll('.lyric-translation').forEach(n => n.remove());
                                    }
                                } else {
                                    lyricsService.renderLyricsFromArrays();
                                }
                                lyricsService.updateLyricToggleUI(!!(lyricsService.translatedLyricsArr && lyricsService.translatedLyricsArr.length));
                            }
                            alert('已切换歌词显示模式');
                        }
                    });
                });

                // 点击其他地方关闭菜单
                document.addEventListener('click', function(e) {
                    if (!domService.advancedBtn.contains(e.target) && !domService.advancedMenu.contains(e.target)) {
                        if (panelsService.floatingPanels.get('advanced-menu').open) panelsService.setFloatingPanel('advanced-menu', false);
                    }
                });
            } else {
                console.log('Advanced menu elements not found:', { advancedBtn: domService.advancedBtn, advancedMenu: domService.advancedMenu });
            }
        }
    };
}
