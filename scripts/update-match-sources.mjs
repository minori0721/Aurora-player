import fs from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { checkMatchSources } from './check-match-sources.mjs';
import { DEFAULT_CONFIG } from './config.mjs';
import { MATCH_SOURCE_ORDERS, MATCH_SOURCE_UPSTREAM } from '../src/netease/match-sources.js';
import { parseFlacStreamInfoFromBuffer } from '../src/audio/quality.js';
import { readMp3StreamInfo } from '../src/audio/mp3.js';

export const SOURCE_SAMPLES = [
    { id: 31967343, name: '恋は渾沌の隷也' },
    { id: 1901371647, name: '孤勇者' },
    { id: 1376075781, name: 'Stay The Night' },
    { id: 1974443814, name: '我记得' },
    { id: 2693371920, name: 'そんなもんね' },
    { id: 2114626833, name: 'Once Upon A Time (House Mix)' },
    { id: 1824045033, name: '再见莫妮卡' },
    { id: 530995169, name: 'SHINY DAYS' },
    { id: 1859245776, name: 'STAY' },
    { id: 1804320463, name: '踏山河' },
    { id: 2023989553, name: 'SACRA' },
    { id: 1406633327, name: 'Blinding Lights' }
];
export const SOURCE_AUDIT_VERSION = 1;
export function sourceDay(now = new Date()) {
    return new Date(new Date(now).getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
export function selectDailySamples(now = new Date()) {
    const group = Math.floor(Date.parse(sourceDay(now)) / 86400000) % 3;
    return [...SOURCE_SAMPLES.slice(0, 3), ...SOURCE_SAMPLES.slice(3 + group * 3, 6 + group * 3)];
}
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PROFILES = ['balanced', 'lossless', 'hires'];
const MAX_SOURCES = 12;
const DEFAULT_ORIGIN = 'https://music.moerika.com';
const fail = code => Object.assign(new Error(code), { code });
const errorCode = error => typeof error.code === 'string' ? error.code
    : typeof error.cause?.code === 'string' ? error.cause.code : error.name;

function publicUrl(raw) {
    const url = new URL(raw);
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || url.username || url.password || isIP(url.hostname.replace(/^\[|\]$/g, ''))
        || !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) throw fail('UNSUPPORTED_URL');
    return url;
}

async function limitedBody(response, limit) {
    const reader = response.body?.getReader();
    if (!reader) throw fail('EMPTY_BODY');
    const bytes = new Uint8Array(limit);
    let length = 0;
    try {
        while (length < limit) {
            const part = await reader.read();
            if (part.done) break;
            if (part.value.length > limit - length) throw fail('BODY_LIMIT');
            bytes.set(part.value, length);
            length += part.value.length;
        }
        return bytes.slice(0, length);
    } finally { await reader.cancel().catch(() => {}); }
}

async function apiJson(fetchImpl, base, endpoint, params) {
    const url = new URL(base.replace(/\/+$/, '') + endpoint);
    url.search = new URLSearchParams({ ...params, randomCNIP: 'true' });
    const response = await fetchImpl(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
        await response.body?.cancel();
        throw fail(response.status === 429 ? 'API_RATE_LIMITED' : `HTTP_${response.status}`);
    }
    const bytes = await limitedBody(response, 128 * 1024);
    return JSON.parse(new TextDecoder().decode(bytes));
}

async function audioHeader(fetchImpl, raw, start, onSize, origin) {
    let url = publicUrl(raw);
    const signal = AbortSignal.timeout(3000);
    for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await fetchImpl(url, { credentials: 'omit', redirect: 'manual', signal,
            headers: { Range: `bytes=${start}-${start + 4095}`, Origin: origin } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const next = response.headers.get('location');
            await response.body?.cancel();
            if (!next || redirects === 3) throw fail('AUDIO_REDIRECT');
            url = publicUrl(new URL(next, url));
            continue;
        }
        const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
        if (response.status !== 206 || !range || Number(range[1]) !== start
            || Number(range[2]) < start || Number(range[2]) >= start + 4096
            || Number(range[3]) <= Number(range[2]) || Number(response.headers.get('content-length')) > 4096) {
            await response.body?.cancel();
            throw fail('AUDIO_RANGE');
        }
        const allowedOrigin = response.headers.get('access-control-allow-origin');
        if (allowedOrigin !== '*' && allowedOrigin !== origin) {
            await response.body?.cancel();
            throw fail('AUDIO_CORS');
        }
        onSize(Number(range[3]));
        return (await limitedBody(response, 4096)).buffer;
    }
}

export async function probeSource({ source, sample, apiBase, fetchImpl = fetch, origin = DEFAULT_ORIGIN }) {
    const started = performance.now();
    const result = { source, id: sample.id, ok: false };
    try {
        const json = await apiJson(fetchImpl, apiBase, '/song/url/match', { id: String(sample.id), source });
        if (json.code === 429) throw fail('API_RATE_LIMITED');
        if (json.code !== 200 || typeof json.data !== 'string' || !json.data) throw fail('NO_LINK');
        if (/\/(?:jd-)?musicrep-ts\//i.test(json.data)) throw fail('TRIAL_LINK');
        let size = 0;
        const read = start => audioHeader(fetchImpl, json.data, start, value => { size = value; }, origin);
        const header = await read(0);
        const flac = parseFlacStreamInfoFromBuffer(header);
        let duration = 0;
        if (flac) {
            const bytes = new Uint8Array(header);
            const offset = bytes.findIndex((byte, index) => byte === 102 && bytes[index + 1] === 76
                && bytes[index + 2] === 97 && bytes[index + 3] === 67) + 8;
            if (offset >= 8 && offset + 18 <= bytes.length) {
                const samples = (bytes[offset + 13] & 15) * 4294967296 + new DataView(header).getUint32(offset + 14);
                duration = samples / flac.sampleRate;
            }
            Object.assign(result, { format: 'flac', sampleRate: flac.sampleRate, bits: flac.bitsPerSample });
        } else {
            const mp3 = await readMp3StreamInfo(read, { header, totalBytes: size });
            if (!mp3) throw fail('UNRECOGNIZED_AUDIO');
            duration = mp3.bitrateKbps ? size * 8 / mp3.bitrateKbps / 1000 : 0;
            Object.assign(result, { format: 'mp3', sampleRate: mp3.sampleRate, bitrateKbps: mp3.bitrateKbps });
        }
        result.size = size;
        result.durationSeconds = Math.round(duration * 100) / 100;
        if (!duration || Math.abs(duration - sample.durationMs / 1000) > Math.max(3, sample.durationMs / 1000 * 0.03)) {
            throw fail('DURATION_MISMATCH');
        }
        result.ok = true;
    } catch (error) {
        result.reason = errorCode(error);
    }
    result.elapsedMs = Math.round(performance.now() - started);
    return result;
}

export function summarizeSources(available, rows) {
    return available.map(source => {
        const attempts = rows.filter(row => row.source === source);
        const successes = attempts.filter(row => row.ok);
        const times = successes.map(row => row.elapsedMs).sort((a, b) => a - b);
        const medianMs = times.length ? times[Math.floor(times.length / 2)] : null;
        return { source, attempts: attempts.length, successes: successes.length,
            mp3: successes.filter(row => row.format === 'mp3').length,
            flac: successes.filter(row => row.format === 'flac').length,
            hires: successes.filter(row => row.format === 'flac' && (row.bits > 16 || row.sampleRate > 48000)).length,
            medianMs, slow: successes.length >= 2 && medianMs >= 5000 };
    });
}

export function planSourceUpdate(available, rows, orders = MATCH_SOURCE_ORDERS) {
    const metrics = summarizeSources(available, rows);
    if (!metrics.some(item => item.successes >= 2)) return { status: 'inconclusive', changed: false, orders, metrics };
    const configured = new Set(Object.values(orders).flat().filter(Boolean));
    const accepted = metrics.filter(item => configured.has(item.source) || item.successes >= 2);
    if (accepted.length < 2) return { status: 'inconclusive', changed: false, orders, metrics };
    const next = {};
    for (const profile of PROFILES) {
        const previous = orders[profile].filter(Boolean);
        const stable = [...previous, ...available.filter(source => !previous.includes(source)).sort()];
        const score = item => profile === 'hires' ? [item.hires, item.flac, item.successes, -Number(item.slow)]
            : profile === 'lossless' ? [item.flac, item.successes, -Number(item.slow)]
            : [item.successes, item.mp3, -Number(item.slow)];
        next[profile] = [...accepted].sort((a, b) => {
            const x = score(a), y = score(b);
            for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
            return stable.indexOf(a.source) - stable.indexOf(b.source);
        }).map(item => item.source).concat(null);
    }
    return { status: 'ready', changed: JSON.stringify(next) !== JSON.stringify(orders), orders: next, metrics };
}

export function renderSourceCatalog(orders) {
    const lines = PROFILES.map(profile => {
        const names = orders[profile];
        if (!Array.isArray(names) || names.at(-1) !== null || names.length < 2
            || names.slice(0, -1).some(name => typeof name !== 'string' || !/^[a-z0-9_-]+$/.test(name))
            || new Set(names).size !== names.length) throw fail('INVALID_SOURCE_ORDER');
        return `    ${profile}: [${names.map(name => name === null ? 'null' : `'${name}'`).join(', ')}]`;
    });
    return `export const MATCH_SOURCE_UPSTREAM = '${MATCH_SOURCE_UPSTREAM}';\n\nexport const MATCH_SOURCE_ORDERS = {\n${lines.join(',\n')}\n};\n`;
}

export async function runSourceAudit({ apiBase = DEFAULT_CONFIG.API_BASE_URL, fetchImpl = fetch,
    delayMs = 700, samples = selectDailySamples(), orders = MATCH_SOURCE_ORDERS, origin = DEFAULT_ORIGIN,
    concurrency = 1, deadlineMs = 12 * 60000, onProgress } = {}) {
    if (![1, 2].includes(concurrency)) throw fail('INVALID_CONCURRENCY');
    const started = performance.now();
    const base = publicUrl(apiBase);
    origin = publicUrl(origin).origin;
    if (base.search || base.hash) throw fail('INVALID_API_BASE');
    const directory = await checkMatchSources(fetchImpl);
    if (!directory.available.length || directory.available.length > MAX_SOURCES) throw fail('SOURCE_COUNT_LIMIT');
    const detail = await apiJson(fetchImpl, base.href, '/song/detail', { ids: samples.map(sample => sample.id).join(',') });
    const verified = samples.flatMap(sample => {
        const song = detail.songs?.find(song => song.id === sample.id);
        return song?.fee === 1 && Number.isFinite(song.dt) && song.dt > 35000 ? [{ ...sample, durationMs: song.dt }] : [];
    });
    if (verified.length < 2) throw fail('INSUFFICIENT_VIP_SAMPLES');
    const rows = [];
    const tasks = verified.flatMap(sample => directory.available.map(source => ({ source, sample })));
    let cursor = 0, stopped = null;
    await Promise.all(Array.from({ length: concurrency }, async () => {
        while (!stopped && cursor < tasks.length) {
            if (performance.now() - started >= deadlineMs) { stopped = 'AUDIT_DEADLINE'; break; }
            const { source, sample } = tasks[cursor++];
            if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
            if (stopped) break;
            const row = await probeSource({ source, sample, apiBase: base.href, fetchImpl, origin });
            rows.push(row);
            onProgress?.(row);
            if (row.reason === 'API_RATE_LIMITED') stopped = 'API_RATE_LIMITED';
        }
    }));
    if (stopped) return { status: 'inconclusive', reason: stopped,
        changed: false, orders, rows, metrics: summarizeSources(directory.available, rows), directory,
        samples: verified.map(({ id, name }) => ({ id, name })), apiHost: base.hostname, origin };
    return { ...planSourceUpdate(directory.available, rows, orders), directory, rows,
        samples: verified.map(({ id, name }) => ({ id, name })), apiHost: base.hostname, origin };
}

export function formatSourceReport(result, { daily = false } = {}) {
    const lines = ['## 音源目录与优先级检查', '', `状态：${result.status}${result.reason ? `（${result.reason}）` : ''}`, ''];
    if (result.apiHost) lines.push(`测试 API：${result.apiHost}`, '');
    if (result.origin) lines.push(`跨域来源：${result.origin}`, '');
    lines.push('| 来源 | 可读且长度匹配 | MP3 | FLAC | 高精度 FLAC | 耗时中位数 |', '| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const item of result.metrics || []) lines.push(`| ${item.source} | ${item.successes}/${item.attempts} | ${item.mp3} | ${item.flac} | ${item.hires} | ${item.medianMs === null ? '-' : `${item.medianMs}ms`} |`);
    if (result.directory?.missing.length) lines.push('', `上游已移除：${result.directory.missing.join('、')}`);
    if (result.samples) lines.push('', `样本：${result.samples.map(sample => `${sample.name}（${sample.id}）`).join('、')}`);
    if (!daily && result.status === 'ready') {
        lines.push('', '### 建议顺序', '');
        for (const profile of PROFILES) lines.push(`- ${profile}: ${result.orders[profile].map(name => name || 'auto').join(' → ')}`);
    }
    lines.push('', '检测项目：匿名跨域链接、受限文件头、音频长度。');
    if (daily) lines.push('本次保存每日检测记录，周一汇总最近七天后生成排序建议。', '');
    else lines.push(
        '检查优先考虑音质和成功样本数；同等结果保留原顺序，耗时中位数达到 5 秒的来源排在同等结果的其他来源之后。',
        '合并本 PR 后，名单随单文件重新构建；本工作流不自动合并或发布。', '');
    return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const now = new Date();
    const daily = process.argv.includes('--daily');
    if (daily && process.argv.includes('--write')) throw fail('DAILY_WRITE_NOT_ALLOWED');
    const apiBase = process.env.SOURCE_CHECK_API_URL || process.env.API_BASE_URL || DEFAULT_CONFIG.API_BASE_URL;
    const origin = process.env.SOURCE_CHECK_ORIGIN || DEFAULT_ORIGIN;
    let result;
    try {
        result = await runSourceAudit({ apiBase, origin, concurrency: daily ? 2 : 1, samples: selectDailySamples(now),
            onProgress(row) { console.log(`${row.source} / ${row.id}: ${row.ok ? '通过' : row.reason}`); } });
    } catch (error) {
        result = { status: 'inconclusive', reason: errorCode(error), changed: false };
    }
    if (daily) {
        result = { ...result, schemaVersion: SOURCE_AUDIT_VERSION, recordedAt: now.toISOString(), day: sourceDay(now),
            upstream: MATCH_SOURCE_UPSTREAM, apiHost: new URL(apiBase).hostname, origin: new URL(origin).origin };
        delete result.orders;
        delete result.changed;
    }
    const directory = path.join(ROOT, 'work/match-sources-audit');
    await fs.mkdir(directory, { recursive: true });
    const report = formatSourceReport(result, { daily });
    await fs.writeFile(path.join(directory, 'report.md'), report);
    await fs.writeFile(path.join(directory, daily ? 'daily.json' : 'report.json'), JSON.stringify(result, null, 2) + '\n');
    if (!daily && result.status === 'ready') {
        const candidate = renderSourceCatalog(result.orders);
        await fs.writeFile(path.join(directory, 'match-sources.js'), candidate);
        if (process.argv.includes('--write')) await fs.writeFile(path.join(ROOT, 'src/netease/match-sources.js'), candidate);
    } else await fs.rm(path.join(directory, 'match-sources.js'), { force: true });
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT,
        `status=${result.status}\nchanged=${!!result.changed}\nweekly=${new Date(sourceDay(now)).getUTCDay() === 1}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, report);
    console.log(report);
    if (result.status !== 'ready') process.exitCode = 2;
}
