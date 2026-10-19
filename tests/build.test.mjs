import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildHtml } from '../scripts/build.mjs';
import { checkHtml, checkSource } from '../scripts/check.mjs';
import { readPublicConfig } from '../scripts/config.mjs';
import { releaseNotes, validateReleaseTag } from '../scripts/release.mjs';
import { startDevServer } from '../scripts/dev.mjs';
import { createHost, FakeAudioContext } from './helpers/host.mjs';
import { periodicSignal } from './helpers/signal.mjs';
import { findBestMatchByMode, releaseAnalysisBuffer } from '../src/analysis/algorithms.js';

const built = await buildHtml({ env: {} });
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
function boot() {
    const fixture = createHost(built.html);
    const context = vm.createContext(fixture.host);
    for (const script of built.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]).runInContext(context, { timeout: 5000 });
    return { ...fixture, audio: FakeAudioContext.instances.at(-1) };
}
function importFiles(fixture, files) {
    const input = fixture.elements.get('file-input');
    input.files = files;
    input.dispatchEvent({ type: 'change', target: input });
}
const localFile = (name, arrayBuffer = async () => new Uint8Array([102, 76, 97, 67]).buffer) => ({ name, size: 4, lastModified: 1, arrayBuffer });

test('source dependencies are explicit and acyclic; output is one standalone HTML', async () => {
    assert.ok((await checkSource()) >= 40);
    assert.equal(checkHtml(built.html, built.version), 5);
    assert.equal(/new Worker\(["'][^"']+\.js/.test(built.appSource), false);
    assert.equal(built.html.includes('node_modules/'), false);
    assert.equal(built.html.includes('Function.prototype.toString'), false);
    assert.ok(built.html.includes('jsmediatags'));
    assert.ok(built.html.includes('MIT'));
});

test('production build is deterministic and environment injection is public/allowlisted', async () => {
    const again = await buildHtml({ env: {} });
    assert.equal(again.html, built.html);
    const configured = await buildHtml({ env: { API_BASE_URL: 'https://api.example.com/v1/', DOWNLOAD_PROXY_URL: 'https://proxy.example.com', GH_TOKEN: 'must-never-enter-html' } });
    assert.equal(configured.config.API_BASE_URL, 'https://api.example.com/v1');
    assert.equal(configured.html.includes('must-never-enter-html'), false);
    assert.equal(configured.html.includes('https://api.example.com/v1'), true);
    assert.throws(() => readPublicConfig({ API_BASE_URL: 'javascript:alert(1)' }));
    assert.throws(() => readPublicConfig({ API_BASE_URL: 'https://user:secret@example.com' }));
    const tricky = await buildHtml({ env: { API_BASE_URL: 'https://example.com/</script><script>' } });
    assert.equal(checkHtml(tricky.html, tricky.version), 5);
});

test('full compiled application boots in a mock host without runtime globals or network', async () => {
    const { host, elements, requests, frames } = createHost(built.html);
    const context = vm.createContext(host);
    for (const script of built.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]).runInContext(context, { timeout: 5000 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof elements.get('play-btn').onclick, 'function');
    assert.equal(typeof elements.get('next-btn').onclick, 'function');
    assert.equal(typeof elements.get('netease-search-btn').onclick, 'function');
    assert.equal(requests.length, 0);
    assert.equal(host._currentPlayActionToken, undefined);
    assert.equal(host.setLoopPoint, undefined);
    assert.ok(frames.size <= 1);
    for (const [id, callback] of [...frames]) { frames.delete(id); callback(1); }
    assert.equal(frames.size, 0, 'paused with effects disabled must not keep RAF alive');
});

test('compiled Worker matches main-thread algorithms in all three modes and releases its cache', () => {
    const posts = [];
    const self = { postMessage: message => posts.push(message) };
    const context = vm.createContext({ self, Float32Array, ArrayBuffer, performance });
    new vm.Script(built.workerSource).runInContext(context);
    const buffer = periodicSignal();
    for (const [jobId, mode] of ['fast', 'balanced', 'full'].entries()) {
        const message = { type: 'analyze', jobId, audioId: 1, sampleRate: buffer.sampleRate, timeA: 4.2, timeB: 12.2, mode };
        if (jobId === 0) message.dataBuffer = buffer.getChannelData(0).buffer;
        self.onmessage({ data: message });
        const result = posts.at(-1);
        assert.equal(result.ok, true, result.error);
        const expected = findBestMatchByMode(buffer, message.timeA, message.timeB, mode);
        for (const field of ['start', 'end', 'confidence', 'diff']) assert.equal(result.result[field], expected[field]);
    }
    self.onmessage({ data: { type: 'release' } });
    self.onmessage({ data: { type: 'analyze', jobId: 4, audioId: 1, mode: 'balanced' } });
    assert.equal(posts.at(-1).ok, false);
    assert.match(posts.at(-1).error, /missing/);
    releaseAnalysisBuffer(buffer);
});

test('compiled background worker falls back without WebGL and needs no document or external imports', () => {
    const posts = [], self = { postMessage: message => posts.push(message), close() {} };
    const context = vm.createContext({ self, performance, setTimeout, clearTimeout });
    new vm.Script(built.backgroundWorkerSource).runInContext(context);
    self.onmessage({ data: { type: 'init', revision: 3,
        canvas: { width: 1, height: 1, addEventListener() {}, getContext: () => null }, theme: {},
        state: { playing: true, hidden: false, reduced: false, width: 1440, height: 900 } } });
    assert.equal(posts.at(-1).revision, 3);
    assert.equal(posts.at(-1).stats.failed, true);
    self.onmessage({ data: { type: 'dispose' } });
    assert.equal(posts.at(-1).type, 'disposed');
});

test('compiled import applies only the matching SLI and clears it on the next local track', async () => {
    const fixture = boot();
    const sli = { name: 'first.flac.sli', size: 30, lastModified: 1, text: async () => 'From=441000; To=44100;' };
    importFiles(fixture, [localFile('first.flac'), localFile('second.flac'), sli]);
    await settle();
    assert.equal(fixture.elements.get('track-title').textContent, 'first');
    assert.equal(fixture.audio.decodeCalls.length, 1);
    assert.equal(fixture.audio.sources.at(-1).loop, true);
    assert.equal(fixture.audio.sources.at(-1).loopStart, 1);
    assert.equal(fixture.audio.sources.at(-1).loopEnd, 10);
    fixture.elements.get('next-btn').click();
    await settle();
    assert.equal(fixture.elements.get('track-title').textContent, 'second');
    assert.equal(fixture.audio.decodeCalls.length, 2);
    assert.equal(fixture.audio.sources.at(-1).loop, false);
    assert.equal(fixture.requests.length, 0);
});

test('compiled import replacement discards an earlier pending local read', async () => {
    const fixture = boot();
    let finish;
    importFiles(fixture, [localFile('old.flac', () => new Promise(resolve => { finish = resolve; }))]);
    await settle();
    assert.equal(typeof finish, 'function');
    importFiles(fixture, [localFile('new.flac')]);
    await settle();
    finish(new Uint8Array([102, 76, 97, 67]).buffer);
    await settle();
    assert.equal(fixture.elements.get('track-title').textContent, 'new');
    assert.equal(fixture.audio.decodeCalls.length, 1);
    assert.equal(fixture.elements.get('pl-container').children.length, 1);
});

test('compiled single-song random replay reuses decoded audio without reading again', async () => {
    const fixture = boot();
    let reads = 0;
    importFiles(fixture, [localFile('only.flac', async () => { reads++; return new ArrayBuffer(4); })]);
    await settle();
    fixture.elements.get('mode-btn').click();
    const source = fixture.audio.sources.at(-1);
    fixture.audio.currentTime += 120;
    source.onended();
    await settle();
    assert.equal(reads, 1);
    assert.equal(fixture.audio.decodeCalls.length, 1);
    assert.equal(fixture.audio.sources.at(-1).started[1], 0);
    assert.notEqual(fixture.audio.sources.at(-1), source);
});

function analyze(fixture) {
    const button = fixture.elements.get('ana-run');
    button.dataset.action = 'analyze';
    fixture.elements.get('ana-start').value = '4.2';
    fixture.elements.get('ana-end').value = '12.2';
    fixture.elements.get('ana-mode').value = 'balanced';
    fixture.host.document.dispatchEvent({ type: 'click', target: button, preventDefault() {} });
}

test('compiled analysis falls back without Worker and restores the action button', async () => {
    const fixture = boot();
    fixture.audio.decoded = periodicSignal();
    importFiles(fixture, [localFile('analysis.flac')]);
    await settle();
    analyze(fixture);
    assert.equal(fixture.elements.get('ana-run').disabled, true);
    for (const [id, callback] of [...fixture.frames]) { fixture.frames.delete(id); callback(performance.now()); }
    await settle();
    assert.equal(fixture.elements.get('ana-run').disabled, false);
    assert.equal(fixture.logs.some(parts => String(parts[0]).includes('using main thread fallback')), true);
    assert.equal(fixture.elements.get('ana-msg').textContent.startsWith('Error:'), false);
    assert.match(fixture.elements.get('ana-msg').textContent, /置信度/);
});

test('compiled analysis cancelled by switching songs cannot apply the old loop', async () => {
    const fixture = boot();
    fixture.audio.decoded = periodicSignal();
    importFiles(fixture, [localFile('a-old.flac'), localFile('b-next.flac')]);
    await settle();
    analyze(fixture);
    fixture.elements.get('next-btn').click();
    await settle();
    for (const [id, callback] of [...fixture.frames]) { fixture.frames.delete(id); callback(performance.now()); }
    await settle();
    assert.equal(fixture.elements.get('track-title').textContent, 'b-next');
    assert.equal(fixture.elements.get('ana-run').disabled, false);
    assert.equal(fixture.audio.sources.at(-1).loop, false);
    assert.equal(fixture.elements.get('loop-enable').checked, false);
});

test('release tag must match the version and notes contain only that version', () => {
    const text = '# Changelog\n\n## v0.0.6 - 2026-10-18\n\n### Changed\n\n- current\n\n## v0.0.5 - 2026-10-01\n\n- older';
    assert.equal(releaseNotes(text, '0.0.6'), '### Changed\n\n- current');
    assert.doesNotThrow(() => validateReleaseTag('v0.0.6', '0.0.6'));
    for (const tag of ['v0.0.5', 'v0.0.6;echo', '0.0.6', 'v0.0.6-rc.1']) assert.throws(() => validateReleaseTag(tag, '0.0.6'));
    assert.throws(() => releaseNotes(text, '9.9.9'));
});

test('development server serves only the generated page and closes cleanly', async () => {
    const server = await startDevServer({ port: 0, watch: false });
    try {
        const page = await fetch(server.url);
        assert.equal(page.status, 200);
        checkHtml(await page.text(), built.version);
        assert.equal((await fetch(`${server.url}/src/app.js`)).status, 404);
        assert.equal((await fetch(server.url, { method: 'POST' })).status, 405);
    } finally {
        await server.close();
    }
});
