import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseNotes, validateReleaseTag } from '../scripts/release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => fs.readFile(path.join(root, file), 'utf8');

test('package, lockfile, README and current release notes use the same version', async () => {
    const pkg = JSON.parse(await read('package.json'));
    const lock = JSON.parse(await read('package-lock.json'));
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
    assert.ok((await read('README.md')).includes(`当前版本：v${pkg.version}`));
    const changelog = await read('changelog.md');
    const heading = changelog.split(/\r?\n/).find(line => line.startsWith('## '));
    assert.match(heading, new RegExp(`^## v${pkg.version.replaceAll('.', '\\.')} - \\d{4}-\\d{2}-\\d{2}$`));
    validateReleaseTag(`v${pkg.version}`, pkg.version);
    const notes = releaseNotes(changelog, pkg.version);
    assert.ok(notes.trim().length > 0);
    assert.equal(changelog.split(`## v${pkg.version} - `).length, 2);
});

test('documentation relative links resolve inside the repository', async () => {
    const pages = ['README.md', 'changelog.md', ...(await fs.readdir(path.join(root, 'docs')))
        .filter(name => name.endsWith('.md')).map(name => `docs/${name}`)];
    for (const page of pages) {
        const text = (await read(page)).replace(/^```[^\n]*\n[\s\S]*?^```/gm, '');
        for (const [, raw] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
            if (/^(?:https?:|mailto:|#)/i.test(raw)) continue;
            const relative = decodeURIComponent(raw.split('#')[0]);
            const target = path.resolve(root, path.dirname(page), relative);
            assert.ok(target.startsWith(root), `${page}: link leaves repository: ${raw}`);
            assert.ok((await fs.stat(target)).isFile(), `${page}: missing linked file: ${raw}`);
        }
    }
});

test('README links to focused guides rather than maintaining internal parameter sections', async () => {
    const readme = await read('README.md');
    for (const name of ['usage', 'deployment', 'technical', 'architecture']) assert.ok(readme.includes(`docs/${name}.md`));
    assert.ok(!/^## .*算法细节/m.test(readme));
    assert.ok(!/^### .*API 行为与边界/m.test(readme));
    assert.ok(!/^### .*离线依赖、缓存与隐私/m.test(readme));
});
