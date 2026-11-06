import { cleanCookie, toHttps } from '../shared/text.js';
import { positiveMusicInteger } from './routes.js';
import { normalizeMusicSong } from './models.js';
import { GUEST_PLAYLIST_COOKIE, normalizePlaylistReader, normalizePlaylistPrivacy, planPlaylistSync } from './playlist-access.js';

const DETAIL_MAX_AGE = 5 * 60_000;
const DETAIL_BATCH_SIZE = 64;

function normalizeSource(source) {
    const id = positiveMusicInteger(source?.id, 0);
    return source?.type === 'netease-playlist' && id ? {
        type: 'netease-playlist', id: String(id),
        loadedCount: Math.max(0, Number(source.loadedCount) || 0),
        totalCount: Math.max(0, Number(source.totalCount) || 0), loading: !!source.loading,
        readAs: normalizePlaylistReader(source.readAs), privacy: normalizePlaylistPrivacy(source.privacy)
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
    const baseQueue = () => queue.basePlaylist;
    const baseIndex = () => queue.baseCurIdx;

    function bound() {
        return binding && binding.queue === baseQueue() && binding.revision === queue.baseStructureRevision;
    }

    function remember(source, queueRef = baseQueue()) {
        request?.abort();
        request = null;
        temporaryCurrent = null;
        const normalized = normalizeSource(source);
        binding = normalized && queueRef === baseQueue() && queueRef.every(track => track.netease && positiveMusicInteger(track.songId, 0))
            ? { source: normalized, queue: queueRef, revision: queue.baseStructureRevision } : null;
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
        binding.revision = queue.baseStructureRevision;
    }

    function refreshCurrent(previousCover) {
        const current = queue.playlist[queue.curIdx];
        if (!current) return;
        const song = normalizeMusicSong(current.songData || { id: current.songId, name: current.name });
        dom.el.title.textContent = song.name;
        content.setMainMusicEntityLinks(song.songData);
        lyrics.setArtistTag('网易云', metadata.currentAudioQuality || '');
        if (toHttps(song.picUrl) !== previousCover) covers.setMainCover(song.picUrl,
            { onLoad: () => { dom.el.img.style.opacity = 1; } });
        content.updateMusicMiniPlayer();
        metadata.updateMediaSession();
    }

    function applyDetails(songs) {
        const changed = [];
        const checkedAt = Date.now();
        const indexes = [...songs.keys()].flatMap(id => queue.findSongIndexes(id))
            .filter(index => index < baseQueue().length).sort((a, b) => a - b);
        for (const index of indexes) {
            const track = baseQueue()[index], incoming = songs.get(Number(track.songId));
            const previous = track.songData || {};
            const normalized = normalizeMusicSong({ ...previous, ...incoming,
                ar: incoming.ar || incoming.artists || previous.ar || previous.artists || [],
                al: incoming.al || incoming.album || previous.al || previous.album || {},
                dt: incoming.dt || incoming.duration || previous.dt || previous.duration || 0 });
            if (!track.songData || songPresentation(track.songData) !== songPresentation(normalized.songData)) {
                track.songData = normalized.songData;
                track.name = `${normalized.name}${normalized.artists.length ? ` - ${normalized.artists.map(artist => artist.name).join(', ')}` : ''}`;
                changed.push(index);
            }
            track.detailCheckedAt = checkedAt;
            persistence.schedulePlaylistTrackSave(index);
        }
        return changed;
    }

    function parseSnapshot(json, owner) {
        const detail = json?.playlist;
        if (json?.code !== 200 || !Array.isArray(detail?.trackIds)) throw new Error('歌单响应缺少完整歌曲列表');
        if (detail.id !== undefined && positiveMusicInteger(detail.id, 0) !== Number(owner.source.id)) throw new Error('歌单响应 ID 不匹配');
        const ids = detail.trackIds.map(item => positiveMusicInteger(typeof item === 'object' ? item?.id : item, 0));
        const reportedCount = detail.trackCount == null ? null : Number(detail.trackCount);
        if (ids.some(id => !id) || !ids.length && detail.trackCount !== 0 && detail.trackCount !== '0') throw new Error('歌单歌曲列表不完整');
        if (Number.isSafeInteger(reportedCount) && reportedCount >= 0 && reportedCount !== ids.length) {
            debug.log(`歌单统计 ${reportedCount} 首，当前可见 ${ids.length} 首；按返回的歌曲 ID 同步`, 'warn');
        }
        return { ids, complete: json.more !== true && detail.more !== true, privacy: normalizePlaylistPrivacy(detail.privacy),
            songs: new Map((Array.isArray(detail.tracks) ? detail.tracks : []).filter(song => song?.name).map(song => [Number(song.id), song])) };
    }

    function commitSnapshot(snapshot, reader) {
        const selected = baseQueue()[baseIndex()];
        const previousCover = toHttps(normalizeMusicSong(selected?.songData || {}).picUrl);
        const plan = planPlaylistSync(baseQueue().map(track => Number(track.songId)), snapshot.ids, binding.source.readAs, reader,
            { complete: snapshot.complete });
        const byId = new Map();
        baseQueue().forEach(track => {
            const id = Number(track.songId);
            if (!byId.has(id)) byId.set(id, { tracks: [], used: 0 });
            byId.get(id).tracks.push(track);
        });
        // 重复 ID 按出现次数复用；优先保留正在播放的那个对象。
        if (selected && byId.has(Number(selected.songId))
            && plan.ids.filter(id => id === Number(selected.songId)).length < byId.get(Number(selected.songId)).tracks.length) {
            const entries = byId.get(Number(selected.songId)).tracks;
            entries.splice(entries.indexOf(selected), 1);
            entries.unshift(selected);
        }
        const next = plan.ids.map(id => {
            const slot = byId.get(id);
            return slot?.tracks[slot.used++] || { name: `歌曲 ${id}（信息待补齐）`, netease: true, songId: id };
        });
        if (plan.replace || snapshot.ids.includes(Number(temporaryCurrent?.songId))) temporaryCurrent = null;
        if (selected && !next.includes(selected) && !queue.isTemporary && ['loading', 'playing', 'paused'].includes(playback.playbackState.status)) {
            next.splice(Math.min(Math.max(0, baseIndex()), next.length), 0, selected);
            temporaryCurrent = selected;
        }
        const structureChanged = next.length !== baseQueue().length || next.some((track, index) => track !== baseQueue()[index]);
        if (structureChanged) {
            const continuation = baseQueue()[(baseIndex() + 1) % baseQueue().length];
            const selectedIndex = selected && next.includes(selected) ? next.indexOf(selected)
                : queue.isTemporary ? (continuation && next.includes(continuation) ? next.indexOf(continuation) - 1 : -1)
                    : next.length ? 0 : -1;
            queue.replaceBaseTracks(next, selectedIndex);
            const locked = prefetch.nextPreloadIndex;
            if (prefetch.hasLockedNextPreloadTarget(queue.playlist, locked)
                && (!prefetch.isNextPreloadCompatible(queue.playlist, locked) || queue.getNextPlaylistIndex(locked) !== locked)) {
                prefetch.cancelNextPreload({ resetDetails: false });
            }
        }
        binding.source = { ...binding.source, loadedCount: plan.ids.length, totalCount: plan.ids.length, loading: false,
            readAs: plan.readAs, privacy: snapshot.privacy ?? binding.source.privacy };
        updateBinding();
        const changed = applyDetails(snapshot.songs);
        if (structureChanged) playlistView.renderPlaylist({ preservePosition: true });
        else changed.forEach(index => playlistView.refreshPlaylistItem(index));
        if (!queue.isTemporary && (selected && next.includes(selected) && changed.includes(next.indexOf(selected))
            || structureChanged && playback.playbackState.status === 'idle')) refreshCurrent(previousCover);
        if (structureChanged) content.updateMusicMiniPlayer();
        if (!next.length && !queue.isTemporary) playback.setPlaybackStatus('idle');
        persistence.schedulePlaylistStateSave(structureChanged);
        debug.log(plan.replace
            ? structureChanged ? `线上歌单已同步，共 ${snapshot.ids.length} 首；当前播放保持不变` : '线上歌单顺序未变化，已复用本地列表'
            : '已按线上顺序合并部分歌曲，暂时保留本地缺失项', plan.replace ? 'success' : 'warn');
    }

    async function synchronize() {
        if (!bound()) return;
        const owner = binding;
        const controller = new AbortController();
        request = controller;
        auth.accountAbortControllers.add(controller);
        const generation = auth.authGeneration;
        const cookie = auth.neteaseCookie;
        let guest = !cookie || auth.loginStatus === 'expired';
        let reader = guest ? 'guest' : normalizePlaylistReader(auth.neteaseUser?.userId);
        let identity;
        const confirmIdentity = () => identity ||= auth.waitForLoginStatus().then(valid => {
            reader = valid ? normalizePlaylistReader(auth.neteaseUser?.userId) : null;
            return reader;
        }, () => { reader = null; return null; });
        const cookieParam = () => `&cookie=${encodeURIComponent(guest ? GUEST_PLAYLIST_COOKIE : cleanCookie(cookie))}&noCookie=true`;
        const current = () => request === controller && !controller.signal.aborted && binding === owner
            && generation === auth.authGeneration && cookie === auth.neteaseCookie && bound();
        const read = (path, options = {}) => transfer.withRequestTimeout(controller.signal, 15_000, '后台歌单检查超时', signal =>
            cache.cachedFetchJson(api.buildApiUrl(path), { ...options, signal, credentials: 'omit', priority: 'idle', cacheScope: 'none' }));
        const readPlaylist = () => read(`/playlist/detail?id=${owner.source.id}&s=0${cookieParam()}&timestamp=${Date.now()}`, { cache: 'no-store' });
        try {
            if (owner.source.privacy === 10) {
                if (!guest) await confirmIdentity();
                if (!current()) return;
                if (guest || reader === null) {
                    debug.log('私有歌单需要有效登录，保留本地列表', 'warn');
                    return;
                }
            }
            let json;
            try { json = await readPlaylist(); }
            catch (error) {
                if (error.status !== 301 || guest || owner.source.privacy === 10) throw error;
                await confirmIdentity();
                if (!current()) return;
                if (auth.loginStatus !== 'expired') throw error;
                guest = true;
                reader = 'guest';
                json = await readPlaylist();
            }
            if (!current()) return;
            if (Number(json?.code) === 301 && !guest && owner.source.privacy !== 10) {
                guest = true;
                json = await readPlaylist();
                if (!current()) return;
            }
            let snapshot = parseSnapshot(json, owner);
            const privacy = snapshot.privacy ?? owner.source.privacy;
            if (!guest && privacy !== 0) await confirmIdentity();
            if (!current()) return;
            if (guest) reader = 'guest';
            if (privacy === 10 && (guest || reader === null)) {
                debug.log('私有歌单需要有效登录，保留本地列表', 'warn');
                return;
            }
            commitSnapshot(snapshot, reader);
            const { ids, songs } = snapshot;
            const existing = new Map(baseQueue().map(track => [Number(track.songId), track]));
            const idSet = new Set(ids);
            const wanted = new Set(ids.filter(id => !existing.get(id)?.songData && !songs.has(id)));
            const visible = playlistView.getVisiblePlaylistIndexes();
            for (const index of [baseIndex(), ...visible]) {
                const track = baseQueue()[index];
                const checked = Number(track?.detailCheckedAt) || 0;
                if (track && idSet.has(Number(track.songId)) && !songs.has(Number(track.songId))
                    && (checked > Date.now() || Date.now() - checked >= DETAIL_MAX_AGE)) wanted.add(Number(track.songId));
            }

            // 成员和顺序已保存，详情按批次补齐，不让单首失败回滚整张歌单。
            const missing = [...wanted];
            let incompleteBatches = 0;
            for (let offset = 0; offset < missing.length; offset += DETAIL_BATCH_SIZE) {
                if (!current()) return;
                const batch = missing.slice(offset, offset + DETAIL_BATCH_SIZE);
                try {
                    const response = await read(`/song/detail?ids=${encodeURIComponent(batch.join(','))}${cookieParam()}`);
                    if (!current()) return;
                    if (response.code !== 200 || !Array.isArray(response.songs)) throw new Error('歌曲详情读取失败');
                    const details = new Map(response.songs.filter(song => song?.name).map(song => [Number(song.id), song]));
                    if (batch.some(id => !details.has(id))) incompleteBatches++;
                    const active = baseQueue()[baseIndex()];
                    const cover = toHttps(normalizeMusicSong(active?.songData || {}).picUrl);
                    const updated = applyDetails(details);
                    updated.forEach(index => playlistView.refreshPlaylistItem(index));
                    if (!queue.isTemporary && updated.includes(baseIndex())) refreshCurrent(cover);
                } catch (_) {
                    if (!current()) return;
                    incompleteBatches++;
                }
            }
            if (incompleteBatches) debug.log(`可见曲目已更新；${incompleteBatches} 批歌曲详情未完整返回，保留已有信息并稍后补齐`, 'warn');
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

    function refresh() {
        request?.abort();
        return synchronize();
    }

    function resolveSelection(index) {
        const target = baseQueue()[index];
        if (!bound() || !temporaryCurrent || !target || target === temporaryCurrent) return index;
        const oldIndex = baseQueue().indexOf(temporaryCurrent);
        prefetch.cancelNextPreload();
        queue.removeBaseTrack(oldIndex, baseIndex() >= oldIndex ? baseIndex() - 1 : baseIndex());
        temporaryCurrent = null;
        updateBinding();
        playlistView.renderPlaylist();
        return baseQueue().indexOf(target);
    }

    function finishEmptyQueue() {
        if (!bound() || !temporaryCurrent || baseQueue().length !== 1 || binding.source.totalCount !== 0) return false;
        prefetch.cancelNextPreload();
        queue.replaceBaseTracks([], -1);
        temporaryCurrent = null;
        updateBinding();
        playback.stopAudio('idle');
        playlistView.renderPlaylist();
        content.updateMusicMiniPlayer();
        return true;
    }

    return { remember, getSource, restore, refresh, resolveSelection, finishEmptyQueue };
}
