import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaylistView } from '../src/playlist/view.js';
import { createHost } from './helpers/host.mjs';

function fixture(t, count) {
    const { host, elements, requests, frames } = createHost('<div id="root"></div><div id="rows"></div><input id="search"><button id="clear"></button><div id="empty"></div>');
    const saved = { window: globalThis.window, document: globalThis.document };
    globalThis.window = host;
    globalThis.document = host.document;
    const container = elements.get('rows'), writes = [], plays = [];
    const setProperty = container.style.setProperty.bind(container.style);
    container.style.setProperty = (name, value) => { writes.push([name, value]); setProperty(name, value); };
    const track = index => ({ name: `Track ${index + 1}`, netease: true });
    const queue = { playlist: Array.from({ length: count }, (_, index) => track(index)), curIdx: -1,
        playTrackFromPlaylist: index => plays.push(index) };
    const view = createPlaylistView({
        dom: { el: { plSidebar: elements.get('root'), plContainer: container,
            plSearch: elements.get('search'), plSearchClear: elements.get('clear'), plSearchEmpty: elements.get('empty') } },
        queue,
        persistence: { schedulePlaylistStateSave() {}, schedulePlaylistTrackSave() {} },
        prefetch: { isNextPreloadCompatible: () => true }
    });
    t.after(() => {
        view.pausePlaylistCovers();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        }
    });
    const flush = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(performance.now()); } };
    return { view, queue, container, writes, plays, requests, track, host, elements, flush,
        digits: () => container.style['--playlist-index-digits'] };
}

for (const [count, digits] of [[0, 3], [9, 3], [99, 3], [100, 3], [999, 3], [1000, 4], [9999, 4], [10000, 5]]) {
    test(`a ${count}-track playlist has one shared ${digits}-digit index column`, t => {
        const f = fixture(t, count);
        f.view.renderPlaylist();
        assert.equal(f.container.children.length, count);
        assert.equal(f.digits(), String(digits));
        assert.deepEqual(f.writes, [['--playlist-index-digits', String(digits)]]);
        if (count) {
            assert.equal(f.container.children.at(-1).children[0].textContent, String(count));
            assert.equal(f.container.children[0].style['--playlist-index-digits'], undefined);
        }
        assert.equal(f.requests.length, 0);
    });
}

test('incremental append expands all rows at 1000 and 10000 without recreating existing rows', t => {
    const f = fixture(t, 999);
    f.view.renderPlaylist();
    const first = f.container.children[0], row999 = f.container.children[998];
    f.queue.playlist.push(f.track(999));
    f.view.appendPlaylistRows(999);
    assert.equal(f.digits(), '4');
    assert.equal(f.container.children[0], first);
    assert.equal(f.container.children[998], row999);
    for (let index = 1000; index < 10000; index++) f.queue.playlist.push(f.track(index));
    f.view.appendPlaylistRows(1000);
    assert.equal(f.digits(), '5');
    assert.equal(f.container.children[0], first);
    assert.equal(f.container.children[998], row999);
    assert.equal(f.container.children.at(-1).children[0].textContent, '10000');
    assert.equal(f.writes.length, 3);
});

test('search hides existing rows without changing original queue indices, text or images', t => {
    const f = fixture(t, 12); f.view.renderPlaylist();
    const originalRows = [...f.container.children], queue = f.queue.playlist;
    f.view.setSearchQuery('ＴＲＡＣＫ １２');
    assert.deepEqual(f.container.children.filter(row => !row.hidden), [originalRows[11]]);
    assert.equal(f.queue.playlist, queue); assert.deepEqual(f.container.children, originalRows);
    originalRows[11].onclick(); assert.deepEqual(f.plays, [11]);
    f.queue.curIdx = 11; f.view.updatePlaylistActiveItem?.(); f.view.ensurePlaylistRenderedAndActive();
    assert.equal(originalRows[11].getAttribute('aria-current'), 'true');
    f.view.setSearchQuery('not found'); assert.equal(f.elements.get('empty').hidden, false);
    f.view.setSearchQuery(''); assert.equal(f.elements.get('clear').disabled, true);
    assert.ok(f.container.children.every(row => !row.hidden)); assert.equal(f.requests.length, 0);
});

test('search includes structured artists, supports IME, and preserves the query across appends', t => {
    const f = fixture(t, 2);
    f.queue.playlist[1].songData = { name: '月ノ鐘', ar: [{ name: 'Aimer' }] };
    f.view.initialize(); f.view.renderPlaylist();
    const input = f.elements.get('search');
    input.dispatchEvent({ type: 'compositionstart' }); input.value = '月 aimer';
    input.dispatchEvent({ type: 'input', isComposing: true }); f.flush();
    assert.ok(f.container.children.every(row => !row.hidden));
    input.dispatchEvent({ type: 'compositionend' }); f.flush();
    assert.deepEqual(f.container.children.map(row => row.hidden), [true, false]);
    f.queue.playlist.push({ name: '月 Aimer', netease: true }); f.view.appendPlaylistRows(2);
    assert.equal(f.container.children[2].hidden, false); assert.equal(input.value, '月 aimer');
    f.queue.playlist[0].name = '月 Aimer'; f.view.refreshPlaylistItem(0);
    assert.equal(f.container.children[0].hidden, false);
    f.queue.playlist = [f.track(0), f.track(1), f.track(2)]; f.view.ensurePlaylistRenderedAndActive();
    assert.equal(input.value, ''); assert.ok(f.container.children.every(row => !row.hidden));
});

test('clearing restores the old scroll and locating a filtered current track clears only the query', t => {
    const f = fixture(t, 12); f.view.initialize(); f.view.renderPlaylist();
    const root = f.elements.get('root'); root.scrollTop = 500;
    f.view.setSearchQuery('track 12'); assert.equal(root.scrollTop, 0);
    f.elements.get('clear').click(); assert.equal(root.scrollTop, 500);
    f.view.setSearchQuery('track 1'); f.queue.curIdx = 8; f.view.ensurePlaylistRenderedAndActive();
    const active = f.container.children[8]; let scrolled = false;
    f.container.querySelector = selector => selector === '.pl-item.active' ? active : null;
    active.scrollIntoView = options => { scrolled = options.behavior === 'smooth'; };
    f.view.scrollPlaylistToCurrent();
    assert.equal(scrolled, true); assert.equal(f.elements.get('search').value, '');
    assert.equal(f.queue.curIdx, 8); assert.deepEqual(f.plays, []);
});

test('selection and refresh preserve the shared width; replacing a long playlist shrinks it again', t => {
    const f = fixture(t, 1000);
    f.view.renderPlaylist();
    const row = f.container.children[999];
    f.queue.curIdx = 999;
    f.view.ensurePlaylistRenderedAndActive();
    f.view.refreshPlaylistItem(999);
    assert.equal(row.classList.contains('active'), true);
    assert.equal(row.getAttribute('aria-current'), 'true');
    assert.equal(row.getAttribute('aria-label'), '播放第 1000 首：Track 1000');
    row.onclick();
    assert.deepEqual(f.plays, [999]);
    assert.equal(f.writes.length, 1);
    f.queue.playlist = [f.track(0), f.track(1)];
    f.queue.curIdx = -1;
    f.view.ensurePlaylistRenderedAndActive();
    assert.equal(f.digits(), '3');
    assert.equal(f.container.children.length, 2);
    assert.equal(f.writes.length, 2);
});
