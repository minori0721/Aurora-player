import FFT from "../vendor/fft.mjs";
const kernels = new Map();
export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export function decimate(data, factor) {
    if (factor === 1) return data;
    let kernel = kernels.get(factor);
    if (!kernel) {
        const filterRadius = factor * 4, cutoff = 0.45 / factor;
        kernel = new Float64Array(filterRadius * 2 + 1);
        let sum = 0;
        for (let i = -filterRadius; i <= filterRadius; i++) {
            kernel[i + filterRadius] = (i ? Math.sin(2 * Math.PI * cutoff * i) / (Math.PI * i) : 2 * cutoff) * (0.54 + 0.46 * Math.cos(Math.PI * i / filterRadius));
            sum += kernel[i + filterRadius];
        }
        for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
        kernels.set(factor, kernel);
    }
    const output = new Float32Array(Math.ceil(data.length / factor));
    const radius = (kernel.length - 1) / 2;
    for (let i = 0; i < output.length; i++) {
        let value = 0;
        const base = i * factor - radius;
        // Interior windows need one bounds check, not one per tap; accumulation order stays unchanged.
        if (base >= 0 && base + kernel.length <= data.length) {
            for (let j = 0; j < kernel.length; j++) value += data[base + j] * kernel[j];
        } else {
            for (let j = 0; j < kernel.length; j++) {
                const k = base + j;
                if (k >= 0 && k < data.length) value += data[k] * kernel[j];
            }
        }
        output[i] = value;
    }
    return output;
}
function prefix(data) {
    const sum = new Float64Array(data.length + 1), square = new Float64Array(data.length + 1);
    for (let i = 0; i < data.length; i++) {
        sum[i + 1] = sum[i] + data[i];
        square[i + 1] = square[i] + data[i] ** 2;
    }
    return { sum, square };
}
export function correlationProfile(a, b, minLag, maxLag, minimumOverlap = Math.min(a.length, b.length) * 0.25) {
    // Reverse A for linear convolution; prefix sums normalize each lag's actual overlap.
    let size = 2;
    while (size < a.length + b.length) size *= 2;
    const fft = new FFT(size), input = new Float64Array(size);
    const fa = new Float64Array(size * 2), fb = new Float64Array(size * 2), output = new Float64Array(size * 2);
    for (let i = 0; i < a.length; i++) input[i] = a[a.length - 1 - i];
    fft.realTransform(fa, input);
    fft.completeSpectrum(fa);
    input.fill(0);
    input.set(b);
    fft.realTransform(fb, input);
    fft.completeSpectrum(fb);
    for (let i = 0; i < fa.length; i += 2) {
        const real = fa[i] * fb[i] - fa[i + 1] * fb[i + 1];
        fa[i + 1] = fa[i] * fb[i + 1] + fa[i + 1] * fb[i];
        fa[i] = real;
    }
    fft.inverseTransform(output, fa);
    const pa = prefix(a), pb = prefix(b);
    const low = Math.max(-a.length + 1, Math.ceil(minLag)), high = Math.min(b.length - 1, Math.floor(maxLag));
    const scores = new Float32Array(Math.max(0, high - low + 1));
    scores.fill(-1);
    for (let lag = low; lag <= high; lag++) {
        const start = Math.max(0, -lag), end = Math.min(a.length, b.length - lag), count = end - start;
        if (count < minimumOverlap || count < 32) continue;
        const sa = pa.sum[end] - pa.sum[start], sb = pb.sum[end + lag] - pb.sum[start + lag];
        const aa = pa.square[end] - pa.square[start] - sa * sa / count;
        const bb = pb.square[end + lag] - pb.square[start + lag] - sb * sb / count;
        if (aa <= 1e-20 || bb <= 1e-20) continue;
        scores[lag - low] = clamp((output[(a.length - 1 + lag) * 2] - sa * sb / count) / Math.sqrt(aa * bb), -1, 1);
    }
    return { low, scores, scratchBytes: input.byteLength + fa.byteLength + fb.byteLength + output.byteLength + pa.sum.byteLength + pa.square.byteLength + pb.sum.byteLength + pb.square.byteLength };
}
export function spectrumFeatures(channels, rate) {
    const size = 512, hop = 32, dimensions = 29;
    const fft = new FFT(size), input = new Float64Array(size), spectrum = new Float64Array(size * 2);
    const power = new Float64Array(size / 2 + 1), window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));
    const count = Math.max(1, Math.ceil(channels[0].length / hop));
    const features = new Float32Array(count * dimensions);
    const chroma = new Int16Array(power.length), band = new Int16Array(power.length);
    for (let bin = 1; bin < power.length; bin++) {
        const frequency = bin * rate / size;
        chroma[bin] = (Math.round(69 + 12 * Math.log2(frequency / 440)) % 12 + 12) % 12;
        band[bin] = clamp(Math.floor(Math.log2(Math.max(40, frequency) / 40) / Math.log2(rate / 80) * 16), 0, 15);
    }
    for (let frame = 0; frame < count; frame++) {
        power.fill(0);
        // Sum spectral power rather than waveforms so opposite-phase channels cannot cancel.
        for (const data of channels) {
            const start = frame * hop - size / 2;
            for (let i = 0; i < size; i++) input[i] = (data[start + i] || 0) * window[i];
            fft.realTransform(spectrum, input);
            for (let bin = 1; bin < power.length; bin++) power[bin] += spectrum[bin * 2] ** 2 + spectrum[bin * 2 + 1] ** 2;
        }
        const offset = frame * dimensions;
        let energy = 0;
        for (let bin = 1; bin < power.length; bin++) {
            const value = power[bin];
            energy += value;
            features[offset + chroma[bin]] += value;
            features[offset + 12 + band[bin]] += value;
        }
        for (const [from, to] of [[0, 12], [12, 28]]) {
            let norm = 0;
            for (let i = from; i < to; i++) {
                const v = Math.sqrt(features[offset + i]);
                features[offset + i] = v;
                norm += v * v;
            }
            norm = Math.sqrt(norm);
            if (norm) for (let i = from; i < to; i++) features[offset + i] /= norm;
        }
        features[offset + 28] = Math.log(Math.max(energy, 1e-30)) * 10 / Math.LN10;
    }
    return { data: features, count, dimensions, hop, rate };
}
export function featureSimilarity(a, b, ia, ib) {
    if (!Number.isFinite(ia) || !Number.isFinite(ib)) return null;
    ia = Math.round(ia);
    ib = Math.round(ib);
    if (ia < 0 || ib < 0 || ia >= a.count || ib >= b.count) return null;
    const x = ia * a.dimensions, y = ib * b.dimensions;
    let chroma = 0, bands = 0;
    for (let i = 0; i < 12; i++) chroma += a.data[x + i] * b.data[y + i];
    for (let i = 12; i < 28; i++) bands += a.data[x + i] * b.data[y + i];
    const loudness = Math.abs(a.data[x + 28] - b.data[y + 28]);
    return { similarity: 0.6 * chroma + 0.4 * bands, loudness };
}
