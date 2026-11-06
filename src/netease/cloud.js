import { createAccountRequest, normalizeApiBody } from './account-request.js';
import { createCloudPreparation } from './cloud-preparation.js';
import { coverImageUrl } from '../shared/cover-url.js';

const RETAIN_MS = 5 * 60_000;
const TERMINAL = new Set(['done', 'cancelled']);
const LABELS = { queued: '等待处理', importing: '尝试直接导入', downloading: '获取音频', preparing: '整理歌曲信息',
    confirmation: '请确认文件信息', token: '获取上传凭证', uploading: '上传音频', completing: '完成云盘入库',
    verifying: '确认云盘结果', done: '已存入音乐云盘', error: '任务未完成', cancelled: '已取消' };

export function musicCloudSong(value) {
    const song = value.songData || value;
    const id = Number(value.songId || song.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('歌曲 ID 无效');
    return { id, song: String(song.name || value.name || '未命名歌曲'),
        artist: (song.ar || song.artists || []).map(artist => artist.name).filter(Boolean).join(', '),
        album: String((song.al || song.album)?.name || ''), cover: (song.al || song.album)?.picUrl || '' };
}

export function cloudSongId(payload) {
    if (!payload || typeof payload !== 'object') return 0;
    const roots = [payload, payload.data, payload.data?.data, payload.privateCloud, payload.data?.privateCloud];
    for (const root of roots) {
        const entries = Array.isArray(root) ? root : [root];
        for (const entry of entries) {
            const id = Number(entry?.songId);
            if (Number.isSafeInteger(id) && id > 0) return id;
        }
    }
    return 0;
}

export function canImportCloudAudio(audio, source) {
    return !source && /^[a-f\d]{32}$/i.test(audio?.md5 || '') && Number(audio.size) > 0 && Number(audio.br) > 0
        && ['mp3', 'flac'].includes(String(audio.type || '').toLowerCase());
}

function allowsFileFallback(error) {
    if (error.uncertain || [301, 302, 401, 403, 429].includes(Number(error.apiCode || error.status))) return false;
    if (/容量|空间|配额|频繁|限制|登录|权限|quota|limit/i.test(error.message)) return false;
    return [404, 405, 501].includes(Number(error.apiCode || error.status)) || /不能导入|不可导入|不支持.*导入|需要上传|need.?upload/i.test(error.message);
}

export function validateCloudUploadUrl(raw) {
    const url = new URL(raw);
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || url.username || url.password || !/(^|\.)(127|126)\.net$/i.test(url.hostname)) {
        throw new Error('云盘上传地址不受支持');
    }
    return url.href;
}

export async function fetchCloudBlob(url, { signal, maxBytes, onProgress = () => {}, fetcher = fetch } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    signal?.addEventListener('abort', abort, { once: true });
    let timer, timedOut = false;
    const arm = ms => {
        clearTimeout(timer);
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
    };
    try {
        arm(15_000);
        const response = await fetcher(url, { signal: controller.signal, credentials: 'omit' });
        if (!response.ok) {
            try { await response.body?.cancel(); } catch (_) {}
            throw Object.assign(new Error(`音频获取失败（HTTP ${response.status}）`), { status: response.status });
        }
        const length = Number(response.headers.get('content-length')) || 0;
        if (length > maxBytes) { await response.body?.cancel(); throw new Error('文件超过当前设备的临时上传上限'); }
        arm(20_000);
        if (!response.body?.getReader) {
            const blob = await response.blob();
            if (blob.size > maxBytes) throw new Error('文件超过当前设备的临时上传上限');
            return blob;
        }
        const reader = response.body.getReader();
        let size = 0;
        const stream = new ReadableStream({
            async pull(output) {
                try {
                    const part = await reader.read();
                    if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
                    if (part.done) { output.close(); return; }
                    size += part.value.byteLength;
                    if (size > maxBytes) throw new Error('文件超过当前设备的临时上传上限');
                    arm(20_000); onProgress(size, length); output.enqueue(part.value);
                } catch (error) { output.error(error); void reader.cancel().catch(() => {}); }
            },
            cancel(reason) { return reader.cancel(reason); }
        });
        return await new Response(stream, { headers: { 'Content-Type': response.headers.get('content-type') || '' } }).blob();
    } catch (error) {
        controller.abort();
        if (timedOut) throw new Error('获取音频超时，请重试');
        throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export function uploadCloudBlob(blob, data, { signal, onProgress = () => {} } = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('已取消', 'AbortError'));
        const xhr = new XMLHttpRequest();
        const abort = () => xhr.abort();
        let timer;
        const arm = () => { clearTimeout(timer); timer = setTimeout(() => xhr.abort(), 30_000); };
        const finish = error => {
            clearTimeout(timer); signal?.removeEventListener('abort', abort);
            error ? reject(error) : resolve();
        };
        xhr.open('POST', validateCloudUploadUrl(data.uploadUrl));
        xhr.withCredentials = false; xhr.timeout = 10 * 60_000;
        xhr.setRequestHeader('x-nos-token', data.uploadToken);
        xhr.setRequestHeader('Content-MD5', data.md5);
        xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
        xhr.upload.onprogress = event => { arm(); onProgress(event.loaded, event.total || blob.size); };
        xhr.onload = () => finish(xhr.status >= 200 && xhr.status < 300 ? null :
            Object.assign(new Error(`云盘文件上传失败（HTTP ${xhr.status}）`), { status: xhr.status }));
        xhr.onerror = () => finish(new Error('云盘上传连接失败，请重试'));
        xhr.ontimeout = () => finish(new Error('云盘上传超时，请重试'));
        xhr.onabort = () => finish(signal?.aborted ? new DOMException('已取消', 'AbortError') : new Error('云盘上传长时间无进展，请重试'));
        signal?.addEventListener('abort', abort, { once: true }); arm(); xhr.send(blob);
    });
}

export function createCloud({ api, auth, debug, download, resolver, playback, cloudWorkerSource = '',
    prepare = createCloudPreparation(cloudWorkerSource), fetcher = fetch, upload = uploadCloudBlob, accountRequest } = {}) {
    const request = accountRequest || createAccountRequest({ api, auth });
    const tasks = [], nodes = new Map();
    let active = null, sequence = 0, initialized = false;
    const current = task => !task.controller.signal.aborted && auth.isAuthSnapshotCurrent(task.account);
    const guard = task => { if (!current(task)) throw new DOMException('账号已改变或任务已取消', 'AbortError'); };
    const post = async (task, path, body) => {
        guard(task);
        const result = await request(path, body, { signal: task.controller.signal });
        guard(task); return normalizeApiBody(result);
    };
    const release = task => {
        clearTimeout(task.releaseTimer); task.releaseTimer = 0;
        task.raw = task.prepared = task.token = null;
    };
    function update(task, status = task.status, message = task.message || '') {
        task.status = status; task.message = message;
        render();
    }
    function progress(task, loaded, total) {
        task.progress = total > 0 ? Math.min(1, loaded / total) : null;
        const now = performance.now();
        if (now - task.lastProgressAt > 100) { task.lastProgressAt = now; render(); }
    }
    async function verify(task) {
        update(task, 'verifying', '');
        const payload = task.cloudId
            ? await post(task, '/user/cloud/detail', { id: String(task.cloudId) })
            : await post(task, '/user/cloud', { limit: 100, offset: 0 });
        const records = Array.isArray(payload.data) ? payload.data : [];
        const expectedSize = task.registration?.fileSize || task.prepared?.blob.size || Number(task.audio.size);
        const found = records.find(record => {
            if (task.cloudId) return Number(record.songId) === task.cloudId;
            if (!(expectedSize > 0) || Number(record.fileSize) !== expectedSize) return false;
            if (Number(record.simpleSong?.id) === task.song.id) return true;
            const metadata = task.registration?.metadata || task.prepared?.metadata;
            return metadata && record.fileName === task.filename && record.songName === metadata.song
                && record.artist === metadata.artist;
        });
        if (!found) {
            task.canRestart = true;
            throw Object.assign(new Error('暂未确认云盘入库结果。重试只检查结果，不会重复上传'), { uncertain: true });
        }
        if (expectedSize > 0 && Number(found.fileSize) > 0 && Number(found.fileSize) !== expectedSize) {
            throw Object.assign(new Error('云盘返回的文件大小不匹配，请先检查云盘中的歌曲'), { uncertain: true });
        }
        task.cloudId = Number(found.songId); task.phase = 'done';
        task.controller = new AbortController();
        release(task); task.registration = null; update(task, 'done', task.note || '');
    }
    async function getFile(task) {
        if (task.raw) return;
        if (!task.source) {
            task.raw = playback?.getEncodedAudioForCloud?.({ songId: task.song.id, md5: task.audio.md5, size: task.audio.size }) || null;
            if (task.raw) return;
        }
        update(task, 'downloading', '');
        const compact = typeof matchMedia === 'function' && matchMedia('(max-width: 700px)').matches;
        const maxBytes = (compact || Number(navigator.deviceMemory) > 0 && Number(navigator.deviceMemory) <= 4 ? 64 : 128) * 1024 * 1024;
        while (true) {
            try {
                task.raw = await fetchCloudBlob(task.audio.url, { fetcher, signal: task.controller.signal, maxBytes,
                    onProgress: (loaded, total) => progress(task, loaded, total) });
                guard(task); return;
            } catch (error) {
                guard(task);
                if (task.refreshed || ![401, 403, 404, 410].includes(Number(error.status))) throw error;
                task.refreshed = true;
                if (task.source) {
                    const result = await resolver.fetchNeteaseMatchAudio(task.song.id,
                        { signal: task.controller.signal, cacheScope: 'none' }, 0, [task.source], task.level);
                    if (!result.audioUrl) throw new Error('音源地址已失效，请重新检测');
                    task.audio = { url: result.audioUrl };
                } else {
                    const result = await post(task, '/song/download/url/v1', { id: task.song.id, level: task.level });
                    if (!result.data?.url || resolver.isNeteaseTrialOnly(result.data)) throw new Error('没有可上传的完整音频');
                    task.audio = result.data;
                }
            }
        }
    }
    async function prepareFile(task) {
        if (task.prepared) return;
        await getFile(task);
        update(task, 'preparing', '');
        const metadata = { song: task.song.song, artist: task.song.artist, album: task.song.album };
        if (task.song.cover && !task.skipCover) {
            try {
                const blob = await fetchCloudBlob(coverImageUrl(task.song.cover, 600),
                    { fetcher, signal: task.controller.signal, maxBytes: 1024 * 1024 });
                if (!['image/jpeg', 'image/png'].includes(blob.type.split(';')[0])) throw new Error('封面不是 JPEG 或 PNG');
                metadata.cover = new Uint8Array(await blob.arrayBuffer()); metadata.coverType = blob.type.split(';')[0];
            } catch (error) {
                guard(task);
                task.coverFailed = true;
                throw new Error('封面获取失败，可以重试或选择不带新封面继续');
            }
        }
        task.prepared = await prepare(task.raw, metadata, { signal: task.controller.signal,
            onProgress: value => progress(task, Number(value.loaded || 0), Number(value.total || 0)) });
        guard(task); task.raw = null; task.coverFailed = false;
    }
    async function run(task) {
        active = task; clearTimeout(task.releaseTimer); task.releaseTimer = 0;
        try {
            guard(task);
            if (task.phase === 'import') {
                update(task, 'importing', ''); task.phase = 'verify-import';
                try {
                    const result = await post(task, '/cloud/import', { id: task.song.id, song: task.song.song,
                        artist: task.song.artist, album: task.song.album, fileType: task.audio.type,
                        fileSize: task.audio.size, bitrate: Math.floor(task.audio.br / 1000), md5: task.audio.md5 });
                    task.cloudId = cloudSongId(result);
                } catch (error) {
                    if (!allowsFileFallback(error)) {
                        if (!error.uncertain) task.phase = 'import';
                        throw error;
                    }
                    task.phase = 'file';
                }
            }
            if (task.phase === 'file') {
                await prepareFile(task);
                if (task.prepared.conflicts?.length && !task.confirmed) {
                    update(task, 'confirmation', task.prepared.conflicts.join('；'));
                    return;
                }
                task.phase = 'token';
            }
            if (task.phase === 'token') {
                update(task, 'token', '');
                const metadata = task.prepared.metadata || task.song;
                task.filename = `${metadata.song || task.song.song} - ${metadata.artist || task.song.artist}`
                    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 160) + `.${task.prepared.type}`;
                const result = await post(task, '/cloud/upload/token', { md5: task.prepared.md5, fileSize: task.prepared.blob.size,
                    filename: task.filename, bitrate: task.prepared.bitrate || 999000 });
                task.token = result.data;
                if (!task.token || !task.token.resourceId || task.token.songId === undefined) throw new Error('上传凭证不完整，请重试');
                if (![true, false, 0, 1].includes(task.token.needUpload)) throw new Error('上传凭证缺少文件状态');
                task.phase = task.token.needUpload ? 'upload' : 'complete';
            }
            if (task.phase === 'upload') {
                update(task, 'uploading', '');
                await upload(task.prepared.blob, { ...task.token, md5: task.prepared.md5 }, {
                    signal: task.controller.signal, onProgress: (loaded, total) => progress(task, loaded, total)
                });
                guard(task); task.phase = 'complete';
            }
            if (task.phase === 'complete') {
                update(task, 'completing', '');
                if (!task.registration) {
                    task.registration = { songId: String(task.token.songId), resourceId: task.token.resourceId,
                        md5: task.prepared.md5, fileSize: task.prepared.blob.size,
                        metadata: task.prepared.metadata || task.song, bitrate: task.prepared.bitrate || 999000 };
                    release(task);
                }
                const registration = task.registration;
                const metadata = registration.metadata;
                task.phase = 'verify-upload';
                try {
                    const result = await post(task, '/cloud/upload/complete', { songId: registration.songId,
                        resourceId: registration.resourceId, md5: registration.md5, filename: task.filename,
                        song: metadata.song, artist: metadata.artist, album: metadata.album,
                        bitrate: registration.bitrate });
                    task.cloudId = cloudSongId(result);
                } catch (error) {
                    if (!error.uncertain && !task.cancelledWrite && !task.controller.signal.aborted) task.phase = 'complete';
                    throw error;
                }
            }
            await verify(task);
        } catch (error) {
            if (!current(task)) {
                release(task);
                if (task.cancelledWrite && auth.isAuthSnapshotCurrent(task.account)) {
                    update(task, 'error', '请求已停止，入库结果未确认。重试只检查云盘，不会重复上传');
                } else update(task, 'cancelled', '');
            }
            else {
                task.uncertain = !!error.uncertain;
                update(task, 'error', error.message || '云盘任务失败，请重试');
                debug.log('云盘任务未完成：' + task.message, 'warn');
            }
        } finally {
            if (!TERMINAL.has(task.status) && (task.prepared || task.raw)) {
                task.releaseTimer = setTimeout(() => {
                    release(task);
                    if (['file', 'token', 'upload', 'complete'].includes(task.phase)) task.phase = 'file';
                    render(); pump();
                }, RETAIN_MS);
            }
            active = null; render(); pump();
        }
    }
    function pump() {
        if (active || tasks.some(task => (task.prepared || task.raw) && !TERMINAL.has(task.status))) return;
        const next = tasks.find(task => task.status === 'queued');
        if (next) void run(next);
    }
    async function start(input) {
        if (!auth.neteaseUser || !auth.neteaseCookie) { auth.showLogin(); return null; }
        const song = musicCloudSong(input);
        const key = `${auth.authGeneration}|${song.id}|${input.level}|${input.source || ''}`;
        if (tasks.some(task => task.key === key && !TERMINAL.has(task.status))) return null;
        if (tasks.filter(task => !TERMINAL.has(task.status)).length >= 10) throw new Error('待处理任务已满，请先完成当前任务');
        if (!input.audioInfo?.url) throw new Error('请先检测可用音源');
        const task = { id: ++sequence, key, song, audio: { ...input.audioInfo }, level: input.level, source: input.source || '',
            account: auth.captureAuthSnapshot(), controller: new AbortController(),
            status: 'queued', phase: canImportCloudAudio(input.audioInfo, input.source) ? 'import' : 'file',
            progress: null, lastProgressAt: -Infinity, message: '', raw: null, prepared: null, token: null, cloudId: 0 };
        tasks.push(task);
        while (tasks.length > 12) {
            const index = tasks.findIndex(item => TERMINAL.has(item.status));
            if (index < 0) break;
            const [removed] = tasks.splice(index, 1); nodes.get(removed.id)?.root.remove(); nodes.delete(removed.id);
        }
        render(); pump(); return task.id;
    }
    function cancel(id) {
        const task = tasks.find(task => task.id === id);
        if (!task || TERMINAL.has(task.status)) return;
        const dispatched = ['verify-import', 'verify-upload'].includes(task.phase);
        task.cancelledWrite = dispatched;
        task.controller.abort(); release(task);
        if (dispatched) update(task, 'error', '请求已停止，入库结果未确认。重试只检查云盘，不会重复上传');
        else { task.registration = null; update(task, 'cancelled', ''); }
        pump();
    }
    function retry(id, { confirmed = false, skipCover = false, restart = false } = {}) {
        const task = tasks.find(task => task.id === id);
        if (!task || active || !['error', 'confirmation'].includes(task.status)) return;
        if (!auth.isAuthSnapshotCurrent(task.account)) { cancel(id); return; }
        if (restart) {
            if (!task.canRestart) return;
            release(task); task.registration = null; task.cloudId = 0; task.canRestart = task.cancelledWrite = false;
            task.phase = canImportCloudAudio(task.audio, task.source) ? 'import' : 'file';
        }
        task.confirmed ||= confirmed; task.skipCover ||= skipCover; task.controller = new AbortController();
        void run(task);
    }
    function reset() {
        for (const task of tasks) { task.controller.abort(); release(task); task.registration = null; }
        tasks.length = 0; nodes.clear();
        document.getElementById('cloud-task-status')?.replaceChildren(); render();
    }
    function render() {
        if (!initialized) return;
        const root = document.getElementById('cloud-task-status');
        const launcher = document.getElementById('cloud-task-open');
        if (launcher) {
            launcher.hidden = !tasks.length;
            document.getElementById('cloud-task-label').textContent = tasks.some(task => !TERMINAL.has(task.status)) ? '云盘任务' : '云盘结果';
        }
        if (!root) return;
        for (const task of tasks) {
            let node = nodes.get(task.id);
            if (!node) {
                const element = document.createElement('div'); element.className = 'cloud-task';
                const title = document.createElement('strong'), status = document.createElement('span'), progressEl = document.createElement('progress');
                status.setAttribute('role', 'status'); progressEl.max = 1; progressEl.setAttribute('aria-label', '云盘任务进度');
                const actions = document.createElement('div'); actions.className = 'cloud-task-actions';
                const button = (label, action) => {
                    const element = document.createElement('button'); element.type = 'button'; element.className = 'glass-btn';
                    element.textContent = label; element.onclick = action; actions.appendChild(element); return element;
                };
                const cancelButton = button('取消', () => cancel(task.id));
                const retryButton = button('重试', () => retry(task.id));
                const confirmButton = button('使用文件信息继续', () => retry(task.id, { confirmed: true }));
                const skipButton = button('不带新封面继续', () => retry(task.id, { skipCover: true }));
                const restartButton = button('已检查云盘，重新处理', () => {
                    if (confirm('请确认已在网易云云盘检查过，该文件未入库。重新处理可能产生重复记录，继续吗？')) retry(task.id, { restart: true });
                });
                const matchButton = button('关联原歌曲', () => void matchOriginal(task));
                element.append(title, status, progressEl, actions); root.appendChild(element);
                node = { root: element, title, status, progress: progressEl, cancelButton, retryButton, confirmButton, skipButton, restartButton, matchButton };
                nodes.set(task.id, node);
            }
            node.title.textContent = task.song.song;
            node.status.textContent = `${LABELS[task.status]}${task.message ? ' · ' + task.message : ''}`;
            node.progress.hidden = !['downloading', 'preparing', 'uploading'].includes(task.status);
            if (task.progress === null) node.progress.removeAttribute('value'); else node.progress.value = task.progress;
            node.cancelButton.hidden = TERMINAL.has(task.status);
            node.retryButton.hidden = task.status !== 'error'; node.retryButton.disabled = !!active;
            node.confirmButton.hidden = task.status !== 'confirmation'; node.confirmButton.disabled = !!active;
            node.skipButton.hidden = task.status !== 'error' || !task.coverFailed; node.skipButton.disabled = !!active;
            node.restartButton.hidden = task.status !== 'error' || !task.canRestart; node.restartButton.disabled = !!active;
            node.matchButton.hidden = task.status !== 'done' || !task.source || !!task.matched;
            node.matchButton.disabled = !!task.matching;
        }
    }
    async function matchOriginal(task) {
        if (task.matching || !auth.isAuthSnapshotCurrent(task.account)) return;
        if (!confirm(`将云盘文件关联为“${task.song.song}”？请确认音频版本一致。`)) return;
        task.matching = true; render();
        try {
            await post(task, '/cloud/match', { uid: auth.neteaseUser.userId, sid: task.cloudId, asid: task.song.id });
            task.matched = true; update(task, 'done', '已关联原歌曲');
        } catch (_) { update(task, 'done', '歌曲已入库，关联未成功，可稍后重试'); }
        finally { task.matching = false; render(); }
    }
    return { start, cancel, retry, reset,
        getSnapshot: () => tasks.map(task => ({ id: task.id, songId: task.song.id, status: task.status, phase: task.phase,
            cloudId: task.cloudId, hasFile: !!(task.raw || task.prepared), message: task.message })),
        initialize() {
            if (initialized) return;
            initialized = true;
            document.getElementById('cloud-task-open')?.addEventListener('click', () => download.openCloudTasks());
            render();
        }
    };
}
