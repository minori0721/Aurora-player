import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoop} from '../src/audio/loop.js';
import {FakeElement} from './helpers/host.mjs';

function fixture() {
    globalThis.document = {getElementById: () => new FakeElement()};
    const el = Object.fromEntries(['loopStart','loopEnd','loopEnable','loopMsg','baseRateInput','markerA','markerB'].map(name => [name,new FakeElement(name)]));
    const dispatch = el.loopEnable.dispatchEvent.bind(el.loopEnable);
    el.loopEnable.dispatchEvent = event => dispatch({type:event.type,target:el.loopEnable});
    el.baseRateInput.value = '44100';
    const queue = {playlist:[{name:'first'},{name:'second'}],curIdx:0};
    let position = 0, loop;
    const playback = {_currentPlayActionToken:1,audioBuffer:{duration:30},playbackState:{duration:30,isPlaying:false},
        getCurrentTime:() => position,getActiveCustomLoop:() => loop.loopState.active ? loop.loopState : null};
    loop = createLoop({dom:{el},queue,playback,prefetch:{prefetchUpcomingNeteaseDetails(){},prewarmNextNeteaseSongUrl(){}},debug:{log(){}},lyrics:{},playlistView:{refreshPlaylistItem(){}}});
    loop.initialize();
    const enable = checked => {el.loopEnable.checked=checked;el.loopEnable.dispatchEvent({type:'change',target:el.loopEnable});};
    const edit = (point,value) => {const field=point==='start'?el.loopStart:el.loopEnd;field.value=value;field.dispatchEvent({type:'input',target:field});};
    return {loop,el,queue,playback,enable,edit,setPosition:value=>{position=value;}};
}
const start = 4 + 18 / 44100, end = 12 + 39 / 44100;

test('loop toggling retains exact endpoints while displaying milliseconds', () => {
    const f=fixture();f.loop.applyLoop(start,end);
    assert.equal(f.el.loopStart.value,'4.000');assert.equal(f.el.loopEnd.value,'12.001');
    for(let i=0;i<10;i++){f.enable(false);f.enable(true);}
    assert.equal(f.loop.loopState.start,start);assert.equal(f.loop.loopState.end,end);
    assert.equal(Math.round(f.loop.loopState.start*44100),176418);
    assert.equal(Math.round(f.loop.loopState.end*44100),529239);
});

test('editing one loop endpoint preserves the untouched endpoint precision', () => {
    const f=fixture();f.loop.applyLoop(start,end);f.enable(false);
    f.edit('start','6.123456');f.enable(true);
    assert.equal(f.loop.loopState.start,6.123456);assert.equal(f.loop.loopState.end,end);
    f.edit('end','13.987654');f.enable(true);
    assert.equal(f.loop.loopState.start,6.123456);assert.equal(f.loop.loopState.end,13.987654);
});

test('explicitly editing back to the displayed number is treated as a manual value', () => {
    const f=fixture();f.loop.applyLoop(start,end);f.enable(false);
    f.edit('start','4.000');f.enable(true);
    assert.equal(f.loop.loopState.start,4);assert.equal(f.loop.loopState.end,end);
});

test('programmatic loop field changes and capture buttons cannot reuse an old value', () => {
    const f=fixture();f.loop.applyLoop(start,end);
    f.el.loopStart.value='5.25';f.enable(true);
    assert.equal(f.loop.loopState.start,5.25);assert.equal(f.loop.loopState.end,end);
    f.setPosition(12.001);f.loop.setLoopPoint('b');
    assert.equal(f.loop.loopState.start,5.25);assert.equal(f.loop.loopState.end,12.001);
});

test('track reset and invalid loops discard cached precision', () => {
    const f=fixture();f.loop.applyLoop(start,end);
    f.queue.curIdx=1;f.playback._currentPlayActionToken++;f.loop.resetLoopUI();f.enable(true);
    assert.equal(f.loop.loopState.start,4);assert.equal(f.loop.loopState.end,12.001);
    f.loop.applyLoop(start,end);assert.equal(f.loop.applyLoop(-1,end),false);f.enable(true);
    assert.equal(f.loop.loopState.start,4);assert.equal(f.loop.loopState.end,12.001);
});

test('SLI sample positions remain unchanged after a loop toggle', () => {
    const f=fixture(),track=f.queue.playlist[0];
    track.sliStatus='valid';track.sliData={status:'valid',toSamples:176418,fromSamples:529239};
    assert.equal(f.loop.applySliLoopForTrack(track),true);
    f.enable(false);f.enable(true);
    assert.equal(Math.round(f.loop.loopState.start*44100),176418);
    assert.equal(Math.round(f.loop.loopState.end*44100),529239);
});

test('current-track loop configuration includes disabled precise/manual ranges but ignores stale inputs', () => {
    const f = fixture();
    assert.equal(f.loop.getLoopConfiguration(), null);
    f.loop.applyLoop(start, end);
    f.enable(false);
    assert.deepEqual(f.loop.getLoopConfiguration(), { active: false, start, end, source: 'manual' });
    f.queue.curIdx = 1; f.playback._currentPlayActionToken++; f.loop.resetLoopUI();
    assert.equal(f.loop.getLoopConfiguration(), null);
    f.edit('start', '2'); f.edit('end', '7');
    assert.deepEqual(f.loop.getLoopConfiguration(), { active: false, start: 2, end: 7, source: 'manual' });
});

test('a valid current SLI is protected before activation and invalid SLI is not', () => {
    const f = fixture(), track = f.queue.playlist[0];
    track.sliStatus = 'valid'; track.sliData = { status: 'valid', toSamples: 44100, fromSamples: 441000 };
    assert.deepEqual(f.loop.getLoopConfiguration(), { active: false, start: 1, end: 10, source: 'sli' });
    track.sliData.fromSamples = 44100 * 40;
    assert.equal(f.loop.getLoopConfiguration(), null);
});

test('restoring a loop keeps its source, activation and exact sample positions', () => {
    const f = fixture();
    f.loop.applyLoop(start, end, 'sli');
    const original = f.loop.getLoopConfiguration();
    f.loop.applyLoop(2, 8, 'analysis');
    assert.equal(f.loop.restoreLoopConfiguration(original), true);
    assert.deepEqual(f.loop.getLoopConfiguration(), original);
    f.enable(false);
    const disabled = f.loop.getLoopConfiguration();
    f.loop.applyLoop(2, 8, 'analysis');
    assert.equal(f.loop.restoreLoopConfiguration(disabled), true);
    assert.deepEqual(f.loop.getLoopConfiguration(), disabled);
    assert.equal(f.loop.loopState.active, false);
    assert.equal(f.loop.restoreLoopConfiguration(null), true);
    assert.equal(f.loop.getLoopConfiguration(), null);
    assert.equal(f.el.loopStart.value, '0.000'); assert.equal(f.el.loopEnd.value, '0.000');
});

test('an invalid restoration cannot disable a valid current loop', () => {
    const f = fixture(); f.loop.applyLoop(start, end);
    const original = f.loop.getLoopConfiguration();
    assert.equal(f.loop.restoreLoopConfiguration({ active: true, start: 5, end: 50 }), false);
    assert.deepEqual(f.loop.getLoopConfiguration(), original);
});
