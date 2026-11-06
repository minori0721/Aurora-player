import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MATCH_SOURCE_ORDERS, MATCH_SOURCE_UPSTREAM } from '../src/netease/match-sources.js';

export function auditMatchSources(files, orders = MATCH_SOURCE_ORDERS) {
    const available = new Set(files.filter(file => file.type === 'file' && /^[a-z0-9_-]+\.js$/.test(file.name))
        .map(file => file.name.slice(0, -3)));
    const configured = new Set(Object.values(orders).flat().filter(Boolean));
    return {
        missing: [...configured].filter(name => !available.has(name)).sort(),
        unconfigured: [...available].filter(name => !configured.has(name)).sort(),
        available: [...available].sort()
    };
}

export async function checkMatchSources(fetchImpl = fetch) {
    const response = await fetchImpl(`https://api.github.com/repos/${MATCH_SOURCE_UPSTREAM}/contents/modules`, {
        headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Upstream source directory: HTTP ${response.status}`);
    const files = await response.json();
    if (!Array.isArray(files) || !files.some(file => file.type === 'file' && file.name.endsWith('.js'))) {
        throw new Error('Upstream source directory is empty or invalid');
    }
    return auditMatchSources(files);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const result = await checkMatchSources();
        console.log(JSON.stringify({ upstream: MATCH_SOURCE_UPSTREAM, ...result }, null, 2));
        if (result.missing.length) process.exitCode = 1;
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
