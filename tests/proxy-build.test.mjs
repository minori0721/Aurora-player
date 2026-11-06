import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { build, buildHtml, ROOT } from '../scripts/build.mjs';
import { DEFAULT_CONFIG, readPublicConfig } from '../scripts/config.mjs';
import { checkHtml } from '../scripts/check.mjs';

test('proxy defaults follow Cloudflare deployment, while generic, Vercel and CI builds use music.moerika.com', () => {
    assert.equal(DEFAULT_CONFIG.DOWNLOAD_PROXY_URL, 'https://music.moerika.com/proxy-download');
    for (const env of [{}, { VERCEL: '1' }, { GITHUB_ACTIONS: 'true' }, { CF_PAGES: '0' }, { WORKERS_CI: '0' }]) {
        assert.equal(readPublicConfig(env).DOWNLOAD_PROXY_URL, DEFAULT_CONFIG.DOWNLOAD_PROXY_URL);
    }
    for (const env of [{ CF_PAGES: '1' }, { WORKERS_CI: '1' }]) {
        assert.equal(readPublicConfig(env).DOWNLOAD_PROXY_URL, '/proxy-download');
        assert.equal(readPublicConfig({ ...env, DOWNLOAD_PROXY_URL: 'https://custom.example/download/' }).DOWNLOAD_PROXY_URL, 'https://custom.example/download');
    }
    assert.equal(readPublicConfig({}, { cloudflare: true }).DOWNLOAD_PROXY_URL, '/proxy-download');
    assert.equal(readPublicConfig({ DOWNLOAD_PROXY_URL: '   ' }).DOWNLOAD_PROXY_URL, DEFAULT_CONFIG.DOWNLOAD_PROXY_URL);
    for (const url of ['javascript:alert(1)', 'https://user:password@example.com', '//example.com', '/proxy-download',
        'https://example.com?token=private', 'https://example.com/#private']) {
        assert.throws(() => readPublicConfig({ DOWNLOAD_PROXY_URL: url }));
    }
});

test('Cloudflare HTML uses the same-site route over HTTP(S) and the public proxy from file://', async () => {
    const result = await buildHtml({ env: { CF_PAGES: '1' } });
    assert.equal(checkHtml(result.html, result.version), 5);
    const script = result.html.match(/<script data-aurora="config">([\s\S]*?)<\/script>/)[1];
    for (const protocol of ['https:', 'http:', 'file:']) {
        const window = { location: { protocol } };
        vm.runInNewContext(script, { window });
        assert.equal(window.DOWNLOAD_PROXY_URL, protocol === 'file:' ? DEFAULT_CONFIG.DOWNLOAD_PROXY_URL : '/proxy-download');
    }
    const custom = await buildHtml({ env: { CF_PAGES: '1', DOWNLOAD_PROXY_URL: 'https://custom.example/proxy' } });
    const window = { location: { protocol: 'file:' } };
    vm.runInNewContext(custom.html.match(/<script data-aurora="config">([\s\S]*?)<\/script>/)[1], { window });
    assert.equal(window.DOWNLOAD_PROXY_URL, 'https://custom.example/proxy');
});

test('Pages generates its bundled Function and exact route; generic builds remove only generated sidecars', async t => {
    const work = path.join(ROOT, 'work'); await fs.mkdir(work, { recursive: true });
    const output = await fs.mkdtemp(path.join(work, 'proxy-build-'));
    t.after(async () => {
        const resolved = await fs.realpath(output), root = await fs.realpath(ROOT);
        assert.ok(resolved.startsWith(root + path.sep));
        await fs.rm(resolved, { recursive: true, force: true });
    });
    await fs.writeFile(path.join(output, 'keep.txt'), 'unrelated');
    const pages = await build({ outdir: output, env: { CF_PAGES: '1' } });
    assert.equal(pages.config.DOWNLOAD_PROXY_URL, '/proxy-download');
    const code = await fs.readFile(path.join(output, '_worker.js'), 'utf8');
    assert.doesNotMatch(code, /\bimport\b/);
    const routes = JSON.parse(await fs.readFile(path.join(output, '_routes.json'), 'utf8'));
    assert.deepEqual(routes, { version: 1, include: ['/proxy-download'], exclude: [] });
    const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
    const preflight = await worker.fetch(new Request('https://player.example/proxy-download', { method: 'OPTIONS' }), {});
    assert.equal(preflight.status, 204);
    const home = await worker.fetch(new Request('https://player.example/'), { ASSETS: { fetch: () => new Response('site') } });
    assert.equal(await home.text(), 'site');
    const standalone = await build({ outdir: output, env: {} });
    assert.equal(standalone.config.DOWNLOAD_PROXY_URL, DEFAULT_CONFIG.DOWNLOAD_PROXY_URL);
    assert.deepEqual((await fs.readdir(output)).sort(), ['index.html', 'keep.txt']);
    const workers = await build({ outdir: output, env: {}, cloudflare: true });
    assert.equal(workers.config.DOWNLOAD_PROXY_URL, '/proxy-download');
    assert.deepEqual((await fs.readdir(output)).sort(), ['index.html', 'keep.txt']);
});
