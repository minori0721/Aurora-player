export function createCloudPreparation(source) {
    return function prepare(blob, metadata, { signal, onProgress = () => {} } = {}) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(new DOMException('已取消', 'AbortError'));
            const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            let worker;
            const finish = (error, result) => {
                worker?.terminate();
                URL.revokeObjectURL(url);
                signal?.removeEventListener('abort', abort);
                error ? reject(error) : resolve(result);
            };
            const abort = () => finish(new DOMException('已取消', 'AbortError'));
            try {
                worker = new Worker(url);
                signal?.addEventListener('abort', abort, { once: true });
                worker.onmessage = ({ data }) => {
                    if (data.progress) onProgress(data.progress);
                    else if (data.error) finish(new Error(data.error));
                    else finish(null, data.result);
                };
                worker.onerror = () => finish(new Error('音频信息处理失败，请重试'));
                worker.postMessage({ blob, metadata });
            } catch (_) { finish(new Error('浏览器无法启动音频信息处理，请使用设备下载')); }
        });
    };
}
