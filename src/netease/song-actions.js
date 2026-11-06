import { createAccountRequest } from './account-request.js';

const LIKE_LIMIT = 1000;
const BATCH_SIZE = 200;
const PLAYLIST_LIMIT = 3000;
const PAGE_SIZE = 30;
const LIKE_TTL = 60000;
const PLAYLIST_TTL = 60000;
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
    let picker = null, pickerToken = 0, pickerController = null, playlistJob = null, playlistState = null;
    let playlistVersion = 0, messageVersion = 0;

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
        playlistVersion++;
        playlistState = null;
        const detail = { songId: song.id, playlistId: playlistId || null, liked };
        const warn = () => debug?.log?.('歌曲收藏缓存更新失败', 'warn');
        try {
            const { invalidateSongAccountState } = cache || {};
            Promise.resolve(invalidateSongAccountState?.call(cache, detail)).catch(warn);
        } catch (_) { warn(); }
        try {
            const { invalidateAfterSongWrite } = myPlaylists || {};
            if (typeof invalidateAfterSongWrite === 'function') Promise.resolve(invalidateAfterSongWrite.call(myPlaylists, detail)).catch(warn);
            else if (myPlaylists) myPlaylists.myPlaylistsCache = null;
        } catch (_) { warn(); }
    }

    function mutate(song, action, work) {
        const ctx = context();
        if (!song) return Promise.resolve(false);
        if (!signedIn(ctx)) {
            status();
            auth.showLogin?.();
            return Promise.resolve(false);
        }
        if (pending.has(song.id)) {
            const existing = pending.get(song.id);
            return existing.action === action ? existing.promise : Promise.resolve(false);
        }
        if (pending.size >= 20) { status('请等待当前收藏操作完成。', true); return Promise.resolve(false); }
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

    async function writeLike(song, liked, ctx, version, playlistId) {
        if (!isCurrent(ctx)) return false;
        const previous = likes.get(song.id);
        revisions.set(song.id, (revisions.get(song.id) || 0) + 1);
        storeLike(song.id, liked);
        refresh([song.id]);
        try {
            await ownedRequest('/song/like', { id: song.id, uid: ctx.userId, like: String(liked) }, ctx);
            if (!isCurrent(ctx)) return false;
            invalidate(song, playlistId, liked);
            if (version === messageVersion) status(liked ? '已喜欢。' : '已取消喜欢。');
            return true;
        } catch (error) {
            if (isCurrent(ctx)) {
                if (previous) likes.set(song.id, previous); else likes.delete(song.id);
                // An uncertain write must be checked again, never blindly inverted on retry.
                if (error.uncertain) likes.delete(song.id);
                if (version === messageVersion && error.name !== 'AbortError') status(errorText(error), true);
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
                result.set(id, { id, name: String(item.name || '未命名歌单').slice(0, 300), specialType: Number(item.specialType) });
            }
        }
        return [...result.values()];
    }

    async function loadPlaylists(ctx, signal) {
        if (playlistState && Date.now() - playlistState.at < PLAYLIST_TTL) return playlistState.list;
        if (playlistJob && !playlistJob.signal?.aborted) return playlistJob.promise;
        const job = { signal, version: playlistVersion };
        job.promise = (async () => {
            // A rendered cache may contain a partial/error page, so it is not a completeness signal.
            const shared = Array.isArray(myPlaylists?.myPlaylistsData) ? myPlaylists.myPlaylistsData : [];
            const list = new Map(shared.slice(0, PLAYLIST_LIMIT).map(item => [numericId(item?.id), item]).filter(([id]) => id));
            const { myPlaylistsComplete = false } = myPlaylists || {};
            const complete = myPlaylistsComplete === true && !myPlaylists?.myPlaylistsLoading;
            if (!complete) {
                // Recheck a partial last page; never skip unseen rows after a partial load.
                let offset = Math.floor(Math.min(shared.length, PLAYLIST_LIMIT - PAGE_SIZE) / PAGE_SIZE) * PAGE_SIZE;
                while (offset < PLAYLIST_LIMIT) {
                    const body = await ownedRequest('/user/playlist', { uid: ctx.userId, limit: PAGE_SIZE, offset }, ctx, signal);
                    if (!isCurrent(ctx) || signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
                    if (!Array.isArray(body.playlist)) throw new Error('Invalid playlists');
                    const page = body.playlist;
                    if (page.length > PAGE_SIZE) throw new Error('Invalid playlist page');
                    let added = 0;
                    for (const item of page) {
                        const id = numericId(item?.id);
                        if (id) {
                            if (!list.has(id)) {
                                if (list.size >= PLAYLIST_LIMIT) throw new Error('Too many playlists');
                                added++;
                            }
                            list.set(id, item);
                        }
                    }
                    const more = body.more === true || (body.more === undefined && page.length >= PAGE_SIZE);
                    if (!more) break;
                    if (!page.length || (offset > 0 && !added) || offset + page.length >= PLAYLIST_LIMIT) throw new Error('Incomplete playlists');
                    offset += page.length;
                }
            }
            if (!isCurrent(ctx) || signal?.aborted || job.version !== playlistVersion) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
            const own = writable([...list.values()], ctx.userId).slice(0, PLAYLIST_LIMIT);
            playlistState = { list: own, at: Date.now() };
            return own;
        })().finally(() => { if (playlistJob === job) playlistJob = null; });
        playlistJob = job;
        return job.promise;
    }

    async function playlistContains(song, playlistId, ctx) {
        const body = await ownedRequest('/playlist/detail', { id: playlistId, s: 0 }, ctx);
        const detail = body.playlist ?? body.data?.playlist;
        const countValue = detail?.trackCount;
        const count = typeof countValue === 'number' || typeof countValue === 'string' && /^\d+$/.test(countValue)
            ? Number(countValue) : NaN;
        const ids = detail?.trackIds;
        const incomplete = () => Object.assign(new Error('无法确认完整歌单，未再次提交收藏，请稍后重试。'), { name: 'AccountRequestError' });
        if (!Number.isSafeInteger(count) || count < 0 || !Array.isArray(ids) || ids.length !== count
            || body.more === true || detail.more === true
            || detail.id !== undefined && numericId(detail.id) !== playlistId) throw incomplete();
        const seen = new Set();
        let contains = false;
        for (const item of ids) {
            const id = numericId(typeof item === 'object' ? item?.id : item);
            if (!id || seen.has(id)) throw incomplete();
            seen.add(id);
            if (id === song.id) contains = true;
        }
        return contains;
    }

    function addToPlaylist(value, pid) {
        const song = songInfo(value), playlistId = numericId(pid);
        if (!playlistId) return Promise.resolve(false);
        return mutate(song, `playlist:${playlistId}`, async (ctx, version) => {
            const key = `${song.id}:${playlistId}`;
            const finish = already => {
                if (!isCurrent(ctx)) return false;
                ctx.uncertainAdds.delete(key);
                invalidate(song, playlistId);
                if (version === messageVersion) status(already ? '已在歌单中。' : '已收藏到歌单。');
                return true;
            };
            try {
                const list = await loadPlaylists(ctx);
                if (!isCurrent(ctx)) return false;
                const target = list.find(item => item.id === playlistId);
                if (!target) throw new Error('Playlist is not writable');
                if (target.specialType === 200) return await writeLike(song, true, ctx, version, playlistId);
                if (ctx.uncertainAdds.has(key) && await playlistContains(song, playlistId, ctx)) return finish(true);
                if (!isCurrent(ctx)) return false;
                if (!ctx.uncertainAdds.has(key) && ctx.uncertainAdds.size >= UNCERTAIN_ADD_LIMIT) {
                    if (version === messageVersion) status('待确认的收藏过多，请先重试已有操作。', true);
                    return false;
                }
                // Reserve before dispatch so concurrent uncertain writes cannot exceed the limit.
                ctx.uncertainAdds.add(key);
                try {
                    await ownedRequest('/playlist/tracks', { op: 'add', pid: playlistId, tracks: String(song.id) }, ctx);
                    return finish(false);
                } catch (error) {
                    if (!isCurrent(ctx)) return false;
                    const duplicate = [502, 512].includes(error.apiCode)
                        || /重复|已存在|已在歌单|already\s+(?:exists?|in|added|collected)|duplicate|\brepeat(?:ed)?\b/i.test(error.message || '');
                    if (duplicate) {
                        if (await playlistContains(song, playlistId, ctx)) return finish(true);
                        if (!isCurrent(ctx)) return false;
                    }
                    if (!error.uncertain) ctx.uncertainAdds.delete(key);
                    throw error;
                }
            } catch (error) {
                if (isCurrent(ctx) && version === messageVersion && error.name !== 'AbortError') status(errorText(error), true);
                return false;
            }
        });
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
        dialog.innerHTML = '<header class="song-actions-header"><h2 id="song-actions-picker-title">收藏到歌单</h2><button type="button" class="song-actions-close" aria-label="关闭" title="关闭">' + CLOSE + '</button></header>'
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

    function pickerStatus(message, error = false, retry = null) {
        picker.status.textContent = message;
        picker.status.dataset.error = String(error);
        picker.retry.hidden = !retry;
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
        const view = ensurePicker();
        view.song = song;
        view.returnFocus = document.activeElement;
        view.dialog.querySelector('.song-actions-song').textContent = song.name;
        view.list.replaceChildren();
        const token = ++pickerToken;
        const controller = new AbortController();
        pickerController = controller;
        const valid = () => token === pickerToken && isCurrent(ctx) && !controller.signal.aborted && view.dialog.open;
        const select = async pid => {
            if (!valid() || pending.has(song.id)) return;
            pickerStatus('正在收藏...');
            const ok = await addToPlaylist(song, pid);
            if (!valid()) return;
            if (ok) closePicker();
            else { pickerStatus('收藏未完成，请先检查歌单再重试。', true, () => select(pid)); view.retry.focus(); }
        };
        const load = async () => {
            if (!valid()) return;
            pickerStatus('正在加载歌单...');
            view.list.setAttribute('aria-busy', 'true');
            try {
                const list = await loadPlaylists(ctx, controller.signal);
                if (!valid()) return;
                view.list.replaceChildren();
                list.forEach(item => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'song-actions-playlist';
                    button.dataset.playlistId = String(item.id);
                    button.textContent = item.name;
                    button.addEventListener('click', () => { void select(item.id); });
                    view.list.appendChild(button);
                });
                pickerStatus(list.length ? '' : '暂无可收藏的自建歌单。');
                refresh([song.id]);
            } catch (error) {
                if (valid() && error.name !== 'AbortError') pickerStatus(errorText(error), true, load);
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
        if (current) void checkLikes([current.id]);
    }

    function reset() {
        const resetGeneration = ++generation;
        messageVersion++;
        playlistVersion++;
        controllers.forEach(controller => controller.abort());
        controllers.clear();
        closePicker();
        clearPickerContent();
        likes.clear(); checks.clear(); revisions.clear(); pending.clear();
        playlistState = null; playlistJob = null; identity = null; current = null;
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
