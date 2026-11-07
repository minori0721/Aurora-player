import { createAccountRequest } from './account-request.js';
import { coverImageUrl } from '../shared/cover-url.js';
import { classifySongActionError, isDuplicateSongError } from './song-action-errors.js';

const LIKE_LIMIT = 1000;
const BATCH_SIZE = 200;
const LIKE_TTL = 60000;
const UNCERTAIN_ADD_LIMIT = 200;
const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg>';
const COLLECT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v8m-4-4h8M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';

function numericId(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function songInfo(value) {
    if (!value || value.netease === false) return null;
    const id = numericId(typeof value === 'object' ? value.songId ?? value.songData?.id ?? value.id : value);
    return id ? { id, name: String(value.songData?.name ?? value.name ?? '未命名歌曲').slice(0, 300) } : null;
}

function errorText(error) {
    if (error?.uncertain) return '结果未确认，请先检查歌单或喜欢状态再重试。';
    if (error?.apiCode === 301 || error?.status === 401) return '请重新登录。';
    const message = error?.name === 'AccountRequestError' ? error.message : '请求失败，请重试';
    return `${message}${Number.isFinite(error?.apiCode) ? ` (${error.apiCode})` : ''}`;
}

export function createSongActions({ api, auth, cache, myPlaylists, debug } = {}) {
    const request = createAccountRequest({ api, auth });
    const likes = new Map(), checks = new Map(), revisions = new Map(), pending = new Map(), controllers = new Set();
    let generation = 0, identity = null, current = null, initialized = false;
    let picker = null, pickerToken = 0, pickerController = null;
    let messageVersion = 0;

    function context() {
        const snapshot = auth.captureAuthSnapshot();
        const userId = numericId(auth.neteaseUser?.userId);
        if (identity && (!auth.isAuthSnapshotCurrent(identity.snapshot) || identity.userId !== userId)) reset();
        identity = { snapshot, userId, uncertainAdds: identity?.uncertainAdds || new Set() };
        return { snapshot, userId, generation, uncertainAdds: identity.uncertainAdds };
    }

    function isCurrent(ctx) {
        return ctx.generation === generation && ctx.userId === numericId(auth.neteaseUser?.userId)
            && auth.isAuthSnapshotCurrent(ctx.snapshot);
    }

    function signedIn(ctx) { return !!ctx.userId && !!ctx.snapshot.cookie; }
    function known(id) {
        const value = likes.get(id);
        return value && Date.now() - value.at < LIKE_TTL ? value.liked : undefined;
    }

    function trimState() {
        for (const id of likes.keys()) {
            if (likes.size <= LIKE_LIMIT) break;
            if (!pending.has(id) && !checks.has(id)) { likes.delete(id); revisions.delete(id); }
        }
        for (const id of revisions.keys()) if (!likes.has(id) && !checks.has(id) && !pending.has(id)) revisions.delete(id);
    }

    function storeLike(id, liked) {
        likes.delete(id);
        likes.set(id, { liked, at: Date.now() });
        trimState();
    }

    function status(message = '', error = false) {
        const node = document.getElementById('song-action-message');
        if (!node) return;
        node.setAttribute('role', 'status');
        node.setAttribute('aria-live', 'polite');
        node.textContent = message;
        node.hidden = !message;
        node.dataset.error = String(error);
    }

    function paintButton(button, id, like, staticButton = false) {
        const loggedIn = !!auth.neteaseUser && !!auth.neteaseCookie;
        const active = like && known(id) === true;
        const busy = pending.has(id) || (like && checks.has(id));
        button.disabled = !id || busy && document.activeElement !== button;
        button.setAttribute('aria-busy', String(busy));
        button.setAttribute('aria-disabled', String(!id || busy));
        if (like) {
            button.setAttribute('aria-pressed', String(active));
            button.dataset.likeState = known(id) === undefined ? 'unknown' : active ? 'liked' : 'unliked';
        }
        const label = !loggedIn ? '登录后收藏歌曲'
            : like ? active ? '取消喜欢' : '喜欢' : '加入歌单';
        button.title = label;
        button.setAttribute('aria-label', label);
        const text = button.querySelector('[data-song-action-label]');
        if (text) text.textContent = label;
        if (staticButton && !button.querySelector('svg')) button.innerHTML = like ? HEART : COLLECT;
    }

    function refresh(ids = []) {
        const selected = new Set(ids);
        const group = document.getElementById('track-song-actions');
        if (group) group.hidden = !current;
        for (const [id, like] of [['track-like', true], ['track-collect', false]]) {
            const button = document.getElementById(id);
            if (!button) continue;
            button.hidden = !current;
            paintButton(button, current?.id, like, true);
        }
        for (const id of selected) {
            document.querySelectorAll(`[data-song-like="${id}"]`).forEach(button => paintButton(button, id, true));
            document.querySelectorAll(`[data-song-collect="${id}"]`).forEach(button => paintButton(button, id, false));
        }
        if (picker?.dialog.open) {
            picker.list.querySelectorAll('button').forEach(button => { button.disabled = pending.has(picker.song.id); });
        }
    }

    async function ownedRequest(path, data, ctx, signal) {
        if (!isCurrent(ctx)) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (signal?.aborted) controller.abort();
        else signal?.addEventListener('abort', abort, { once: true });
        controllers.add(controller);
        try { return await request(path, data, { signal: controller.signal }); }
        finally { controllers.delete(controller); signal?.removeEventListener('abort', abort); }
    }

    async function checkLikes(ids) {
        const ctx = context();
        const list = [...new Set((Array.isArray(ids) ? ids : []).map(numericId).filter(Boolean))].slice(0, LIKE_LIMIT);
        if (!signedIn(ctx)) { refresh(list); return new Map(); }
        const fresh = list.filter(id => known(id) === undefined && !checks.has(id) && !pending.has(id))
            .slice(0, Math.max(0, LIKE_LIMIT - checks.size));
        const jobs = new Set(list.map(id => checks.get(id)).filter(Boolean));
        for (let offset = 0; offset < fresh.length; offset += BATCH_SIZE) {
            const batch = fresh.slice(offset, offset + BATCH_SIZE);
            const versions = batch.map(id => revisions.get(id) || 0);
            const job = (async () => {
                try {
                    const body = await ownedRequest('/song/like/check', { ids: JSON.stringify(batch) }, ctx);
                    const values = Array.isArray(body.data) ? body.data : body.data?.ids ?? body.ids;
                    if (!Array.isArray(values) || values.some(value => !numericId(value))) throw new Error('Invalid like state');
                    if (!isCurrent(ctx)) return;
                    const liked = new Set(values.map(numericId));
                    batch.forEach((id, index) => {
                        if (versions[index] === (revisions.get(id) || 0)) storeLike(id, liked.has(id));
                    });
                } catch (error) {
                    if (isCurrent(ctx) && error.name !== 'AbortError') status(errorText(error), true);
                } finally {
                    batch.forEach(id => { if (checks.get(id) === job) checks.delete(id); });
                    trimState();
                    if (isCurrent(ctx)) refresh(batch);
                }
            })();
            batch.forEach(id => checks.set(id, job));
            jobs.add(job);
        }
        refresh(list);
        await Promise.all(jobs);
        return isCurrent(ctx) ? new Map(list.filter(id => known(id) !== undefined).map(id => [id, known(id)])) : new Map();
    }

    function invalidate(song, playlistId, liked) {
        const detail = { songId: song.id, playlistId: playlistId || null, liked };
        const warn = () => debug?.log?.('歌曲收藏缓存更新失败', 'warn');
        try {
            const { invalidateSongAccountState } = cache || {};
            Promise.resolve(invalidateSongAccountState?.call(cache, detail)).catch(warn);
        } catch (_) { warn(); }
        try {
            const { invalidateAfterSongWrite } = myPlaylists || {};
            if (typeof invalidateAfterSongWrite === 'function') Promise.resolve(invalidateAfterSongWrite.call(myPlaylists, detail)).catch(warn);
        } catch (_) { warn(); }
    }

    function mutate(song, action, work, onBlocked) {
        const ctx = context();
        if (!song) return Promise.resolve(false);
        if (!signedIn(ctx)) {
            status();
            auth.showLogin?.();
            return Promise.resolve(false);
        }
        if (pending.has(song.id)) {
            const existing = pending.get(song.id);
            if (existing.action !== action) onBlocked?.();
            return existing.action === action ? existing.promise : Promise.resolve(false);
        }
        if (pending.size >= 20) {
            if (onBlocked) onBlocked(); else status('请等待当前收藏操作完成。', true);
            return Promise.resolve(false);
        }
        const version = ++messageVersion;
        // Defer work until the per-song lock has been installed.
        const job = Promise.resolve().then(() => isCurrent(ctx) ? work(ctx, version) : false).finally(() => {
            if (pending.get(song.id)?.promise === job) pending.delete(song.id);
            trimState();
            if (isCurrent(ctx)) refresh([song.id]);
        });
        pending.set(song.id, { action, promise: job });
        refresh([song.id]);
        return job;
    }

    async function writeLike(song, liked, ctx, version, playlistId, onResult) {
        if (!isCurrent(ctx)) return false;
        const previous = likes.get(song.id);
        revisions.set(song.id, (revisions.get(song.id) || 0) + 1);
        storeLike(song.id, liked);
        refresh([song.id]);
        try {
            await ownedRequest('/song/like', { id: song.id, uid: ctx.userId, like: String(liked) }, ctx);
            if (!isCurrent(ctx)) return false;
            invalidate(song, playlistId, liked);
            if (onResult) onResult({ kind: 'added', message: '已收藏到歌单。', error: false, retry: null });
            else if (version === messageVersion) status(liked ? '已喜欢。' : '已取消喜欢。');
            return true;
        } catch (error) {
            if (isCurrent(ctx)) {
                if (previous) likes.set(song.id, previous); else likes.delete(song.id);
                // An uncertain write must be checked again, never blindly inverted on retry.
                if (error.uncertain) likes.delete(song.id);
                if (onResult) onResult(classifySongActionError(error), error);
                else if (version === messageVersion && error.name !== 'AbortError') status(errorText(error), true);
            }
            return false;
        }
    }

    function toggleLike(value) {
        const song = songInfo(value);
        return mutate(song, 'like', async (ctx, version) => {
            if (known(song.id) === undefined) {
                // checkLikes normally skips mutations; perform one joined read before the write.
                const existing = checks.get(song.id);
                if (existing) await existing;
                if (!isCurrent(ctx)) return false;
                if (known(song.id) === undefined) try {
                    const body = await ownedRequest('/song/like/check', { ids: JSON.stringify([song.id]) }, ctx);
                    const values = Array.isArray(body.data) ? body.data : body.data?.ids ?? body.ids;
                    if (!Array.isArray(values) || values.some(id => !numericId(id))) throw new Error('Invalid like state');
                    if (!isCurrent(ctx)) return false;
                    storeLike(song.id, values.map(numericId).includes(song.id));
                } catch (error) {
                    if (isCurrent(ctx) && error.name !== 'AbortError' && version === messageVersion) status(errorText(error), true);
                    return false;
                }
            }
            if (!isCurrent(ctx)) return false;
            return writeLike(song, !known(song.id), ctx, version);
        });
    }

    function writable(list, userId) {
        const result = new Map();
        for (const item of list) {
            const id = numericId(item?.id);
            if (id && numericId(item.creator?.userId) === userId && !result.has(id)) {
                const count = typeof item.trackCount === 'number' || typeof item.trackCount === 'string' && /^\d+$/.test(item.trackCount)
                    ? Number(item.trackCount) : NaN;
                let cover = '';
                try {
                    const url = new URL(coverImageUrl(item.coverImgUrl || '', 100));
                    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) cover = url.href;
                } catch (_) {}
                result.set(id, { id, name: String(item.name || '未命名歌单').slice(0, 300), specialType: Number(item.specialType),
                    cover, trackCount: Number.isSafeInteger(count) && count >= 0 ? count : null });
            }
        }
        return [...result.values()];
    }

    async function loadPlaylists(ctx, signal, onUpdate) {
        const state = await myPlaylists.ensurePlaylists({ signal, onUpdate: state => {
            if (isCurrent(ctx) && !signal?.aborted) onUpdate?.(writable(state.items, ctx.userId), state);
        } });
        if (!isCurrent(ctx) || signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        return writable(state.items, ctx.userId);
    }

    async function playlistContains(song, playlistId, ctx) {
        const body = await ownedRequest('/playlist/detail', { id: playlistId, s: 0 }, ctx);
        const detail = body.playlist ?? body.data?.playlist;
        const countValue = detail?.trackCount;
        const count = typeof countValue === 'number' || typeof countValue === 'string' && /^\d+$/.test(countValue)
            ? Number(countValue) : NaN;
        const ids = detail?.trackIds;
        const incomplete = reason => Object.assign(new Error('暂时无法确认收藏状态。'), {
            name: 'AccountRequestError', kind: 'membership-unconfirmed', reason,
            trackCount: Number.isSafeInteger(count) ? count : null, idCount: Array.isArray(ids) ? ids.length : null
        });
        if (numericId(detail?.id) !== playlistId) throw incomplete('playlist-identity');
        // A positive match needs only this song; absence needs a complete, valid ID list.
        for (const list of [ids, detail.tracks]) {
            if (Array.isArray(list) && list.some(item => numericId(typeof item === 'object' ? item?.id : item) === song.id)) return true;
        }
        if (!Number.isSafeInteger(count) || count < 0 || !Array.isArray(ids) || ids.length !== count
            || body.more === true || detail.more === true) throw incomplete('incomplete-ids');
        const seen = new Set();
        for (const item of ids) {
            const id = numericId(typeof item === 'object' ? item?.id : item);
            if (!id || seen.has(id)) throw incomplete('invalid-ids');
            seen.add(id);
        }
        return false;
    }

    function addToPlaylist(value, pid, { onResult, verifyOnly = false } = {}) {
        const song = songInfo(value), playlistId = numericId(pid);
        if (!playlistId) return Promise.resolve(false);
        const blocked = () => onResult?.({ kind: 'busy', message: '请等待其他收藏操作完成。', error: true, retry: 'retry' });
        return mutate(song, `playlist:${playlistId}`, async (ctx, version) => {
            const key = `${song.id}:${playlistId}`;
            let phase = 'load';
            const report = (result, error) => {
                if (!isCurrent(ctx)) return;
                if (error && result.kind !== 'cancelled') debug?.log?.(
                    `收藏操作：${result.kind}；阶段 ${phase}；HTTP ${Number.isFinite(error.status) ? error.status : '-'}；API ${Number.isFinite(error.apiCode) ? error.apiCode : '-'}${error.kind === 'membership-unconfirmed' ? `；核验 ${error.reason}，数量 ${error.trackCount ?? '-'}，ID 数量 ${error.idCount ?? '-'}` : ''}`, 'warn');
                onResult?.(result);
            };
            const finish = already => {
                if (!isCurrent(ctx)) return false;
                ctx.uncertainAdds.delete(key);
                invalidate(song, playlistId);
                report({ kind: already ? 'already' : 'added', message: already ? '已在歌单中。' : '已收藏到歌单。', error: false, retry: null });
                return true;
            };
            try {
                // A displayed, owned target can be used while remaining catalog pages are loading.
                const known = writable(myPlaylists.myPlaylistsData, ctx.userId).find(item => item.id === playlistId);
                const list = known ? [known] : await loadPlaylists(ctx);
                if (!isCurrent(ctx)) return false;
                const target = list.find(item => item.id === playlistId);
                if (!target) throw new Error('Playlist is not writable');
                phase = 'write';
                if (target.specialType === 5) {
                    if (!verifyOnly) return await writeLike(song, true, ctx, version, playlistId, report);
                    phase = 'check';
                    revisions.set(song.id, (revisions.get(song.id) || 0) + 1);
                    const body = await ownedRequest('/song/like/check', { ids: JSON.stringify([song.id]) }, ctx);
                    const ids = Array.isArray(body.data) ? body.data : body.data?.ids ?? body.ids;
                    if (!Array.isArray(ids) || ids.some(id => !numericId(id))) throw new Error('Invalid like state');
                    if (!isCurrent(ctx)) return false;
                    const liked = ids.map(numericId).includes(song.id);
                    storeLike(song.id, liked);
                    if (liked) return finish(true);
                } else if (verifyOnly || ctx.uncertainAdds.has(key)) {
                    phase = 'check';
                    if (await playlistContains(song, playlistId, ctx)) return finish(true);
                    if (!isCurrent(ctx)) return false;
                    ctx.uncertainAdds.delete(key);
                }
                if (!isCurrent(ctx)) return false;
                if (verifyOnly) {
                    report({ kind: 'absent', message: '歌单中尚无这首歌，可以重新收藏。', error: false, retry: 'retry' });
                    return false;
                }
                phase = 'write';
                if (!ctx.uncertainAdds.has(key) && ctx.uncertainAdds.size >= UNCERTAIN_ADD_LIMIT) {
                    report({ kind: 'busy', message: '待确认的收藏过多，请先检查已有操作。', error: true, retry: null });
                    return false;
                }
                // Reserve before dispatch so concurrent uncertain writes cannot exceed the limit.
                ctx.uncertainAdds.add(key);
                try {
                    await ownedRequest('/playlist/tracks', { op: 'add', pid: playlistId, tracks: String(song.id) }, ctx);
                    return finish(false);
                } catch (error) {
                    if (!isCurrent(ctx)) return false;
                    const outcome = classifySongActionError(error);
                    if (isDuplicateSongError(error) || [502, 512].includes(error.apiCode) && outcome.kind === 'unconfirmed') {
                        report(outcome, error);
                        phase = 'check';
                        if (await playlistContains(song, playlistId, ctx)) return finish(true);
                        if (!isCurrent(ctx)) return false;
                        ctx.uncertainAdds.delete(key);
                        report({ kind: 'absent', message: '歌单中尚无这首歌，可以重新收藏。', error: false, retry: 'retry' });
                        return false;
                    }
                    if (outcome.kind !== 'unconfirmed') ctx.uncertainAdds.delete(key);
                    throw error;
                }
            } catch (error) {
                report(classifySongActionError(error, { checking: phase === 'check', loading: phase === 'load' }), error);
                return false;
            }
        }, blocked);
    }

    function closePicker() {
        pickerToken++;
        pickerController?.abort();
        pickerController = null;
        if (picker?.dialog.open) picker.dialog.close();
    }

    function clearPickerContent() {
        if (!picker) return;
        picker.list.replaceChildren();
        picker.dialog.querySelector('.song-actions-song').textContent = '';
        picker.status.textContent = '';
        picker.retry.hidden = true;
        picker.song = null;
        picker.retryAction = null;
    }

    function ensurePicker() {
        if (picker) return picker;
        const dialog = document.createElement('dialog');
        dialog.className = 'song-actions-dialog';
        dialog.setAttribute('aria-labelledby', 'song-actions-picker-title');
        dialog.setAttribute('aria-describedby', 'song-actions-picker-song');
        dialog.innerHTML = '<header class="song-actions-header"><h2 id="song-actions-picker-title">收藏到歌单</h2><button type="button" class="song-actions-close netease-close" aria-label="关闭" title="关闭">' + CLOSE + '</button></header>'
            + '<p id="song-actions-picker-song" class="song-actions-song"></p><div class="song-actions-list"></div>'
            + '<p class="song-actions-status" role="status" aria-live="polite" aria-atomic="true"></p>'
            + '<button type="button" class="song-actions-retry" hidden>重试</button>';
        document.body.appendChild(dialog);
        picker = { dialog, song: null, returnFocus: null, retryAction: null,
            list: dialog.querySelector('.song-actions-list'), status: dialog.querySelector('.song-actions-status'),
            retry: dialog.querySelector('.song-actions-retry'), close: dialog.querySelector('.song-actions-close') };
        picker.close.addEventListener('click', closePicker);
        dialog.addEventListener('cancel', event => { event.preventDefault(); closePicker(); });
        dialog.addEventListener('close', () => {
            if (dialog.open) return;
            pickerToken++;
            pickerController?.abort();
            pickerController = null;
            clearPickerContent();
            const target = picker.returnFocus;
            if (target?.isConnected && !target.hidden && !target.disabled) target.focus();
            picker.returnFocus = null;
        });
        dialog.addEventListener('click', event => { if (event.target === dialog) closePicker(); });
        picker.retry.addEventListener('click', () => { void picker.retryAction?.(); });
        return picker;
    }

    function pickerStatus(message, error = false, retry = null, label = '重试') {
        picker.status.textContent = message;
        picker.status.dataset.error = String(error);
        picker.retry.hidden = !retry;
        picker.retry.textContent = label;
        picker.retryAction = retry;
    }

    async function openPlaylistPicker(value) {
        const ctx = context(), song = songInfo(value);
        if (!song) return false;
        if (!signedIn(ctx)) {
            status();
            auth.showLogin?.();
            return false;
        }
        closePicker();
        status();
        const view = ensurePicker();
        view.song = song;
        view.returnFocus = document.activeElement;
        view.dialog.querySelector('.song-actions-song').textContent = song.name;
        view.list.replaceChildren();
        const token = ++pickerToken;
        const controller = new AbortController();
        pickerController = controller;
        const valid = () => token === pickerToken && isCurrent(ctx) && !controller.signal.aborted && view.dialog.open;
        let selecting = false;
        const select = async (pid, verifyOnly = false) => {
            if (!valid() || pending.has(song.id)) return;
            selecting = true;
            pickerStatus(verifyOnly ? '正在检查收藏状态...' : '正在收藏...');
            let result;
            const ok = await addToPlaylist(song, pid, { verifyOnly, onResult: value => { result = value; } });
            if (!valid()) return;
            if (ok) closePicker();
            else if (result?.kind !== 'cancelled') {
                const retry = result?.retry || null;
                const action = retry === 'login' ? () => { closePicker(); auth.showLogin?.(); }
                    : retry ? () => select(pid, retry === 'check') : null;
                const label = retry === 'login' ? '重新登录' : retry === 'check' ? '检查收藏状态' : '重新收藏';
                pickerStatus(result?.message || '收藏未完成，请稍后再试。', result?.error !== false, action, label);
                if (action) view.retry.focus();
            }
        };
        const paintPlaylists = (list, state) => {
            if (!valid()) return;
            const existing = new Map([...view.list.children].map(button => [button.dataset.playlistId, button]));
            const wanted = new Set(list.map(item => String(item.id)));
            for (const [id, button] of existing) if (!wanted.has(id)) view.list.removeChild(button);
            list.forEach((item, index) => {
                let button = existing.get(String(item.id));
                if (!button) {
                    button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'song-actions-playlist';
                    button.dataset.playlistId = String(item.id);
                    button.title = item.name;
                    const cover = document.createElement('span');
                    cover.className = 'song-actions-playlist-cover';
                    cover.setAttribute('aria-hidden', 'true');
                    if (item.cover) {
                        const image = document.createElement('img');
                        image.alt = ''; image.width = image.height = 40;
                        image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
                        image.addEventListener('error', () => { image.hidden = true; image.removeAttribute('src'); }, { once: true });
                        image.src = item.cover;
                        cover.appendChild(image);
                    }
                    const info = document.createElement('span'), name = document.createElement('span'), count = document.createElement('span');
                    info.className = 'song-actions-playlist-info';
                    name.className = 'song-actions-playlist-name'; name.textContent = item.name;
                    count.className = 'song-actions-playlist-count';
                    count.hidden = item.trackCount === null;
                    count.textContent = item.trackCount === null ? '' : `${item.trackCount} 首`;
                    info.append(name, count); button.append(cover, info);
                    button.addEventListener('click', () => { void select(item.id); });
                } else {
                    button.title = item.name;
                    button.querySelector('.song-actions-playlist-name').textContent = item.name;
                    const count = button.querySelector('.song-actions-playlist-count');
                    count.hidden = item.trackCount === null;
                    count.textContent = item.trackCount === null ? '' : `${item.trackCount} 首`;
                }
                if (view.list.children[index] !== button) view.list.insertBefore(button, view.list.children[index] || null);
            });
            if (!selecting && !state.error) pickerStatus(state.complete ? list.length ? '' : '暂无可收藏的自建歌单。'
                : list.length ? `已显示 ${list.length} 个歌单，正在继续加载...` : '正在加载歌单...');
            refresh([song.id]);
        };
        const load = async () => {
            if (!valid()) return;
            selecting = false;
            pickerStatus('正在加载歌单...');
            view.list.setAttribute('aria-busy', 'true');
            try {
                await loadPlaylists(ctx, controller.signal, paintPlaylists);
            } catch (error) {
                if (valid() && !selecting && error.name !== 'AbortError') {
                    const result = classifySongActionError(error, { loading: true });
                    const login = result.retry === 'login';
                    pickerStatus(result.message, true, login ? () => { closePicker(); auth.showLogin?.(); }
                        : result.retry ? load : null, login ? '重新登录' : '重试');
                }
            } finally { if (valid()) view.list.setAttribute('aria-busy', 'false'); }
        };
        view.dialog.showModal();
        view.close.focus();
        await load();
        return valid();
    }

    function setCurrentTrack(track) {
        context();
        current = track?.netease === true ? songInfo(track) : null;
        messageVersion++;
        status();
        refresh();
        const selected = current;
        Promise.resolve().then(() => { if (selected && current === selected) void checkLikes([selected.id]); });
    }

    function reset() {
        const resetGeneration = ++generation;
        messageVersion++;
        controllers.forEach(controller => controller.abort());
        controllers.clear();
        closePicker();
        clearPickerContent();
        likes.clear(); checks.clear(); revisions.clear(); pending.clear();
        identity = null; current = null;
        status();
        refresh();
        // Auth calls reset before committing the new user/cookie; do not capture that old identity.
        Promise.resolve().then(() => {
            if (generation !== resetGeneration) return;
            document.querySelectorAll('[data-song-like], [data-song-collect]').forEach(button => {
                paintButton(button, numericId(button.dataset.songLike ?? button.dataset.songCollect), button.dataset.songLike !== undefined);
            });
        });
    }

    function initialize() {
        if (initialized) return;
        initialized = true;
        document.addEventListener('click', event => {
            const button = event.target.closest?.('#track-like, #track-collect, [data-song-like], [data-song-collect]');
            if (!button) return;
            // Capture phase prevents row play handlers and document-level browser dismissal.
            event.preventDefault();
            event.stopImmediatePropagation();
            const ctx = context();
            const isLike = button.id === 'track-like' || button.dataset.songLike !== undefined;
            const song = button.id === 'track-like' || button.id === 'track-collect' ? current
                : songInfo({ id: button.dataset.songLike ?? button.dataset.songCollect, name: button.dataset.songTitle });
            if (!song || button.disabled || button.getAttribute('aria-busy') === 'true') return;
            if (!signedIn(ctx)) {
                status();
                auth.showLogin?.();
                return;
            }
            if (isLike) void toggleLike(song); else void openPlaylistPicker(song);
        }, true);
        document.addEventListener('toggle', event => {
            const menu = event.target;
            if (menu.tagName !== 'DETAILS' || !menu.open) return;
            const ids = [...menu.querySelectorAll('[data-song-like], [data-song-collect]')]
                .map(button => numericId(button.dataset.songLike ?? button.dataset.songCollect)).filter(Boolean);
            if (ids.length) { refresh(ids); void checkLikes(ids); }
        }, true);
        refresh();
    }

    return { initialize, setCurrentTrack, reset, checkLikes, toggleLike, openPlaylistPicker, addToPlaylist };
}
