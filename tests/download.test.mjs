import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownload } from '../src/netease/download.js';
import { FakeElement } from './helpers/host.mjs';
import { mp3Fixture } from './helpers/mp3.mjs';

function fixture(t, matched, audioInfo = null) {
    const dom = Object.fromEntries(['downloadClose', 'downloadCancel', 'downloadModal', 'downloadBtnMobile',
        'downloadBtn', 'downloadTitle', 'downloadTrackInfo', 'downloadListEl', 'downloadDestination'].map(key => [key, new FakeElement()]));
    const anchors = [], tasks = [], modalOpens = [], requests = [], headerCalls = [], matchCalls = [];
    const state = { header: async () => null };
    const document = { body: new FakeElement(), createElement(tag) {
        const element = new FakeElement();
        let text = '';
        Object.defineProperty(element, 'textContent', { get() { return text + this.children.map(child => child.textContent).join(''); },
            set(value) { text = String(value); this.children = []; } });
        element.replaceChildren = (...children) => { element.textContent = ''; element.append(...children); };
        if (tag === 'a') anchors.push(element);
        Object.defineProperty(element, 'innerHTML', { get() { return this._html || ''; }, set(value) {
            this._html = value; this.textContent = '';
            if (value.includes('quality-meta')) this.children.push(Object.assign(document.createElement('div'), { className: 'quality-meta' }));
        } });
        return element;
    }, createTextNode(value) { const node = this.createElement('#text'); node.textContent = value; return node; } };
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document });
    t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
    const download = createDownload({ dom, playback: { _currentPlayActionToken: 7 }, debug: { log() {} },
        panels: { modalController: { open(modal) { modalOpens.push(modal); }, close() {} } }, api: { buildApiUrl: path => `https://api.test${path}` },
        transfer: { fetchAudioHeader: async (url, options) => { headerCalls.push({ url, options }); return state.header(url, options); } },
        cloud: { getSnapshot: () => tasks },
        auth: { neteaseCookie: '', captureAuthSnapshot: () => ({}), isAuthSnapshotCurrent: () => true },
        cache: { cachedFetchJson: async raw => { requests.push(raw); return new URL(raw).pathname === '/song/music/detail'
            ? { data: Object.fromEntries(['standard', 'higher', 'exhigh', 'lossless', 'hires'].map(level => [level,
                { br: 952000, sr: 48000, size: 36 * 1024 * 1024 }])) }
            : { data: matched ? { url: null } : audioInfo || { url: 'https://cdn.test/music.mp3', type: 'mp3', br: 192000, sr: 44100, size: 5 * 1024 * 1024 } }; } },
        resolver: { isNeteaseTrialOnly: () => false, getNeteaseMatchStrategy: () => ['test'],
            fetchNeteaseMatchAudio: async (...args) => { matchCalls.push(args); return { audioUrl: 'https://cdn.test/matched.mp3', source: 'test' }; } }
    });
    download._currentPlaying = { playToken: 7, netease: true, songId: 1, songData: { name: 'Example', ar: [] } };
    download.initialize();
    return { download, dom, anchors, tasks, modalOpens, requests, state, headerCalls, matchCalls };
}

for (const current of [null, { playToken: 7, netease: false }, { playToken: 6, netease: true }]) {
    test(`download button keeps existing cloud tasks reachable without a current online track (${JSON.stringify(current)})`, async t => {
        const f = fixture(t, false); f.tasks.push({ id: 1, status: 'uploading' });
        f.download._currentPlaying = current;
        await f.dom.downloadBtn.onclick();
        assert.equal(f.dom.downloadTitle.textContent, '云盘任务');
        assert.equal(f.dom.downloadListEl.hidden, true); assert.equal(f.dom.downloadDestination.hidden, true);
        assert.deepEqual(f.modalOpens, [f.dom.downloadModal]); assert.equal(f.requests.length, 0);
        f.download._currentPlaying = { playToken: 7, netease: true, songId: 1, songData: { name: 'Example', ar: [] } };
        await f.dom.downloadBtn.onclick();
        assert.equal(f.dom.downloadListEl.hidden, false); assert.equal(f.dom.downloadDestination.hidden, false);
        assert.equal(f.dom.downloadTitle.textContent, '下载音质'); assert.ok(f.requests.length > 0);
    });
}

test('match download never borrows official bitrate, sample rate, size or lossless inference', async t => {
    const f = fixture(t, true); await f.dom.downloadBtn.onclick();
    for (const row of f.dom.downloadListEl.children) {
        assert.equal(row.querySelector('.quality-meta').textContent, 'MP3 (match兜底/test)'
            + (['lossless', 'hires'].includes(row.dataset.level) ? ' · 未取得无损' : ''));
        assert.equal(row.querySelector('.quality-action').children[0].textContent, '下载');
    }
});

test('five matched download rows share source resolution and a single actual MP3 header probe', async t => {
    const f = fixture(t, true);
    f.state.header = async (url, options) => {
        options.onMetadata({ size: 10 * 1024 * 1024 });
        return mp3Fixture({ bitrate: 320, sampleRate: 44100, tag: 'Info' });
    };
    await f.dom.downloadBtn.onclick();
    assert.equal(f.matchCalls.length, 1); assert.equal(f.headerCalls.length, 1);
    assert.equal(f.requests.filter(raw => new URL(raw).pathname === '/song/music/detail').length, 0);
    for (const row of f.dom.downloadListEl.children) {
        const meta = row.querySelector('.quality-meta'), text = meta.textContent;
        assert.match(text, /MP3 320kbps 44\.1kHz 10\.0MB/);
        assert.doesNotMatch(text, /952kbps|48kHz|36\.0MB/);
        assert.equal(meta.querySelector('.quality-meta-details').textContent, 'MP3 320kbps 44.1kHz 10.0MB');
        assert.equal(meta.querySelectorAll('.quality-meta-note').filter(part => part.textContent.startsWith('(match')).length, 1);
        assert.equal(meta.querySelector('.quality-meta-note').textContent, '(match兜底/test)');
    }
});

test('automatic upgrades stay in an independent parenthesized metadata group', async t => {
    const f = fixture(t, false, { url: 'https://cdn.test/actual.flac', type: 'flac', sr: 48000, size: 25 * 1024 * 1024 });
    await f.dom.downloadBtn.onclick();
    const meta = f.dom.downloadListEl.children[0].querySelector('.quality-meta');
    assert.equal(meta.querySelector('.quality-meta-details').textContent, 'FLAC 48kHz 25.0MB');
    assert.equal(meta.querySelector('.quality-meta-note').textContent, '(自动升级)');
    assert.equal(meta.textContent, 'FLAC 48kHz 25.0MB (自动升级)');
});

test('a valid FLAC header overrides a misleading suffix and updates the actual download extension', async t => {
    const f = fixture(t, true);
    const bytes = new Uint8Array(42); bytes.set([102, 76, 97, 67, 128, 0, 0, 34]);
    const sr = 48000, bits = 24;
    bytes[18] = sr >> 12; bytes[19] = sr >> 4;
    bytes[20] = (sr & 15) << 4 | 2 | (bits - 1) >> 4; bytes[21] = (bits - 1 & 15) << 4;
    f.state.header = async (url, options) => { options.onMetadata({ size: 25 * 1024 * 1024 }); return bytes.buffer; };
    await f.dom.downloadBtn.onclick();
    const row = f.dom.downloadListEl.children[0];
    assert.match(row.querySelector('.quality-meta').textContent, /FLAC 48kHz\/24bit 25\.0MB/);
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { DOWNLOAD_PROXY_URL: '/proxy-download' } });
    t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : delete globalThis.window);
    await row.querySelector('.quality-action').children[0].onclick();
    assert.match(f.anchors[0].download, /\.flac$/);
});

test('header supplementation never blocks the download button and closing prevents stale metadata writes', async t => {
    const f = fixture(t, true); let finish;
    f.state.header = () => new Promise(resolve => { finish = resolve; });
    const pending = f.dom.downloadBtn.onclick();
    await new Promise(resolve => setImmediate(resolve));
    const row = f.dom.downloadListEl.children[0], meta = row.querySelector('.quality-meta');
    assert.equal(row.querySelector('.quality-action').children[0].textContent, '下载');
    const text = meta.textContent;
    f.dom.downloadClose.onclick();
    finish(mp3Fixture({ tag: 'Info' })); await pending;
    assert.equal(meta.textContent, text);
    assert.equal(f.headerCalls[0].options.signal.aborted, true);
});

test('official MP3 download keeps actual bitrate, sample rate and size visible', async t => {
    const f = fixture(t, false); await f.dom.downloadBtn.onclick();
    for (const row of f.dom.downloadListEl.children) {
        assert.equal(row.querySelector('.quality-meta').textContent, 'MP3 192kbps 44.1kHz 5.0MB'
            + (['lossless', 'hires'].includes(row.dataset.level) ? ' · 未取得无损' : ''));
    }
    assert.equal(f.requests.filter(raw => new URL(raw).pathname === '/song/music/detail').length, 0);
});

test('official quality details supplement only a matching tier that is missing actual fields', async t => {
    const f = fixture(t, false, { url: 'https://cdn.test/music.mp3', type: 'mp3', level: 'standard', br: 128000 });
    await f.dom.downloadBtn.onclick();
    assert.equal(f.requests.filter(raw => new URL(raw).pathname === '/song/music/detail').length, 1);
    assert.match(f.dom.downloadListEl.children[0].querySelector('.quality-meta').textContent, /128kbps 48kHz 36\.0MB/);
    assert.doesNotMatch(f.dom.downloadListEl.children[1].querySelector('.quality-meta').textContent, /48kHz|36\.0MB/);
});

for (const type of ['mp3', 'm4a', 'wav', 'ogg']) {
    test(`large ${type} downloads keep their real format without a lossless upgrade`, async t => {
        const f = fixture(t, false, { url: `https://cdn.test/music.${type}`, type, size: 25 * 1024 * 1024 });
        await f.dom.downloadBtn.onclick();
        for (const row of f.dom.downloadListEl.children) assert.equal(row.querySelector('.quality-meta').textContent, `${type.toUpperCase()} 25.0MB`
            + (type === 'mp3' && ['lossless', 'hires'].includes(row.dataset.level) ? ' · 未取得无损' : ''));
    });
}

test('unknown download format and mismatched tiers never borrow the official FLAC description', async t => {
    const f = fixture(t, false, { url: 'https://cdn.test/opaque?file=.flac' });
    await f.dom.downloadBtn.onclick();
    for (const row of f.dom.downloadListEl.children) {
        const text = row.querySelector('.quality-meta').textContent;
        assert.doesNotMatch(text, /FLAC|MP3|kbps|kHz|MB/);
    }
});

for (const proxy of ['/proxy-download', 'https://proxy.minori0721.dpdns.org', 'https://custom.example/download']) {
    test(`device download uses configured entry ${proxy} without fetching the audio in page JS`, async t => {
        const f = fixture(t, false);
        const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
        Object.defineProperty(globalThis, 'window', { configurable: true, value: { DOWNLOAD_PROXY_URL: proxy } });
        t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : delete globalThis.window);
        await f.dom.downloadBtn.onclick();
        await f.dom.downloadListEl.children[0].querySelector('.quality-action').children[0].onclick();
        assert.equal(f.anchors.length, 1);
        const anchor = f.anchors[0], url = new URL(anchor.href, 'https://player.example');
        assert.equal(url.searchParams.get('url'), 'https://cdn.test/music.mp3');
        assert.match(url.searchParams.get('filename'), /^Example.*\[standard\]\.mp3$/);
        assert.equal(anchor.href.startsWith(proxy + '?'), true);
        assert.equal(anchor.target, '_blank'); assert.equal(anchor.rel, 'noopener');
        assert.equal(anchor.download, url.searchParams.get('filename'));
    });
}
