export const LOOP_ANALYSIS_PADDING_SECONDS = 4;

export function describeLoopAnalysisInput(buffer, timeA, timeB) {
    const sampleRate = buffer?.sampleRate;
    const channelCount = buffer?.numberOfChannels;
    const sourceLength = buffer?.getChannelData?.(0)?.length;
    if (!Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 384000
        || !Number.isInteger(channelCount) || channelCount < 1 || channelCount > 32
        || !Number.isSafeInteger(sourceLength) || sourceLength < 4) throw new Error('Invalid analysis audio');
    if (!Number.isFinite(timeA) || !Number.isFinite(timeB) || timeA < 0
        || timeB > sourceLength / sampleRate || timeB - timeA < 0.25) throw new Error('Invalid analysis range');
    const padding = Math.ceil(LOOP_ANALYSIS_PADDING_SECONDS * sampleRate);
    const centers = [timeA, timeB].map(time => Math.round(time * sampleRate));
    const ranges = centers.map(center => ({ start: Math.max(0, center - padding), end: Math.min(sourceLength, center + padding) }));
    if (ranges[0].end >= ranges[1].start) {
        ranges[0].end = ranges[1].end;
        ranges.pop();
    }
    let length = 0;
    for (const range of ranges) {
        range.offset = length;
        length += range.end - range.start;
    }
    return { sampleRate, channelCount, sourceLength, length, ranges,
        key: [sampleRate, channelCount, sourceLength, ...ranges.flatMap(range => [range.start, range.end])].join(':') };
}

export function createLoopAnalysisInput(buffer, layout) {
    const channels = [];
    for (let channel = 0; channel < layout.channelCount; channel++) {
        const source = buffer.getChannelData(channel);
        if (source.length !== layout.sourceLength) throw new Error('Mismatched analysis channels');
        // Copy only the requested neighborhoods; playback buffers must never be transferred.
        const data = new Float32Array(layout.length);
        for (const range of layout.ranges) data.set(source.subarray(range.start, range.end), range.offset);
        channels.push(data);
    }
    return restoreLoopAnalysisInput(layout, channels);
}

export function restoreLoopAnalysisInput(layout, channels) {
    if (!layout || !Array.isArray(channels) || channels.length !== layout.channelCount
        || channels.some(channel => channel.length !== layout.length)) throw new Error('Invalid analysis window data');
    return { analysisLayout: layout, sampleRate: layout.sampleRate, numberOfChannels: channels.length,
        duration: layout.length / layout.sampleRate, length: layout.length, getChannelData: channel => channels[channel] };
}

export function analysisPoint(layout, time) {
    const sample = Math.round(time * layout.sampleRate);
    const range = layout.ranges.find(item => sample >= item.start && sample <= item.end);
    if (!range) throw new Error('Analysis point outside prepared windows');
    return { range, index: range.offset + sample - range.start };
}
