function parseJsonLyricLine(line) {
    if (!line || line[0] !== '{') return null;
    try {
        const obj = JSON.parse(line);
        if (!obj || !Array.isArray(obj.c)) return null;
        const txt = obj.c.map(part => part && typeof part.tx === 'string' ? part.tx : '').join('').trim();
        if (!txt) return null;
        const t = Number(obj.t);
        if (Number.isFinite(t) && t >= 0) return { t: t / 1000, txt };
        return { t: -1, txt, meta: true };
    } catch(e) {
        return null;
    }
}

function parseLyricsToArray(text, metaBucket) {
    if(!text) return [];
    const lines = text.split(/\r?\n/);
    const timeReg = /\[(\d{1,2}):(\d{2})(?:[:.](\d{2,3}))?\]/g;
    const out = [];
    lines.forEach(l => {
        const line = l.trim(); if(!line) return;
        const jsonLine = parseJsonLyricLine(line);
        if (jsonLine) {
            if (jsonLine.meta) {
                if (metaBucket) metaBucket.push({ t: -1, txt: jsonLine.txt });
            } else {
                out.push(jsonLine);
            }
            return;
        }
        const times = []; let match;
        while ((match = timeReg.exec(line)) !== null) {
            const min = parseInt(match[1]); const sec = parseInt(match[2]); let ms = match[3] ? parseInt(match[3]) : 0;
            if (match[3] && match[3].length === 2) ms *= 10;
            times.push(min*60 + sec + ms/1000);
        }
        timeReg.lastIndex = 0;
        const txt = line.replace(/\[\d{1,2}:\d{2}(?:[:.\d]+)?\]/g, '').replace(/\[[a-zA-Z]+:.*?\]/g, '').trim();
        if(times.length > 0 && txt) { times.forEach(t => out.push({t, txt})); }
        else if (txt) out.push({t: -1, txt});
    });
    out.sort((a,b)=>a.t - b.t);
    return out;
}

/**
 * 解析 YRC 逐字歌词
 * YRC 格式：[行起始ms,行时长ms] 或 [行起始ms,行时长ms,0]，后接 (字起始ms,字时长ms,0)字。
 * 返回 Array<{ t: number(秒), dur: number(ms), words: Array<{ txt, start(ms), dur(ms) }> }>
 */
function parseYrc(text) {
    if (!text) return null;
    const lines = text.split(/\r?\n/);
    const result = [];
    const lineReg = /^\[(\d+),(\d+)(?:,\d+)?\]/;
    const wordReg = /\((\d+),(\d+),\d+\)/g;
    const validTiming = (start, dur) => Number.isSafeInteger(start) && Number.isSafeInteger(dur)
        && Number.isSafeInteger(start + dur);
    for (const raw of lines) {
        const line = raw.trim();
        const lm = lineReg.exec(line);
        if (!lm) continue;
        const lineStart = Number(lm[1]), duration = Number(lm[2]);
        if (!validTiming(lineStart, duration)) continue;
        const rest = line.slice(lm[0].length);
        const tokens = [...rest.matchAll(wordReg)];
        if (tokens.some(token => !validTiming(Number(token[1]), Number(token[2])))) continue;
        const words = [];
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            const txt = rest.slice(token.index + token[0].length, tokens[i + 1]?.index ?? rest.length);
            if (txt) words.push({ txt, start: Number(token[1]), dur: Number(token[2]) });
        }
        if (words.length > 0) {
            result.push({ t: lineStart / 1000, dur: duration, words });
        }
    }
    result.sort((a, b) => a.t - b.t);
    return result.length > 0 ? result : null;
}

function alignWordLyricTimeline(original, translated, roman, wordLyrics) {
    if (!wordLyrics?.length) return { original, translated, roman };
    const normalize = text => text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
    const isCredit = text => /^\s*(?:作[词詞曲]|[编編]曲|Lyricist|Lyrics|Composer|Composed|Arranger|Arranged)\s*[:：]/i.test(text);
    const candidates = original.filter(line => line.t >= 0 && !isCredit(line.txt))
        .map(line => ({ line, key: normalize(line.txt) }));
    const replacements = new Map();
    const wordRows = wordLyrics.map(line => ({ t: line.t, txt: line.words.map(word => word.txt).join('') }));
    const keys = wordRows.map(line => normalize(line.txt));
    // Strong agreement across complete tracks proves line order, even when individual
    // timestamps or spellings differ. A partial/other version must not get paired by index.
    const sameTrack = candidates.length === wordRows.length
        && candidates.filter((candidate, i) => candidate.key === keys[i]).length / wordRows.length >= .75
        && candidates.filter((candidate, i) => Math.abs(candidate.line.t - wordRows[i].t) <= 2).length / wordRows.length >= .75;
    let textPairs = null;
    if (!sameTrack && keys.join('') && candidates.map(candidate => candidate.key).join('') === keys.join('')) {
        // Identical full text can have different line breaks. Character offsets prove
        // correspondence without guessing which translation fragment belongs to which line.
        let index = 0, end = keys[0].length, offset = 0;
        const pairs = candidates.map(candidate => {
            while (index + 1 < keys.length && offset >= end) end += keys[++index].length;
            const pair = [candidate.line, wordRows[index].t];
            offset += candidate.key.length;
            return pair;
        });
        if (pairs.filter(([plain, time]) => Math.abs(plain.t - time) <= 2).length / pairs.length >= .75) textPairs = new Map(pairs);
    }
    wordRows.forEach((row, i) => {
        if (sameTrack) {
            replacements.set(candidates[i].line, row.t);
            return;
        }
        if (textPairs) return;
        let best = null, distance = Infinity;
        for (const candidate of candidates) {
            const { line: plain } = candidate;
            const delta = Math.abs(plain.t - row.t);
            if (replacements.has(plain) || delta > 2) continue;
            if (keys[i] && candidate.key === keys[i] && delta < distance) {
                best = plain; distance = delta;
            }
        }
        // Preserve exact-time alternate text support without preferring it to a text match.
        if (!best) best = candidates.find(candidate => !replacements.has(candidate.line)
            && Math.abs(candidate.line.t - row.t) < .05)?.line;
        if (best) replacements.set(best, row.t);
    });
    if (textPairs) for (const [plain, time] of textPairs) replacements.set(plain, time);
    const main = [...original.filter(line => !replacements.has(line)), ...wordRows].sort((a, b) => a.t - b.t);
    const findOriginal = createLyricTimeLookup([...replacements.keys()]);
    const sourceByTime = new Map([...replacements.keys()].map(line => [line.t, line]));
    const wordByTime = new Map(wordLyrics.map(line => [line.t, line]));
    const alignExtra = (lines, field) => {
        const aligned = lines.map(line => {
            const plain = sourceByTime.get(line.t) || findOriginal(line.t);
            return plain ? { ...line, t: replacements.get(plain) } : line;
        });
        const fallbackByTime = new Map();
        for (const line of aligned) {
            const previous = fallbackByTime.get(line.t);
            fallbackByTime.set(line.t, previous ? `${previous} ${line.txt}` : line.txt);
        }
        // Subtitles attach to existing main rows. They never create a second singing timeline.
        return main.flatMap(line => {
            const txt = wordByTime.get(line.t)?.[field] ?? fallbackByTime.get(line.t);
            return txt ? [{ t: line.t, txt }] : [];
        });
    };
    return {
        original: main, translated: alignExtra(translated, 'translation'), roman: alignExtra(roman, 'roman')
    };
}

function selectNeteaseLyricTracks(data) {
    const text = field => typeof data?.[field]?.lyric === 'string' ? data[field].lyric : '';
    let wordLyrics = parseYrc(text('yrc'));
    if (wordLyrics) {
        const attach = field => {
            const rows = parseLyricsToArray(text(field)).filter(line => line.t >= 0);
            const times = createLyricTimeLookup(wordLyrics);
            // Some yromalrc payloads are another version with credits or different timing.
            // Accept partial tracks only when most of their rows belong to this YRC timeline.
            if (!rows.length || rows.filter(line => times(line.t)).length / rows.length < .75) return () => undefined;
            const exact = new Map(rows.map(line => [line.t, line]));
            const fallback = createLyricTimeLookup(rows);
            return time => exact.get(time) || fallback(time);
        };
        const translation = attach('ytlrc'), roman = attach('yromalrc');
        wordLyrics = wordLyrics.map(line => ({ ...line,
            translation: translation(line.t)?.txt, roman: roman(line.t)?.txt }));
    }
    return { original: text('lrc'), translated: text('tlyric') || text('trans'), roman: text('romalrc'), wordLyrics };
}

function createLyricTimeLookup(lines) {
    const indexed = (lines || []).map((line, index) => ({ line, index }))
        .filter(item => Number.isFinite(item.line.t)).sort((a, b) => a.line.t - b.line.t || a.index - b.index);
    return time => {
        let low = 0, high = indexed.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (indexed[mid].line.t < time - 0.05) low = mid + 1;
            else high = mid;
        }
        let match = null;
        // Preserve the original first-match rule, including unsorted or duplicate timestamps.
        for (let i = low; i < indexed.length && indexed[i].line.t <= time + 0.05; i++) {
            const item = indexed[i];
            if (Math.abs(item.line.t - time) < 0.05 && (!match || item.index < match.index)) match = item;
        }
        return match?.line;
    };
}

function extractLyricsText(value, depth = 0) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || depth >= 3) return '';
    for (const key of ['lyrics', 'text', 'data']) {
        const text = extractLyricsText(value[key], depth + 1);
        if (text.trim()) return text;
    }
    return '';
}

export { alignWordLyricTimeline, createLyricTimeLookup, extractLyricsText, parseJsonLyricLine, parseLyricsToArray, parseYrc, selectNeteaseLyricTracks };
