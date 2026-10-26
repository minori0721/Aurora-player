import test from 'node:test';
import assert from 'node:assert/strict';
import { alignWordLyricTimeline, parseLyricsToArray, parseYrc, selectNeteaseLyricTracks } from '../src/lyrics/parser.js';

test('YRC accepts two/three-field headers, keeps original timing and sorts rows', () => {
    const rows = parseYrc('\uFEFF [2200,900,0](2220,300,0)wind(2520,580,0)sound\n [1170,440](1170,200,0)rain(1370,240,0)fall');
    assert.deepEqual(rows, [
        { t: 1.17, dur: 440, words: [{ txt: 'rain', start: 1170, dur: 200 }, { txt: 'fall', start: 1370, dur: 240 }] },
        { t: 2.2, dur: 900, words: [{ txt: 'wind', start: 2220, dur: 300 }, { txt: 'sound', start: 2520, dur: 580 }] }
    ]);
    assert.equal(parseYrc('[0,0](0,0,0)word')[0].words[0].dur, 0);
});

test('YRC retains literal brackets/parentheses and rejects unsafe or missing timings', () => {
    const rows = parseYrc('[1000,500](1000,200,0)wind (soft) [echo](1200,300,0) again');
    assert.equal(rows[0].words[0].txt, 'wind (soft) [echo]');
    assert.equal(rows[0].words[1].txt, ' again');
    for (const value of ['', '[0,1000]text only', '[-1,10](0,10,0)word', '[0,-1](0,10,0)word',
        '[9007199254740992,10](0,10,0)word', '[9007199254740991,1](0,1,0)word',
        '[0,1000](9007199254740992,10,0)word', '[0,1000](9007199254740991,1,0)word']) {
        assert.equal(parseYrc(value), null, value);
    }
});

test('YRC replaces shifted sung lines without duplicates and aligns LRC-timed subtitles', () => {
    const original = [{ t: 0, txt: 'Composer: Example' }, { t: 1.43, txt: 'Rain fall!' },
        { t: 2.48, txt: 'Wind sound' }, { t: 9.789, txt: 'Rain fall!' }, { t: 15, txt: 'plain ending' }];
    const translated = [{ t: 1.43, txt: 'translation one' }, { t: 2.48, txt: 'translation two' }, { t: 15, txt: 'ending' }];
    const roman = [{ t: 1.43, txt: 'roman' }];
    const words = parseYrc('[1170,440](1170,200,0)rain (1370,240,0)fall\n[2200,900](2220,300,0)wind (2520,580,0)sound\n[9800,600](9800,600,0)rain fall');
    const before = structuredClone({ original, translated, roman, words });
    const result = alignWordLyricTimeline(original, translated, roman, words);
    assert.deepEqual(result.original.map(row => row.t), [0, 1.17, 2.2, 9.8, 15]);
    assert.deepEqual(result.translated.map(row => row.t), [1.17, 2.2, 15]);
    assert.equal(result.roman[0].t, 1.17);
    assert.deepEqual({ original, translated, roman, words }, before, 'alignment must not mutate cached/parser inputs');
});

test('partial YRC retains credits, unmatched lines and distant repetitions rather than guessing', () => {
    const original = [{ t: -1, txt: 'metadata' }, { t: 0, txt: 'intro' }, { t: 1.3, txt: 'wind' },
        { t: 2.3, txt: 'unrelated overlapping line' }, { t: 8, txt: 'wind' }];
    const words = parseYrc('[1000,1000](1000,1000,0)wind\n[2200,500](2200,500,0)other');
    const result = alignWordLyricTimeline(original, [], [], words);
    assert.deepEqual(result.original.map(row => row.t), [-1, 0, 1, 2.2, 2.3, 8]);
    assert.equal(result.original.filter(row => row.txt === 'wind').length, 2);
});

test('word-only and exact-timestamp variants work, ordinary LRC stays unchanged without YRC', () => {
    const words = parseYrc('[1000,1000](1000,1000,0)words');
    assert.deepEqual(alignWordLyricTimeline([], [], [], words).original, [{ t: 1, txt: 'words' }]);
    const original = [{ t: 1, txt: 'alternate text' }, { t: 3, txt: 'fallback' }], translated = [], roman = [];
    assert.deepEqual(alignWordLyricTimeline(original, translated, roman, words).original, [{ t: 1, txt: 'words' }, original[1]]);
    const unchanged = alignWordLyricTimeline(original, translated, roman, null);
    assert.equal(unchanged.original, original); assert.equal(unchanged.translated, translated); assert.equal(unchanged.roman, roman);
});

function fromResponse(data) {
    const tracks = selectNeteaseLyricTracks(data);
    return alignWordLyricTimeline(parseLyricsToArray(tracks.original), parseLyricsToArray(tracks.translated),
        parseLyricsToArray(tracks.roman), tracks.wordLyrics);
}

test('earlier ordinary timestamps are paired in either direction, not added as repeated YRC rows', () => {
    const data = { lrc: { lyric: '[00:00.000]Composer: Example\n[00:00.780]one\n[00:07.298]two' },
        tlyric: { lyric: '[00:00.780]old one\n[00:07.298]old two' },
        yrc: { lyric: '[930,6130](930,6130,0)one\n[7400,7550](7400,7550,0)two' },
        ytlrc: { lyric: '[00:00.930]new one\n[00:07.400]new two' } };
    const result = fromResponse(data);
    assert.deepEqual(result.original.map(line => line.t), [0, .93, 7.4]);
    assert.deepEqual(result.translated, [{ t: .93, txt: 'new one' }, { t: 7.4, txt: 'new two' }]);
});

test('anchored agreement handles isolated large offsets and minor spelling variants without affecting word timing', () => {
    const original = [0, 5, 10, 15, 20].map((t, i) => ({ t, txt: `unique phrase ${i}` }));
    const words = original.map((line, i) => ({ t: i === 4 ? 29 : line.t + .1, dur: 1000,
        words: [{ txt: i === 2 ? 'unique phraze 2' : line.txt, start: (i === 4 ? 29 : line.t + .1) * 1000, dur: 1000 }] }));
    const result = alignWordLyricTimeline(original, [], [], words);
    assert.deepEqual(result.original.map(line => line.t), [.1, 5.1, 10.1, 15.1, 29]);
    assert.equal(result.original.length, words.length);
});

test('equal row counts alone do not establish the same track or match a distant repeated phrase', () => {
    const far = alignWordLyricTimeline([{ t: 20, txt: 'refrain' }], [], [], parseYrc('[1000,1000](1000,1000,0)refrain'));
    assert.deepEqual(far.original.map(line => line.t), [1, 20]);
    const other = alignWordLyricTimeline([{ t: 1.5, txt: 'other version' }], [], [], parseYrc('[1000,1000](1000,1000,0)word'));
    assert.deepEqual(other.original.map(line => line.t), [1, 1.5]);
});

test('partial tracks retain ordinary gaps and repeat occurrences, subtitles never introduce new main rows', () => {
    const data = { lrc: { lyric: '[00:01.000]one\n[00:05.000]missing words\n[00:10.000]one' },
        tlyric: { lyric: '[00:01.000]first\n[00:05.000]gap\n[00:09.000]stray subtitle\n[00:10.000]repeat' },
        yrc: { lyric: '[1100,1000](1100,1000,0)one' } };
    const result = fromResponse(data);
    assert.deepEqual(result.original.map(line => line.t), [1.1, 5, 10]);
    assert.deepEqual(result.translated.map(line => line.t), [1.1, 5, 10]);
    assert.equal(result.translated.some(line => line.txt === 'stray subtitle'), false);
});

test('paired translation and romanization win per row, missing paired rows use aligned ordinary text', () => {
    const data = { lrc: { lyric: '[00:01.000]one\n[00:05.000]two' },
        tlyric: { lyric: '[00:01.000]old one\n[00:05.000]old two' },
        romalrc: { lyric: '[00:01.000]old roma one\n[00:05.000]old roma two' },
        yrc: { lyric: '[1100,1000](1100,1000,0)one\n[5100,1000](5100,1000,0)two' },
        ytlrc: { lyric: '[00:01.100]paired translation' }, yromalrc: { lyric: '[00:05.100]paired roma' } };
    const result = fromResponse(data);
    assert.deepEqual(result.translated.map(line => line.txt), ['paired translation', 'old two']);
    assert.deepEqual(result.roman.map(line => line.txt), ['old roma one', 'paired roma']);
});

test('mislabeled/misaligned paired tracks cannot bind metadata to a nearby sung row', () => {
    const data = { lrc: { lyric: '[00:01.000]one\n[00:05.000]two' },
        romalrc: { lyric: '[00:01.000]proper one\n[00:05.000]proper two' },
        yrc: { lyric: '[1120,1000](1120,1000,0)one\n[5100,1000](5100,1000,0)two' },
        yromalrc: { lyric: '[00:00.000]unrelated header\n[00:00.962]credit one\n[00:01.154]credit two\n[00:01.405]other version\n[00:05.424]other two' } };
    const result = fromResponse(data);
    assert.deepEqual(result.roman, [{ t: 1.12, txt: 'proper one' }, { t: 5.1, txt: 'proper two' }]);
});

test('invalid/missing YRC preserves ordinary lyric tracks and ignores YRC-only supplements', () => {
    const data = { lrc: { lyric: '[00:01.000]plain' }, tlyric: { lyric: '[00:01.000]ordinary translation' },
        romalrc: { lyric: '[00:01.000]ordinary roman' }, yrc: { lyric: '[1,2]broken' },
        ytlrc: { lyric: '[00:01.000]wrong translation' }, yromalrc: { lyric: '[00:01.000]wrong roman' } };
    const result = fromResponse(data);
    assert.deepEqual(result.original, [{ t: 1, txt: 'plain' }]);
    assert.equal(result.translated[0].txt, 'ordinary translation');
    assert.equal(result.roman[0].txt, 'ordinary roman');
});

test('adjacent short YRC rows get their exact supplements, never the previous row within tolerance', () => {
    const data = { yrc: { lyric: '[1000,30](1000,30,0)one\n[1030,30](1030,30,0)two' },
        ytlrc: { lyric: '[00:01.000]translation one\n[00:01.030]translation two' },
        yromalrc: { lyric: '[00:01.000]roman one\n[00:01.030]roman two' } };
    const result = fromResponse(data);
    assert.deepEqual(result.translated, [{ t: 1, txt: 'translation one' }, { t: 1.03, txt: 'translation two' }]);
    assert.deepEqual(result.roman.map(line => line.txt), ['roman one', 'roman two']);
});

test('identical full text with different line breaks uses the YRC layout without duplicate fragments', () => {
    const result = fromResponse({ lrc: { lyric: '[00:00.780]one two' },
        tlyric: { lyric: '[00:00.780]whole translation' },
        yrc: { lyric: '[930,3000](930,3000,0)one\n[7400,3000](7400,3000,0)two' } });
    assert.deepEqual(result.original, [{ t: .93, txt: 'one' }, { t: 7.4, txt: 'two' }]);
    assert.deepEqual(result.translated, [{ t: .93, txt: 'whole translation' }], 'do not invent a translation split or duplicate it');
});

test('native sentences containing ordinary fragments keep their layout and all fallback subtitles', () => {
    const result = fromResponse({ lrc: { lyric: '[00:01.000]one\n[00:02.000]two' },
        tlyric: { lyric: '[00:01.000]first translation\n[00:02.000]second translation' },
        romalrc: { lyric: '[00:01.000]first roman\n[00:02.000]second roman' },
        yrc: { lyric: '[1100,3000](1100,1000,0)one (2100,2000,0)two' } });
    assert.deepEqual(result.original, [{ t: 1.1, txt: 'one two' }]);
    assert.deepEqual(result.translated, [{ t: 1.1, txt: 'first translation second translation' }]);
    assert.deepEqual(result.roman, [{ t: 1.1, txt: 'first roman second roman' }]);
});
