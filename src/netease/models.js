import { toHttps } from '../shared/text.js';
import { positiveMusicInteger } from './routes.js';

function normalizeMusicArtist(artist = {}) {
    return {
        id: positiveMusicInteger(artist.id, 0),
        name: String(artist.name || artist.artistName || '未知歌手'),
        picUrl: toHttps(artist.picUrl || artist.img1v1Url || artist.cover || artist.avatarUrl || ''),
        albumSize: Number(artist.albumSize || 0),
        musicSize: Number(artist.musicSize || 0),
        mvSize: Number(artist.mvSize || 0),
        briefDesc: String(artist.briefDesc || '')
    };
}

function normalizeMusicAlbum(album = {}) {
    const rawArtists = Array.isArray(album.artists) && album.artists.length
        ? album.artists : (album.artist ? [album.artist] : []);
    return {
        id: positiveMusicInteger(album.id, 0),
        name: String(album.name || '未知专辑'),
        picUrl: toHttps(album.picUrl || album.blurPicUrl || ''),
        artists: rawArtists.filter(artist => artist && (artist.id || artist.name || artist.artistName)).map(normalizeMusicArtist),
        publishTime: Number(album.publishTime || 0),
        size: Number(album.size || album.trackCount || 0),
        description: String(album.description || album.briefDesc || ''),
        company: String(album.company || ''),
        subType: String(album.subType || album.type || '')
    };
}

function normalizeMusicSong(song = {}) {
    const rawArtists = song.ar || song.artists || [];
    const artists = rawArtists.filter(artist => artist && (artist.id || artist.name || artist.artistName)).map(normalizeMusicArtist);
    const rawAlbum = song.al || song.album || {};
    const album = normalizeMusicAlbum(rawAlbum);
    const durationMs = Math.max(0, Number(song.dt || song.duration || 0));
    const songData = {
        ...song,
        id: positiveMusicInteger(song.id, 0),
        name: String(song.name || '未知歌曲'),
        dt: durationMs,
        duration: durationMs,
        ar: artists,
        artists,
        al: { ...rawAlbum, id: album.id, name: album.name, picUrl: album.picUrl },
        album: { ...rawAlbum, id: album.id, name: album.name, picUrl: album.picUrl }
    };
    return {
        id: songData.id,
        name: songData.name,
        durationMs,
        artists,
        album,
        picUrl: album.picUrl,
        songData
    };
}

export { normalizeMusicAlbum, normalizeMusicArtist, normalizeMusicSong };
