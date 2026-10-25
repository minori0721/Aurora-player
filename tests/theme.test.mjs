import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoverTheme, DEFAULT_THEME_BASE, DEFAULT_THEME_COLORS, parseThemeColor } from '../src/ui/theme.js';
import { coverThemeKey, createThemeCache } from '../src/ui/theme-cache.js';
import { createRender } from '../src/ui/render.js';

function pixelsOf(parts, count = 1000) {
    const pixels = new Uint8ClampedArray(count * 4);
    let offset = 0;
    for (const { rgb, fraction, alpha = 255 } of parts) {
        const end = Math.min(count, offset + Math.round(count * fraction));
        while (offset < end) { pixels.set([...rgb, alpha], offset * 4); offset++; }
    }
    return pixels;
}

const colorPart = (rgb, fraction = 1, alpha = 255) => ({ rgb, fraction, alpha });
const parseRgb = css => css.match(/\d+/g).slice(0, 3).map(Number);

test('theme colors parse emitted hex and rgb formats with bounded channels and safe fallback', () => {
    assert.deepEqual(parseThemeColor(DEFAULT_THEME_BASE), [245, 247, 250]);
    assert.deepEqual(parseThemeColor(' #AbC '), [170, 187, 204]);
    assert.deepEqual(parseThemeColor('RGB(12, 40, 180)'), [12, 40, 180]);
    assert.deepEqual(parseThemeColor('rgba(220, 100, 50, 0.4)'), [220, 100, 50, .4]);
    assert.deepEqual(parseThemeColor('rgba(-4, 270, 12, 2)'), [0, 255, 12, 1]);
    const fallback = [30, 60, 90];
    for (const invalid of [null, 5, '', 'bad', '#abcd', 'rgb(NaN,0,0)', 'rgb(,0,0)', 'rgba(1,2,3)', 'rgb(1,2,3,4)']) {
        assert.deepEqual(parseThemeColor(invalid, fallback), fallback);
        assert.notEqual(parseThemeColor(invalid, fallback), fallback);
    }
});

function lightness(css) {
    const [r, g, b] = parseRgb(css).map(channel => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2104542553 * Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        + 0.793617785 * Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        - 0.0040720468 * Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
}

function contrast(rgb) {
    const luminance = values => values.map(value => value / 255)
        .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    return (luminance(rgb) + 0.05) / (luminance([44, 62, 80]) + 0.05);
}

test('black, white, near-white and gray covers produce neutral backgrounds, not default purple', () => {
    for (const rgb of [[0, 0, 0], [255, 255, 255], [245, 245, 245], [128, 128, 128]]) {
        const theme = buildCoverTheme(pixelsOf([colorPart(rgb)]), rgb[0] === 255 ? null : [rgb]);
        assert.equal(theme.mode, 'neutral');
        assert.equal(theme.primary, null);
        assert.notDeepEqual(theme.colors, DEFAULT_THEME_COLORS);
        for (const color of theme.colors) {
            const [r, g, b] = parseRgb(color);
            assert.equal(r, g);
            assert.equal(g, b);
            assert.ok(contrast([r, g, b]) >= 4.5);
        }
    }
});

test('large black or white areas do not hide a supported red or blue accent', () => {
    for (const neutral of [[0, 0, 0], [255, 255, 255], [245, 245, 245]]) {
        for (const accent of [[210, 70, 70], [40, 80, 190]]) {
            const pixels = pixelsOf([colorPart(neutral, 0.8), colorPart(accent, 0.2)]);
            const theme = buildCoverTheme(pixels, [neutral, accent]);
            assert.equal(theme.mode, 'color');
            assert.deepEqual(theme.primary, accent);
            assert.ok(theme.strength > 0.9);
        }
    }
});

test('tiny colored text cannot turn an otherwise neutral cover into a saturated background', () => {
    for (const fraction of [0.001, 0.005, 0.01, 0.02]) {
        const theme = buildCoverTheme(pixelsOf([colorPart([255, 255, 255], 1 - fraction), colorPart([220, 20, 20], fraction)]), [[220, 20, 20]]);
        assert.equal(theme.mode, 'neutral');
    }
    const theme = buildCoverTheme(pixelsOf([colorPart([255, 255, 255], 0.95), colorPart([220, 20, 20], 0.05)]), [[220, 20, 20]]);
    assert.ok(theme.strength < 0.15);
});

test('pastels, dark chromatic covers and single colors keep their own hue', () => {
    for (const rgb of [[245, 205, 220], [245, 235, 155], [16, 24, 70], [70, 15, 25], [210, 70, 70], [25, 160, 60], [40, 80, 190]]) {
        const theme = buildCoverTheme(pixelsOf([colorPart(rgb)]), [rgb]);
        assert.equal(theme.mode, 'color', JSON.stringify(rgb));
        assert.deepEqual(theme.primary, rgb);
        for (const color of theme.colors) {
            const channels = parseRgb(color);
            assert.ok(channels.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255));
            assert.ok(contrast(channels) >= 4.5);
        }
    }
});

test('single-hue themes retain lightness separation so moving gradients remain visible', () => {
    for (const rgb of [[210, 70, 70], [25, 160, 60], [40, 80, 190], [245, 205, 220], [16, 24, 70]]) {
        const theme = buildCoverTheme(pixelsOf([colorPart(rgb)]), [rgb]);
        const levels = [0, 2, 3].map(index => lightness(theme.colors[index]));
        assert.ok(Math.max(...levels) - Math.min(...levels) >= 0.07, JSON.stringify(rgb));
        assert.deepEqual(theme.primary, rgb);
        assert.equal(theme.secondaryInfluence, 0);
        assert.ok(contrast(parseRgb(theme.base)) >= 4.5);
    }
});

test('neutral covers retain a restrained grayscale gradient rather than a flat fill', () => {
    for (const rgb of [[0, 0, 0], [128, 128, 128], [255, 255, 255]]) {
        const theme = buildCoverTheme(pixelsOf([colorPart(rgb)]), [rgb]);
        const levels = theme.colors.map(lightness);
        assert.ok(Math.max(...levels) - Math.min(...levels) >= 0.035, JSON.stringify(rgb));
        assert.equal(theme.mode, 'neutral');
    }
});

test('transparent borders do not supply false black populations', () => {
    const rgb = [40, 130, 210];
    const plain = buildCoverTheme(pixelsOf([colorPart(rgb)]), [rgb]);
    const bordered = buildCoverTheme(pixelsOf([colorPart([0, 0, 0], 0.8, 0), colorPart(rgb, 0.2)]), [rgb]);
    assert.deepEqual(bordered, plain);
});

test('similar candidates merge; palette order, duplicate entries and invalid entries are harmless', () => {
    const pixels = pixelsOf([colorPart([210, 70, 70], 0.6), colorPart([40, 80, 190], 0.4)]);
    const palette = [[210, 70, 70], [40, 80, 190], [211, 71, 71], [NaN, 0, 0], [-1, 0, 0], null];
    const one = buildCoverTheme(pixels, palette);
    assert.deepEqual(buildCoverTheme(pixels, [...palette].reverse()), one);
    assert.equal(one.mode, 'color');
    assert.notDeepEqual(one.primary, one.secondary);
});

test('missing or fully transparent input uses the no-cover theme and never throws', () => {
    for (const pixels of [null, [], [1, 2, 3], new Uint8ClampedArray(400)]) {
        const theme = buildCoverTheme(pixels, null);
        assert.equal(theme.mode, 'default');
        assert.deepEqual(theme.colors, DEFAULT_THEME_COLORS);
    }
    assert.doesNotThrow(() => buildCoverTheme([NaN, 20, 30, 255], [[NaN, 2, 3]]));
});

test('neutral-heavy multi-color photos preserve supported colors without a colored average', () => {
    const red = [210, 70, 70], blue = [40, 80, 190], white = [245, 245, 245];
    const theme = buildCoverTheme(pixelsOf([colorPart(white, 0.6), colorPart(red, 0.25), colorPart(blue, 0.15)]), [white, red, blue]);
    assert.deepEqual(theme.primary, red);
    assert.deepEqual(theme.secondary, blue);
    assert.equal(theme.colors.length, 4);
});

test('render clears every theme layer on missing/unreadable covers and releases its small canvas', () => {
    const saved = { window: globalThis.window, document: globalThis.document, ColorThief: globalThis.ColorThief, warn: console.warn };
    const properties = new Map();
    let failRead = false, warned = 0;
    const canvas = {
        getContext: () => ({
            drawImage() {},
            getImageData() {
                if (failRead) { const error = new Error('tainted'); error.name = 'SecurityError'; throw error; }
                return { data: pixelsOf([colorPart([210, 70, 70])]) };
            }
        })
    };
    try {
        globalThis.window = { matchMedia: () => ({ matches: false }) };
        globalThis.document = { createElement: () => canvas, body: { style: { setProperty: (name, value) => properties.set(name, value) } } };
        globalThis.ColorThief = class { getPalette() { return [[210, 70, 70]]; } };
        console.warn = () => warned++;
        const render = createRender({ dom: { el: { canvas } } });
        const img = { naturalWidth: 512, naturalHeight: 512 };
        render.updateTheme(img);
        assert.equal(properties.size, 5);
        assert.equal(canvas.width, 1);
        assert.equal(canvas.height, 1);
        render.updateTheme(null);
        assert.deepEqual([...properties.values()], [...DEFAULT_THEME_COLORS, DEFAULT_THEME_BASE]);
        render.updateTheme(img);
        failRead = true;
        render.updateTheme(img);
        assert.deepEqual([...properties.values()], [...DEFAULT_THEME_COLORS, DEFAULT_THEME_BASE]);
        assert.equal(warned, 1);
        assert.equal(canvas.width, 1);
        assert.equal(canvas.height, 1);
    } finally {
        for (const name of ['window', 'document', 'ColorThief']) {
            if (saved[name] === undefined) delete globalThis[name];
            else globalThis[name] = saved[name];
        }
        console.warn = saved.warn;
    }
});

test('related shades share population without merging distinct blue and purple families', () => {
    const blues = [[35, 65, 130], [65, 115, 190], [100, 150, 210]], purple = [140, 55, 155];
    const parts = [...blues.map(rgb => colorPart(rgb, 0.18)), colorPart(purple, 0.36), colorPart([245, 245, 245], 0.1)];
    const theme = buildCoverTheme(pixelsOf(parts), [...blues, purple, [245, 245, 245]]);
    assert.ok(blues.some(rgb => JSON.stringify(rgb) === JSON.stringify(theme.primary)));
    assert.ok(theme.primaryCoverage > 0.5);
    assert.deepEqual(theme.secondary, purple);
    assert.ok(theme.secondaryInfluence > 0.35 && theme.secondaryInfluence <= 0.5);
    assert.match(theme.colors[1], /^rgb\(/);
    assert.notEqual(theme.base, DEFAULT_THEME_BASE);
});

test('three supported families retain full-opacity tones and normalized population weights', () => {
    const blue = [71, 122, 178], warm = [188, 111, 84], green = [77, 100, 74];
    const theme = buildCoverTheme(pixelsOf([colorPart(blue, 0.41), colorPart(warm, 0.24), colorPart(green, 0.15), colorPart([245, 245, 245], 0.2)]), [blue, warm, green]);
    assert.deepEqual(theme.primary, blue);
    assert.deepEqual(theme.secondary, warm);
    assert.deepEqual(theme.tertiary, green);
    assert.ok(theme.colors.every(color => color.startsWith('rgb(')));
    assert.ok(Math.abs(theme.weights.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
    assert.ok(theme.weights[2] > 0.15);
    for (const color of theme.colors) assert.ok(contrast(parseRgb(color)) >= 4.5);
});

test('small saturated details cannot displace a broadly supported muted family', () => {
    const muted = [77, 100, 74], bright = [76, 167, 229];
    const theme = buildCoverTheme(pixelsOf([colorPart(muted, 0.6), colorPart(bright, 0.04), colorPart([245, 245, 245], 0.36)]), [muted, bright]);
    assert.deepEqual(theme.primary, muted);
    assert.equal(theme.tertiary, null);
    assert.deepEqual(theme.secondary, muted);
});

test('theme cache is bounded, least-recently-used and never retains full-size pixels or image objects', () => {
    const cache = createThemeCache(2);
    const source = { ...buildCoverTheme(pixelsOf([colorPart([40, 80, 190])]), [[40, 80, 190]]), pixels: new Uint8Array(4), image: {} };
    const first = cache.set('one', source);
    cache.set('two', source);
    assert.equal(cache.get('one'), first);
    cache.set('three', source);
    assert.equal(cache.get('two'), null);
    assert.equal(cache.size, 2);
    assert.equal('pixels' in first, false);
    assert.equal('image' in first, false);
    assert.equal(Object.isFrozen(first.colors), true);
    assert.notEqual(first.primary, source.primary);
    for (const limit of [-1, 0, NaN, Infinity]) {
        const bounded = createThemeCache(limit);
        for (let i = 0; i < 100; i++) bounded.set(String(i), source);
        assert.ok(bounded.size > 0 && bounded.size <= 16);
    }
});

test('theme cache retains at most sixteen fixed-size spatial samples by default', () => {
    const cache = createThemeCache();
    const theme = buildCoverTheme(pixelsOf([colorPart([40, 80, 190])]), [[40, 80, 190]]);
    for (let i = 0; i < 20; i++) {
        const spatial = { width: 64, height: 64, format: 'srgb-rgba8', data: new Uint8Array(16384), image: {} };
        const cached = cache.set(String(i), { ...theme, spatial });
        assert.equal(cached.spatial.data, spatial.data);
        assert.equal('image' in cached.spatial, false);
        assert.equal(Object.isFrozen(cached.spatial), true);
    }
    assert.equal(cache.size, 16);
    assert.equal(cache.get('3'), null);
    let bytes = 0;
    for (let i = 4; i < 20; i++) bytes += cache.get(String(i)).spatial.data.byteLength;
    assert.equal(bytes, 256 * 1024);
    const invalid = cache.set('bad', { ...theme, spatial: { width: 1024, height: 1024, data: new Uint8Array(4) } });
    assert.equal(invalid.spatial, undefined);
});

test('theme cache aliases reuse the owned immutable result without extending the LRU limit', () => {
    const cache = createThemeCache(2);
    const first = cache.set('one', buildCoverTheme(pixelsOf([colorPart([40, 80, 190])]), [[40, 80, 190]]));
    assert.equal(cache.set('two', first), first);
    assert.equal(cache.get('two'), first);
    assert.equal(cache.set('three', first), first);
    assert.equal(cache.get('one'), null);
    assert.equal(cache.size, 2);
});

test('identical spatial samples across URLs skip palette work and theme writes; distinct maps do not', () => {
    const saved = { window: globalThis.window, document: globalThis.document, ColorThief: globalThis.ColorThief };
    let reads = 0, palettes = 0, writes = 0, reverse = false;
    const canvas = { getContext: () => ({ drawImage() {}, getImageData() {
        reads++;
        const data = new Uint8ClampedArray(96 * 96 * 4);
        for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
            const red = (x < 48) !== reverse;
            data.set(red ? [200, 40, 40, 255] : [40, 60, 200, 255], (y * 96 + x) * 4);
        }
        return { data };
    } }) };
    try {
        globalThis.window = { matchMedia: () => ({ matches: false }) };
        globalThis.document = { createElement: () => canvas, body: { style: { setProperty() { writes++; } } } };
        globalThis.ColorThief = class { getPalette() { palettes++; return [[200, 40, 40], [40, 60, 200]]; } };
        const render = createRender({ dom: { el: { canvas } } });
        const image = { naturalWidth: 512, naturalHeight: 512, src: 'blob:first' };
        render.updateTheme(image);
        image.src = 'blob:second'; render.updateTheme(image);
        assert.equal(reads, 2); assert.equal(palettes, 1); assert.equal(writes, 5);
        render.updateTheme(image);
        assert.equal(reads, 2); assert.equal(palettes, 1); assert.equal(writes, 5);
        reverse = true; image.src = 'blob:reversed'; render.updateTheme(image);
        assert.equal(palettes, 2); assert.equal(writes, 10);
        assert.equal(canvas.width, 1); assert.equal(canvas.height, 1);
    } finally {
        for (const name of ['window', 'document', 'ColorThief']) {
            if (saved[name] === undefined) delete globalThis[name]; else globalThis[name] = saved[name];
        }
    }
});

test('cache keys unify only recognized NetEase thumbnail sizes and keep source identity', () => {
    const root = 'https://p4.music.126.net/cover.jpg';
    assert.equal(coverThemeKey(`${root}?param=512y512`), coverThemeKey(`${root}?param=1024y1024`));
    assert.notEqual(coverThemeKey(`${root}?revision=1`), coverThemeKey(`${root}?revision=2`));
    assert.notEqual(coverThemeKey(`${root}?param=512y1024`), coverThemeKey(`${root}?param=512y512`));
    assert.notEqual(coverThemeKey(`${root}?param=512y512&param=crop`), coverThemeKey(`${root}?param=512y512`));
    assert.notEqual(coverThemeKey('https://example.com/cover.jpg?param=512y512'), coverThemeKey('https://example.com/cover.jpg?param=1024y1024'));
    assert.notEqual(coverThemeKey('blob:https://example.com/one'), coverThemeKey('blob:https://example.com/two'));
    for (const source of ['', undefined, 'data:image/png;base64,AAAA', 'https://example.com/a.gif', 'https://example.com/a.webp', `https://example.com/${'a'.repeat(3000)}`]) assert.equal(coverThemeKey(source), null);
});

test('render reuses resized NetEase cover colors and does not repeat palette reads or unchanged CSS writes', () => {
    const saved = { window: globalThis.window, document: globalThis.document, ColorThief: globalThis.ColorThief };
    let reads = 0, writes = 0;
    const canvas = { getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixelsOf([colorPart([40, 80, 190])]) }) }) };
    try {
        globalThis.window = { matchMedia: () => ({ matches: false }) };
        globalThis.document = { createElement: () => canvas, body: { style: { setProperty: () => writes++ } } };
        globalThis.ColorThief = class { getPalette() { reads++; return [[40, 80, 190]]; } };
        const render = createRender({ dom: { el: { canvas } } });
        const img = { naturalWidth: 512, naturalHeight: 512, src: 'https://p4.music.126.net/one.jpg?param=512y512' };
        render.updateTheme(img);
        assert.equal(reads, 1); assert.equal(writes, 5);
        img.src = 'https://p4.music.126.net/one.jpg?param=1024y1024';
        render.updateTheme(img);
        assert.equal(reads, 1); assert.equal(writes, 5);
        render.updateTheme(null); render.updateTheme(img);
        assert.equal(reads, 1); assert.equal(writes, 15);
        img.src = 'https://p4.music.126.net/two.jpg?param=1024y1024';
        render.updateTheme(img);
        assert.equal(reads, 2); assert.equal(writes, 20);
    } finally {
        for (const name of ['window', 'document', 'ColorThief']) {
            if (saved[name] === undefined) delete globalThis[name];
            else globalThis[name] = saved[name];
        }
    }
});
