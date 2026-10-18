import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, buildHtml } from '../scripts/build.mjs';
import { publishRelease } from '../scripts/release.mjs';

const built = await buildHtml({ env: {} });
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
const TAG_OBJECT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const tag = `v${built.version}`;
const failure = stderr => Object.assign(new Error(stderr), { stderr });

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

function github({ draft = false, published = false, tagCommit = null, annotated = false, uploadFails = false, size = Buffer.byteLength(built.html), authFails = false, tagFails = false, moveDuringUpload = false, malformedRelease = false, createTagFails = false, missingAttachment = false } = {}) {
    const commands = [];
    const runGh = args => {
        commands.push(args);
        if (authFails) throw failure('Authentication failed');
        if (args[0] === 'release') {
            if (args[1] === 'view') {
                if (args.at(-1) === 'assets') return JSON.stringify({ assets: missingAttachment ? [] : [{ name: 'index.html', size }] });
                if (malformedRelease) return '{}';
                if (!draft && !published) throw failure('release not found');
                return JSON.stringify({ isDraft: !published, url: `https://example.com/releases/${tag}` });
            }
            if (args[1] === 'create') { draft = true; return ''; }
            if (args[1] === 'upload') {
                if (uploadFails) throw failure('upload failed');
                if (moveDuringUpload) tagCommit = OTHER;
                return '';
            }
            if (args[1] === 'edit') { published = true; return ''; }
        }
        if (args[0] === 'api') {
            if (tagFails) throw failure('Resource not accessible (HTTP 403)');
            if (args.includes('POST')) {
                if (createTagFails) throw failure('Tag creation failed (HTTP 403)');
                assert.ok(args.includes(`ref=refs/tags/${tag}`));
                assert.ok(args.includes(`sha=${COMMIT}`));
                tagCommit = COMMIT;
                return '';
            }
            if (args[1].includes('/git/ref/tags/')) {
                if (!tagCommit) throw failure('Not Found (HTTP 404)');
                return JSON.stringify({ object: annotated ? { type: 'tag', sha: TAG_OBJECT } : { type: 'commit', sha: tagCommit } });
            }
            if (args[1].endsWith(`/git/tags/${TAG_OBJECT}`)) return JSON.stringify({ object: { type: 'commit', sha: tagCommit } });
        }
        throw new Error(`Unexpected mock command: ${args.join(' ')}`);
    };
    return { commands, runGh };
}

const publish = (root, mock, explicitTag) => publishRelease(explicitTag, { root, runGh: mock.runGh, commit: COMMIT });

test('new manifest version creates a pinned tag, uploads a draft, verifies attachment, then publishes', () => fixture(async root => {
    const mock = github();
    const result = await publish(root, mock);
    assert.deepEqual(result, { status: 'published', tag, commit: COMMIT });
    const commands = mock.commands;
    const tagIndex = commands.findIndex(args => args.includes('POST'));
    const createIndex = commands.findIndex(args => args[1] === 'create');
    const uploadIndex = commands.findIndex(args => args[1] === 'upload');
    const verifyIndex = commands.findIndex(args => args.at(-1) === 'assets');
    const publishIndex = commands.findIndex(args => args[1] === 'edit');
    assert.ok(tagIndex < createIndex && createIndex < uploadIndex && uploadIndex < verifyIndex && verifyIndex < publishIndex);
    assert.ok(commands[createIndex].includes('--draft'));
    assert.ok(commands[createIndex].includes('--verify-tag'));
    assert.equal(path.basename(commands[uploadIndex][3]), 'index.html');
    assert.ok(commands[publishIndex].includes('--draft=false'));
    await assert.rejects(fs.access(path.join(root, 'test-results/release-notes.md')));
}));

test('draft retry and lightweight or annotated tags only resume the same checked commit', () => fixture(async root => {
    for (const annotated of [false, true]) {
        const mock = github({ draft: true, tagCommit: COMMIT, annotated });
        assert.equal((await publish(root, mock, tag)).status, 'published');
        assert.equal(mock.commands.some(args => args[1] === 'create' || args.includes('POST')), false);
    }
}));

test('an existing tag without a release completes publication without changing the tag', () => fixture(async root => {
    const mock = github({ tagCommit: COMMIT });
    assert.equal((await publish(root, mock)).status, 'published');
    assert.equal(mock.commands.some(args => args.includes('POST')), false);
}));

test('an already published version skips without rewriting its tag and attachment', () => fixture(async root => {
    const mock = github({ published: true, tagCommit: OTHER });
    assert.equal((await publish(root, mock)).status, 'skipped');
    assert.equal(mock.commands.length, 1);
}));

test('authentication, malformed metadata and tag API permission failures stop publication', () => fixture(async root => {
    for (const options of [{ authFails: true }, { tagFails: true }, { malformedRelease: true }]) {
        const mock = github(options);
        await assert.rejects(publish(root, mock));
        assert.equal(mock.commands.some(args => args.includes('POST') || args[1] === 'create'), false);
    }
}));

test('failed tag creation cannot create or publish a release', () => fixture(async root => {
    const mock = github({ createTagFails: true });
    await assert.rejects(publish(root, mock), /Tag creation failed/);
    assert.equal(mock.commands.some(args => args[1] === 'create' || args[1] === 'upload' || args[1] === 'edit'), false);
}));

test('mismatched tags and drafts missing their tag never get retagged or overwritten', () => fixture(async root => {
    for (const options of [{ tagCommit: OTHER }, { draft: true }, { draft: true, tagCommit: OTHER, annotated: true }]) {
        const mock = github(options);
        await assert.rejects(publish(root, mock), /another commit|no tag/);
        assert.equal(mock.commands.some(args => args.includes('POST') || args[1] === 'upload'), false);
    }
}));

test('failed uploads and incomplete attachments leave the release unpublished', () => fixture(async root => {
    for (const options of [{ uploadFails: true }, { size: 0 }, { size: Buffer.byteLength(built.html) - 1 }, { missingAttachment: true }, { moveDuringUpload: true }]) {
        const mock = github(options);
        await assert.rejects(publish(root, mock));
        assert.equal(mock.commands.some(args => args[1] === 'edit'), false);
        await assert.rejects(fs.access(path.join(root, 'test-results/release-notes.md')));
    }
}));

test('invalid tag, missing changelog and invalid artifact fail before creating a tag', () => fixture(async root => {
    const wrongTag = github();
    await assert.rejects(publish(root, wrongTag, 'v999.0.0'));
    assert.equal(wrongTag.commands.length, 0);
    await fs.writeFile(path.join(root, 'changelog.md'), '# Empty');
    const missingNotes = github();
    await assert.rejects(publish(root, missingNotes), /Missing changelog/);
    assert.equal(missingNotes.commands.some(args => args[0] === 'api'), false);
    await fs.writeFile(path.join(root, 'changelog.md'), `## ${tag} - 2026-10-18\n\n- restored`);
    await fs.writeFile(path.join(root, 'dist/index.html'), '<html>broken</html>');
    const invalidArtifact = github();
    await assert.rejects(publish(root, invalidArtifact));
    assert.equal(invalidArtifact.commands.some(args => args[0] === 'api'), false);
}));
