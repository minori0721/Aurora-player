import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHost } from './helpers/host.mjs';
import { createDom } from '../src/ui/elements.js';
import { createBrowser } from '../src/netease/navigation.js';
import { createContent } from '../src/netease/content.js';

const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const songs = Array.from({ length: 101 }, (_, index) => ({ id: index + 1, name: `Song ${index + 1}`, dt: 180000,
    ar: [{ id: 1000, name: 'Artist' }], al: { id: 2000, name: 'Album' } }));

function fixture(t) {
    const { host, elements, requests } = createHost(html);
    host.location.href = 'http://localhost/#music/playlists/import'; host.location.hash = '#music/playlists/import';
    const writeHistory = (state, _, url) => {
        host.history.state = state;
        if (url) { host.location.href = url; host.location.hash = new URL(url).hash; }
    };
    host.history.replaceState = writeHistory; host.history.pushState = writeHistory; host.history.length = 1;
    const globals = { window: host, document: host.document, history: host.history,
        sessionStorage: host.sessionStorage, requestAnimationFrame: host.requestAnimationFrame };
    const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => {
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });
    const dom = createDom(), calls = [], logs = [];
    let content;
    const browser = createBrowser({ dom, auth: { cancelLoginSession() {}, refreshVipInfo() {} },
        content: new Proxy({}, { get: (_, key) => (...args) => content[key](...args) }),
        panels: { modalController: {
            open() { dom.neteasePanel.classList.add('show'); }, close() { dom.neteasePanel.classList.remove('show'); }
        } } });
    content = createContent({ dom, browser, onlinePlaylist: { SONGS_PER_PAGE: 50 },
        queue: { playlist: [], curIdx: -1, async playTemporaryNow(song) { calls.push(['play', song.songId]); },
            enqueueTemporary(entries, next) { calls.push(['queue', entries.map(song => song.songId), next]); } },
        debug: { log: (...args) => logs.push(args) } });
    content.initialize(); browser.initialize();
    const row = () => dom.playlistResults.children.find(node => node.className === 'netease-item');
    const click = async (kind = 'play') => {
        const menu = { open: true }, first = row();
        const target = { dataset: { musicQueue: kind }, closest(selector) {
            if (selector === '.netease-item[data-music-context]') return first;
            if (selector === 'details') return menu;
            if (selector === (kind === 'play' ? '[data-music-play]' : '[data-music-queue]')) return this;
            return null;
        } };
        dom.neteasePanel.dispatchEvent({ type: 'click', target, stopPropagation() {} });
        await Promise.resolve();
    };
    return { host, dom, elements, requests, browser, content, calls, logs, row, click };
}

test('long online artist groups retain individual escaped links inside their own layout block', t => {
    const f = fixture(t);
    f.content.setMainMusicEntityLinks({ id: 1, name: 'Song', ar: [{ id: 11, name: 'Artist "A"' }, { id: 12, name: '<Artist B>' }], al: { id: 2, name: 'Album' } });
    const markup = f.dom.el.artist.innerHTML;
    assert.match(markup, /^<span class="track-artist-names" title="Artist &quot;A&quot;, &lt;Artist B&gt;">/);
    assert.match(markup, /data-music-artist="11"/); assert.match(markup, /data-music-artist="12"/);
    assert.doesNotMatch(markup, /<Artist B>/);
});

for (const journey of ['same tab', 'search and back', 'close and reopen']) {
    test(`retained playlist songs stay playable after ${journey} without redraw or requests`, async t => {
        const f = fixture(t);
        f.content.renderSongList(songs, f.dom.playlistResults, 1);
        const row = f.row(), context = f.browser.musicBrowserState.contexts.get(row.dataset.musicContext);
        await f.click(); assert.deepEqual(f.calls.at(-1), ['play', 51]);
        if (journey === 'same tab') await f.browser.renderMusicRoute({ kind: 'playlist-import' });
        else if (journey === 'search and back') {
            await f.browser.renderMusicRoute({ kind: 'search', q: '', type: 'all', page: 1 });
            assert.equal(f.browser.musicBrowserState.contexts.has(row.dataset.musicContext), false);
            await f.browser.renderMusicRoute({ kind: 'playlist-import' });
        } else {
            f.browser.closeMusicBrowser(); f.elements.get('toggle-netease-panel').onclick();
        }
        assert.equal(f.row(), row);
        assert.equal(f.browser.musicBrowserState.contexts.get(row.dataset.musicContext), context);
        await f.click(); assert.deepEqual(f.calls.at(-1), ['play', 51]);
        await f.click('next'); assert.deepEqual(f.calls.at(-1), ['queue', [51], true]);
        await f.click('last'); assert.deepEqual(f.calls.at(-1), ['queue', [51], false]);
        assert.equal(f.requests.length, 0); assert.deepEqual(f.logs.filter(log => log[1] === 'warn'), []);
        assert.equal(f.dom.neteasePanel.listeners.get('click').size, 2);
    });
}

test('replaced or cleared playlist DOM never restores its old context', async t => {
    const f = fixture(t);
    f.content.renderSongList(songs, f.dom.playlistResults, 0);
    f.dom.playlistResults.innerHTML = '<div>Loading another playlist</div>';
    await f.browser.renderMusicRoute({ kind: 'playlist-import' });
    assert.equal(f.browser.musicBrowserState.contexts.size, 0);
    f.content.renderSongList([songs[100]], f.dom.playlistResults, 0);
    await f.browser.renderMusicRoute({ kind: 'playlist-import' });
    await f.click(); assert.deepEqual(f.calls.at(-1), ['play', 101]);
    assert.equal(f.browser.musicBrowserState.contexts.size, 1);
});

test('restoring a retained preview keeps the context bound and reports a missing context', async t => {
    const f = fixture(t);
    f.content.renderSongList(songs, f.dom.playlistResults, 0);
    const id = f.row().dataset.musicContext;
    for (let index = 0; index < 30; index++) f.browser.musicBrowserState.contexts.set(`other-${index}`, {});
    f.content.restorePlaylistPreviewContext();
    assert.equal(f.browser.musicBrowserState.contexts.size, 24);
    assert.ok(f.browser.musicBrowserState.contexts.has(id));
    f.browser.musicBrowserState.contexts.delete(id);
    await f.click();
    assert.equal(f.calls.length, 0); assert.equal(f.logs.at(-1)[1], 'warn');
});

test('background batches retain an unchanged preview page and paginate using the newest songs', async t => {
    const f = fixture(t), firstBatch = songs.slice(0, 50);
    f.content.renderSongList(firstBatch, f.dom.playlistResults);
    const first = f.row(), cover = first.querySelector('.music-song-cover');
    f.content.renderSongList(songs, f.dom.playlistResults);
    assert.equal(f.row(), first); assert.equal(first.querySelector('.music-song-cover'), cover);
    assert.equal(f.dom.playlistResults.querySelectorAll('.music-pagination').length, 1);
    const pagination = f.dom.playlistResults.querySelector('.music-pagination');
    assert.match(pagination.children[1].textContent, /101/);
    pagination.children[2].onclick();
    await f.click(); assert.deepEqual(f.calls.at(-1), ['play', 51]);
    assert.equal(f.requests.length, 0);
});

test('changed preview presentation and replaced containers are redrawn instead of reusing stale rows', t => {
    const f = fixture(t), data = songs.map(song => ({ ...song }));
    f.content.renderSongList(data, f.dom.playlistResults);
    const first = f.row(); data[0].name = 'Updated title';
    f.content.renderSongList(data, f.dom.playlistResults);
    assert.notEqual(f.row(), first);
    const updated = f.row(); f.dom.playlistResults.innerHTML = '';
    f.content.renderSongList(data, f.dom.playlistResults);
    assert.notEqual(f.row(), updated);
});
