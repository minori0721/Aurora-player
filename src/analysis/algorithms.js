const monoAnalysisCache = new WeakMap();

const downsampleAnalysisCache = new WeakMap();

function getMonoAnalysisData(buffer) {
    const cached = monoAnalysisCache.get(buffer);
    if (cached) return cached;
    const chan0 = buffer.getChannelData(0);
    if (buffer.numberOfChannels === 1) {
        monoAnalysisCache.set(buffer, chan0);
        return chan0;
    }
    const chan1 = buffer.getChannelData(1);
    const mixed = new Float32Array(chan0.length);
    for (let i = 0; i < chan0.length; i++) mixed[i] = (chan0[i] + chan1[i]) * 0.5;
    monoAnalysisCache.set(buffer, mixed);
    return mixed;
}

function getDownsampledAnalysisData(buffer, targetRate = 6000) {
    let byRate = downsampleAnalysisCache.get(buffer);
    if (!byRate) {
        byRate = new Map();
        downsampleAnalysisCache.set(buffer, byRate);
    }
    if (byRate.has(targetRate)) return byRate.get(targetRate);

    const mono = getMonoAnalysisData(buffer);
    const sourceRate = buffer.sampleRate;
    const factor = Math.max(1, Math.floor(sourceRate / targetRate));
    const rate = sourceRate / factor;
    const length = Math.floor(mono.length / factor);
    const data = new Float32Array(length);

    for (let i = 0; i < length; i++) {
        const from = i * factor;
        let sum = 0;
        for (let j = 0; j < factor; j++) sum += mono[from + j] || 0;
        data[i] = sum / factor;
    }

    const result = { data, rate, factor };
    byRate.set(targetRate, result);
    return result;
}

function clampSampleIndex(index, length) {
    return Math.max(1, Math.min(length - 2, Math.round(index)));
}

function getWindowRms(data, start, size, sampleStep = 16) {
    const from = Math.max(0, Math.min(data.length - 1, start));
    const to = Math.max(from + 1, Math.min(data.length, from + size));
    let energy = 0;
    let count = 0;
    for (let i = from; i < to; i += sampleStep) {
        const value = data[i] || 0;
        energy += value * value;
        count++;
    }
    return count ? Math.sqrt(energy / count) : 0;
}

function scoreWindowPair(data, startA, startB, size, sampleStep, rmsFloor = 0.002) {
    const len = data.length;
    const fromA = Math.max(0, Math.min(len - 1, startA));
    const fromB = Math.max(0, Math.min(len - 1, startB));
    const usable = Math.max(0, Math.min(size, len - fromA, len - fromB));
    if (usable <= 0) return { error: Infinity, rms: rmsFloor, count: 0 };

    let mse = 0;
    let energyA = 0;
    let energyB = 0;
    let count = 0;
    for (let j = 0; j < usable; j += sampleStep) {
        const a = data[fromA + j] || 0;
        const b = data[fromB + j] || 0;
        const delta = a - b;
        mse += delta * delta;
        energyA += a * a;
        energyB += b * b;
        count++;
    }

    const rms = Math.max(Math.sqrt(Math.max(energyA, energyB) / Math.max(1, count)), rmsFloor);
    return {
        error: Math.sqrt(mse / Math.max(1, count)) / rms,
        rms,
        count
    };
}

function getRobustLoopError(values) {
    const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!finite.length) return 0;
    const mid = Math.floor(finite.length / 2);
    const median = finite.length % 2 ? finite[mid] : (finite[mid - 1] + finite[mid]) * 0.5;
    const trimmed = finite.slice(0, Math.max(1, Math.ceil(finite.length * 0.75)));
    const trimmedMean = trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
    return median * 0.7 + trimmedMean * 0.3;
}

function uniqueSampleCandidates(candidates, minDistance = 24) {
    const sorted = candidates
        .filter(v => Number.isFinite(v))
        .map(v => Math.round(v))
        .sort((a, b) => a - b);
    const result = [];
    for (const value of sorted) {
        if (!result.some(item => Math.abs(item - value) < minDistance)) result.push(value);
    }
    return result;
}

function collectGridCandidates(center, radius, dataLength, step) {
    const from = Math.max(1, center - radius);
    const to = Math.min(dataLength - 2, center + radius);
    const candidates = [center];
    for (let i = from; i <= to; i += step) candidates.push(i);
    candidates.push(to);
    return candidates;
}

function getLoopMatchModeLabel(mode) {
    if (mode === 'fast') return '速度优先';
    if (mode === 'full') return '准确优先';
    return '均衡推荐';
}

function createLoopMatchResult(start, end, confidence, startedAt, detail = {}) {
    const safeConfidence = Math.max(0, Math.min(100, Number.isFinite(confidence) ? confidence : 0));
    return {
        start,
        end,
        confidence: safeConfidence,
        diff: Math.max(0, Math.min(1, 1 - safeConfidence / 100)),
        elapsedMs: performance.now() - startedAt,
        detail
    };
}

function runFastLoopAttempt(buffer, timeA, timeB) {
    const chan0 = buffer.getChannelData(0);
    let data = chan0;
    if (buffer.numberOfChannels > 1) {
        data = getMonoAnalysisData(buffer);
    }

    const sr = buffer.sampleRate;
    const searchRadius = 3.0;
    const windowSize = Math.floor(0.15 * sr);
    const centerB = Math.floor(timeB * sr);
    const centerA = Math.floor(timeA * sr);
    const templateStart = centerB - windowSize;

    if (templateStart < 0 || centerB >= data.length) throw new Error("End point out of bounds");

    const startIdx = Math.max(0, centerA - Math.floor(searchRadius * sr));
    const endIdx = Math.min(centerB - windowSize * 2, centerA + Math.floor(searchRadius * sr));
    if (endIdx <= startIdx) throw new Error("Search range is too narrow");

    let bestOffset = -1;
    let minDiff = Infinity;
    const step = 4;

    for (let i = startIdx; i < endIdx; i += step) {
        let diff = 0;
        for (let j = 0; j < windowSize; j += 10) {
            const delta = data[i + j] - data[templateStart + j];
            diff += delta * delta;
            if (diff > minDiff) break;
        }
        if (diff < minDiff) {
            minDiff = diff;
            bestOffset = i;
        }
    }

    if (bestOffset < 0) throw new Error("No candidate found in search range");

    let fineBest = bestOffset;
    let fineMinDiff = Infinity;
    const fineRange = 200;

    for (let i = Math.max(0, bestOffset - fineRange); i <= Math.min(data.length - windowSize - 1, bestOffset + fineRange); i++) {
        let diff = 0;
        for (let j = 0; j < windowSize; j += 2) {
            const delta = data[i + j] - data[templateStart + j];
            diff += delta * delta;
        }
        if (diff < fineMinDiff) {
            fineMinDiff = diff;
            fineBest = i;
        }
    }

    const refinedA = fineBest + windowSize;
    const normalizedDiff = fineMinDiff / (windowSize / 2);
    const confidence = Math.max(0, Math.min(100, (1 - normalizedDiff) * 100));
    return {
        start: refinedA / sr,
        end: timeB,
        confidence,
        diff: normalizedDiff,
        detail: {
            algorithm: 'fast',
            fineMinDiff,
            windowSize,
            adjustedEnd: timeB
        }
    };
}

function findBestMatchFast(buffer, timeA, timeB) {
    const startedAt = performance.now();
    const attempts = [
        { bOffset: 0, label: 'B' },
        { bOffset: 0.1, label: 'B+0.1' },
        { bOffset: -0.1, label: 'B-0.1' }
    ];
    let best = null;

    for (const attempt of attempts) {
        const adjustedB = timeB + attempt.bOffset;
        if (adjustedB <= timeA) continue;
        let result;
        try {
            result = runFastLoopAttempt(buffer, timeA, adjustedB);
        } catch (e) {
            continue;
        }
        if (!best || result.confidence > best.confidence) {
            best = {
                ...result,
                attempt: attempt.label,
                attemptsRun: (best?.attemptsRun || 0) + 1
            };
        }
        if (result.confidence >= 99) break;
    }

    if (!best) throw new Error("No candidate found in search range");
    return createLoopMatchResult(best.start, best.end, best.confidence, startedAt, {
        ...best.detail,
        attempt: best.attempt
    });
}

function scoreLoopPair(data, startIdx, endIdx, sr, roughStartIdx, roughEndIdx, options = {}) {
    const len = data.length;
    const start = clampSampleIndex(startIdx, len);
    const end = clampSampleIndex(endIdx, len);
    const minLoopLength = Math.floor(0.25 * sr);
    const phaseWindow = options.phaseWindow ?? Math.max(1024, Math.floor(0.16 * sr));
    const sampleStep = options.sampleStep ?? 24;
    const maxMoveSamples = options.maxMoveSamples ?? Infinity;
    const postPhaseWeight = options.postPhaseWeight ?? 0;
    const postSampleStep = options.postSampleStep ?? Math.max(sampleStep, 24);
    const postSegmentCount = options.postSegmentCount ?? 3;
    const confidenceRiskWeight = options.confidenceRiskWeight ?? 0;
    if (
        end <= start + minLoopLength ||
        start < phaseWindow ||
        end < phaseWindow ||
        Math.abs(start - roughStartIdx) > maxMoveSamples ||
        Math.abs(end - roughEndIdx) > maxMoveSamples
    ) {
        return { score: Infinity, confidence: 0, start, end };
    }

    const startPre = start - phaseWindow;
    const endPre = end - phaseWindow;
    const preScore = scoreWindowPair(data, startPre, endPre, phaseWindow, sampleStep);
    const contextRms = preScore.rms;
    const phaseError = preScore.error;
    const postWindow = Math.min(phaseWindow, len - Math.max(start, end) - 2);
    let postPhaseError = 0;
    let postPhaseWorstError = 0;
    if (postPhaseWeight > 0 && postWindow >= Math.max(256, postSampleStep * 4)) {
        const segmentCount = Math.max(1, postSegmentCount);
        const segmentSize = Math.max(256, Math.floor(postWindow / segmentCount));
        const segmentStride = segmentCount > 1
            ? Math.max(1, Math.floor((postWindow - segmentSize) / (segmentCount - 1)))
            : 0;
        const postErrors = [];
        for (let i = 0; i < segmentCount; i++) {
            const offset = Math.min(postWindow - segmentSize, i * segmentStride);
            const segment = scoreWindowPair(data, start + offset, end + offset, segmentSize, postSampleStep);
            if (Number.isFinite(segment.error)) postErrors.push(segment.error);
        }
        postPhaseError = getRobustLoopError(postErrors);
        postPhaseWorstError = postErrors.length ? Math.max(...postErrors) : postPhaseError;
    }
    const startPrev = data[start - 1] || 0;
    const endPrev = data[end - 1] || 0;
    const start0 = data[start] || 0;
    const start1 = data[start + 1] || start0;
    const seamPrevError = Math.abs(endPrev - startPrev) / contextRms;
    const seamJumpError = Math.abs(start0 - endPrev) / contextRms;
    const slopeError = Math.abs((start1 - start0) - (start0 - endPrev)) / contextRms;
    const startDistanceSec = Math.abs(start - roughStartIdx) / sr;
    const endDistanceSec = Math.abs(end - roughEndIdx) / sr;
    const distanceSec = startDistanceSec + endDistanceSec;
    const maxDistanceSec = Math.max(startDistanceSec, endDistanceSec);
    const bothMovedSec = Math.min(startDistanceSec, endDistanceSec);
    const distancePenalty = distanceSec * (options.distanceWeight ?? 0.035);
    const roughLoopLengthSec = Math.max(0, (roughEndIdx - roughStartIdx) / sr);
    const loopLengthSec = (end - start) / sr;
    const lengthDeltaSec = Math.abs(loopLengthSec - roughLoopLengthSec);
    const lengthPenalty = lengthDeltaSec * (options.lengthWeight ?? 0);
    const postRisk = Math.max(0, postPhaseWorstError - postPhaseError, postPhaseError - 0.72);
    const lengthRisk = Math.max(0, lengthDeltaSec - 2.35);
    const roughMoveRisk = Math.max(0, maxDistanceSec - 2.05);
    const oneSidedLengthRisk = bothMovedSec < 0.12 ? Math.max(0, lengthDeltaSec - 1.1) : 0;
    const riskPenalty =
        postRisk * (options.postRiskWeight ?? 0.18) +
        lengthRisk * (options.lengthRiskWeight ?? 0.18) +
        roughMoveRisk * (options.moveRiskWeight ?? 0.12) +
        oneSidedLengthRisk * (options.oneSidedLengthRiskWeight ?? 1.35);

    const qualityScore =
        phaseError * 1.55 +
        postPhaseError * postPhaseWeight +
        seamPrevError * 0.9 +
        seamJumpError * 0.55 +
        slopeError * 0.18;
    const score = qualityScore + distancePenalty + lengthPenalty;
    const confidenceQuality = qualityScore + distancePenalty * 0.25 + riskPenalty * confidenceRiskWeight;
    const confidence = Math.max(0, Math.min(100, 100 * Math.exp(-confidenceQuality * 1.12)));

    return {
        score,
        confidence,
        start,
        end,
        detail: {
            phaseError,
            postPhaseError,
            postPhaseWorstError,
            seamPrevError,
            seamJumpError,
            slopeError,
            qualityScore,
            distancePenalty,
            lengthPenalty,
            riskPenalty,
            oneSidedLengthRisk,
            distanceSec,
            maxDistanceSec,
            bothMovedSec,
            lengthDeltaSec,
            contextRms
        }
    };
}

function insertRankedPair(candidates, candidate, limit, minDistance) {
    if (!Number.isFinite(candidate.score)) return;
    const duplicate = candidates.find(item =>
        Math.abs(item.start - candidate.start) < minDistance &&
        Math.abs(item.end - candidate.end) < minDistance
    );
    if (duplicate && duplicate.score <= candidate.score) return;
    if (duplicate) candidates.splice(candidates.indexOf(duplicate), 1);
    candidates.push(candidate);
    candidates.sort((a, b) => a.score - b.score);
    if (candidates.length > limit) candidates.length = limit;
}

function refineLoopPair(data, seed, sr, roughStart, roughEnd, options = {}) {
    let best = seed;
    const maxMoveSamples = options.maxMoveSamples ?? Infinity;
    const anchorStart = seed.start;
    const anchorEnd = seed.end;
    const passes = [
        { radius: Math.floor(0.18 * sr), step: Math.max(16, Math.floor(0.012 * sr)), sampleStep: 32, phaseWindow: Math.floor(0.16 * sr) },
        { radius: Math.floor(0.045 * sr), step: 16, sampleStep: 8, phaseWindow: Math.floor(0.14 * sr) },
        { radius: Math.floor(0.008 * sr), step: 1, sampleStep: 3, phaseWindow: Math.floor(0.10 * sr) }
    ];

    for (const pass of passes) {
        for (let repeat = 0; repeat < 2; repeat++) {
            if (!options.lockStart) {
                const startFrom = Math.max(anchorStart - pass.radius, roughStart - maxMoveSamples);
                const startTo = Math.min(anchorStart + pass.radius, roughStart + maxMoveSamples);
                for (let s = startFrom; s <= startTo; s += pass.step) {
                    const candidate = scoreLoopPair(data, s, best.end, sr, roughStart, roughEnd, {
                        ...pass,
                        maxMoveSamples,
                        postPhaseWeight: options.refinePostPhaseWeight ?? 0,
                        postSampleStep: options.refinePostSampleStep ?? Math.max(pass.sampleStep, 48)
                    });
                    if (candidate.score < best.score) best = candidate;
                }
            }

            if (!options.lockEnd) {
                const endFrom = Math.max(anchorEnd - pass.radius, roughEnd - maxMoveSamples);
                const endTo = Math.min(anchorEnd + pass.radius, roughEnd + maxMoveSamples);
                for (let e = endFrom; e <= endTo; e += pass.step) {
                    const candidate = scoreLoopPair(data, best.start, e, sr, roughStart, roughEnd, {
                        ...pass,
                        maxMoveSamples,
                        postPhaseWeight: options.refinePostPhaseWeight ?? 0,
                        postSampleStep: options.refinePostSampleStep ?? Math.max(pass.sampleStep, 48)
                    });
                    if (candidate.score < best.score) best = candidate;
                }
            }
        }
    }

    return scoreLoopPair(data, best.start, best.end, sr, roughStart, roughEnd, {
        sampleStep: 2,
        phaseWindow: Math.floor(0.12 * sr),
        postPhaseWeight: options.finalPostPhaseWeight ?? options.postPhaseWeight ?? 0,
        postSampleStep: options.finalPostSampleStep ?? 12,
        postSegmentCount: options.postSegmentCount,
        confidenceRiskWeight: options.confidenceRiskWeight ?? 0,
        maxMoveSamples
    });
}

function getSafeCandidateBoost(item) {
    const detail = item?.detail;
    if (!detail || !Number.isFinite(item.confidence)) return 0;
    if (item.confidence >= 80 || item.confidence < 23.5) return 0;
    if (detail.lengthDeltaSec > 0.75) return 0;
    if (detail.maxDistanceSec > 0.85 || detail.distanceSec > 1.25) return 0;
    if (detail.riskPenalty > 0.08 || detail.oneSidedLengthRisk > 0.02) return 0;
    if (detail.postPhaseError > 0.4 || detail.postPhaseWorstError > 1.05) return 0;
    if (detail.phaseError > 0.55 || detail.qualityScore > 1.32) return 0;

    let boost = 3.2;
    boost += Math.max(0, 0.75 - detail.lengthDeltaSec) * 2.2;
    boost += Math.max(0, 0.85 - detail.maxDistanceSec) * 2.0;
    boost += Math.max(0, 0.4 - detail.postPhaseError) * 4.0;
    boost += Math.max(0, 0.55 - detail.phaseError) * 3.0;
    return Math.min(10, boost);
}

function applySafeCandidateBoost(item) {
    const boost = getSafeCandidateBoost(item);
    if (boost <= 0) return item;
    return {
        ...item,
        confidence: Math.min(100, item.confidence + boost),
        detail: {
            ...item.detail,
            rawConfidence: item.confidence,
            safeCandidateBoost: boost
        }
    };
}

function chooseLoopCandidate(candidates) {
    const viable = candidates
        .filter(item => Number.isFinite(item.score))
        .map(applySafeCandidateBoost);
    if (!viable.length) return null;

    const riskRank = (item) => {
        const detail = item.detail || {};
        return (detail.riskPenalty || 0) * 0.18 +
            Math.max(0, (detail.postPhaseWorstError || 0) - 1.0) * 0.05;
    };
    const rank = (item, allowWideMove) =>
        item.detail.qualityScore +
        item.detail.distanceSec * 0.04 +
        item.detail.maxDistanceSec * 0.03 +
        item.detail.bothMovedSec * (allowWideMove ? 0.18 : 0.65) +
        item.detail.lengthDeltaSec * (allowWideMove ? 0.02 : 0.12) +
        riskRank(item);

    const reliable = viable.filter(item => item.confidence >= 30);
    const pool = reliable.length ? reliable : viable;
    const allowWideMove = reliable.length > 0;

    pool.sort((a, b) => {
        const rankA = rank(a, allowWideMove);
        const rankB = rank(b, allowWideMove);
        if (Math.abs(rankA - rankB) > 0.000001) return rankA - rankB;
        return b.confidence - a.confidence;
    });

    if (reliable.length) return pool[0];

    viable.sort((a, b) => {
        const rankA =
            a.detail.qualityScore +
            a.detail.distanceSec * 0.08 +
            a.detail.maxDistanceSec * 0.05 +
            a.detail.bothMovedSec * 0.65 +
            a.detail.lengthDeltaSec * (a.detail.qualityScore > 0.55 ? 0.22 : 0.08) +
            riskRank(a);
        const rankB =
            b.detail.qualityScore +
            b.detail.distanceSec * 0.08 +
            b.detail.maxDistanceSec * 0.05 +
            b.detail.bothMovedSec * 0.65 +
            b.detail.lengthDeltaSec * (b.detail.qualityScore > 0.55 ? 0.22 : 0.08) +
            riskRank(b);
        return rankA - rankB || b.confidence - a.confidence;
    });

    return viable[0];
}

function addScoredPair(candidates, data, start, end, sr, roughStart, roughEnd, flags, minDistance, limit = 160) {
    const candidate = scoreLoopPair(data, start, end, sr, roughStart, roughEnd, {
        sampleStep: 48,
        phaseWindow: Math.floor(0.14 * sr),
        distanceWeight: 0.04,
        maxMoveSamples: flags.maxMoveSamples
    });
    insertRankedPair(candidates, { ...candidate, ...flags }, limit, minDistance);
}

function scoreNccWindow(data, startA, startB, windowSize, sampleStep = 1) {
    if (startA < 0 || startB < 0 || startA + windowSize >= data.length || startB + windowSize >= data.length) {
        return -Infinity;
    }

    let sumA = 0;
    let sumB = 0;
    let sumAA = 0;
    let sumBB = 0;
    let sumAB = 0;
    let count = 0;

    for (let i = 0; i < windowSize; i += sampleStep) {
        const a = data[startA + i] || 0;
        const b = data[startB + i] || 0;
        sumA += a;
        sumB += b;
        sumAA += a * a;
        sumBB += b * b;
        sumAB += a * b;
        count++;
    }

    if (!count) return -Infinity;
    const numerator = sumAB - (sumA * sumB) / count;
    const energyA = sumAA - (sumA * sumA) / count;
    const energyB = sumBB - (sumB * sumB) / count;
    const denominator = Math.sqrt(Math.max(energyA * energyB, 1e-12));
    return denominator > 0 ? numerator / denominator : -Infinity;
}

function insertNccCandidate(candidates, candidate, limit, minDistance) {
    if (!Number.isFinite(candidate.ncc)) return;
    const duplicate = candidates.find(item =>
        Math.abs(item.start - candidate.start) < minDistance &&
        Math.abs(item.end - candidate.end) < minDistance
    );
    if (duplicate && duplicate.ncc >= candidate.ncc) return;
    if (duplicate) candidates.splice(candidates.indexOf(duplicate), 1);
    candidates.push(candidate);
    candidates.sort((a, b) => b.ncc - a.ncc);
    if (candidates.length > limit) candidates.length = limit;
}

function collectBalancedSeedsForRate(buffer, timeA, timeB, options = {}) {
    const { data, rate } = getDownsampledAnalysisData(buffer, options.targetRate || 6000);
    const sr = buffer.sampleRate;
    const roughStart = clampSampleIndex(timeA * rate, data.length);
    const roughEnd = clampSampleIndex(timeB * rate, data.length);
    const searchRadiusSec = Math.min(2.35, Math.max(2.18, (timeB - timeA) * 0.0175));
    const searchRadius = Math.floor(searchRadiusSec * rate);
    const step = Math.max(8, Math.floor(0.02 * rate));
    const fineStep = Math.max(2, Math.floor(0.006 * rate));
    const windowSize = Math.max(512, Math.floor(0.18 * rate));
    const minDistance = Math.max(4, Math.floor(0.025 * rate));
    const topLimit = options.topLimit || 28;
    const seeds = [];

    const addCandidate = (start, end, source, sampleStep = 1) => {
        const startPre = Math.round(start - windowSize);
        const endPre = Math.round(end - windowSize);
        const ncc = scoreNccWindow(data, startPre, endPre, windowSize, sampleStep);
        const distanceSec = (Math.abs(start - roughStart) + Math.abs(end - roughEnd)) / rate;
        const nccWithDistance = ncc - distanceSec * 0.025;
        insertNccCandidate(seeds, {
            start: Math.round(start),
            end: Math.round(end),
            ncc: nccWithDistance,
            rawNcc: ncc,
            source
        }, topLimit, minDistance);
    };

    for (let offset = -searchRadius; offset <= searchRadius; offset += step) {
        addCandidate(roughStart + offset, roughEnd + offset, 'shift', 2);
        addCandidate(roughStart + offset, roughEnd - offset, 'opposite', 2);
        addCandidate(roughStart + offset, roughEnd, 'locked-end', 2);
        addCandidate(roughStart, roughEnd + offset, 'locked-start', 2);
    }
    addCandidate(roughStart, roughEnd, 'exact', 1);

    const coarseSeeds = [...seeds];
    for (const seed of coarseSeeds.slice(0, Math.min(12, coarseSeeds.length))) {
        for (let ds = -step; ds <= step; ds += fineStep) {
            addCandidate(seed.start + ds, seed.end, seed.source + ':fine-start', 1);
            addCandidate(seed.start, seed.end + ds, seed.source + ':fine-end', 1);
            addCandidate(seed.start + ds, seed.end + ds, seed.source + ':fine-shift', 1);
        }
    }

    return seeds.map(seed => ({
        start: Math.round(seed.start / rate * sr),
        end: Math.round(seed.end / rate * sr),
        ncc: seed.ncc,
        rawNcc: seed.rawNcc,
        source: seed.source
    }));
}

function collectBalancedSeeds(buffer, timeA, timeB) {
    return collectBalancedSeedsForRate(buffer, timeA, timeB);
}

function canStopBalancedRefine(best, refinedCount) {
    if (!best || refinedCount < 8) return false;
    const detail = best.detail || {};
    if (best.confidence >= 94 && detail.maxDistanceSec <= 1.4) return true;
    return refinedCount >= 12 &&
        best.confidence >= 86 &&
        detail.maxDistanceSec <= 1.6 &&
        detail.lengthDeltaSec <= 0.9;
}

function findBestMatchBalanced(buffer, timeA, timeB) {
    const startedAt = performance.now();
    const data = getMonoAnalysisData(buffer);
    const sr = buffer.sampleRate;
    const roughStart = clampSampleIndex(timeA * sr, data.length);
    const roughEnd = clampSampleIndex(timeB * sr, data.length);
    const minLoopLength = Math.floor(0.25 * sr);
    if (roughEnd <= roughStart + minLoopLength) throw new Error("Search range is too narrow");

    const searchRadiusSec = Math.min(2.35, Math.max(2.18, (timeB - timeA) * 0.0175));
    const maxMoveSamples = Math.floor(searchRadiusSec * sr);
    const seeds = collectBalancedSeeds(buffer, timeA, timeB);
    const coarseCandidates = [];

    for (const seed of seeds) {
        const scored = scoreLoopPair(data, seed.start, seed.end, sr, roughStart, roughEnd, {
            sampleStep: 24,
            phaseWindow: Math.floor(0.14 * sr),
            distanceWeight: 0.04,
            postPhaseWeight: 0.75,
            postSampleStep: 48,
            postSegmentCount: 3,
            maxMoveSamples
        });
        if (!Number.isFinite(scored.score)) continue;
        insertRankedPair(
            coarseCandidates,
            { ...scored, ncc: seed.ncc, rawNcc: seed.rawNcc, source: seed.source },
            52,
            Math.max(24, Math.floor(0.01 * sr))
        );
    }

    const refineSeeds = coarseCandidates
        .filter(item => Number.isFinite(item.score))
        .sort((a, b) => a.score - b.score || b.confidence - a.confidence);
    const refinedCandidates = [];

    for (const scored of refineSeeds) {
        const refined = refineLoopPair(data, scored, sr, roughStart, roughEnd, {
            maxMoveSamples,
            refinePostPhaseWeight: 0.75,
            refinePostSampleStep: 48,
            finalPostPhaseWeight: 0.75,
            finalPostSampleStep: 16,
            postSegmentCount: 4,
            confidenceRiskWeight: 0.48
        });
        insertRankedPair(
            refinedCandidates,
            { ...refined, ncc: scored.ncc, rawNcc: scored.rawNcc, source: scored.source },
            36,
            Math.max(24, Math.floor(0.006 * sr))
        );
        const currentBest = chooseLoopCandidate(refinedCandidates);
        if (canStopBalancedRefine(currentBest, refinedCandidates.length)) break;
    }

    const best = chooseLoopCandidate(refinedCandidates);
    if (!best) throw new Error("No candidate found in search range");
    return createLoopMatchResult(best.start / sr, best.end / sr, best.confidence, startedAt, {
        ...best.detail,
        algorithm: 'balanced',
        seedCount: seeds.length,
        refineCount: refineSeeds.length,
        ncc: best.ncc,
        rawNcc: best.rawNcc,
        source: best.source,
    });
}

/**
 * 寻找最佳循环点：
 * A/B 是用户给出的粗点，函数会在附近搜索同相位边界。
 * 10 -> 130 和 9.712 -> 129.712 可能都是精确循环点，算法只按接缝质量和离粗点距离取最合适的那个。
 */
function findBestMatchFull(buffer, timeA, timeB) {
    const startedAt = performance.now();
    const data = getMonoAnalysisData(buffer);
    const sr = buffer.sampleRate;

    const roughStart = clampSampleIndex(timeA * sr, data.length);
    const roughEnd = clampSampleIndex(timeB * sr, data.length);
    const minLoopLength = Math.floor(0.25 * sr);
    if (roughEnd <= roughStart + minLoopLength) throw new Error("Search range is too narrow");

    const searchRadiusSec = Math.min(2.35, Math.max(2.18, (timeB - timeA) * 0.0175));
    const searchRadius = Math.floor(searchRadiusSec * sr);
    const maxMoveSamples = searchRadius;
    const coarseStep = Math.max(128, Math.floor(0.014 * sr));
    const minCandidateDistance = Math.max(64, Math.floor(0.025 * sr));
    const startCandidates = uniqueSampleCandidates(
        collectGridCandidates(roughStart, searchRadius, data.length, coarseStep),
        minCandidateDistance
    );
    const endCandidates = uniqueSampleCandidates(
        collectGridCandidates(roughEnd, searchRadius, data.length, coarseStep),
        minCandidateDistance
    );
    const crossStep = Math.max(192, Math.floor(0.045 * sr));
    const crossMinDistance = Math.max(64, Math.floor(0.04 * sr));
    const crossStartCandidates = uniqueSampleCandidates(
        collectGridCandidates(roughStart, searchRadius, data.length, crossStep),
        crossMinDistance
    );
    const crossEndCandidates = uniqueSampleCandidates(
        collectGridCandidates(roughEnd, searchRadius, data.length, crossStep),
        crossMinDistance
    );

    const coarseLockedEnd = [];
    const coarseLockedStart = [];
    const coarseShifted = [];
    const coarseOpposite = [];
    const coarseCross = [];
    const coarseExact = [];
    addScoredPair(coarseExact, data, roughStart, roughEnd, sr, roughStart, roughEnd, { maxMoveSamples }, minCandidateDistance, 8);

    for (const start of startCandidates) {
        addScoredPair(coarseLockedEnd, data, start, roughEnd, sr, roughStart, roughEnd, { lockEnd: true, maxMoveSamples }, minCandidateDistance);
    }
    for (const end of endCandidates) {
        addScoredPair(coarseLockedStart, data, roughStart, end, sr, roughStart, roughEnd, { lockStart: true, maxMoveSamples }, minCandidateDistance);
    }
    for (let offset = -searchRadius; offset <= searchRadius; offset += coarseStep) {
        addScoredPair(coarseShifted, data, roughStart + offset, roughEnd + offset, sr, roughStart, roughEnd, { shifted: true, maxMoveSamples }, minCandidateDistance, 48);
        addScoredPair(coarseOpposite, data, roughStart + offset, roughEnd - offset, sr, roughStart, roughEnd, { opposite: true, maxMoveSamples }, minCandidateDistance, 80);
    }
    addScoredPair(coarseShifted, data, roughStart + searchRadius, roughEnd + searchRadius, sr, roughStart, roughEnd, { shifted: true, maxMoveSamples }, minCandidateDistance, 48);
    addScoredPair(coarseOpposite, data, roughStart - searchRadius, roughEnd + searchRadius, sr, roughStart, roughEnd, { opposite: true, maxMoveSamples }, minCandidateDistance, 80);
    addScoredPair(coarseOpposite, data, roughStart + searchRadius, roughEnd - searchRadius, sr, roughStart, roughEnd, { opposite: true, maxMoveSamples }, minCandidateDistance, 80);
    addScoredPair(coarseExact, data, roughStart, roughEnd, sr, roughStart, roughEnd, { maxMoveSamples }, minCandidateDistance, 8);
    for (const start of crossStartCandidates) {
        for (const end of crossEndCandidates) {
            const candidate = scoreLoopPair(data, start, end, sr, roughStart, roughEnd, {
                sampleStep: 64,
                phaseWindow: Math.floor(0.12 * sr),
                distanceWeight: 0.055,
                maxMoveSamples
            });
            insertRankedPair(coarseCross, { ...candidate, cross: true, maxMoveSamples }, 160, crossMinDistance);
        }
    }

    const coarseBest = [
        ...coarseExact.slice(0, 4),
        ...coarseLockedEnd.slice(0, 32),
        ...coarseLockedStart.slice(0, 32),
        ...coarseShifted.slice(0, 18),
        ...coarseOpposite.slice(0, 80),
        ...coarseCross.slice(0, 160)
    ];
    if (!coarseBest.length) throw new Error("No candidate found in search range");

    const refinedCandidates = [];
    for (const candidate of coarseBest) {
        const refined = refineLoopPair(data, candidate, sr, roughStart, roughEnd, {
            lockStart: candidate.lockStart,
            lockEnd: candidate.lockEnd,
            maxMoveSamples
        });
        insertRankedPair(
            refinedCandidates,
            { ...refined, lockStart: candidate.lockStart, lockEnd: candidate.lockEnd, shifted: candidate.shifted },
            72,
            Math.max(24, Math.floor(0.006 * sr))
        );
    }
    const best = chooseLoopCandidate(refinedCandidates);
    if (!best) throw new Error("No candidate found in search range");

    return createLoopMatchResult(best.start / sr, best.end / sr, best.confidence, startedAt, {
        ...best.detail,
        algorithm: 'full',
        candidateCount: startCandidates.length * endCandidates.length,
        refinedCount: refinedCandidates.length
    });
}

function findBestMatchByMode(buffer, timeA, timeB, mode = 'balanced') {
    if (mode === 'fast') return findBestMatchFast(buffer, timeA, timeB);
    if (mode === 'full') return findBestMatchFull(buffer, timeA, timeB);
    return findBestMatchBalanced(buffer, timeA, timeB);
}

export function releaseAnalysisBuffer(buffer) {
    monoAnalysisCache.delete(buffer);
    downsampleAnalysisCache.delete(buffer);
}

export { findBestMatchBalanced, findBestMatchByMode, findBestMatchFast, findBestMatchFull, getLoopMatchModeLabel };
