export function periodicSignal(sampleRate = 4000) {
    const period = sampleRate * 4;
    const motif = new Float32Array(period);
    let seed = 173;
    for (let i = 0; i < period; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        motif[i] = (Math.sin(i * 0.071) + Math.sin(i * 0.019) * 0.5 + ((seed >>> 0) / 0xffffffff - 0.5) * 0.1) * 0.3;
    }
    const data = new Float32Array(sampleRate * 20);
    for (let i = 0; i < data.length; i++) data[i] = motif[i % period];
    return { sampleRate, numberOfChannels: 1, duration: 20, getChannelData: () => data };
}
