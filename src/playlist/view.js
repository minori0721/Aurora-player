import { toHttps } from '../shared/text.js';
import { createPlaylistCovers } from './covers.js';

export function createPlaylistView({
    dom: domService,
    persistence: persistenceService,
    prefetch: prefetchService,
    queue: queueService
} = {}) {
    const playlistCovers = createPlaylistCovers({ root: domService.el.plSidebar, container: domService.el.plContainer });
    const observePlaylistCovers = () => playlistCovers.observe();
    const pausePlaylistCovers = () => playlistCovers.suspend();

    let activePlaylistRow = null;

    function updatePlaylistActiveItem() {
        const nextRow = domService.el.plContainer.children[queueService.curIdx] || null;
        if (activePlaylistRow !== nextRow) {
            if (activePlaylistRow) {
                activePlaylistRow.classList.remove('active');
                activePlaylistRow.setAttribute('aria-current', 'false');
            }
            if (nextRow) {
                nextRow.classList.add('active');
                nextRow.setAttribute('aria-current', 'true');
            }
            activePlaylistRow = nextRow;
        }
        if (typeof persistenceService.schedulePlaylistStateSave === 'function') persistenceService.schedulePlaylistStateSave();
    }

    function updatePlaylistCompanionMarker(row, track) {
        row.querySelector('.pl-item-companion')?.remove();
        if (track?.needsFile) {
            const marker = document.createElement('span');
            marker.className = 'pl-item-companion warn';
            marker.textContent = '!';
            marker.title = track.fileHandle ? '点击播放以授权读取本地文件' : '本地文件未恢复，请重新选择或导入文件';
            marker.setAttribute('aria-label', marker.title);
            row.appendChild(marker);
            return;
        }
        if (!track || track.netease || !['valid', 'invalid', 'ambiguous'].includes(track.sliStatus)) return;
        const hasWarning = track.sliStatus !== 'valid' || !!track.sliRuntimeError;
        const marker = document.createElement('span');
        marker.className = `pl-item-companion${hasWarning ? ' warn' : ''}`;
        marker.textContent = hasWarning ? '!' : '∞';
        marker.title = hasWarning ? `SLI ${track.sliStatus === 'ambiguous' ? '匹配歧义' : '无效'}: ${track.sliRuntimeError || track.sliMessage || '未知原因'}` : '已匹配 SLI 循环';
        marker.setAttribute('aria-label', marker.title);
        row.appendChild(marker);
    }

    function refreshPlaylistItem(index) {
        persistenceService.schedulePlaylistTrackSave(index);
        const row = domService.el.plContainer.children[index];
        const track = queueService.playlist[index];
        if (!row || !track) return;

        row.setAttribute('aria-label', track.needsFile
            ? (track.fileHandle ? `授权并播放第 ${index + 1} 首：${track.name}` : `第 ${index + 1} 首：${track.name}，需要重新选择本地文件`)
            : `播放第 ${index + 1} 首：${track.name}`);
        const titleEl = row.querySelector('.pl-item-title');
        if (titleEl) {
            const icon = track.netease ? '☁️ ' : (track.needsFile ? '⚠️ ' : '');
            titleEl.textContent = `${icon}${track.name}`;
        }
        updatePlaylistCompanionMarker(row, track);

        const coverEl = row.querySelector('.pl-item-cover');
        if (!coverEl) return;
        const coverUrl = toHttps(track.songData?.album?.picUrl || track.songData?.al?.picUrl || '');
        playlistCovers.bind(coverEl, coverUrl);
    }

    function ensurePlaylistRenderedAndActive() {
        if (domService.el.plContainer.children.length !== queueService.playlist.length) renderPlaylist();
        else updatePlaylistActiveItem();
    }

    function createPlaylistRow(track, index) {
        const d = document.createElement('button');
        d.type = 'button';
        d.className = 'pl-item';
        d.setAttribute('aria-current', 'false');
        const indexEl = document.createElement('span');
        indexEl.className = 'pl-item-index';
        indexEl.textContent = String(index + 1);

        const coverEl = document.createElement('img');
        coverEl.className = 'pl-item-cover empty';
        coverEl.width = 30;
        coverEl.height = 30;
        coverEl.alt = '';
        coverEl.setAttribute('aria-hidden', 'true');
        coverEl.loading = 'eager';
        coverEl.decoding = 'async';
        coverEl.referrerPolicy = 'no-referrer';
        const coverUrl = toHttps(track.songData?.album?.picUrl || track.songData?.al?.picUrl || '');
        playlistCovers.bind(coverEl, coverUrl);
        const coverSlot = document.createElement('span');
        coverSlot.className = 'pl-cover';
        coverSlot.appendChild(coverEl);

        const titleEl = document.createElement('span');
        titleEl.className = 'pl-item-title';
        d.appendChild(indexEl);
        d.appendChild(coverSlot);
        d.appendChild(titleEl);
        updatePlaylistCompanionMarker(d, track);
        d.onclick = () => {
            if (!prefetchService.isNextPreloadCompatible(queueService.playlist, index, track)) {
                try { prefetchService.cancelNextPreload(); } catch(e) {}
            }
            queueService.playTrackFromPlaylist(index);
        };
        d.setAttribute('aria-label', track.needsFile
            ? (track.fileHandle ? `授权并播放第 ${index + 1} 首：${track.name}` : `第 ${index + 1} 首：${track.name}，需要重新选择本地文件`)
            : `播放第 ${index + 1} 首：${track.name}`);
        const icon = track.netease ? '☁️ ' : (track.needsFile ? '⚠️ ' : '');
        titleEl.textContent = `${icon}${track.name}`;
        return d;
    }

    function appendPlaylistRows(startIndex = 0, force = false) {
        if (!force && domService.el.plContainer.children.length !== startIndex) {
            renderPlaylist();
            return;
        }
        const frag = document.createDocumentFragment();
        for (let i = startIndex; i < queueService.playlist.length; i++) frag.appendChild(createPlaylistRow(queueService.playlist[i], i));
        domService.el.plContainer.appendChild(frag);
        updatePlaylistActiveItem();
        observePlaylistCovers();
        persistenceService.schedulePlaylistStateSave(true);
    }

    function renderPlaylist() {
        playlistCovers.reset();
        domService.el.plContainer.innerHTML = '';
        activePlaylistRow = null;
        appendPlaylistRows(0, true);
        if (typeof persistenceService.schedulePlaylistStateSave === 'function') persistenceService.schedulePlaylistStateSave(true);
    }

    function scrollPlaylistToCurrent() {
        if (!domService.el.plSidebar || !queueService.playlist || queueService.playlist.length === 0 || queueService.curIdx < 0) return;
        const active = domService.el.plContainer.querySelector('.pl-item.active');
        if (!active) return; // no current item in list, keep still
        active.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function scrollPlaylistToTop() {
        if (!domService.el.plSidebar) return;
        domService.el.plSidebar.scrollTo({ top: 0, behavior: 'smooth' });
    }

    let initialized = false;
    return {
        observePlaylistCovers,
        pausePlaylistCovers,
        refreshPlaylistItem,
        ensurePlaylistRenderedAndActive,
        appendPlaylistRows,
        renderPlaylist,
        scrollPlaylistToCurrent,
        scrollPlaylistToTop,
        initialize() {
            if (initialized) return;
            initialized = true;
            playlistCovers.initialize();
        }
    };
}
