import { prepareCloudAudio } from './cloud-tags.js';

self.onmessage = async ({ data }) => {
    try {
        const result = await prepareCloudAudio(data.blob, data.metadata, {
            onProgress: progress => self.postMessage({ progress })
        });
        self.postMessage({ result });
    } catch (error) {
        self.postMessage({ error: error.message || '音频信息处理失败' });
    }
};
