import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const read = name => fs.readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');

test('Check gates Pages and Release on the same verified artifact', async () => {
    const check = await read('check');
    assert.match(check, /os: \[ubuntu-latest, windows-latest\]/);
    assert.match(check, /run: npm test/);
    for (const job of ['pages', 'release']) {
        const block = check.slice(check.indexOf(`\n  ${job}:`) + 1).split(/\n  [a-z]+:/)[0];
        assert.match(block, /needs: check/);
        assert.match(block, /github\.event_name != 'pull_request'/);
        assert.match(block, /artifact-name: aurora-site-\$\{\{ github.sha \}\}/);
    }
    assert.match(check, /if-no-files-found: error/);
    assert.match(check, /overwrite: true/);
    assert.doesNotMatch(check, /github.run_attempt/);
    assert.match(check, /API_BASE_URL: \$\{\{ vars.API_BASE_URL \}\}/);
    assert.match(check, /DOWNLOAD_PROXY_URL: \$\{\{ vars.DOWNLOAD_PROXY_URL \}\}/);
});

test('deployment consumers download this run artifact without rebuilding or retriggering checks', async () => {
    for (const name of ['pages', 'release']) {
        const text = await read(name);
        assert.match(text, /workflow_call:/);
        assert.doesNotMatch(text, /workflow_run:|workflow_dispatch:|\n  push:/);
        assert.match(text, /uses: actions\/download-artifact@[a-f0-9]{40}/);
        assert.match(text, /name: \$\{\{ inputs.artifact-name \}\}/);
        assert.doesNotMatch(text, /run: npm (?:test|run (?:check|build))|run-id:|repository:/);
    }
    assert.match(await read('pages'), /if: github.ref == 'refs\/heads\/minori0721-test-1'/);
    assert.match(await read('release'), /ref: \$\{\{ github.sha \}\}/);
});

test('all third-party Actions stay pinned and builds do not hold deployment permissions', async () => {
    for (const name of ['check', 'pages', 'release']) {
        const text = await read(name);
        for (const [, target] of text.matchAll(/uses: ([^\s]+)/g)) {
            if (!target.startsWith('./')) assert.match(target, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
        }
        assert.doesNotMatch(text, /permissions: write-all/);
        assert.match(text, /permissions:\s+contents: read/);
    }
    const check = await read('check');
    const matrix = check.slice(check.indexOf('\n  check:'), check.indexOf('\n  pages:'));
    assert.doesNotMatch(matrix, /contents: write|pages: write|id-token: write|GH_TOKEN/);
});
