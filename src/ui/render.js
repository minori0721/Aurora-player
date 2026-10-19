import { fmtTime } from '../shared/text.js';
import { buildCoverTheme, DEFAULT_THEME_BASE, DEFAULT_THEME_COLORS } from './theme.js';
import { coverThemeKey, createThemeCache } from './theme-cache.js';

export function createRender({
    dom: domService,
    lyrics: lyricsService,
    playback: playbackService,
    prefetch: prefetchService,
    queue: queueService
} = {}) {
    let particles = [];

    const colorThief = new ColorThief();

    const themeColorCanvas = document.createElement('canvas');
    const themeCache = createThemeCache();
    const noCoverTheme = { base: DEFAULT_THEME_BASE, colors: DEFAULT_THEME_COLORS };
    let lastTheme = null;

    const canvasCtx = domService.el.canvas.getContext('2d');

    let _lastTimeStr = "";

    function setPlaybackProgress(pct) {
        const safePct = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
        const hiddenPercent = Math.max(0, Math.min(100, (1 - safePct) * 100));
        domService.el.progLine.style.clipPath = `inset(0 ${hiddenPercent}% 0 0 round 4px)`;
        domService.el.progBg.setAttribute('aria-valuenow', String(Math.round(safePct * 100)));
    }

    const reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');

    const BASIC_RENDER_INTERVAL_MS = 66;

    let renderFrameId = 0;

    let renderTimerId = 0;

    let lastBasicRenderAt = 0;

    let canvasNeedsClear = true;

    function visualEffectIsActive() {
        return !document.hidden && !reducedMotionMedia.matches && domService.el.effectSel.value !== 'none';
    }

    function syncVisualCanvasSize() {
        if (!domService.el.canvas) return;
        const active = visualEffectIsActive();
        if (domService.el.canvas.hidden === active) domService.el.canvas.hidden = !active;
        const width = active ? Math.max(1, window.innerWidth) : 1;
        const height = active ? Math.max(1, window.innerHeight) : 1;
        if (domService.el.canvas.width === width && domService.el.canvas.height === height) return;
        // Resizing clears the backing surface; restore before the next draw.
        domService.el.canvas.width = width;
        domService.el.canvas.height = height;
        canvasNeedsClear = true;
    }

    function clearVisualCanvasOnce() {
        if (!canvasNeedsClear || !domService.el.canvas.width || !domService.el.canvas.height) return;
        canvasCtx.clearRect(0, 0, domService.el.canvas.width, domService.el.canvas.height);
        window.__auroraPerf.canvasClearCount++;
        canvasNeedsClear = false;
    }

    function scheduleRender(force = false) {
        if (document.hidden) return;
        if (force) lastBasicRenderAt = 0;
        if (renderFrameId || renderTimerId) return;
        if (visualEffectIsActive() || lastBasicRenderAt === 0 || !playbackService.playbackState.isPlaying) {
            renderFrameId = requestAnimationFrame(renderFrame);
            return;
        }
        const delay = Math.max(0, BASIC_RENDER_INTERVAL_MS - (performance.now() - lastBasicRenderAt));
        if (delay <= 4) {
            renderFrameId = requestAnimationFrame(renderFrame);
            return;
        }
        renderTimerId = setTimeout(() => {
            renderTimerId = 0;
            if (!document.hidden && !renderFrameId) renderFrameId = requestAnimationFrame(renderFrame);
        }, delay);
    }

    function renderFrame(timestamp) {
        renderFrameId = 0;
        window.__auroraPerf.rafCount++;
        syncVisualCanvasSize();
        const effectActive = visualEffectIsActive();
        if (!effectActive) clearVisualCanvasOnce();
        const shouldUpdatePlayback = playbackService.playbackState.isPlaying || lastBasicRenderAt === 0;
        if (shouldUpdatePlayback && (lastBasicRenderAt === 0 || timestamp - lastBasicRenderAt >= BASIC_RENDER_INTERVAL_MS)) {
            lastBasicRenderAt = timestamp;
            updatePlaybackFrame();
        }
        if (effectActive) renderVisuals();
        if (playbackService.playbackState.isPlaying || effectActive) scheduleRender();
    }

    function updatePlaybackFrame() {
        const now = playbackService.getCurrentTime();
        const timeStr = fmtTime(now);
        // 减少毫无必要的 DOM 文本节点写入
        if (_lastTimeStr !== timeStr) {
            domService.el.currTime.textContent = timeStr;
            _lastTimeStr = timeStr;
        }
        if(playbackService.playbackState.duration) {
            setPlaybackProgress(now / playbackService.playbackState.duration);
            const nextIdx = prefetchService.getLikelyNextPlaylistIndex();
            const nextTrack = nextIdx === null ? null : queueService.playlist[nextIdx];
            const triggerSec = nextTrack?.netease
                ? prefetchService.getNeteasePrefetchTriggerSec(nextTrack)
                : prefetchService.LOCAL_PREFETCH_TRIGGER_SEC;
            // 阈值按下一首歌曲类型判断；暂停、自定义循环和单曲循环不启动下一首预取。
            if (playbackService.playbackState.isPlaying && nextTrack && !playbackService.getActiveCustomLoop()
                && (playbackService.playbackState.duration - now) <= triggerSec
                && !prefetchService.hasPreloaded && !prefetchService.prefetchAttempted) {
                prefetchService.prefetchAttempted = true; // 立即标记为已尝试，防止重复发起
                try { prefetchService.prefetchNextSong(nextIdx); } catch(e) {}
            }
        }
        // 刷新歌词高亮与居中（会做防抖判断）
        try { lyricsService.refreshLyricHighlightAndCenter(); } catch(e) {}
    }

    function updateTheme(img) {
        let theme = noCoverTheme;
        if(img) {
            try {
                const width = img.naturalWidth, height = img.naturalHeight;
                if (!width || !height) throw new Error('Cover not loaded');
                const key = coverThemeKey(img.currentSrc || img.src);
                theme = themeCache.get(key);
                if (!theme) {
                    const scale = Math.min(1, 96 / Math.max(width, height));
                    themeColorCanvas.width = Math.max(1, Math.round(width * scale));
                    themeColorCanvas.height = Math.max(1, Math.round(height * scale));
                    // ColorThief 2.4 expects image dimensions, but drawImage also accepts a canvas.
                    themeColorCanvas.naturalWidth = themeColorCanvas.width;
                    themeColorCanvas.naturalHeight = themeColorCanvas.height;
                    const context = themeColorCanvas.getContext('2d', { willReadFrequently: true });
                    context.drawImage(img, 0, 0, themeColorCanvas.width, themeColorCanvas.height);
                    const pixels = context.getImageData(0, 0, themeColorCanvas.width, themeColorCanvas.height).data;
                    theme = themeCache.set(key, buildCoverTheme(pixels, colorThief.getPalette(themeColorCanvas, 8, 1)));
                }
            } catch(e) {
                theme = noCoverTheme;
                console.warn('Cover theme extraction failed:', e?.name || 'Error');
            } finally {
                themeColorCanvas.width = themeColorCanvas.height = 1;
            }
        }
        if (theme === lastTheme) return;
        lastTheme = theme;
        theme.colors.forEach((color, index) => document.body.style.setProperty(`--bg-${index + 1}`, color));
        document.body.style.setProperty('--bg-base', theme.base);
    }

    let freqData = null;

    function renderVisuals() {
        syncVisualCanvasSize();
        const mode = domService.el.effectSel.value;
        const w = domService.el.canvas.width, h = domService.el.canvas.height;
        if (mode === 'none' || reducedMotionMedia.matches || document.hidden) {
            clearVisualCanvasOnce();
            return;
        }
        canvasCtx.clearRect(0,0,w,h);
        window.__auroraPerf.canvasClearCount++;
        canvasNeedsClear = false;

        // 复用 Uint8Array 减少垃圾回收压力
        if (!freqData || freqData.length !== playbackService.analyser.frequencyBinCount) {
            freqData = new Uint8Array(playbackService.analyser.frequencyBinCount);
        }
        playbackService.analyser.getByteFrequencyData(freqData);
        let data = freqData;

        if(mode==='bars') { const bw=(w/data.length)*2.5; let x=0; for(let i=0;i<data.length;i++){ const H=data[i]*1.5; canvasCtx.fillStyle=`rgba(255,255,255,0.3)`; canvasCtx.fillRect(x,h-H/2,bw,H/2); x+=bw+1; } }
        else if(mode==='snow') {
            // 自适应雪花数量并保持左右均匀分布
            const maxParticles = Math.max(60, Math.floor(w / 8));
            while (particles.length < maxParticles) {
                particles.push({ x: Math.random() * w, y: Math.random() * -h, r: Math.random() * 3 + 1, s: Math.random() * 2 + 0.5 });
            }
            const bass = (data && data[10]) ? data[10] : 0;
            canvasCtx.fillStyle = "rgba(255,255,255,0.9)";
            for (let i = 0; i < particles.length; i++) {
                const p = particles[i];
                // 垂直移动，受低频影响但幅度较小
                p.y += p.s * (1 + (bass / 256) * 0.8);
                // 温和水平漂移并加随机抖动，避免偏向一侧
                p.x += Math.sin(p.y * 0.01) * 0.5 + (Math.random() - 0.5) * 0.3;
                // 越界处理：从顶部随机X重置，保持整体均匀
                if (p.y > h) {
                    p.y = -Math.random() * 20;
                    p.x = Math.random() * w;
                }
                if (p.x < -50 || p.x > w + 50) {
                    p.x = Math.random() * w;
                }
                canvasCtx.beginPath();
                canvasCtx.arc(p.x, p.y, Math.max(1, p.r), 0, Math.PI * 2);
                canvasCtx.fill();
            }
        } else if(mode==='waves') {
            canvasCtx.beginPath(); canvasCtx.moveTo(0,h/2);
            // 将 performance.now() 提至循环外，防止高频调用引发额外开销
            const time = performance.now() / 1000;
            for(let i=0;i<data.length;i++){ canvasCtx.lineTo((i/data.length)*w, h/2+Math.sin(i*0.1+time)*data[i]+Math.cos(i*0.05)*50); }
            canvasCtx.strokeStyle="rgba(255,255,255,0.4)"; canvasCtx.lineWidth=2; canvasCtx.stroke();
        }
    }

    let initialized = false;
    return {
        get _lastTimeStr() { return _lastTimeStr; },
        set _lastTimeStr(value) { _lastTimeStr = value; },
        setPlaybackProgress,
        scheduleRender,
        updateTheme,
        initialize() {
            if (initialized) return;
            initialized = true;
            window.__auroraPerf = window.__auroraPerf || { rafCount: 0, canvasClearCount: 0 };

            domService.el.effectSel.addEventListener('change', () => {
                syncVisualCanvasSize();
                canvasNeedsClear = true;
                scheduleRender(true);
            });

            reducedMotionMedia.addEventListener?.('change', () => {
                syncVisualCanvasSize();
                canvasNeedsClear = true;
                scheduleRender(true);
            });

            document.addEventListener('visibilitychange', () => {
                syncVisualCanvasSize();
                if (document.hidden) {
                    if (renderFrameId) cancelAnimationFrame(renderFrameId);
                    if (renderTimerId) clearTimeout(renderTimerId);
                    renderFrameId = 0;
                    renderTimerId = 0;
                } else {
                    canvasNeedsClear = true;
                    scheduleRender(true);
                }
            });

            scheduleRender(true);

            window.addEventListener('resize', () => {
                if(domService.el.canvas) {
                    syncVisualCanvasSize();
                    scheduleRender(true);
                }
            });

            if(domService.el.canvas) {
                syncVisualCanvasSize();
            }

            updateTheme(null);
        }
    };
}
