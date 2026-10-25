import { findBestMatchByMode, releaseAnalysisBuffer } from './algorithms.js';
import { restoreLoopAnalysisInput } from './input.js';

let currentAudioId = null;
let currentBuffer = null;
let currentWindowKey = null;

self.onmessage = (event) => {
    const message = event.data || {};
    if (message.type === 'release') {
        if (currentBuffer) releaseAnalysisBuffer(currentBuffer);
        currentAudioId = null;
        currentBuffer = null;
        currentWindowKey = null;
        return;
    }
    if (message.type !== 'analyze') return;

    try {
        if (message.audioId !== currentAudioId || message.windowKey !== currentWindowKey || message.channelBuffers) {
            if (!message.channelBuffers || message.layout?.key !== message.windowKey) throw new Error('Worker audio data missing');
            const input = restoreLoopAnalysisInput(message.layout, message.channelBuffers.map(data => new Float32Array(data)));
            if (currentBuffer) releaseAnalysisBuffer(currentBuffer);
            currentAudioId = message.audioId;
            currentWindowKey = message.windowKey;
            currentBuffer = input;
        }

        if (!currentBuffer) throw new Error('Worker audio data missing');
        const result = findBestMatchByMode(currentBuffer, message.timeA, message.timeB, message.mode);
        self.postMessage({ jobId: message.jobId, ok: true, audioId: currentAudioId, result });
    } catch (error) {
        self.postMessage({
            jobId: message.jobId,
            ok: false,
            audioId: currentAudioId || message.audioId,
            error: error && error.message ? error.message : String(error)
        });
    }
};
