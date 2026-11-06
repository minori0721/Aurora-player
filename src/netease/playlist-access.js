import { positiveMusicInteger } from './routes.js';

export const GUEST_PLAYLIST_COOKIE = 'os=pc';

export function normalizePlaylistReader(value) {
    if (value === 'guest') return value;
    return typeof value === 'number' || typeof value === 'string' ? positiveMusicInteger(value, 0) || null : null;
}

export function normalizePlaylistPrivacy(value) {
    return value === 0 || value === '0' ? 0 : value === 10 || value === '10' ? 10 : null;
}

export function mergePlaylistIds(localIds, remoteIds) {
    const slots = new Map();
    localIds.forEach((id, index) => {
        if (!slots.has(id)) slots.set(id, { indexes: [], used: 0 });
        slots.get(id).indexes.push(index);
    });
    const matched = new Uint8Array(localIds.length);
    const lastRemote = new Map();
    const anchors = remoteIds.map((id, position) => {
        lastRemote.set(id, position);
        const slot = slots.get(id);
        const index = slot && slot.used < slot.indexes.length ? slot.indexes[slot.used++] : -1;
        if (index >= 0) matched[index] = 1;
        return index;
    });
    // Keep missing local runs immediately before their next surviving neighbour.
    const before = new Map();
    let pending = [], hasMissing = false;
    localIds.forEach((id, index) => {
        if (!matched[index]) {
            if (!lastRemote.has(id)) pending.push(id);
            hasMissing = true;
        }
        else if (pending.length) { before.set(index, pending); pending = []; }
    });
    const ids = [];
    remoteIds.forEach((id, index) => {
        for (const missing of before.get(anchors[index]) || []) ids.push(missing);
        ids.push(id);
        if (lastRemote.get(id) === index) {
            const slot = slots.get(id);
            // Extra duplicate occurrences follow their remote copies so repeated merges stay stable.
            if (slot) for (let extra = slot.used; extra < slot.indexes.length; extra++) ids.push(id);
        }
    });
    for (const missing of pending) ids.push(missing);
    return { ids, hasMissing };
}

export function planPlaylistSync(localIds, remoteIds, previousReader, reader, { complete = true } = {}) {
    return {
        ids: complete ? remoteIds : mergePlaylistIds(localIds, remoteIds).ids,
        replace: complete,
        readAs: normalizePlaylistReader(reader) ?? normalizePlaylistReader(previousReader)
    };
}
