import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackPlan } from '../src/playlist/plan.js';
import { createQueue } from '../src/playlist/queue.js';
import { normalizePersistedPlaylistState, createCompactPlaylistState } from '../src/storage/playlist-schema.js';
import { FakeElement } from './helpers/host.mjs';

const track = id => ({ netease: true, songId: id, name: `Song ${id}`, songData: { id, name: `Song ${id}`, ar: [], al: {} } });
function plan() { const state = new PlaybackPlan(); state.reset([track(1), track(2), track(3)]); state.select(0); return state; }
const advance = state => state.select(state.nextIndex());

test('temporary play interrupts only the current song and returns to the next base song', () => {
    const state = plan(), base = state.base, items = state.items;
    state.playNow(track(10));
    assert.equal(state.current.songId, 10); assert.equal(state.base, base); assert.equal(state.items, items);
    assert.equal(state.baseIndex, 0); advance(state);
    assert.equal(state.current.songId, 2); assert.equal(state.isTemporary, false);
    assert.deepEqual(state.base.map(item => item.songId), [1, 2, 3]);
});

test('album append is FIFO within manual queue; play-next inserts a whole block at the front', () => {
    const state = plan(); state.playNow(track(10));
    state.enqueue([track(20), track(21), track(22)]);
    state.enqueue([track(30), track(31)], true);
    const actual = [];
    for (let i = 0; i < 6; i++) { advance(state); actual.push(state.current.songId); }
    assert.deepEqual(actual, [30, 31, 20, 21, 22, 2]);
});

test('previous follows actual playback history, then next follows forward history', () => {
    const state = plan(); state.playNow(track(10)); state.enqueue([track(20)]); advance(state); advance(state);
    assert.equal(state.current.songId, 2);
    state.previousIndex(); assert.equal(state.current.songId, 20);
    state.previousIndex(); assert.equal(state.current.songId, 10);
    advance(state); assert.equal(state.current.songId, 20);
    advance(state); assert.equal(state.current.songId, 2);
});

test('explicit base selection preserves pending manual entries without duplicating the base', () => {
    const state = plan(); state.enqueue([track(10)]); state.select(2);
    advance(state); assert.equal(state.current.songId, 10);
    advance(state); assert.equal(state.current.songId, 1);
    assert.equal(state.base.length, 3);
});

test('random base selection honors its locked target and never shuffles an enqueued album', () => {
    const state = plan(); state.enqueue([track(20), track(21)]);
    assert.equal(state.items[state.nextIndex(1, 2)].songId, 20); advance(state);
    assert.equal(state.items[state.nextIndex(1, 2)].songId, 21); advance(state);
    assert.equal(state.nextIndex(1, 2), 2);
    assert.equal(state.nextIndex(1, 0, () => 0), 1);
});

test('empty base and one temporary song stop when manual playback is exhausted', () => {
    const state = new PlaybackPlan(); state.playNow(track(10));
    assert.equal(state.baseIndex, -1); assert.equal(state.nextIndex(), null);
    state.enqueue([track(11)]); advance(state);
    assert.equal(state.current.songId, 11); assert.equal(state.nextIndex(), null);
});

test('clearing pending leaves active audio identity and the base cursor unchanged', () => {
    const state = plan(); state.playNow(track(10)); state.enqueue([track(20), track(21)]);
    const current = state.current; state.clearPending();
    assert.equal(state.current, current); assert.equal(state.baseIndex, 0);
    assert.equal(state.pending.length, 0); assert.equal(state.items[state.nextIndex()].songId, 2);
});

test('base appends, reorders and metadata changes preserve active manual identity', () => {
    const state = plan(); state.playNow(track(10)); const current = state.current;
    state.base.push(track(4)); state.reconcile();
    assert.equal(state.current, current); assert.equal(state.index, 4);
    state.base.reverse(); state.reconcile(3);
    assert.equal(state.current, current); assert.equal(state.baseIndex, 3);
    assert.equal(state.items[state.nextIndex()].songId, 4);
});

test('base reconciliation discards removed forward history instead of selecting an invalid index', () => {
    const state = plan(); state.select(1); state.previousIndex();
    assert.equal(state.forward.length, 1);
    state.base.splice(1, 1); state.reconcile(0);
    assert.equal(state.forward.length, 0);
    advance(state); assert.equal(state.current.songId, 3);
});

test('history retention is bounded and never retains decoded audio', () => {
    const state = plan();
    for (let i = 10; i < 200; i++) state.playNow(track(i));
    assert.equal(state.history.length, 32); assert.equal(state.manual.length, 33);
    assert.equal(state.items.length, state.base.length + 33);
    assert.equal(state.current.songId, 199);
});

test('large base selections do not copy or enumerate the base on ordinary next-song steps', () => {
    const state = new PlaybackPlan(), base = Array.from({ length: 50000 }, (_, i) => track(i + 1));
    state.reset(base); const items = state.items;
    base[Symbol.iterator] = () => { throw new Error('base iteration during selection'); };
    for (let i = 0; i < 100; i++) state.select(i);
    assert.equal(state.items, items); assert.equal(state.current.songId, 100);
});

test('manual restore keeps current and pending entries separate from the base', () => {
    const state = plan(), current = track(10), pending = [track(20), track(21)];
    state.restoreManual({ current, pending });
    assert.equal(state.current, current); assert.equal(state.baseIndex, 0);
    advance(state); assert.equal(state.current.songId, 20);
    advance(state); advance(state); assert.equal(state.current.songId, 2);
});

test('manual-only snapshots normalize, compact, and reject invalid manual entries', () => {
    const stored = id => ({ type: 'netease', id, title: `Song ${id}`, artists: [], album: {} });
    const value = normalizePersistedPlaylistState({ schema: 3, revision: 1, tracks: [],
        manual: { current: stored(10), pending: [stored(20), stored(-1), { type: 'local', id: 90 }] } });
    assert.equal(value.manual.current.id, 10); assert.deepEqual(value.manual.pending.map(item => item.id), [20]);
    assert.deepEqual(createCompactPlaylistState(value).manual, value.manual);
});

function queueFixture(t) {
    const elements = new Map(['prev-btn', 'next-btn', 'icon-list-loop', 'icon-random', 'icon-single'].map(id => [id, new FakeElement()]));
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: id => elements.get(id) } });
    t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
    let queue, token = 0;
    const played = [], stopped = [], feedbackClears = [], modeButton = new FakeElement();
    const playback = { playbackWantsPlay: true, transportVersion: 0, playbackState: { status: 'playing', isPlaying: true },
        beginPlaybackAction: () => ++token, getPlaybackLoad: () => ({}), releasePlaybackLoad() {},
        stopAudio: value => stopped.push(value), resetPlaybackTimeline() {}, unlockAudioContext: async () => true,
        isPlaybackActionCurrent: (value, item) => value === token && (!item || queue.playlist[queue.curIdx] === item),
        setPlaybackStatus: value => { playback.playbackState.status = value; }, getActiveCustomLoop: () => null, getCurrentTime: () => 0,
        startAudio: () => played.push('replay') };
    queue = createQueue({ playback, content: { setMainMusicEntityLinks() {}, updateMusicMiniPlayer() {},
        clearMusicQueueFeedback() { feedbackClears.push(true); } },
        covers: { setMainCover() {} }, debug: { log() {} }, dom: { el: { title: {}, img: { style: {} }, modeBtn: modeButton } },
        onlinePlaylist: { resolveSyncedSelection: index => index, finishSyncedEmptyQueue: () => false }, persistence: { schedulePlaylistStateSave() {}, schedulePlaylistTrackSave() {} },
        playlistView: { renderPlaylist() {}, ensurePlaylistRenderedAndActive() {} },
        prefetch: { hasLockedNextPreloadTarget: () => false, nextPreloadKind: 'none', nextPreloadStatus: 'idle',
            prefetchUpcomingNeteaseDetails() {}, cancelNextPreload() {}, prewarmNextNeteaseSongUrl() {}, retargetNextPreload() {} },
        onlinePlayback: { playNeteaseSong: async song => played.push(song.id) }
    });
    queue.playlist = [track(1), track(2), track(3)]; queue.curIdx = 0; queue.initialize();
    return { queue, played, stopped, feedbackClears, elements, playback, modeButton };
}

test('only base structure mutations change the base revision, not temporary history or selection', () => {
    const model = new PlaybackPlan(); model.reset([track(1), track(2)]);
    const initial = model.baseStructureRevision, reference = model.base;
    model.select(0); model.playNow(track(90)); model.enqueue([track(91)]); model.clearPending();
    assert.equal(model.baseStructureRevision, initial);
    model.appendBaseTracks([track(3)]); assert.equal(model.baseStructureRevision, initial + 1);
    model.sortBaseTracks((a, b) => b.songId - a.songId); assert.equal(model.baseStructureRevision, initial + 2);
    model.removeBaseTrack(0); assert.equal(model.baseStructureRevision, initial + 3);
    model.replaceBaseTracks([track(5)]); assert.equal(model.baseStructureRevision, initial + 4);
    assert.equal(model.base, reference);
});

test('integrated queue plays single -> album block -> original next song', async t => {
    const f = queueFixture(t), q = f.queue;
    await q.playTemporaryNow(track(10)); q.enqueueTemporary([track(20), track(21)]);
    for (let i = 0; i < 3; i++) { q.handleNext({}); await new Promise(resolve => setImmediate(resolve)); }
    assert.deepEqual(f.played, [10, 20, 21, 2]); assert.equal(q.baseCurIdx, 1);
    assert.deepEqual(q.basePlaylist.map(item => item.songId), [1, 2, 3]);
});

test('single-track loop replays actual temporary audio and does not consume pending entries', async t => {
    const f = queueFixture(t), q = f.queue;
    await q.playTemporaryNow(track(10)); q.enqueueTemporary([track(20)]);
    await f.modeButton.onclick(); await f.modeButton.onclick();
    assert.equal(q.playMode, 2);
    f.playback.audioBuffer = {};
    q.handleNext();
    assert.deepEqual(f.played, [10, 'replay']);
    assert.deepEqual(q.manualState.pending.map(item => item.songId), [20]);
    q.handleNext({}); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.played.at(-1), 20);
});

test('clearing temporary pending never stops current audio or changes the active token', async t => {
    const f = queueFixture(t), q = f.queue;
    await q.playTemporaryNow(track(10)); q.enqueueTemporary([track(20)]);
    const stops = f.stopped.length, current = q.playlist[q.curIdx], clears = f.feedbackClears.length;
    q.clearTemporaryQueue();
    assert.equal(f.feedbackClears.length, clears + 1);
    assert.equal(f.stopped.length, stops); assert.equal(q.playlist[q.curIdx], current);
    assert.equal(q.manualState.pending.length, 0);
});

test('replacing the base list clears any feedback from the previous queue', t => {
    const f = queueFixture(t), clears = f.feedbackClears.length;
    f.queue.playlist = [track(50)];
    assert.equal(f.feedbackClears.length, clears + 1);
    assert.equal(f.queue.basePlaylist[0].songId, 50);
});

function replacementDialog(fixture) {
    const dialog = Object.assign(new EventTarget(), { returnValue: '', opens: 0,
        showModal() { this.opens++; },
        close(value = '') { this.returnValue = value; this.dispatchEvent(new Event('close')); }
    });
    fixture.elements.set('queue-replace-dialog', dialog);
    return dialog;
}

test('replacement cancellation preserves pending entries and accepting does not itself clear them', async t => {
    const f = queueFixture(t), dialog = replacementDialog(f), q = f.queue;
    q.enqueueTemporary([track(10)]);
    const cancelled = q.confirmReplaceQueue(); dialog.close();
    assert.equal(await cancelled, false); assert.equal(q.manualState.pending.length, 1);
    const accepted = q.confirmReplaceQueue(); dialog.close('replace');
    assert.equal(await accepted, true); assert.equal(q.manualState.pending.length, 1);
});

test('one shared replacement prompt allows only the latest replacement request to proceed', async t => {
    const f = queueFixture(t), dialog = replacementDialog(f), q = f.queue;
    q.enqueueTemporary([track(10)]);
    const first = q.confirmReplaceQueue(), second = q.confirmReplaceQueue();
    assert.equal(dialog.opens, 1); dialog.close('replace');
    assert.deepEqual(await Promise.all([first, second]), [false, true]);
});

test('replacement approval cannot replace a different queue created while the prompt was open', async t => {
    const f = queueFixture(t), dialog = replacementDialog(f), q = f.queue;
    q.enqueueTemporary([track(10)]);
    const pending = q.confirmReplaceQueue(); q.playlist = [track(99)]; dialog.close('replace');
    assert.equal(await pending, false); assert.equal(q.basePlaylist[0].songId, 99);
});
