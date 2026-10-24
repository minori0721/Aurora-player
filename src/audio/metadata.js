import { extractLyricsText } from '../lyrics/parser.js';

export function createMetadata({
    covers: coversService,
    dom: domService,
    lyrics: lyricsService
} = {}) {
    function updateMediaSession() {
        if ('mediaSession' in navigator) {
            const artworkSrc = domService.el.img.getAttribute('src');
            navigator.mediaSession.metadata = new MediaMetadata({
                title: domService.el.title.textContent,
                artist: domService.el.artist.textContent,
                artwork: artworkSrc ? [{ src: domService.el.img.src, sizes: domService.el.img.complete && domService.el.img.naturalWidth ? `${domService.el.img.naturalWidth}x${domService.el.img.naturalHeight}` : 'any', ...(coversService.mainCoverMimeType ? { type: coversService.mainCoverMimeType } : {}) }] : []
            });
        }
    }

    function applyMetadata(common, source, isCurrent = () => true, lyricSession = null) {
        if (!isCurrent()) return;
        if(common.title) domService.el.title.textContent = common.title;
        if(common.artist) domService.el.artist.textContent = common.artist;

        // 设置本地文件音质标签
        if (common.sampleRate && common.bitsPerSample) {
            // FLAC文件 - 显示位深度和采样率
            const srKhz = common.sampleRate >= 1000 ? (common.sampleRate / 1000).toFixed(common.sampleRate % 1000 === 0 ? 0 : 1) + 'kHz' : common.sampleRate + 'Hz';
            currentAudioQuality = `FLAC ${srKhz}/${common.bitsPerSample}bit`;
        } else if (common.fileSize && common.fileExt) {
            // 其他格式 - 稍后在解码完成后根据格式显示合适信息
            pendingQualityInfo = { size: common.fileSize, ext: common.fileExt };
        }
        if(common.picture && typeof common.picture === 'object' && common.picture.data && common.picture.format) {
            const data = common.picture.data;
            const format = common.picture.format;
            if(data && format) {
                const bytes = ArrayBuffer.isView(data) ? data : new Uint8Array(data);
                const url = URL.createObjectURL(new Blob([bytes], { type: format }));
                coversService.setMainCover(url, { objectUrl: true, mimeType: format, onLoad: () => {
                    if (!isCurrent()) return;
                    domService.el.img.style.opacity = 1;
                } });
            }
        } else { coversService.setMainCover(); }

        if (lyricSession) lyricsService.applyLocalLyricMetadata(lyricSession, common, source);
        else {
            const text = extractLyricsText(common.lyrics);
            if (text) lyricsService.parseAndRenderLyrics(text, source);
        }
    }

    let pendingQualityInfo = null;

    // 等待计算的音质信息（MP3等）
    let currentAudioQuality = '';

    let initialized = false;
    return {
        updateMediaSession,
        applyMetadata,
        get pendingQualityInfo() { return pendingQualityInfo; },
        set pendingQualityInfo(value) { pendingQualityInfo = value; },
        get currentAudioQuality() { return currentAudioQuality; },
        set currentAudioQuality(value) { currentAudioQuality = value; },
        initialize() {
            if (initialized) return;
            initialized = true;

        }
    };
}
