import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ROOT } from './build.mjs';
import { checkHtml } from './check.mjs';

export function releaseNotes(changelog, version) {
    const heading = `## v${version} - `;
    const lines = changelog.replace(/\r\n/g, '\n').split('\n');
    const start = lines.findIndex(line => line.startsWith(heading));
    if (start < 0) throw new Error(`Missing changelog entry for v${version}`);
    const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
    const notes = lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
    if (!notes) throw new Error('Release notes are empty');
    return notes;
}

export function validateReleaseTag(tag, version) {
    if (!/^v\d+\.\d+\.\d+$/.test(tag) || tag !== `v${version}`) throw new Error('Release tag must match package.json version exactly');
}

function readTagCommit(gh, tag) {
    let object;
    try {
        object = JSON.parse(gh(['api', `repos/{owner}/{repo}/git/ref/tags/${tag}`])).object;
    } catch (error) {
        if (/HTTP 404/.test(String(error.stderr || ''))) return null;
        throw error;
    }
    const seen = new Set();
    while (object && /^[0-9a-f]{40}$/i.test(object.sha)) {
        if (object.type === 'commit') return object.sha;
        if (object.type !== 'tag' || seen.has(object.sha) || seen.size >= 10) break;
        seen.add(object.sha);
        object = JSON.parse(gh(['api', `repos/{owner}/{repo}/git/tags/${object.sha}`])).object;
    }
    throw new Error('Release tag does not resolve to a commit');
}

export async function publishRelease(tag, { root = ROOT, runGh, commit } = {}) {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    tag ||= `v${pkg.version}`;
    validateReleaseTag(tag, pkg.version);
    // Only "not found" is treated as absence; authentication/network errors must stop publication.
    const gh = runGh || (args => execFileSync('gh', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    let exists = false;
    try {
        const release = JSON.parse(gh(['release', 'view', tag, '--json', 'isDraft,url']));
        if (typeof release.isDraft !== 'boolean') throw new Error('Invalid release metadata');
        if (!release.isDraft) {
            if (!runGh) console.log(`Skipped ${tag}: already published`);
            return { status: 'skipped', tag, url: release.url };
        }
        exists = true;
    } catch (error) {
        if (!/release not found/i.test(String(error.stderr || ''))) throw error;
    }
    const notes = releaseNotes(await fs.readFile(path.join(root, 'changelog.md'), 'utf8'), pkg.version);
    const artifact = path.join(root, 'dist/index.html');
    const html = await fs.readFile(artifact, 'utf8');
    checkHtml(html, pkg.version);
    const target = commit || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    if (!/^[0-9a-f]{40}$/i.test(target)) throw new Error('Release target must be an exact commit SHA');
    const tagged = readTagCommit(gh, tag);
    if (tagged && tagged !== target) throw new Error(`${tag} points to another commit; do not move an existing release tag`);
    if (!tagged) {
        if (exists) throw new Error('Existing release draft has no tag; refusing to change its source');
        gh(['api', '--method', 'POST', 'repos/{owner}/{repo}/git/refs', '-f', `ref=refs/tags/${tag}`, '-f', `sha=${target}`]);
        if (readTagCommit(gh, tag) !== target) throw new Error('Created release tag does not match the checked commit');
    }
    const notesFile = path.join(root, 'test-results/release-notes.md');
    await fs.mkdir(path.dirname(notesFile), { recursive: true });
    await fs.writeFile(notesFile, notes);
    try {
        if (!exists) gh(['release', 'create', tag, '--verify-tag', '--draft', '--title', tag, '--notes-file', notesFile]);
        gh(['release', 'upload', tag, artifact, '--clobber']);
        const uploaded = JSON.parse(gh(['release', 'view', tag, '--json', 'assets'])).assets;
        const assets = uploaded?.filter(asset => asset.name === 'index.html') || [];
        if (assets.length !== 1 || assets[0].size !== Buffer.byteLength(html)) throw new Error('Release attachment is missing or incomplete');
        if (readTagCommit(gh, tag) !== target) throw new Error('Release tag changed during upload; leaving the draft unpublished');
        gh(['release', 'edit', tag, '--notes-file', notesFile, '--draft=false', '--latest']);
        if (!runGh) console.log(`Published ${tag} with index.html`);
        return { status: 'published', tag, commit: target };
    } finally {
        await fs.rm(notesFile, { force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await publishRelease(process.argv[2]);
