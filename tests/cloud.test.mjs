import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloud, musicCloudSong, canImportCloudAudio, cloudSongId, validateCloudUploadUrl, fetchCloudBlob } from '../src/netease/cloud.js';

const md5 = '1234567890abcdef1234567890abcdef';
const song = { id: 11, name: 'Example', ar: [{ name: 'Artist' }], al: { name: 'Album' } };
const audio = { url: 'https://cdn.test/song.mp3', type: 'mp3', md5, size: 8, br: 320000 };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
    for (let index = 0; index < 100; index++) { if (predicate()) return; await tick(); }
    assert.fail('task did not reach expected state');
}
function fixture(t, { handle, prepare, fetcher, upload, playback, loggedIn = true } = {}) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    let cloud;
    globalThis.document = { getElementById: () => null };
    t.after(() => {
        cloud?.reset();
        if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else delete globalThis.document;
    });
    const calls = [], counts = { files: 0, prepare: 0, upload: 0, login: 0 };
    const auth = { neteaseUser: loggedIn ? { userId: 4 } : null, neteaseCookie: loggedIn ? 'fake-cookie' : '', authGeneration: 0,
        captureAuthSnapshot() { return { generation: this.authGeneration }; },
        isAuthSnapshotCurrent(snapshot) { return snapshot.generation === this.authGeneration; }, showLogin() { counts.login++; } };
    const request = async (path, data, options) => {
        calls.push({ path, data });
        if (handle) { const value = await handle(path, data, options); if (value !== undefined) return value; }
        if (path === '/cloud/import') return { code: 200, data: [{ songId: 700 }] };
        if (path === '/cloud/upload/token') return { code: 200, data: { needUpload: true, songId: 0, resourceId: 'resource',
            uploadToken: 'fake-upload-token', uploadUrl: 'https://nos.test.127.net/bucket/object' } };
        if (path === '/cloud/upload/complete') return { code: 200, data: { code: 200, songId: 700 } };
        if (path === '/user/cloud/detail') return { code: 200, data: [{ songId: 700, fileSize: 8 }] };
        if (path === '/user/cloud') return { code: 200, data: [{ songId: 700, fileSize: 8, simpleSong: { id: 11 } }] };
        throw new Error('unexpected endpoint ' + path);
    };
    cloud = createCloud({ api: {}, auth, debug: { log() {} }, download: {}, resolver: {}, playback, accountRequest: request,
        fetcher: async (...args) => { counts.files++; return fetcher ? fetcher(...args) : new Response(new Uint8Array(8)); },
        prepare: async (...args) => { counts.prepare++; return prepare ? prepare(...args) :
            { blob: new Blob([new Uint8Array(8)], { type: 'audio/mpeg' }), type: 'mp3', md5, bitrate: 192000,
                metadata: { song: 'Example', artist: 'Artist', album: 'Album' }, conflicts: [] }; },
        upload: async (...args) => { counts.upload++; if (upload) return upload(...args); }
    });
    return { cloud, auth, calls, counts, start: (extra = {}) => cloud.start({ songData: song, audioInfo: audio, level: 'exhigh', ...extra }),
        state: () => cloud.getSnapshot()[0] };
}

test('cloud metadata uses structured song fields, not display-name splitting', () => {
    assert.deepEqual(musicCloudSong({ songData: { ...song, name: 'A - B' } }), { id: 11, song: 'A - B', artist: 'Artist', album: 'Album', cover: '' });
    assert.throws(() => musicCloudSong({ id: -1 }), /ID/);
});
test('fast import requires actual official hash, size, bitrate and supported format', () => {
    assert.equal(canImportCloudAudio(audio, ''), true);
    for (const value of [{ ...audio, md5: '' }, { ...audio, size: 0 }, { ...audio, br: 0 }, { ...audio, type: 'm4a' }]) {
        assert.equal(canImportCloudAudio(value, ''), false);
    }
    assert.equal(canImportCloudAudio(audio, 'match'), false);
});
test('cloud IDs come from cloud songId rather than catalog id', () => {
    assert.equal(cloudSongId({ code: 200, data: { code: 200, songId: '700' } }), 700);
    assert.equal(cloudSongId({ data: [{ songId: 8, simpleSong: { id: 11 } }] }), 8);
    assert.equal(cloudSongId({ data: { id: 11 } }), 0);
});
test('upload URLs are limited to HTTPS NetEase storage and reject credentials', () => {
    assert.match(validateCloudUploadUrl('http://nos.example.127.net/bucket/object'), /^https:/);
    for (const url of ['https://evil.test/object', 'https://127.net.evil.test', 'https://user:pass@nos.127.net/x', 'file:///tmp/a']) {
        assert.throws(() => validateCloudUploadUrl(url));
    }
});
test('official fast import avoids fetching, tagging and uploading audio', async t => {
    const f = fixture(t); await f.start(); await until(() => f.state().status === 'done');
    assert.deepEqual(f.calls.map(call => call.path), ['/cloud/import', '/user/cloud/detail']);
    assert.equal(f.calls[0].data.bitrate, 320);
    assert.deepEqual(f.counts, { files: 0, prepare: 0, upload: 0, login: 0 });
    assert.equal(f.state().hasFile, false);
});
test('match upload uses final file hash, size, metadata and real bitrate', async t => {
    const f = fixture(t); await f.start({ source: 'match' }); await until(() => f.state().status === 'done');
    assert.deepEqual(f.calls.map(call => call.path), ['/cloud/upload/token', '/cloud/upload/complete', '/user/cloud/detail']);
    assert.equal(f.calls[0].data.fileSize, 8); assert.equal(f.calls[0].data.md5, md5);
    assert.equal(f.calls[1].data.bitrate, 192000);
    assert.equal(f.calls[1].data.songId, '0', 'upstream complete requires a truthy string even for songId zero');
    assert.deepEqual(f.counts, { files: 1, prepare: 1, upload: 1, login: 0 });
    assert.equal(f.state().hasFile, false);
});
test('known unsupported import falls back once to file upload', async t => {
    const f = fixture(t, { handle: path => { if (path === '/cloud/import') throw Object.assign(new Error('not supported'), { status: 404 }); } });
    await f.start(); await until(() => f.state().status === 'done');
    assert.equal(f.calls.filter(call => call.path === '/cloud/import').length, 1);
    assert.equal(f.counts.upload, 1);
});
test('fallback upload reuses an already owned matching encoded Blob without a second GET', async t => {
    let identity;
    const f = fixture(t, { handle: path => { if (path === '/cloud/import') throw Object.assign(new Error('unsupported'), { status: 404 }); },
        playback: { getEncodedAudioForCloud(value) { identity = value; return new Blob([new Uint8Array(8)]); } } });
    await f.start(); await until(() => f.state().status === 'done');
    assert.deepEqual(identity, { songId: 11, md5, size: 8 });
    assert.equal(f.counts.files, 0); assert.equal(f.counts.upload, 1);
});
for (const code of [301, 403, 429]) {
    test(`import failure ${code} does not trigger file download or repeated writes`, async t => {
        const f = fixture(t, { handle: path => { if (path === '/cloud/import') throw Object.assign(new Error('操作失败'), { apiCode: code }); } });
        await f.start(); await until(() => f.state().status === 'error');
        assert.equal(f.counts.files, 0); assert.equal(f.calls.length, 1);
    });
}
test('quota failure does not attempt a more expensive upload', async t => {
    const f = fixture(t, { handle: () => { throw Object.assign(new Error('云盘空间不足'), { apiCode: 400 }); } });
    await f.start(); await until(() => f.state().status === 'error'); assert.equal(f.counts.files, 0);
});
test('uncertain import retry checks results without repeating the write', async t => {
    const f = fixture(t, { handle: path => {
        if (path === '/cloud/import') throw Object.assign(new Error('请求超时'), { uncertain: true });
    } });
    await f.start(); await until(() => f.state().status === 'error');
    f.cloud.retry(f.state().id); await until(() => f.state().status === 'done');
    assert.deepEqual(f.calls.map(call => call.path), ['/cloud/import', '/user/cloud']);
});
test('unconfirmed result only restarts the write after explicit restart selection', async t => {
    let imports = 0;
    const f = fixture(t, { handle: path => {
        if (path === '/cloud/import' && ++imports === 1) throw Object.assign(new Error('timeout'), { uncertain: true });
        if (path === '/user/cloud') return { code: 200, data: [] };
    } });
    await f.start(); await until(() => f.state().status === 'error');
    f.cloud.retry(f.state().id); await tick(); await until(() => f.state().status === 'error');
    assert.equal(imports, 1);
    f.cloud.retry(f.state().id, { restart: true }); await until(() => f.state().status === 'done');
    assert.equal(imports, 2);
});
test('server says no upload needed: skip NOS transfer and finish registration', async t => {
    const f = fixture(t, { handle: path => path === '/cloud/upload/token'
        ? { code: 200, data: { songId: 5, resourceId: 'r', needUpload: false } } : undefined });
    await f.start({ source: 'match' }); await until(() => f.state().status === 'done');
    assert.equal(f.counts.upload, 0); assert.equal(f.counts.files, 1);
});
test('registration failure retries only registration and reuses the prepared file', async t => {
    let complete = 0;
    const f = fixture(t, { handle: path => {
        if (path === '/cloud/upload/complete' && complete++ === 0) throw new Error('入库失败');
    } });
    await f.start({ source: 'match' }); await until(() => f.state().status === 'error');
    assert.equal(f.state().hasFile, false, 'uploaded bytes are released before registration retry');
    f.cloud.retry(f.state().id); await until(() => f.state().status === 'done');
    assert.equal(f.counts.files, 1); assert.equal(f.counts.prepare, 1); assert.equal(f.counts.upload, 1); assert.equal(complete, 2);
});
test('unknown upload completion retry checks matching recent cloud record', async t => {
    const f = fixture(t, { handle: path => {
        if (path === '/cloud/upload/complete') throw Object.assign(new Error('请求超时'), { uncertain: true });
        if (path === '/user/cloud') return { code: 200, data: [{ songId: 710, fileSize: 8,
            fileName: 'Example - Artist.mp3', songName: 'Example', artist: 'Artist' }] };
    } });
    await f.start({ source: 'match' }); await until(() => f.state().status === 'error');
    f.cloud.retry(f.state().id); await until(() => f.state().status === 'done');
    assert.equal(f.counts.upload, 1); assert.equal(f.state().cloudId, 710);
    assert.equal(f.calls.filter(call => call.path === '/cloud/upload/complete').length, 1);
});
test('verification rejects a mismatched cloud file size', async t => {
    const f = fixture(t, { handle: path => path === '/user/cloud/detail' ? { code: 200, data: [{ songId: 700, fileSize: 999 }] } : undefined });
    await f.start(); await until(() => f.state().status === 'error'); assert.match(f.state().message, /大小不匹配/);
});
test('metadata conflicts wait for confirmation and do not redownload on continue', async t => {
    const f = fixture(t, { prepare: async () => ({ blob: new Blob([new Uint8Array(8)]), type: 'mp3', md5,
        metadata: { song: 'Actual', artist: 'Singer', album: 'Album' }, conflicts: ['文件歌名不一致'] }) });
    await f.start({ source: 'match' }); await until(() => f.state().status === 'confirmation');
    assert.equal(f.calls.length, 0);
    f.cloud.retry(f.state().id, { confirmed: true }); await until(() => f.state().status === 'done');
    assert.equal(f.counts.files, 1); assert.equal(f.counts.prepare, 1);
    assert.equal(f.calls.find(call => call.path === '/cloud/upload/complete').data.song, 'Actual');
});
test('failed cover can be skipped without fetching the audio a second time', async t => {
    const f = fixture(t, { fetcher: async url => {
        if (url.includes('cover.test')) throw new Error('cover offline');
        return new Response(new Uint8Array(8));
    } });
    await f.start({ source: 'match', songData: { ...song, al: { name: 'Album', picUrl: 'https://cover.test/a.jpg' } } });
    await until(() => f.state().status === 'error');
    assert.match(f.state().message, /封面/);
    f.cloud.retry(f.state().id, { skipCover: true }); await until(() => f.state().status === 'done');
    assert.equal(f.counts.files, 2, 'one audio GET and one failed cover GET');
    assert.equal(f.counts.upload, 1);
});
test('duplicate start does not allocate another file task', async t => {
    let finish;
    const f = fixture(t, { upload: () => new Promise(resolve => { finish = resolve; }) });
    await f.start({ source: 'match' }); await until(() => f.state().status === 'uploading');
    assert.equal(await f.start({ source: 'match' }), null); assert.equal(f.cloud.getSnapshot().length, 1);
    finish(); await until(() => f.state().status === 'done');
});
test('queued work does not acquire a second audio file while first is uploading', async t => {
    let finish;
    const f = fixture(t, { upload: () => new Promise(resolve => { finish = resolve; }) });
    await f.start({ source: 'match' }); await until(() => f.state().status === 'uploading');
    await f.start({ source: 'match', songData: { ...song, id: 12 } });
    assert.equal(f.counts.files, 1); assert.equal(f.cloud.getSnapshot()[1].status, 'queued');
    f.cloud.cancel(f.cloud.getSnapshot()[1].id); finish(); await until(() => f.state().status === 'done');
});
test('account change invalidates stale work before registration', async t => {
    let finish;
    const f = fixture(t, { upload: () => new Promise(resolve => { finish = resolve; }) });
    await f.start({ source: 'match' }); await until(() => f.state().status === 'uploading');
    f.auth.authGeneration++; finish(); await until(() => f.state().status === 'cancelled');
    assert.equal(f.state().hasFile, false);
    assert.equal(f.calls.some(call => call.path === '/cloud/upload/complete'), false);
});
test('guest start opens login but never queues an account modification', async t => {
    const f = fixture(t, { loggedIn: false }); assert.equal(await f.start(), null);
    assert.equal(f.counts.login, 1); assert.equal(f.calls.length, 0); assert.equal(f.cloud.getSnapshot().length, 0);
});
test('cancel during registration preserves reconciliation and prevents a second write', async t => {
    let rejectComplete;
    const f = fixture(t, { handle: path => {
        if (path === '/cloud/upload/complete') return new Promise((_, reject) => { rejectComplete = reject; });
    } });
    await f.start({ source: 'match' }); await until(() => !!rejectComplete);
    f.cloud.cancel(f.state().id); rejectComplete(new DOMException('cancelled', 'AbortError'));
    await until(() => f.state().status === 'error'); await tick();
    assert.equal(await f.start({ source: 'match' }), null);
    f.cloud.retry(f.state().id); await until(() => f.state().status === 'done');
    assert.equal(f.calls.filter(call => call.path === '/cloud/upload/complete').length, 1);
    assert.equal(f.counts.upload, 1);
});
test('HTTP error body is cancelled and its fetch signal is aborted', async () => {
    let cancelled = false, signal;
    const fetcher = async (_, options) => {
        signal = options.signal;
        return { ok: false, status: 403, body: { cancel() { cancelled = true; } } };
    };
    await assert.rejects(fetchCloudBlob('https://cdn.test', { maxBytes: 10, fetcher }), { status: 403 });
    assert.equal(cancelled, true); assert.equal(signal.aborted, true);
});
test('blob reader cancels oversized response before reading the body', async () => {
    let cancelled = false;
    const fetcher = async () => ({ ok: true, headers: new Headers({ 'content-length': '100' }), body: { cancel() { cancelled = true; } } });
    await assert.rejects(fetchCloudBlob('https://cdn.test', { maxBytes: 10, fetcher }), /上限/); assert.equal(cancelled, true);
});
test('blob reader enforces size limit with unknown content length', async () => {
    const fetcher = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(11)); controller.close(); } }));
    await assert.rejects(fetchCloudBlob('https://cdn.test', { maxBytes: 10, fetcher }), /上限/);
});
test('blob reader returns encoded bytes unchanged', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const blob = await fetchCloudBlob('https://cdn.test', { maxBytes: 10, fetcher: async () => new Response(bytes) });
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
});
