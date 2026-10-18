export function createTransfer({} = {}) {
    const NETEASE_URL_TIMEOUT_MS = 30_000;

    const AUDIO_HEADER_TIMEOUT_MS = 15_000;

    const AUDIO_IDLE_TIMEOUT_MS = 20_000;

    async function fetchAudioWithFallback(candidates, options = {}) {
        let lastError = null;
        for (const audioUrl of candidates) {
            try {
                const resp = await fetch(audioUrl, options);
                if (resp.ok) return { resp, audioUrl };
                try { await resp.body?.cancel?.(); } catch (_) {}
                lastError = new Error(`HTTP ${resp.status}`);
                lastError.status = resp.status;
            } catch (e) {
                if (e.name === 'AbortError') throw e;
                lastError = e;
            }
        }
        throw lastError || new Error('Audio fetch failed');
    }

    function awaitWithSignal(promise, signal) {
        if (!signal) return Promise.resolve(promise);
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                signal.removeEventListener('abort', onAbort);
                reject(signal.reason || createAbortError());
            };
            if (signal.aborted) {
                Promise.resolve(promise).catch(() => {});
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
            Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
        });
    }

    async function withRequestTimeout(parentSignal, timeoutMs, message, work) {
        const controller = new AbortController();
        const onAbort = () => controller.abort(parentSignal.reason || createAbortError());
        if (parentSignal?.aborted) onAbort();
        else parentSignal?.addEventListener('abort', onAbort, { once: true });
        const timeoutError = new Error(message);
        timeoutError.timeout = true;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(timeoutError); }, timeoutMs);
        try {
            if (controller.signal.aborted) throw controller.signal.reason || createAbortError();
            return await awaitWithSignal(work(controller.signal), controller.signal);
        } catch (error) {
            if (controller.signal.aborted) throw timedOut ? timeoutError : (controller.signal.reason || error);
            throw error;
        } finally {
            clearTimeout(timer);
            parentSignal?.removeEventListener('abort', onAbort);
        }
    }

    function createAudioTransferWatchdog(controller, options = {}) {
        const headerMs = options.headerTimeoutMs ?? AUDIO_HEADER_TIMEOUT_MS;
        const idleMs = options.idleTimeoutMs ?? AUDIO_IDLE_TIMEOUT_MS;
        const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
        let bodyStarted = false;
        let lastProgress = now();
        let timeoutError = null;
        let timer;
        const check = () => {
            if (controller.signal.aborted) return;
            const remaining = (bodyStarted ? idleMs : headerMs) - (now() - lastProgress);
            if (remaining > 0) {
                timer = setTimeout(check, remaining);
                return;
            }
            const error = new Error(bodyStarted ? '音频下载长时间没有收到数据' : '音频服务器响应超时');
            error.name = 'AbortError';
            error.code = 'AUDIO_STALLED';
            error.timeout = true;
            timeoutError = error;
            controller.abort(error);
        };
        timer = setTimeout(check, headerMs);
        const dispose = () => clearTimeout(timer);
        controller.signal.addEventListener('abort', dispose, { once: true });
        return {
            headersReceived() {
                bodyStarted = true;
                lastProgress = now();
                clearTimeout(timer);
                timer = setTimeout(check, idleMs);
            },
            progress() { lastProgress = now(); },
            getError() { return timeoutError; },
            dispose() { dispose(); controller.signal.removeEventListener('abort', dispose); }
        };
    }

    async function fetchAudioDataWithFallback(candidates, options = {}) {
        const controller = new AbortController();
        const parentSignal = options.signal;
        const onAbort = () => controller.abort(parentSignal.reason || createAbortError());
        if (parentSignal?.aborted) onAbort();
        else parentSignal?.addEventListener('abort', onAbort, { once: true });
        const watchdog = createAudioTransferWatchdog(controller, options);
        try {
            if (controller.signal.aborted) throw controller.signal.reason || createAbortError();
            const result = await awaitWithSignal(fetchAudioWithFallback(candidates, { signal: controller.signal }), controller.signal);
            watchdog.headersReceived();
            const read = await awaitWithSignal(
                readResponseArrayBufferWithLimit(result.resp, options.maxBytes ?? Infinity, controller.signal, watchdog.progress),
                controller.signal
            );
            return { ...read, audioUrl: result.audioUrl };
        } catch (error) {
            if (controller.signal.aborted) throw watchdog.getError() || controller.signal.reason || error;
            controller.abort(error);
            throw error;
        } finally {
            watchdog.dispose();
            parentSignal?.removeEventListener('abort', onAbort);
        }
    }

    function createAbortError(message = 'request aborted') {
        return new DOMException(message, 'AbortError');
    }

    async function readResponseArrayBufferWithLimit(response, maxBytes, signal, onProgress = () => {}) {
        const contentLength = Number(response.headers?.get?.('content-length') || 0);
        if (contentLength > maxBytes) {
            try { await response.body?.cancel?.(); } catch (_) {}
            return { buffer: null, tooLarge: true, byteLength: contentLength };
        }
        if (!response.body?.getReader) {
            const buffer = await response.arrayBuffer();
            if (signal?.aborted) throw signal.reason || createAbortError();
            return buffer.byteLength > maxBytes
                ? { buffer: null, tooLarge: true, byteLength: buffer.byteLength }
                : { buffer, tooLarge: false, byteLength: buffer.byteLength };
        }

        const reader = response.body.getReader();
        let total = 0;
        let tooLarge = false;
        const onAbort = () => { reader.cancel(signal.reason).catch(() => {}); };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            // Let Response assemble the body; do not retain a second JS chunk array.
            const stream = new ReadableStream({
                async pull(output) {
                    try {
                        if (signal?.aborted) throw signal.reason || createAbortError();
                        const part = await reader.read();
                        if (signal?.aborted) throw signal.reason || createAbortError();
                        if (part.done) { output.close(); return; }
                        const chunk = part.value || new Uint8Array(0);
                        total += chunk.byteLength;
                        if (total > maxBytes) {
                            tooLarge = true;
                            throw new Error('prefetch size limit');
                        }
                        if (chunk.byteLength) onProgress(total);
                        output.enqueue(chunk);
                    } catch (error) {
                        output.error(error);
                        reader.cancel(error).catch(() => {});
                    }
                },
                cancel(reason) { return reader.cancel(reason); }
            });
            const buffer = await new Response(stream).arrayBuffer();
            if (signal?.aborted) throw signal.reason || createAbortError();
            return { buffer, tooLarge: false, byteLength: total };
        } catch (error) {
            if (tooLarge) return { buffer: null, tooLarge: true, byteLength: total };
            throw error;
        } finally {
            signal?.removeEventListener('abort', onAbort);
            try { reader.releaseLock(); } catch (_) {}
        }
    }

    function abortableDelay(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                reject(new DOMException('aborted', 'AbortError'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    function fetchJsonWithStageTimeout(url, options, timeoutMs, timeoutMessage) {
        return withRequestTimeout(options.signal, timeoutMs, timeoutMessage, async signal => {
            const response = await fetch(url, { ...options, signal });
            if (!response.ok) {
                try { await response.body?.cancel?.(); } catch (_) {}
                const error = new Error(`请求失败: HTTP ${response.status}`);
                error.status = response.status;
                error.retryable = response.status === 429 || response.status >= 500;
                throw error;
            }
            return await response.json();
        });
    }

    let initialized = false;
    return {
        get NETEASE_URL_TIMEOUT_MS() { return NETEASE_URL_TIMEOUT_MS; },
        awaitWithSignal,
        withRequestTimeout,
        fetchAudioDataWithFallback,
        createAbortError,
        abortableDelay,
        fetchJsonWithStageTimeout,
        initialize() {
            if (initialized) return;
            initialized = true;

        }
    };
}
