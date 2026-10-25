import test from 'node:test';
import assert from 'node:assert/strict';
import { mp3AudioOffset, parseMp3StreamInfo, readMp3StreamInfo } from '../src/audio/mp3.js';
import { createAudioQualityProbe, describeAudioQualityFromBuffer, describeAudioQualityFromInfo } from '../src/audio/quality.js';
import { mp3Fixture } from './helpers/mp3.mjs';

test('MP3 Info headers describe actual 128, 192 and 320 kbps with or without ID3', () => {
    for (const bitrate of [128, 192, 320]) for (const id3 of [0, 35]) {
        const buffer = mp3Fixture({ bitrate, id3 }), info = parseMp3StreamInfo(buffer);
        assert.deepEqual(info, { sampleRate: 44100, channels: 2, bitrateKbps: bitrate, mode: 'CBR' });
        assert.equal(describeAudioQualityFromInfo({ type: 'mp3' }, '', info).label, `MP3 ${bitrate}kbps`);
        const probe = createAudioQualityProbe(buffer, 'a.mp3');
        assert.equal(describeAudioQualityFromBuffer(null, 'a.mp3', { duration: 1 }, { _qualityProbe: probe }).label, `MP3 ${bitrate}kbps`);
    }
});

test('Xing VBR uses byte and sample counts, never the first frame bitrate', () => {
    const buffer = mp3Fixture({ tag: 'Xing', bitrate: 320 });
    assert.equal(parseMp3StreamInfo(buffer).bitrateKbps, Math.round(60000 * 8 * 44100 / (100 * 1152) / 1000));
    const bad = buffer.slice(0); new DataView(bad).setUint32(44, 0);
    const info = parseMp3StreamInfo(bad);
    assert.equal(info.bitrateKbps, null);
    assert.equal(describeAudioQualityFromInfo({ type: 'mp3' }, '', info).label, 'MP3 VBR');
    assert.equal(parseMp3StreamInfo(mp3Fixture({ tag: '' })), null);
});

test('MP3 probes reject short, corrupt, reserved and false-sync input', () => {
    const buffer = mp3Fixture(), frame = Math.floor(144000 * 192 / 44100);
    for (const length of [0, 3, 9, frame + 3]) assert.equal(parseMp3StreamInfo(buffer.slice(0, length)), null);
    for (const changed of [1, 2]) {
        const bad = new Uint8Array(buffer.slice(0)); bad[changed] = 0;
        assert.equal(parseMp3StreamInfo(bad), null);
    }
    const invalid = new Uint8Array(mp3Fixture({ id3: 35 })); invalid[6] = 255;
    assert.equal(mp3AudioOffset(invalid), null);
    assert.equal(parseMp3StreamInfo(invalid), null);
});

test('large ID3 is skipped with at most two small reads, never downloaded in full', async () => {
    const buffer = mp3Fixture({ id3: 8192 }), requests = [];
    const read = async start => { requests.push(start); return buffer.slice(start, start + 4096); };
    assert.equal((await readMp3StreamInfo(read)).bitrateKbps, 192);
    assert.deepEqual(requests, [0, 8202]);
    requests.length = 0;
    assert.equal((await readMp3StreamInfo(read, { header: buffer.slice(0, 4096) })).bitrateKbps, 192);
    assert.deepEqual(requests, [8202]);
    requests.length = 0;
    assert.equal(await readMp3StreamInfo(read, { header: buffer.slice(0, 4096), totalBytes: 2000 }), null);
    assert.deepEqual(requests, []);
    assert.equal(await readMp3StreamInfo(async () => null), null);
});

test('a frame starting near the first range boundary can use one bounded follow-up', async () => {
    const buffer = mp3Fixture({ id3: 3790, bitrate: 320 }), requests = [];
    const info = await readMp3StreamInfo(async start => { requests.push(start); return buffer.slice(start, start + 4096); });
    assert.equal(info.bitrateKbps, 320); assert.deepEqual(requests, [0, 3800]);
});

test('MPEG 2 and 2.5 mono CRC frames use their own rate, size and side-info offsets', () => {
    for (const version of [2, 0]) {
        const sampleRate = version === 2 ? 22050 : 11025;
        const frameSize = Math.floor(72000 * 64 / sampleRate);
        const bytes = new Uint8Array(frameSize * 3);
        for (let index = 0; index < 3; index++) bytes.set([255, 224 | version << 3 | 2, 128, 192], index * frameSize);
        bytes.set([73, 110, 102, 111], 15);
        assert.deepEqual(parseMp3StreamInfo(bytes), { sampleRate, channels: 1, bitrateKbps: 64, mode: 'CBR' });
    }
});

test('VBRI byte and frame counts describe average bitrate; malformed offsets stay bounded', () => {
    const bytes = new Uint8Array(mp3Fixture({ tag: '' })), view = new DataView(bytes.buffer);
    bytes.set([86, 66, 82, 73], 36); view.setUint32(46, 60000); view.setUint32(50, 100);
    assert.equal(parseMp3StreamInfo(bytes).bitrateKbps, Math.round(60000 * 8 * 44100 / (100 * 1152) / 1000));
    const prefix = new Uint8Array(10); prefix.set([73, 68, 51, 4, 0, 16, 0, 0, 0, 35]);
    assert.equal(mp3AudioOffset(prefix), 55);
    prefix[3] = 3; assert.equal(mp3AudioOffset(prefix), 45);
    prefix[3] = 1; assert.equal(mp3AudioOffset(prefix), null);
});
