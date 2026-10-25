const MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

function bytesOf(buffer) {
    return buffer instanceof ArrayBuffer ? new Uint8Array(buffer)
        : ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array();
}

export function mp3AudioOffset(buffer) {
    const bytes = bytesOf(buffer);
    if (bytes.length < 10) return null;
    if (bytes[0] !== 73 || bytes[1] !== 68 || bytes[2] !== 51) return 0;
    if (bytes[3] < 2 || bytes[3] > 4 || bytes.slice(6, 10).some(value => value > 127)) return null;
    return 10 + bytes[6] * 2097152 + bytes[7] * 16384 + bytes[8] * 128 + bytes[9]
        + (bytes[3] === 4 && (bytes[5] & 16) ? 10 : 0);
}

export function parseMp3StreamInfo(buffer) {
    const bytes = bytesOf(buffer), start = mp3AudioOffset(bytes);
    if (start === null || start >= bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ascii = (offset, text) => offset + text.length <= bytes.length
        && [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
    const frameAt = offset => {
        if (offset + 4 > bytes.length || bytes[offset] !== 255 || (bytes[offset + 1] & 224) !== 224) return null;
        const version = (bytes[offset + 1] >> 3) & 3, layer = (bytes[offset + 1] >> 1) & 3;
        const rateIndex = bytes[offset + 2] >> 4, sampleIndex = (bytes[offset + 2] >> 2) & 3;
        if (version === 1 || layer !== 1 || !rateIndex || rateIndex === 15 || sampleIndex === 3) return null;
        const bitrateKbps = (version === 3 ? MPEG1 : MPEG2)[rateIndex];
        const sampleRate = [44100, 48000, 32000][sampleIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
        return { offset, version, sampleRate, bitrateKbps, samples: version === 3 ? 1152 : 576,
            length: Math.floor((version === 3 ? 144000 : 72000) * bitrateKbps / sampleRate) + ((bytes[offset + 2] >> 1) & 1),
            channels: bytes[offset + 3] >> 6 === 3 ? 1 : 2, crc: bytes[offset + 1] & 1 ? 0 : 2 };
    };
    for (let offset = start; offset < Math.min(bytes.length - 4, start + 4096); offset++) {
        const first = frameAt(offset);
        if (!first) continue;
        const second = frameAt(offset + first.length);
        if (!second || first.version !== second.version || first.sampleRate !== second.sampleRate) continue;
        const side = first.version === 3 ? (first.channels === 1 ? 17 : 32) : (first.channels === 1 ? 9 : 17);
        const tag = offset + 4 + first.crc + side;
        const info = { sampleRate: first.sampleRate, channels: first.channels };
        const average = (frames, size) => {
            const bitrateKbps = size * 8 * first.sampleRate / (frames * first.samples) / 1000;
            return frames > 0 && size > 0 && bitrateKbps >= 8 && bitrateKbps <= 640 ? Math.round(bitrateKbps) : null;
        };
        if (ascii(tag, 'Xing') || ascii(tag, 'Info')) {
            if (tag + 8 > bytes.length) return null;
            const flags = view.getUint32(tag + 4);
            let cursor = tag + 8, frames = 0, size = 0;
            if (flags & 1) { if (cursor + 4 > bytes.length) return null; frames = view.getUint32(cursor); cursor += 4; }
            if (flags & 2) { if (cursor + 4 > bytes.length) return null; size = view.getUint32(cursor); }
            if (ascii(tag, 'Info') && first.bitrateKbps === second.bitrateKbps) {
                return { ...info, bitrateKbps: first.bitrateKbps, mode: 'CBR' };
            }
            return { ...info, bitrateKbps: average(frames, size), mode: 'VBR' };
        }
        const vbri = offset + 36;
        if (ascii(vbri, 'VBRI') && vbri + 18 <= bytes.length) {
            return { ...info, bitrateKbps: average(view.getUint32(vbri + 14), view.getUint32(vbri + 10)), mode: 'VBR' };
        }
        // Equal initial frames alone do not establish a constant bitrate for the entire file.
        return first.bitrateKbps !== second.bitrateKbps ? { ...info, bitrateKbps: null, mode: 'VBR' } : null;
    }
    return null;
}

export async function readMp3StreamInfo(readRange, { header = null, totalBytes = 0 } = {}) {
    header ||= await readRange(0);
    if (!header) return null;
    const offset = mp3AudioOffset(header);
    if (offset === null) return null;
    const initial = parseMp3StreamInfo(header);
    if (initial) return initial;
    if (offset > 0) {
        if (offset > 64 * 1024 * 1024 || totalBytes > 0 && offset >= totalBytes) return null;
        header = await readRange(offset);
    }
    return header ? parseMp3StreamInfo(header) : null;
}
