import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const readJson = async name => JSON.parse(await fs.readFile(new URL(`../${name}`, import.meta.url), 'utf8'));

test('Cloudflare serves a same-site download route while Vercel stays static', async () => {
    const cloudflare = await readJson('wrangler.json');
    const vercel = await readJson('vercel.json');
    const pkg = await readJson('package.json');
    assert.match(cloudflare.name, /^[a-z0-9][a-z0-9-]{0,62}$/);
    assert.match(cloudflare.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(cloudflare.assets.directory, `./${vercel.outputDirectory}`);
    assert.equal(vercel.outputDirectory, 'dist');
    assert.equal(cloudflare.build.command, 'npm run build:cloudflare');
    assert.equal(vercel.buildCommand, 'npm run build');
    assert.ok(pkg.scripts.build);
    assert.equal(pkg.scripts['build:cloudflare'], 'node scripts/build.mjs --cloudflare');
    assert.equal(vercel.installCommand, 'npm ci');
    assert.equal(vercel.framework, null);
    assert.equal(cloudflare.assets.not_found_handling, '404-page');
    assert.equal(cloudflare.main, 'server/cloudflare.js');
    assert.equal(cloudflare.assets.binding, 'ASSETS');
    assert.deepEqual(cloudflare.assets.run_worker_first, ['/proxy-download']);
    assert.ok((await fs.stat(new URL(`../${cloudflare.main}`, import.meta.url))).isFile());
    assert.equal('vars' in cloudflare, false, 'public endpoints are build-time configuration, not Worker bindings');
});
