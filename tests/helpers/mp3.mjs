export function mp3Fixture({ tag = 'Info', bitrate = 192, id3 = 0 } = {}) {
    const rates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const frameSize = Math.floor(144000 * bitrate / 44100), offset = id3 ? 10 + id3 : 0;
    const bytes = new Uint8Array(offset + frameSize * 3);
    if (id3) bytes.set([73, 68, 51, 4, 0, 0, (id3 >> 21) & 127, (id3 >> 14) & 127, (id3 >> 7) & 127, id3 & 127]);
    for (let index = 0; index < 3; index++) bytes.set([255, 251, rates.indexOf(bitrate) << 4, 0], offset + frameSize * index);
    if (tag) {
        bytes.set([...tag].map(char => char.charCodeAt(0)), offset + 36);
        const view = new DataView(bytes.buffer);
        view.setUint32(offset + 40, 3); view.setUint32(offset + 44, 100); view.setUint32(offset + 48, 60000);
    }
    return bytes.buffer;
}
