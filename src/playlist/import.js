import { AUDIO_FILE_EXTENSIONS, COMPANION_FILE_EXTENSIONS, createImportPathFields, normalizeImportPath } from './paths.js';
import { findCompanionBindings } from './matching.js';
import { parseSliFile } from './sli.js';

export function createImports({
    analysis: analysisService,
    debug: debugService,
    dom: domService,
    loop: loopService,
    playback: playbackService,
    playlistView: playlistViewService,
    prefetch: prefetchService,
    queue: queueService
} = {}) {
    let companionRegistry = { sli: new Map(), lrc: new Map() };

    let pendingCompanionRegistry = { sli: new Map(), lrc: new Map() };

    let importQueue = Promise.resolve();

    let importAssetSequence = 1;

    let importSummaryTimer = null;

    function createImportAsset(file, relativePath, handle = null) {
        const fields = createImportPathFields(relativePath || file.webkitRelativePath || file.name, file.name);
        const { ext, stemKey: stem } = fields;
        const asset = {
            ...fields, id: `asset-${importAssetSequence++}`, file, handle,
            kind: AUDIO_FILE_EXTENSIONS.has(ext) || file.type?.startsWith('audio/') ? 'audio' : (COMPANION_FILE_EXTENSIONS.has(ext) ? ext : 'other')
        };
        if (asset.kind === 'sli' || asset.kind === 'lrc') {
            const companionDot = stem.lastIndexOf('.');
            const possibleAudioExt = companionDot >= 0 ? stem.slice(companionDot + 1) : '';
            asset.explicitAudioNameKey = AUDIO_FILE_EXTENSIONS.has(possibleAudioExt) ? stem : null;
            asset.companionBaseKey = asset.explicitAudioNameKey ? stem.slice(0, companionDot) : stem;
        }
        return asset;
    }

    function dedupeImportAssets(records) {
        const byPath = new Map();
        records.forEach(record => {
            if (!record?.file) return;
            const asset = createImportAsset(record.file, record.relativePath, record.handle || null);
            const previous = byPath.get(asset.pathKey);
            if (!previous || previous.file.size !== asset.file.size || previous.file.lastModified !== asset.file.lastModified) byPath.set(asset.pathKey, asset);
        });
        return Array.from(byPath.values());
    }

    async function walkFileSystemHandle(handle, parentPath, output, errors) {
        const relativePath = normalizeImportPath(parentPath ? `${parentPath}/${handle.name}` : handle.name);
        if (handle.kind === 'file') {
            try { output.push({ file: await handle.getFile(), handle, relativePath }); }
            catch (error) { errors.push({ path: relativePath, error }); }
            return;
        }
        if (handle.kind !== 'directory') return;
        try {
            for await (const child of handle.values()) await walkFileSystemHandle(child, relativePath, output, errors);
        } catch (error) { errors.push({ path: relativePath, error }); }
    }

    function readEntryFile(entry) {
        return new Promise((resolve, reject) => entry.file(resolve, reject));
    }

    function readEntryBatch(reader) {
        return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    }

    async function walkWebkitEntry(entry, parentPath, output, errors) {
        const relativePath = normalizeImportPath(parentPath ? `${parentPath}/${entry.name}` : entry.name);
        if (entry.isFile) {
            try { output.push({ file: await readEntryFile(entry), relativePath }); }
            catch (error) { errors.push({ path: relativePath, error }); }
            return;
        }
        if (!entry.isDirectory) return;
        try {
            const reader = entry.createReader();
            while (true) {
                const batch = await readEntryBatch(reader);
                if (!batch.length) break;
                for (const child of batch) await walkWebkitEntry(child, relativePath, output, errors);
            }
        } catch (error) { errors.push({ path: relativePath, error }); }
    }

    function captureDropSnapshot(dataTransfer) {
        const fallbackFiles = Array.from(dataTransfer?.files || []);
        const items = Array.from(dataTransfer?.items || []).filter(item => item.kind === 'file').map(item => {
            let handlePromise = null, entry = null, file = null;
            try {
                if (typeof item.getAsFileSystemHandle === 'function') handlePromise = Promise.resolve(item.getAsFileSystemHandle()).catch(() => null);
            } catch (_) {}
            try { if (typeof item.webkitGetAsEntry === 'function') entry = item.webkitGetAsEntry(); } catch (_) {}
            try { file = item.getAsFile(); } catch (_) {}
            return { handlePromise, entry, file };
        });
        return { items, fallbackFiles };
    }

    async function collectDropSnapshot(snapshot) {
        const records = [], errors = [];
        let unsupportedDirectory = false;
        if (snapshot.items.length) {
            for (const item of snapshot.items) {
                const handle = item.handlePromise ? await item.handlePromise : null;
                if (handle) {
                    const before = records.length;
                    const handleErrors = [];
                    await walkFileSystemHandle(handle, '', records, handleErrors);
                    if (records.length === before && item.entry) {
                        const fallbackErrors = [];
                        await walkWebkitEntry(item.entry, '', records, fallbackErrors);
                        if (records.length === before) errors.push(...handleErrors, ...fallbackErrors);
                    } else {
                        errors.push(...handleErrors);
                    }
                } else if (item.entry) await walkWebkitEntry(item.entry, '', records, errors);
                else if (item.file) records.push({ file: item.file, relativePath: item.file.webkitRelativePath || item.file.name });
                else unsupportedDirectory = true;
            }
        } else {
            snapshot.fallbackFiles.forEach(file => records.push({ file, relativePath: file.webkitRelativePath || file.name }));
        }
        if (!records.length && snapshot.fallbackFiles.length) snapshot.fallbackFiles.forEach(file => records.push({ file, relativePath: file.webkitRelativePath || file.name }));
        return { records, errors, unsupportedDirectory };
    }

    function mergeAssetRegistry(target, assets) {
        assets.forEach(asset => target[asset.kind].set(asset.pathKey, asset));
    }

    function mergeSupplementalAssetRegistry(target, assets) {
        assets.forEach(asset => {
            if (!asset.dirKey) {
                const sameName = Array.from(target[asset.kind].values()).filter(existing => existing.nameKey === asset.nameKey);
                if (sameName.length === 1) target[asset.kind].delete(sameName[0].pathKey);
            }
            target[asset.kind].set(asset.pathKey, asset);
        });
    }

    async function rebuildCompanionBindings(queue = queueService.playlist, registry = companionRegistry) {
        const localTracks = queue.filter(track => !track.netease && track.asset);
        const sliResult = findCompanionBindings(localTracks, 'sli', registry.sli);
        const lrcResult = findCompanionBindings(localTracks, 'lrc', registry.lrc);
        const invalidAssets = new Set();
        await Promise.all(localTracks.filter(track => track.sliStatus === 'matched').map(async track => {
            const asset = track.sliAsset;
            const parsed = asset.parsedSli || await parseSliFile(asset.file);
            asset.parsedSli = parsed;
            if (track.sliAsset !== asset) return;
            track.sliData = parsed;
            if (parsed.status === 'valid') track.sliStatus = 'valid';
            else {
                track.sliStatus = 'invalid';
                track.sliMessage = parsed.error;
                invalidAssets.add(track.sliAsset.pathKey);
            }
        }));
        localTracks.forEach(track => { if (track.lrcStatus === 'matched') track.lrcStatus = 'valid'; });

        const validAssets = new Set(localTracks.filter(track => track.sliStatus === 'valid').map(track => track.sliAsset.pathKey));
        const unmatchedAssets = new Set(sliResult.assets.map(asset => asset.pathKey).filter(path => !validAssets.has(path) && !invalidAssets.has(path) && !sliResult.ambiguousAssets.has(path)));
        const lrcMatchedAssets = new Set(localTracks.filter(track => track.lrcStatus === 'valid').map(track => track.lrcAsset.pathKey));
        const lrcUnmatchedAssets = new Set(lrcResult.assets.map(asset => asset.pathKey).filter(path => !lrcMatchedAssets.has(path) && !lrcResult.ambiguousAssets.has(path)));
        return {
            sli: { total: sliResult.assets.length, matched: validAssets.size, unmatched: unmatchedAssets.size, ambiguous: sliResult.ambiguousAssets.size, invalid: invalidAssets.size, unmatchedAssets, ambiguousAssets: sliResult.ambiguousAssets, invalidAssets },
            lrc: { total: lrcResult.assets.length, matched: lrcMatchedAssets.size, unmatched: lrcUnmatchedAssets.size, ambiguous: lrcResult.ambiguousAssets.size, unmatchedAssets: lrcUnmatchedAssets, ambiguousAssets: lrcResult.ambiguousAssets }
        };
    }

    function logCompanionDiagnostics(stats, errors, unsupportedDirectory) {
        const audioCount = queueService.playlist.filter(track => !track.netease).length;
        const summary = `导入完成: ${audioCount} 音频 / ${stats.sli.total} SLI / 匹配 ${stats.sli.matched} / 未匹配 ${stats.sli.unmatched} / 歧义 ${stats.sli.ambiguous} / 无效 ${stats.sli.invalid}`;
        const hasWarning = !!(stats.sli.unmatched || stats.sli.ambiguous || stats.sli.invalid || errors.length || unsupportedDirectory);
        debugService.log(summary, hasWarning ? 'warn' : 'success');
        showImportSummary(summary, hasWarning);
        const logPaths = (label, paths, registry, type = 'warn') => paths.forEach(path => debugService.log(`${label}: ${registry.get(path)?.relativePath || path}`, type));
        logPaths('SLI 未匹配', stats.sli.unmatchedAssets, companionRegistry.sli);
        logPaths('SLI 歧义', stats.sli.ambiguousAssets, companionRegistry.sli);
        queueService.playlist.filter(track => track.sliStatus === 'invalid').forEach(track => debugService.log(`SLI 格式无效: ${track.sliAsset?.relativePath || track.name} (${track.sliMessage || '未知原因'})`, 'error'));
        logPaths('LRC 未匹配', stats.lrc.unmatchedAssets, companionRegistry.lrc);
        logPaths('LRC 歧义', stats.lrc.ambiguousAssets, companionRegistry.lrc);
        errors.forEach(item => debugService.log(`文件读取失败: ${item.path} (${item.error?.message || item.error || 'unknown'})`, 'error'));
        if (unsupportedDirectory) debugService.log('当前浏览器无法展开拖入的目录，请改用 Chromium/Safari 或直接选择目录内的全部文件。', 'error');
    }

    function setImportScanning(active) {
        document.body.classList.toggle('import-scanning', active);
        domService.dragMaskTitle.textContent = active ? '正在读取文件夹' : '投喂音乐';
        domService.dragMaskDetail.textContent = active ? '完成扫描后会一次性导入' : 'MP3 / FLAC / OGG / SLI';
    }

    function showImportSummary(message, warning = false) {
        clearTimeout(importSummaryTimer);
        domService.importSummary.textContent = message;
        domService.importSummary.classList.toggle('warn', warning);
        domService.importSummary.classList.add('show');
        importSummaryTimer = setTimeout(() => domService.importSummary.classList.remove('show'), 6000);
    }

    async function processImportCollection(collection) {
        const assets = dedupeImportAssets(collection.records || []);
        const audioAssets = assets.filter(asset => asset.kind === 'audio');
        const companionAssets = assets.filter(asset => asset.kind === 'sli' || asset.kind === 'lrc');
        if (!audioAssets.length && !companionAssets.length) {
            (collection.errors || []).forEach(item => debugService.log(`文件读取失败: ${item.path}`, 'error'));
            debugService.log('没有发现支持的音频、SLI 或 LRC 文件', 'warn');
            showImportSummary('没有发现支持的音频、SLI 或 LRC 文件', true);
            return;
        }

        if (audioAssets.length) {
            const importPlayToken = playbackService.invalidatePlaybackAction();
            try { prefetchService.cancelNextPreload(); } catch (_) {}
            playbackService.stopAudio();
            const importTransportVersion = playbackService.transportVersion;
            queueService.activePlaylistQueueToken = null;
            queueService.playlistPendingAdvance = false;
            analysisService.resetLoopAnalysisWorkerAudio();
            loopService.resetLoopUI();
            companionRegistry = { sli: new Map(pendingCompanionRegistry.sli), lrc: new Map(pendingCompanionRegistry.lrc) };
            pendingCompanionRegistry = { sli: new Map(), lrc: new Map() };
            mergeAssetRegistry(companionRegistry, companionAssets);
            queueService.playlist = audioAssets.map(asset => ({
                file: asset.file, fileHandle: asset.handle || null, asset, sourceKey: asset.pathKey,
                name: asset.name.replace(/\.[^.]+$/, ''),
                lrcFile: null, sliFile: null, lrcStatus: 'none', sliStatus: 'none', sliData: null
            }));
            queueService.playlist.sort((a, b) => a.asset.relativePath.localeCompare(b.asset.relativePath, undefined, { numeric: true, sensitivity: 'base' }));
            const importedQueue = queueService.playlist;
            queueService.curIdx = -1;
            const stats = await rebuildCompanionBindings(importedQueue, companionRegistry);
            if (queueService.playlist !== importedQueue) return;
            playlistViewService.renderPlaylist();
            logCompanionDiagnostics(stats, collection.errors || [], collection.unsupportedDirectory);
            if (queueService.playlist.length && queueService.curIdx === -1 && playbackService.isPlaybackActionCurrent(importPlayToken)
                && playbackService.transportVersion === importTransportVersion) queueService.playTrackFromPlaylist(0);
            return;
        }

        const localTracks = queueService.playlist.filter(track => !track.netease && track.asset);
        if (!localTracks.length) {
            mergeAssetRegistry(pendingCompanionRegistry, companionAssets);
            const pendingMessage = `已暂存 ${companionAssets.length} 个伴随文件，将在下一批本地音频导入时配对。`;
            debugService.log(pendingMessage, 'success');
            showImportSummary(pendingMessage);
            return;
        }
        const queue = queueService.playlist;
        const previousBindings = new Map(localTracks.map(track => [track, {
            sli: track.sliAsset, lrc: track.lrcAsset, sliStatus: track.sliStatus,
            loopEditVersion: loopService.getLoopEditVersion(track)
        }]));
        mergeSupplementalAssetRegistry(companionRegistry, companionAssets);
        const stats = await rebuildCompanionBindings(queue, companionRegistry);
        if (queueService.playlist !== queue) return;
        playlistViewService.renderPlaylist();
        logCompanionDiagnostics(stats, collection.errors || [], collection.unsupportedDirectory);
        const currentTrack = queue[queueService.curIdx];
        const previous = previousBindings.get(currentTrack);
        if (previous) loopService.syncCurrentTrackCompanions(currentTrack, {
            sliChanged: loopService.getLoopEditVersion(currentTrack) === previous.loopEditVersion
                && (previous.sli !== currentTrack.sliAsset || previous.sliStatus !== currentTrack.sliStatus),
            lrcChanged: previous.lrc !== currentTrack.lrcAsset
        });
    }

    function enqueueImport(collectionTask) {
        importQueue = importQueue.then(async () => {
            setImportScanning(true);
            await processImportCollection(await collectionTask());
        }).catch(error => {
            const message = `导入失败: ${error?.message || error}`;
            debugService.log(message, 'error');
            showImportSummary(message, true);
        }).finally(() => setImportScanning(false));
        return importQueue;
    }

    function handleFiles(files) {
        const records = files.map(file => ({ file, relativePath: file.webkitRelativePath || file.name }));
        return enqueueImport(() => Promise.resolve({ records, errors: [], unsupportedDirectory: false }));
    }

    function handleDrop(e) {
        document.body.classList.remove('drag-on');
        const snapshot = captureDropSnapshot(e.dataTransfer);
        enqueueImport(() => collectDropSnapshot(snapshot));
    }

    let initialized = false;
    return {
        get importAssetSequence() { return importAssetSequence; },
        set importAssetSequence(value) { importAssetSequence = value; },
        showImportSummary,
        initialize() {
            if (initialized) return;
            initialized = true;
            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(e => document.body.addEventListener(e, ev => { ev.preventDefault(); ev.stopPropagation(); }));

            document.body.addEventListener('dragenter', () => document.body.classList.add('drag-on'));

            document.body.addEventListener('dragleave', (e) => { if(e.clientX===0 && e.clientY===0) document.body.classList.remove('drag-on'); });

            document.body.addEventListener('drop', handleDrop);

            document.getElementById('btn-import').addEventListener('click', () => domService.fileInput.click());

            domService.fileInput.addEventListener('change', (e) => {
                if (e.target.files.length > 0) handleFiles(Array.from(e.target.files));
                e.target.value = '';
            });
        }
    };
}
