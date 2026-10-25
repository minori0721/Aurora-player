import test from 'node:test';
import assert from 'node:assert/strict';
import FFT from '../src/vendor/fft.mjs';
import { correlationProfile, decimate, featureSimilarity, spectrumFeatures } from '../src/analysis/signal.js';

function noise(length) {
    let seed = 732;
    return Float32Array.from({ length }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 32 - 0.5;
    });
}

function directCorrelation(a, b, lag) {
    let sa = 0, sb = 0, aa = 0, bb = 0, ab = 0, count = 0;
    for (let i = Math.max(0, -lag); i < Math.min(a.length, b.length - lag); i++) {
        const x = a[i], y = b[i + lag];
        sa += x; sb += y; aa += x * x; bb += y * y; ab += x * y; count++;
    }
    return (ab - sa * sb / count) / Math.sqrt((aa - sa * sa / count) * (bb - sb * sb / count));
}

test('vendored FFT forward and inverse agree with the direct transform', () => {
    const input = Float64Array.from([1, -2, 3, 0.5, 0, 2, -1, 0.25]);
    const fft = new FFT(input.length), spectrum = new Float64Array(input.length * 2);
    fft.realTransform(spectrum, input);
    fft.completeSpectrum(spectrum);
    for (let bin = 0; bin < input.length; bin++) {
        let real = 0, imaginary = 0;
        for (let i = 0; i < input.length; i++) {
            const angle = -2 * Math.PI * bin * i / input.length;
            real += input[i] * Math.cos(angle);
            imaginary += input[i] * Math.sin(angle);
        }
        assert.ok(Math.abs(spectrum[bin * 2] - real) < 1e-10);
        assert.ok(Math.abs(spectrum[bin * 2 + 1] - imaginary) < 1e-10);
    }
    const restored = new Float64Array(spectrum.length);
    fft.inverseTransform(restored, spectrum);
    for (let i = 0; i < input.length; i++) assert.ok(Math.abs(restored[i * 2] - input[i]) < 1e-10);
});

test('FFT correlation has the correct lag, local means and unequal overlap normalization', () => {
    const a = noise(257), b = new Float32Array(357);
    b.set(a.map(value => value * 2 + 0.3), 71);
    const { low, scores } = correlationProfile(a, b, -100, 100);
    for (let i = 0; i < scores.length; i++) assert.ok(Math.abs(scores[i] - directCorrelation(a, b, low + i)) < 1e-6);
    assert.equal(low + scores.indexOf(Math.max(...scores)), 71);
});

test('short but sufficient edge overlap remains a valid correlation candidate', () => {
    const a = noise(1000), b = noise(1000).reverse();
    b.set(a.subarray(0, 100), 900);
    assert.equal(correlationProfile(a, b, 900, 900).scores[0], -1);
    assert.ok(correlationProfile(a, b, 900, 900, 64).scores[0] > 0.99999);
});

test('low-pass decimation suppresses aliases without modifying the source', () => {
    const rate = 48000, size = rate / 2;
    const tone = frequency => Float32Array.from({ length: size }, (_, i) => Math.sin(2 * Math.PI * frequency * i / rate));
    const low = tone(440), high = tone(9000), original = high.slice();
    const rms = data => Math.sqrt(data.subarray(16, -16).reduce((sum, value) => sum + value * value, 0) / (data.length - 32));
    assert.ok(rms(decimate(high, 12)) < rms(decimate(low, 12)) * 0.02);
    assert.deepEqual(high, original);
});

test('interior and edge FIR paths are bit-exact with the checked-tap reference', () => {
    const reference = (data,factor) => {
        if(factor===1)return data;
        const radius=factor*4,cutoff=.45/factor,kernel=new Float64Array(radius*2+1);
        let sum=0;
        for(let i=-radius;i<=radius;i++){
            kernel[i+radius]=(i?Math.sin(2*Math.PI*cutoff*i)/(Math.PI*i):2*cutoff)*(.54+.46*Math.cos(Math.PI*i/radius));
            sum+=kernel[i+radius];
        }
        for(let i=0;i<kernel.length;i++)kernel[i]/=sum;
        const output=new Float32Array(Math.ceil(data.length/factor));
        for(let i=0;i<output.length;i++){
            let value=0;
            for(let j=0;j<kernel.length;j++){
                const index=i*factor+j-radius;
                if(index>=0&&index<data.length)value+=data[index]*kernel[j];
            }
            output[i]=value;
        }
        return output;
    };
    for(const factor of [1,5,11,12,24,48,96])for(const length of [1,13,512,8192]){
        const data=noise(length),copy=data.slice();
        assert.deepEqual(decimate(data,factor),reference(data,factor),`factor=${factor} length=${length}`);
        assert.deepEqual(data,copy);
    }
});

test('spectral power retains opposite-phase stereo and bounds feature lookups', () => {
    const left = noise(2048), right = left.map(value => -value);
    const mono = spectrumFeatures([left], 4000), stereo = spectrumFeatures([left, right], 4000);
    const value = featureSimilarity(mono, stereo, 20, 20);
    assert.ok(value.similarity > 0.99999);
    assert.ok(Math.abs(value.loudness - 10 * Math.log10(2)) < 0.001);
    assert.equal(featureSimilarity(mono, stereo, -1, 0), null);
    assert.equal(featureSimilarity(mono, stereo, mono.count, 0), null);
    assert.equal(featureSimilarity(mono, stereo, NaN, 0), null);
});
