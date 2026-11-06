import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPlaylistView } from '../src/playlist/view.js';
import { createHost, withBaseQueue } from './helpers/host.mjs';
import { PlaybackPlan } from '../src/playlist/plan.js';

function fixture(t, count) {
    const { host, elements, requests, frames } = createHost('<div id="root"></div><div id="rows"></div><input id="search"><button id="clear"></button><div id="empty"></div><section id="temporary"><div id="manual-rows"></div></section><div id="base-label"></div><button id="clear-manual"></button>');
    const saved = { window: globalThis.window, document: globalThis.document };
    globalThis.window = host;
    globalThis.document = host.document;
    const container = elements.get('rows'), writes = [], plays = [];
    const setProperty = container.style.setProperty.bind(container.style);
    container.style.setProperty = (name, value) => { writes.push([name, value]); setProperty(name, value); };
    const track = index => ({ name: `Track ${index + 1}`, netease: true });
    const queue = withBaseQueue({ playlist: Array.from({ length: count }, (_, index) => track(index)), curIdx: -1,
        playTrackFromPlaylist: index => plays.push(index), indexOfTrack(track) { return this.playlist.indexOf(track); } });
    const view = createPlaylistView({
        dom: { el: { plSidebar: elements.get('root'), plContainer: container,
            plTemporary: elements.get('temporary'), plTemporaryContainer: elements.get('manual-rows'),
            plBaseLabel: elements.get('base-label'), plClearTemporary: elements.get('clear-manual'),
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
    const rows = () => container.querySelectorAll('.pl-item');
    const visibleRows = () => {
        const hidden = new Set(container.querySelectorAll('.pl-row-group').filter(group => group.hidden).flatMap(group => group.children));
        return rows().filter(row => !row.hidden && !hidden.has(row));
    };
    const click = row => {
        const closest = row.closest;
        row.closest = selector => selector === '.pl-item' ? row : null;
        (row._temporaryNumber ? elements.get('manual-rows') : container).dispatchEvent({ type: 'click', target: row });
        row.closest = closest;
    };
    return { view, queue, container, rows, visibleRows, click, writes, plays, requests, track, host, elements, flush,
        digits: () => container.style['--playlist-index-digits'],
        sharedDigits: () => elements.get('root').style['--playlist-shared-index-digits'] };
}

function usePlaybackPlan(f) {
    const model = new PlaybackPlan();
    model.reset(f.queue.playlist);
    Object.defineProperties(f.queue, {
        playlist: { get: () => model.items }, basePlaylist: { get: () => model.base },
        curIdx: { get: () => model.index }, temporaryEntries: { get: () => model.temporary },
        manualState: { get: () => ({ pending: model.pending }) }
    });
    f.queue.indexOfTrack = track => model.indexOf(track);
    return model;
}

test('artist width can grow into spare title space and stops at its intrinsic text width', () => {
    const css = readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
    const artist = css.match(/\.pl-song-artists\s*\{([^}]+)\}/)[1];
    assert.match(artist, /flex:\s*1 0 min\(40%, clamp\(4em, 30%, 7em\)\)/);
    assert.match(artist, /max-width:\s*max-content/);
    assert.match(artist, /text-overflow:\s*ellipsis/);
});

test('online titles have no cloud prefix when created, refreshed, appended or temporarily queued', t => {
    const f = fixture(t, 1), model = usePlaybackPlan(f);
    model.playNow({ name: 'Temporary title', netease: true });
    f.view.renderPlaylist();
    const title = row => row.querySelector('.pl-song-name').textContent;
    const manual = f.elements.get('manual-rows');
    assert.equal(title(f.rows()[0]), 'Track 1');
    assert.equal(title(manual.querySelectorAll('.pl-item')[0]), 'Temporary title');
    model.base[0].name = 'Updated base'; model.current.name = 'Updated temporary';
    f.view.refreshPlaylistItem(0); f.view.refreshPlaylistItem(model.index);
    assert.equal(title(f.rows()[0]), 'Updated base');
    assert.equal(title(manual.querySelectorAll('.pl-item')[0]), 'Updated temporary');
    model.appendBaseTracks([{ name: 'Appended title', netease: true }]);
    f.view.appendPlaylistRows(1);
    assert.equal(title(f.rows()[1]), 'Appended title');
    assert.equal(f.requests.length, 0);
});

test('local file warnings remain while ordinary local titles stay undecorated', t => {
    const f = fixture(t, 2);
    f.queue.playlist[0] = { name: 'missing.wav', needsFile: true };
    f.queue.playlist[1] = { name: 'ready.wav' };
    f.view.renderPlaylist();
    for (let index = 0; index < 2; index++) f.view.refreshPlaylistItem(index);
    assert.equal(f.rows()[0].querySelector('.pl-song-name').textContent, '\u26a0\ufe0f missing.wav');
    assert.equal(f.rows()[1].querySelector('.pl-song-name').textContent, 'ready.wav');
});

test('structured song names and artists are separate without splitting title punctuation', t => {
    const f = fixture(t, 3);
    f.queue.playlist[0] = { name: 'Title - Part II - Aimer', netease: true,
        songData: { name: 'Title - Part II', ar: [{ name: 'Aimer' }, { name: '<Guest>' }] } };
    f.queue.playlist[1] = { name: 'Legacy display', netease: true,
        songData: { name: 'Another title', artists: [{ artistName: 'Artist' }] } };
    f.queue.playlist[2] = { name: 'Local - filename.wav' };
    f.view.renderPlaylist();
    const [first, second, local] = f.rows();
    assert.equal(first.querySelector('.pl-song-name').textContent, 'Title - Part II');
    assert.equal(first.querySelector('.pl-song-artists').textContent, 'Aimer, <Guest>');
    assert.equal(first.querySelector('.pl-item-title').title, 'Title - Part II - Aimer, <Guest>');
    assert.equal(first.querySelector('.pl-song-separator').getAttribute('aria-hidden'), 'true');
    assert.equal(second.querySelector('.pl-song-artists').textContent, 'Artist');
    assert.equal(local.querySelector('.pl-song-name').textContent, 'Local - filename.wav');
    assert.equal(local.querySelector('.pl-song-artists'), null);
    assert.equal(f.requests.length, 0);
});

test('artist updates reuse title nodes and covers, including temporary and appended rows', t => {
    const f = fixture(t, 1), model = usePlaybackPlan(f);
    model.playNow({ name: 'Temporary - Singer', netease: true,
        songData: { name: 'Temporary', ar: [{ name: 'Singer' }] } });
    f.view.renderPlaylist();
    const row = f.rows()[0], cover = row.querySelector('.pl-item-cover');
    const title = row.querySelector('.pl-song-name');
    model.base[0].songData = { name: 'Updated', ar: [], artists: [{ name: 'New singer' }] };
    f.view.refreshPlaylistItem(0);
    const artist = row.querySelector('.pl-song-artists');
    assert.equal(artist.textContent, 'New singer');
    assert.equal(artist.hidden, false);
    assert.equal(row.querySelector('.pl-song-name'), title);
    assert.equal(title.textContent, 'Updated');
    assert.equal(row.querySelector('.pl-item-cover'), cover);
    model.base[0].songData.ar = [{ name: '' }]; delete model.base[0].songData.artists;
    f.view.refreshPlaylistItem(0);
    assert.equal(artist.hidden, true);
    assert.equal(row.querySelector('.pl-song-separator').hidden, true);
    const manual = f.elements.get('manual-rows').querySelectorAll('.pl-item')[0];
    model.current.songData.ar[0].name = 'Updated singer';
    f.view.refreshPlaylistItem(model.index);
    assert.equal(manual.querySelector('.pl-song-artists').textContent, 'Updated singer');
    assert.match(manual.getAttribute('aria-label'), /播放临时点播/);
    model.appendBaseTracks([{ name: 'Appended - Singer', netease: true,
        songData: { name: 'Appended', ar: [{ name: 'Singer' }] } }]);
    f.view.appendPlaylistRows(1);
    assert.equal(f.rows()[1].querySelector('.pl-song-artists').textContent, 'Singer');
    assert.equal(f.requests.length, 0);
});

for (const [count, digits] of [[0, 3], [9, 3], [99, 3], [100, 3], [999, 3], [1000, 4], [9999, 4], [10000, 5]]) {
    test(`a ${count}-track playlist has one shared ${digits}-digit index column`, t => {
        const f = fixture(t, count);
        f.view.renderPlaylist();
        assert.equal(f.rows().length, count);
        assert.equal(f.digits(), String(digits));
        assert.deepEqual(f.writes, [['--playlist-index-digits', String(digits)]]);
        if (count) {
            assert.equal(f.rows().at(-1).children[0].textContent, String(count));
            assert.equal(f.rows()[0].style['--playlist-index-digits'], undefined);
        }
        assert.equal(f.requests.length, 0);
    });
}

test('incremental append expands all rows at 1000 and 10000 without recreating existing rows', t => {
    const f = fixture(t, 999);
    f.view.renderPlaylist();
    const first = f.rows()[0], row999 = f.rows()[998];
    f.queue.playlist.push(f.track(999));
    f.view.appendPlaylistRows(999);
    assert.equal(f.digits(), '4');
    assert.equal(f.rows()[0], first);
    assert.equal(f.rows()[998], row999);
    for (let index = 1000; index < 10000; index++) f.queue.playlist.push(f.track(index));
    f.view.appendPlaylistRows(1000);
    assert.equal(f.digits(), '5');
    assert.equal(f.rows()[0], first);
    assert.equal(f.rows()[998], row999);
    assert.equal(f.rows().at(-1).children[0].textContent, '10000');
    assert.equal(f.writes.length, 3);
});

test('search hides existing rows without changing original queue indices, text or images', t => {
    const f = fixture(t, 12); f.view.renderPlaylist();
    const originalRows = [...f.rows()], queue = f.queue.playlist;
    f.view.setSearchQuery('ＴＲＡＣＫ １２');
    assert.deepEqual(f.rows().filter(row => !row.hidden), [originalRows[11]]);
    assert.equal(f.queue.playlist, queue); assert.deepEqual(f.rows(), originalRows);
    f.click(originalRows[11]); assert.deepEqual(f.plays, [11]);
    f.queue.curIdx = 11; f.view.updatePlaylistActiveItem?.(); f.view.ensurePlaylistRenderedAndActive();
    assert.equal(originalRows[11].getAttribute('aria-current'), 'true');
    f.view.setSearchQuery('not found'); assert.equal(f.elements.get('empty').hidden, false);
    f.view.setSearchQuery(''); assert.equal(f.elements.get('clear').disabled, true);
    assert.ok(f.rows().every(row => !row.hidden)); assert.equal(f.requests.length, 0);
});

test('search includes structured artists, supports IME, and preserves the query across appends', t => {
    const f = fixture(t, 2);
    f.queue.playlist[1].songData = { name: '月ノ鐘', ar: [{ name: 'Aimer' }] };
    f.view.initialize(); f.view.renderPlaylist();
    const input = f.elements.get('search');
    input.dispatchEvent({ type: 'compositionstart' }); input.value = '月 aimer';
    input.dispatchEvent({ type: 'input', isComposing: true }); f.flush();
    assert.ok(f.rows().every(row => !row.hidden));
    input.dispatchEvent({ type: 'compositionend' }); f.flush();
    assert.deepEqual(f.rows().map(row => row.hidden), [true, false]);
    f.queue.playlist.push({ name: '月 Aimer', netease: true }); f.view.appendPlaylistRows(2);
    assert.equal(f.rows()[2].hidden, false); assert.equal(input.value, '月 aimer');
    f.queue.playlist[0].name = '月 Aimer'; f.view.refreshPlaylistItem(0);
    assert.equal(f.rows()[0].hidden, false);
    f.queue.playlist = [f.track(0), f.track(1), f.track(2)]; f.view.ensurePlaylistRenderedAndActive();
    assert.equal(input.value, ''); assert.ok(f.rows().every(row => !row.hidden));
});

test('clearing restores the old scroll and locating a filtered current track clears only the query', t => {
    const f = fixture(t, 12); f.view.initialize(); f.view.renderPlaylist();
    const root = f.elements.get('root'); root.scrollTop = 500;
    f.view.setSearchQuery('track 12'); assert.equal(root.scrollTop, 0);
    f.elements.get('clear').click(); assert.equal(root.scrollTop, 500);
    f.view.setSearchQuery('track 1'); f.queue.curIdx = 8; f.view.ensurePlaylistRenderedAndActive();
    const active = f.rows()[8]; let scrolled = false;
    f.container.querySelector = selector => selector === '.pl-item.active' ? active : null;
    active.scrollIntoView = options => { scrolled = options.behavior === 'smooth'; };
    f.view.scrollPlaylistToCurrent();
    assert.equal(scrolled, true); assert.equal(f.elements.get('search').value, '');
    assert.equal(f.queue.curIdx, 8); assert.deepEqual(f.plays, []);
});

test('clearing at the top avoids a redundant scroll write after DOM updates', t => {
    const f = fixture(t, 1000); f.view.renderPlaylist();
    const root = f.elements.get('root'), writes = [];
    Object.defineProperty(root, 'scrollTop', { configurable: true, get: () => 0, set: value => writes.push(value) });
    f.view.setSearchQuery('track 999'); f.view.setSearchQuery('not found');
    const beforeClear = writes.length; f.view.setSearchQuery('');
    assert.equal(writes.length, beforeClear);
    assert.equal(f.visibleRows().length, 1000);
});

test('selection and refresh preserve the shared width; replacing a long playlist shrinks it again', t => {
    const f = fixture(t, 1000);
    f.view.renderPlaylist();
    const row = f.rows()[999];
    f.queue.curIdx = 999;
    f.view.ensurePlaylistRenderedAndActive();
    f.view.refreshPlaylistItem(999);
    assert.equal(row.classList.contains('active'), true);
    assert.equal(row.getAttribute('aria-current'), 'true');
    assert.equal(row.getAttribute('aria-label'), '播放第 1000 首：Track 1000');
    f.click(row);
    assert.deepEqual(f.plays, [999]);
    assert.equal(f.writes.length, 1);
    f.queue.playlist = [f.track(0), f.track(1)];
    f.queue.curIdx = -1;
    f.view.ensurePlaylistRenderedAndActive();
    assert.equal(f.digits(), '3');
    assert.equal(f.rows().length, 2);
    assert.equal(f.writes.length, 2);
});

test('manual queue updates keep every base row and cover, and search includes both sections', t => {
    const f = fixture(t, 1000), model = usePlaybackPlan(f); model.select(2);
    f.view.renderPlaylist(); const original = f.rows().slice(), cover = original[2].children[1];
    model.playNow({ name: 'Manual title', netease: true });
    model.enqueue([{ name: 'Next title', netease: true }]);
    f.view.ensurePlaylistRenderedAndActive();
    assert.deepEqual(f.rows(), original); assert.equal(f.rows()[2].children[1], cover);
    const manual = f.elements.get('manual-rows');
    assert.equal(manual.querySelectorAll('.pl-item').length, 2); assert.equal(manual.querySelectorAll('.pl-item')[0].getAttribute('aria-current'), 'true');
    f.view.refreshPlaylistItem(model.index);
    assert.equal(manual.querySelectorAll('.pl-item')[0].getAttribute('aria-label'), '播放临时点播第 1 首：Manual title');
    f.view.setSearchQuery('manual');
    assert.equal(f.visibleRows().length, 0);
    assert.deepEqual(manual.querySelectorAll('.pl-item').map(row => row.hidden), [false, true]);
    model.clearPending(); f.view.ensurePlaylistRenderedAndActive();
    assert.equal(manual.querySelectorAll('.pl-item').length, 1); assert.equal(f.elements.get('clear-manual').disabled, true);
    assert.equal(f.requests.length, 0);
});

for (const [baseCount, temporaryCount, digits] of [[1, 1, 3], [1000, 1, 4], [1, 1000, 4], [10000, 1, 5]]) {
    test(`${baseCount} base and ${temporaryCount} temporary rows share a ${digits}-digit desktop column`, t => {
        const f = fixture(t, baseCount), model = usePlaybackPlan(f);
        model.enqueue(Array.from({ length: temporaryCount }, (_, index) => ({ name: `Manual ${index + 1}`, netease: true })));
        f.view.renderPlaylist();
        const manual = f.elements.get('manual-rows'), firstBase = f.rows()[0];
        assert.equal(f.sharedDigits(), String(digits));
        assert.equal(f.digits(), String(Math.max(3, String(baseCount).length)));
        assert.equal(manual.style['--playlist-index-digits'], String(Math.max(3, String(temporaryCount).length)));
        f.view.setSearchQuery('manual 1');
        assert.equal(f.sharedDigits(), String(digits));
        assert.equal(f.rows()[0], firstBase);
        assert.equal(f.visibleRows().length, 0);
        model.clearPending(); f.view.ensurePlaylistRenderedAndActive();
        assert.equal(f.sharedDigits(), String(Math.max(3, String(baseCount).length)));
        assert.equal(f.rows()[0], firstBase);
        assert.equal(f.requests.length, 0);
    });
}

test('incremental base growth updates both desktop columns without recreating rows', t => {
    const f = fixture(t, 999), model = usePlaybackPlan(f);
    model.enqueue([{ name: 'Manual', netease: true }]);
    f.view.renderPlaylist(); const firstBase = f.rows()[0];
    model.appendBaseTracks([f.track(999)]); f.view.appendPlaylistRows(999);
    assert.equal(f.sharedDigits(), '4');
    assert.equal(f.rows()[0], firstBase);
    f.view.setSearchQuery('manual');
    assert.equal(f.sharedDigits(), '4');
    assert.equal(f.elements.get('manual-rows').style['--playlist-index-digits'], '3');
    assert.equal(f.requests.length, 0);
});

function scrollingFixture(t) {
    const f = fixture(t, 40), sidebar = f.elements.get('root'), doc = f.host.document;
    sidebar.classList.add('show'); sidebar.scrollTop = 300;
    sidebar.getBoundingClientRect = () => ({ top: 0, bottom: 200 });
    const create = doc.createElement.bind(doc);
    doc.createElement = tag => {
        const node = create(tag);
        if (tag === 'button') {
            node.getBoundingClientRect = () => {
                const top = 100 + node._queueIndex * 50 - sidebar.scrollTop;
                return { top, bottom: top + 50 };
            };
            node.focus = () => { doc.activeElement = node; };
        }
        return node;
    };
    f.view.renderPlaylist();
    return { ...f, sidebar, doc };
}

test('synchronized prepends preserve the visible row offset and keyboard focus', t => {
    const f = scrollingFixture(t), visible = f.rows()[4], focused = f.rows()[5];
    const anchor = visible._track, top = visible.getBoundingClientRect().top;
    focused.focus(); const focusedTrack = focused._track;
    f.queue.playlist.unshift(f.track(99));
    f.view.renderPlaylist({ preservePosition: true });
    assert.equal(f.sidebar.scrollTop, 350);
    assert.equal(f.rows().find(row => row._track === anchor).getBoundingClientRect().top, top);
    assert.equal(f.doc.activeElement._track, focusedTrack);
    assert.notEqual(f.doc.activeElement, focused);
});

test('removing the first visible row preserves the next surviving row instead of jumping to the start', t => {
    const f = scrollingFixture(t), anchor = f.rows()[5]._track, top = f.rows()[5].getBoundingClientRect().top;
    f.queue.playlist.splice(4, 1);
    f.view.renderPlaylist({ preservePosition: true });
    assert.equal(f.sidebar.scrollTop, 250);
    assert.equal(f.rows().find(row => row._track === anchor).getBoundingClientRect().top, top);
});

test('synchronized updates keep search terms and show newly prepended rows when already at the top', t => {
    const f = fixture(t, 40), sidebar = f.elements.get('root');
    f.view.renderPlaylist(); f.view.setSearchQuery('track 6');
    const value = f.elements.get('search').value;
    f.queue.playlist.unshift(f.track(99));
    f.view.renderPlaylist({ preservePosition: true });
    assert.equal(f.elements.get('search').value, value);
    assert.equal(f.visibleRows().length, 4);
    f.view.setSearchQuery(''); sidebar.scrollTop = 0;
    f.queue.playlist.unshift(f.track(100));
    f.view.renderPlaylist({ preservePosition: true });
    assert.equal(sidebar.scrollTop, 0); assert.equal(f.rows()[0]._track, f.queue.playlist[0]);
});
