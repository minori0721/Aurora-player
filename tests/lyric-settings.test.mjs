import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyrics } from '../src/lyrics/controller.js';
import { createHost, FakeElement } from './helpers/host.mjs';

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

class LyricElement extends FakeElement {
    appendChild(child) {
        if (child.fragment) { for (const node of [...child.children]) this.appendChild(node); child.children = []; }
        else { child.parentElement = this; this.children.push(child); }
        return child;
    }
    insertBefore(child, reference) {
        const index = this.children.indexOf(reference);
        if (index < 0) return this.appendChild(child);
        child.parentElement = this;
        this.children.splice(index, 0, child);
        return child;
    }
    remove() { this.parentElement?.removeChild(this); super.remove(); }
}

function fixture(t, preference = 'original') {
    const { host } = createHost(), previous = new Map();
    host.document.createElement = () => new LyricElement();
    host.document.createTextNode = text => Object.assign(new LyricElement(), { textContent: text });
    host.localStorage.setItem('lyric_mode', preference);
    for (const [key, value] of Object.entries({ document: host.document, localStorage: host.localStorage, requestAnimationFrame: host.requestAnimationFrame })) {
        previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    t.after(() => { for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
    } });
    const box = new LyricElement(), artist = new LyricElement(), cloud = new FakeElement(), desktop = new FakeElement();
    const inputs = ['original', 'both', 'roma'].map(value => Object.assign(new FakeElement(), { value }));
    const toggle = Object.assign(new FakeElement(), { textContent: '词译音' });
    const symbol = Object.assign(new FakeElement(), { className: 'lyric-mode-symbol' });
    const icon = Object.assign(new FakeElement(), { tagName: 'svg' });
    symbol.appendChild(icon); toggle.appendChild(symbol);
    const requests = [], pending = [];
    const lyrics = createLyrics({
        dom: { el: { lyricBox: box, artist, title: new FakeElement() }, cloudLyricsSwitches: [cloud, desktop], lyricModeInputs: inputs, lyricToggleBtn: toggle },
        playback: { getCurrentTime: () => 0, playbackState: { duration: 120, isPlaying: false } }, metadata: {}, debug: { log() {} },
        api: { buildApiUrl: path => `https://fixture.invalid${path}` },
        cache: { cachedFetchJson(url, options) { requests.push({ url, options }); return new Promise(resolve => pending.push(resolve)); } }
    });
    t.after(() => lyrics.cancelLocalLyricSession());
    return { lyrics, box, artist, cloud, desktop, inputs, toggle, symbol, icon, host, requests, pending };
}

const original = '[00:00.000]original\n[00:02.000]next';
const translated = '[00:00.000]translation\n[00:02.000]next translation';
const roman = '[00:00.000]roman\n[00:02.000]next roman';

test('quality supplementation reuses badges and does not accumulate whitespace or replace artist links', t => {
    const f = fixture(t), link = new LyricElement();
    link.className = 'music-link'; link.textContent = 'Example';
    f.artist.appendChild(link);
    f.lyrics.setArtistTag('source', 'MP3');
    const source = f.artist.querySelector('.tag-source'), quality = f.artist.querySelector('.tag-quality');
    for (let i = 0; i < 100; i++) f.lyrics.setArtistTag('source', 'MP3 320kbps');
    assert.deepEqual(f.artist.children, [link, source, quality]);
    assert.equal(quality.textContent, 'MP3 320kbps');
    assert.equal(quality.title, 'MP3 320kbps');
    assert.equal(source.title, 'source');
    f.lyrics.setArtistTag('', 'MP3 320kbps');
    assert.deepEqual(f.artist.children, [link, quality]);
    f.lyrics.setArtistTag('new source', 'FLAC 192kHz/24bit');
    assert.deepEqual(f.artist.children.map(node => node.className), ['music-link', 'tag-source', 'tag-quality']);
    assert.equal(f.artist.children[2], quality);
    assert.equal(quality.title, 'FLAC 192kHz/24bit');
    f.lyrics.setArtistTag('', '');
    assert.deepEqual(f.artist.children, [link]);
});

test('replacing artist contents recreates only the new track badges and accepts empty values', t => {
    const f = fixture(t);
    f.lyrics.setArtistTag(null, undefined);
    assert.equal(f.artist.children.length, 0);
    f.lyrics.setArtistTag('first source', 'MP3');
    const previous = f.artist.querySelector('.tag-quality');
    f.artist.replaceChildren();
    f.lyrics.setArtistTag('second source', 'FLAC 44.1kHz/16bit');
    assert.equal(f.artist.children.length, 2);
    assert.notEqual(f.artist.querySelector('.tag-quality'), previous);
    assert.equal(f.artist.querySelector('.tag-quality').textContent, 'FLAC 44.1kHz/16bit');
});

test('empty lyrics disable every mode and unavailable selections cannot change the preference', t => {
    const f = fixture(t, 'roma');
    f.lyrics.resetTrackLyrics();
    assert.deepEqual(f.inputs.map(input => [input.checked, input.disabled]), [[false, true], [false, true], [false, true]]);
    for (const mode of ['original', 'both', 'roma']) assert.equal(f.lyrics.setLyricDisplayMode(mode), false);
    assert.equal(f.host.localStorage.getItem('lyric_mode'), 'roma');
    f.lyrics.parseAndRenderLyrics(original, 'test');
    f.inputs[1].checked = true;
    assert.equal(f.lyrics.setLyricDisplayMode('both'), false);
    assert.deepEqual(f.inputs.map(input => [input.checked, input.disabled]), [[true, false], [false, true], [false, true]]);
    assert.equal(f.lyrics.lyricDisplayMode, 'roma');
    assert.equal(f.box.querySelector('.lyric-translation'), null);
});

test('direct mode selection replaces only subtitles, preserving original and timed-word nodes', t => {
    const f = fixture(t);
    f.lyrics.parseAndRenderLyrics(original, 'test', translated, roman,
        [{ t: 0, words: [{ txt: 'original', start: 0, dur: 1000 }] }]);
    const first = f.box.children[0], word = first.querySelector('.yrc-char');
    assert.equal(f.lyrics.setLyricDisplayMode('both'), true);
    assert.equal(first.querySelector('.lyric-translation').textContent, 'translation');
    assert.equal(f.lyrics.setLyricDisplayMode('roma'), true);
    assert.equal(first.querySelectorAll('.lyric-translation').length, 1);
    assert.equal(first.querySelector('.lyric-translation').textContent, 'roman');
    assert.equal(first.querySelector('.yrc-char'), word);
    assert.equal(f.box.children[0], first);
    assert.deepEqual(f.inputs.map(input => [input.checked, input.disabled]), [[false, false], [false, false], [true, false]]);
    assert.equal(f.host.localStorage.getItem('lyric_mode'), 'roma');
    assert.equal(f.lyrics.setLyricDisplayMode('original'), true);
    assert.equal(first.querySelector('.lyric-translation'), null);
    assert.equal(first.querySelector('.yrc-char'), word);
});

test('missing extra text falls back to original without overwriting the preferred mode', t => {
    const f = fixture(t, 'roma');
    f.lyrics.parseAndRenderLyrics(original, 'test', translated, roman);
    assert.equal(f.lyrics.effectiveLyricDisplayMode, 'roma');
    f.lyrics.resetTrackLyrics();
    f.lyrics.parseAndRenderLyrics(original, 'test');
    assert.equal(f.lyrics.effectiveLyricDisplayMode, 'original');
    assert.equal(f.lyrics.lyricDisplayMode, 'roma');
    assert.deepEqual(f.inputs.map(input => [input.checked, input.disabled]), [[true, false], [false, true], [false, true]]);
    assert.equal(f.lyrics.setLyricDisplayMode('both'), false);
    assert.equal(f.lyrics.setLyricDisplayMode('invalid'), false);
    assert.equal(f.host.localStorage.getItem('lyric_mode'), 'roma');
    f.lyrics.parseAndRenderLyrics(original, 'test', '', roman);
    assert.equal(f.inputs[2].checked, true);
    assert.equal(f.box.querySelector('.lyric-translation').textContent, 'roman');
});

test('plain lyrics use the same selection and failed preference storage does not block rendering', t => {
    const f = fixture(t, 'invalid');
    f.lyrics.parseAndRenderLyrics('plain original', 'test', 'plain translation', 'plain roman');
    f.host.localStorage.setItem = () => { throw new Error('storage unavailable'); };
    assert.equal(f.lyrics.setLyricDisplayMode('both'), true);
    assert.match(f.box.innerHTML, /plain original/);
    assert.match(f.box.innerHTML, /plain translation/);
    assert.equal(f.lyrics.setLyricDisplayMode('roma'), true);
    assert.match(f.box.innerHTML, /plain roman/);
    assert.doesNotMatch(f.box.innerHTML, /plain translation/);
});

test('cloud switches sync both entry points and turning off invalidates pending matching', async t => {
    const f = fixture(t), session = f.lyrics.createLocalLyricSession({}, () => true);
    f.lyrics.applyLocalLyricMetadata(session, { title: 'fixture', artist: 'Example' }, 'local');
    assert.equal(f.requests.length, 0);
    f.lyrics.neteaseSearchEnabled = true;
    assert.equal(f.cloud.checked, true);
    assert.equal(f.desktop.checked, true);
    assert.equal(f.requests.length, 1);
    const signal = f.requests[0].options.signal;
    f.lyrics.neteaseSearchEnabled = false;
    assert.equal(signal.aborted, true);
    assert.equal(f.cloud.checked, false);
    assert.equal(f.desktop.checked, false);
    f.pending[0]({ code: 200, result: { songs: [{ id: 1, name: 'fixture', ar: [{ name: 'Example' }] }] } });
    await settle();
    assert.equal(f.lyrics.originalLyricsArr.length, 0);
    f.lyrics.neteaseSearchEnabled = true;
    assert.equal(f.requests.length, 2);
    f.lyrics.neteaseSearchEnabled = true;
    assert.equal(f.requests.length, 2);
});

test('desktop cycle button and mobile modes mirror selection, missing text and track reset', t => {
    const f = fixture(t, 'roma');
    f.lyrics.resetTrackLyrics();
    assert.equal(f.toggle.disabled, true); assert.equal(f.toggle.dataset.lyricMode, 'original');
    assert.ok(f.inputs.every(input => input.disabled));
    f.lyrics.parseAndRenderLyrics(original, 'test', translated, roman);
    assert.equal(f.toggle.dataset.lyricMode, 'roma'); assert.equal(f.inputs[2].checked, true);
    f.lyrics.setLyricDisplayMode('both');
    assert.equal(f.toggle.dataset.lyricMode, 'both'); assert.equal(f.inputs[1].checked, true);
    f.lyrics.resetTrackLyrics();
    f.lyrics.parseAndRenderLyrics(original, 'test', '', roman);
    assert.equal(f.inputs[1].disabled, true); assert.equal(f.inputs[0].checked, true);
    assert.equal(f.toggle.dataset.lyricMode, 'original'); assert.equal(f.toggle.disabled, false);
    assert.equal(f.lyrics.lyricDisplayMode, 'both');
    assert.equal(f.requests.length, 0);
});

test('desktop cycles through word, translation and roman using the existing subtitle update path', t => {
    const f = fixture(t);
    f.lyrics.parseAndRenderLyrics(original, 'test', translated, roman,
        [{ t: 0, words: [{ txt: 'original', start: 0, dur: 1000 }] }]);
    const first = f.box.children[0], word = first.querySelector('.yrc-char');
    for (const mode of ['both', 'roma', 'original']) {
        assert.equal(f.lyrics.cycleLyricDisplayMode(), true);
        assert.equal(f.lyrics.effectiveLyricDisplayMode, mode);
        assert.equal(f.toggle.dataset.lyricMode, mode); assert.match(f.toggle.getAttribute('aria-label'), /点击切换/);
        assert.equal(f.inputs.find(input => input.checked).value, mode);
        assert.equal(f.toggle.textContent, '词译音');
        assert.equal(f.toggle.children[0], f.symbol); assert.equal(f.symbol.children[0], f.icon);
        assert.equal(f.box.children[0], first); assert.equal(first.querySelector('.yrc-char'), word);
    }
    assert.equal(f.requests.length, 0);
});

test('desktop cycles skip missing extras and cannot change preferences with no alternative text', t => {
    const f = fixture(t, 'roma');
    f.lyrics.resetTrackLyrics();
    assert.equal(f.lyrics.cycleLyricDisplayMode(), false);
    assert.equal(f.host.localStorage.getItem('lyric_mode'), 'roma');
    f.lyrics.parseAndRenderLyrics(original, 'test');
    assert.equal(f.toggle.disabled, true); assert.equal(f.lyrics.cycleLyricDisplayMode(), false);
    assert.equal(f.lyrics.lyricDisplayMode, 'roma');
    f.lyrics.parseAndRenderLyrics(original, 'test', translated);
    assert.equal(f.toggle.dataset.lyricMode, 'original'); f.lyrics.cycleLyricDisplayMode();
    assert.equal(f.toggle.dataset.lyricMode, 'both'); f.lyrics.cycleLyricDisplayMode();
    assert.equal(f.toggle.dataset.lyricMode, 'original');
    f.lyrics.parseAndRenderLyrics(original, 'test', '', roman);
    f.lyrics.cycleLyricDisplayMode(); assert.equal(f.toggle.dataset.lyricMode, 'roma');
    f.lyrics.cycleLyricDisplayMode(); assert.equal(f.toggle.dataset.lyricMode, 'original');
    assert.equal(f.requests.length, 0);
});

test('cloud setting never replaces embedded lyrics or clears already visible text', t => {
    const f = fixture(t), session = f.lyrics.createLocalLyricSession({}, () => true);
    f.lyrics.applyLocalLyricMetadata(session, { title: 'fixture', lyrics: original }, 'local');
    const row = f.box.children[0];
    f.lyrics.neteaseSearchEnabled = true;
    f.lyrics.neteaseSearchEnabled = false;
    assert.equal(f.requests.length, 0);
    assert.equal(f.box.children[0], row);
    assert.equal(session.source, 'embedded');
});
