function clearTrackCompanion(track, type) {
    track[`${type}File`] = null;
    track[`${type}Asset`] = null;
    track[`${type}Status`] = 'none';
    track[`${type}Message`] = '';
    if (type === 'sli') {
        track.sliData = null;
        track.sliRuntimeError = '';
    }
}

function findCompanionBindings(tracks, type, registry) {
    const assets = Array.from(registry.values());
    const audioBaseCounts = new Map();
    tracks.forEach(track => audioBaseCounts.set(track.asset.stemKey, (audioBaseCounts.get(track.asset.stemKey) || 0) + 1));
    const provisional = [], ambiguousAssets = new Set();

    tracks.forEach(track => {
        clearTrackCompanion(track, type);
        const audio = track.asset;
        const sameDirExact = assets.filter(asset => asset.dirKey === audio.dirKey && asset.explicitAudioNameKey === audio.nameKey);
        const sameDirGeneric = assets.filter(asset => asset.dirKey === audio.dirKey && !asset.explicitAudioNameKey && asset.companionBaseKey === audio.stemKey);
        const globalCandidates = assets.filter(asset => asset.companionBaseKey === audio.stemKey && (!asset.explicitAudioNameKey || asset.explicitAudioNameKey === audio.nameKey));
        let candidates = sameDirExact.length ? sameDirExact : sameDirGeneric;
        if (!candidates.length && audioBaseCounts.get(audio.stemKey) === 1) candidates = globalCandidates;
        if (candidates.length === 1) provisional.push({ track, asset: candidates[0] });
        else if (candidates.length > 1 || (!candidates.length && globalCandidates.length && audioBaseCounts.get(audio.stemKey) > 1)) {
            track[`${type}Status`] = 'ambiguous';
            track[`${type}Message`] = '存在多个同名候选';
            (candidates.length ? candidates : globalCandidates).forEach(asset => ambiguousAssets.add(asset.pathKey));
        }
    });

    const claims = new Map();
    provisional.forEach(match => {
        if (!claims.has(match.asset.pathKey)) claims.set(match.asset.pathKey, []);
        claims.get(match.asset.pathKey).push(match);
    });

    provisional.forEach(match => {
        const competing = claims.get(match.asset.pathKey);
        if (competing.length > 1) {
            competing.forEach(item => {
                item.track[`${type}Status`] = 'ambiguous';
                item.track[`${type}Message`] = '同一个伴随文件对应多首歌曲';
            });
            ambiguousAssets.add(match.asset.pathKey);
            return;
        }
        match.track[`${type}File`] = match.asset.file;
        match.track[`${type}Asset`] = match.asset;
        match.track[`${type}Status`] = 'matched';
    });
    return { assets, ambiguousAssets };
}

export { findCompanionBindings };
