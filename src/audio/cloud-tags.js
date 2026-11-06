import md5 from '../vendor/md5-0.8.3.mjs';
import { parseMp3StreamInfo } from './mp3.js';
import { parseFlacStreamInfoFromBuffer } from './quality.js';

export const CLOUD_AUDIO_LIMITS = Object.freeze({
    cover: 1024 * 1024, metadata: 16 * 1024 * 1024, text: 64 * 1024,
    entries: 10000, blocks: 1024, chunk: 1024 * 1024
});
const utf8 = new TextEncoder();
const fields = ['song', 'artist', 'album'];
const fieldLabels = { song: '曲名', artist: '歌手', album: '专辑' };
const ids = { song: 'TIT2', artist: 'TPE1', album: 'TALB' };
const oldIds = { song: 'TT2', artist: 'TP1', album: 'TAL' };
const commentKeys = { TITLE: 'song', ARTIST: 'artist', ALBUM: 'album' };

function fail(message, code = 'INVALID_AUDIO') {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function ensure(bytes, offset, size) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > bytes.length) {
        fail('音频元数据不完整');
    }
}

function ascii(bytes, offset = 0, length = bytes.length - offset) {
    ensure(bytes, offset, length);
    let result = '';
    for (let i = offset; i < offset + length; i++) result += String.fromCharCode(bytes[i]);
    return result;
}

function matches(bytes, offset, text) {
    return offset + text.length <= bytes.length && [...text].every((ch, i) => bytes[offset + i] === ch.charCodeAt(0));
}

function u32(bytes, offset, little = false) {
    ensure(bytes, offset, 4);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, little);
}

function word(value, little = false) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, little);
    return bytes;
}

function synchsafe(bytes, offset) {
    ensure(bytes, offset, 4);
    let value = 0;
    for (let i = offset; i < offset + 4; i++) {
        if (bytes[i] & 128) fail('ID3 同步安全长度无效');
        value = value * 128 + bytes[i];
    }
    return value;
}

function syncWord(value) {
    return Uint8Array.of((value >>> 21) & 127, (value >>> 14) & 127, (value >>> 7) & 127, value & 127);
}

function concat(parts) {
    const size = parts.reduce((sum, part) => sum + part.length, 0);
    if (size > CLOUD_AUDIO_LIMITS.metadata) fail('音频元数据超过 16 MiB 上限', 'METADATA_LIMIT');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
}

function decode(bytes, encoding = 'utf-8') {
    try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
    catch (_) { fail('音频元数据的文本编码无效'); }
}

function nonempty(value) { return value.trim() !== ''; }
function comparable(value) { return value.trim().normalize('NFC'); }

function imageType(bytes) {
    if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (bytes.length >= 24 && matches(bytes, 1, 'PNG\r\n\x1a\n') && bytes[0] === 137 && matches(bytes, 12, 'IHDR')) return 'image/png';
    if (bytes.length >= 10 && (matches(bytes, 0, 'GIF87a') || matches(bytes, 0, 'GIF89a'))) return 'image/gif';
    if (bytes.length >= 12 && matches(bytes, 0, 'RIFF') && matches(bytes, 8, 'WEBP')) return 'image/webp';
    return '';
}

function mime(value) {
    value = value.toLowerCase();
    return value === 'image/jpg' ? 'image/jpeg' : value;
}

function existingCover(type, bytes) {
    if (!bytes.length) return false;
    if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(type)) return imageType(bytes) === type;
    // Preserve other embedded image formats and linked covers without fetching them.
    return type === '-->' || /^image\/[a-z0-9.+-]+$/.test(type);
}

function requestedMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') fail('元数据必须是对象', 'INVALID_METADATA');
    const result = {};
    for (const field of fields) {
        const value = metadata[field] ?? '';
        if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) fail(`${fieldLabels[field]}元数据无效`, 'INVALID_METADATA');
        const encoded = utf8.encode(value);
        if (encoded.length > CLOUD_AUDIO_LIMITS.text) fail(`${fieldLabels[field]}元数据超过 64 KiB 上限`, 'METADATA_LIMIT');
        if (decode(encoded) !== value) fail(`${fieldLabels[field]}含有无效 Unicode 字符`, 'INVALID_METADATA');
        result[field] = value.trim();
    }
    if (metadata.cover !== undefined) {
        if (!(metadata.cover instanceof Uint8Array) || !metadata.cover.length) fail('封面必须是非空 Uint8Array 字节数组', 'INVALID_METADATA');
        if (metadata.cover.length > CLOUD_AUDIO_LIMITS.cover) fail('新封面超过 1 MiB 上限', 'METADATA_LIMIT');
        result.cover = metadata.cover.slice();
        result.coverType = imageType(result.cover);
        if (!result.coverType || metadata.coverType !== undefined && (typeof metadata.coverType !== 'string' || mime(metadata.coverType) !== result.coverType)) {
            fail('封面图像无效或 MIME 类型不匹配', 'INVALID_METADATA');
        }
    }
    return result;
}

function addValue(found, field, value) {
    const size = utf8.encode(value).length;
    if (size > CLOUD_AUDIO_LIMITS.text) fail('已有文本超过 64 KiB 上限', 'METADATA_LIMIT');
    if (!nonempty(value)) return;
    const key = comparable(value);
    if (found.seen[field].has(key)) return;
    const total = found.sizes[field] + (found[field].length ? 3 : 0) + size;
    if (total > CLOUD_AUDIO_LIMITS.text) fail('已有文本合计超过 64 KiB 上限', 'METADATA_LIMIT');
    found.seen[field].add(key);
    found.sizes[field] = total;
    found[field].push(value);
}

function emptyValues() {
    return { song: [], artist: [], album: [], sizes: { song: 0, artist: 0, album: 0 },
        seen: { song: new Set(), artist: new Set(), album: new Set() } };
}

function resolveMetadata(found, requested) {
    const metadata = {}, conflicts = [];
    const brief = value => {
        const safe = value.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, ' ');
        const chars = [...safe];
        return chars.length > 80 ? chars.slice(0, 77).join('') + '...' : safe;
    };
    for (const field of fields) {
        metadata[field] = found[field].length ? found[field].join(' / ') : requested[field];
        if (field !== 'album' && requested[field] && found[field].length && comparable(metadata[field]) !== comparable(requested[field])) {
            conflicts.push(`${fieldLabels[field]}冲突：已有值“${brief(metadata[field])}”，传入值“${brief(requested[field])}”；已保留已有值。`);
        }
    }
    return { metadata, conflicts };
}

function checkAbort(signal) {
    if (signal?.aborted) throw new DOMException('音频准备已取消', 'AbortError');
}

function yieldTask() { return new Promise(resolve => setTimeout(resolve, 0)); }

async function read(blob, start, size, signal) {
    checkAbort(signal);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 || start + size > blob.size) fail('音频文件不完整');
    let abort;
    const pending = blob.slice(start, start + size).arrayBuffer();
    try {
        const buffer = signal ? await Promise.race([pending, new Promise((_, reject) => {
            abort = () => reject(new DOMException('音频准备已取消', 'AbortError'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
        })]) : await pending;
        checkAbort(signal);
        if (buffer.byteLength !== size) fail('读取的音频数据不完整');
        return new Uint8Array(buffer);
    } finally { if (abort) signal.removeEventListener('abort', abort); }
}

function report(onProgress, phase, loaded, total, signal) {
    onProgress?.({ phase, loaded, total });
    checkAbort(signal);
}

/** Lowercase whole-file MD5; bounded 1 MiB reads, usable without DOM/Node APIs. */
export async function hashCloudAudio(blob, { signal, onProgress } = {}) {
    checkAbort(signal);
    const hash = md5.create();
    report(onProgress, 'hash', 0, blob.size, signal);
    for (let offset = 0; offset < blob.size;) {
        const size = Math.min(CLOUD_AUDIO_LIMITS.chunk, blob.size - offset);
        hash.update(await read(blob, offset, size, signal));
        offset += size;
        report(onProgress, 'hash', offset, blob.size, signal);
        // Yield a task so an inlined worker can receive its cancellation message.
        await yieldTask();
        checkAbort(signal);
    }
    return hash.hex();
}

function deunsync(bytes) {
    const out = new Uint8Array(bytes.length);
    let length = 0;
    for (let i = 0; i < bytes.length; i++) {
        out[length++] = bytes[i];
        if (bytes[i] === 255 && bytes[i + 1] === 0) i++;
    }
    return out.subarray(0, length);
}

function unsync(bytes) {
    let extra = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 255 && (i + 1 === bytes.length || bytes[i + 1] === 0 || bytes[i + 1] >= 224)) extra++;
    if (!extra) return bytes;
    if (bytes.length + extra > CLOUD_AUDIO_LIMITS.metadata) fail('ID3 元数据超过 16 MiB 上限', 'METADATA_LIMIT');
    const out = new Uint8Array(bytes.length + extra);
    let pos = 0;
    for (let i = 0; i < bytes.length; i++) {
        out[pos++] = bytes[i];
        if (bytes[i] === 255 && (i + 1 === bytes.length || bytes[i + 1] === 0 || bytes[i + 1] >= 224)) out[pos++] = 0;
    }
    return out;
}

function id3String(bytes, encoding) {
    if (encoding === 0) return ascii(bytes);
    if (encoding === 3) return decode(bytes);
    if (encoding !== 1 && encoding !== 2) fail('不支持此 ID3 文本编码', 'UNSUPPORTED_AUDIO');
    if (bytes.length % 2) fail('ID3 UTF-16 文本不完整');
    if (!bytes.length) return '';
    if (encoding === 2) return decode(bytes, 'utf-16be');
    if (bytes.length < 2 || !(bytes[0] === 255 && bytes[1] === 254 || bytes[0] === 254 && bytes[1] === 255)) fail('ID3 UTF-16 文本缺少字节顺序标记');
    return decode(bytes.subarray(2), bytes[0] === 255 ? 'utf-16le' : 'utf-16be');
}

function terminated(bytes, start, encoding = 0) {
    const step = encoding === 1 || encoding === 2 ? 2 : 1;
    for (let i = start; i + step <= bytes.length; i += step) {
        if (bytes[i] === 0 && (step === 1 || bytes[i + 1] === 0)) return i;
    }
    fail('ID3 图像字段缺少结束标记');
}

function id3Picture(payload, version) {
    ensure(payload, 0, version === 2 ? 5 : 4);
    const encoding = payload[0];
    if (encoding > 3) fail('不支持此 ID3 图像字段编码', 'UNSUPPORTED_AUDIO');
    let pos, type;
    if (version === 2) {
        const format = ascii(payload, 1, 3);
        type = { JPG: 'image/jpeg', PNG: 'image/png', GIF: 'image/gif' }[format]
            || (format === '-->' ? '-->' : /^[A-Z0-9]{3}$/.test(format) ? `image/${format.toLowerCase()}` : '');
        pos = 4;
    } else {
        pos = terminated(payload, 1);
        type = mime(ascii(payload, 1, pos - 1));
        pos++;
    }
    ensure(payload, pos, 1);
    const front = payload[pos++] === 3;
    const end = terminated(payload, pos, encoding);
    id3String(payload.subarray(pos, end), encoding);
    pos = end + (encoding === 1 || encoding === 2 ? 2 : 1);
    return { front, valid: front && existingCover(type, payload.subarray(pos)) };
}

function framePayload(raw, version, tagFlags) {
    const flags = version === 2 ? 0 : raw[9];
    if (version === 3 && flags & 192 || version === 4 && flags & 12) fail('无法安全编辑已压缩或加密的 ID3 曲目信息或封面', 'UNSUPPORTED_AUDIO');
    let payload = raw.subarray(version === 2 ? 6 : 10);
    if (version === 4 && (flags & 2 || tagFlags & 128)) payload = deunsync(payload);
    let pos = (version === 3 && flags & 32 || version === 4 && flags & 64) ? 1 : 0;
    ensure(payload, 0, pos);
    if (version === 4 && flags & 1) {
        const size = synchsafe(payload, pos);
        pos += 4;
        if (size !== payload.length - pos) fail('ID3 数据长度指示值无效');
    }
    return payload.subarray(pos);
}

function extendedHeaderSize(body, version) {
    if (version === 3) {
        const size = u32(body, 0);
        if (size !== 6 && size !== 10) fail('ID3 扩展头无效');
        ensure(body, 0, size + 4);
        if (body[4] & 127 || body[5] || !!(body[4] & 128) !== (size === 10)) fail('ID3 扩展标志无效');
        return size + 4;
    }
    const size = synchsafe(body, 0);
    ensure(body, 0, size);
    if (size < 6 || body[4] !== 1 || body[5] & 143) fail('ID3 扩展头无效');
    let pos = 6;
    for (const [flag, length] of [[64, 0], [32, 5], [16, 1]]) if (body[5] & flag) {
        ensure(body, pos, length + 1);
        if (body[pos] !== length) fail('ID3 扩展数据无效');
        pos += length + 1;
    }
    if (pos !== size) fail('ID3 扩展数据长度无效');
    if (body[5] & 64) fail('不支持链式 ID3 更新标签', 'UNSUPPORTED_AUDIO');
    return size;
}

async function parseId3(blob, header, signal) {
    const found = emptyValues(), frames = [];
    if (!matches(header, 0, 'ID3')) return { found, frames, version: 4, flags: 0, end: 0, hasCover: false };
    ensure(header, 0, 10);
    const version = header[3], flags = header[5], size = synchsafe(header, 6);
    if (![2, 3, 4].includes(version) || header[4] !== 0) fail('不支持此 ID3 版本', 'UNSUPPORTED_AUDIO');
    if (flags & (version === 2 ? 63 : version === 3 ? 31 : 15)) fail('ID3 文件头标志无效');
    if (version === 2 && flags & 64) fail('不支持压缩的 ID3v2.2 标签', 'UNSUPPORTED_AUDIO');
    const footer = version === 4 && flags & 16 ? 10 : 0;
    if (size + 10 + footer > CLOUD_AUDIO_LIMITS.metadata) fail('ID3 元数据超过 16 MiB 上限', 'METADATA_LIMIT');
    let body = await read(blob, 10, size, signal);
    if (footer) {
        const tail = await read(blob, 10 + size, 10, signal);
        if (!matches(tail, 0, '3DI') || tail.slice(3).some((value, i) => value !== header[i + 3])) fail('ID3 尾部标签无效');
    }
    if (version < 4 && flags & 128) body = deunsync(body);
    let pos = version > 2 && flags & 64 ? extendedHeaderSize(body, version) : 0;
    let hasCover = false;
    const fieldIds = version === 2 ? oldIds : ids;
    while (pos < body.length) {
        if (frames.length && frames.length % 256 === 0) await yieldTask();
        checkAbort(signal);
        if (!body[pos]) {
            if (body.subarray(pos).some(Boolean)) fail('ID3 填充区包含非零数据');
            break;
        }
        if (frames.length >= CLOUD_AUDIO_LIMITS.entries) fail('ID3 标签帧数量超过上限', 'METADATA_LIMIT');
        const length = version === 2 ? 6 : 10;
        ensure(body, pos, length);
        const id = ascii(body, pos, version === 2 ? 3 : 4);
        if (!/^[A-Z0-9]+$/.test(id)) fail('ID3 标签帧标识无效');
        const size = version === 2 ? body[pos + 3] * 65536 + body[pos + 4] * 256 + body[pos + 5]
            : version === 4 ? synchsafe(body, pos + 4) : u32(body, pos + 4);
        if (!size) fail('ID3 标签帧内容为空');
        ensure(body, pos, length + size);
        const raw = body.subarray(pos, pos + length + size);
        if (version > 2 && (raw[8] & (version === 3 ? 31 : 143) || raw[9] & (version === 3 ? 31 : 176))) fail('ID3 标签帧标志无效');
        const field = fields.find(field => fieldIds[field] === id);
        const frame = { id, raw, field };
        if (field || id === (version === 2 ? 'PIC' : 'APIC')) {
            const payload = framePayload(raw, version, flags);
            if (field) {
                ensure(payload, 0, 1);
                const value = id3String(payload.subarray(1), payload[0]).replace(/\0+$/, '').split('\0').filter(nonempty).join(' / ');
                addValue(found, field, value);
            } else {
                frame.picture = id3Picture(payload, version);
                hasCover ||= frame.picture.valid;
            }
        }
        frames.push(frame);
        pos += length + size;
    }
    return { found, frames, version, flags, end: 10 + size + footer, hasCover };
}

function encodeId3Text(value, version) {
    if (version === 4) return concat([Uint8Array.of(3), utf8.encode(value)]);
    const bytes = new Uint8Array(3 + value.length * 2);
    bytes.set([1, 255, 254]);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < value.length; i++) view.setUint16(3 + i * 2, value.charCodeAt(i), true);
    return bytes;
}

function encodeFrame(id, payload, version, flags) {
    const header = new Uint8Array(version === 2 ? 6 : 10);
    header.set(utf8.encode(id));
    if (version === 4 && flags & 128) { payload = unsync(payload); header[9] = 2; }
    if (version === 2) header.set(word(payload.length).subarray(1), 3);
    else header.set(version === 4 ? syncWord(payload.length) : word(payload.length), 4);
    return concat([header, payload]);
}

function mp3Frame(bytes, offset) {
    ensure(bytes, offset, 4);
    if (bytes[offset] !== 255 || (bytes[offset + 1] & 224) !== 224) fail('MP3 音频帧无效或尾部数据不受支持');
    const version = (bytes[offset + 1] >> 3) & 3, layer = (bytes[offset + 1] >> 1) & 3;
    const rate = bytes[offset + 2] >> 4, sample = (bytes[offset + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || !rate || rate === 15 || sample === 3) fail('MPEG Layer III 帧头无效或不受支持', 'UNSUPPORTED_AUDIO');
    const rates = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const sampleRate = [44100, 48000, 32000][sample] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    return { sampleRate, length: Math.floor((version === 3 ? 144000 : 72000) * rates[rate] / sampleRate) + ((bytes[offset + 2] >> 1) & 1) };
}

async function validateMp3(blob, start, end, signal) {
    if (start >= end) fail('MP3 文件没有音频帧');
    let pos = start, sampleRate;
    while (pos < end) {
        const chunk = await read(blob, pos, Math.min(CLOUD_AUDIO_LIMITS.chunk, end - pos), signal);
        let cursor = 0;
        while (cursor + 4 <= chunk.length) {
            const frame = mp3Frame(chunk, cursor);
            sampleRate ??= frame.sampleRate;
            if (sampleRate !== frame.sampleRate) fail('不支持采样率变化的 MP3 文件', 'UNSUPPORTED_AUDIO');
            if (pos + cursor + frame.length > end) fail('MP3 音频帧不完整');
            cursor += frame.length;
            if (cursor >= chunk.length) break;
        }
        if (!cursor) fail('MP3 音频帧头不完整');
        pos += cursor;
        checkAbort(signal);
        await yieldTask();
    }
    const probe = await read(blob, start, Math.min(4096, end - start), signal);
    const info = parseMp3StreamInfo(probe);
    return { sampleRate, ...(info?.bitrateKbps ? { bitrate: info.bitrateKbps * 1000 } : {}) };
}

async function prepareMp3(blob, header, requested, signal) {
    const tag = await parseId3(blob, header, signal);
    const v2Found = Object.fromEntries(fields.map(field => [field, tag.found[field].length > 0]));
    let audioEnd = blob.size;
    if (blob.size >= 128) {
        const tail = await read(blob, blob.size - 128, 128, signal);
        if (matches(tail, 0, 'TAG')) {
            audioEnd -= 128;
            for (const [i, field] of fields.entries()) if (!v2Found[field]) {
                addValue(tag.found, field, ascii(tail, 3 + i * 30, 30).replace(/\0.*$/s, '').trimEnd());
            }
        }
    }
    const quality = await validateMp3(blob, tag.end, audioEnd, signal);
    const resolved = resolveMetadata(tag.found, requested);
    const additions = [], replaced = new Set();
    for (const field of fields) if (!v2Found[field] && resolved.metadata[field]) {
        replaced.add(field);
        additions.push(encodeFrame((tag.version === 2 ? oldIds : ids)[field], encodeId3Text(resolved.metadata[field], tag.version), tag.version, tag.flags));
    }
    const addCover = !tag.hasCover && requested.cover;
    if (addCover) {
        if (tag.version === 2 && !['image/png', 'image/jpeg', 'image/gif'].includes(requested.coverType)) fail('ID3v2.2 不支持嵌入此类封面', 'UNSUPPORTED_AUDIO');
        const type = tag.version === 2 ? utf8.encode({ 'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/gif': 'GIF' }[requested.coverType]) : concat([utf8.encode(requested.coverType), Uint8Array.of(0)]);
        additions.push(encodeFrame(tag.version === 2 ? 'PIC' : 'APIC', concat([Uint8Array.of(0), type, Uint8Array.of(3, 0), requested.cover]), tag.version, tag.flags));
    }
    if (!additions.length) return { blob, ...quality, ...resolved };
    // Keep opaque frames and their version; drop stale extended-header CRC/restrictions.
    const kept = tag.frames.filter(frame => !replaced.has(frame.field) && !(addCover && frame.picture?.front && !frame.picture.valid));
    if (kept.length + additions.length > CLOUD_AUDIO_LIMITS.entries) fail('补充后的 ID3 标签帧数量超过上限', 'METADATA_LIMIT');
    let body = concat([...kept.map(frame => frame.raw), ...additions]);
    if (tag.version < 4 && tag.flags & 128) body = unsync(body);
    if (body.length + 10 > CLOUD_AUDIO_LIMITS.metadata) fail('最终 ID3 元数据超过 16 MiB 上限', 'METADATA_LIMIT');
    const flags = tag.flags & 128;
    const newHeader = concat([utf8.encode('ID3'), Uint8Array.of(tag.version, 0, flags), syncWord(body.length)]);
    const finalBlob = new Blob([newHeader, body, blob.slice(tag.end)], { type: 'audio/mpeg' });
    return { blob: finalBlob, ...quality, ...resolved };
}

function vorbisComments(bytes, found) {
    let pos = 0;
    const take = () => { const size = u32(bytes, pos, true); pos += 4; ensure(bytes, pos, size); const part = bytes.subarray(pos, pos + size); pos += size; return part; };
    const vendor = take();
    decode(vendor);
    const count = u32(bytes, pos, true);
    pos += 4;
    if (count > CLOUD_AUDIO_LIMITS.entries) fail('FLAC 注释数量超过上限', 'METADATA_LIMIT');
    const entries = [];
    for (let i = 0; i < count; i++) {
        const raw = take(), text = decode(raw), split = text.indexOf('=');
        if (split < 1 || !/^[\x20-\x3c\x3e-\x7d]+$/.test(text.slice(0, split))) fail('FLAC 注释字段名无效');
        const field = commentKeys[text.slice(0, split).toUpperCase()];
        if (field) addValue(found, field, text.slice(split + 1));
        entries.push({ raw, field });
    }
    if (pos !== bytes.length) fail('FLAC 注释包含多余数据');
    return { vendor, entries };
}

function flacPicture(bytes) {
    const front = u32(bytes, 0) === 3;
    const mimeSize = u32(bytes, 4);
    ensure(bytes, 8, mimeSize);
    const type = mime(ascii(bytes, 8, mimeSize));
    let pos = 8 + mimeSize;
    const descriptionSize = u32(bytes, pos);
    pos += 4;
    ensure(bytes, pos, descriptionSize);
    decode(bytes.subarray(pos, pos + descriptionSize));
    pos += descriptionSize;
    ensure(bytes, pos, 20);
    const size = u32(bytes, pos + 16);
    pos += 20;
    ensure(bytes, pos, size);
    if (pos + size !== bytes.length) fail('FLAC 图像块包含多余数据');
    return { front, valid: front && existingCover(type, bytes.subarray(pos)) };
}

function flacBlock(type, bytes, last) {
    if (bytes.length > 0xffffff) fail('FLAC 元数据块长度超过 24 位上限', 'METADATA_LIMIT');
    const header = word(bytes.length);
    header[0] = type | (last ? 128 : 0);
    return [header, bytes];
}

async function prepareFlac(blob, requested, signal) {
    let pos = 4, last = false, comments, hasCover = false, stream;
    const blocks = [], found = emptyValues();
    while (!last) {
        if (blocks.length && blocks.length % 64 === 0) await yieldTask();
        checkAbort(signal);
        if (blocks.length >= CLOUD_AUDIO_LIMITS.blocks) fail('FLAC 元数据块数量超过上限', 'METADATA_LIMIT');
        const header = await read(blob, pos, 4, signal);
        const type = header[0] & 127, size = u32(header, 0) & 0xffffff;
        last = !!(header[0] & 128);
        if (pos + 4 + size > CLOUD_AUDIO_LIMITS.metadata) fail('FLAC 元数据超过 16 MiB 上限', 'METADATA_LIMIT');
        if (type === 127 || !blocks.length && type !== 0 || type === 0 && (blocks.length || size !== 34)) fail('FLAC 流信息或元数据块顺序无效');
        const bytes = await read(blob, pos + 4, size, signal);
        const block = { type, bytes };
        if (type === 0) stream = bytes;
        if (type === 4) {
            if (comments) fail('FLAC 包含重复的 Vorbis 注释块');
            comments = vorbisComments(bytes, found);
        }
        if (type === 6) { block.picture = flacPicture(bytes); hasCover ||= block.picture.valid; }
        blocks.push(block);
        pos += 4 + size;
    }
    const probe = concat([utf8.encode('fLaC'), Uint8Array.of(128, 0, 0, 34), stream]);
    const info = parseFlacStreamInfoFromBuffer(probe.buffer);
    if (!info || info.bitsPerSample > 32 || stream[0] * 256 + stream[1] < 16 || stream[2] * 256 + stream[3] < stream[0] * 256 + stream[1]) fail('FLAC 流信息无效');
    const audioHeader = await read(blob, pos, Math.min(6, blob.size - pos), signal);
    if (audioHeader.length < 6 || audioHeader[0] !== 255 || (audioHeader[1] & 254) !== 248) fail('FLAC 音频帧缺失或不完整');
    const samples = (stream[13] & 15) * 4294967296 + u32(stream, 14);
    const quality = { sampleRate: info.sampleRate, bitsPerSample: info.bitsPerSample };
    if (samples) quality.bitrate = Math.round((blob.size - pos) * 8 * info.sampleRate / samples);
    const resolved = resolveMetadata(found, requested);
    const missing = fields.filter(field => !found[field].length && resolved.metadata[field]);
    const addCover = !hasCover && requested.cover;
    if (!missing.length && !addCover) return { blob, ...quality, ...resolved };
    if (missing.length) {
        const vendor = comments?.vendor || utf8.encode('Aurora-player');
        const entries = (comments?.entries || []).filter(entry => !missing.includes(entry.field)).map(entry => entry.raw);
        for (const field of missing) entries.push(utf8.encode(`${{ song: 'TITLE', artist: 'ARTIST', album: 'ALBUM' }[field]}=${resolved.metadata[field]}`));
        if (entries.length > CLOUD_AUDIO_LIMITS.entries) fail('FLAC 注释数量超过上限', 'METADATA_LIMIT');
        const bytes = concat([word(vendor.length, true), vendor, word(entries.length, true), ...entries.flatMap(entry => [word(entry.length, true), entry])]);
        const index = blocks.findIndex(block => block.type === 4);
        if (index < 0) blocks.push({ type: 4, bytes });
        else blocks[index] = { type: 4, bytes };
    }
    if (addCover) {
        const type = utf8.encode(requested.coverType);
        const bytes = concat([word(3), word(type.length), type, word(0), new Uint8Array(16), word(requested.cover.length), requested.cover]);
        for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].picture?.front && !blocks[i].picture.valid) blocks.splice(i, 1);
        blocks.push({ type: 6, bytes });
    }
    if (blocks.length > CLOUD_AUDIO_LIMITS.blocks) fail('补充后的 FLAC 元数据块数量超过上限', 'METADATA_LIMIT');
    const prefix = concat([utf8.encode('fLaC'), ...blocks.flatMap((block, i) => flacBlock(block.type, block.bytes, i === blocks.length - 1))]);
    return { blob: new Blob([prefix, blob.slice(pos)], { type: 'audio/flac' }), ...quality, ...resolved };
}

/**
 * Fill missing MP3/FLAC tags; keep encoded audio unchanged.
 * bitrate: bits/s; sampleRate: Hz; md5: final whole-file bytes.
 * Progress: {phase: 'metadata'|'hash', loaded, total}; metadata uses 0/1.
 */
export async function prepareCloudAudio(blob, metadata, { signal, onProgress } = {}) {
    checkAbort(signal);
    if (!(blob instanceof Blob)) fail('音频必须是 Blob 对象', 'INVALID_AUDIO');
    if (onProgress !== undefined && typeof onProgress !== 'function') fail('进度回调必须是函数', 'INVALID_METADATA');
    const requested = requestedMetadata(metadata);
    report(onProgress, 'metadata', 0, 1, signal);
    const header = await read(blob, 0, Math.min(10, blob.size), signal);
    let type, prepared;
    if (matches(header, 0, 'fLaC')) {
        type = 'flac';
        prepared = await prepareFlac(blob, requested, signal);
    } else if (matches(header, 0, 'ID3') || header[0] === 255 && (header[1] & 224) === 224) {
        type = 'mp3';
        prepared = await prepareMp3(blob, header, requested, signal);
    } else fail('仅支持 MP3 和原生 FLAC 文件', 'UNSUPPORTED_AUDIO');
    report(onProgress, 'metadata', 1, 1, signal);
    const digest = await hashCloudAudio(prepared.blob, { signal, onProgress });
    checkAbort(signal);
    return { ...prepared, md5: digest, type };
}
