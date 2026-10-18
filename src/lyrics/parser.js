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
 * YRC 格式：[行起始ms,行时长ms,0]\n[字起始ms,字时长ms,0]字...
 * 返回 Array<{ t: number(秒), words: Array<{ txt, start(ms), dur(ms) }> }>
 */
function parseYrc(text) {
    if (!text) return null;
    const lines = text.split(/\r?\n/);
    const result = [];
    // 行头格式：[startMs,durMs,0]
    const lineReg = /^\[(\d+),(\d+),\d+\]/;
    // 字格式：(startMs,durMs,0)字
    const wordReg = /\((\d+),(\d+),\d+\)([^(\[]*)/g;
    for (const raw of lines) {
        const lm = lineReg.exec(raw);
        if (!lm) continue;
        const lineStart = parseInt(lm[1]); // ms
        const rest = raw.slice(lm[0].length);
        const words = [];
        let wm;
        wordReg.lastIndex = 0;
        while ((wm = wordReg.exec(rest)) !== null) {
            const txt = wm[3];
            if (txt) words.push({ txt, start: parseInt(wm[1]), dur: parseInt(wm[2]) });
        }
        if (words.length > 0) {
            result.push({ t: lineStart / 1000, words });
        }
    }
    return result.length > 0 ? result : null;
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

export { createLyricTimeLookup, extractLyricsText, parseJsonLyricLine, parseLyricsToArray, parseYrc };
