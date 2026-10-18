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

export async function publishRelease(tag, { root = ROOT, runGh } = {}) {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    validateReleaseTag(tag, pkg.version);
    const notes = releaseNotes(await fs.readFile(path.join(root, 'changelog.md'), 'utf8'), pkg.version);
    const artifact = path.join(root, 'dist/index.html');
    checkHtml(await fs.readFile(artifact, 'utf8'), pkg.version);
    // Only "not found" is treated as absence; authentication/network errors must stop publication.
    const gh = runGh || (args => execFileSync('gh', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    let exists = false;
    try {
        const release = JSON.parse(gh(['release', 'view', tag, '--json', 'isDraft']));
        if (!release.isDraft) throw new Error('This version is already published; do not overwrite a released artifact');
        exists = true;
    } catch (error) {
        if (!/release not found/i.test(String(error.stderr || ''))) throw error;
    }
    const notesFile = path.join(root, 'test-results/release-notes.md');
    await fs.mkdir(path.dirname(notesFile), { recursive: true });
    await fs.writeFile(notesFile, notes);
    try {
        if (!exists) gh(['release', 'create', tag, '--verify-tag', '--draft', '--title', tag, '--notes-file', notesFile]);
        gh(['release', 'upload', tag, artifact, '--clobber']);
        gh(['release', 'edit', tag, '--notes-file', notesFile, '--draft=false', '--latest']);
        if (!runGh) console.log(`Published ${tag} with index.html`);
    } finally {
        await fs.rm(notesFile, { force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await publishRelease(process.argv[2]);
