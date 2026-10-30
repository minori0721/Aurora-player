import { cleanCookie, toHttps } from '../shared/text.js';
import { positiveMusicInteger } from './routes.js';
import { normalizeMusicSong } from './models.js';

const DETAIL_MAX_AGE = 5 * 60_000;
const DETAIL_BATCH_SIZE = 64;

function normalizeSource(source) {
    const id = positiveMusicInteger(source?.id, 0);
    return source?.type === 'netease-playlist' && id ? {
        type: 'netease-playlist', id: String(id),
        loadedCount: Math.max(0, Number(source.loadedCount) || 0),
        totalCount: Math.max(0, Number(source.totalCount) || 0), loading: !!source.loading
    } : null;
}

function songPresentation(song) {
    const normalized = normalizeMusicSong(song || {});
    return JSON.stringify([normalized.name, normalized.artists, normalized.album, normalized.durationMs]);
}

export function createPlaylistSync({
    api, auth, cache, content, covers, debug, dom, lyrics, metadata,
    persistence, playback, playlistView, prefetch, queue, transfer
} = {}) {
    let binding = null;
    let request = null;
    let temporaryCurrent = null;
    const baseQueue = () => queue.basePlaylist || queue.playlist;
    const baseIndex = () => queue.baseCurIdx ?? queue.curIdx;

    function bound() {
        return binding && binding.queue === baseQueue() && binding.entries.length === baseQueue().length
            && binding.entries.every((entry, index) => entry === baseQueue()[index]
                && entry.netease && Number(entry.songId) === binding.ids[index]);
    }

    function remember(source, queueRef = baseQueue()) {
        request?.abort();
        request = null;
        temporaryCurrent = null;
        const normalized = normalizeSource(source);
        binding = normalized && queueRef === baseQueue() && queueRef.every(track => track.netease && positiveMusicInteger(track.songId, 0))
            ? { source: normalized, queue: queueRef, entries: queueRef.slice(), ids: queueRef.map(track => Number(track.songId)) } : null;
    }

    function getSource() {
        if (!bound()) {
            request?.abort();
            binding = null;
            temporaryCurrent = null;
        }
        return binding ? { ...binding.source } : null;
    }

    function updateBinding() {
        binding.entries = baseQueue().slice();
        binding.ids = baseQueue().map(track => Number(track.songId));
    }

    function refreshCurrent(previousCover) {
        const current = queue.playlist[queue.curIdx];
        if (!current?.songData) return;
        const song = normalizeMusicSong(current.songData);
        dom.el.title.textContent = song.name;
        content.setMainMusicEntityLinks(song.songData);
        lyrics.setArtistTag('网易云', metadata.currentAudioQuality || '');
        if (toHttps(song.picUrl) !== previousCover) covers.setMainCover(song.picUrl,
            { onLoad: () => { dom.el.img.style.opacity = 1; } });
        content.updateMusicMiniPlayer();
        metadata.updateMediaSession();
    }

    async function synchronize() {
        if (!bound()) return;
        const owner = binding;
        const controller = new AbortController();
        request = controller;
        auth.accountAbortControllers.add(controller);
        const generation = auth.authGeneration;
        const cookie = auth.neteaseCookie;
        const cookieParam = cookie ? `&cookie=${encodeURIComponent(cleanCookie(cookie))}` : '';
        const current = () => request === controller && !controller.signal.aborted && binding === owner
            && generation === auth.authGeneration && cookie === auth.neteaseCookie && bound();
        const read = path => transfer.withRequestTimeout(controller.signal, 15_000, '后台歌单检查超时', signal =>
            cache.cachedFetchJson(api.buildApiUrl(path), { signal, priority: 'idle', cacheScope: 'none' }));
        try {
            const json = await read(`/playlist/detail?id=${owner.source.id}&s=0${cookieParam}`);
            if (!current()) return;
            const detail = json?.playlist;
            // 不把无权限、截断或缺少完整 ID 的响应当成歌曲被删除。
            if (json.code !== 200 || !Array.isArray(detail?.trackIds)) throw new Error('歌单响应缺少完整歌曲列表');
            const ids = detail.trackIds.map(item => positiveMusicInteger(typeof item === 'object' ? item?.id : item, 0));
            if (ids.some(id => !id) || Number(detail.trackCount) !== ids.length) throw new Error('歌单歌曲列表不完整');
            const songs = new Map((detail.tracks || []).filter(song => song?.name).map(song => [Number(song.id), song]));
            const existing = new Set(owner.ids);
            const wanted = new Set(ids.filter(id => !existing.has(id) && !songs.has(id)));
            const visible = playlistView.getVisiblePlaylistIndexes();
            for (const index of [baseIndex(), ...visible]) {
                const track = baseQueue()[index];
                const checked = Number(track?.detailCheckedAt) || 0;
                if (track && ids.includes(Number(track.songId)) && !songs.has(Number(track.songId))
                    && (checked > Date.now() || Date.now() - checked >= DETAIL_MAX_AGE)) wanted.add(Number(track.songId));
            }
            const missing = [...wanted];
            for (let offset = 0; offset < missing.length; offset += DETAIL_BATCH_SIZE) {
                if (!current()) return;
                const batch = missing.slice(offset, offset + DETAIL_BATCH_SIZE);
                const response = await read(`/song/detail?ids=${encodeURIComponent(batch.join(','))}${cookieParam}`);
                if (!current()) return;
                if (response.code !== 200 || !Array.isArray(response.songs)) throw new Error('歌曲详情读取失败');
                response.songs.filter(song => song?.name).forEach(song => songs.set(Number(song.id), song));
            }
            if (ids.some(id => !existing.has(id) && !songs.has(id))) throw new Error('新增歌曲详情不完整');
            if (!current()) return;

            const selected = baseQueue()[baseIndex()];
            const previousCover = toHttps(normalizeMusicSong(selected?.songData || {}).picUrl);
            const byId = new Map();
            baseQueue().forEach(track => {
                const id = Number(track.songId);
                if (!byId.has(id)) byId.set(id, []);
                byId.get(id).push(track);
            });
            // 重复 ID 按出现次数复用；优先保留正在播放的那个对象。
            if (selected && byId.has(Number(selected.songId))
                && ids.filter(id => id === Number(selected.songId)).length < byId.get(Number(selected.songId)).length) {
                const entries = byId.get(Number(selected.songId));
                entries.splice(entries.indexOf(selected), 1);
                entries.unshift(selected);
            }
            const next = ids.map(id => byId.get(id)?.shift() || { netease: true, songId: id });
            if (selected && !next.includes(selected) && !queue.isTemporary && ['loading', 'playing', 'paused'].includes(playback.playbackState.status)) {
                next.splice(Math.min(Math.max(0, baseIndex()), next.length), 0, selected);
                temporaryCurrent = selected;
            }
            const changed = [];
            const checkedAt = Date.now();
            next.forEach((track, index) => {
                const incoming = songs.get(Number(track.songId));
                if (!incoming) return;
                const previous = track.songData || {};
                const normalized = normalizeMusicSong({ ...previous, ...incoming,
                    ar: incoming.ar || incoming.artists || previous.ar || previous.artists || [],
                    al: incoming.al || incoming.album || previous.al || previous.album || {},
                    dt: incoming.dt || incoming.duration || previous.dt || previous.duration || 0 });
                if (songPresentation(track.songData) !== songPresentation(normalized.songData)) {
                    track.songData = normalized.songData;
                    track.name = `${normalized.name}${normalized.artists.length ? ` - ${normalized.artists.map(artist => artist.name).join(', ')}` : ''}`;
                    changed.push(index);
                }
                track.detailCheckedAt = checkedAt;
            });
            const structureChanged = next.length !== baseQueue().length || next.some((track, index) => track !== baseQueue()[index]);
            if (structureChanged) {
                prefetch.cancelNextPreload();
                const continuation = baseQueue()[(baseIndex() + 1) % baseQueue().length];
                const selectedIndex = selected && next.includes(selected) ? next.indexOf(selected)
                    : queue.isTemporary ? (continuation && next.includes(continuation) ? next.indexOf(continuation) - 1 : -1)
                        : next.length ? 0 : -1;
                baseQueue().length = 0;
                for (const track of next) baseQueue().push(track);
                if (queue.reconcileBasePlaylist) queue.reconcileBasePlaylist(selectedIndex);
                else queue.curIdx = selectedIndex;
            }
            owner.source = { ...owner.source, loadedCount: ids.length, totalCount: ids.length, loading: false };
            updateBinding();
            if (structureChanged) playlistView.renderPlaylist();
            else changed.forEach(index => playlistView.refreshPlaylistItem(index));
            if (!queue.isTemporary && (selected && next.includes(selected) && changed.includes(next.indexOf(selected))
                || structureChanged && playback.playbackState.status === 'idle')) refreshCurrent(previousCover);
            if (structureChanged) content.updateMusicMiniPlayer();
            if (!next.length && !queue.isTemporary) playback.setPlaybackStatus('idle');
            persistence.schedulePlaylistStateSave(true);
            debug.log(structureChanged ? `线上歌单已同步，共 ${ids.length} 首；当前播放保持不变` : '线上歌单顺序未变化，已复用本地列表', 'success');
        } catch (error) {
            if (current() && error?.name !== 'AbortError') debug.log(`后台歌单检查未完成，保留本地列表：${error.message}`, 'warn');
        } finally {
            auth.accountAbortControllers.delete(controller);
            if (request === controller) request = null;
        }
    }

    function restore(source, queueRef) {
        remember(source, queueRef);
        return synchronize();
    }

    function resolveSelection(index) {
        const target = baseQueue()[index];
        if (!bound() || !temporaryCurrent || !target || target === temporaryCurrent) return index;
        const oldIndex = baseQueue().indexOf(temporaryCurrent);
        prefetch.cancelNextPreload();
        baseQueue().splice(oldIndex, 1);
        if (queue.reconcileBasePlaylist) queue.reconcileBasePlaylist(baseIndex() >= oldIndex ? baseIndex() - 1 : baseIndex());
        else if (queue.curIdx >= oldIndex) queue.curIdx--;
        temporaryCurrent = null;
        updateBinding();
        playlistView.renderPlaylist();
        return baseQueue().indexOf(target);
    }

    function finishEmptyQueue() {
        if (!bound() || !temporaryCurrent || baseQueue().length !== 1 || binding.source.totalCount !== 0) return false;
        prefetch.cancelNextPreload();
        baseQueue().splice(0);
        if (queue.reconcileBasePlaylist) queue.reconcileBasePlaylist(-1);
        else queue.curIdx = -1;
        temporaryCurrent = null;
        updateBinding();
        playback.stopAudio('idle');
        playlistView.renderPlaylist();
        content.updateMusicMiniPlayer();
        return true;
    }

    return { remember, getSource, restore, resolveSelection, finishEmptyQueue };
}
