import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceDay, selectDailySamples, SOURCE_SAMPLES, SOURCE_AUDIT_VERSION } from '../scripts/update-match-sources.mjs';
import { MATCH_SOURCE_UPSTREAM } from '../src/netease/match-sources.js';
import { validateSourceSnapshot, selectSourceHistory, planWeeklySourceUpdate, formatWeeklySourceReport } from '../scripts/source-history.mjs';
import { collectSourceHistory, readSourceSnapshot } from '../scripts/summarize-match-sources.mjs';

const NOW = new Date('2026-11-09T03:10:00Z');
const DAY = 86400000;
const orders = names => Object.fromEntries(['balanced', 'lossless', 'hires'].map(profile => [profile, [...names, null]]));
function snapshot(age, providers = { a: 6, b: 6 }, options = {}) {
    const recordedAt = new Date(NOW.getTime() - age * DAY).toISOString();
    const samples = Array.from({ length: 6 }, (_, i) => ({ id: i + 1 }));
    return { schemaVersion: SOURCE_AUDIT_VERSION, upstream: MATCH_SOURCE_UPSTREAM, recordedAt, day: sourceDay(recordedAt),
        status: 'ready', apiHost: 'api.test', origin: 'https://music.test', directory: { available: Object.keys(providers) }, samples,
        rows: Object.entries(providers).flatMap(([source, count]) => samples.map(({ id }) => ({
            source, id, ok: id <= count, format: 'mp3', sampleRate: 44100, elapsedMs: 600, reason: 'HTTP_500',
            ...(options[source] || {}) }))) };
}
const week = factory => Array.from({ length: 7 }, (_, age) => factory(age));

test('Shanghai day boundaries and rotating samples keep three anchors and cover twelve songs', () => {
    assert.equal(sourceDay('2026-11-08T15:59:59Z'), '2026-11-08');
    assert.equal(sourceDay('2026-11-08T16:00:00Z'), '2026-11-09');
    const selections = [0, 1, 2].map(age => selectDailySamples(new Date(NOW.getTime() - age * DAY)));
    for (const samples of selections) {
        assert.equal(samples.length, 6);
        assert.deepEqual(samples.slice(0, 3), SOURCE_SAMPLES.slice(0, 3));
        assert.equal(new Set(samples.map(sample => sample.id)).size, 6);
    }
    assert.equal(new Set(selections.flat().map(sample => sample.id)).size, 12);
});

test('history retains seven local days and only the latest observation per day', () => {
    const earlier = snapshot(1); earlier.recordedAt = new Date(Date.parse(earlier.recordedAt) - 60000).toISOString();
    const failed = { ...snapshot(1), status: 'inconclusive', rows: undefined };
    const records = [...week(age => snapshot(age)), snapshot(7), snapshot(-1), earlier, failed,
        { ...snapshot(2), origin: 'https://other.test' }, { ...snapshot(3), apiHost: 'other.test' }];
    const selected = selectSourceHistory(records, { now: NOW, apiHost: 'api.test', origin: 'https://music.test' });
    assert.equal(selected.length, 7);
    assert.equal(selected[1].status, 'inconclusive');
    assert.equal(new Set(selected.map(day => day.day)).size, 7);
});

test('recent days carry a two-day half-life rather than winning by raw weekly totals', () => {
    const records = week(age => snapshot(age, { a: age < 3 ? 5 : 2, b: 3 }));
    const result = planWeeklySourceUpdate(records, { now: NOW, orders: orders(['b', 'a']) });
    assert.equal(result.status, 'ready');
    const weights = week(age => 2 ** (-age / 2));
    const expected = weights.reduce((sum, weight, age) => sum + weight * (age < 3 ? 5 : 2) / 6, 0)
        / weights.reduce((sum, weight) => sum + weight, 0);
    assert.ok(Math.abs(result.metrics.find(item => item.source === 'a').availableRate - expected) < 1e-12);
    assert.equal(result.orders.balanced[0], 'a');
    assert.ok(weights.slice(0, 3).reduce((sum, x) => sum + x, 0) / weights.reduce((sum, x) => sum + x, 0) > 0.7);
});

test('small weighted differences preserve order and format-specific profiles remain independent', () => {
    const close = planWeeklySourceUpdate(week(age => snapshot(age, { a: age === 0 ? 5 : 6, b: 6 })),
        { now: NOW, orders: orders(['a', 'b']) });
    assert.equal(close.changed, false);
    const formats = planWeeklySourceUpdate(week(age => snapshot(age, { a: 6, b: 6 },
        { b: { format: 'flac', bits: 24, sampleRate: 48000 } })), { now: NOW, orders: orders(['a', 'b']) });
    assert.equal(formats.orders.balanced[0], 'a');
    assert.equal(formats.orders.lossless[0], 'b');
    assert.equal(formats.orders.hires[0], 'b');
});

test('a latest source-specific outage outranks old successes without removing the source', () => {
    const result = planWeeklySourceUpdate(week(age => snapshot(age, { a: age === 0 ? 0 : 6, b: 3 })),
        { now: NOW, orders: orders(['a', 'b']) });
    assert.deepEqual(result.orders.balanced, ['b', 'a', null]);
    assert.equal(result.metrics.find(item => item.source === 'a').recentOutage, true);
});

test('missing current data, a current global outage, and fewer than three days preserve the catalog', () => {
    const initial = orders(['a', 'b']);
    const inputs = [week(age => snapshot(age + 1)), [snapshot(0), snapshot(1)],
        [{ ...snapshot(0), status: 'inconclusive' }, ...week(age => snapshot(age + 1))],
        [snapshot(0, { a: 0, b: 0 }), snapshot(1), snapshot(2)]];
    for (const records of inputs) {
        const result = planWeeklySourceUpdate(records, { now: NOW, orders: initial });
        assert.equal(result.status, 'inconclusive'); assert.equal(result.changed, false);
        assert.equal(result.orders, initial);
    }
});

test('new sources require three successful days and distinct songs while retired modules disappear', () => {
    const records = week(age => snapshot(age, { a: 6, b: 6, fresh: age < 2 ? 6 : 0, narrow: 2 }));
    const initial = orders(['retired', 'a', 'b']);
    const result = planWeeklySourceUpdate(records, { now: NOW, orders: initial });
    assert.deepEqual(result.orders.balanced, ['a', 'b', null]);
    records[2] = snapshot(2, { a: 6, b: 6, fresh: 6, narrow: 2 });
    assert.ok(planWeeklySourceUpdate(records, { now: NOW, orders: initial }).orders.balanced.includes('fresh'));
});

test('slow timing matters only after quality ties and adequate daily evidence', () => {
    const result = planWeeklySourceUpdate(week(age => snapshot(age, { a: 6, b: 6 }, { a: { elapsedMs: 6000 } })),
        { now: NOW, orders: orders(['a', 'b']) });
    assert.equal(result.orders.balanced[0], 'b');
    const near = planWeeklySourceUpdate(week(age => snapshot(age, { a: 6, b: 6 }, { a: { elapsedMs: 1200 } })),
        { now: NOW, orders: orders(['a', 'b']) });
    assert.equal(near.changed, false);
});

test('snapshots exclude secret-like extra fields and reject malformed or partial matrices', () => {
    const raw = snapshot(0); raw.cookie = 'secret-cookie'; raw.rows[0].url = 'https://cdn.test/?key=secret-link';
    const safe = validateSourceSnapshot(raw);
    assert.doesNotMatch(JSON.stringify(safe), /secret-cookie|secret-link|cdn.test/);
    for (const input of [{ ...raw, schemaVersion: 100 }, { ...raw, day: 'wrong' },
        { ...raw, directory: { available: ['x|injected'] } }, { ...raw, rows: [...raw.rows, raw.rows[0]] },
        { ...raw, samples: [{ id: 1 }, { id: 1 }] }, { ...raw, samples: [null, { id: 1 }] },
        { ...raw, rows: [null] }]) assert.equal(validateSourceSnapshot(input), null);
    const partial = validateSourceSnapshot({ ...raw, rows: raw.rows.slice(1) });
    assert.equal(partial.status, 'inconclusive');
    const limited = structuredClone(raw); limited.rows[0] = { ...limited.rows[0], ok: false, reason: 'API_RATE_LIMITED' };
    assert.equal(validateSourceSnapshot(limited).status, 'inconclusive');
    const result = planWeeklySourceUpdate([raw, snapshot(1), snapshot(2)], { now: NOW, orders: orders(['a', 'b']) });
    assert.doesNotMatch(formatWeeklySourceReport(result), /secret-cookie|secret-link|cdn.test/);
});

test('cross-run collection restricts branch, event and repository and tolerates missing artifacts', async () => {
    const item = id => ({ id, head_branch: 'main', head_repository: { full_name: 'owner/repo' },
        status: 'completed', event: 'schedule', created_at: NOW.toISOString() });
    const runs = [item(11), item(12), item(99), { ...item(13), event: 'pull_request' },
        { ...item(14), head_branch: 'other' }, { ...item(15), head_repository: { full_name: 'fork/repo' } }];
    const calls = [], warnings = [];
    const records = await collectSourceHistory({ repository: 'owner/repo', branch: 'main', runId: 99,
        directory: 'work/history', now: NOW, onWarning: message => warnings.push(message),
        executeImpl: async (command, args, options) => {
            calls.push({ command, args, options });
            if (args[0] === 'api') return { stdout: JSON.stringify({ workflow_runs: runs }) };
            if (args[2] === '12') throw new Error('artifact expired');
            return { stdout: '' };
        }, readImpl: async () => snapshot(1) });
    assert.equal(records.length, 1); assert.equal(warnings.length, 1);
    assert.equal(calls.filter(call => call.args[0] === 'run').length, 2);
    assert.ok(calls.every(call => call.command === 'gh' && call.options.timeout === 30000));
    assert.doesNotMatch(JSON.stringify(calls), /GH_TOKEN|secret/);
    await assert.rejects(collectSourceHistory({ repository: '../bad', branch: 'main', runId: 99 }), /CONTEXT/);
});

test('snapshot file reads enforce a small payload and parse only the declared schema', async () => {
    const root = fileURLToPath(new URL('../work/', import.meta.url));
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, 'source-history-test-'));
    const file = path.join(directory, 'daily.json');
    try {
        await fs.writeFile(file, JSON.stringify(snapshot(0)));
        assert.equal((await readSourceSnapshot(file)).status, 'ready');
        await fs.writeFile(file, 'x'.repeat(256 * 1024 + 1));
        await assert.rejects(readSourceSnapshot(file), /TOO_LARGE/);
        await fs.writeFile(file, '{}');
        await assert.rejects(readSourceSnapshot(file), /INVALID_SNAPSHOT/);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('weekly reports can be reconstructed from stored daily JSON without a second audio probe', async () => {
    const root = fileURLToPath(new URL('../work/', import.meta.url));
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, 'source-history-test-'));
    try {
        const files = [];
        for (let age = 0; age < 7; age++) {
            const file = path.join(directory, `${age}.json`);
            await fs.writeFile(file, JSON.stringify(snapshot(age, { a: 3, b: 6 }, { b: { format: 'flac', bits: 24 } })));
            files.push(file);
        }
        const records = await Promise.all(files.map(readSourceSnapshot));
        const result = planWeeklySourceUpdate(records, { now: NOW, orders: orders(['a', 'b']) });
        assert.equal(result.days, 7); assert.equal(result.status, 'ready');
        assert.equal(result.orders.lossless[0], 'b');
        assert.equal(result.metrics.find(item => item.source === 'a').attempts, 42);
        assert.match(formatWeeklySourceReport(result), /2026-11-09/);
        const rerun = planWeeklySourceUpdate([...records, ...records], { now: NOW, orders: result.orders });
        assert.equal(rerun.changed, false);
        assert.equal(rerun.metrics.find(item => item.source === 'a').attempts, 42);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
