import test from 'node:test';
import assert from 'node:assert/strict';
import { describeJsonCache } from '../src/storage/cache-policy.js';
import { createCompactPlaylistState, normalizePersistedPlaylistState, pickNewestPlaylistState, pickPlaylistSelectedIndex } from '../src/storage/playlist-schema.js';
import { createPorts, installPort, sealPorts } from '../src/shared/ports.js';
import { createPersistence } from '../src/storage/playlist.js';
import { createHost, withBaseQueue } from './helpers/host.mjs';

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

test('composition rejects missing required services before startup', () => {
    const ports = createPorts(['required']);
    assert.throws(() => sealPorts(ports), /required/);
});

for (const name of ['SecurityError', 'QuotaExceededError', 'UnknownError', 'DataCloneError']) {
    for (const handle of [false, true]) {
        test(`playlist writes retry only clone failures with handles: ${name}, handle=${handle}`, async t => {
            t.mock.timers.enable({ apis: ['setTimeout'] });
            const host = createHost().host, values = [];
            const queue = withBaseQueue({ playlist: [{ name: 'local.wav', fileHandle: handle ? {} : null }], curIdx: 0 });
            for (const [key, value] of Object.entries({ window: host, localStorage: host.localStorage })) {
                const previous = Object.getOwnPropertyDescriptor(globalThis, key);
                Object.defineProperty(globalThis, key, { configurable: true, value });
                t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
            }
            let attempts = 0;
            const persistence = createPersistence({ queue, onlinePlaylist: { getPersistedQueueSource: () => null }, debug: { log() {} },
                cache: { IDB_PLAYER_STORE: 'player-state', openIdb: async () => ({ transaction() {
                    attempts++;
                    const tx = { abort() {}, objectStore: () => ({ put(state) {
                        if (state.tracks) {
                            values.push(state);
                            if (attempts === 1) throw new DOMException('synthetic write failure', name);
                        }
                        queueMicrotask(() => tx.oncomplete());
                    } }) };
                    return tx;
                } }) } });
            persistence.schedulePlaylistStateSave(true); t.mock.timers.tick(120);
            for (let i = 0; i < 8; i++) await Promise.resolve();
            const shouldRetry = name === 'DataCloneError' && handle;
            assert.equal(attempts, shouldRetry ? 2 : 1);
            assert.ok(host.localStorage.getItem('aurora_playlist_snapshot_v3'));
            if (shouldRetry) assert.equal(values[1].tracks[0].handle, undefined);
            assert.equal(queue.playlist[0].fileHandle !== null, handle);
        });
    }
}
