import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyricWrapping, lyricPhraseRanges, lyricWrapCandidates, timedPhraseCuts } from '../src/lyrics/wrapping.js';

const parts = (text, join = true) => lyricPhraseRanges(text, join).map(([start, end]) => text.slice(start, end));

test('space grouping is literal and retains a mixed-language Latin suffix as a soft first choice', () => {
    assert.deepEqual(parts('涙や別れも 積み重ねて 少しずつ大きくなってく'), ['涙や別れも', '積み重ねて', '少しずつ大きくなってく']);
    assert.deepEqual(parts('希望をもって memories fade as lights go down'), ['希望をもって', 'memories fade as lights go down']);
    assert.deepEqual(parts('希望をもって memories fade as lights go down', false), ['希望をもって', 'memories', 'fade', 'as', 'lights', 'go', 'down']);
    assert.deepEqual(parts('  希望をもって\t\tmemories　fade  '), ['希望をもって', 'memories　fade']);
});

test('Latin runs are identified across the whole text, independent of surrounding scripts or brackets', () => {
    for (const [text, expected] of [
        ['予想外の連続に 天変地異のようなNew game', ['予想外の連続に', '天変地異のようなNew game']],
        ['朝の光 New gameが始まる 今', ['朝の光', 'New gameが始まる', '今']],
        ['带着希望 走进New game的世界 明天', ['带着希望', '走进New game的世界', '明天']],
        ['새로운 꿈으로New game 시작', ['새로운', '꿈으로New game', '시작']],
        ['希望 (New game) 明日', ['希望', '(New game)', '明日']],
        ["希望 don't stop, won't fade", ['希望', "don't stop,", "won't fade"]],
        ['希望 caf\u00e9 de\u0301j\u00e0 vu 明日', ['希望', 'caf\u00e9 de\u0301j\u00e0 vu', '明日']],
        ['希望 \ud83d\udeb6\ud83c\udffd\u200d\u2640\ufe0f memories fade e\u0301cho', ['希望', '\ud83d\udeb6\ud83c\udffd\u200d\u2640\ufe0f', 'memories fade e\u0301cho']],
        ['希望 hello - world 明日', ['希望', 'hello', '-', 'world', '明日']],
        ['希望 12 34 明日', ['希望', '12', '34', '明日']]
    ]) assert.deepEqual(parts(text), expected);
});

test('the strong plan protects mixed Latin runs and the weaker plan retains ordinary boundaries', () => {
    const text = '予想外の連続に 天変地異のようなNew game';
    assert.deepEqual(lyricWrapCandidates(text).map(ranges => ranges.map(([start, end]) => text.slice(start, end))), [
        ['予想外の連続に', '天変地異のようなNew game'],
        ['予想外の連続に', '天変地異のようなNew', 'game']
    ]);
    assert.deepEqual(parts(text, false), ['予想外の連続に', '天変地異のようなNew', 'game']);
});

test('range protection only removes base boundaries, preserves text and never creates extra candidates', () => {
    const prefixes = ['朝の光', '明日のNew', '新的caf\u00e9', '꿈New', '(New', '\ud83c\udfb5New'];
    const separators = [' ', '\t', '\u3000', '\u00a0', '\u202f'];
    const tails = ['game 明日', "don't fade 明日", 'de\u0301j\u00e0 vu)', 'game！？ 明日'];
    for (const prefix of prefixes) for (const separator of separators) for (const tail of tails) {
        const text = `希望 ${prefix}${separator}${tail}`, base = lyricPhraseRanges(text, false);
        const boundaries = new Set(base.slice(0, -1).map(range => range[1]));
        const strong = lyricPhraseRanges(text), snapshot = JSON.stringify(strong);
        for (const [start, end] of strong) { assert.ok(start >= 0 && end <= text.length && start < end); }
        assert.ok(strong.slice(0, -1).every(range => boundaries.has(range[1])));
        let restored = '', offset = 0;
        for (const [start, end] of strong) { restored += text.slice(offset, start) + text.slice(start, end); offset = end; }
        assert.equal(restored + text.slice(offset), text);
        assert.ok(lyricWrapCandidates(text).length <= 2);
        assert.equal(JSON.stringify(lyricPhraseRanges(text)), snapshot);
    }
});

test('mixed-script timed ranges never split the Latin run or rebuild time nodes', () => {
    const text = '予想外の連続に 天変地異のようなNew game';
    const nodes = ['予想外の連続に ', '天変地異のようなNew ', 'game'];
    assert.deepEqual(timedPhraseCuts(text, lyricPhraseRanges(text), nodes.map(value => value.length)), [1]);
    const value = host({ text, timed: nodes }); value.manager.refresh();
    const originals = [...value.elements[0].childNodes];
    assert.equal(value.manager.layout(), true);
    assert.deepEqual(value.content.querySelectorAll('.yrc-char'), originals);
    assert.deepEqual(value.content.querySelectorAll('.lyric-phrase').map(node => node.textContent), ['天変地異のようなNew game']);
    value.manager.reset(); assert.deepEqual(value.elements[0].childNodes, originals);
});

test('near-limit Latin words and dense boundaries remain bounded without special-case text rules', () => {
    const long = 'W'.repeat(740);
    assert.deepEqual(parts('希望 ' + long), ['希望', long]);
    const pair = 'W'.repeat(360) + ' ' + 'x'.repeat(360);
    assert.deepEqual(parts('希望 ' + pair), ['希望', pair]);
    assert.deepEqual(lyricWrapCandidates('希望 ' + long + 'x'.repeat(40)), []);
    assert.deepEqual(lyricWrapCandidates(Array(49).fill('New希望').join(' ')), []);
});

test('punctuation stays on the preceding phrase, with closing quotes and numeric separators intact', () => {
    assert.deepEqual(parts('「出発しよう。」そして、明日へ！'), ['「出発しよう。」', 'そして、', '明日へ！']);
    assert.deepEqual(parts('心跳，继续；明天：再见。'), ['心跳，', '继续；', '明天：', '再见。']);
    assert.deepEqual(parts('希望 3.14 1,000 v0.1.2 memories.fade', false), ['希望', '3.14', '1,000', 'v0.1.2', 'memories.fade']);
    assert.deepEqual(parts('希望 Hello, world. Next verse'), ['希望', 'Hello,', 'world.', 'Next verse']);
});

test('consecutive ending punctuation and closing quotes stay with the preceding phrase', () => {
    assert.deepEqual(parts('大丈夫！？ 明日へ進もう'), ['大丈夫！？', '明日へ進もう']);
    assert.deepEqual(parts('「はい！」、次へ。'), ['「はい！」、', '次へ。']);
    assert.deepEqual(parts('出発！... 次へ'), ['出発！...', '次へ']);
    assert.deepEqual(parts('待って！？…… 明日へ'), ['待って！？……', '明日へ']);
});

test('numeric colons stay intact while prose colons remain phrase boundaries', () => {
    assert.deepEqual(parts('希望 12:34 １：２ 3.14 1,000', false), ['希望', '12:34', '１：２', '3.14', '1,000']);
    assert.deepEqual(parts('希望:明日へ　次へ：進もう'), ['希望:', '明日へ', '次へ：', '進もう']);
});

test('graphemes are never segmented internally and explicit or bidirectional text retains native layout', () => {
    assert.deepEqual(parts('希望 👨‍👩‍👧‍👦 e\u0301cho'), ['希望', '👨‍👩‍👧‍👦', 'e\u0301cho']);
    for (const text of ['一行\n二行', '一行\r\n二行', '希望 مرحبا بالعالم', 'x'.repeat(769)]) {
        assert.deepEqual(lyricWrapCandidates(text), []);
    }
    assert.deepEqual(lyricWrapCandidates('memories fade as lights go down'), []);
    assert.deepEqual(lyricWrapCandidates('没有空格也没有标点的一长句'), []);
});

test('NBSP retains local connections while ordinary and fullwidth spaces remain usable', () => {
    assert.deepEqual(parts('Tie love\u00a0すべてが知りたいの 弱音だって聞かせて'),
        ['Tie love\u00a0すべてが知りたいの', '弱音だって聞かせて']);
    assert.deepEqual(parts('You lie you like\u00a0もどかしい距離 わかってるのに　ジレンマ'),
        ['You lie you like\u00a0もどかしい距離', 'わかってるのに', 'ジレンマ']);
    assert.deepEqual(parts('希望 non\u00a0breaking 明日'), ['希望', 'non\u00a0breaking', '明日']);
    assert.deepEqual(parts('希望 10\u00a0kg を持って進もう'), ['希望', '10\u00a0kg', 'を持って進もう']);
    assert.deepEqual(parts('希望 10\u202fkg を持って進もう'), ['希望', '10\u202fkg', 'を持って進もう']);
});

test('protected joins next to punctuation or ordinary spaces are not exposed as boundaries', () => {
    for (const text of ['希望！\u00a0明日 続く', '希望\u00a0 明日 続く', '希望 \u202f明日 続く', '希望！？\u00a0 明日 続く']) {
        const plan = lyricPhraseRanges(text);
        assert.equal(plan.length, 2);
        assert.equal(text.slice(...plan[1]), '続く');
        assert.equal(text.slice(...plan[0]), text.slice(0, text.lastIndexOf(' ')));
    }
});

test('a protected join never falls back to a plan that separates a continuous Latin run', () => {
    assert.deepEqual(lyricWrapCandidates('遥か先へ光差した\u00a0your voice still echoes inside'), []);
    assert.equal(lyricWrapCandidates('Tie love\u00a0すべてが知りたいの 弱音だって聞かせて').length, 1);
    assert.deepEqual(lyricWrapCandidates('希望\u00a0your voice still echoes inside\u00a0明日'), []);
    assert.deepEqual(lyricWrapCandidates('10\u00a0kg of gold'), []);
});

test('protected candidate offsets preserve every original character and timed join', () => {
    for (const glue of ['\u00a0', '\u202f']) {
        const text = `Tie love${glue}すべてが知りたいの 弱音だって聞かせて`;
        const nodes = ['Tie ', `love${glue}`, 'すべてが知りたいの ', '弱音だって聞かせて'];
        const ranges = lyricPhraseRanges(text);
        assert.deepEqual(timedPhraseCuts(text, ranges, nodes.map(value => value.length)), [3]);
        let offset = 0, restored = '';
        for (const [start, end] of ranges) { restored += text.slice(offset, start) + text.slice(start, end); offset = end; }
        assert.equal(restored + text.slice(offset), text);
        assert.deepEqual(timedPhraseCuts(text, ranges, [text.length]), []);
    }
});

test('candidate counts are bounded and repeated plans are deduplicated', () => {
    assert.equal(lyricWrapCandidates('涙や別れも 積み重ねて 少しずつ大きくなってく').length, 1);
    assert.equal(lyricWrapCandidates('希望をもって memories fade as lights go down').length, 2);
    assert.deepEqual(lyricWrapCandidates(Array(50).fill('希望').join(' ')), []);
    for (const text of ['空格  保留', '标点，保留。', '希望\t英文 words']) for (const ranges of lyricWrapCandidates(text)) {
        let previous = 0, restored = '';
        for (const [start, end] of ranges) { restored += text.slice(previous, start) + text.slice(start, end); previous = end; }
        restored += text.slice(previous);
        assert.equal(restored, text);
    }
});

test('timed groups cut only between whole timing nodes, including attached spaces', () => {
    const text = '希望をもって memories fade';
    const ranges = lyricPhraseRanges(text);
    assert.deepEqual(timedPhraseCuts(text, ranges, ['希望をもって ', 'memories ', 'fade'].map(value => value.length)), [1]);
    assert.deepEqual(timedPhraseCuts(text, ranges, ['希望をもって memories ', 'fade'].map(value => value.length)), []);
    assert.deepEqual(timedPhraseCuts(text, ranges, [1, 2]), []);
});

// Controlled geometry tests exercise the safety gates; browser A/B tests cover real font layout.
function host({ count = 1, timed = false, reject = '', unique = false, text: suppliedText = null } = {}) {
    let probes = 0;
    class Node {
        constructor(type = 1, text = '') { this.nodeType = type; this.data = text; this.childNodes = []; this.style = {}; this.className = ''; }
        get classList() { return { contains: value => this.className.split(' ').includes(value) }; }
        get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map(node => node.textContent).join(''); }
        appendChild(node) {
            if (node.nodeType === 11) { for (const child of [...node.childNodes]) this.appendChild(child); return node; }
            node.remove(); this.childNodes.push(node); node.parentNode = this; return node;
        }
        replaceChildren(...nodes) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; nodes.forEach(node => this.appendChild(node)); }
        remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this); this.parentNode = null; }
        cloneNode(deep) { const copy = new Node(this.nodeType, this.data); copy.className = this.className; copy.style = { ...this.style }; if (deep) this.childNodes.forEach(node => copy.appendChild(node.cloneNode(true))); return copy; }
        setAttribute() {}
        closest() { return this.line; }
        querySelectorAll(selector) { const values = []; for (const node of this.childNodes) { if (selector.split(', ').some(value => node.classList.contains(value.slice(1)))) values.push(node); values.push(...node.querySelectorAll(selector)); } return values; }
        get isConnected() { return this === body || !!this.parentNode?.isConnected; }
        get clientWidth() { return 100; }
        get scrollWidth() { return reject === 'overflow' && this.querySelectorAll('.lyric-phrase').length ? 120 : 100; }
        get offsetHeight() {
            const grouped = this.querySelectorAll('.lyric-phrase').length > 0;
            return grouped && (reject === 'height' || reject === this.style.fontWeight) ? 60 : 40;
        }
        getBoundingClientRect() { return { height: this.offsetHeight }; }
    }
    const body = new Node(), content = new Node(); body.appendChild(content);
    const elements = Array.from({ length: count }, (_, index) => {
        const element = new Node(); element.className = 'lyric-original'; element.line = { index };
        const text = suppliedText ?? `希望をもって memories fade${unique ? ` ${index}` : ''}`;
        if (timed) for (const part of Array.isArray(timed) ? timed : text.match(/\S+\s*/gu)) { const child = new Node(); child.className = 'yrc-char'; child.appendChild(new Node(3, part)); element.appendChild(child); }
        else element.appendChild(new Node(3, text));
        content.appendChild(element); return element;
    });
    const document = { body, hidden: false, createElement() { probes++; return new Node(); }, createTextNode: text => new Node(3, text), createDocumentFragment: () => new Node(11) };
    const environment = { getComputedStyle: node => ({ width: '100px', lineHeight: '20px', fontSize: '20px', fontWeight: node.style.fontWeight || '800', direction: 'ltr' }) };
    return { manager: createLyricWrapping(content, { environment, document }), elements, content, document, probes: () => probes };
}

test('layout rejects an extra line at either weight and any horizontal overflow', () => {
    for (const reject of ['height', '400', '800', 'overflow']) {
        const value = host({ reject }); value.manager.refresh();
        assert.equal(value.manager.layout(), false);
        assert.equal(value.content.querySelectorAll('.lyric-phrase').length, 0);
        assert.equal(value.document.body.childNodes.length, 1);
    }
});

test('NBSP layout retains character content and timed nodes, with the same height and overflow guards', () => {
    const text = 'Tie love\u00a0すべてが知りたいの 弱音だって聞かせて';
    const timed = ['Tie ', 'love\u00a0', 'すべてが知りたいの ', '弱音だって聞かせて'];
    for (const reject of ['', 'height', '400', '800', 'overflow']) {
        const value = host({ text, timed, reject }); value.manager.refresh();
        const original = [...value.elements[0].childNodes];
        assert.equal(value.manager.layout(), !reject);
        assert.equal(value.elements[0].textContent, text);
        assert.deepEqual(value.content.querySelectorAll('.yrc-char'), original);
        value.manager.reset();
        assert.deepEqual(value.elements[0].childNodes, original);
    }
});

test('layout batches near the current line and deduplicates repeated paragraph measurements', () => {
    const value = host({ count: 100 }); value.manager.refresh();
    assert.equal(value.manager.layout(), true);
    assert.equal(value.elements.filter(node => node.querySelectorAll('.lyric-phrase').length).length, 16);
    const probes = value.probes();
    assert.equal(value.manager.layout(), false);
    assert.equal(value.probes(), probes);
    value.manager.layout(value.elements[60].line);
    assert.equal(value.elements.filter(node => node.querySelectorAll('.lyric-phrase').length).length, 32);
    // A cache hit creates wrappers and a detached host, but no baseline/trial clones.
    assert.equal(value.probes() - probes, 33);
});

test('a native-only current row prepares nearby eligible rows instead of restarting at the beginning', () => {
    const value = host({ count: 100 });
    value.elements[50].childNodes[0].data = 'English only';
    value.manager.refresh(value.elements.map(node => node.line));
    value.manager.layout(value.elements[50].line);
    assert.deepEqual(value.elements.flatMap((node, index) => node.querySelectorAll('.lyric-phrase').length ? [index] : []),
        [46, 47, 48, 49, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62]);
});

test('native-only anchors at the start, end and inside a gap select the closest available region', () => {
    for (const [anchor, native, expected] of [
        [0, [0, 1, 2], 3], [99, [97, 98, 99], 96], [50, Array.from({ length: 21 }, (_, index) => index + 40), 61]
    ]) {
        const value = host({ count: 100 });
        for (const index of native) value.elements[index].childNodes[0].data = 'English only';
        value.manager.refresh(value.elements.map(node => node.line));
        value.manager.layout(value.elements[anchor].line);
        assert.ok(value.elements[expected].querySelectorAll('.lyric-phrase').length);
        assert.ok(value.elements.filter(node => node.querySelectorAll('.lyric-phrase').length).length <= 16);
        if (anchor > 0) assert.equal(value.elements[0].querySelectorAll('.lyric-phrase').length, 0);
    }
});

test('invalidation, refresh and reset retain timed node identity and clear temporary probes', () => {
    const value = host({ timed: true }); value.manager.refresh();
    const original = [...value.elements[0].childNodes];
    assert.equal(value.manager.layout(), true);
    assert.deepEqual(value.content.querySelectorAll('.yrc-char'), original);
    value.manager.invalidate(); value.manager.layout();
    assert.deepEqual(value.content.querySelectorAll('.yrc-char'), original);
    value.manager.refresh();
    assert.deepEqual(value.elements[0].childNodes, original);
    value.document.hidden = true;
    assert.equal(value.manager.layout(), false);
    value.document.hidden = false; value.manager.layout(); value.manager.reset();
    assert.deepEqual(value.elements[0].childNodes, original);
    assert.equal(value.document.body.childNodes.length, 1);
    assert.equal(value.manager.layout(), false);
});

test('a host without layout APIs preserves native wrapping', () => {
    const manager = createLyricWrapping({}, { environment: {}, document: {} });
    manager.refresh(); manager.invalidate(); manager.reset();
    assert.equal(manager.layout(), false);
});
