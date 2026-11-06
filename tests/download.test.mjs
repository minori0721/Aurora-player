import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownload } from '../src/netease/download.js';
import { FakeElement } from './helpers/host.mjs';

function fixture(t, matched, audioInfo = null) {
    const dom = Object.fromEntries(['downloadClose', 'downloadCancel', 'downloadModal', 'downloadBtnMobile',
        'downloadBtn', 'downloadTitle', 'downloadTrackInfo', 'downloadListEl'].map(key => [key, new FakeElement()]));
    const anchors = [];
    const document = { body: new FakeElement(), createElement(tag) {
        const element = new FakeElement();
        if (tag === 'a') anchors.push(element);
        Object.defineProperty(element, 'innerHTML', { get() { return this._html || ''; }, set(value) {
            this._html = value; this.children = [];
            if (value.includes('quality-meta')) this.children.push(Object.assign(new FakeElement(), { className: 'quality-meta' }));
        } });
        return element;
    } };
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document });
    t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
    const download = createDownload({ dom, playback: { _currentPlayActionToken: 7 }, debug: { log() {} },
        panels: { modalController: { open() {} } }, api: { buildApiUrl: path => `https://api.test${path}` },
        auth: { neteaseCookie: '', captureAuthSnapshot: () => ({}), isAuthSnapshotCurrent: () => true },
        cache: { cachedFetchJson: async raw => new URL(raw).pathname === '/song/music/detail'
            ? { data: Object.fromEntries(['standard', 'higher', 'exhigh', 'lossless', 'hires'].map(level => [level,
                { br: 952000, sr: 48000, size: 36 * 1024 * 1024 }])) }
            : { data: matched ? { url: null } : audioInfo || { url: 'https://cdn.test/music.mp3', type: 'mp3', br: 192000, sr: 44100, size: 5 * 1024 * 1024 } } },
        resolver: { isNeteaseTrialOnly: () => false, getNeteaseMatchStrategy: () => ['test'],
            fetchNeteaseMatchAudio: async () => ({ audioUrl: 'https://cdn.test/matched.mp3', source: 'test' }) }
    });
    download._currentPlaying = { playToken: 7, netease: true, songId: 1, songData: { name: 'Example', ar: [] } };
    download.initialize();
    return { download, dom, anchors };
}

test('match download never borrows official bitrate, sample rate, size or lossless inference', async t => {
    const f = fixture(t, true); await f.dom.downloadBtn.onclick();
    for (const row of f.dom.downloadListEl.children) {
        assert.equal(row.querySelector('.quality-meta').textContent, 'MP3 (match兜底/test)');
        assert.equal(row.querySelector('.quality-action').children[0].textContent, '下载');
    }
});

test('official MP3 download keeps actual bitrate, sample rate and size visible', async t => {
    const f = fixture(t, false); await f.dom.downloadBtn.onclick();
    for (const row of f.dom.downloadListEl.children) {
        assert.equal(row.querySelector('.quality-meta').textContent, 'MP3 192kbps 44.1kHz 5.0MB');
    }
});

for (const type of ['mp3', 'm4a', 'wav', 'ogg']) {
    test(`large ${type} downloads keep their real format without a lossless upgrade`, async t => {
        const f = fixture(t, false, { url: `https://cdn.test/music.${type}`, type, size: 25 * 1024 * 1024 });
        await f.dom.downloadBtn.onclick();
        for (const row of f.dom.downloadListEl.children) assert.equal(row.querySelector('.quality-meta').textContent, `${type.toUpperCase()} 25.0MB`);
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
