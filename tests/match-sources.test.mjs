import test from 'node:test';
import assert from 'node:assert/strict';
import { auditMatchSources, checkMatchSources } from '../scripts/check-match-sources.mjs';
import { MATCH_SOURCE_ORDERS } from '../src/netease/match-sources.js';

const entries = names => names.map(name => ({ type: 'file', name: `${name}.js` }));

test('upstream directory audit identifies retired and newly available providers without changing priority', () => {
    const orders = { balanced: ['msls', 'retired', null], lossless: ['byfuns', 'msls', null] };
    const before = structuredClone(orders);
    const result = auditMatchSources([...entries(['byfuns', 'msls', 'ddyr']), { type: 'dir', name: 'nested.js' }, { type: 'file', name: 'README.md' }], orders);
    assert.deepEqual(result, { missing: ['retired'], unconfigured: ['ddyr'], available: ['byfuns', 'ddyr', 'msls'] });
    assert.deepEqual(orders, before);
});

test('source audit only downloads directory metadata from the fixed upstream repository', async () => {
    let calls = 0;
    const configured = [...new Set(Object.values(MATCH_SOURCE_ORDERS).flat().filter(Boolean))];
    const result = await checkMatchSources(async (url, options) => {
        calls++;
        assert.equal(url, 'https://api.github.com/repos/NeteaseCloudMusicApiEnhanced/UnblockNeteaseMusic-utils/contents/modules');
        assert.equal(options.headers.Authorization, undefined);
        return new Response(JSON.stringify(entries([...configured, 'brandnew'])));
    });
    assert.equal(calls, 1); assert.deepEqual(result.missing, []); assert.deepEqual(result.unconfigured, ['brandnew']);
});

test('an unavailable or malformed upstream directory cannot be reported as a successful audit', async () => {
    await assert.rejects(checkMatchSources(async () => new Response('{}', { status: 403 })), /HTTP 403/);
    for (const value of [{ message: 'rate limited' }, [], [{ type: 'dir', name: 'modules' }]]) {
        await assert.rejects(checkMatchSources(async () => new Response(JSON.stringify(value))), /empty or invalid/);
    }
});
