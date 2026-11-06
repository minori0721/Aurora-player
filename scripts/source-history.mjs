import { MATCH_SOURCE_ORDERS, MATCH_SOURCE_UPSTREAM } from '../src/netease/match-sources.js';
import { SOURCE_AUDIT_VERSION, sourceDay } from './update-match-sources.mjs';

const DAY = 86400000;
const PROFILES = ['balanced', 'lossless', 'hires'];
const sourceName = name => typeof name === 'string' && /^[a-z0-9_-]+$/.test(name);
const safeId = id => Number.isSafeInteger(id) && id > 0;
const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

// Whitelist fields before historical reports enter aggregation or Markdown.
export function validateSourceSnapshot(raw) {
    if (raw?.schemaVersion !== SOURCE_AUDIT_VERSION || raw.upstream !== MATCH_SOURCE_UPSTREAM
        || !['ready', 'inconclusive'].includes(raw.status) || typeof raw.recordedAt !== 'string'
        || !Number.isFinite(Date.parse(raw.recordedAt)) || new Date(raw.recordedAt).toISOString() !== raw.recordedAt
        || raw.day !== sourceDay(raw.recordedAt) || typeof raw.apiHost !== 'string'
        || !/^[a-z0-9.-]+$/i.test(raw.apiHost) || typeof raw.origin !== 'string') return null;
    try { if (new URL(raw.origin).origin !== raw.origin) return null; } catch { return null; }
    const envelope = { schemaVersion: SOURCE_AUDIT_VERSION, upstream: MATCH_SOURCE_UPSTREAM, recordedAt: raw.recordedAt,
        day: raw.day, apiHost: raw.apiHost, origin: raw.origin };
    if (raw.status === 'inconclusive') return { ...envelope, status: 'inconclusive', directory: { available: [] }, samples: [], rows: [] };
    const available = raw.directory?.available;
    if (!Array.isArray(available) || available.length < 1 || available.length > 12
        || !available.every(sourceName) || new Set(available).size !== available.length
        || !Array.isArray(raw.samples) || raw.samples.length < 2 || raw.samples.length > 6
        || !raw.samples.every(sample => sample && safeId(sample.id))
        || new Set(raw.samples.map(sample => sample.id)).size !== raw.samples.length
        || !Array.isArray(raw.rows) || raw.rows.length > 72) return null;
    const ids = new Set(raw.samples.map(sample => sample.id)), seen = new Set();
    const rows = [];
    for (const row of raw.rows) {
        if (!row) return null;
        const key = `${row.source}:${row.id}`;
        if (!available.includes(row.source) || !ids.has(row.id) || seen.has(key)
            || typeof row.ok !== 'boolean' || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0) return null;
        seen.add(key);
        if (row.ok && (!['mp3', 'flac'].includes(row.format) || !Number.isFinite(row.sampleRate)
            || row.sampleRate < 8000 || row.sampleRate > 768000
            || (row.format === 'flac' && (!Number.isInteger(row.bits) || row.bits < 1 || row.bits > 64)))) return null;
        rows.push({ source: row.source, id: row.id, ok: row.ok, elapsedMs: row.elapsedMs,
            ...(row.ok ? { format: row.format, sampleRate: row.sampleRate, bits: row.bits } :
                { reason: /^[A-Z][A-Z0-9_]{0,63}$/.test(row.reason) ? row.reason : 'PROBE_FAILED' }) });
    }
    const complete = rows.length === available.length * ids.size;
    const rateLimited = rows.some(row => row.reason === 'API_RATE_LIMITED');
    const usable = raw.status === 'ready' && complete && !rateLimited && rows.some(row => row.ok);
    return { ...envelope, status: usable ? 'ready' : 'inconclusive',
        directory: { available: [...available] }, samples: raw.samples.map(sample => ({ id: sample.id })), rows };
}

export function selectSourceHistory(records, { now = new Date(), apiHost, origin } = {}) {
    const today = Date.parse(sourceDay(now));
    const days = new Map();
    for (const raw of records) {
        const record = validateSourceSnapshot(raw);
        if (!record || (apiHost && record.apiHost !== apiHost) || (origin && record.origin !== origin)
            || Date.parse(record.recordedAt) > new Date(now).getTime() + 300000) continue;
        const age = (today - Date.parse(record.day)) / DAY;
        if (age < 0 || age > 6) continue;
        const previous = days.get(record.day);
        if (!previous || Date.parse(record.recordedAt) > Date.parse(previous.recordedAt)
            || (record.recordedAt === previous.recordedAt && record.status === 'inconclusive')) days.set(record.day, record);
    }
    // A later failed rerun supersedes an earlier success on the same local day.
    return [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
}

export function planWeeklySourceUpdate(records, { now = new Date(), orders = MATCH_SOURCE_ORDERS,
    apiHost, origin } = {}) {
    const history = selectSourceHistory(records, { now, apiHost, origin });
    const latest = history[0];
    const valid = history.filter(day => day.status === 'ready');
    const base = { status: 'inconclusive', changed: false, orders, metrics: [], history, days: valid.length };
    if (!latest || latest.day !== sourceDay(now) || latest.status !== 'ready') return { ...base, reason: 'LATEST_SAMPLE_UNAVAILABLE' };
    if (valid.length < 3) return { ...base, reason: 'INSUFFICIENT_DAYS' };
    const available = latest.directory.available;
    const metrics = available.map(source => {
        const daily = valid.flatMap(day => {
            const attempts = day.rows.filter(row => row.source === source);
            if (!attempts.length) return [];
            const weight = 2 ** (-(new Date(now).getTime() - Date.parse(day.recordedAt)) / DAY / 2);
            const successful = attempts.filter(row => row.ok);
            return [{ weight, attempts, successful }];
        });
        const totalWeight = daily.reduce((sum, day) => sum + day.weight, 0);
        const rate = predicate => daily.reduce((sum, day) => sum
            + day.weight * day.attempts.filter(predicate).length / day.attempts.length, 0) / (totalWeight || 1);
        const successful = daily.flatMap(day => day.successful);
        const recent = latest.rows.filter(row => row.source === source);
        return { source, days: daily.length, attempts: daily.reduce((sum, day) => sum + day.attempts.length, 0),
            successes: successful.length, distinctSongs: new Set(successful.map(row => row.id)).size,
            stableDays: daily.filter(day => day.successful.length >= 2).length,
            availableRate: rate(row => row.ok), mp3Rate: rate(row => row.ok && row.format === 'mp3'),
            flacRate: rate(row => row.ok && row.format === 'flac'),
            hiresRate: rate(row => row.ok && row.format === 'flac' && (row.bits > 16 || row.sampleRate > 48000)),
            medianMs: median(successful.map(row => row.elapsedMs)),
            recentOutage: recent.length >= 3 && !recent.some(row => row.ok) };
    });
    const configured = new Set(Object.values(orders).flat().filter(Boolean));
    const accepted = metrics.filter(item => configured.has(item.source)
        || (item.stableDays >= 3 && item.distinctSongs >= 3));
    if (accepted.length < 2) return { ...base, metrics, reason: 'INSUFFICIENT_SOURCES' };
    const next = {};
    for (const profile of PROFILES) {
        const previous = orders[profile].filter(source => accepted.some(item => item.source === source));
        const stable = [...previous, ...accepted.map(item => item.source).filter(source => !previous.includes(source)).sort()];
        const criteria = profile === 'hires' ? ['hiresRate', 'flacRate', 'availableRate']
            : profile === 'lossless' ? ['flacRate', 'availableRate'] : ['availableRate', 'mp3Rate'];
        const better = (a, b) => {
            if (a.recentOutage !== b.recentOutage) return !a.recentOutage;
            if (a.days < 3 || b.days < 3) return false;
            for (const key of criteria) if (Math.abs(a[key] - b[key]) >= 0.1 - 1e-9) return a[key] > b[key];
            return a.medianMs !== null && a.medianMs < 5000 && b.medianMs >= 5000;
        };
        // Stable insertion gives small differences a deterministic previous-order tie break.
        const ranked = [];
        for (const source of stable) {
            const item = accepted.find(candidate => candidate.source === source);
            const index = ranked.findIndex(other => better(item, other));
            ranked.splice(index < 0 ? ranked.length : index, 0, item);
        }
        next[profile] = ranked.map(item => item.source).concat(null);
    }
    return { ...base, status: 'ready', changed: JSON.stringify(next) !== JSON.stringify(orders), orders: next, metrics };
}

export function formatWeeklySourceReport(result) {
    const percent = rate => `${(rate * 100).toFixed(1)}%`;
    const lines = ['## 每周音源报告', '', `状态：${result.status}${result.reason ? `（${result.reason}）` : ''}`,
        `有效检测：${result.days} 天；最近七天按两天半衰期加权。`, '',
        '| 日期（UTC+8） | 检测时间 | 状态 |', '| --- | --- | --- |'];
    for (const day of result.history) lines.push(`| ${day.day} | ${day.recordedAt} | ${day.status} |`);
    lines.push('', '| 来源 | 有效天数 | 成功/检测 | 加权可用率 | 加权 FLAC 率 | 加权高精度率 | 耗时中位数 | 最新全失败 |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const item of result.metrics) lines.push(`| ${item.source} | ${item.days} | ${item.successes}/${item.attempts} | ${percent(item.availableRate)} | ${percent(item.flacRate)} | ${percent(item.hiresRate)} | ${item.medianMs === null ? '-' : `${item.medianMs}ms`} | ${item.recentOutage ? '是' : '否'} |`);
    if (result.status === 'ready') {
        lines.push('', '### 建议顺序', '');
        for (const profile of PROFILES) lines.push(`- ${profile}: ${result.orders[profile].map(name => name || 'auto').join(' → ')}`);
        lines.push('', result.changed ? '建议名单有变化。' : '建议名单与当前一致。');
    }
    lines.push('', '检测项目：公开 VIP 样本、匿名跨域、小范围音频文件头和时长。',
        '普通、无损、Hi-Res 分别比较可用率、FLAC 率和高精度率；差距不足 10 个百分点时继续比较下一指标，近似结果保留原顺序。',
        '新来源至少三个有效日、三首不同歌曲通过；最新多首全失败的来源降低优先级。',
        '汇报使用 GitHub runner 的线路耗时。合并 PR 后重新构建内嵌名单。', '');
    return lines.join('\n');
}
