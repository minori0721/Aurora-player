import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyrics } from '../src/lyrics/controller.js';
import { createMetadata } from '../src/audio/metadata.js';
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
        cache: { cachedFetchJson(url, options) { requests.push({ url, options }); return new Promise((resolve, reject) => pending.push(Object.assign(resolve, { reject }))); } }
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

test('long local artist names have an independent text block and keep quality badges separate', t => {
    const f = fixture(t), title = new FakeElement();
    const metadata = createMetadata({ dom: { el: { artist: f.artist, title } }, covers: { setMainCover() {} }, lyrics: {} });
    const artist = '花澤さくら / 紫咲ほたる / Camden Cox / Karen Harding / <script>not markup</script>';
    metadata.applyMetadata({ title: 'A long local title', artist }, 'local');
    const names = f.artist.querySelector('.track-artist-names');
    assert.equal(names.textContent, artist); assert.equal(names.title, artist);
    f.lyrics.setArtistTag('本地文件', 'FLAC 192kHz/24bit');
    assert.deepEqual(f.artist.children.map(node => node.className), ['track-artist-names', 'tag-source', 'tag-quality']);
    assert.equal(f.artist.children[0], names);
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
    assert.equal(f.artist.querySelector('.tag-source').textContent, 'test');
    assert.equal(f.lyrics.setLyricDisplayMode('roma'), true);
    assert.match(f.box.innerHTML, /plain roman/);
    assert.doesNotMatch(f.box.innerHTML, /plain translation/);
    assert.equal(f.artist.querySelector('.tag-source').textContent, 'test');
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

const instrumentalCredits = '{"c":[{"tx":"作曲: "},{"tx":"GTR7"}]}\n{"c":[{"tx":"编曲: "},{"tx":"GTR7"}]}';

for (const marker of ['纯音乐，请欣赏', '  纯音乐, 请欣赏。  ', '[99:00.00]纯音乐，请欣赏']) {
    test(`instrumental marker uses a static status, not a timed or plain lyric: ${marker}`, t => {
        const f = fixture(t, 'roma');
        f.lyrics.parseAndRenderLyrics(`${instrumentalCredits}\n${marker}`, '网易云');
        assert.match(f.box.innerHTML, /class="lyric-message" role="status"/);
        assert.match(f.box.innerHTML, /纯音乐，请欣赏/);
        assert.match(f.box.innerHTML, /作曲: GTR7\n编曲: GTR7/);
        assert.doesNotMatch(f.box.innerHTML, /lyric-line|lyric-original|data-lyric-time|margin-top/);
        assert.equal(f.lyrics.getNextLyricTime(), null);
        assert.ok(f.inputs.every(input => input.disabled && !input.checked));
        assert.equal(f.lyrics.setLyricDisplayMode('both'), false);
        f.lyrics.refreshLyricHighlightAndCenter(true);
        assert.match(f.box.innerHTML, /class="lyric-message"/);
    });
}

test('a genuine single untimed line and marker text embedded in real lyrics are preserved', t => {
    const f = fixture(t);
    for (const text of ['Stay the night', '純音楽を聴いている', '纯音乐，请欣赏\n真正的歌词', 'Not instrumental <&>']) {
        f.lyrics.parseAndRenderLyrics(text, 'test');
        assert.match(f.box.innerHTML, /class="lyric-untimed"/);
        assert.doesNotMatch(f.box.innerHTML, /lyric-message|data-lyric-time/);
        assert.equal(f.inputs[0].disabled, false);
    }
    f.lyrics.parseAndRenderLyrics('纯音乐，请欣赏', 'test', 'A real translation');
    assert.equal(f.lyrics.setLyricDisplayMode('both'), true);
    assert.match(f.box.innerHTML, /A real translation/);
    assert.doesNotMatch(f.box.innerHTML, /lyric-message/);
});

test('empty and credits-only payloads show no lyrics without asserting instrumental content', t => {
    const f = fixture(t);
    for (const text of ['', instrumentalCredits]) {
        f.lyrics.parseAndRenderLyrics(text, 'test');
        assert.match(f.box.innerHTML, /lyric-message/);
        assert.match(f.box.innerHTML, /暂无歌词/);
        assert.doesNotMatch(f.box.innerHTML, /纯音乐/);
        assert.ok(f.inputs.every(input => input.disabled));
    }
    assert.match(f.box.innerHTML, /作曲: GTR7/);
});

test('untimed text retains newlines, escaping and modes without timed controls', t => {
    const f = fixture(t);
    const text = 'First line\n涙や別れも 積み重ねて\n希望をもって memories fade as lights go down\n<script>alert(1)</script>';
    f.lyrics.parseAndRenderLyrics(text, 'test', '翻译第一行\n翻译第二行', 'roma one\nroma two');
    assert.match(f.box.innerHTML, /First line\n涙や別れも/);
    assert.match(f.box.innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(f.box.innerHTML, /<script>|data-lyric-time|role="button"/);
    f.lyrics.setLyricDisplayMode('both');
    assert.match(f.box.innerHTML, /翻译第一行\n翻译第二行/);
    f.lyrics.setLyricDisplayMode('roma');
    assert.match(f.box.innerHTML, /roma one\nroma two/);
    assert.doesNotMatch(f.box.innerHTML, /翻译第一行/);
    f.lyrics.parseAndRenderLyrics('', 'test', 'translation-only text');
    f.lyrics.setLyricDisplayMode('both');
    assert.equal(f.box.innerHTML.split('translation-only text').length - 1, 1);
});

test('status rendering clears old highlights and modes while safely retaining the preferred mode', t => {
    const f = fixture(t, 'both');
    f.lyrics.parseAndRenderLyrics(original, 'test', translated, roman);
    assert.ok(f.box.children.length > 0);
    f.lyrics.showLyricStatus('读取失败 <filename>.mp3');
    assert.equal(f.box.children.length, 0);
    assert.match(f.box.innerHTML, /读取失败 &lt;filename&gt;.mp3/);
    assert.equal(f.lyrics.originalLyricsArr.length, 0);
    assert.equal(f.lyrics.getNextLyricTime(), null);
    assert.ok(f.inputs.every(input => input.disabled));
    assert.equal(f.lyrics.cycleLyricDisplayMode(), false);
    assert.equal(f.lyrics.lyricDisplayMode, 'both');
    f.lyrics.parseAndRenderLyrics(original, 'test', translated);
    assert.equal(f.lyrics.effectiveLyricDisplayMode, 'both');
    assert.equal(f.box.children[0].querySelector('.lyric-translation').textContent, 'translation');
});

for (const [data, expected] of [[{ nolyric: true }, '纯音乐，请欣赏'], [{ uncollected: true }, '暂无歌词'],
    [{ lrc: { lyric: '' } }, '暂无歌词'], [{ lrc: { lyric: `${instrumentalCredits}\n纯音乐，请欣赏` } }, '纯音乐，请欣赏']]) {
    test(`lyric responses use unified status markup: ${JSON.stringify(data)}`, async t => {
        const f = fixture(t);
        f.lyrics.parseAndRenderLyrics(original, 'test', translated);
        const load = f.lyrics.fetchLyricById(2723078898);
        assert.match(f.box.innerHTML, /获取歌词/);
        assert.ok(f.inputs.every(input => input.disabled));
        f.pending[0]({ code: 200, ...data });
        await load;
        assert.match(f.box.innerHTML, /class="lyric-message"/);
        assert.ok(f.box.innerHTML.includes(expected));
        assert.doesNotMatch(f.box.innerHTML, /data-lyric-time|margin-top/);
        assert.equal(f.artist.querySelector('.tag-source').textContent, '网易云');
        assert.ok(f.inputs.every(input => input.disabled));
    });
}

test('lyric request failures cannot leave stale timed data or enable old mode buttons', async t => {
    const f = fixture(t);
    f.lyrics.parseAndRenderLyrics(original, 'test', translated);
    const load = f.lyrics.fetchLyricById(1);
    f.pending[0].reject(new Error('offline'));
    assert.equal(await load, false);
    assert.match(f.box.innerHTML, /歌词获取失败/);
    assert.equal(f.lyrics.originalLyricsArr.length, 0);
    assert.equal(f.lyrics.getNextLyricTime(), null);
    assert.ok(f.inputs.every(input => input.disabled));
});

test('late and aborted responses cannot replace the next track status or untimed text', async t => {
    const f = fixture(t);
    let current = true;
    const load = f.lyrics.fetchLyricById(1, { isCurrent: () => current });
    current = false;
    f.lyrics.parseAndRenderLyrics('Next track text', 'local');
    const next = f.box.innerHTML;
    f.pending[0]({ code: 200, nolyric: true });
    assert.equal(await load, false);
    assert.equal(f.box.innerHTML, next);
    const controller = new AbortController();
    const aborted = f.lyrics.fetchLyricById(2, { signal: controller.signal });
    controller.abort();
    f.lyrics.showLyricStatus('下一首正在加载');
    f.pending[1]({ code: 200, nolyric: true });
    assert.equal(await aborted, false);
    assert.match(f.box.innerHTML, /下一首正在加载/);
});
