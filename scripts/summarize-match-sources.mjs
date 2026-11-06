import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceDay, renderSourceCatalog } from './update-match-sources.mjs';
import { validateSourceSnapshot, planWeeklySourceUpdate, formatWeeklySourceReport } from './source-history.mjs';

const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUTPUT = path.join(ROOT, 'work/match-sources-weekly');
const DAY = 86400000;

export async function readSourceSnapshot(file) {
    const stat = await fs.stat(file);
    if (stat.size > 256 * 1024) throw new Error('SNAPSHOT_TOO_LARGE');
    const snapshot = validateSourceSnapshot(JSON.parse(await fs.readFile(file, 'utf8')));
    if (!snapshot) throw new Error('INVALID_SNAPSHOT');
    return snapshot;
}

export async function collectSourceHistory({ repository, branch, runId, directory, now = new Date(),
    executeImpl = execute, readImpl = readSourceSnapshot, onWarning = () => {} }) {
    if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9_][a-z0-9_.-]*$/i.test(repository) || typeof branch !== 'string' || !branch
        || !/^\d+$/.test(String(runId))) throw new Error('INVALID_RUN_CONTEXT');
    const since = new Date(Date.parse(sourceDay(now)) - 7 * DAY).toISOString();
    const run = args => executeImpl('gh', args, { timeout: 30000, maxBuffer: 1024 * 1024 });
    const response = await run(['api', '--method', 'GET', `repos/${repository}/actions/workflows/match-sources.yml/runs`,
        '-f', `branch=${branch}`, '-f', 'per_page=50', '-f', `created=>=${since}`]);
    const runs = JSON.parse(response.stdout).workflow_runs;
    if (!Array.isArray(runs)) throw new Error('INVALID_WORKFLOW_RUNS');
    const candidates = runs.filter(item => Number.isSafeInteger(item.id) && item.id > 0
        && String(item.id) !== String(runId) && item.head_branch === branch
        && item.head_repository?.full_name === repository && item.status === 'completed'
        && ['schedule', 'workflow_dispatch'].includes(item.event))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 21);
    const records = [];
    for (const item of candidates) {
        const destination = path.join(directory, String(item.id));
        try {
            await run(['run', 'download', String(item.id), '--repo', repository,
                '--name', 'match-sources-daily', '--dir', destination]);
            records.push(await readImpl(path.join(destination, 'daily.json')));
        } catch {
            onWarning(`无法读取历史检测 ${item.id}，本次按缺测处理。`);
        }
    }
    return records;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const now = new Date();
    await fs.mkdir(OUTPUT, { recursive: true });
    let result;
    try {
        const current = await readSourceSnapshot(path.join(ROOT, 'work/match-sources-audit/daily.json'));
        const records = [current, ...await collectSourceHistory({ repository: process.env.GITHUB_REPOSITORY,
            branch: process.env.GITHUB_REF_NAME, runId: process.env.GITHUB_RUN_ID,
            directory: path.join(OUTPUT, 'history'), now, onWarning: message => console.warn(message) })];
        result = planWeeklySourceUpdate(records, { now, apiHost: current.apiHost, origin: current.origin });
    } catch {
        // Failed history reads are not evidence that an audio source has failed.
        result = { status: 'inconclusive', reason: 'HISTORY_UNAVAILABLE', changed: false, days: 0, history: [], metrics: [] };
    }
    const report = formatWeeklySourceReport(result);
    await fs.writeFile(path.join(OUTPUT, 'report.md'), report);
    await fs.writeFile(path.join(OUTPUT, 'report.json'), JSON.stringify(result, null, 2) + '\n');
    if (result.status === 'ready') await fs.writeFile(path.join(OUTPUT, 'match-sources.js'), renderSourceCatalog(result.orders));
    else await fs.rm(path.join(OUTPUT, 'match-sources.js'), { force: true });
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `status=${result.status}\nchanged=${!!result.changed}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, report);
    console.log(report);
}
