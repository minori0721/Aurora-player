import test from 'node:test';
import assert from 'node:assert/strict';
import { describeJsonCache } from '../src/storage/cache-policy.js';
import { createCompactPlaylistState, normalizePersistedPlaylistState, pickNewestPlaylistState, pickPlaylistSelectedIndex } from '../src/storage/playlist-schema.js';
import { createPorts, installPort, sealPorts } from '../src/shared/ports.js';

test('credential URLs never get public cache scope and volatile parameters do not split keys', () => {
    globalThis.window = { location: { href: 'http://localhost/' } };
    for (const field of ['cookie', 'TOKEN', 'key', 'csrf', 'MUSIC_U']) {
        const entry = describeJsonCache(`https://api.test/album?id=1&${field}=fake-secret&timestamp=4`, 'public');
        assert.equal(entry.scope, 'account');
        assert.equal(entry.key.includes('fake-secret'), false);
        assert.equal(entry.key.includes(`${field}=`), false);
    }
    assert.equal(describeJsonCache('https://api.test/album?id=1&timestamp=3').key, describeJsonCache('https://api.test/album?noCache=6&id=1').key);
    assert.equal(describeJsonCache('https://api.test/login', 'none').scope, 'none');
});

test('playlist migration preserves titles with delimiters and borrows only matching local handles', () => {
    const migrated = normalizePersistedPlaylistState({ schema: 2, tracks: [{ id: 7, name: 'A - B - Singer', ar: [{ id: 8, name: 'Singer' }] }] });
    assert.equal(migrated.tracks[0].title, 'A - B');
    const handle = { getFile() {} };
    const local = { type: 'local', name: 'song.ogg', relativePath: 'a/song.ogg', size: 123, lastModified: 9, handle };
    const older = { schema: 3, listId: 'list', revision: 1, selectedIndex: 0, tracks: [local] };
    const newer = { ...older, revision: 2, tracks: [{ ...local, handle: undefined }] };
    assert.equal(createCompactPlaylistState(older).tracks[0].handle, undefined);
    assert.equal(pickNewestPlaylistState(newer, older).tracks[0].handle, handle);
    assert.equal(pickNewestPlaylistState({ ...newer, tracks: [{ ...local, size: 999, handle: undefined }] }, older).tracks[0].handle, undefined);
});

test('selection snapshots cannot cross playlist identity or content revisions', () => {
    const state = { listId: 'a', revision: 10, selectedIndex: 0, tracks: [{}, {}, {}] };
    assert.equal(pickPlaylistSelectedIndex(state, { listId: 'b', contentRevision: 10, revision: 11, selectedIndex: 2 }), 0);
    assert.equal(pickPlaylistSelectedIndex(state, { listId: 'a', contentRevision: 9, revision: 11, selectedIndex: 2 }), 0);
    assert.equal(pickPlaylistSelectedIndex(state, { listId: 'a', contentRevision: 10, revision: 11, selectedIndex: 2 }), 2);
});

test('composition preserves live state without copying, and seals service interfaces', () => {
    let value = 1;
    const ports = createPorts(['one', 'two']);
    installPort(ports.one, { get value() { return value; }, set value(next) { value = next; } });
    installPort(ports.two, { read: () => ports.one.value });
    sealPorts(ports);
    ports.one.value = 2;
    assert.equal(ports.two.read(), 2);
    assert.throws(() => { ports.two.read = () => 0; }, TypeError);
    assert.throws(() => installPort(ports.one, {}));
});
