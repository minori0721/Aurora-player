export const DEFAULT_THEME_COLORS = Object.freeze(['#e0c3fc', '#8ec5fc', '#a2d9ff', '#dcd6f7']);
export const DEFAULT_THEME_BASE = '#f5f7fa';

const linearRgb = Float64Array.from({ length: 256 }, (_, value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
});

const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const smoothstep = (low, high, value) => {
    const t = clamp((value - low) / (high - low));
    return t * t * (3 - 2 * t);
};

// CSS Color 4 Oklab conversion: score lightness and chroma independently of sRGB gamma.
function toOklab(red, green, blue, result = {}) {
    const r = linearRgb[Math.round(clamp(red, 0, 255))];
    const g = linearRgb[Math.round(clamp(green, 0, 255))];
    const b = linearRgb[Math.round(clamp(blue, 0, 255))];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    result.L = L; result.a = a; result.b = bb; result.C = Math.hypot(a, bb);
    return result;
}

function distanceSquared(one, two) {
    return (one.L - two.L) ** 2 + (one.a - two.a) ** 2 + (one.b - two.b) ** 2;
}

function neutralWeight(color) {
    const colorful = smoothstep(0.012, 0.08, color.C);
    const extreme = 1 - smoothstep(0.08, 0.22, color.L) + smoothstep(0.88, 0.98, color.L);
    return (0.08 + 0.92 * colorful) * (1 - 0.8 * (1 - colorful) * extreme);
}

function toLinearRgb(L, a, b) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    ];
}

function backgroundTone(color, L, chroma, opacity = 1) {
    const a = color?.C > 0 ? color.a / color.C : 0;
    const b = color?.C > 0 ? color.b / color.C : 0;
    let rgb = toLinearRgb(L, a * chroma, b * chroma);
    // Reduce chroma instead of clipping channels, which can change the cover's hue.
    if (rgb.some(channel => channel < 0 || channel > 1)) {
        let low = 0, high = chroma;
        for (let step = 0; step < 12; step++) {
            const middle = (low + high) / 2;
            const candidate = toLinearRgb(L, a * middle, b * middle);
            if (candidate.every(channel => channel >= 0 && channel <= 1)) low = middle;
            else high = middle;
        }
        rgb = toLinearRgb(L, a * low, b * low);
    }
    const bytes = rgb.map(channel => Math.round(255 * (channel <= 0.0031308 ? 12.92 * clamp(channel) : 1.055 * clamp(channel) ** (1 / 2.4) - 0.055)));
    return opacity < 1 ? `rgba(${bytes.join(',')},${opacity.toFixed(3)})` : `rgb(${bytes.join(',')})`;
}

function sameColorFamily(one, two) {
    if (one.C < 0.025 || two.C < 0.025) return distanceSquared(one, two) < 0.035 ** 2;
    return (one.a * two.a + one.b * two.b) / (one.C * two.C) >= Math.cos(25 * Math.PI / 180);
}

function rankColorFamilies(candidates) {
    const families = [];
    const supported = candidates.filter(color => color.C >= 0.018 && color.coverage > 0)
        .sort((one, two) => two.support - one.support || one.rgb[0] - two.rgb[0] || one.rgb[1] - two.rgb[1] || one.rgb[2] - two.rgb[2]);
    for (const color of supported) {
        // Complete-link grouping prevents a chain of nearby hues merging blue through green.
        let family = families.find(group => group.members.every(member => sameColorFamily(member, color)));
        if (!family) { family = { members: [], coverage: 0, support: 0 }; families.push(family); }
        family.members.push(color);
        family.coverage += color.coverage;
        family.support += color.support;
    }
    for (const family of families) {
        const costs = family.members.map(color => ({ color, cost: family.members.reduce((sum, member) => sum + member.support
            * (0.25 * (color.L - member.L) ** 2 + (color.a - member.a) ** 2 + (color.b - member.b) ** 2), 0) }));
        costs.sort((one, two) => one.cost - two.cost || two.color.support - one.color.support);
        family.color = costs[0].color;
        family.score = family.support ** 0.9 * smoothstep(0.015, 0.06, family.coverage);
    }
    const best = Math.max(0, ...families.map(family => family.score));
    return families.filter(family => family.coverage > 0.015 && family.score > 0)
        .sort((one, two) => {
            const close = one.score >= best * 0.95 && two.score >= best * 0.95;
            return (close ? two.coverage - one.coverage : two.score - one.score)
                || two.support - one.support || one.color.rgb[0] - two.color.rgb[0] || one.color.rgb[1] - two.color.rgb[1] || one.color.rgb[2] - two.color.rgb[2];
        });
}

export function buildCoverTheme(pixels, palette = []) {
    const fallback = () => ({ mode: 'default', base: DEFAULT_THEME_BASE, colors: [...DEFAULT_THEME_COLORS], primary: null, secondary: null, strength: 0 });
    if (!pixels?.length || pixels.length % 4 !== 0) return fallback();
    const candidates = [];
    const sorted = (Array.isArray(palette) ? palette : [])
        .filter(rgb => Array.isArray(rgb) && rgb.length >= 3 && rgb.slice(0, 3).every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 255))
        .map(rgb => rgb.slice(0, 3))
        .sort((one, two) => one[0] - two[0] || one[1] - two[1] || one[2] - two[2]);
    for (const rgb of sorted) {
        const lab = toOklab(...rgb);
        if (!candidates.some(color => distanceSquared(color, lab) < 0.03 ** 2)) candidates.push({ ...lab, rgb, weight: 0 });
    }
    // ColorThief omits pure white. Neutral anchors keep its pixels out of colored populations.
    const anchors = [[0, 0, 0], [128, 128, 128], [255, 255, 255]].map(rgb => ({ ...toOklab(...rgb), weight: 0 }));
    const population = [...candidates, ...anchors];
    const pixel = {};
    let total = 0, lightness = 0, colorfulPixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 3] < 125) continue;
        const color = toOklab(pixels[offset], pixels[offset + 1], pixels[offset + 2], pixel);
        if (!Number.isFinite(color.L)) continue;
        const alpha = pixels[offset + 3] / 255;
        total += alpha;
        lightness += color.L * alpha;
        colorfulPixels += smoothstep(0.018, 0.06, color.C) * alpha;
        let nearest = null, distance = Infinity;
        for (const candidate of population) {
            const delta = distanceSquared(candidate, color);
            if (delta < distance) { nearest = candidate; distance = delta; }
        }
        if (nearest && distance < 0.14 ** 2) nearest.weight += alpha;
    }
    if (!total) return fallback();
    const meanL = lightness / total;
    for (const color of candidates) {
        color.coverage = color.weight / total;
        color.support = color.coverage * neutralWeight(color) * (0.35 + 0.65 * smoothstep(0.018, 0.12, color.C));
    }
    const ranked = rankColorFamilies(candidates);
    const primaryFamily = ranked[0];
    const primary = primaryFamily?.color;
    const strength = primary ? smoothstep(0.025, 0.18, colorfulPixels / total) * smoothstep(0.015, 0.08, primaryFamily.coverage) : 0;
    if (!primary || strength < 0.01) {
        const base = 0.86 + 0.1 * meanL;
        return {
            mode: 'neutral', base: backgroundTone(null, base, 0), primary: null, secondary: null, strength: 0,
            colors: [base + 0.005, base - 0.05, base + 0.02, base - 0.025].map(L => backgroundTone(null, clamp(L, 0.84, 0.98), 0))
        };
    }
    const secondaryFamily = ranked.find(family => family !== primaryFamily && family.coverage >= 0.03
        && Math.hypot(family.color.a - primary.a, family.color.b - primary.b) >= 0.045);
    const secondary = secondaryFamily?.color || primary;
    const secondaryInfluence = secondaryFamily ? Math.min(0.5, secondaryFamily.support / (primaryFamily.support + secondaryFamily.support))
        * smoothstep(0.03, 0.1, secondaryFamily.coverage) : 0;
    const neutralBase = 0.86 + 0.1 * meanL;
    const base = neutralBase + (0.9 + 0.04 * meanL - neutralBase) * strength;
    const primaryChroma = Math.min(0.1, primary.C * 0.7) * strength;
    // Separate moving tones from the base even when the cover has only one hue.
    const lightnessSpread = 0.025 + 0.06 * strength;
    const tones = [
        [primary, base - lightnessSpread * 0.6, primaryChroma, 1],
        [secondary, base + 0.005, Math.min(primaryChroma * 0.9, secondary.C * 0.65 * strength), secondaryInfluence],
        [primary, base + 0.025, primaryChroma * 0.45, 1],
        [primary, base - lightnessSpread, primaryChroma * 0.9, 1]
    ];
    return {
        mode: 'color', primary: [...primary.rgb], secondary: [...secondary.rgb], strength,
        primaryCoverage: primaryFamily.coverage, secondaryCoverage: secondaryFamily?.coverage || 0, secondaryInfluence,
        base: backgroundTone(primary, base + 0.02, primaryChroma * 0.25),
        colors: tones.map(([color, L, chroma, opacity]) => backgroundTone(color, L, chroma, opacity))
    };
}
