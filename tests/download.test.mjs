import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownload } from '../src/netease/download.js';
import { FakeElement } from './helpers/host.mjs';

function fixture(t, matched) {
    const dom = Object.fromEntries(['downloadClose', 'downloadCancel', 'downloadModal', 'downloadBtnMobile',
        'downloadBtn', 'downloadTitle', 'downloadTrackInfo', 'downloadListEl'].map(key => [key, new FakeElement()]));
    const document = { createElement() {
        const element = new FakeElement();
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
            : { data: matched ? { url: null } : { url: 'https://cdn.test/music.mp3', type: 'mp3', br: 192000, sr: 44100, size: 5 * 1024 * 1024 } } },
        resolver: { isNeteaseTrialOnly: () => false, getNeteaseMatchStrategy: () => ['test'],
            fetchNeteaseMatchAudio: async () => ({ audioUrl: 'https://cdn.test/matched.mp3', source: 'test' }) }
    });
    download._currentPlaying = { playToken: 7, netease: true, songId: 1, songData: { name: 'Example', ar: [] } };
    download.initialize();
    return { download, dom };
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
