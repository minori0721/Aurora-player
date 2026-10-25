import { findBestMatchByMode, getLoopMatchModeLabel, releaseAnalysisBuffer } from './algorithms.js';
import { createLoopAnalysisInput, describeLoopAnalysisInput } from './input.js';
import { LOOP_WORKER_SOURCE } from 'aurora:loop-worker';

export function createAnalysis({
    debug: debugService,
    dom: domService,
    loop: loopService,
    playback: playbackService,
    queue: queueService
} = {}) {
    let loopAnalysisWorker = null;

    let loopAnalysisWorkerUrl = null;

    let loopAnalysisWorkerAudioId = null;

    let loopAnalysisWorkerWindowKey = null;

    const LOOP_ANALYSIS_IDLE_MS = 60_000;

    let loopAnalysisIdleTimer = null;

    let loopAnalysisJobId = 0;

    const loopAnalysisPendingJobs = new Map();

    const loopAnalysisBufferIds = new WeakMap();

    let loopAnalysisNextBufferId = 1;

    let loopAnalysisRun = null;

    let analysisInputRevision = 0;

    let previewStopTimer = null;

    function cancelPreviewTimer() {
        if (previewStopTimer) clearTimeout(previewStopTimer);
        previewStopTimer = null;
    }

    // --- 核心：自动循环匹配算法 (周期搜索 + 联合接缝精修) ---
    function cancelLoopAnalysisRun() {
        const run = loopAnalysisRun;
        if (!run) return;
        loopAnalysisRun = null;
        run.cancelWait?.();
        resetLoopAnalysisWorkerAudio();
        domService.el.anaRun.disabled = false;
        domService.el.anaRun.textContent = run.buttonText;
        domService.el.anaMsg.textContent = '';
    }

    function invalidateAnalysisInput() {
        analysisInputRevision++;
        cancelLoopAnalysisRun();
    }

    async function runAnalysis() {
        if (domService.el.anaRun?.disabled) return;
        if (!playbackService.audioBuffer && !playbackService.isStreaming) { domService.el.anaMsg.textContent = "Please load audio first!"; return; }

        const roughA = parseFloat(domService.el.anaStart.value);
        const roughB = parseFloat(domService.el.anaEnd.value);
        if (!Number.isFinite(roughA) || !Number.isFinite(roughB) || roughA < 0 || roughB - roughA < 0.25) {
            domService.el.anaMsg.textContent = "请输入有效的 A/B 时间，区间至少 0.25 秒"; return;
        }

        const mode = domService.el.anaMode?.value || 'balanced';
        const modeLabel = getLoopMatchModeLabel(mode);
        domService.el.anaMsg.textContent = `Analyzing... (${modeLabel})`;
        domService.el.anaMsg.style.color = "var(--accent)";
        const runButtonText = domService.el.anaRun?.textContent;
        if (domService.el.anaRun) {
            domService.el.anaRun.disabled = true;
            domService.el.anaRun.textContent = "⏳ 匹配中...";
        }

        let sourceBuffer = playbackService.audioBuffer;
        let expectedAudioId = sourceBuffer ? getLoopAnalysisAudioId(sourceBuffer) : null;
        const playToken = playbackService._currentPlayActionToken;
        const inputRevision = analysisInputRevision;
        const track = queueService.playlist[queueService.curIdx] || null;
        const loopEditVersion = loopService.getLoopEditVersion(track);
        const run = { buttonText: runButtonText || "✨ 开始精确匹配", cancelWait: null, applied: false };
        loopAnalysisRun = run;
        const isCurrent = () => loopAnalysisRun === run && playbackService.isPlaybackActionCurrent(playToken)
            && inputRevision === analysisInputRevision
            && parseFloat(domService.el.anaStart.value) === roughA && parseFloat(domService.el.anaEnd.value) === roughB
            && (domService.el.anaMode?.value || 'balanced') === mode
            && (run.applied || loopService.getLoopEditVersion(track) === loopEditVersion)
            && (!sourceBuffer || sourceBuffer === playbackService.audioBuffer && expectedAudioId === getLoopAnalysisAudioId(playbackService.audioBuffer));

        try {
            if (!sourceBuffer) {
                domService.el.anaMsg.textContent = '正在准备完整音频…';
                sourceBuffer = await playbackService.ensureCompleteAudio('智能分析');
                expectedAudioId = getLoopAnalysisAudioId(sourceBuffer);
                if (!isCurrent()) return;
            }
            await new Promise(resolve => {
                const frameId = requestAnimationFrame(() => {
                    run.cancelWait = null;
                    resolve();
                });
                run.cancelWait = () => {
                    cancelAnimationFrame(frameId);
                    resolve();
                };
            });
            if (!isCurrent()) return;
            const result = await findBestMatchByModeAsync(sourceBuffer, roughA, roughB, mode);
            if (!isCurrent()) return;

            const confidence = Number.isFinite(result.confidence)
                ? result.confidence
                : Math.max(0, (1 - result.diff) * 100);
            const tookText = result.elapsedMs ? ` / ${result.elapsedMs.toFixed(0)}ms` : "";

            if (confidence >= 80) {
                loopService.applyLoop(result.start, result.end);
                run.applied = true;
                domService.el.anaMsg.textContent = `✨ 找到了! [${modeLabel}] (匹配评分: ${confidence.toFixed(1)}/100${tookText})`;
                domService.el.anaMsg.style.color = "#27ae60";
                debugService.log(`循环匹配成功 [${modeLabel}]：${result.start.toFixed(4)}s -> ${result.end.toFixed(4)}s，评分 ${confidence.toFixed(1)}/100${tookText}`, 'success');
            } else if (confidence >= 30) {
                loopService.applyLoop(result.start, result.end);
                run.applied = true;
                domService.el.anaMsg.textContent = `⚠️ 已给出候选 [${modeLabel}] (匹配评分: ${confidence.toFixed(1)}/100${tookText})，建议先试听。`;
                domService.el.anaMsg.style.color = "#f39c12";
                debugService.log(`循环候选 [${modeLabel}]：${result.start.toFixed(4)}s -> ${result.end.toFixed(4)}s，评分 ${confidence.toFixed(1)}/100${tookText}`, 'warn');
            } else {
                domService.el.anaMsg.textContent = `❌ 没有可靠接缝 [${modeLabel}] (最高评分: ${confidence.toFixed(1)}/100${tookText})，请把 A/B 粗点靠近重复段。`;
                domService.el.anaMsg.style.color = "#e74c3c";
                debugService.log(`循环匹配未找到可靠接缝 [${modeLabel}]，最高评分 ${confidence.toFixed(1)}/100${tookText}`, 'error');
            }
        } catch (e) {
            if (!isCurrent() || e?.cancelled) return;
            domService.el.anaMsg.textContent = "Error: " + e.message;
            console.error(e);
        } finally {
            if (loopAnalysisRun === run && domService.el.anaRun) {
                if (!isCurrent()) domService.el.anaMsg.textContent = '';
                loopAnalysisRun = null;
                domService.el.anaRun.disabled = false;
                domService.el.anaRun.textContent = run.buttonText;
            }
        }
    }

    function getLoopAnalysisAudioId(buffer) {
        if (!buffer) return null;
        let id = loopAnalysisBufferIds.get(buffer);
        if (!id) {
            id = loopAnalysisNextBufferId++;
            loopAnalysisBufferIds.set(buffer, id);
        }
        return id;
    }

    function clearLoopAnalysisIdleTimer() {
        if (loopAnalysisIdleTimer !== null) clearTimeout(loopAnalysisIdleTimer);
        loopAnalysisIdleTimer = null;
    }

    function scheduleLoopAnalysisIdleRelease() {
        clearLoopAnalysisIdleTimer();
        if (!loopAnalysisWorker || loopAnalysisPendingJobs.size) return;
        const worker = loopAnalysisWorker;
        loopAnalysisIdleTimer = setTimeout(() => {
            loopAnalysisIdleTimer = null;
            if (loopAnalysisWorker !== worker || loopAnalysisPendingJobs.size) return;
            resetLoopAnalysisWorkerAudio();
        }, LOOP_ANALYSIS_IDLE_MS);
    }

    function failLoopAnalysisWorker(error) {
        clearLoopAnalysisIdleTimer();
        const pending = [...loopAnalysisPendingJobs.values()];
        loopAnalysisPendingJobs.clear();
        pending.forEach(job => job.reject(error));

        if (loopAnalysisWorker) {
            try { loopAnalysisWorker.terminate(); } catch (e) {}
            loopAnalysisWorker = null;
        }
        if (loopAnalysisWorkerUrl) {
            try { URL.revokeObjectURL(loopAnalysisWorkerUrl); } catch (e) {}
            loopAnalysisWorkerUrl = null;
        }
        loopAnalysisWorkerAudioId = null;
        loopAnalysisWorkerWindowKey = null;
    }

    function resetLoopAnalysisWorkerAudio() {
        const error = new Error('Analysis cancelled');
        error.cancelled = true;
        failLoopAnalysisWorker(error);
    }

    function getLoopAnalysisWorker() {
        if (loopAnalysisWorker) return loopAnalysisWorker;
        if (!window.Worker || !window.Blob || !window.URL) {
            throw new Error('This browser does not support Web Worker analysis');
        }

        const blob = new Blob([LOOP_WORKER_SOURCE], { type: 'text/javascript' });
        loopAnalysisWorkerUrl = URL.createObjectURL(blob);
        loopAnalysisWorker = new Worker(loopAnalysisWorkerUrl);
        const worker = loopAnalysisWorker;

        worker.onmessage = (event) => {
            if (loopAnalysisWorker !== worker) return;
            const message = event.data || {};
            const job = loopAnalysisPendingJobs.get(message.jobId);
            if (!job) return;
            loopAnalysisPendingJobs.delete(message.jobId);

            if (message.ok) {
                job.resolve(message.result);
            } else {
                const error = new Error(message.error || 'Loop analysis failed');
                error.analysisError = true;
                job.reject(error);
            }
            scheduleLoopAnalysisIdleRelease();
        };

        worker.onerror = (event) => {
            if (loopAnalysisWorker !== worker) return;
            const message = event?.message || 'Loop analysis worker failed';
            const error = new Error(message);
            error.workerError = true;
            failLoopAnalysisWorker(error);
        };

        return loopAnalysisWorker;
    }

    function runLoopAnalysisInWorker(buffer, timeA, timeB, mode = 'balanced') {
        const worker = getLoopAnalysisWorker();
        clearLoopAnalysisIdleTimer();
        const audioId = getLoopAnalysisAudioId(buffer);
        const layout = describeLoopAnalysisInput(buffer, timeA, timeB);
        const jobId = ++loopAnalysisJobId;
        const message = {
            type: 'analyze',
            jobId,
            audioId,
            windowKey: layout.key,
            timeA,
            timeB,
            mode
        };
        const transfer = [];

        if (loopAnalysisWorkerAudioId !== audioId || loopAnalysisWorkerWindowKey !== layout.key) {
            const input = createLoopAnalysisInput(buffer, layout);
            message.layout = layout;
            message.channelBuffers = Array.from({ length: input.numberOfChannels }, (_, channel) => input.getChannelData(channel).buffer);
            transfer.push(...message.channelBuffers);
        }

        const promise = new Promise((resolve, reject) => {
            loopAnalysisPendingJobs.set(jobId, { resolve, reject });
        });

        try {
            worker.postMessage(message, transfer);
            if (message.channelBuffers) {
                loopAnalysisWorkerAudioId = audioId;
                loopAnalysisWorkerWindowKey = layout.key;
            }
        } catch (error) {
            loopAnalysisPendingJobs.delete(jobId);
            error.workerError = true;
            throw error;
        }

        return promise;
    }

    async function findBestMatchByModeAsync(buffer, timeA, timeB, mode = 'balanced') {
        const startedAt = performance.now();
        let result;
        try {
            result = await runLoopAnalysisInWorker(buffer, timeA, timeB, mode);
        } catch (error) {
            if (error?.cancelled) throw error;
            if (error?.analysisError) throw error;
            failLoopAnalysisWorker(error);
            debugService.log(`循环分析 Worker 不可用，回退主线程：${error.message}`, 'warn');
            try {
                result = findBestMatchByMode(buffer, timeA, timeB, mode);
            } finally {
                releaseAnalysisBuffer(buffer);
            }
        }
        return { ...result, algorithmElapsedMs: result.elapsedMs, elapsedMs: performance.now() - startedAt };
    }

    // 辅助：捕获当前播放时间
    function capturePoint(type) {
        invalidateAnalysisInput();
        const t = playbackService.getCurrentTime();
        if(type === 'a') domService.el.anaStart.value = t.toFixed(3);
        else domService.el.anaEnd.value = t.toFixed(3);
    }

    // 辅助：试听
    async function previewPoint(type) {
        const t = parseFloat(type==='a' ? domService.el.anaStart.value : domService.el.anaEnd.value);
        const duration = Number(playbackService.audioBuffer?.duration || playbackService.playbackState.duration || 0);
        if ((!playbackService.audioBuffer && !playbackService.isStreaming) || !Number.isFinite(t) || !Number.isFinite(duration) || duration <= 0 || t < 0 || t > duration) {
            domService.el.anaMsg.textContent = '请先加载音频并输入有效时间点';
            domService.el.anaMsg.style.color = 'red';
            return;
        }
        cancelPreviewTimer();
        const token = playbackService._currentPlayActionToken;
        const track = queueService.playlist[queueService.curIdx] || null;
        if (playbackService.isStreaming) {
            const version = playbackService.transportVersion;
            try {
                await playbackService.ensureCompleteAudio('循环点试听');
                if (!playbackService.isPlaybackActionCurrent(token) || version !== playbackService.transportVersion) return;
                await playbackService.activateCompleteAudio('循环点试听');
                if (!playbackService.isPlaybackActionCurrent(token)) return;
            } catch (error) {
                if (playbackService.isPlaybackActionCurrent(token)) domService.el.anaMsg.textContent = error.message;
                return;
            }
        }
        playbackService.startAudio(Math.max(0, t - 3));
        const previewSource = playbackService.sourceNode;
        const previewVersion = playbackService.transportVersion;
        const previewDurationMs = Math.max(250, Math.min(6000, (duration - Math.max(0, t - 3)) * 1000));
        previewStopTimer = setTimeout(() => {
            previewStopTimer = null;
            if (token !== playbackService._currentPlayActionToken || queueService.playlist[queueService.curIdx] !== track || playbackService.sourceNode !== previewSource || previewVersion !== playbackService.transportVersion) return;
            playbackService.playbackState.pauseTime = playbackService.getCurrentTime();
            playbackService.stopAudio('paused');
        }, previewDurationMs);
    }

    // 导出 .sli 文件
    function exportSLI() {
        if (!loopService.loopState.active || loopService.loopState.start >= loopService.loopState.end) {
            domService.el.anaMsg.textContent = "请先设置有效的循环区间呢！";
            domService.el.anaMsg.style.color = "red";
            return;
        }

        const rate = parseInt(domService.el.baseRateInput.value) || 44100;
        // SLI格式: From = 结束采样点; To = 开始采样点
        const fromSamples = Math.round(loopService.loopState.end * rate);
        const toSamples = Math.round(loopService.loopState.start * rate);

        const sliContent = `From = ${fromSamples};\nTo = ${toSamples};`;

        // 创建 Blob 并下载
        const blob = new Blob([sliContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;

        // 使用当前曲目名称
        const fileName = queueService.playlist[queueService.curIdx]?.name || 'loop';
        a.download = `${fileName}.sli`;

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        domService.el.anaMsg.textContent = `已导出: ${fileName}.sli`;
        domService.el.anaMsg.style.color = "#27ae60";
        debugService.log(`SLI 已导出：终点 From=${fromSamples}，起点 To=${toSamples}`, 'success');
    }

    let initialized = false;
    return {
        capturePoint,
        previewPoint,
        exportSLI,
        runAnalysis,
        cancelPreviewTimer,
        cancelLoopAnalysisRun,
        resetLoopAnalysisWorkerAudio,
        initialize() {
            if (initialized) return;
            initialized = true;
            for (const control of [domService.el.anaStart, domService.el.anaEnd, domService.el.anaMode,
                domService.el.loopStart, domService.el.loopEnd, domService.el.loopEnable]) {
                control.addEventListener('input', invalidateAnalysisInput);
                control.addEventListener('change', invalidateAnalysisInput);
            }
        }
    };
}
