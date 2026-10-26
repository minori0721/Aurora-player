import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLyricTimeline } from '../src/lyrics/timeline.js';
import { createLyricTimeLookup, parseYrc, selectNeteaseLyricTracks } from '../src/lyrics/parser.js';

const line = (t, txt) => ({ t, txt });
const words = (t, txt, dur = 500) => ({ t, dur, words: [{ txt, start: t * 1000, dur }] });
const tuples = rows => rows.flatMap(row => row.words || []).map(word => [word.txt, word.start, word.dur]);
const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
};

test('close cues use their exact original/subtitle instead of the previous row within 50ms', () => {
    const original = [.77, .83, .84].map((t, i) => line(t, `phrase ${i}`));
    const translated = original.map((row, i) => line(row.t, `translation ${i}`));
    const result = buildLyricTimeline(original, translated, [], null);
    assert.deepEqual(result.rows.map(row => [row.t, row.txt, row.translation]), original.map((row, i) => [row.t, row.txt, translated[i].txt]));
    const lookup = createLyricTimeLookup(original);
    assert.equal(lookup(.84), original[2]);
    assert.equal(lookup(.831), original[1]);
});

test('several distinct source records at one timestamp are retained in a single display event', () => {
    const original = ['writer', 'composer', 'arranger'].map(txt => line(0, txt));
    const result = buildLyricTimeline(original, [], [], null);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].txt, 'writer\ncomposer\narranger');
    assert.deepEqual(result.rows[0].sourceOriginal, original);
});

test('orphan subtitles never create main cues; translation-only input is displayed once', () => {
    const result = buildLyricTimeline([line(1, 'original')], [line(1, 'translated'), line(12, 'orphan')], [], null);
    assert.deepEqual(result.rows.map(row => [row.t, row.txt, row.translation]), [[1, 'original', 'translated']]);
    const fallback = buildLyricTimeline([], [line(1, 'only translation')], [], null);
    assert.deepEqual(fallback.rows.map(row => [row.txt, row.translation]), [['only translation', '']]);
});

test('one ordinary sentence can group existing word cues without replacing text, objects or absolute timings', () => {
    const timed = [words(1.1, 'Hello,'), words(1.7, 'world again'), words(3, 'a different ending')];
    const original = [line(1, 'Hello, world again'), line(2.9, 'a different ending')];
    const source = freeze({ timed, original });
    const result = buildLyricTimeline(source.original, [line(1, 'whole translation')], [], source.timed);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].txt, 'Hello, world again');
    assert.equal(result.rows[0].translation, 'whole translation');
    assert.equal(result.rows[0].t, 1.1);
    assert.deepEqual(tuples(result.rows), tuples(timed));
    assert.equal(result.rows[0].words[1], timed[1].words[0]);
});

test('long pauses and excessive word counts keep native word cue boundaries', () => {
    const timed = [words(1, 'one'), words(7, 'two')];
    const result = buildLyricTimeline([line(1.1, 'one two')], [line(1.1, 'whole translation')], [], timed);
    assert.deepEqual(result.rows.map(row => row.t), [1, 7]);
    assert.equal(result.rows[0].translation, 'whole translation');
    assert.equal(result.rows[1].translation, '');
    const many = [0, 1].map(i => ({ t: i + 1, words: Array.from({ length: 50 }, (_, j) => ({ txt: 'a', start: (i + 1) * 1000 + j, dur: 1 })) }));
    assert.equal(buildLyricTimeline([line(1, 'a'.repeat(100))], [], [], many).rows.length, 2);
});

test('many ordinary fragments keep repeated subtitles from distinct source events in order', () => {
    const timed = [words(1.1, 'first phrase second phrase', 3000)];
    const result = buildLyricTimeline([line(1, 'first phrase'), line(2, 'second phrase')],
        [line(1, 'again'), line(2, 'again')], [], timed);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].translation, 'again again');
    assert.deepEqual(tuples(result.rows), tuples(timed));
});

test('whole-track text agreement survives irregular offsets without changing word times', () => {
    const original = [line(1, 'first unique phrase'), line(10, 'second unique phrase'), line(20, 'third unique phrase')];
    const timed = [words(10, 'first unique phrase'), words(30, 'second unique phrase'), words(55, 'third unique phrase')];
    const result = buildLyricTimeline(original, original.map((row, i) => line(row.t, `translation ${i}`)), [], timed);
    assert.deepEqual(result.rows.map(row => row.t), [10, 30, 55]);
    assert.deepEqual(result.rows.map(row => row.translation), ['translation 0', 'translation 1', 'translation 2']);
});

test('one distant phrase does not establish track identity; real distant repetitions remain', () => {
    const result = buildLyricTimeline([line(20, 'a long repeated phrase')], [], [], [words(1, 'a long repeated phrase')]);
    assert.deepEqual(result.rows.map(row => row.t), [1, 20]);
    const ordinary = buildLyricTimeline([line(1, 'repeat'), line(20, 'repeat')], [], [], null);
    assert.deepEqual(ordinary.rows.map(row => row.t), [1, 20]);
});

test('anchored wording variants can group native word runs without inventing timings for ordinary text', () => {
    const original = [line(1, 'opening unique sentence'), line(5, 'lets sign something for your appetite'), line(10, 'closing unique sentence')];
    const timed = [words(1.1, 'opening unique sentence'), words(5.1, 'lets order something for', 1000), words(6.1, 'your appetite', 1000), words(10.1, 'closing unique sentence')];
    const result = buildLyricTimeline(original, [], [], timed);
    assert.equal(result.rows.length, 3);
    assert.equal(result.rows[1].txt, 'lets order something for your appetite');
    assert.equal(result.rows[1].sourceOriginal[0], original[1]);
    assert.deepEqual(tuples(result.rows), tuples(timed));
});

test('near-duplicate ordinary records share a mapped event, not a second word run', () => {
    const original = [line(1, 'one whole sentence'), line(1.04, 'one whole sentence')];
    const timed = [words(1.1, 'one whole sentence')];
    const result = buildLyricTimeline(original, [line(1, 'translated'), line(1.04, 'translated')], [], timed);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].sourceOriginal.length, 2);
    assert.equal(result.rows[0].translation, 'translated');
    assert.deepEqual(tuples(result.rows), tuples(timed));
});

test('punctuation-only interval markers stay as annotations, not new word-timeline singing cues', () => {
    const result = buildLyricTimeline([line(0, '.'), line(1, 'first phrase')], [], [], [words(1.1, 'first phrase')]);
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.annotations, [line(0, '.')]);
});

test('large unrelated tracks hit the bounded fallback and never discard native words', () => {
    const original = Array.from({ length: 200 }, (_, i) => line(i * 3 + .4, `ordinary variant ${i}`));
    const timed = original.map((row, i) => words(i * 3, `different word cue ${i}`));
    const result = buildLyricTimeline(original, [], [], timed);
    assert.equal(result.rows.length, 400);
    assert.deepEqual(tuples(result.rows), tuples(timed));
});

test('two/three-field YRC and literal punctuation remain compatible with the timeline', () => {
    const timed = parseYrc('[1000,1000](1000,500,0)wind (soft)(1500,500,0) [echo]\n[3000,500,0](3000,500,0)end');
    assert.deepEqual(tuples(buildLyricTimeline([], [], [], timed).rows), tuples(timed));
});

test('grouping never jumps across a punctuation-only native word cue', () => {
    const timed = [words(1, 'first phrase'), words(1.5, '...'), words(2, 'second phrase')];
    const result = buildLyricTimeline([line(1, 'first phrase second phrase')], [], [], timed);
    assert.deepEqual(tuples(result.rows), tuples(timed));
    assert.equal(result.rows.length, 3);
});

test('information colliding with a native word cue is retained without entering its sung subtitle', () => {
    const result = buildLyricTimeline([line(0, 'Composer: Example'), line(.1, 'first phrase')],
        [line(0, 'composer information'), line(.1, 'sung translation')], [], [words(0, 'first phrase')]);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].translation, 'sung translation');
    assert.deepEqual(result.rows[0].info, ['Composer: Example', 'composer information']);
});

test('duplicate aliases cannot form a chain that consumes a later distinct event', () => {
    const original = [line(1, 'same phrase'), line(1.04, 'same phrase'), line(1.08, 'same phrase')];
    const result = buildLyricTimeline(original, [], [], [words(1, 'same phrase')]);
    assert.equal(result.rows.filter(row => !row.words).length, 1);
    assert.equal(result.rows.find(row => !row.words).t, 1.08);
});

test('one paired subtitle near two short cues belongs to its nearest exact event only', () => {
    const tracks = selectNeteaseLyricTracks({ yrc: { lyric: '[1000,30](1000,30,0)one\n[1030,30](1030,30,0)two' },
        ytlrc: { lyric: '[00:01.000]first only' } });
    const result = buildLyricTimeline([], [], [], tracks.wordLyrics);
    assert.deepEqual(result.rows.map(row => row.translation), ['first only', '']);
});

test('crossed two-to-two sentences are partitioned at existing timed word boundaries', () => {
    const original = [line(.9, 'first phrase'), line(1.9, 'next words final phrase'), line(8, 'ordinary unmatched ending')];
    const timed = [{ t: 1, words: [{ txt: 'first phrase ', start: 1000, dur: 1000 }, { txt: 'next words', start: 2000, dur: 1000 }] },
        words(3, 'final phrase'), words(8, 'different native ending')];
    const result = buildLyricTimeline(original, [line(.9, 'first translation'), line(1.9, 'second translation')], [], timed);
    assert.deepEqual(result.rows.slice(0, 2).map(row => [row.t, row.txt, row.translation]),
        [[1, 'first phrase ', 'first translation'], [2, 'next words final phrase', 'second translation']]);
    assert.equal(result.rows.filter(row => !row.words && row.t < 8).length, 0);
    assert.deepEqual(tuples(result.rows), tuples(timed));
});

test('exact correspondence is not limited to three source rows', () => {
    const original = [line(.9, 'a complete sentence with many fragments')];
    const timed = ['a complete', 'sentence', 'with', 'many', 'fragments'].map((text, i) => words(1 + i * .2, text, 200));
    const result = buildLyricTimeline(original, [], [], timed);
    assert.equal(result.rows.length, 1);
    assert.deepEqual(tuples(result.rows), tuples(timed));
});

test('normalization is comparison-only and never slices literal Unicode characters', () => {
    const original = [line(.9, 'first'), line(1.9, 'café again')];
    const timed = [{ t: 1, words: [{ txt: '\uFB01rst ', start: 1000, dur: 1000 }, { txt: 'cafe\u0301', start: 2000, dur: 1000 }] }, words(3, 'again')];
    freeze({ original, timed });
    const result = buildLyricTimeline(original, [], [], timed);
    assert.deepEqual(result.rows.map(row => row.txt), ['\uFB01rst ', 'cafe\u0301 again']);
    assert.deepEqual(tuples(result.rows), tuples(timed));
});

test('a cut inside a timed token retains the native row rather than inventing timings', () => {
    const original = [line(.9, 'first phrase'), line(1.9, 'next words final phrase')];
    const timed = [words(1, 'first phrase next words final phrase')];
    const result = buildLyricTimeline(original, [], [], timed);
    assert.equal(result.rows.length, 1);
    assert.deepEqual(tuples(result.rows), tuples(timed));
});

test('repartitioned sentences use their own subtitles instead of copying a native parent subtitle', () => {
    const original = [line(.9, 'first phrase'), line(1.9, 'second phrase ending')];
    const timed = [{ t: 1, words: [{ txt: 'first phrase ', start: 1000, dur: 1000 }, { txt: 'second phrase', start: 2000, dur: 1000 }],
        translation: 'native parent translation', translationSource: line(1, 'native parent translation') }, words(3, 'ending')];
    const result = buildLyricTimeline(original, [line(.9, 'first child'), line(1.9, 'second child')], [], timed);
    assert.deepEqual(result.rows.map(row => row.translation), ['first child', 'second child']);
    const noPairedChildren = buildLyricTimeline(original, [], [], timed);
    assert.equal(noPairedChildren.rows.length, 2);
    assert.equal(noPairedChildren.rows[0].translation, 'native parent translation');
});

test('a lone unrelated row cannot be consumed just because most other rows correspond', () => {
    const original = Array.from({ length: 5 }, (_, i) => line(i * 3, `unique source phrase ${i}`));
    const timed = original.map((row, i) => words(row.t + .1, i === 2 ? 'completely unrelated words' : row.txt));
    const result = buildLyricTimeline(original, [], [], timed);
    assert.ok(result.rows.some(row => !row.words && row.sourceOriginal.includes(original[2])));
    assert.deepEqual(tuples(result.rows), tuples(timed));
});

test('adjacent small wording variants require individual text evidence inside ordered anchors', () => {
    const original = [line(0, 'opening unique sentence'), line(3, 'with fire in our eyes'), line(6, 'a complete sample sentence'), line(9, 'closing unique sentence')];
    const timed = [words(.1, 'opening unique sentence'), words(3.1, 'fire in our eyes'),
        words(6.1, 'a complete example sentence'), words(9.1, 'closing unique sentence')];
    const result = buildLyricTimeline(original, [], [], timed);
    assert.equal(result.rows.length, 4);
    assert.deepEqual(tuples(result.rows), tuples(timed));
});

test('local anchor offsets allow exact edge matches without a global larger time window', () => {
    const original = [line(0, 'first unique sentence'), line(3, 'second unique sentence'), line(6, 'last short echo')];
    const timed = [words(4, 'first unique sentence'), words(7, 'second unique sentence'), words(10, 'last short echo'), words(15, 'unrelated ending')];
    const result = buildLyricTimeline(original, [], [], timed);
    assert.deepEqual(result.rows.map(row => row.t), [4, 7, 10, 15]);
});

test('identical cross-source credits share one native event while distinct roles and repetitions survive', () => {
    const original = [line(0, 'Composer: Person'), line(.5, 'Lyricist: Other'), line(2, 'repeat'), line(5, 'repeat')];
    const timed = [words(1, 'composer: person'), words(2.1, 'repeat'), words(5.1, 'repeat')];
    const result = buildLyricTimeline(original, [], [], timed);
    assert.equal(result.rows.filter(row => /composer/i.test(row.txt)).length, 1);
    assert.ok(result.rows.some(row => row.txt === 'Lyricist: Other'));
    assert.equal(result.rows.filter(row => row.txt === 'repeat').length, 2);
    assert.deepEqual(result.rows.flatMap(row => row.sourceOriginal).length, original.length);
});
