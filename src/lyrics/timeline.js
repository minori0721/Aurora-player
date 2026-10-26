const TIME_TOLERANCE = .05;
const MAX_ALIGNMENT_CELLS = 16384;
const MAX_GROUP_WORDS = 96;
const MAX_GROUP_PAUSE_MS = 1200;
const MAX_EXACT_CHARACTERS = 768;

export const normalizeLyricText = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
const isCredit = text => /^\s*(?:作[词詞曲]|[编編]曲|Lyricist|Lyrics|Composer|Composed|Arranger|Arranged)\s*[:：]/i.test(text);
const wordText = row => row.words.map(word => word.txt).join('');
const timed = rows => rows.filter(row => Number.isFinite(row.t) && row.t >= 0);
const uniqueText = rows => [...new Set(rows)].map(row => row.txt).filter(Boolean).join(' ');

function similarity(a, b, minRatio = .8) {
    if (a === b) return 1;
    if (!a || !b || Math.min(a.length, b.length) / Math.max(a.length, b.length) < minRatio || Math.max(a.length, b.length) > 256) return 0;
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const next = [i];
        for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, previous[j] + 1,
            previous[j - 1] + (a[i - 1] !== b[j - 1]));
        previous = next;
    }
    return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function orderedAnchors(plain, words) {
    if (plain.length === words.length) {
        const exact = plain.flatMap((row, i) => row.key === words[i].key ? [{ i, j: i }] : []);
        if (exact.length >= 2 && exact.length / plain.length >= .75
            && new Set(exact.map(pair => plain[pair.i].key)).size >= 2
            && plain.filter((row, i) => Math.abs(row.row.t - words[i].row.t) <= 2).length / plain.length >= .75) return exact;
    }
    const locations = rows => {
        const map = new Map();
        rows.forEach((row, index) => {
            const positions = map.get(row.key) || [];
            positions.push(index); map.set(row.key, positions);
        });
        return map;
    };
    const p = locations(plain), w = locations(words), pairs = [], ranks = new Map();
    plain.forEach((row, i) => {
        const a = p.get(row.key), b = w.get(row.key);
        const rank = ranks.get(row.key) || 0;
        ranks.set(row.key, rank + 1);
        if (row.key.length >= 8 && a.length === b?.length) pairs.push({ i, j: b[rank] });
    });
    const ends = [], previous = Array(pairs.length).fill(-1);
    pairs.forEach((pair, index) => {
        let low = 0, high = ends.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (pairs[ends[mid]].j < pair.j) low = mid + 1;
            else high = mid;
        }
        if (low) previous[index] = ends[low - 1];
        ends[low] = index;
    });
    const result = [];
    for (let i = ends.at(-1) ?? -1; i >= 0; i = previous[i]) result.push(pairs[i]);
    result.reverse();
    return new Set(result.map(pair => plain[pair.i].key)).size > 1 ? result
        : result.filter(pair => Math.abs(plain[pair.i].row.t - words[pair.j].row.t) <= 2);
}

function matchTracks(plain, words) {
    const blocks = [];
    const scores = new Map();
    const compare = (a, b, orderedPair = false) => {
        if (a === b) return 1;
        const minRatio = orderedPair ? .5 : .8;
        if (!a || !b || Math.min(a.length, b.length) / Math.max(a.length, b.length) < minRatio || Math.max(a.length, b.length) > 256) return 0;
        const key = `${a}\0${b}`;
        if (scores.has(key)) return scores.get(key);
        const value = similarity(a, b, minRatio);
        if (scores.size < 512) scores.set(key, value);
        return value;
    };
    const add = (p, n, w, m, exact = true) => blocks.push({ p, n, w, m, exact });
    const keys = rows => rows.map(row => row.key).join('');
    const text = keys(plain);
    const substantial = text.length >= 24 && new Set(plain.map(row => row.key)).size >= 2;
    const closeTrack = plain.length === words.length && plain.every((row, index) => Math.abs(row.row.t - words[index].row.t) <= 2);
    const equalTrack = text && text === keys(words) && (substantial || closeTrack);
    if (equalTrack) {
        let i = 0, j = 0;
        while (i < plain.length && j < words.length) {
            const p = i, w = j;
            let a = plain[i++].key, b = words[j++].key;
            while (a.length !== b.length && (i < plain.length || j < words.length)) {
                if (a.length < b.length && i < plain.length) a += plain[i++].key;
                else if (j < words.length) b += words[j++].key;
                else break;
            }
            add(p, i - p, w, j - w);
        }
        return blocks;
    }
    const anchors = orderedAnchors(plain, words);
    const exactGroups = new Map(), wordPositions = new Map(), support = new Set();
    for (let j = 0; j < words.length; j++) {
        const positions = wordPositions.get(words[j].key) || [];
        positions.push(j); wordPositions.set(words[j].key, positions);
        let key = '';
        for (let count = 1; count <= 3 && j + count <= words.length; count++) {
            key += words[j + count - 1].key;
            if (key.length < 8 || new Set(key).size < 4) continue;
            const matches = exactGroups.get(key) || [];
            matches.push({ t: words[j].row.t, count }); exactGroups.set(key, matches);
        }
    }
    for (let i = 0; i < plain.length && support.size < 2; i++) {
        let key = '';
        for (let count = 1; count <= 3 && i + count <= plain.length; count++) {
            key += plain[i + count - 1].key;
            if (exactGroups.get(key)?.some(match => (count === 1 || match.count === 1) && Math.abs(match.t - plain[i].row.t) <= 2)) support.add(key);
        }
    }
    const contextual = anchors.length >= 2 || support.size >= 2;
    function gap(pStart, pEnd, wStart, wEnd, enclosed) {
        const n = pEnd - pStart, m = wEnd - wStart;
        if (!n || !m) return;
        const plainText = keys(plain.slice(pStart, pEnd)), wordText = keys(words.slice(wStart, wEnd));
        const unique = new Map();
        const uniqueHere = key => {
            if (!unique.has(key)) unique.set(key, plainText.indexOf(key) === plainText.lastIndexOf(key)
                && wordText.indexOf(key) === wordText.lastIndexOf(key));
            return unique.get(key);
        };
        const before = pStart && wStart ? { t: plain[pStart - 1].row.t, delta: words[wStart - 1].row.t - plain[pStart - 1].row.t } : null;
        const after = pEnd < plain.length && wEnd < words.length
            ? { t: plain[pEnd].row.t, delta: words[wEnd].row.t - plain[pEnd].row.t } : null;
        const distance = (i, j) => {
            const time = plain[i].row.t;
            const fraction = before && after && after.t > before.t ? Math.max(0, Math.min(1, (time - before.t) / (after.t - before.t))) : 0;
            const offset = before && after ? before.delta + fraction * (after.delta - before.delta) : (before || after)?.delta || 0;
            return Math.abs(words[j].row.t - time - offset);
        };
        const allowed = (i, j, key, exact) => enclosed || Math.abs(words[j].row.t - plain[i].row.t) <= 2 || distance(i, j) <= 2
            || exact && contextual && uniqueHere(key);
        if (n * m > MAX_ALIGNMENT_CELLS) {
            let next = wStart;
            for (let i = pStart; i < pEnd; i++) {
                const positions = wordPositions.get(plain[i].key) || [];
                let low = 0, high = positions.length;
                while (low < high) {
                    const mid = (low + high) >>> 1, index = positions[mid];
                    if (index < next) low = mid + 1;
                    else high = mid;
                }
                const j = positions[low];
                if (j < wEnd && allowed(i, j, plain[i].key, true)) { add(i, 1, j, 1); next = j + 1; }
            }
            return;
        }
        const stride = m + 1, cost = new Float64Array((n + 1) * stride).fill(Infinity), moves = new Uint8Array(cost.length);
        const plainMoves = new Uint16Array(cost.length), wordMoves = new Uint16Array(cost.length);
        cost[0] = 0;
        const update = (i, j, value, move, pn = 0, wn = 0) => {
            const index = i * stride + j;
            if (value < cost[index] - 1e-9) { cost[index] = value; moves[index] = move; plainMoves[index] = pn; wordMoves[index] = wn; }
        };
        for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
            const base = cost[i * stride + j];
            if (i < n) update(i + 1, j, base + 1, 1);
            if (j < m) update(i, j + 1, base + 1, 2);
            if (i < n && j < m) {
                // Grow only the shorter exact prefix; unlike a row-count limit this
                // also handles crossed sentence boundaries without a large search.
                let pn = 1, wn = 1, a = plain[pStart + i].key, b = words[wStart + j].key;
                while (Math.max(a.length, b.length) <= MAX_EXACT_CHARACTERS) {
                    if (a === b) {
                        if (allowed(pStart + i, wStart + j, a, true)) update(i + pn, j + wn,
                            base + (pn + wn - 2) * .08 + Math.min(distance(pStart + i, wStart + j) / 20, .4), 3, pn, wn);
                        break;
                    }
                    if (a.length < b.length && b.startsWith(a) && i + pn < n) a += plain[pStart + i + pn++].key;
                    else if (b.length < a.length && a.startsWith(b) && j + wn < m) b += words[wStart + j + wn++].key;
                    else break;
                }
            }
            let a = '';
            for (let pn = 1; pn <= 3 && i + pn <= n; pn++) {
                a += plain[pStart + i + pn - 1].key;
                let b = '';
                for (let wn = 1; wn <= 3 && j + wn <= m; wn++) {
                    b += words[wStart + j + wn - 1].key;
                    const exact = a === b;
                    if (exact || pn > 1 && wn > 1) continue;
                    const delta = distance(pStart + i, wStart + j);
                    if (!allowed(pStart + i, wStart + j, a, false)) continue;
                    // Only an isolated, time-consistent ordered pair may tolerate
                    // larger wording differences; other candidates remain strict.
                    const orderedPair = contextual && n === m && i === j && pn === 1 && wn === 1
                        && Math.min(delta, Math.abs(plain[pStart + i].row.t - words[wStart + j].row.t)) <= 2;
                    const score = enclosed || contextual ? compare(a, b, orderedPair) : 0;
                    if (score < (orderedPair ? .5 : .84)) continue;
                    const penalty = (1 - (score || .5)) * 2 + (pn + wn - 2) * .08 + Math.min(delta / 20, .4);
                    update(i + pn, j + wn, base + penalty, 3, pn, wn);
                }
            }
        }
        const found = [];
        let i = n, j = m;
        while (i || j) {
            const move = moves[i * stride + j];
            if (move === 1) i--;
            else if (move === 2) j--;
            else {
                const index = i * stride + j, pn = plainMoves[index], wn = wordMoves[index];
                i -= pn; j -= wn;
                found.push({ p: pStart + i, n: pn, w: wStart + j, m: wn,
                    exact: keys(plain.slice(pStart + i, pStart + i + pn)) === keys(words.slice(wStart + j, wStart + j + wn)) });
            }
        }
        blocks.push(...found.reverse());
    }
    let p = 0, w = 0;
    anchors.forEach((anchor, index) => {
        gap(p, anchor.i, w, anchor.j, index > 0);
        add(anchor.i, 1, anchor.j, 1);
        p = anchor.i + 1; w = anchor.j + 1;
    });
    gap(p, plain.length, w, words.length, false);
    return blocks;
}

function attachExtras(main, extras) {
    const byTime = new Map(), attached = new Map();
    main.forEach(row => {
        const key = row.t.toFixed(3), group = byTime.get(key) || [];
        group.push(row); byTime.set(key, group);
    });
    for (const extra of timed(extras)) {
        const exact = byTime.get(extra.t.toFixed(3));
        let target = exact?.[0];
        if (!target) {
            let low = 0, high = main.length;
            while (low < high) {
                const mid = (low + high) >>> 1;
                if (main[mid].t < extra.t) low = mid + 1;
                else high = mid;
            }
            const a = main[low - 1], b = main[low];
            const nearest = a && (!b || extra.t - a.t <= b.t - extra.t) ? a : b;
            if (nearest && Math.abs(nearest.t - extra.t) < TIME_TOLERANCE) target = nearest;
        }
        if (target) {
            const group = attached.get(target) || [];
            group.push(extra); attached.set(target, group);
        }
    }
    return attached;
}

function canGroup(rows) {
    if (rows.reduce((sum, row) => sum + row.words.length, 0) > MAX_GROUP_WORDS) return false;
    return rows.every((row, i) => !i || row.words[0].start - Math.max(...rows[i - 1].words.map(word => word.start + word.dur)) <= MAX_GROUP_PAUSE_MS);
}

function makeWordRow(rows) {
    const runs = [];
    rows.forEach((row, index) => {
        if (index) {
            const previous = wordText(rows[index - 1]), next = wordText(row);
            if (!/\s$/.test(previous) && !/^\s/.test(next) && /[\p{Script=Latin}\p{N}\p{M},;:!?.'"\])}]$/u.test(previous)
                && /^[\p{Script=Latin}\p{N}'"([{]/u.test(next)) runs.push({ text: ' ' });
        }
        runs.push({ words: row.words });
    });
    return { t: rows[0].t, txt: runs.map(run => run.text ?? run.words.map(word => word.txt).join('')).join(''),
        words: rows.flatMap(row => row.words), runs, sourceWords: rows, sourceOriginal: [], aliases: new Set(), info: [] };
}

function partitionWordRows(plain, words, translations, pronunciations) {
    const tokens = words.flatMap(row => row.words), edges = new Map([[0, 0]]);
    let key = '';
    tokens.forEach((word, index) => { key += normalizeLyricText(word.txt); edges.set(key.length, index + 1); });
    if (key !== words.map(row => normalizeLyricText(wordText(row))).join('')) return null;
    let offset = 0;
    const cuts = [0];
    for (const row of plain.slice(0, -1)) {
        offset += normalizeLyricText(row.txt).length;
        if (!edges.has(offset)) return null;
        cuts.push(edges.get(offset));
    }
    cuts.push(tokens.length);
    if (plain.map(row => normalizeLyricText(row.txt)).join('') !== key) return null;
    const positions = new Map(tokens.map((word, index) => [word, index]));
    const result = [];
    for (let index = 0; index < plain.length; index++) {
        const start = cuts[index], end = cuts[index + 1];
        if (start >= end) return null;
        const sources = words.filter(row => positions.get(row.words[0]) < end && positions.get(row.words.at(-1)) >= start);
        const slices = sources.map(row => {
            const from = Math.max(0, start - positions.get(row.words[0])), to = Math.min(row.words.length, end - positions.get(row.words[0]));
            return { t: from ? row.words[from].start / 1000 : row.t, words: row.words.slice(from, to) };
        });
        if (!canGroup(slices)) return null;
        const target = makeWordRow(slices);
        if (result.length && target.t <= result.at(-1).t) return null;
        target.sourceWords = sources;
        target.ordinaryBoundaries = true;
        // A subtitle belonging to an entire native row cannot be copied to its
        // children. Split only if the new sentence has its own paired source.
        for (const [field, extras] of [['translation', translations], ['roman', pronunciations]]) {
            if (sources.some(row => (row[field] || row[`${field}Source`]) && (positions.get(row.words[0]) < start || positions.get(row.words.at(-1)) >= end))
                && !extras.get(plain[index])?.length) return null;
        }
        result.push(target);
    }
    return result;
}

export function buildLyricTimeline(original, translated, roman, wordLyrics) {
    const main = timed(original), words = (wordLyrics || []).filter(row => Number.isFinite(row.t) && row.t >= 0 && row.words?.length);
    const annotations = words.length ? main.filter(row => !isCredit(row.txt) && !normalizeLyricText(row.txt)) : [];
    const translations = attachExtras(main, translated), pronunciations = attachExtras(main, roman);
    const plain = main.filter(row => !isCredit(row.txt)).map(row => ({ row, key: normalizeLyricText(row.txt) })).filter(row => row.key);
    const wordCandidates = words.filter(row => !isCredit(wordText(row))).map(row => ({ row, key: normalizeLyricText(wordText(row)) })).filter(row => row.key);
    const blocks = plain.length && wordCandidates.length ? matchTracks(plain, wordCandidates) : [];
    const consumed = new Map(), represented = new Map(), owner = new Map(), wordIndex = new Map(words.map((row, index) => [row, index]));
    words.forEach(row => {
        const target = makeWordRow([row]);
        row.words.forEach(word => owner.set(word, target));
    });
    for (const block of blocks) {
        const p = plain.slice(block.p, block.p + block.n).map(item => item.row);
        const w = wordCandidates.slice(block.w, block.w + block.m).map(item => item.row);
        const contiguous = w.every((row, index) => !index || wordIndex.get(row) === wordIndex.get(w[index - 1]) + 1);
        const partitions = block.exact && block.n > 1 && block.m > 1 && contiguous
            ? partitionWordRows(p, w, translations, pronunciations) : null;
        if (partitions) partitions.forEach(target => target.words.forEach(word => owner.set(word, target)));
        const combined = block.n === 1 && block.m > 1 && contiguous && canGroup(w) ? makeWordRow(w) : null;
        if (combined) combined.words.forEach(word => owner.set(word, combined));
        let offset = 0;
        for (const [plainIndex, row] of p.entries()) {
            let index = 0, end = wordCandidates[block.w].key.length;
            while (index + 1 < w.length && offset >= end) end += wordCandidates[block.w + ++index].key.length;
            const target = partitions?.[plainIndex] || combined || owner.get(w[index].words[0]);
            target.sourceOriginal.push(row);
            consumed.set(row, target);
            const key = normalizeLyricText(row.txt), matches = represented.get(key) || [];
            matches.push(row); represented.set(key, matches);
            offset += normalizeLyricText(row.txt).length;
        }
    }
    const credits = new Map();
    for (const row of words) if (isCredit(wordText(row))) {
        const key = normalizeLyricText(wordText(row)), matches = credits.get(key) || [];
        matches.push(row); credits.set(key, matches);
    }
    for (const row of main) if (isCredit(row.txt)) {
        const matches = credits.get(normalizeLyricText(row.txt));
        const source = matches?.reduce((best, item) => !best || Math.abs(item.t - row.t) < Math.abs(best.t - row.t) ? item : best, null);
        if (source) {
            const target = owner.get(source.words[0]);
            target.sourceOriginal.push(row); consumed.set(row, target);
        }
    }
    // Repeated source records a few milliseconds apart can describe the same mapped
    // event. Keep their provenance/subtitles without inserting a second main cue.
    for (const item of plain) if (!consumed.has(item.row)) {
        const matches = represented.get(item.key) || [];
        let low = 0, high = matches.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (matches[mid].t < item.row.t - TIME_TOLERANCE) low = mid + 1;
            else high = mid;
        }
        const duplicate = matches[low];
        if (duplicate && Math.abs(duplicate.t - item.row.t) < TIME_TOLERANCE) {
            const target = consumed.get(duplicate);
            target.sourceOriginal.push(item.row); target.aliases.add(item.row); consumed.set(item.row, target);
        }
    }
    const result = [...new Set(owner.values())];
    for (const row of main) if (!consumed.has(row) && !annotations.includes(row)) result.push({ t: row.t, txt: row.txt, words: null, runs: null,
        sourceWords: [], sourceOriginal: [row], info: [] });
    if (!result.length) {
        const fallback = timed(translated).length ? timed(translated) : timed(roman);
        result.push(...fallback.map(row => ({ t: row.t, txt: row.txt, words: null, runs: null, sourceWords: [], sourceOriginal: [], info: [] })));
    }
    for (const row of result) {
        const ordinary = field => {
            const primary = row.sourceOriginal.filter(source => !row.aliases?.has(source)).flatMap(source => field.get(source) || []);
            return [...primary, ...row.sourceOriginal.filter(source => row.aliases?.has(source)).flatMap(source => field.get(source) || [])
                .filter(extra => !primary.some(existing => existing.txt === extra.txt))];
        };
        const paired = field => row.sourceWords.map(source => source[`${field}Source`] || (source[field] ? { txt: source[field] } : null)).filter(Boolean);
        const translation = paired('translation'), pronunciation = paired('roman');
        const choose = (native, field) => {
            const fallback = ordinary(field);
            return row.ordinaryBoundaries && fallback.length ? fallback : native.length ? native : fallback;
        };
        row.translationSources = choose(translation, translations);
        row.romanSources = choose(pronunciation, pronunciations);
        row.translation = uniqueText(row.translationSources);
        row.roman = uniqueText(row.romanSources);
    }
    result.sort((a, b) => a.t - b.t || Number(!!b.words) - Number(!!a.words));
    const rows = [];
    for (const row of result) {
        const previous = rows.at(-1);
        if (previous && previous.t.toFixed(3) === row.t.toFixed(3)) {
            if (previous.words && !row.words) {
                previous.info.push(row.txt, ...[row.translation, row.roman].filter(Boolean));
                previous.sourceOriginal.push(...row.sourceOriginal);
                continue;
            }
            else {
                previous.txt += `\n${row.txt}`;
                if (row.words) {
                    previous.words = [...previous.words, ...row.words];
                    previous.runs = [...previous.runs, { text: '\n' }, ...row.runs];
                }
            }
            previous.sourceOriginal.push(...row.sourceOriginal);
            previous.sourceWords.push(...row.sourceWords);
            previous.translationSources.push(...row.translationSources);
            previous.romanSources.push(...row.romanSources);
            previous.translation = uniqueText(previous.translationSources);
            previous.roman = uniqueText(previous.romanSources);
        } else rows.push(row);
    }
    const array = field => rows.filter(row => row[field]).map(row => ({ t: row.t, txt: row[field] }));
    for (const row of rows) {
        row.translationSources = [...new Set(row.translationSources)];
        row.romanSources = [...new Set(row.romanSources)];
    }
    return { rows, annotations, original: [...original.filter(row => row.t < 0), ...array('txt')],
        translated: [...translated.filter(row => row.t < 0), ...array('translation')],
        roman: [...roman.filter(row => row.t < 0), ...array('roman')],
        wordLyrics: rows.filter(row => row.words).map(row => ({ t: row.t, words: row.words })) };
}
