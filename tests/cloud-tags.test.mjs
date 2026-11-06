import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { CLOUD_AUDIO_LIMITS, hashCloudAudio, prepareCloudAudio } from '../src/audio/cloud-tags.js';
import { mp3AudioOffset } from '../src/audio/mp3.js';
import { parseFlacTagsFromArrayBuffer } from '../src/audio/quality.js';
import { mp3Fixture } from './helpers/mp3.mjs';

const encoder = new TextEncoder();
const text = value => encoder.encode(value);
const join = (...parts) => new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))));
const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());
const finalText = { song: 'New song', artist: 'New artist', album: 'New album' };
const audio = new Uint8Array(mp3Fixture());
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9GQAAAAASUVORK5CYII=', 'base64'));
const jpeg = Uint8Array.of(255, 216, 255, 224, 0, 2, 255, 217);

function number(value, little = false) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, little);
    return bytes;
}

function sync(value) { return Uint8Array.of(value >>> 21 & 127, value >>> 14 & 127, value >>> 7 & 127, value & 127); }
function unsync(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
        out.push(bytes[i]);
        if (bytes[i] === 255 && (i + 1 === bytes.length || bytes[i + 1] === 0 || bytes[i + 1] >= 224)) out.push(0);
    }
    return Uint8Array.from(out);
}

function frame(id, data, version = 4, flags = 0, status = 0) {
    if (version === 2) return join(text(id), number(data.length).subarray(1), data);
    return join(text(id), version === 4 ? sync(data.length) : number(data.length), [status, flags], data);
}

function id3(frames, version = 4, { flags = 0, prefix = new Uint8Array(), padding = 0 } = {}) {
    let body = join(prefix, ...frames, new Uint8Array(padding));
    if (version < 4 && flags & 128) body = unsync(body);
    const header = join(text('ID3'), [version, 0, flags], sync(body.length));
    return join(header, body, ...(version === 4 && flags & 16 ? [join(text('3DI'), header.subarray(3))] : []));
}

function idText(value, encoding = 3, bigEndian = false) {
    if (encoding === 0) return join([0], Uint8Array.from([...value].map(ch => ch.charCodeAt(0))));
    if (encoding === 3) return join([3], text(value));
    const bytes = new Uint8Array(value.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), !bigEndian);
    return join([encoding], ...(encoding === 1 ? [bigEndian ? [254, 255] : [255, 254]] : []), bytes);
}

function apic(data = png, type = 'image/png', pictureType = 3, version = 4) {
    const media = version === 2 ? text(type === 'image/png' ? 'PNG' : 'JPG') : join(text(type), [0]);
    return frame(version === 2 ? 'PIC' : 'APIC', join([0], media, [pictureType, 0], data), version);
}

function rawFrames(bytes) {
    const version = bytes[3], end = mp3AudioOffset(bytes), result = [];
    for (let pos = 10; pos < end;) {
        const headerSize = version === 2 ? 6 : 10;
        const id = Buffer.from(bytes.subarray(pos, pos + (version === 2 ? 3 : 4))).toString('ascii');
        const size = version === 2 ? bytes[pos + 3] * 65536 + bytes[pos + 4] * 256 + bytes[pos + 5]
            : version === 4 ? bytes[pos + 4] * 2097152 + bytes[pos + 5] * 16384 + bytes[pos + 6] * 128 + bytes[pos + 7]
                : new DataView(bytes.buffer, bytes.byteOffset).getUint32(pos + 4);
        result.push({ id, raw: bytes.slice(pos, pos + headerSize + size), payload: bytes.slice(pos + headerSize, pos + headerSize + size) });
        pos += headerSize + size;
    }
    return result;
}

function block(type, payload, last = false) { return join([type | (last ? 128 : 0)], number(payload.length).subarray(1), payload); }
const flacAudio = Uint8Array.of(255, 248, 105, 24, 0, 15, 0, 2, 1, 7, 3, 255, 0, 20, 11, 13);

function flac(extra = [], { frames = flacAudio, sampleRate = 48000, bits = 24, samples = 1000 } = {}) {
    const stream = new Uint8Array(34), view = new DataView(stream.buffer);
    view.setUint16(0, 16); view.setUint16(2, 4096);
    const packed = BigInt(sampleRate) << 44n | 1n << 41n | BigInt(bits - 1) << 36n | BigInt(samples);
    view.setBigUint64(10, packed);
    stream.fill(0x5a, 18); // A distinct PCM digest must not be confused with the whole-file MD5.
    const blocks = [{ type: 0, bytes: stream }, ...extra];
    return join(text('fLaC'), ...blocks.map((item, i) => block(item.type, item.bytes, i === blocks.length - 1)), frames);
}

function comments(entries, vendor = 'fixture vendor') {
    const encoded = entries.map(text), rawVendor = text(vendor);
    return { type: 4, bytes: join(number(rawVendor.length, true), rawVendor, number(encoded.length, true), ...encoded.flatMap(raw => [number(raw.length, true), raw])) };
}

function picture(data = png, type = 'image/png', front = true) {
    const media = text(type), description = text('Original art');
    return { type: 6, bytes: join(number(front ? 3 : 4), number(media.length), media, number(description.length), description, number(1), number(1), number(24), number(0), number(data.length), data) };
}

function flacParts(bytes) {
    const blocks = [];
    let pos = 4, last = false;
    while (!last) {
        const type = bytes[pos] & 127;
        last = !!(bytes[pos] & 128);
        const size = bytes[pos + 1] * 65536 + bytes[pos + 2] * 256 + bytes[pos + 3];
        blocks.push({ type, bytes: bytes.slice(pos + 4, pos + 4 + size), last });
        pos += 4 + size;
    }
    return { blocks, frames: bytes.slice(pos), offset: pos };
}

async function assertHash(result) {
    const bytes = await bytesOf(result.blob);
    assert.equal(result.md5, createHash('md5').update(bytes).digest('hex'));
    assert.match(result.md5, /^[a-f0-9]{32}$/);
    return bytes;
}

test('bare MP3 fills tags/art, hashes final bytes, preserves every audio byte, and is idempotent', async () => {
    const source = new Blob([audio], { type: 'application/octet-stream' });
    const supplied = { song: '\u591c\u7a7a \ud83c\udfb5', artist: 'Bj\u00f6rk / \u6b4c\u624b', album: 'Cafe\u0301', cover: png, coverType: 'image/png' };
    const result = await prepareCloudAudio(source, supplied);
    assert.deepEqual(result.metadata, { song: supplied.song, artist: supplied.artist, album: supplied.album });
    assert.equal(result.type, 'mp3'); assert.equal(result.bitrate, 192000); assert.equal(result.sampleRate, 44100);
    assert.equal(result.bitsPerSample, undefined); assert.deepEqual(result.conflicts, []);
    const bytes = await assertHash(result);
    assert.deepEqual(bytes.subarray(mp3AudioOffset(bytes)), audio);
    assert.notEqual(result.md5, createHash('md5').update(audio).digest('hex'));
    assert.deepEqual(rawFrames(bytes).find(item => item.id === 'APIC').raw, apic());
    assert.deepEqual(await bytesOf(source), audio);
    const again = await prepareCloudAudio(result.blob, supplied);
    assert.equal(again.blob, result.blob); assert.equal(again.md5, result.md5); assert.deepEqual(again.metadata, result.metadata);
});

test('ID3v2.2/2.3/2.4 preserve existing identity/art/opaque frames and fill only missing tags', async () => {
    for (const version of [2, 3, 4]) {
        const title = frame(version === 2 ? 'TT2' : 'TIT2', idText('Original \u66f2\u540d', 1), version);
        const artist = frame(version === 2 ? 'TP1' : 'TPE1', idText('Original Artist', 0), version);
        const art = apic(png, 'image/png', 3, version);
        const opaque = frame(version === 2 ? 'UFI' : 'PRIV', Uint8Array.of(1, 2, 3, 4), version);
        const source = join(id3([title, artist, art, opaque], version, { padding: 20 }), audio);
        const result = await prepareCloudAudio(new Blob([source]), { ...finalText, cover: jpeg, coverType: 'image/jpeg' });
        assert.deepEqual(result.metadata, { song: 'Original \u66f2\u540d', artist: 'Original Artist', album: finalText.album });
        assert.equal(result.conflicts.length, 2);
        assert.ok(result.conflicts.every(value => typeof value === 'string' && /冲突：已有值/.test(value) && /已保留已有值/.test(value)));
        const bytes = await assertHash(result), frames = rawFrames(bytes);
        assert.equal(bytes[3], version);
        for (const raw of [title, artist, art, opaque]) assert.ok(frames.some(item => Buffer.from(item.raw).equals(Buffer.from(raw))));
        assert.deepEqual(bytes.subarray(mp3AudioOffset(bytes)), audio);
        assert.equal(frames.filter(item => ['APIC', 'PIC'].includes(item.id)).length, 1);
        assert.equal((await prepareCloudAudio(result.blob, {})).blob, result.blob);
    }
});

test('ID3 UTF-16BE, Latin-1 and NFC comparisons preserve actual text without spurious conflicts', async () => {
    const source = new Blob([id3([
        frame('TIT2', idText('Cafe\u0301', 1, true)),
        frame('TPE1', idText('Bj\u00f6rk', 0)), frame('TALB', idText('\u5c08\u8f2f', 2, true))
    ]), audio]);
    const result = await prepareCloudAudio(source, { song: 'Caf\u00e9', artist: 'Bj\u00f6rk', album: 'Other' });
    assert.equal(result.blob, source);
    assert.deepEqual(result.metadata, { song: 'Cafe\u0301', artist: 'Bj\u00f6rk', album: '\u5c08\u8f2f' });
    assert.deepEqual(result.conflicts, []);
    await assertHash(result);
});

test('empty ID3 identity frames are replaced, but unrelated/back-cover frames remain byte-identical', async () => {
    const back = apic(png, 'image/png', 4), opaque = frame('TXXX', join([3], text('key\0value')));
    const source = new Blob([id3([frame('TIT2', idText('  ')), frame('TPE1', idText('')), back, opaque]), audio]);
    const result = await prepareCloudAudio(source, { ...finalText, cover: jpeg });
    const bytes = await assertHash(result), frames = rawFrames(bytes);
    assert.equal(frames.filter(item => item.id === 'TIT2').length, 1);
    assert.equal(frames.filter(item => item.id === 'TPE1').length, 1);
    assert.ok(frames.some(item => Buffer.from(item.raw).equals(Buffer.from(back))));
    assert.ok(frames.some(item => Buffer.from(item.raw).equals(Buffer.from(opaque))));
    assert.equal(frames.filter(item => item.id === 'APIC').length, 2);
    assert.deepEqual((await prepareCloudAudio(result.blob, {})).metadata, finalText);
});

test('ID3v1 fallback is preserved and reflected in final ID3v2 metadata and conflicts', async () => {
    const v1 = new Uint8Array(128); v1.set(text('TAG'));
    v1.set(text('Legacy title'), 3); v1.set(text('Legacy artist'), 33); v1.set(text('Legacy album'), 63);
    const result = await prepareCloudAudio(new Blob([audio, v1]), finalText);
    assert.deepEqual(result.metadata, { song: 'Legacy title', artist: 'Legacy artist', album: 'Legacy album' });
    assert.equal(result.conflicts.length, 2);
    const bytes = await assertHash(result);
    assert.deepEqual(bytes.subarray(mp3AudioOffset(bytes)), join(audio, v1));
    assert.deepEqual((await prepareCloudAudio(result.blob, {})).metadata, result.metadata);
});

test('tag-level v2.3 and frame-level v2.4 unsynchronisation retain art and logical text', async () => {
    const art = join(jpeg.subarray(0, 4), [255, 0, 255, 225], jpeg.subarray(4));
    for (const version of [3, 4]) {
        const titlePayload = idText('Old\u00ff\u00e1', 0);
        const picPayload = apic(art, 'image/jpeg').subarray(10);
        const frames = version === 3 ? [frame('TIT2', titlePayload, 3), frame('APIC', picPayload, 3)]
            : [frame('TIT2', join(sync(titlePayload.length), unsync(titlePayload)), 4, 3), frame('APIC', unsync(picPayload), 4, 2)];
        const source = new Blob([id3(frames, version, { flags: version === 3 ? 128 : 0 }), audio]);
        const result = await prepareCloudAudio(source, finalText), bytes = await assertHash(result);
        assert.equal(result.metadata.song, 'Old\u00ff\u00e1');
        assert.deepEqual(bytes.subarray(mp3AudioOffset(bytes)), audio);
        const again = await prepareCloudAudio(result.blob, { ...result.metadata, cover: png });
        assert.equal(again.blob, result.blob);
    }
});

test('ID3 grouping/DLI and v2.4 global unsynchronisation preserve original frames and new tags', async () => {
    for (const version of [3, 4]) {
        const payload = idText('Grouped title', 0);
        const grouped = frame('TIT2', join([7], ...(version === 4 ? [sync(payload.length)] : []), payload), version, version === 4 ? 65 : 32);
        const result = await prepareCloudAudio(new Blob([id3([grouped], version), audio]), finalText);
        assert.equal(result.metadata.song, 'Grouped title');
        assert.deepEqual(rawFrames(await assertHash(result)).find(item => item.id === 'TIT2').raw, grouped);
    }
    const title = frame('TIT2', unsync(idText('Title\u00ff\u00e1', 0)), 4, 2);
    const result = await prepareCloudAudio(new Blob([id3([title], 4, { flags: 128 }), audio]), { ...finalText, cover: jpeg });
    const bytes = await assertHash(result);
    assert.equal(bytes[5] & 128, 128);
    assert.deepEqual(bytes.subarray(mp3AudioOffset(bytes)), audio);
    assert.equal((await prepareCloudAudio(result.blob, {})).blob, result.blob);
});

test('complete single-frame MP3 and plain CBR without a rate tag are accepted without invented bitrate', async () => {
    const untagged = new Uint8Array(mp3Fixture({ tag: '' }));
    for (const data of [untagged, untagged.subarray(0, 626)]) {
        const result = await prepareCloudAudio(new Blob([data]), finalText);
        assert.equal(result.bitrate, undefined); assert.equal(result.sampleRate, 44100);
        const bytes = await assertHash(result);
        assert.deepEqual(bytes.subarray(mp3AudioOffset(bytes)), data);
    }
    const vbr = await prepareCloudAudio(new Blob([mp3Fixture({ tag: 'Xing', bitrate: 320 })]), finalText);
    assert.equal(vbr.bitrate, Math.round(60000 * 8 * 44100 / (100 * 1152) / 1000) * 1000);
});

test('ID3 extended headers and v2.4 footers are handled without stale CRC or audio displacement', async () => {
    for (const version of [3, 4]) {
        const prefix = version === 3 ? join(number(10), [128, 0], number(0), number(0x12345678))
            : join(sync(12), [1, 32, 5, 0, 0, 0, 0, 0]);
        const tag = id3([frame('TIT2', idText('Kept', version === 3 ? 1 : 3), version)], version, { flags: version === 4 ? 80 : 64, prefix });
        const source = new Blob([tag, audio]);
        const unchanged = await prepareCloudAudio(source, { song: 'Kept' });
        assert.equal(unchanged.blob, source);
        const result = await prepareCloudAudio(source, finalText), bytes = await assertHash(result);
        assert.equal(bytes[5] & 80, 0);
        assert.equal(result.metadata.song, 'Kept');
        assert.deepEqual(bytes.subarray(mp3AudioOffset(bytes)), audio);
    }
});

test('opaque compressed frames survive; compressed/encrypted identity tags fail safely', async () => {
    const opaque = frame('PRIV', Uint8Array.of(1, 2, 3), 4, 8);
    const result = await prepareCloudAudio(new Blob([id3([opaque]), audio]), finalText);
    assert.deepEqual(rawFrames(await bytesOf(result.blob)).find(item => item.id === 'PRIV').raw, opaque);
    for (const [version, flag] of [[3, 128], [3, 64], [4, 8], [4, 4]]) {
        const source = new Blob([id3([frame('TIT2', idText('Unknown'), version, flag)], version), audio]);
        await assert.rejects(prepareCloudAudio(source, finalText), { code: 'UNSUPPORTED_AUDIO' });
    }
});

test('FLAC fills Vorbis/PICTURE, preserves STREAMINFO PCM digest and audio bytes, hashes entire final file', async () => {
    const source = flac([{ type: 1, bytes: new Uint8Array(20) }, { type: 2, bytes: text('APP1opaque') }]);
    const result = await prepareCloudAudio(new Blob([source]), { ...finalText, song: '\u97f3\u697d \ud83c\udfb5', cover: png, coverType: 'image/png' });
    assert.equal(result.type, 'flac'); assert.equal(result.sampleRate, 48000); assert.equal(result.bitsPerSample, 24);
    assert.equal(result.bitrate, flacAudio.length * 8 * 48000 / 1000);
    const bytes = await assertHash(result), parts = flacParts(bytes), original = flacParts(source);
    assert.deepEqual(parts.frames, original.frames);
    assert.deepEqual(parts.blocks.slice(0, 3).map(item => item.bytes), original.blocks.map(item => item.bytes));
    assert.equal(parts.blocks.filter(item => item.last).length, 1);
    assert.equal(parts.blocks.at(-1).last, true);
    const tags = parseFlacTagsFromArrayBuffer(bytes.buffer, CLOUD_AUDIO_LIMITS.cover, () => {});
    assert.equal(tags.title, '\u97f3\u697d \ud83c\udfb5'); assert.equal(tags.artist, finalText.artist); assert.equal(tags.album, finalText.album);
    assert.deepEqual(tags.picture.data, png);
    assert.notEqual(result.md5, '5a'.repeat(16));
    const again = await prepareCloudAudio(result.blob, result.metadata);
    assert.equal(again.blob, result.blob); assert.equal(again.md5, result.md5);
});

test('FLAC preserves existing text/front art, vendor, unknown comments/blocks and fills empty album', async () => {
    const comment = comments(['title=Original \u66f2', 'ARTIST=Original artist', 'ALBUM=  ', 'REPLAYGAIN_TRACK_GAIN=-1.0 dB', 'LYRICS=\u6b4c\u8a5e'], 'Original \u30d9\u30f3\u30c0\u30fc');
    const art = picture(), back = picture(jpeg, 'image/jpeg', false), app = { type: 2, bytes: text('TESToriginal') };
    const source = flac([comment, art, back, app]);
    const result = await prepareCloudAudio(new Blob([source]), { ...finalText, cover: jpeg });
    assert.deepEqual(result.metadata, { song: 'Original \u66f2', artist: 'Original artist', album: finalText.album });
    assert.equal(result.conflicts.length, 2);
    const bytes = await assertHash(result), parts = flacParts(bytes);
    assert.deepEqual(parts.frames, flacAudio);
    assert.deepEqual(parts.blocks.filter(item => item.type === 6).map(item => item.bytes), [art.bytes, back.bytes]);
    assert.deepEqual(parts.blocks.find(item => item.type === 2).bytes, app.bytes);
    const commentText = Buffer.from(parts.blocks.find(item => item.type === 4).bytes).toString('utf8');
    for (const str of ['Original \u30d9\u30f3\u30c0\u30fc', 'REPLAYGAIN_TRACK_GAIN=-1.0 dB', 'LYRICS=\u6b4c\u8a5e', 'title=Original \u66f2']) assert.ok(commentText.includes(str));
    assert.ok(!commentText.includes('ALBUM=  '));
    assert.equal(parseFlacTagsFromArrayBuffer(bytes.buffer, undefined, () => {}).album, finalText.album);
});

test('FLAC duplicate artist comments preserve all values; nonfront art does not suppress new front art', async () => {
    const back = picture(png, 'image/png', false);
    const source = new Blob([flac([comments(['TITLE=Title', 'ARTIST=One', 'artist=Two', 'ALBUM=Existing']), back])]);
    const result = await prepareCloudAudio(source, { song: 'Title', artist: 'One / Two', cover: jpeg });
    assert.deepEqual(result.metadata, { song: 'Title', artist: 'One / Two', album: 'Existing' });
    assert.deepEqual(result.conflicts, []);
    const parts = flacParts(await assertHash(result));
    assert.equal(parts.blocks.filter(item => item.type === 6).length, 2);
    assert.deepEqual(parts.blocks.find(item => item.type === 6).bytes, back.bytes);
});

test('existing front art above 1 MiB remains untouched; the new-art cap does not shrink originals', async () => {
    const large = new Uint8Array(CLOUD_AUDIO_LIMITS.cover + 100); large.set(png);
    for (const source of [join(id3([apic(large)]), audio), flac([picture(large)])]) {
        const result = await prepareCloudAudio(new Blob([source]), { ...finalText, cover: jpeg });
        const bytes = await assertHash(result);
        if (result.type === 'mp3') assert.deepEqual(rawFrames(bytes).find(item => item.id === 'APIC').raw, apic(large));
        else assert.deepEqual(flacParts(bytes).blocks.find(item => item.type === 6).bytes, picture(large).bytes);
    }
});

test('less common embedded front art and linked covers are kept without network access', async () => {
    for (const [data, type] of [[text('BMoriginal bitmap bytes'), 'image/bmp'], [text('https://invalid.test/cover.png'), '-->']]) {
        const art = apic(data, type);
        const mp3 = await prepareCloudAudio(new Blob([id3([art]), audio]), { ...finalText, cover: png });
        const frames = rawFrames(await assertHash(mp3)).filter(item => item.id === 'APIC');
        assert.equal(frames.length, 1); assert.deepEqual(frames[0].raw, art);
        const originalPicture = picture(data, type);
        const result = await prepareCloudAudio(new Blob([flac([originalPicture])]), { ...finalText, cover: png });
        const pictures = flacParts(await assertHash(result)).blocks.filter(item => item.type === 6);
        assert.equal(pictures.length, 1); assert.deepEqual(pictures[0].bytes, originalPicture.bytes);
    }
});

test('exact new-cover/text limits and typed-array subviews are accepted without including adjacent bytes', async () => {
    const maximum = new Uint8Array(CLOUD_AUDIO_LIMITS.cover); maximum.set(png);
    const surrounding = join([1, 2, 3], png, [4, 5, 6]);
    for (const cover of [maximum, surrounding.subarray(3, surrounding.length - 3)]) {
        const result = await prepareCloudAudio(new Blob([audio]), { song: 'x'.repeat(CLOUD_AUDIO_LIMITS.text), cover });
        assert.equal(result.metadata.song.length, CLOUD_AUDIO_LIMITS.text);
        const bytes = await assertHash(result);
        const frame = rawFrames(bytes).find(item => item.id === 'APIC');
        assert.deepEqual(frame.payload.subarray(frame.payload.length - cover.length), cover);
        assert.equal((await prepareCloudAudio(result.blob, {})).blob, result.blob);
    }
});

test('metadata validation bounds text/art, guards Unicode and MIME, and never mutates source or input', async () => {
    const source = new Blob([audio]), original = await bytesOf(source);
    for (const bad of [null, 'x', { song: 1 }, { artist: 'a\0b' }, { song: '\ud800' }, { cover: [1, 2] }, { cover: new Uint8Array() }, { cover: text('not image') }, { cover: png, coverType: 'image/jpeg' }]) {
        await assert.rejects(prepareCloudAudio(source, bad), { code: 'INVALID_METADATA' });
    }
    for (const bad of [{ song: 'x'.repeat(CLOUD_AUDIO_LIMITS.text + 1) }, { cover: new Uint8Array(CLOUD_AUDIO_LIMITS.cover + 1) }]) {
        await assert.rejects(prepareCloudAudio(source, bad), { code: 'METADATA_LIMIT' });
    }
    const cover = png.slice(), supplied = Object.freeze({ ...finalText, cover });
    const result = await prepareCloudAudio(source, supplied);
    assert.deepEqual(supplied, { ...finalText, cover: png });
    assert.deepEqual(await bytesOf(source), original);
    assert.deepEqual(result.metadata, finalText);
    assert.equal(Object.hasOwn(result.metadata, 'cover'), false);
    await assert.rejects(prepareCloudAudio(source, {}, { onProgress: 'not callable' }), { code: 'INVALID_METADATA' });
    await assert.rejects(prepareCloudAudio(audio, {}), { code: 'INVALID_AUDIO' });
});

test('worker-facing validation, unsupported-format, limit, truncation and cancellation messages are localized', async () => {
    const cases = [
        [audio, {}, 'INVALID_AUDIO', /音频必须是 Blob/],
        [new Blob([audio]), { song: 1 }, 'INVALID_METADATA', /曲名元数据无效/],
        [new Blob([audio]), { artist: '\ud800' }, 'INVALID_METADATA', /歌手含有无效 Unicode/],
        [new Blob([audio]), { album: 'x'.repeat(CLOUD_AUDIO_LIMITS.text + 1) }, 'METADATA_LIMIT', /专辑元数据超过/],
        [new Blob([text('RIFF....WAVE')]), {}, 'UNSUPPORTED_AUDIO', /仅支持 MP3 和原生 FLAC/],
        [new Blob([audio.subarray(0, 100)]), {}, 'INVALID_AUDIO', /MP3 音频帧不完整/]
    ];
    for (const [source, metadata, code, message] of cases) {
        await assert.rejects(prepareCloudAudio(source, metadata), error => {
            assert.equal(error.code, code); assert.match(error.message, message);
            return true;
        });
    }
    const controller = new AbortController(); controller.abort();
    await assert.rejects(prepareCloudAudio(new Blob([audio]), {}, { signal: controller.signal }), { name: 'AbortError', message: '音频准备已取消' });
});

test('bounded human-readable conflicts sanitize control/bidi data without changing final metadata', async () => {
    const title = 'a'.repeat(400) + '\u202e\nunsafe';
    const source = new Blob([id3([frame('TIT2', idText(title)), frame('TPE1', idText('Original artist'))]), audio]);
    const result = await prepareCloudAudio(source, { ...finalText, song: 'b'.repeat(400) });
    assert.equal(result.metadata.song, title);
    assert.equal(result.conflicts.length, 2);
    for (const conflict of result.conflicts) { assert.ok(conflict.length < 260); assert.doesNotMatch(conflict, /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/); }
});

test('unsupported formats reject based on bytes, not file name or claimed MIME', async () => {
    for (const data of [text('RIFF....WAVE'), text('OggSxxxx'), text('....ftypM4A '), text('fLa'), new Uint8Array(), new Uint8Array(50)]) {
        const source = new Blob([data], { type: 'audio/mp3' });
        await assert.rejects(prepareCloudAudio(source, finalText), { code: 'UNSUPPORTED_AUDIO' });
        assert.deepEqual(await bytesOf(source), data);
    }
});

test('every truncated ID3 metadata prefix and incomplete MP3 frame rejects without touching source', async () => {
    const tag = id3([frame('TIT2', idText('Original')), apic()]);
    const source = join(tag, audio);
    for (let size = 0; size < tag.length + 4; size++) await assert.rejects(prepareCloudAudio(new Blob([source.subarray(0, size)]), finalText));
    for (const size of [audio.length - 1, audio.length - 3, 4, 20, 625]) await assert.rejects(prepareCloudAudio(new Blob([audio.subarray(0, size)]), finalText));
    const noAudio = new Blob([tag]);
    await assert.rejects(prepareCloudAudio(noAudio, finalText), { code: 'INVALID_AUDIO' });
    assert.deepEqual(await bytesOf(noAudio), tag);
});

test('ID3 malformed sizes, identifiers, flags, padding, UTF, APIC and footer fail closed', async () => {
    const sources = [];
    const valid = join(id3([frame('TIT2', idText('Original'))]), audio);
    for (const [index, value] of [[3, 5], [4, 1], [5, 1], [6, 255], [10, 1], [14, 127], [18, 1], [19, 128], [20, 99]]) {
        const bad = valid.slice(); bad[index] = value; sources.push(bad);
    }
    sources.push(join(id3([frame('TIT2', Uint8Array.of(3, 0xc3, 0x28))]), audio));
    sources.push(join(id3([frame('TIT2', Uint8Array.of(1, 0, 1))]), audio));
    sources.push(join(id3([frame('APIC', Uint8Array.of(0, 1, 2, 3))]), audio));
    sources.push(join(id3([frame('TIT2', Uint8Array.of(3), 4, 1)]), audio));
    sources.push(join(id3([frame('TIT2', new Uint8Array())]), audio));
    sources.push(join(id3([new Uint8Array(1), Uint8Array.of(1)]), audio));
    const footer = join(id3([frame('TIT2', idText('Original'))], 4, { flags: 16 }), audio); footer[mp3AudioOffset(footer) - 10] = 0; sources.push(footer);
    const huge = join(text('ID3'), [4, 0, 0], sync(CLOUD_AUDIO_LIMITS.metadata), audio); sources.push(huge);
    for (const source of sources) await assert.rejects(prepareCloudAudio(new Blob([source]), finalText));
});

test('FLAC truncation at all metadata offsets, missing audio, invalid block order and nested lengths reject', async () => {
    const valid = flac([comments(['TITLE=Original']), picture()]);
    const end = flacParts(valid).offset;
    for (let size = 0; size < end + 6; size++) await assert.rejects(prepareCloudAudio(new Blob([valid.subarray(0, size)]), finalText));
    const sources = [join(text('fLaC'), block(4, comments(['TITLE=A']).bytes, true), flacAudio), flac([{ type: 0, bytes: new Uint8Array(34) }]), flac([{ type: 127, bytes: text('bad') }]), flac([comments(['TITLE=A']), comments(['ARTIST=B'])])];
    const huge = valid.slice(); huge.set([255, 255, 255], 5); sources.push(huge);
    const badRate = valid.slice(); badRate.fill(0, 18, 21); sources.push(badRate);
    for (const payload of [join(number(1000, true), [0]), join(number(0, true), number(10001, true)), join(number(0, true), number(1, true), number(1000, true)), join(comments(['TITLE=A']).bytes, [1]), comments(['NOT_A_COMMENT']).bytes, comments(['=EMPTY']).bytes]) sources.push(flac([{ type: 4, bytes: payload }]));
    for (const offset of [4, 8 + text('image/png').length, picture().bytes.length - png.length - 4]) {
        const pic = picture().bytes.slice(); pic.set(number(0xffffffff), offset); sources.push(flac([{ type: 6, bytes: pic }]));
    }
    sources.push(flac([{ type: 6, bytes: join(picture().bytes, [1]) }]));
    for (const source of sources) await assert.rejects(prepareCloudAudio(new Blob([source]), finalText));
});

test('metadata entry/block caps reject hostile counts and final growth beyond budget', async () => {
    const empty = frame('TXXX', Uint8Array.of(3));
    await assert.rejects(prepareCloudAudio(new Blob([id3(Array(CLOUD_AUDIO_LIMITS.entries + 1).fill(empty)), audio]), finalText), { code: 'METADATA_LIMIT' });
    const excessive = Array.from({ length: CLOUD_AUDIO_LIMITS.blocks }, () => ({ type: 1, bytes: new Uint8Array() }));
    await assert.rejects(prepareCloudAudio(new Blob([flac(excessive)]), finalText), { code: 'METADATA_LIMIT' });
    const nearLimit = CLOUD_AUDIO_LIMITS.metadata - 42 - 4;
    await assert.rejects(prepareCloudAudio(new Blob([flac([{ type: 1, bytes: new Uint8Array(nearLimit) }])]), { ...finalText, cover: png }), { code: 'METADATA_LIMIT' });
    const manyArtists = ['ARTIST=' + 'x'.repeat(40000), 'ARTIST=' + 'y'.repeat(40000)];
    await assert.rejects(prepareCloudAudio(new Blob([flac([comments(manyArtists)])]), finalText), { code: 'METADATA_LIMIT' });
    const fullId3 = id3(Array(CLOUD_AUDIO_LIMITS.entries).fill(empty));
    await assert.rejects(prepareCloudAudio(new Blob([fullId3, audio]), finalText), { code: 'METADATA_LIMIT' });
});

test('large source MP3 validation remains chunked and preserves frames across chunk boundaries', async () => {
    const reads = [], data = join(...Array(1200).fill(audio));
    class TrackedBlob extends Blob {
        slice(start, end) {
            const part = super.slice(start, end), load = part.arrayBuffer.bind(part);
            part.arrayBuffer = () => { reads.push([start, end ?? this.size]); return load(); };
            return part;
        }
        arrayBuffer() { throw new Error('Source audio must never be read in one allocation'); }
    }
    const result = await prepareCloudAudio(new TrackedBlob([data]), finalText);
    const bytes = await assertHash(result);
    assert.deepEqual(bytes.subarray(mp3AudioOffset(bytes)), data);
    assert.ok(reads.every(([start, end]) => end - start <= CLOUD_AUDIO_LIMITS.chunk));
    assert.ok(reads.filter(([start]) => start > 0).length >= 3);
});

test('known MD5 vectors, binary data and chunk boundaries match independent node:crypto hashes', async () => {
    for (const data of [new Uint8Array(), text('abc'), text('The quick brown fox jumps over the lazy dog'), Uint8Array.from({ length: 256 }, (_, i) => i)]) {
        const digest = await hashCloudAudio(new Blob([data]));
        assert.equal(digest, createHash('md5').update(data).digest('hex'));
    }
    for (const size of [55, 56, 63, 64, 65, CLOUD_AUDIO_LIMITS.chunk - 1, CLOUD_AUDIO_LIMITS.chunk, CLOUD_AUDIO_LIMITS.chunk + 1, CLOUD_AUDIO_LIMITS.chunk * 3 + 17]) {
        const data = Uint8Array.from({ length: size }, (_, i) => (i * 31 + i >>> 8) & 255);
        const reads = [];
        class TrackedBlob extends Blob {
            slice(start, end) { reads.push([start, end]); return super.slice(start, end); }
            arrayBuffer() { throw new Error('Whole-file arrayBuffer must not be used'); }
        }
        const events = [], digest = await hashCloudAudio(new TrackedBlob([data]), { onProgress: event => events.push(event) });
        assert.equal(digest, createHash('md5').update(data).digest('hex'));
        assert.equal(reads.length, Math.ceil(size / CLOUD_AUDIO_LIMITS.chunk));
        assert.ok(reads.every(([start, end]) => end - start <= CLOUD_AUDIO_LIMITS.chunk));
        assert.deepEqual(events[0], { phase: 'hash', loaded: 0, total: size });
        assert.deepEqual(events.at(-1), { phase: 'hash', loaded: size, total: size });
        assert.ok(events.every((event, i) => !i || event.loaded > events[i - 1].loaded));
    }
});

test('progress reports metadata completion before hashing the final bytes', async () => {
    const events = [];
    const result = await prepareCloudAudio(new Blob([audio]), finalText, { onProgress: event => events.push(event) });
    assert.deepEqual(events.slice(0, 2), [{ phase: 'metadata', loaded: 0, total: 1 }, { phase: 'metadata', loaded: 1, total: 1 }]);
    assert.deepEqual(events[2], { phase: 'hash', loaded: 0, total: result.blob.size });
    assert.deepEqual(events.at(-1), { phase: 'hash', loaded: result.blob.size, total: result.blob.size });
});

test('abort before start, during metadata, on metadata completion and during final hashing rejects', async () => {
    const source = new Blob([audio]);
    const cancelled = new AbortController(); cancelled.abort('cancel');
    await assert.rejects(prepareCloudAudio(source, finalText, { signal: cancelled.signal }), { name: 'AbortError' });
    for (const stop of [event => event.phase === 'metadata' && event.loaded === 0, event => event.phase === 'metadata' && event.loaded === 1, event => event.phase === 'hash' && event.loaded === 0, event => event.phase === 'hash' && event.loaded > 0]) {
        const controller = new AbortController(), events = [];
        await assert.rejects(prepareCloudAudio(source, finalText, { signal: controller.signal, onProgress: event => { events.push(event); if (stop(event)) controller.abort(); } }), { name: 'AbortError' });
        assert.ok(stop(events.at(-1)));
    }
    assert.deepEqual(await bytesOf(source), audio);
});

test('abort interrupts a pending Blob read, removes listeners, and rejects late read completion safely', async () => {
    const controller = new AbortController();
    let finish, adds = 0, removes = 0;
    const originalAdd = controller.signal.addEventListener.bind(controller.signal), originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => { adds++; return originalAdd(...args); };
    controller.signal.removeEventListener = (...args) => { removes++; return originalRemove(...args); };
    class SlowBlob extends Blob {
        slice() { return { arrayBuffer: () => new Promise(resolve => { finish = resolve; }) }; }
    }
    const promise = prepareCloudAudio(new SlowBlob([audio]), finalText, { signal: controller.signal });
    controller.abort();
    await assert.rejects(promise, { name: 'AbortError' });
    assert.equal(adds, removes); assert.equal(adds, 1);
    finish(new ArrayBuffer(10));
    await new Promise(resolve => setTimeout(resolve, 0));
});

test('hash yields task turns, so timer cancellation stops before reading the next chunk', async () => {
    const controller = new AbortController(), reads = [];
    class TrackedBlob extends Blob {
        slice(start, end) { reads.push([start, end]); return super.slice(start, end); }
    }
    const source = new TrackedBlob([new Uint8Array(CLOUD_AUDIO_LIMITS.chunk * 4)]);
    await assert.rejects(hashCloudAudio(source, { signal: controller.signal, onProgress: event => {
        if (event.loaded > 0) setTimeout(() => controller.abort(), 0);
    } }), { name: 'AbortError' });
    assert.equal(reads.length, 1);
});

test('large metadata parsing yields for cancellation before hashing starts', async () => {
    const opaque = frame('TXXX', Uint8Array.of(3)), events = [];
    const source = new Blob([id3(Array(1000).fill(opaque)), audio]);
    const controller = new AbortController();
    await assert.rejects(prepareCloudAudio(source, finalText, { signal: controller.signal, onProgress: event => {
        events.push(event);
        if (event.phase === 'metadata' && !event.loaded) setTimeout(() => controller.abort(), 0);
    } }), { name: 'AbortError' });
    assert.deepEqual(events, [{ phase: 'metadata', loaded: 0, total: 1 }]);
});

test('Blob read failures and progress errors propagate, and source remains unchanged', async () => {
    class BrokenBlob extends Blob { slice() { return { arrayBuffer: async () => { throw new Error('Disk read failed'); } }; } }
    await assert.rejects(prepareCloudAudio(new BrokenBlob([audio]), finalText), /Disk read failed/);
    await assert.rejects(prepareCloudAudio(new Blob([audio]), finalText, { onProgress: () => { throw new Error('Progress failed'); } }), /Progress failed/);
});

test('module and MIT vendor run in a worker without DOM, network, native crypto, or leaked globals', async () => {
    const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        global.fetch = () => { throw new Error('Network is forbidden'); };
        (async () => {
            const { prepareCloudAudio } = await import(workerData.url);
            const result = await prepareCloudAudio(new Blob([workerData.audio]), workerData.metadata);
            parentPort.postMessage({ type: result.type, md5: result.md5, metadata: result.metadata,
                bytes: new Uint8Array(await result.blob.arrayBuffer()), leaked: 'md5' in globalThis });
        })().catch(error => { throw error; });
    `, { eval: true, workerData: { url: new URL('../src/audio/cloud-tags.js', import.meta.url).href, audio, metadata: finalText } });
    try {
        const result = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); worker.once('exit', code => { if (code) reject(new Error(`Worker exited ${code}`)); }); });
        assert.equal(result.type, 'mp3'); assert.deepEqual(result.metadata, finalText); assert.equal(result.leaked, false);
        assert.equal(result.md5, createHash('md5').update(result.bytes).digest('hex'));
    } finally { await worker.terminate(); }
});
