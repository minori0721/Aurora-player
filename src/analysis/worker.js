import { findBestMatchByMode } from './algorithms.js';

let currentAudioId = null;
let currentBuffer = null;

self.onmessage = (event) => {
    const message = event.data || {};
    if (message.type === 'release') {
        currentAudioId = null;
        currentBuffer = null;
        return;
    }
    if (message.type !== 'analyze') return;

    try {
        if (message.audioId !== currentAudioId || message.dataBuffer) {
            if (!message.dataBuffer) throw new Error('Worker audio data missing');
            const data = new Float32Array(message.dataBuffer);
            currentAudioId = message.audioId;
            currentBuffer = {
                sampleRate: message.sampleRate,
                numberOfChannels: 1,
                getChannelData: () => data
            };
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
