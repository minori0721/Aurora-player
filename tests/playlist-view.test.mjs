import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaylistView } from '../src/playlist/view.js';
import { createHost } from './helpers/host.mjs';

function fixture(t, count) {
    const { host, elements, requests } = createHost('<div id="root"></div><div id="rows"></div>');
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
        dom: { el: { plSidebar: elements.get('root'), plContainer: container } },
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
    return { view, queue, container, writes, plays, requests, track,
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
