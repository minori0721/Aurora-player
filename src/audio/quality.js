function inferAudioTypeFromUrl(url, fallbackType = '') {
    const rawType = String(fallbackType || '').toLowerCase();
    const rawUrl = String(url || '').toLowerCase();
    let path = rawUrl;
    try { path = new URL(rawUrl).pathname.toLowerCase(); } catch (_) {}
    if (path.includes('.flac') || rawType === 'flac') return 'flac';
    if (path.includes('.wav') || rawType === 'wav') return 'wav';
    if (path.includes('.aiff') || path.includes('.aif') || rawType === 'aiff' || rawType === 'aif') return 'aiff';
    if (path.includes('.ogg') || rawType === 'ogg' || rawType === 'opus') return rawType === 'opus' ? 'opus' : 'ogg';
    if (path.includes('.m4a') || rawType === 'm4a') return 'm4a';
    if (path.includes('.aac') || rawType === 'aac') return 'aac';
    if (path.includes('.mp3') || rawType === 'mp3') return 'mp3';
    return rawType || 'mp3';
}

function formatSampleRate(sampleRate) {
    const sr = Number(sampleRate || 0);
    if (!sr) return '';
    return sr >= 1000 ? (sr / 1000).toFixed(sr % 1000 === 0 ? 0 : 1) + 'kHz' : sr + 'Hz';
}

function getAverageBitrateKbps(bufferOrByteLength, durationSeconds) {
    const seconds = Number(durationSeconds || 0);
    const byteLength = typeof bufferOrByteLength === 'number'
        ? bufferOrByteLength
        : Number(bufferOrByteLength?.byteLength || 0);
    if (!byteLength || seconds <= 0 || !Number.isFinite(seconds)) return null;
    return Math.round((byteLength * 8) / seconds / 1000);
}

function findAsciiSignatureOffset(buffer, signature, maxScanBytes = 65536) {
    if (!buffer || !signature) return -1;
    const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, maxScanBytes));
    const sig = Array.from(signature, ch => ch.charCodeAt(0));
    outer: for (let i = 0; i <= bytes.length - sig.length; i++) {
        for (let j = 0; j < sig.length; j++) {
            if (bytes[i + j] !== sig[j]) continue outer;
        }
        return i;
    }
    return -1;
}

function parseFlacStreamInfoFromBuffer(buffer) {
    try {
        if (!buffer || buffer.byteLength < 26) return null;
        const view = new DataView(buffer);
        const flacOffset = findAsciiSignatureOffset(buffer, 'fLaC');
        if (flacOffset < 0) return null;
        let offset = flacOffset + 4;
        let loopLimit = 0;
        while (offset + 4 <= view.byteLength && loopLimit < 100) {
            loopLimit++;
            const header = view.getUint8(offset);
            const isLast = (header & 0x80) !== 0;
            const type = header & 0x7F;
            const len = view.getUint32(offset) & 0x00FFFFFF;
            offset += 4;
            if (type === 0 && len === 34 && offset + len <= view.byteLength) {
                const byte10 = view.getUint8(offset + 10);
                const byte11 = view.getUint8(offset + 11);
                const byte12 = view.getUint8(offset + 12);
                const byte13 = view.getUint8(offset + 13);
                const sampleRate = (byte10 << 12) | (byte11 << 4) | (byte12 >> 4);
                const channels = ((byte12 & 0x0E) >> 1) + 1;
                const bitsPerSample = (((byte12 & 0x01) << 4) | (byte13 >> 4)) + 1;
                if (!sampleRate || bitsPerSample < 4) return null;
                return { sampleRate, channels, bitsPerSample };
            }
            offset += len;
            if (isLast) break;
        }
    } catch (_) {}
    return null;
}

function parseWavStreamInfoFromBuffer(buffer) {
    try {
        if (!buffer || buffer.byteLength < 44) return null;
        const view = new DataView(buffer);
        if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) return null; // RIFF/WAVE
        let offset = 12;
        let loopLimit = 0;
        while (offset + 8 <= view.byteLength && loopLimit < 100) {
            loopLimit++;
            const chunkId = view.getUint32(offset, false);
            const chunkLen = view.getUint32(offset + 4, true);
            offset += 8;
            if (chunkId === 0x666d7420 && chunkLen >= 16 && offset + 16 <= view.byteLength) { // fmt
                const channels = view.getUint16(offset + 2, true);
                const sampleRate = view.getUint32(offset + 4, true);
                const bitsPerSample = view.getUint16(offset + 14, true);
                return { sampleRate, channels, bitsPerSample };
            }
            offset += chunkLen + (chunkLen % 2);
        }
    } catch (_) {}
    return null;
}

function describeAudioQualityFromInfo(audioInfo, audioUrl = '', streamInfo = null) {
    const type = inferAudioTypeFromUrl(audioUrl || audioInfo?.url, audioInfo?.type).toUpperCase();
    const brKbps = audioInfo?.br ? Math.round(audioInfo.br / 1000) : null;
    const sampleRate = streamInfo?.sampleRate || audioInfo?.sr || null;
    const srText = formatSampleRate(sampleRate);
    let label = type;
    if (type === 'FLAC' || type === 'WAV' || type === 'AIFF') {
        if (type === 'FLAC' && srText && streamInfo?.bitsPerSample) label = `${type} ${srText}/${streamInfo.bitsPerSample}bit`;
        else if (srText) label = `${type} ${srText}`;
        else if (brKbps) label = `${type} ${brKbps}kbps`;
    } else if (brKbps) {
        label = `${type} ${brKbps}kbps`;
    }
    return { label, type, brKbps, sampleRate };
}

function createAudioQualityProbe(buffer, audioUrl, audioInfo = {}) {
    const type = inferAudioTypeFromUrl(audioUrl || audioInfo?.url, audioInfo?.type).toUpperCase();
    return {
        type,
        byteLength: Number(buffer?.byteLength || audioInfo?.size || 0),
        flacInfo: type === 'FLAC' ? parseFlacStreamInfoFromBuffer(buffer) : null,
        wavInfo: type === 'WAV' ? parseWavStreamInfoFromBuffer(buffer) : null
    };
}

function describeAudioQualityFromBuffer(buffer, audioUrl, decodedBuffer, audioInfo = {}) {
    const probe = audioInfo?._qualityProbe || null;
    const type = (probe?.type || inferAudioTypeFromUrl(audioUrl || audioInfo?.url, audioInfo?.type)).toUpperCase();
    const duration = decodedBuffer?.duration || Number(audioInfo?.time || 0) / 1000 || 0;
    const byteLength = probe?.byteLength || buffer?.byteLength || audioInfo?.size || 0;
    const averageBitrateKbps = getAverageBitrateKbps(byteLength, duration);
    const apiBitrateKbps = audioInfo?.br ? Math.round(audioInfo.br / 1000) : null;
    const bitrateKbps = averageBitrateKbps || apiBitrateKbps;
    const decodedSampleRate = decodedBuffer?.sampleRate || null;
    const channels = decodedBuffer?.numberOfChannels || null;
    const flacInfo = probe?.flacInfo || (type === 'FLAC' ? parseFlacStreamInfoFromBuffer(buffer) : null);
    const wavInfo = probe?.wavInfo || (type === 'WAV' ? parseWavStreamInfoFromBuffer(buffer) : null);
    const sourceSampleRate = flacInfo?.sampleRate || wavInfo?.sampleRate || audioInfo?.sr || null;
    const sourceChannels = flacInfo?.channels || wavInfo?.channels || null;
    const bitsPerSample = flacInfo?.bitsPerSample || wavInfo?.bitsPerSample || null;
    const srText = formatSampleRate(sourceSampleRate);
    let label = type;

    if (type === 'FLAC') {
        if (srText && bitsPerSample) label = `FLAC ${srText}/${bitsPerSample}bit`;
        else if (srText) label = `FLAC ${srText}`;
        else if (bitrateKbps) label = `FLAC ${bitrateKbps}kbps`;
    } else if (type === 'WAV') {
        if (srText && bitsPerSample) label = `WAV ${srText}/${bitsPerSample}bit`;
        else if (srText) label = `WAV ${srText}`;
        else if (bitrateKbps) label = `WAV ${bitrateKbps}kbps`;
    } else if (type === 'AIFF' || type === 'AIF') {
        label = srText ? `${type} ${srText}` : (bitrateKbps ? `${type} ${bitrateKbps}kbps` : type);
    } else if (type === 'APE' || type === 'TTA' || type === 'TAK') {
        label = srText ? `${type} ${srText}` : (bitrateKbps ? `${type} ${bitrateKbps}kbps` : type);
    } else if (bitrateKbps) {
        label = `${type} ${bitrateKbps}kbps`;
    }

    return { label, type, bitrateKbps, sampleRate: sourceSampleRate, channels: sourceChannels || channels, decodedSampleRate };
}

function parseFlacTagsFromArrayBuffer(buffer, maxPictureBytes = 12 * 1024 * 1024, onWarning = console.warn) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4) return null;
    const view = new DataView(buffer);
    const tags = {};
    const ensure = (offset, length, limit = view.byteLength) => {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > limit) {
            throw new RangeError('FLAC 元数据被截断');
        }
    };
    const readU32 = (offset, littleEndian, limit) => {
        ensure(offset, 4, limit);
        return view.getUint32(offset, littleEndian);
    };

    try {
        if (view.getUint32(0) !== 0x664C6143) return null;
        let offset = 4;
        const utf8 = new TextDecoder('utf-8');
        const ascii = new TextDecoder('ascii');

        for (let blockCount = 0; blockCount < 100; blockCount++) {
            ensure(offset, 4);
            const header = view.getUint8(offset);
            const isLast = (header & 0x80) !== 0;
            const type = header & 0x7F;
            const len = ((view.getUint8(offset + 1) << 16) | (view.getUint8(offset + 2) << 8) | view.getUint8(offset + 3)) >>> 0;
            offset += 4;
            ensure(offset, len);
            const blockEnd = offset + len;

            if (type === 0 && len >= 18) {
                ensure(offset + 10, 4, blockEnd);
                const byte10 = view.getUint8(offset + 10);
                const byte11 = view.getUint8(offset + 11);
                const byte12 = view.getUint8(offset + 12);
                const byte13 = view.getUint8(offset + 13);
                tags.sampleRate = (byte10 << 12) | (byte11 << 4) | (byte12 >> 4);
                tags.bitsPerSample = (((byte12 & 0x01) << 4) | (byte13 >> 4)) + 1;
            } else if (type === 4) {
                let pos = offset;
                const vendorLen = readU32(pos, true, blockEnd);
                pos += 4;
                ensure(pos, vendorLen, blockEnd);
                pos += vendorLen;
                const commentCount = readU32(pos, true, blockEnd);
                pos += 4;
                if (commentCount > 10000) throw new RangeError('FLAC 标签数量异常');
                for (let i = 0; i < commentCount; i++) {
                    const commentLen = readU32(pos, true, blockEnd);
                    pos += 4;
                    ensure(pos, commentLen, blockEnd);
                    const comment = utf8.decode(new Uint8Array(buffer, pos, commentLen));
                    pos += commentLen;
                    const splitAt = comment.indexOf('=');
                    if (splitAt <= 0) continue;
                    const key = comment.slice(0, splitAt).toUpperCase();
                    const value = comment.slice(splitAt + 1);
                    if (key === 'LYRICS' || key === 'UNSYNCED LYRICS') tags.lyrics = value;
                    else if (key === 'TITLE') tags.title = value;
                    else if (key === 'ARTIST') tags.artist = value;
                    else if (key === 'ALBUM') tags.album = value;
                }
            } else if (type === 6) {
                let pos = offset;
                readU32(pos, false, blockEnd);
                pos += 4;
                const mimeLen = readU32(pos, false, blockEnd);
                pos += 4;
                ensure(pos, mimeLen, blockEnd);
                const mimeType = ascii.decode(new Uint8Array(buffer, pos, mimeLen));
                pos += mimeLen;
                const descriptionLen = readU32(pos, false, blockEnd);
                pos += 4;
                ensure(pos, descriptionLen, blockEnd);
                pos += descriptionLen;
                ensure(pos, 16, blockEnd);
                pos += 16;
                const pictureLen = readU32(pos, false, blockEnd);
                pos += 4;
                ensure(pos, pictureLen, blockEnd);
                if (pictureLen > maxPictureBytes) {
                    onWarning(`已跳过 FLAC 封面：${Math.ceil(pictureLen / 1024 / 1024)}MB 超出大小上限`, 'warn');
                } else if (/^image\/(?:jpeg|png|gif|webp)$/i.test(mimeType)) {
                    tags.picture = { format: mimeType, data: new Uint8Array(buffer.slice(pos, pos + pictureLen)) };
                }
            }

            offset = blockEnd;
            if (isLast) break;
        }
    } catch (error) {
        onWarning(`已忽略损坏的 FLAC 元数据：${error.message}`, 'warn');
    }
    return Object.keys(tags).length ? tags : null;
}

export { createAudioQualityProbe, describeAudioQualityFromBuffer, describeAudioQualityFromInfo, formatSampleRate, inferAudioTypeFromUrl, parseFlacTagsFromArrayBuffer, parseFlacStreamInfoFromBuffer, parseWavStreamInfoFromBuffer };
