export function normalizePlaylistSearch(value) {
    return String(value || '').normalize('NFKC').toLowerCase().trim();
}

export function playlistSearchKey(track) {
    const song = track?.songData || {};
    const artists = Array.isArray(song.ar) ? song.ar : Array.isArray(song.artists) ? song.artists : [];
    return normalizePlaylistSearch([track?.name, song.name, track?.file?.name, track?.asset?.name,
        ...artists.map(artist => typeof artist === 'string' ? artist : artist?.name)].filter(Boolean).join(' '));
}

export function matchesPlaylistSearch(key, terms) {
    return terms.every(term => key.includes(term));
}
