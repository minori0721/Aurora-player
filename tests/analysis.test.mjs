import test from 'node:test';
import assert from 'node:assert/strict';
import { findBestMatchByMode, releaseAnalysisBuffer } from '../src/analysis/algorithms.js';
import { analysisPoint, createLoopAnalysisInput, describeLoopAnalysisInput, restoreLoopAnalysisInput } from '../src/analysis/input.js';

const audio = (channels, sampleRate = 4000) => ({ sampleRate, numberOfChannels: channels.length,
    duration: channels[0].length / sampleRate, getChannelData: c => channels[c] });
function noise(length, gain = 0.3) {
    let seed = 173;
    return Float32Array.from({ length }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return (seed / 2147483648 - 1) * gain;
    });
}
function repeated(rate = 4000, gain = 0.3) {
    const motif = noise(rate * 4, gain);
    return Float32Array.from({ length: rate * 20 }, (_, i) => motif[i % motif.length]);
}

test('analysis packs only A/B neighborhoods, preserves stereo and never detaches playback', () => {
    const left = repeated(), right = left.map(v => -v);
    const source = audio([left, right]);
    const layout = describeLoopAnalysisInput(source, 4.1, 16.2);
    const input = createLoopAnalysisInput(source, layout);
    assert.equal(layout.length, 64000 - 800);
    assert.equal(layout.ranges.length, 2);
    for (const time of [4.1, 16.2, 20]) {
        const { index } = analysisPoint(layout, time);
        if (time < 20) assert.equal(input.getChannelData(0)[index], left[Math.round(time * 4000)]);
    }
    assert.notEqual(input.getChannelData(0).buffer, left.buffer);
    structuredClone(input.getChannelData(0), { transfer: [input.getChannelData(0).buffer] });
    assert.equal(left.byteLength, 320000);
    assert.equal(right.byteLength, 320000);
});

test('analysis merges overlapping ranges and validates inputs', () => {
    const source = audio([repeated()]);
    const layout = describeLoopAnalysisInput(source, 1, 3);
    assert.equal(layout.ranges.length, 1);
    assert.equal(layout.length, 28000);
    assert.throws(() => analysisPoint(layout, 12), /outside/);
    for (const [a, b] of [[NaN, 4], [-1, 4], [4, 3], [0, 21], [1, 1.1]]) {
        assert.throws(() => describeLoopAnalysisInput(source, a, b), /range/);
    }
    assert.throws(() => describeLoopAnalysisInput(audio([], 0), 0, 1));
    assert.throws(() => restoreLoopAnalysisInput(layout, []), /Invalid/);
    assert.throws(() => createLoopAnalysisInput(audio([repeated(), new Float32Array(10)]),
        describeLoopAnalysisInput(audio([repeated(), new Float32Array(10)]), 1, 3)), /Mismatched/);
});

for (const mode of ['fast', 'balanced', 'full']) {
    test(`${mode}: gain changes cannot turn unrelated noise into a confident match`, () => {
        const data = noise(64000, 0.01);
        const quiet = findBestMatchByMode(audio([data]), 4.09, 12.14, mode);
        const loud = findBestMatchByMode(audio([data.map(v => v * 25)]), 4.09, 12.14, mode);
        assert.ok(quiet.confidence < 30, quiet.confidence);
        assert.ok(Math.abs(quiet.confidence - loud.confidence) < 0.01);
        assert.equal(quiet.start, loud.start);
        assert.equal(quiet.end, loud.end);
    });

    test(`${mode}: silence and DC are not loop evidence`, () => {
        for (const data of [new Float32Array(64000), new Float32Array(64000).fill(0.2)]) {
            const result = findBestMatchByMode(audio([data]), 4, 12, mode);
            assert.equal(result.confidence, 0);
            assert.equal(result.detail.reason, 'no-signal');
        }
    });

    test(`${mode}: repeated anti-phase stereo matches without cancellation`, () => {
        const left = repeated(), right = left.map(v => -v);
        const result = findBestMatchByMode(audio([left, right]), 4.09, 12.14, mode);
        assert.ok(result.confidence > 95, JSON.stringify(result));
        assert.ok(Math.abs(result.end - result.start - 8) < 1 / 4000);
        assert.equal(result.detail.checkedChannels, 2);
    });

    test(`${mode}: matching left cannot conceal an unrelated right channel`, () => {
        const result = findBestMatchByMode(audio([repeated(), noise(80000)]), 4.09, 12.14, mode);
        assert.ok(result.confidence < 30, result.confidence);
    });

    test(`${mode}: silent channel is ignored; file boundaries remain finite`, () => {
        const source = audio([repeated(), new Float32Array(80000)]);
        const result = findBestMatchByMode(source, 0, 20, mode);
        assert.ok(Number.isFinite(result.confidence));
        assert.ok(result.start >= 0 && result.end <= 20);
        assert.ok(result.end - result.start >= 0.25);
        assert.equal(result.detail.checkedChannels, 1);
        releaseAnalysisBuffer(source);
    });
}

test('native-rate refinement also works after 48 kHz downsampling', () => {
    const source = audio([repeated(48000)], 48000);
    const result = findBestMatchByMode(source, 4.09, 12.14);
    assert.ok(result.confidence > 95, JSON.stringify(result));
    assert.ok(Math.abs(result.end - result.start - 8) <= 1 / 48000);
});

test('a matching short fragment cannot bypass the longer-context check', () => {
    const data = noise(80000);
    data.set(data.slice(4 * 4000 - 240, 4 * 4000 + 240), 12 * 4000 - 240);
    for (const mode of ['fast', 'balanced', 'full']) {
        const result = findBestMatchByMode(audio([data]), 4, 12, mode);
        assert.ok(result.confidence < 30, JSON.stringify(result));
    }
});

test('non-finite samples fail explicitly without mutating the source', () => {
    const data = repeated();
    data[4000] = NaN;
    assert.throws(() => findBestMatchByMode(audio([data]), 1, 12), /Non-finite/);
    assert.ok(Number.isNaN(data[4000]));
});

test('prepared stereo windows and direct input produce identical results, including a new A/B region', () => {
    const left = repeated(), right = left.map(v => -v);
    const source = audio([left, right]);
    for (const [a, b] of [[4.09, 12.14], [6.05, 18.1]]) {
        const input = createLoopAnalysisInput(source, describeLoopAnalysisInput(source, a, b));
        const expected = findBestMatchByMode(source, a, b);
        const actual = findBestMatchByMode(input, a, b);
        for (const field of ['start', 'end', 'confidence', 'diff']) assert.equal(actual[field], expected[field]);
    }
    releaseAnalysisBuffer(source);
});

test('larger rough-point error and a non-integer downsample period still refine to the native sample', () => {
    const rate = 44100, period = 173219, motif = noise(period);
    const data = Float32Array.from({ length: rate * 20 }, (_, i) => motif[i % period]);
    const expectedLength = period * 2 / rate;
    for (const mode of ['fast', 'balanced', 'full']) {
        const result = findBestMatchByMode(audio([data], rate), 4.65, 4 + expectedLength - 0.47, mode);
        assert.ok(result.confidence > 95, JSON.stringify(result));
        assert.ok(Math.abs(result.end - result.start - expectedLength) < 1 / rate);
    }
});

test('joint endpoint refinement recovers a native period near both file boundaries', () => {
    const rate = 44100, period = 173219, motif = noise(period);
    const source = audio([Float32Array.from({ length: rate * 16 }, (_, i) => motif[i % period])], rate);
    for (const mode of ['fast', 'balanced', 'full']) {
        const result = findBestMatchByMode(source, 0.04, 15.97, mode);
        assert.equal(Math.round((result.end - result.start) * rate), period * 4);
        assert.ok(result.confidence >= 30);
        assert.ok(result.start >= 0 && result.end <= 16);
        releaseAnalysisBuffer(source);
    }
});

test('a sustained tone with several equally plausible periods does not auto-apply', () => {
    const rate = 4000;
    const data = Float32Array.from({ length: rate * 16 }, (_, i) => Math.sin(2 * Math.PI * 440 * i / rate));
    for (const mode of ['fast', 'balanced', 'full']) {
        const result = findBestMatchByMode(audio([data], rate), 3.09, 11.14, mode);
        assert.ok(result.confidence < 30);
        assert.equal(result.detail.reason, 'ambiguous');
    }
});

test('unknown matching modes use balanced behavior and incomplete prepared windows fail explicitly', () => {
    const source = audio([repeated()]);
    const balanced = findBestMatchByMode(source, 4.09, 12.14);
    const unknown = findBestMatchByMode(source, 4.09, 12.14, 'unknown');
    for (const field of ['start', 'end', 'confidence', 'diff']) assert.equal(unknown[field], balanced[field]);
    assert.equal(unknown.detail.algorithm, 'balanced');
    const input = createLoopAnalysisInput(source, describeLoopAnalysisInput(source, 4.09, 12.14));
    assert.throws(() => findBestMatchByMode(input, 5.09, 13.14), /outside prepared windows/);
});

for (const rate of [22050, 44100, 48000, 96000]) for (const gain of [1, 0.0001]) {
    test(`joint period refinement preserves stereo at ${rate} Hz and gain ${gain}`, () => {
        const period = Math.round(rate * 2.347) + 3, motif = noise(period, gain * 0.2);
        const left = Float32Array.from({ length: rate * 14 }, (_, i) => motif[i % period]);
        const source = audio([left, left.map(value => -value)], rate);
        for (const mode of ['fast', 'balanced', 'full']) {
            const result = findBestMatchByMode(source, 3.18, 3 + 2 * period / rate - 0.14, mode);
            assert.equal(Math.round((result.end - result.start) * rate), period * 2);
            assert.ok(result.confidence >= 30);
            releaseAnalysisBuffer(source);
        }
    });
}
