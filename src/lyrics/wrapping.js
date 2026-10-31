const MAX_TEXT = 768, MAX_GROUPS = 48, MAX_BLOCKS = 1024, MAX_CHARACTERS = 32000;
const BATCH_SIZE = 16, CACHE_LIMIT = 128;
const SPACE = /[ \t\u3000]/u;
const GLUE = /[\u00a0\u202f]/u;
const CLOSING = /[」』）\]})”’»]/u;
const ENDING = /[，。、！？；：,.!?;:…‥]/u;
const DIGIT = /\p{Nd}/u;
const LATIN = /\p{Script=Latin}/u;
const LATIN_WORD = /[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{M}\p{N}'\u2019-]*/gu;
const WORD_SPACE = /^[ \t\u3000\u00a0\u202f]+$/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const RTL = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;

function punctuationAt(text, index) {
    const char = text[index];
    if (char === ':' || char === '：') return !DIGIT.test(text[index - 1] || '') || !DIGIT.test(text[index + 1] || '');
    if (/[，。、！？；!?;]/u.test(char)) return true;
    if (char === ',') return !/\d/u.test(text[index - 1] || '') || !/\d/u.test(text[index + 1] || '');
    // Keep decimals, versions, initials, ellipses and dotted names intact.
    return char === '.' && index > 0 && !/[\d.]/u.test(text[index - 1])
        && (index + 1 === text.length || SPACE.test(text[index + 1]) || CLOSING.test(text[index + 1]));
}

function phraseBoundaries(text) {
    if (typeof text !== 'string' || text.length > MAX_TEXT || /[\r\n]/u.test(text) || RTL.test(text)) return [];
    const ranges = [];
    let start = 0, index = 0;
    while (index < text.length) {
        if (SPACE.test(text[index])) {
            if (start < index) ranges.push([start, index]);
            while (index < text.length && SPACE.test(text[index])) index++;
            start = index;
        } else if (punctuationAt(text, index)) {
            index++;
            while (index < text.length && (CLOSING.test(text[index]) || ENDING.test(text[index]))) index++;
            if (start < index) ranges.push([start, index]);
            start = index;
        } else index += text.codePointAt(index) > 0xffff ? 2 : 1;
    }
    if (start < text.length) ranges.push([start, text.length]);
    if (ranges.length > MAX_GROUPS) return [];
    const glued = GLUE.test(text), protectedRanges = glued ? [] : ranges;
    if (glued) for (const range of ranges) {
        const previous = protectedRanges[protectedRanges.length - 1];
        if (previous && GLUE.test(text.slice(previous[1] - 1, range[0] + 1))) previous[1] = range[1];
        else protectedRanges.push([...range]);
    }
    return protectedRanges;
}

function protectLatinRanges(text, ranges) {
    if (ranges.length < 2 || !LATIN.test(text)) return ranges;
    const runs = [];
    let run = null;
    for (const match of text.matchAll(LATIN_WORD)) {
        const start = match.index, end = start + match[0].length, latin = LATIN.test(match[0]);
        if (run && WORD_SPACE.test(text.slice(run.end, start))) {
            run.end = end; run.latin ||= latin; run.joined = true;
        } else {
            if (run?.joined && run.latin) runs.push([run.start, run.end]);
            run = { start, end, latin, joined: false };
        }
    }
    if (run?.joined && run.latin) runs.push([run.start, run.end]);
    const merged = [];
    let index = 0;
    for (const range of ranges) {
        const previous = merged[merged.length - 1];
        while (previous && index < runs.length && runs[index][1] <= previous[1]) index++;
        // A run can start inside a mixed-language group; only its internal boundaries are protected.
        if (previous && index < runs.length && runs[index][0] < previous[1] && runs[index][1] > range[0]) previous[1] = range[1];
        else merged.push([...range]);
    }
    return merged;
}

export function lyricPhraseRanges(text, joinLatin = true) {
    const ranges = phraseBoundaries(text);
    return joinLatin ? protectLatinRanges(text, ranges) : ranges;
}

export function lyricWrapCandidates(text) {
    if (typeof text !== 'string' || !CJK.test(text)) return [];
    const ranges = phraseBoundaries(text);
    const candidates = [protectLatinRanges(text, ranges)];
    // With a protected join, a weaker plan could strand the first/last word of a Latin run.
    if (!GLUE.test(text)) candidates.push(ranges);
    const seen = new Set();
    return candidates.filter(ranges => {
        if (ranges.length < 2) return false;
        const key = JSON.stringify(ranges);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function timedPhraseCuts(text, ranges, lengths) {
    const ends = [];
    let offset = 0;
    for (const length of lengths) { offset += length; ends.push(offset); }
    if (offset !== text.length) return [];
    const cuts = [];
    for (let index = 0; index + 1 < ranges.length; index++) {
        const low = ranges[index][1], high = ranges[index + 1][0];
        const at = ends.findIndex(end => end >= low && end <= high);
        if (at >= 0 && at + 1 < lengths.length && cuts[cuts.length - 1] !== at + 1) cuts.push(at + 1);
    }
    return cuts;
}

const STYLE_PROPERTIES = ['fontFamily', 'fontSize', 'fontStyle', 'fontStretch', 'fontVariant', 'fontFeatureSettings',
    'fontVariationSettings', 'fontKerning', 'letterSpacing', 'wordSpacing', 'lineHeight', 'whiteSpace', 'textTransform',
    'textAlign', 'direction', 'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle'];

export function createLyricWrapping(content, { environment = window, document: doc = document } = {}) {
    let records = [], fingerprint = '', lineOrder = new WeakMap();
    const processed = new Set(), cache = new Map();

    function restore(record) {
        if (record.applied && record.element.textContent === record.text) record.element.replaceChildren(...record.children);
        record.applied = false;
    }

    function reset() {
        records.forEach(restore);
        records = [];
        fingerprint = '';
        lineOrder = new WeakMap();
        processed.clear(); cache.clear();
    }

    function refresh(lines = []) {
        reset();
        lines.forEach((line, index) => lineOrder.set(line, index));
        let characters = 0;
        for (const element of content.querySelectorAll('.lyric-original, .lyric-translation')) {
            const text = element.textContent || '', candidates = lyricWrapCandidates(text);
            if (!candidates.length) continue;
            if (records.length >= MAX_BLOCKS || characters + text.length > MAX_CHARACTERS) break;
            const children = [...element.childNodes];
            const timed = children.some(node => node.nodeType === 1);
            if (timed && (children.length > 96 || children.some(node => node.nodeType !== 3 && !node.classList?.contains('yrc-char')))) continue;
            const plans = candidates.map(ranges => timed ? timedPhraseCuts(text, ranges, children.map(node => node.textContent.length)) : ranges)
                .filter(plan => timed ? plan.length > 0 : plan.length > 1);
            if (!plans.length) continue;
            characters += text.length;
            const line = element.closest('.lyric-line');
            records.push({ element, text, children, timed, plans, applied: false, line, position: lineOrder.get(line) ?? -1 });
        }
    }

    function paint(element, record, plan, clone = false) {
        const fragment = doc.createDocumentFragment();
        const group = nodes => {
            const span = doc.createElement('span');
            span.className = 'lyric-phrase';
            for (const node of nodes) span.appendChild(node);
            fragment.appendChild(span);
        };
        if (record.timed) {
            let start = 0;
            for (const end of [...plan, record.children.length]) {
                const nodes = record.children.slice(start, end).map(node => clone ? node.cloneNode(true) : node);
                if (nodes.length === 1) fragment.appendChild(nodes[0]);
                else group(nodes);
                start = end;
            }
        } else {
            let offset = 0;
            for (const [start, end] of plan) {
                if (start > offset) fragment.appendChild(doc.createTextNode(record.text.slice(offset, start)));
                group([doc.createTextNode(record.text.slice(start, end))]);
                offset = end;
            }
            if (offset < record.text.length) fragment.appendChild(doc.createTextNode(record.text.slice(offset)));
        }
        element.replaceChildren(fragment);
    }

    function probe(record, style, weight, host, plan = null) {
        const node = record.element.cloneNode(true);
        for (const property of STYLE_PROPERTIES) node.style[property] = style[property];
        Object.assign(node.style, { width: style.width, maxWidth: 'none', minWidth: '0', height: 'auto', maxHeight: 'none',
            position: 'relative', display: 'block', transform: 'none', fontWeight: weight });
        if (plan) paint(node, record, plan, true);
        host.appendChild(node);
        return node;
    }

    function size(node) {
        return { height: node.getBoundingClientRect().height, overflow: node.scrollWidth > node.clientWidth + 1 };
    }

    function nearestRecord(anchor) {
        const position = lineOrder.get(anchor);
        if (position === undefined) return Math.max(0, records.findIndex(record => record.line === anchor));
        // Native-only lines have no record; locate their neighbours in the original row order.
        let low = 0, high = records.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (records[mid].position < position) low = mid + 1;
            else high = mid;
        }
        if (low > 0 && (low === records.length || position - records[low - 1].position < records[low].position - position)) low--;
        return low;
    }

    function layout(anchor = null) {
        if (!records.length || doc.hidden) return false;
        const first = records[0].element, style = environment.getComputedStyle(first);
        const key = [content.clientWidth, style.fontSize, style.fontFamily, style.letterSpacing, style.lineHeight].join('|');
        if (key !== fingerprint) {
            fingerprint = key;
            records.forEach(restore);
            processed.clear(); cache.clear();
        }
        const index = nearestRecord(anchor);
        const targets = records.slice(Math.max(0, index - 4), Math.max(0, index - 4) + BATCH_SIZE)
            .filter(record => !processed.has(record) && record.element.isConnected);
        if (!targets.length) return false;
        const jobs = targets.map(record => {
            const style = environment.getComputedStyle(record.element);
            const weights = record.element.classList.contains('lyric-original') ? ['400', '800'] : [style.fontWeight];
            const key = JSON.stringify([record.text, record.timed, style.width, weights, STYLE_PROPERTIES.map(property => style[property]),
                record.children.map(node => [node.nodeType, node.nodeType === 1 ? node.className : '', node.textContent.length,
                    node.style?.font, node.style?.whiteSpace, node.style?.letterSpacing])]);
            return { record, style, weights, key, before: record.element.offsetHeight };
        }).filter(job => parseFloat(job.style.width) > 0 && job.style.direction !== 'rtl');
        if (!jobs.length) return false;
        const host = doc.createElement('div');
        host.className = 'lyric-wrap-probe';
        host.setAttribute('aria-hidden', 'true');
        host.inert = true;
        host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;contain:layout style paint;';
        const fragment = doc.createDocumentFragment();
        const accepted = [];
        const unique = new Map();
        for (const job of jobs) {
            if (cache.has(job.key)) {
                const plan = cache.get(job.key);
                if (plan) accepted.push({ ...job, plan });
                processed.add(job.record);
            } else if (!unique.has(job.key)) unique.set(job.key, job);
        }
        const measuredJobs = [...unique.values()];
        let changed = false;
        try {
            for (const job of measuredJobs) job.baseline = job.weights.map(weight => probe(job.record, job.style, weight, fragment));
            if (measuredJobs.length) { host.appendChild(fragment); doc.body.appendChild(host); }
            for (const job of measuredJobs) job.sizes = job.baseline.map(size);
            // Single-line blocks stay untouched. Reads and writes are batched for the whole pass.
            const multi = measuredJobs.filter(job => job.sizes.some(value => value.height > parseFloat(job.style.lineHeight) + 1));
            for (const job of multi) job.trials = job.record.plans.map(plan => ({ plan,
                nodes: job.weights.map(weight => probe(job.record, job.style, weight, fragment, plan)) }));
            host.appendChild(fragment);
            for (const job of measuredJobs) {
                const trial = job.trials?.find(trial => trial.nodes.every((node, index) => {
                    const measured = size(node);
                    return !measured.overflow && measured.height <= job.sizes[index].height + .5;
                }));
                job.plan = trial?.plan || null;
                cache.set(job.key, job.plan);
                while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
            }
            for (const job of jobs) if (!processed.has(job.record)) {
                const plan = unique.get(job.key)?.plan || null;
                if (plan) accepted.push({ ...job, plan });
                processed.add(job.record);
            }
            for (const job of accepted) { paint(job.record.element, job.record, job.plan); job.record.applied = true; }
            for (const job of accepted) {
                const element = job.record.element;
                if (element.offsetHeight > job.before || element.scrollWidth > element.clientWidth + 1) restore(job.record);
                else changed = true;
            }
        } finally { host.remove(); }
        return changed;
    }

    return { refresh, reset, layout, invalidate() { fingerprint = ''; } };
}
