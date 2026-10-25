import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildHtml } from '../scripts/build.mjs';
import { checkHtml, checkSource } from '../scripts/check.mjs';
import { readPublicConfig } from '../scripts/config.mjs';
import { releaseNotes, validateReleaseTag } from '../scripts/release.mjs';
import { startDevServer } from '../scripts/dev.mjs';
import { createHost, FakeAudioContext } from './helpers/host.mjs';
import { periodicSignal } from './helpers/signal.mjs';
import { findBestMatchByMode, releaseAnalysisBuffer } from '../src/analysis/algorithms.js';
import { createLoopAnalysisInput, describeLoopAnalysisInput } from '../src/analysis/input.js';

const built = await buildHtml({ env: {} });
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
function boot() {
    const fixture = createHost(built.html);
    const context = vm.createContext(fixture.host);
    for (const script of built.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]).runInContext(context, { timeout: 5000 });
    return { ...fixture, audio: FakeAudioContext.instances.at(-1) };
}
function importFiles(fixture, files) {
    const input = fixture.elements.get('file-input');
    input.files = files;
    input.dispatchEvent({ type: 'change', target: input });
}
const localFile = (name, arrayBuffer = async () => new Uint8Array([102, 76, 97, 67]).buffer) => ({ name, size: 4, lastModified: 1, arrayBuffer });

test('source dependencies are explicit and acyclic; output is one standalone HTML', async () => {
    assert.ok((await checkSource()) >= 40);
    assert.equal(checkHtml(built.html, built.version), 5);
    assert.equal(/new Worker\(["'][^"']+\.js/.test(built.appSource), false);
    assert.equal(built.html.includes('node_modules/'), false);
    assert.equal(built.html.includes('Function.prototype.toString'), false);
    assert.ok(built.html.includes('jsmediatags'));
    assert.ok(built.html.includes('MIT'));
    assert.ok(built.html.includes('fft.js 4.0.4'));
    assert.ok(built.html.includes('Copyright Fedor Indutny, 2017.'));
    assert.ok(built.workerSource.includes('Copyright Fedor Indutny, 2017.'));
});

test('production build is deterministic and environment injection is public/allowlisted', async () => {
    const again = await buildHtml({ env: {} });
    assert.equal(again.html, built.html);
    const configured = await buildHtml({ env: { API_BASE_URL: 'https://api.example.com/v1/', DOWNLOAD_PROXY_URL: 'https://proxy.example.com', GH_TOKEN: 'must-never-enter-html' } });
    assert.equal(configured.config.API_BASE_URL, 'https://api.example.com/v1');
    assert.equal(configured.html.includes('must-never-enter-html'), false);
    assert.equal(configured.html.includes('https://api.example.com/v1'), true);
    assert.throws(() => readPublicConfig({ API_BASE_URL: 'javascript:alert(1)' }));
    assert.throws(() => readPublicConfig({ API_BASE_URL: 'https://user:secret@example.com' }));
    const tricky = await buildHtml({ env: { API_BASE_URL: 'https://example.com/</script><script>' } });
    assert.equal(checkHtml(tricky.html, tricky.version), 5);
});

test('full compiled application boots in a mock host without runtime globals or network', async () => {
    const { host, elements, requests, frames } = createHost(built.html);
    const context = vm.createContext(host);
    for (const script of built.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]).runInContext(context, { timeout: 5000 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof elements.get('play-btn').onclick, 'function');
    assert.equal(typeof elements.get('next-btn').onclick, 'function');
    assert.equal(typeof elements.get('netease-search-btn').onclick, 'function');
    assert.equal(requests.length, 0);
    assert.equal(host._currentPlayActionToken, undefined);
    assert.equal(host.setLoopPoint, undefined);
    assert.ok(frames.size <= 1);
    for (const [id, callback] of [...frames]) { frames.delete(id); callback(1); }
    assert.equal(frames.size, 0, 'paused with effects disabled must not keep RAF alive');
});

test('desktop and mobile Log keep their existing actions and native effects remain in the standalone template', () => {
    assert.match(built.html, /id="toggle-debug"[^>]+aria-label="打开日志"/);
    assert.ok(built.html.includes('<span>Log</span>'));
    assert.ok(built.html.includes('> 日志已就绪。'));
    assert.equal(built.html.includes('Debugger Ready.'), false);
    assert.ok(built.html.includes('Lucide Logs icon'));
    assert.ok(built.html.includes('ISC License'));
    const select = built.html.match(/<select id="effect-select"[^>]*>([\s\S]*?)<\/select>/)?.[1];
    assert.ok(select);
    assert.deepEqual([...select.matchAll(/value="([^"]+)"/g)].map(match => match[1]), ['none', 'snow', 'bars', 'waves']);
    assert.equal(built.html.split('id="effect-select"').length, 2);
    const mobileLog = built.html.match(/<button[^>]+data-action="debug"[^>]*>([\s\S]*?)<\/button>/)?.[1];
    assert.ok(mobileLog?.includes('class="tool-icon"'));
    assert.match(mobileLog, /<span class="advanced-menu-text">Log<\/span>$/);
    assert.equal([...built.html.matchAll(/class="advanced-menu-icon"/g)].length, 6);
    assert.equal([...built.html.matchAll(/class="advanced-menu-text"/g)].length, 6);
    assert.equal(built.html.includes('🐞 Debug'), false);
});

test('compiled Log toggles the existing console and native effect changes do not start audio', async () => {
    const f = boot();
    await settle();
    const log = f.elements.get('toggle-debug'), consolePanel = f.elements.get('debug-console');
    for (const closed of ['', 'none']) {
        consolePanel.style.display = closed;
        log.click();
        assert.equal(consolePanel.style.display, 'block');
        log.click();
        assert.equal(consolePanel.style.display, 'none');
    }
    const effect = f.elements.get('effect-select');
    const canvas = f.elements.get('visual-canvas');
    // The lightweight host does not implement reflected HTMLElement boolean defaults.
    canvas.hidden = true;
    effect.value = 'snow';
    effect.dispatchEvent({ type: 'change', target: effect });
    assert.equal(canvas.hidden, false);
    assert.equal(canvas.width, f.host.innerWidth);
    assert.ok(f.frames.size > 0);
    effect.value = 'none';
    effect.dispatchEvent({ type: 'change', target: effect });
    assert.equal(canvas.hidden, true);
    assert.equal(canvas.width, 1);
    assert.equal(f.audio.sources.length, 0);
    assert.equal(f.requests.length, 0);
});

test('compiled local playback and lyric controls write Chinese logs without translating diagnostic data', async () => {
    const f = boot();
    await settle();
    const lyrics = f.elements.get('toggle-netease');
    lyrics.click();
    lyrics.click();
    assert.ok(f.logs.some(parts => parts[0] === '网易云歌词搜索：已开启'));
    assert.ok(f.logs.some(parts => parts[0] === '网易云歌词搜索：已关闭'));
    importFiles(f, [localFile('diagnostic-English-title.flac')]);
    await settle();
    const messages = f.elements.get('debug-console').children.map(row => row.textContent);
    assert.ok(messages.includes('> 本地曲目：diagnostic-English-title'));
    assert.ok(messages.includes('> 检测到 FLAC，正在解析文件元数据…'));
    assert.ok(messages.some(text => text.startsWith('> 已忽略损坏的 FLAC 元数据：')));
    assert.equal(f.elements.get('track-title').textContent, 'diagnostic-English-title');
    assert.equal(f.audio.decodeCalls.length, 1);
    assert.equal(f.requests.length, 0);
    f.audio.decodeHook = () => Promise.reject(new Error('Original diagnostic (401)'));
    importFiles(f, [localFile('failed-case.flac')]);
    await settle();
    assert.ok(f.elements.get('debug-console').children.some(row => row.textContent === '> 本地播放失败：Error: Original diagnostic (401)'));
});

test('compiled cloud switch stays in the menu and synchronizes with the desktop control', async () => {
    const f = boot();
    await settle();
    const trigger = f.elements.get('toggle-advanced'), menu = f.elements.get('advanced-menu');
    const cloud = f.elements.get('cloud-lyrics-switch'), desktop = f.elements.get('toggle-netease');
    trigger.click();
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    cloud.checked = true;
    cloud.dispatchEvent({ type: 'change', target: cloud });
    assert.equal(desktop.getAttribute('aria-pressed'), 'true');
    assert.equal(menu.getAttribute('aria-hidden'), 'false');
    desktop.click();
    assert.equal(cloud.checked, false);
    assert.equal(menu.getAttribute('aria-hidden'), 'false');
    menu.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(f.requests.length, 0);
    assert.equal(f.audio.sources.length, 0);
});

test('compiled Worker matches main-thread algorithms in all three modes and releases its cache', () => {
    const posts = [];
    const self = { postMessage: message => posts.push(message) };
    const context = vm.createContext({ self, Float32Array, ArrayBuffer, performance });
    new vm.Script(built.workerSource).runInContext(context);
    const buffer = periodicSignal();
    const layout = describeLoopAnalysisInput(buffer, 4.2, 12.2);
    for (const [jobId, mode] of ['fast', 'balanced', 'full'].entries()) {
        const message = { type: 'analyze', jobId, audioId: 1, windowKey: layout.key, timeA: 4.2, timeB: 12.2, mode };
        if (jobId === 0) {
            const input = createLoopAnalysisInput(buffer, layout);
            message.layout = layout;
            message.channelBuffers = [input.getChannelData(0).buffer];
        }
        self.onmessage({ data: message });
        const result = posts.at(-1);
        assert.equal(result.ok, true, result.error);
        const expected = findBestMatchByMode(buffer, message.timeA, message.timeB, mode);
        for (const field of ['start', 'end', 'confidence', 'diff']) assert.equal(result.result[field], expected[field]);
    }
    self.onmessage({ data: { type: 'release' } });
    self.onmessage({ data: { type: 'analyze', jobId: 4, audioId: 1, mode: 'balanced' } });
    assert.equal(posts.at(-1).ok, false);
    assert.match(posts.at(-1).error, /missing/);
    const stereo = { ...buffer, numberOfChannels: 2, getChannelData: c => c ? buffer.getChannelData(0).map(v => -v) : buffer.getChannelData(0) };
    const stereoLayout = describeLoopAnalysisInput(stereo, 1.1, 17.1);
    const packed = createLoopAnalysisInput(stereo, stereoLayout);
    self.onmessage({ data: { type: 'analyze', jobId: 5, audioId: 2, windowKey: stereoLayout.key,
        layout: stereoLayout, channelBuffers: [packed.getChannelData(0).buffer, packed.getChannelData(1).buffer],
        timeA: 1.1, timeB: 17.1, mode: 'balanced' } });
    assert.equal(posts.at(-1).ok, true);
    assert.equal(posts.at(-1).result.detail.checkedChannels, 2);
    self.onmessage({ data: { type: 'analyze', jobId: 6, audioId: 2, windowKey: 'stale-region', timeA: 1, timeB: 9 } });
    assert.equal(posts.at(-1).ok, false);
    assert.match(posts.at(-1).error, /missing/);
    releaseAnalysisBuffer(buffer);
});

test('compiled background worker falls back without WebGL and needs no document or external imports', () => {
    const posts = [], self = { postMessage: message => posts.push(message), close() {} };
    const context = vm.createContext({ self, performance, setTimeout, clearTimeout });
    new vm.Script(built.backgroundWorkerSource).runInContext(context);
    self.onmessage({ data: { type: 'init', revision: 3,
        canvas: { width: 1, height: 1, addEventListener() {}, getContext: () => null }, theme: {},
        state: { playing: true, hidden: false, reduced: false, width: 1440, height: 900 } } });
    assert.equal(posts.at(-1).revision, 3);
    assert.equal(posts.at(-1).stats.failed, true);
    self.onmessage({ data: { type: 'dispose' } });
    assert.equal(posts.at(-1).type, 'disposed');
});

test('compiled import applies only the matching SLI and clears it on the next local track', async () => {
    const fixture = boot();
    const sli = { name: 'first.flac.sli', size: 30, lastModified: 1, text: async () => 'From=441000; To=44100;' };
    importFiles(fixture, [localFile('first.flac'), localFile('second.flac'), sli]);
    await settle();
    assert.equal(fixture.elements.get('track-title').textContent, 'first');
    assert.equal(fixture.audio.decodeCalls.length, 1);
    assert.equal(fixture.audio.sources.at(-1).loop, true);
    assert.equal(fixture.audio.sources.at(-1).loopStart, 1);
    assert.equal(fixture.audio.sources.at(-1).loopEnd, 10);
    fixture.elements.get('next-btn').click();
    await settle();
    assert.equal(fixture.elements.get('track-title').textContent, 'second');
    assert.equal(fixture.audio.decodeCalls.length, 2);
    assert.equal(fixture.audio.sources.at(-1).loop, false);
    assert.equal(fixture.requests.length, 0);
});

test('compiled import replacement discards an earlier pending local read', async () => {
    const fixture = boot();
    let finish;
    importFiles(fixture, [localFile('old.flac', () => new Promise(resolve => { finish = resolve; }))]);
    await settle();
    assert.equal(typeof finish, 'function');
    importFiles(fixture, [localFile('new.flac')]);
    await settle();
    finish(new Uint8Array([102, 76, 97, 67]).buffer);
    await settle();
    assert.equal(fixture.elements.get('track-title').textContent, 'new');
    assert.equal(fixture.audio.decodeCalls.length, 1);
    assert.equal(fixture.elements.get('pl-container').children.length, 1);
});

test('compiled single-song random replay reuses decoded audio without reading again', async () => {
    const fixture = boot();
    let reads = 0;
    importFiles(fixture, [localFile('only.flac', async () => { reads++; return new ArrayBuffer(4); })]);
    await settle();
    fixture.elements.get('mode-btn').click();
    const source = fixture.audio.sources.at(-1);
    fixture.audio.currentTime += 120;
    source.onended();
    await settle();
    assert.equal(reads, 1);
    assert.equal(fixture.audio.decodeCalls.length, 1);
    assert.equal(fixture.audio.sources.at(-1).started[1], 0);
    assert.notEqual(fixture.audio.sources.at(-1), source);
});

function analyze(fixture) {
    const button = fixture.elements.get('ana-run');
    button.dataset.action = 'analyze';
    fixture.elements.get('ana-start').value = '4.2';
    fixture.elements.get('ana-end').value = '12.2';
    fixture.elements.get('ana-mode').value = 'balanced';
    fixture.host.document.dispatchEvent({ type: 'click', target: button, preventDefault() {} });
}

test('compiled analysis falls back without Worker and restores the action button', async () => {
    const fixture = boot();
    fixture.audio.decoded = periodicSignal();
    importFiles(fixture, [localFile('analysis.flac')]);
    await settle();
    analyze(fixture);
    assert.equal(fixture.elements.get('ana-run').disabled, true);
    for (const [id, callback] of [...fixture.frames]) { fixture.frames.delete(id); callback(performance.now()); }
    await settle();
    assert.equal(fixture.elements.get('ana-run').disabled, false);
    assert.equal(fixture.logs.some(parts => String(parts[0]).includes('回退主线程')), true);
    assert.equal(fixture.elements.get('ana-msg').textContent.startsWith('Error:'), false);
    assert.match(fixture.elements.get('ana-msg').textContent, /匹配评分/);
});

test('compiled analysis transfers stereo neighborhoods once, reuses them and replaces changed regions', async () => {
    const fixture = boot(), messages = [];
    class AnalysisWorker {
        constructor() {
            const self = { postMessage: data => this.onmessage?.({ data }) };
            this.self = self;
            new vm.Script(built.workerSource).runInContext(vm.createContext({ self, performance, Float32Array, ArrayBuffer }));
        }
        postMessage(message, transfer = []) {
            messages.push({ bytes: transfer.reduce((sum, buffer) => sum + buffer.byteLength, 0), key: message.windowKey });
            const data = structuredClone(message, { transfer });
            queueMicrotask(() => { if (!this.terminated) this.self.onmessage({ data }); });
        }
        terminate() { this.terminated = true; }
    }
    fixture.host.Worker = AnalysisWorker;
    const mono = periodicSignal(), left = mono.getChannelData(0), right = left.map(v => -v);
    fixture.audio.decoded = { ...mono, numberOfChannels: 2, getChannelData: c => c ? right : left };
    importFiles(fixture, [localFile('stereo.flac')]);
    await settle();
    const run = async () => {
        analyze(fixture);
        for (const [id, callback] of [...fixture.frames]) { fixture.frames.delete(id); callback(performance.now()); }
        await settle();
    };
    await run();
    await run();
    assert.ok(messages[0].bytes > 0);
    assert.equal(messages[1].bytes, 0);
    const button = fixture.elements.get('ana-run');
    fixture.elements.get('ana-start').value = '1.1';
    fixture.elements.get('ana-end').value = '17.1';
    fixture.host.document.dispatchEvent({ type: 'click', target: button, preventDefault() {} });
    for (const [id, callback] of [...fixture.frames]) { fixture.frames.delete(id); callback(performance.now()); }
    await settle();
    assert.ok(messages[2].bytes > 0);
    assert.notEqual(messages[2].key, messages[0].key);
    assert.equal(left.length, 80000);
    assert.equal(right.length, 80000);
    assert.equal(fixture.elements.get('ana-msg').textContent.startsWith('Error:'), false);
    assert.equal(fixture.logs.some(parts => String(parts[0]).includes('回退主线程')), false);
});

test('compiled analysis cancelled by switching songs cannot apply the old loop', async () => {
    const fixture = boot();
    fixture.audio.decoded = periodicSignal();
    importFiles(fixture, [localFile('a-old.flac'), localFile('b-next.flac')]);
    await settle();
    analyze(fixture);
    fixture.elements.get('next-btn').click();
    await settle();
    for (const [id, callback] of [...fixture.frames]) { fixture.frames.delete(id); callback(performance.now()); }
    await settle();
    assert.equal(fixture.elements.get('track-title').textContent, 'b-next');
    assert.equal(fixture.elements.get('ana-run').disabled, false);
    assert.equal(fixture.audio.sources.at(-1).loop, false);
    assert.equal(fixture.elements.get('loop-enable').checked, false);
});

test('compiled analysis ignores a late Worker result after switching songs', async () => {
    const fixture = boot();
    let pendingWorker;
    fixture.host.Worker = class {
        constructor() { pendingWorker = this; }
        postMessage(message) { this.message = message; }
        terminate() { this.terminated = true; }
    };
    fixture.audio.decoded = periodicSignal();
    importFiles(fixture, [localFile('a-analysis-old.flac'), localFile('b-analysis-new.flac')]);
    await settle();
    analyze(fixture);
    for (const [id, callback] of [...fixture.frames]) { fixture.frames.delete(id); callback(performance.now()); }
    await settle();
    assert.equal(fixture.elements.get('ana-run').disabled, true);
    fixture.elements.get('next-btn').click();
    await settle();
    assert.equal(pendingWorker.terminated, true);
    pendingWorker.onmessage({ data: { jobId: pendingWorker.message.jobId, ok: true,
        result: { start: 4, end: 12, confidence: 100, diff: 0 } } });
    await settle();
    assert.equal(fixture.elements.get('track-title').textContent, 'b-analysis-new');
    assert.equal(fixture.elements.get('ana-run').disabled, false);
    assert.equal(fixture.elements.get('loop-enable').checked, false);
    assert.equal(fixture.elements.get('ana-msg').textContent, '');
});

test('compiled analysis falls back safely even if transfer detached the local window before failing', async () => {
    const fixture = boot();
    fixture.host.Worker = class {
        postMessage(message, transfer) {
            structuredClone(message, { transfer });
            throw new Error('transport failure after transfer');
        }
        terminate() {}
    };
    const buffer = periodicSignal();
    fixture.audio.decoded = buffer;
    importFiles(fixture, [localFile('transfer-fallback.flac')]);
    await settle();
    analyze(fixture);
    for (const [id, callback] of [...fixture.frames]) { fixture.frames.delete(id); callback(performance.now()); }
    await settle();
    assert.equal(buffer.getChannelData(0).length, 80000);
    assert.match(fixture.elements.get('ana-msg').textContent, /匹配评分/);
    assert.equal(fixture.elements.get('ana-run').disabled, false);
    assert.equal(fixture.logs.some(parts => String(parts[0]).includes('回退主线程')), true);
});

async function pendingAnalysis() {
    const fixture=boot(),workers=[];
    fixture.host.Worker=class {
        constructor(){workers.push(this);}
        postMessage(message){this.message=message;}
        terminate(){this.terminated=true;}
        reply(start=4,end=12){this.onmessage({data:{jobId:this.message.jobId,ok:true,result:{start,end,confidence:100,diff:0}}});}
    };
    fixture.audio.decoded=periodicSignal(44100);
    importFiles(fixture,[localFile('edit-analysis.flac')]);await settle();
    analyze(fixture);
    const flush=async()=>{for(const [id,callback] of [...fixture.frames]){fixture.frames.delete(id);callback(performance.now());}await settle();};
    return {...fixture,workers,flush};
}

for(const [id,event,value] of [['ana-start','input','6'],['ana-end','input','14'],['ana-mode','change','fast'],['loop-start','input','5'],['loop-enable','change',null]]) {
    test(`compiled analysis cancels when ${id} changes and ignores late responses`,async()=>{
        const f=await pendingAnalysis();await f.flush();
        const worker=f.workers[0],control=f.elements.get(id);
        if(value!==null)control.value=value;else control.checked=false;
        control.dispatchEvent({type:event,target:control});
        assert.equal(worker.terminated,true);assert.equal(f.elements.get('ana-run').disabled,false);
        worker.reply();await settle();
        assert.equal(f.elements.get('loop-enable').checked,false);
        assert.equal(f.elements.get('ana-msg').textContent,'');
        assert.equal(f.logs.some(parts=>String(parts[0]).includes('回退主线程')),false);
    });
}

test('compiled analysis input edits before its first frame do not launch a worker',async()=>{
    const f=await pendingAnalysis(),control=f.elements.get('ana-start');
    control.value='6';control.dispatchEvent({type:'input',target:control});await f.flush();
    assert.equal(f.workers.length,0);assert.equal(f.elements.get('ana-run').disabled,false);
});

test('compiled analysis snapshot rejects changes without DOM edit events',async()=>{
    const f=await pendingAnalysis();await f.flush();
    f.elements.get('ana-end').value='14';f.workers[0].reply();await settle();
    assert.equal(f.elements.get('loop-enable').checked,false);
    assert.equal(f.elements.get('ana-run').disabled,false);assert.equal(f.elements.get('ana-msg').textContent,'');
});

test('an old cancelled analysis cannot clear a newer run or replace its result',async()=>{
    const f=await pendingAnalysis();await f.flush();const old=f.workers[0];
    const control=f.elements.get('ana-start');control.value='6';control.dispatchEvent({type:'input',target:control});
    analyze(f);await f.flush();const next=f.workers[1];
    old.reply();await settle();
    assert.equal(f.elements.get('ana-run').disabled,true);assert.equal(f.elements.get('loop-enable').checked,false);
    next.reply(4+18/44100,12+39/44100);await settle();
    assert.equal(f.elements.get('ana-run').disabled,false);assert.match(f.elements.get('ana-msg').textContent,/匹配评分/);
    const precise=f.audio.sources.at(-1);const enable=f.elements.get('loop-enable');
    enable.checked=false;enable.dispatchEvent({type:'change',target:enable});
    enable.checked=true;enable.dispatchEvent({type:'change',target:enable});
    assert.equal(f.audio.sources.at(-1).loopStart,precise.loopStart);
    assert.equal(f.audio.sources.at(-1).loopEnd,precise.loopEnd);
});

test('capturing a new rough point cancels pending analysis without stopping audio',async()=>{
    const f=await pendingAnalysis();await f.flush();const source=f.audio.sources.at(-1);
    const button=f.host.document.createElement('button');button.dataset.action='capture';button.dataset.point='a';
    f.host.document.dispatchEvent({type:'click',target:button,preventDefault(){}});await settle();
    assert.equal(f.workers[0].terminated,true);assert.equal(f.elements.get('ana-run').disabled,false);
    assert.equal(f.audio.sources.at(-1),source);
});

test('compiled SLI export keeps sample positions after toggling a precise loop',async()=>{
    const f=await pendingAnalysis();await f.flush();
    f.workers[0].reply(4+18/44100,12+39/44100);await settle();
    const enable=f.elements.get('loop-enable');
    enable.checked=false;enable.dispatchEvent({type:'change',target:enable});
    enable.checked=true;enable.dispatchEvent({type:'change',target:enable});
    const blobs=[];
    f.host.URL=class extends URL {
        static createObjectURL(blob){blobs.push(blob);return 'blob:test-export';}
        static revokeObjectURL(){}
    };
    const button=f.host.document.createElement('button');button.dataset.action='export-sli';
    f.host.document.dispatchEvent({type:'click',target:button,preventDefault(){}});
    assert.equal(blobs.length,1);
    assert.equal(await blobs[0].text(),'From = 529239;\nTo = 176418;');
});

test('release tag must match the version and notes contain only that version', () => {
    const text = '# Changelog\n\n## v0.0.6 - 2026-10-18\n\n### Changed\n\n- current\n\n## v0.0.5 - 2026-10-01\n\n- older';
    assert.equal(releaseNotes(text, '0.0.6'), '### Changed\n\n- current');
    assert.doesNotThrow(() => validateReleaseTag('v0.0.6', '0.0.6'));
    for (const tag of ['v0.0.5', 'v0.0.6;echo', '0.0.6', 'v0.0.6-rc.1']) assert.throws(() => validateReleaseTag(tag, '0.0.6'));
    assert.throws(() => releaseNotes(text, '9.9.9'));
});

test('development server serves only the generated page and closes cleanly', async () => {
    const server = await startDevServer({ port: 0, watch: false });
    try {
        const page = await fetch(server.url);
        assert.equal(page.status, 200);
        checkHtml(await page.text(), built.version);
        assert.equal((await fetch(`${server.url}/src/app.js`)).status, 404);
        assert.equal((await fetch(server.url, { method: 'POST' })).status, 405);
    } finally {
        await server.close();
    }
});
