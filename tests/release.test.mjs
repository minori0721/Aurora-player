import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, buildHtml } from '../scripts/build.mjs';
import { publishRelease } from '../scripts/release.mjs';

const built = await buildHtml({ env: {} });
async function fixture(run) {
    const parent = path.join(ROOT, 'test-results');
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'release-'));
    try {
        await fs.mkdir(path.join(root, 'dist'));
        await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: built.version }));
        await fs.writeFile(path.join(root, 'changelog.md'), `## v${built.version} - 2026-10-18\n\n### Changed\n\n- tested`);
        await fs.writeFile(path.join(root, 'dist/index.html'), built.html);
        await run(root);
    } finally {
        assert.ok(path.resolve(root).startsWith(path.resolve(parent) + path.sep));
        await fs.rm(root, { recursive: true, force: true });
    }
}

test('first release creates a draft, attaches index.html, then publishes', () => fixture(async root => {
    const commands = [];
    await publishRelease(`v${built.version}`, { root, runGh(args) {
        commands.push(args);
        if (args[1] === 'view') throw Object.assign(new Error('missing'), { stderr: 'release not found' });
        return '';
    } });
    assert.deepEqual(commands.map(args => args[1]), ['view', 'create', 'upload', 'edit']);
    assert.ok(commands[1].includes('--draft'));
    assert.ok(commands[1].includes('--verify-tag'));
    assert.equal(path.basename(commands[2][3]), 'index.html');
    assert.ok(commands[3].includes('--draft=false'));
    await assert.rejects(fs.access(path.join(root, 'test-results/release-notes.md')));
}));

test('retry resumes an existing draft without creating another release', () => fixture(async root => {
    const commands = [];
    await publishRelease(`v${built.version}`, { root, runGh(args) {
        commands.push(args);
        return args[1] === 'view' ? '{"isDraft":true}' : '';
    } });
    assert.deepEqual(commands.map(args => args[1]), ['view', 'upload', 'edit']);
}));

test('published versions and authentication failures are not overwritten', () => fixture(async root => {
    for (const mode of ['published', 'auth']) {
        let calls = 0;
        await assert.rejects(publishRelease(`v${built.version}`, { root, runGh() {
            calls++;
            if (mode === 'auth') throw Object.assign(new Error('denied'), { stderr: 'Authentication failed' });
            return '{"isDraft":false}';
        } }));
        assert.equal(calls, 1);
    }
}));

test('failed attachment upload never publishes an empty release', () => fixture(async root => {
    const commands = [];
    await assert.rejects(publishRelease(`v${built.version}`, { root, runGh(args) {
        commands.push(args);
        if (args[1] === 'view') throw Object.assign(new Error('missing'), { stderr: 'release not found' });
        if (args[1] === 'upload') throw new Error('upload failed');
        return '';
    } }));
    assert.deepEqual(commands.map(args => args[1]), ['view', 'create', 'upload']);
}));
