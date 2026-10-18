import { positiveMusicInteger } from '../netease/routes.js';

function normalizeNeteaseMatchText(value) {
    return String(value || '').toLowerCase().replace(/[\s\u3000]+/g, '');
}

function getNeteaseSongArtists(song) {
    const rawArtists = song?.ar || song?.artists || song?.artist || [];
    const artists = Array.isArray(rawArtists) ? rawArtists : [rawArtists];
    return artists
        .map(artist => typeof artist === 'string' ? artist : artist?.name)
        .filter(Boolean);
}

function getNeteaseSongAlbum(song) {
    const album = song?.al || song?.album || {};
    return typeof album === 'string' ? album : (album?.name || song?.albumName || '');
}

function getNeteaseSongDurationMs(song) {
    return Number(song?.dt || song?.duration || song?.durationMs || 0);
}

function extractNeteaseMatchSongs(payload) {
    const candidates = [
        payload?.result?.songs,
        payload?.data?.result?.songs,
        payload?.data?.songs,
        payload?.songs,
        payload?.result?.data,
        payload?.data
    ];
    const list = candidates.find(value => Array.isArray(value)) || [];
    return list.map(item => {
        if (!item || typeof item !== 'object') return null;
        const nested = item.song || item.songData || item.songInfo;
        if (nested && typeof nested === 'object') return { ...item, ...nested };
        const id = positiveMusicInteger(item.id || item.songId || item.song_id, 0);
        const name = item.name || item.songName || item.song_name || '';
        return id ? { ...item, id, name: String(name) } : null;
    }).filter(song => song?.id);
}

function chooseNeteaseSongMatch(songs, target = {}) {
    const targetName = normalizeNeteaseMatchText(target.name);
    const targetArtist = normalizeNeteaseMatchText(target.artist);
    const targetAlbum = normalizeNeteaseMatchText(target.album);
    const targetDuration = Number(target.duration || 0) * 1000;
    return (Array.isArray(songs) ? songs : []).map(song => {
        const name = normalizeNeteaseMatchText(song?.name);
        const artists = getNeteaseSongArtists(song).map(normalizeNeteaseMatchText);
        const album = normalizeNeteaseMatchText(getNeteaseSongAlbum(song));
        const durationMs = getNeteaseSongDurationMs(song);
        let score = 0;
        if (targetName && name === targetName) score += 120;
        else if (targetName && (name.includes(targetName) || targetName.includes(name))) score += 55;
        if (targetArtist && artists.some(value => value === targetArtist)) score += 55;
        else if (targetArtist && artists.some(value => value.includes(targetArtist) || targetArtist.includes(value))) score += 30;
        if (targetAlbum && album === targetAlbum) score += 40;
        else if (targetAlbum && (album.includes(targetAlbum) || targetAlbum.includes(album))) score += 20;
        if (targetDuration > 0 && durationMs > 0) {
            const diffSeconds = Math.abs(durationMs - targetDuration) / 1000;
            score += Math.max(0, 45 - Math.min(45, diffSeconds * 2));
        }
        return { song, score };
    }).sort((a, b) => b.score - a.score)[0]?.song || null;
}

export { chooseNeteaseSongMatch, extractNeteaseMatchSongs, getNeteaseSongArtists, getNeteaseSongDurationMs };
