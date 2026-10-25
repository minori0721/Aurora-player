import { analysisPoint, createLoopAnalysisInput, describeLoopAnalysisInput, LOOP_ANALYSIS_PADDING_SECONDS } from "./input.js";
import { clamp, decimate, correlationProfile, spectrumFeatures, featureSimilarity } from "./signal.js";
const preparedCache = new WeakMap();
const stateCache = new WeakMap();
export function getLoopMatchModeLabel(mode) {
    return mode === "fast" ? "速度优先" : mode === "full" ? "准确优先" : "均衡推荐";
}
function prepare(buffer, timeA, timeB) {
    let input = buffer;
    if (!buffer.analysisLayout) {
        const requestedLayout = describeLoopAnalysisInput(buffer, timeA, timeB);
        input = preparedCache.get(buffer);
        if (input?.analysisLayout.key !== requestedLayout.key) {
            input = createLoopAnalysisInput(buffer, requestedLayout);
            preparedCache.set(buffer, input);
        }
    }
    const layout = input.analysisLayout, sr = input.sampleRate;
    if (!Number.isFinite(timeA) || !Number.isFinite(timeB) || timeA < 0 || timeB > layout.sourceLength / sr || timeB - timeA < 0.25) throw new Error("Invalid analysis range");
    const key = `${Math.round(timeA * sr)}:${Math.round(timeB * sr)}`;
    let state = stateCache.get(input);
    if (state?.key === key) return state;
    const channels = Array.from({ length: input.numberOfChannels }, (_, c) => input.getChannelData(c));
    const variance = channels.map((data) => {
        let mean = 0, square = 0, n = 0;
        for (const value of data) {
            if (!Number.isFinite(value)) throw new Error("Non-finite analysis samples");
            n++;
            const delta = value - mean;
            mean += delta / n;
            square += delta * (value - mean);
        }
        return square / n;
    });
    const primary = variance.indexOf(Math.max(...variance));
    const active = variance.map((v, c) => v > Math.max(variance[primary] * 1e-6, 1e-20) ? c : -1).filter((c) => c >= 0);
    const padding = Math.ceil(LOOP_ANALYSIS_PADDING_SECONDS * sr);
    const slice = (time) => {
        const point = analysisPoint(layout, time), center = Math.round(time * sr);
        const start = Math.max(0, center - padding), end = Math.min(layout.sourceLength, center + padding);
        if (start < point.range.start || end > point.range.end) throw new Error("Analysis neighborhood outside prepared windows");
        const offset = point.range.offset + start - point.range.start;
        return { start, end, channels: channels.map((data) => data.subarray(offset, offset + end - start)) };
    };
    const wa = slice(timeA), wb = slice(timeB);
    const factor = Math.max(1, Math.floor(sr / 4e3)), rate = sr / factor;
    const lowA = active.map((c) => decimate(wa.channels[c], factor)), lowB = active.map((c) => decimate(wb.channels[c], factor));
    const primaryIndex = active.indexOf(primary), baseLength = wb.start - wa.start;
    const minLength = Math.max(Math.round(0.25 * sr), Math.round((timeB - timeA - 4) * sr)), maxLength = Math.round((timeB - timeA + 4) * sr);
    const profile = active.length ? correlationProfile(lowA[primaryIndex], lowB[primaryIndex], (minLength - baseLength) / factor, (maxLength - baseLength) / factor, Math.ceil(rate * 0.12)) : null;
    state = {
        key,
        input,
        layout,
        sr,
        channels,
        active,
        primary,
        wa,
        wb,
        factor,
        rate,
        lowA,
        lowB,
        profile,
        baseLength,
        minLength,
        maxLength,
        roughA: Math.round(timeA * sr),
        roughB: Math.round(timeB * sr),
        featuresA: null,
        featuresB: null
    };
    stateCache.set(input, state);
    return state;
}
function candidatePeriods(state, mode) {
    const { profile, factor, baseLength } = state;
    const pool = [];
    const add = (length, score, origin) => {
        if (length < state.minLength || length > state.maxLength || !Number.isFinite(score)) return;
        const duplicate = pool.findIndex((p) => Math.abs(p.length - length) < state.sr * 0.02);
        if (duplicate >= 0 && pool[duplicate].score >= score) return;
        if (duplicate >= 0) pool.splice(duplicate, 1);
        pool.push({ length, score, origin });
        pool.sort((left, right) =>
            right.score - Math.abs(right.length - (state.roughB - state.roughA)) / state.sr * 0.002
            - (left.score - Math.abs(left.length - (state.roughB - state.roughA)) / state.sr * 0.002));
        if (pool.length > 48) pool.length = 48;
    };
    for (let i = 1; i < profile.scores.length - 1; i++) if (profile.scores[i] >= profile.scores[i - 1] && profile.scores[i] >= profile.scores[i + 1]) add(baseLength + (profile.low + i) * factor, profile.scores[i], "correlation");
    // Musical context proposes periods; native waveform evidence still decides the result.
    state.featuresA ||= spectrumFeatures(state.lowA, state.rate);
    state.featuresB ||= spectrumFeatures(state.lowB, state.rate);
    const a = state.featuresA, b = state.featuresB, stride = mode === "fast" ? 4 : mode === "full" ? 1 : 2;
    const lowA = Math.max(0, Math.ceil((state.roughA - 2 * state.sr - state.wa.start) / (factor * a.hop)));
    const highA = Math.min(a.count - 1, Math.floor((state.roughA + 2 * state.sr - state.wa.start) / (factor * a.hop)));
    const lowB = Math.max(0, Math.ceil((state.roughB - 2 * state.sr - state.wb.start) / (factor * b.hop)));
    const highB = Math.min(b.count - 1, Math.floor((state.roughB + 2 * state.sr - state.wb.start) / (factor * b.hop)));
    const musical = [];
    for (let ia = lowA; ia <= highA; ia += stride) for (let ib = lowB; ib <= highB; ib += stride) {
        const point = featureSimilarity(a, b, ia, ib);
        if (!point || point.similarity < 0.85 || point.loudness > 8) continue;
        let best = 0;
        for (const direction of [-1, 1]) {
            let sum = point.similarity, n = 1;
            for (const seconds of [0.15, 0.35, 0.7, 1.2]) {
                const offset = Math.round(direction * seconds * state.rate / a.hop), next = featureSimilarity(a, b, ia + offset, ib + offset);
                if (next) {
                    sum += next.similarity;
                    n++;
                }
            }
            best = Math.max(best, sum / n);
        }
        const length = baseLength + (ib - ia) * factor * a.hop;
        const distance = Math.abs(state.wa.start + ia * factor * a.hop - state.roughA) / state.sr + Math.abs(state.wb.start + ib * factor * a.hop - state.roughB) / state.sr;
        const score = best - distance * 1e-3;
        if (musical.length >= 24 && score <= musical.at(-1).score) continue;
        const duplicate = musical.findIndex((p) => Math.abs(p.length - length) < state.sr * 0.015);
        if (duplicate >= 0 && musical[duplicate].score >= score) continue;
        if (duplicate >= 0) musical.splice(duplicate, 1);
        musical.push({ length, score });
        musical.sort((x, y) => y.score - x.score);
        if (musical.length > 24) musical.length = 24;
    }
    for (const candidate of musical.slice(0, mode === "fast" ? 4 : mode === "full" ? 16 : 8)) {
        const target = Math.round((candidate.length - baseLength) / factor - profile.low), radius = Math.ceil(state.rate * 0.025);
        let best = clamp(target, 0, profile.scores.length - 1);
        for (let i = Math.max(0, target - radius); i <= Math.min(profile.scores.length - 1, target + radius); i++) if (profile.scores[i] > profile.scores[best]) best = i;
        add(baseLength + (profile.low + best) * factor, profile.scores[best], "spectral");
    }
    return pool.slice(0, mode === "fast" ? 12 : mode === "full" ? 24 : 16);
}
function nativeCorrelation(state, length, from, to, step, channel) {
    const x = state.wa.channels[channel], y = state.wb.channels[channel];
    let sa = 0, sb = 0, aa = 0, bb = 0, ab = 0, diff = 0, n = 0;
    for (let i = from; i < to; i += step) {
        const a = x[i - state.wa.start], b = y[i + length - state.wb.start];
        sa += a;
        sb += b;
        aa += a * a;
        bb += b * b;
        ab += a * b;
        diff += (a - b) ** 2;
        n++;
    }
    const va = aa - sa * sa / n, vb = bb - sb * sb / n;
    if (n < 16 || va <= 1e-20 || vb <= 1e-20) return { ncc: -1, error: Infinity };
    return { ncc: clamp((ab - sa * sb / n) / Math.sqrt(va * vb), -1, 1), error: Math.sqrt(diff / Math.max(aa, bb, 1e-30)) };
}
function refinePeriod(state, seed) {
    const radius = state.factor * 3, center = Math.round(seed.length);
    // Keep the comparison interval fixed while refining the period at native sample resolution.
    const from = Math.max(state.wa.start, state.wb.start - center + radius) + 2;
    const to = Math.min(state.wa.end, state.wb.end - center - radius) - 2;
    const step = Math.max(1, Math.floor((to - from) / 1800));
    let best = null;
    for (let length = center - radius; length <= center + radius; length++) {
        if (length < state.minLength || length > state.maxLength) continue;
        const value = nativeCorrelation(state, length, from, to, step, state.primary);
        const rank = value.ncc - Math.abs(length - (state.roughB - state.roughA)) / state.sr * 2e-3;
        if (!best || rank > best.rank) best = { ...seed, length, ...value, rank, from, to };
    }
    if (!best) return null;
    let worst = 1;
    for (const channel of state.active) worst = Math.min(worst, nativeCorrelation(state, best.length, from, to, step, channel).ncc);
    best.worstNcc = worst;
    return best;
}
function phaseScore(state, a, length) {
    // Moving A moves B by the same amount: seam optimization must not change the period.
    const b = a + length;
    let risk = 0, jump = 0;
    for (const c of state.active) {
        const x = state.wa.channels[c], y = state.wb.channels[c], ia = a - state.wa.start, ib = b - state.wb.start;
        if (ia < 2 || ia + 2 >= x.length || ib < 2 || ib > y.length) return null;
        let energy = 0, derivative = 0, n = 0;
        const radius = Math.min(Math.round(state.sr * 0.025), ia - 1, ib - 1, x.length - ia - 2, y.length - ib);
        const step = Math.max(1, Math.floor(radius / 16));
        for (let k = -radius; k <= radius; k += step) {
            energy += x[ia + k] ** 2 + y[Math.min(y.length - 1, ib + k)] ** 2;
            derivative += (x[ia + k] - x[ia + k - 1]) ** 2 + (y[Math.min(y.length - 1, ib + k)] - y[Math.max(0, Math.min(y.length - 1, ib + k - 1))]) ** 2;
            n += 2;
        }
        const rms = Math.max(Math.sqrt(energy / Math.max(n, 1)), 1e-12), drms = Math.max(Math.sqrt(derivative / Math.max(n, 1)), rms * 0.01);
        const actualJump = Math.abs(x[ia] - y[ib - 1]) / drms;
        const replacement = ib < y.length ? Math.abs(x[ia] - y[ib]) / rms : 0;
        risk = Math.max(risk, Math.max(0, actualJump - 2.5) * 0.08 + replacement * 0.15);
        jump = Math.max(jump, actualJump);
    }
    const fa = (a - state.wa.start) / (state.factor * state.featuresA.hop), fb = (b - state.wb.start) / (state.factor * state.featuresB.hop);
    let music = 0;
    for (const direction of [-1, 1]) {
        let sum = 0, n = 0;
        for (const seconds of [0, 0.15, 0.4, 0.8]) {
            const offset = direction * seconds * state.rate / state.featuresA.hop;
            const value = featureSimilarity(state.featuresA, state.featuresB, fa + offset, fb + offset);
            if (value) {
                sum += value.similarity;
                n++;
            }
        }
        if (n) music = Math.max(music, sum / n);
    }
    const distance = (Math.abs(a - state.roughA) + Math.abs(b - state.roughB)) / state.sr;
    return { a, b, risk, jump, music, cost: risk + (1 - music) * 0.5 + distance * 2e-3 };
}
function refinePhase(state, period) {
    const low = Math.max(state.roughA - 2 * state.sr, state.roughB - 2 * state.sr - period.length, state.wa.start + 2, state.wb.start + 2 - period.length);
    const high = Math.min(state.roughA + 2 * state.sr, state.roughB + 2 * state.sr - period.length, state.wa.end - 3, state.wb.end - period.length);
    if (low > high) return null;
    const step = Math.max(1, Math.floor(state.sr * 1e-3));
    let best = null;
    for (let a = Math.ceil(low); a <= high; a += step) {
        const value = phaseScore(state, a, period.length);
        if (value && (!best || value.cost < best.cost)) best = value;
    }
    if (!best) return null;
    const anchor = best.a;
    for (let a = Math.max(Math.ceil(low), anchor - step); a <= Math.min(Math.floor(high), anchor + step); a++) {
        const value = phaseScore(state, a, period.length);
        if (value && value.cost < best.cost) best = value;
    }
    return { ...period, ...best };
}
export function findBestMatchByMode(buffer, timeA, timeB, mode = "balanced") {
    mode = mode === "fast" || mode === "full" ? mode : "balanced";
    const start = performance.now(), state = prepare(buffer, timeA, timeB);
    const baseDetail = { algorithm: mode, analysisBytes: state.channels.reduce((n, c) => n + c.byteLength, 0), sourceFrames: state.layout.sourceLength, analysisFrames: state.layout.length };
    const result = (candidate, scoreValue, reason, extra = {}) => ({
        start: candidate ? candidate.a / state.sr : timeA,
        end: candidate ? candidate.b / state.sr : timeB,
        confidence: scoreValue,
        diff: 1 - scoreValue / 100,
        elapsedMs: performance.now() - start,
        detail: { ...baseDetail, reason, ...extra }
    });
    if (!state.active.length) return result(null, 0, "no-signal");
    const seeds = candidatePeriods(state, mode), periods = [];
    for (const seed of seeds) {
        const value = refinePeriod(state, seed);
        if (value && !periods.some((p) => Math.abs(p.length - value.length) <= 2)) periods.push(value);
    }
    periods.sort((a, b) => b.rank - a.rank);
    const refined = [];
    for (const period of periods.slice(0, mode === "fast" ? 2 : mode === "full" ? 8 : 4)) {
        const candidate = refinePhase(state, period);
        if (candidate) refined.push(candidate);
    }
    refined.sort((a, b) => b.rank - a.rank + (a.cost - b.cost) * 0.015);
    const best = refined[0];
    if (!best) return result(null, 0, "no-informative-match");
    // Similar nearby periods are ambiguous even when a sustained tone correlates perfectly.
    const ambiguous = refined.some((p) => Math.abs(p.length - best.length) > state.sr * 0.02 && Math.abs(best.worstNcc - p.worstNcc) < 8e-3 && (best.worstNcc < 0.9 || Math.abs(p.length - best.length) < state.sr * 0.25));
    let confidence = 100 * clamp((best.worstNcc - 0.1) / 0.8, 0, 1);
    if (best.music < 0.75 || best.jump > 10 || ambiguous) confidence = Math.min(confidence, 29);
    return result(best, confidence, ambiguous ? "ambiguous" : confidence >= 30 ? "candidate" : "weak-repeat", {
        periodSamples: best.length,
        correlation: best.worstNcc,
        primaryCorrelation: best.ncc,
        musicSimilarity: best.music,
        hardSpliceJumpRatio: best.jump,
        phaseRisk: best.risk,
        checkedChannels: state.active.length,
        candidateCount: periods.length,
        scratchBytes: state.profile.scratchBytes,
        candidates: refined.slice(0, 5).map((p) => ({ length: p.length / state.sr, ncc: p.worstNcc, a: p.a / state.sr, b: p.b / state.sr }))
    });
}
export function releaseAnalysisBuffer(buffer) {
    const input = preparedCache.get(buffer);
    if (input) stateCache.delete(input);
    preparedCache.delete(buffer);
    stateCache.delete(buffer);
}
export const findBestMatchFast = (buffer, a, b) => findBestMatchByMode(buffer, a, b, "fast");
export const findBestMatchBalanced = (buffer, a, b) => findBestMatchByMode(buffer, a, b, "balanced");
export const findBestMatchFull = (buffer, a, b) => findBestMatchByMode(buffer, a, b, "full");
