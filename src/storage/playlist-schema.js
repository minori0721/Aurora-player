import { toHttps } from '../shared/text.js';
import { normalizeImportKey } from '../playlist/paths.js';
import { positiveMusicInteger } from '../netease/routes.js';

const PLAYER_STATE_SCHEMA = 3;

function normalizePersistedArtist(artist = {}) {
    return { id: positiveMusicInteger(artist.id, 0), name: String(artist.name || '') };
}

function createCompactPlaylistState(state) {
    return {
        schema: state.schema,
        listId: state.listId,
        revision: state.revision,
        savedAt: state.savedAt,
        selectedIndex: state.selectedIndex,
        source: state.source,
        ...(state.manual ? { manual: state.manual } : {}),
        tracks: state.tracks.map(track => {
            const compact = { ...track };
            delete compact.handle;
            return compact;
        })
    };
}

function pickPlaylistSelectedIndex(state, ...selections) {
    const valid = selections.filter(selection => state.listId && selection?.listId === state.listId
        && selection.contentRevision === state.revision && Number.isSafeInteger(selection.revision)
        && selection.revision >= state.revision && Number.isSafeInteger(selection.selectedIndex)
        && selection.selectedIndex >= 0 && selection.selectedIndex < state.tracks.length)
        .sort((a, b) => b.revision - a.revision);
    return valid[0]?.selectedIndex ?? state.selectedIndex;
}

function normalizePersistedPlaylistState(state) {
    if (!state || !Array.isArray(state.tracks)) return null;
    const schema = Number(state.schema || 0);
    if (schema !== 2 && schema !== PLAYER_STATE_SCHEMA) return null;
    const normalizeTrack = item => {
        if (schema === PLAYER_STATE_SCHEMA && item?.type === 'local') {
            return { ...item, type: 'local' };
        }
        const artists = (item?.artists || item?.ar || []).map(normalizePersistedArtist);
        const title = String(item?.title || inferLegacyTitle(item) || item?.name || '');
        return {
            type: 'netease',
            id: positiveMusicInteger(item?.id, 0),
            title,
            displayName: String(item?.displayName || item?.name || title),
            ...(Number.isFinite(item?.durationMs) && item.durationMs > 0 ? { durationMs: item.durationMs } : {}),
            ...(Number.isFinite(item?.detailCheckedAt) && item.detailCheckedAt > 0 ? { detailCheckedAt: item.detailCheckedAt } : {}),
            artists,
            album: {
                id: positiveMusicInteger(item?.album?.id || item?.al?.id, 0),
                name: String(item?.album?.name || item?.al?.name || ''),
                picUrl: toHttps(item?.album?.picUrl || item?.al?.picUrl || '')
            }
        };
    };
    const tracks = state.tracks.map(normalizeTrack);
    const validManual = item => item?.type === 'netease' && positiveMusicInteger(item.id, 0);
    const manual = state.manual ? {
        current: validManual(state.manual.current) ? normalizeTrack(state.manual.current) : null,
        pending: (Array.isArray(state.manual.pending) ? state.manual.pending : []).filter(validManual).map(normalizeTrack)
    } : null;
    if (!tracks.length && !(manual?.current || manual?.pending.length)
        && !(schema === PLAYER_STATE_SCHEMA && state.source?.type === 'netease-playlist' && positiveMusicInteger(state.source.id, 0))) return null;
    const normalized = {
        ...state,
        schema: PLAYER_STATE_SCHEMA,
        revision: Number(state.revision || state.savedAt || Date.now()),
        savedAt: Number(state.savedAt || Date.now()),
        selectedIndex: Math.max(0, Math.min(tracks.length - 1, Number(state.selectedIndex) || 0)),
        source: state.source || null,
        manual,
        tracks
    };
    if (schema !== PLAYER_STATE_SCHEMA) {
        normalized._upgraded = true;
    }
    return normalized;
}

function getPersistedLocalTrackIdentity(track) {
    if (track?.type !== 'local') return null;
    if (track.size == null || track.lastModified == null) return null;
    const path = normalizeImportKey(track.relativePath || '');
    const size = Number(track.size);
    const lastModified = Number(track.lastModified);
    if (!path || !Number.isSafeInteger(size) || size < 0
        || !Number.isSafeInteger(lastModified) || lastModified < 0) return null;
    return JSON.stringify([path, size, lastModified]);
}

function pickNewestPlaylistState(...states) {
    const candidates = states.map(normalizePersistedPlaylistState).filter(Boolean)
        .sort((a, b) => Number(b.revision || b.savedAt || 0) - Number(a.revision || a.savedAt || 0));
    if (!candidates.length) return null;
    const newest = candidates[0];
    // Compact snapshots omit handles; borrow only uniquely matching file identities from older IDB state.
    const donors = candidates.slice(1).map(state => {
        const byIdentity = new Map();
        state.tracks.forEach(track => {
            const key = getPersistedLocalTrackIdentity(track);
            if (key) byIdentity.set(key, byIdentity.has(key) ? null : track);
        });
        return byIdentity;
    });
    return {
        ...newest,
        tracks: newest.tracks.map(track => {
            if (track.type !== 'local' || track.handle) return track;
            const key = getPersistedLocalTrackIdentity(track);
            if (!key) return track;
            for (const donor of donors) {
                const handle = donor.get(key)?.handle;
                if (typeof handle?.getFile === 'function') return { ...track, handle };
            }
            return track;
        })
    };
}

function inferLegacyTitle(item) {
    const displayName = String(item?.name || '');
    const artistText = (item?.ar || []).map(artist => artist?.name).filter(Boolean).join(', ');
    const exactSuffix = artistText ? ` - ${artistText}` : '';
    return exactSuffix && displayName.endsWith(exactSuffix) ? displayName.slice(0, -exactSuffix.length) : displayName;
}

export { PLAYER_STATE_SCHEMA, createCompactPlaylistState, inferLegacyTitle, normalizePersistedArtist, normalizePersistedPlaylistState, pickNewestPlaylistState, pickPlaylistSelectedIndex };
