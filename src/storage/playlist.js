import { toHttps } from '../shared/text.js';
import { createImportPathFields, normalizeImportKey } from '../playlist/paths.js';
import { positiveMusicInteger } from '../netease/routes.js';
import { normalizeMusicSong } from '../netease/models.js';
import { PLAYER_STATE_SCHEMA, createCompactPlaylistState, inferLegacyTitle, normalizePersistedArtist, pickNewestPlaylistState, pickPlaylistSelectedIndex } from './playlist-schema.js';

export function createPersistence({
    cache: cacheService,
    content: contentService,
    covers: coversService,
    debug: debugService,
    dom: domService,
    imports: importsService,
    lyrics: lyricsService,
    onlinePlaylist: onlinePlaylistService,
    playback: playbackService,
    playlistView: playlistViewService,
    queue: queueService
} = {}) {
    // ========== 结构化播放列表持久化 ==========
    const PLAYER_STATE_KEY = 'current-playlist';

    const PLAYER_SNAPSHOT_KEY = 'aurora_playlist_snapshot_v3';

    const PLAYER_SELECTION_KEY = 'current-playlist-selection';

    const PLAYER_SELECTION_SNAPSHOT_KEY = 'aurora_playlist_selection_v1';

    let playlistStateSaveTimer = null;

    let playlistStateRevision = 0;

    let playlistStatePending = null;

    let playlistStateWriting = false;

    let playlistStructureDirty = true;

    let playlistPersistenceQueue = null;

    let playlistPersistenceId = '';

    let playlistCachedState = null;

    let playlistCachedSource = '';

    let playlistIdbRevision = 0;

    let playlistCompactRevision = 0;

    let playlistLastSelection = null;

    let playlistSelectionIdbRevision = 0;

    let playlistSelectionCompactRevision = 0;

    function schedulePlaylistTrackSave(index) {
        const previous = playlistPersistenceQueue === queueService.playlist ? playlistCachedState?.tracks[index] : null;
        const track = queueService.playlist[index];
        if (!track) return;
        const next = serializePlaylistTrack(track);
        const unchanged = previous && previous.handle === next.handle
            && JSON.stringify({ ...previous, handle: undefined }) === JSON.stringify({ ...next, handle: undefined });
        schedulePlaylistStateSave(!unchanged);
    }

    function serializeNeteaseTrack(track) {
        const song = normalizeMusicSong(track.songData || { id: track.songId, name: track.name });
        return {
            id: positiveMusicInteger(track.songId || song.id, 0),
            title: String(song.name || track.name || ''),
            displayName: String(track.name || song.name || ''),
            ...(song.durationMs > 0 ? { durationMs: song.durationMs } : {}),
            ...(track.detailCheckedAt > 0 ? { detailCheckedAt: track.detailCheckedAt } : {}),
            artists: song.artists.map(normalizePersistedArtist),
            album: {
                id: positiveMusicInteger(song.album?.id, 0),
                name: String(song.album?.name || ''),
                picUrl: toHttps(song.album?.picUrl || '')
            }
        };
    }

    function serializeLocalTrack(track) {
        const file = track.file || track.asset?.file || null;
        const asset = track.asset || {};
        return {
            type: 'local',
            name: String(track.name || file?.name || asset.name || '本地文件'),
            relativePath: String(asset.relativePath || file?.webkitRelativePath || file?.name || track.name || ''),
            pathKey: String(track.sourceKey || asset.pathKey || ''),
            size: Number(file?.size ?? asset.size ?? 0),
            lastModified: Number(file?.lastModified ?? asset.lastModified ?? 0),
            handle: track.fileHandle || asset.handle || null
        };
    }

    function getPersistedPlaylistSource() {
        return onlinePlaylistService.getPersistedQueueSource();
    }

    function serializePlaylistTrack(track) {
        if (track?.netease) return { type: 'netease', ...serializeNeteaseTrack(track) };
        return serializeLocalTrack(track || {});
    }

    function buildPlaylistState() {
        const source = getPersistedPlaylistSource();
        const base = queueService.basePlaylist;
        const pending = queueService.manualState;
        const manual = pending && (pending.current || pending.pending.length) ? {
            current: pending.current ? serializePlaylistTrack(pending.current) : null,
            pending: pending.pending.map(serializePlaylistTrack)
        } : null;
        if (!Array.isArray(base) || !base.length && !source && !manual) return null;
        const sourceKey = JSON.stringify({ source, manual });
        if (playlistPersistenceQueue !== queueService.playlist) {
            playlistPersistenceQueue = queueService.playlist;
            playlistPersistenceId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
            playlistStructureDirty = true;
        }
        if (!playlistStructureDirty && playlistCachedState?.tracks.length === base.length && sourceKey === playlistCachedSource) return playlistCachedState;
        playlistStateRevision = Math.max(playlistStateRevision + 1, Date.now());
        playlistCachedState = {
            schema: PLAYER_STATE_SCHEMA,
            listId: playlistPersistenceId,
            revision: playlistStateRevision,
            savedAt: Date.now(),
            selectedIndex: Math.max(0, Math.min(base.length - 1, Number(queueService.baseCurIdx) || 0)),
            source,
            ...(manual ? { manual } : {}),
            tracks: base.map(serializePlaylistTrack)
        };
        playlistCachedSource = sourceKey;
        playlistStructureDirty = false;
        return playlistCachedState;
    }

    function writeCompactPlaylistState(state) {
        try {
            localStorage.setItem(PLAYER_SNAPSHOT_KEY, JSON.stringify(createCompactPlaylistState(state)));
            return true;
        } catch (error) {
            console.warn('Compact playlist snapshot failed:', error);
            return false;
        }
    }

    async function readPlaylistIdbState() {
        try {
            const db = await cacheService.openIdb();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(cacheService.IDB_PLAYER_STORE, 'readonly');
                const store = tx.objectStore(cacheService.IDB_PLAYER_STORE);
                const stateRequest = store.get(PLAYER_STATE_KEY);
                const selectionRequest = store.get(PLAYER_SELECTION_KEY);
                tx.oncomplete = () => resolve({ state: stateRequest.result, selection: selectionRequest.result });
                tx.onabort = tx.onerror = () => reject(tx.error || new Error('Playlist read failed'));
            });
        } catch (_) { return { state: null, selection: null }; }
    }

    async function writePlaylistTransaction(state, selection) {
        const db = await cacheService.openIdb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(cacheService.IDB_PLAYER_STORE, 'readwrite');
            tx.oncomplete = () => resolve(true);
            tx.onabort = tx.onerror = () => reject(tx.error || new Error('Playlist transaction failed'));
            const store = tx.objectStore(cacheService.IDB_PLAYER_STORE);
            try {
                if (state) store.put(state, PLAYER_STATE_KEY);
                store.put(selection, PLAYER_SELECTION_KEY);
            } catch (error) {
                reject(error);
                tx.abort();
            }
        });
    }

    async function persistPlaylistState(state, selection) {
        try {
            return await writePlaylistTransaction(state, selection);
        } catch (error) {
            if (error?.name === 'DataCloneError' && state?.tracks.some(track => track.handle)) {
                const withoutHandles = { ...state, tracks: state.tracks.map(({ handle: _handle, ...track }) => track) };
                try { return await writePlaylistTransaction(withoutHandles, selection); }
                catch (retryError) { error = retryError; }
            }
            debugService.log(`播放列表本地数据库写入失败 (${error?.name || 'Error'})，保留已有快照`, 'warn');
            return false;
        }
    }

    function drainPlaylistStateWrites() {
        if (playlistStateWriting) return;
        playlistStateWriting = true;
        (async () => {
            while (playlistStatePending) {
                const pending = playlistStatePending;
                playlistStatePending = null;
                try {
                    const full = playlistIdbRevision === pending.state.revision ? null : pending.state;
                    if (await persistPlaylistState(full, pending.selection)) {
                        playlistIdbRevision = pending.state.revision;
                        playlistSelectionIdbRevision = pending.selection.revision;
                    }
                }
                catch (error) { console.warn('saveCurrentPlaylist error', error); }
            }
            playlistStateWriting = false;
        })();
    }

    function saveCurrentPlaylist() {
        const state = buildPlaylistState();
        if (!state) return Promise.resolve(false);
        const base = queueService.basePlaylist;
        const selectedIndex = Math.max(0, Math.min(base.length - 1, Number(queueService.baseCurIdx) || 0));
        if (playlistLastSelection?.listId === state.listId && playlistLastSelection.contentRevision === state.revision
            && playlistLastSelection.selectedIndex === selectedIndex && playlistCompactRevision === state.revision
            && playlistIdbRevision === state.revision && playlistSelectionIdbRevision === playlistLastSelection.revision
            && playlistSelectionCompactRevision === playlistLastSelection.revision) return Promise.resolve(true);
        playlistStateRevision = Math.max(playlistStateRevision + 1, Date.now());
        const selection = { listId: state.listId, contentRevision: state.revision, revision: playlistStateRevision, selectedIndex };
        if (playlistCompactRevision !== state.revision && writeCompactPlaylistState(state)) playlistCompactRevision = state.revision;
        try {
            localStorage.setItem(PLAYER_SELECTION_SNAPSHOT_KEY, JSON.stringify(selection));
            playlistSelectionCompactRevision = selection.revision;
        } catch (error) { console.warn('Playlist selection snapshot failed:', error); }
        playlistLastSelection = selection;
        playlistStatePending = { state, selection };
        drainPlaylistStateWrites();
        return Promise.resolve(true);
    }

    function schedulePlaylistStateSave(contentChanged = false) {
        if (contentChanged) playlistStructureDirty = true;
        clearTimeout(playlistStateSaveTimer);
        playlistStateSaveTimer = setTimeout(() => saveCurrentPlaylist(), 120);
    }

    function readCompactPlaylistState() {
        try {
            const raw = localStorage.getItem(PLAYER_SNAPSHOT_KEY);
            const state = raw ? JSON.parse(raw) : null;
            return state && Array.isArray(state.tracks) ? state : null;
        } catch (error) {
            console.warn('Compact playlist restore failed:', error);
            return null;
        }
    }

    function readCompactPlaylistSelection() {
        try { return JSON.parse(localStorage.getItem(PLAYER_SELECTION_SNAPSHOT_KEY) || 'null'); }
        catch (_) { return null; }
    }

    async function migrateLegacyPlaylistState() {
        try {
            const rawList = localStorage.getItem('aurora_saved_playlist');
            if (!rawList) return null;
            const rawIndex = localStorage.getItem('aurora_saved_index');
            const legacy = JSON.parse(rawList);
            if (!Array.isArray(legacy) || !legacy.length) return null;
            const state = {
                schema: PLAYER_STATE_SCHEMA,
                revision: Date.now(),
                savedAt: Date.now(),
                selectedIndex: Math.max(0, Math.min(legacy.length - 1, Number.parseInt(rawIndex, 10) || 0)),
                source: null,
                tracks: legacy.map(item => ({
                    type: 'netease',
                    id: positiveMusicInteger(item.id, 0),
                    title: inferLegacyTitle(item),
                    displayName: String(item.name || inferLegacyTitle(item)),
                    artists: (item.ar || []).map(normalizePersistedArtist),
                    album: {
                        id: positiveMusicInteger(item.al?.id, 0),
                        name: String(item.al?.name || ''),
                        picUrl: toHttps(item.al?.picUrl || '')
                    }
                }))
            };
            if (await cacheService.idbSet(PLAYER_STATE_KEY, state, cacheService.IDB_PLAYER_STORE)) {
                localStorage.removeItem('aurora_saved_playlist');
                localStorage.removeItem('aurora_saved_index');
            }
            return state;
        } catch (error) {
            console.warn('Legacy playlist migration failed:', error);
            return null;
        }
    }

    async function restoreSavedPlaylist() {
        try {
            const { state: idbState, selection: idbSelection } = await readPlaylistIdbState();
            const compactState = readCompactPlaylistState();
            const state = pickNewestPlaylistState(idbState, compactState) || await migrateLegacyPlaylistState();
            if (queueService.playlist.length || state?.schema !== PLAYER_STATE_SCHEMA || !Array.isArray(state.tracks)) return;
            playlistStateRevision = Math.max(playlistStateRevision, Number(state.revision) || 0);
            if (!state.tracks.length && !state.manual) {
                void onlinePlaylistService.restoreQueueSource(state.source, queueService.basePlaylist);
                return;
            }
            const compactSelection = readCompactPlaylistSelection();
            state.selectedIndex = pickPlaylistSelectedIndex(state, idbSelection, compactSelection);
            playlistStateRevision = Math.max(playlistStateRevision, Number(state.revision) || 0,
                Number(idbSelection?.revision) || 0, Number(compactSelection?.revision) || 0);
            const needsStateUpgrade = !!state._upgraded;
            if (needsStateUpgrade) {
                delete state._upgraded;
                writeCompactPlaylistState(state);
            }
            const restoreTrack = item => {
                if (item.type === 'local') {
                    const relativePath = String(item.relativePath || item.name || '本地文件');
                    return {
                        name: String(item.name || relativePath),
                        file: null,
                        fileHandle: item.handle || null,
                        needsFile: true,
                        sourceKey: normalizeImportKey(relativePath),
                        asset: { ...createImportPathFields(relativePath, String(item.name || '')), id: `asset-${importsService.importAssetSequence++}`, file: null, handle: item.handle || null, kind: 'audio', size: Number(item.size || 0), lastModified: Number(item.lastModified || 0) },
                        lrcFile: null,
                        sliFile: null,
                        lrcStatus: 'none',
                        sliStatus: 'none',
                        sliData: null
                    };
                }
                const ar = (item.artists || []).map(normalizePersistedArtist);
                const al = { id: item.album?.id || 0, name: item.album?.name || '', picUrl: toHttps(item.album?.picUrl || '') };
                return {
                    name: String(item.displayName || item.title || ''), netease: true, songId: item.id,
                    ...(item.detailCheckedAt > 0 ? { detailCheckedAt: item.detailCheckedAt } : {}),
                    songData: { id: item.id, name: String(item.title || ''), ar, al, artists: ar, album: al,
                        ...(item.durationMs > 0 ? { dt: item.durationMs, duration: item.durationMs } : {}) }
                };
            };
            queueService.playlist = state.tracks.map(restoreTrack);
            queueService.activePlaylistQueueToken = null;
            queueService.playlistPendingAdvance = false;
            playlistPersistenceQueue = queueService.playlist;
            playlistPersistenceId = state.listId || window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
            queueService.curIdx = state.tracks.length ? Math.max(0, Math.min(state.tracks.length - 1, Number(state.selectedIndex) || 0)) : -1;
            if (state.manual) queueService.restoreManualState({
                current: state.manual.current ? restoreTrack(state.manual.current) : null,
                pending: state.manual.pending.map(restoreTrack)
            });
            playlistViewService.renderPlaylist();
            const currentTrack = queueService.playlist[queueService.curIdx] || queueService.playlist[0];
            if (!currentTrack) return;
            if (currentTrack.netease) {
                domService.el.title.textContent = currentTrack.songData.name || currentTrack.name;
                contentService.setMainMusicEntityLinks(currentTrack.songData);
                lyricsService.setArtistTag('网易云');
                const cover = toHttps(currentTrack.songData.al.picUrl);
                if (cover) {
                    coversService.setMainCover(cover);
                    domService.el.img.style.opacity = 1;
                }
            } else {
                domService.el.title.textContent = currentTrack.name;
                contentService.setMainMusicEntityLinks(null);
                lyricsService.setArtistTag('本地文件');
            }
            playbackService.setPlaybackStatus('idle');
            contentService.updateMusicMiniPlayer();
            const needsFile = queueService.playlist.filter(track => track.needsFile).length;
            const needsSelection = queueService.playlist.filter(track => track.needsFile && !track.fileHandle).length;
            debugService.log(`已从历史恢复 ${queueService.playlist.length} 首歌曲${needsFile ? `；${needsFile - needsSelection} 个本地文件可请求访问权限，${needsSelection} 个文件需重新选择` : ''}`, needsFile ? 'warn' : 'success');
            void onlinePlaylistService.restoreQueueSource(state.source, queueService.basePlaylist);
        } catch (error) {
            console.warn('Failed to restore playlist:', error);
        }
    }

    let initialized = false;
    return {
        schedulePlaylistTrackSave,
        schedulePlaylistStateSave,
        initialize() {
            if (initialized) return;
            initialized = true;
            window.addEventListener('pagehide', () => saveCurrentPlaylist());

            restoreSavedPlaylist();
        }
    };
}
