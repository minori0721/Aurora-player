import test from 'node:test';
import assert from 'node:assert/strict';
import { inferAudioTypeFromUrl } from '../src/audio/quality.js';
import { parseSliFile, formatSliLoop } from '../src/playlist/sli.js';
import { createImportPathFields, normalizeImportPath, normalizeImportKey } from '../src/playlist/paths.js';
import { findCompanionBindings } from '../src/playlist/matching.js';
import { parseJsonLyricLine, parseLyricsToArray, parseYrc } from '../src/lyrics/parser.js';
import { normalizeMusicSong } from '../src/netease/models.js';
import { parseMusicRoute, buildMusicHash } from '../src/netease/routes.js';
import { parseFlacTagsFromArrayBuffer, parseFlacStreamInfoFromBuffer, parseWavStreamInfoFromBuffer } from '../src/audio/quality.js';

test('SLI accepts valid sample ranges and rejects malformed/read failures', async () => {
    const valid = await parseSliFile({ text: async () => 'From = 5033574; To = 414981;' });
    assert.deepEqual(valid, { status: 'valid', fromSamples: 5033574, toSamples: 414981 });
    for (const source of ['', 'From=1;', 'From=2;To=3;', 'From=3;To=3;', 'From=9007199254740992;To=0;']) {
        assert.equal((await parseSliFile({ text: async () => source })).status, 'invalid');
    }
    assert.equal((await parseSliFile({ text: async () => { throw new Error('unreadable'); } })).status, 'invalid');
});

test('SLI exports a standard v2 Link block and preserves integer samples on import', async () => {
    for (const [from, to] of [[529239, 176418], [1, 0], [Number.MAX_SAFE_INTEGER, 417]]) {
        const text = formatSliLoop(from, to);
        assert.equal(text, `#2.00\n# Sound Loop Information (utf-8)\nLink { From=${from}; To=${to}; Smooth=False; Condition=no; RefValue=0; CondVar=0; }\n`);
        assert.deepEqual(await parseSliFile({ text: async () => text }), { status: 'valid', fromSamples: from, toSamples: to });
    }
    for (const pair of [[0, 0], [2, -1], [2, 3], [NaN, 0], [Infinity, 0], [2.1, 1], [Number.MAX_SAFE_INTEGER + 1, 0]]) {
        assert.throws(() => formatSliLoop(...pair));
    }
});

test('paths preserve Unicode/display names and normalize matching keys', () => {
    assert.equal(normalizeImportPath('Album\\sub\\曲名.WAV'), 'Album/sub/曲名.WAV');
    assert.equal(normalizeImportKey('A/Cafe\u0301.OGG'), 'a/café.ogg');
    const audio = createImportPathFields('Album/曲名.WAV');
    assert.equal(audio.ext, 'wav');
    assert.equal(audio.stemKey, '曲名');
});

function companion(path) {
    const asset = createImportPathFields(path);
    const name = asset.stemKey;
    const dot = name.lastIndexOf('.');
    const explicit = dot >= 0 && ['wav', 'ogg', 'mp3', 'flac', 'm4a'].includes(name.slice(dot + 1));
    return { ...asset, file: { name: asset.name }, explicitAudioNameKey: explicit ? name : '', companionBaseKey: explicit ? name.slice(0, dot) : name };
}

test('SLI matching respects directory, exact audio name and ambiguity', () => {
    const track = name => ({ name, asset: createImportPathFields(name) });
    const tracks = [track('a/song.wav'), track('b/song.ogg')];
    const first = companion('a/song.WAV.SLI'), second = companion('b/song.sli');
    findCompanionBindings(tracks, 'sli', new Map([[first.pathKey, first], [second.pathKey, second]]));
    assert.equal(tracks[0].sliFile, first.file);
    assert.equal(tracks[1].sliFile, second.file);
    const ambiguous = [track('a/song.wav')];
    const one = companion('x/song.sli'), two = companion('y/song.sli');
    findCompanionBindings(ambiguous, 'sli', new Map([[one.pathKey, one], [two.pathKey, two]]));
    assert.equal(ambiguous[0].sliStatus, 'ambiguous');
    assert.equal(ambiguous[0].sliFile, null);
});

test('routes round-trip all supported views and reject invalid IDs', () => {
    for (const route of [
        { kind: 'search', q: '日本語 & solfa', type: 'song', page: 3 },
        { kind: 'artist', id: 7, view: 'albums', page: 2 },
        { kind: 'album', id: 123 }, { kind: 'playlist-import' }, { kind: 'playlist-mine' }
    ]) assert.deepEqual(parseMusicRoute(buildMusicHash(route)), route);
    for (const hash of ['#music/album/-1', '#music/artist/NaN', '#music/album/9007199254740992', '#music/unknown']) assert.equal(parseMusicRoute(hash).kind, 'invalid');
    assert.equal(parseMusicRoute('#other'), null);
});

test('API song fields normalize ar/al and artists/album equally', () => {
    const current = normalizeMusicSong({ id: 1, name: 'A - B', dt: 12345, ar: [{ id: 2, name: 'Artist' }], al: { id: 3, name: 'Album', picUrl: 'http://example.com/a.jpg' } });
    const legacy = normalizeMusicSong({ id: 1, name: 'A - B', duration: 12345, artists: [{ id: 2, name: 'Artist' }], album: { id: 3, name: 'Album', picUrl: 'http://example.com/a.jpg' } });
    assert.equal(current.durationMs, legacy.durationMs);
    assert.deepEqual(current.artists, legacy.artists);
    assert.equal(current.album.picUrl, 'https://example.com/a.jpg');
});

test('metadata-only JSON, LRC and YRC parsers remain usable without the DOM', () => {
    const metadata = [];
    const rows = parseLyricsToArray('{"t":-1,"c":[{"tx":"作曲: "},{"tx":"solfa"}]}\n[00:01.50]hello', metadata);
    assert.equal(rows.length, 1);
    assert.equal(metadata.length, 1);
    assert.equal(parseJsonLyricLine('not json'), null);
    assert.ok(Array.isArray(parseYrc('[0,1000,0](0,500,0)你(500,500,0)好')));
});

test('truncated FLAC metadata never blocks playback and WAV headers are bounded', () => {
    for (let size = 0; size < 80; size++) {
        const bytes = new Uint8Array(size);
        if (size >= 4) bytes.set([102, 76, 97, 67]);
        assert.doesNotThrow(() => parseFlacTagsFromArrayBuffer(bytes.buffer, 1024, () => {}));
        assert.doesNotThrow(() => parseFlacStreamInfoFromBuffer(bytes.buffer));
        assert.doesNotThrow(() => parseWavStreamInfoFromBuffer(bytes.buffer));
    }
    const wav = new ArrayBuffer(44), view = new DataView(wav);
    view.setUint32(0, 0x52494646); view.setUint32(8, 0x57415645); view.setUint32(12, 0x666d7420);
    view.setUint32(16, 16, true); view.setUint16(22, 2, true); view.setUint32(24, 44100, true); view.setUint16(34, 16, true);
    assert.deepEqual(parseWavStreamInfoFromBuffer(wav), { sampleRate: 44100, channels: 2, bitsPerSample: 16 });
});
test('format inference uses a path suffix or explicit type, never size, folders or query text', () => {
    assert.equal(inferAudioTypeFromUrl('https://cdn.test/old.flac/song.mp3?x=.wav'), 'mp3');
    assert.equal(inferAudioTypeFromUrl('https://cdn.test/opaque?x=.flac'), '');
    assert.equal(inferAudioTypeFromUrl('https://cdn.test/opaque', 'flac'), 'flac');
    assert.equal(inferAudioTypeFromUrl('https://cdn.test/opaque', 'nonsense'), '');
});
