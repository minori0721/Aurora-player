import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlaylistReader, normalizePlaylistPrivacy, mergePlaylistIds, planPlaylistSync } from '../src/netease/playlist-access.js';

test('playlist source stores only a guest marker or a positive account ID', () => {
    assert.equal(normalizePlaylistReader('guest'), 'guest');
    assert.equal(normalizePlaylistReader('123'), 123);
    for (const value of [null, undefined, '', 0, -1, 1.5, Infinity, true, false, [], [123], {}, 'MUSIC_U=synthetic']) {
        assert.equal(normalizePlaylistReader(value), null);
    }
});

test('only known public/private values classify playlist access', () => {
    for (const value of [0, '0']) assert.equal(normalizePlaylistPrivacy(value), 0);
    for (const value of [10, '10']) assert.equal(normalizePlaylistPrivacy(value), 10);
    for (const value of [false, null, undefined, '', 1, 'private']) assert.equal(normalizePlaylistPrivacy(value), null);
});

test('complete snapshots replace members and order independently of the previous identity', () => {
    for (const [previous, reader] of [['guest', 'guest'], [123, 123], [123, 'guest'], [123, 456], ['guest', 123], [null, 123]]) {
        const remote = [3, 4, 2], plan = planPlaylistSync([1, 2, 3], remote, reader, reader);
        const changed = planPlaylistSync([1, 2, 3], remote, previous, reader);
        assert.equal(plan.ids, remote); assert.equal(plan.replace, true); assert.equal(plan.readAs, reader);
        assert.deepEqual(changed, plan);
    }
});

test('partial snapshots keep remote order and retain missing local runs before their next neighbour', () => {
    for (const [previous, reader] of [[123, 'guest'], [123, 456], ['guest', 123], [123, null], [null, null]]) {
        const result = planPlaylistSync([1, 2, 3], [4, 1, 3], previous, reader, { complete: false });
        assert.deepEqual(result.ids, [4, 1, 2, 3]); assert.equal(result.replace, false);
        assert.equal(result.readAs, reader ?? previous);
    }
});

test('protected merges preserve duplicate occurrences without growing them on each refresh', () => {
    const first = mergePlaylistIds([1, 1, 2], [2, 1, 3, 3]);
    assert.deepEqual(first.ids, [2, 1, 1, 3, 3]); assert.equal(first.hasMissing, true);
    assert.deepEqual(mergePlaylistIds(first.ids, [2, 1, 3, 3]).ids, first.ids);
});

test('legacy snapshots establish a new basis even when remote members have been removed', () => {
    assert.deepEqual(planPlaylistSync([1, 2], [2, 3, 1], null, 'guest'), { ids: [2, 3, 1], replace: true, readAs: 'guest' });
    const missing = planPlaylistSync([1, 1, 2], [1, 2], null, 123);
    assert.equal(missing.replace, true); assert.equal(missing.readAs, 123);
    assert.deepEqual(missing.ids, [1, 2]);
});

test('complete empty snapshots can clear account lists; partial empty snapshots preserve them', () => {
    assert.deepEqual(planPlaylistSync([1, 2], [], 123, 'guest').ids, []);
    assert.deepEqual(planPlaylistSync([1, 2], [], null, 'guest').ids, []);
    assert.deepEqual(planPlaylistSync([1, 2], [], 123, 'guest', { complete: false }).ids, [1, 2]);
    assert.deepEqual(planPlaylistSync([1, 2], [], 'guest', 'guest').ids, []);
    assert.equal(planPlaylistSync([], [], null, 'guest').readAs, 'guest');
});

test('partial merge handles prepend, middle insertion, reorder and disjoint snapshots deterministically', () => {
    for (const [local, remote, expected] of [
        [[1, 2, 3], [4, 1, 3], [4, 1, 2, 3]],
        [[1, 2, 3], [1, 4, 3], [1, 4, 2, 3]],
        [[1, 2, 3], [3, 4, 2], [3, 4, 1, 2]],
        [[1, 2, 3], [4, 5], [4, 5, 1, 2, 3]],
        [[], [4, 5], [4, 5]], [[1, 2], [], [1, 2]]
    ]) {
        assert.deepEqual(mergePlaylistIds(local, remote).ids, expected);
        assert.deepEqual(mergePlaylistIds(expected, remote).ids, expected);
    }
});

test('partial merges are idempotent, retain every occurrence and embed the remote order across generated inputs', () => {
    let seed = 12345;
    const random = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
    const counts = ids => {
        const result = new Map();
        for (const id of ids) result.set(id, (result.get(id) || 0) + 1);
        return result;
    };
    for (let round = 0; round < 1000; round++) {
        const local = Array.from({ length: random(40) }, () => 1 + random(12));
        const remote = Array.from({ length: random(40) }, () => 1 + random(12));
        const { ids } = mergePlaylistIds(local, remote);
        assert.deepEqual(mergePlaylistIds(ids, remote).ids, ids, JSON.stringify({ local, remote }));
        const actual = counts(ids), left = counts(local), right = counts(remote);
        for (const id of new Set([...local, ...remote])) assert.equal(actual.get(id), Math.max(left.get(id) || 0, right.get(id) || 0));
        let position = 0;
        for (const id of ids) if (id === remote[position]) position++;
        assert.equal(position, remote.length);
    }
});
