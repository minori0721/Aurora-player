import { toHttps } from '../shared/text.js';
import { createPlaylistCovers } from './covers.js';
import { matchesPlaylistSearch, normalizePlaylistSearch, playlistSearchKey } from './search.js';

export function createPlaylistView({
    dom: domService,
    persistence: persistenceService,
    prefetch: prefetchService,
    queue: queueService
} = {}) {
    const playlistCovers = createPlaylistCovers({ root: domService.el.plSidebar, container: domService.el.plItems || domService.el.plContainer });
    const observePlaylistCovers = () => playlistCovers.observe();
    const pausePlaylistCovers = () => playlistCovers.suspend();

    let activePlaylistRow = null;
    let playlistIndexDigits = 0;
    let searchQueue = queueService.playlist, searchTerms = [], searchKeys = [], visibleCount = 0;
    let searchFrame = 0, composing = false, unfilteredScrollTop = 0;
    let temporaryRows = new Map(), renderedTemporary = [];
    const base = () => queueService.basePlaylist;
    const rowAt = index => index < base().length ? domService.el.plContainer.children[index] : temporaryRows.get(index);
    const rowEntries = () => [
        ...Array.from(domService.el.plContainer.children, (row, index) => ({ row, index })),
        ...Array.from(temporaryRows, ([index, row]) => ({ row, index }))
    ];

    function updateSearchUI() {
        const { plSearch, plSearchClear, plSearchEmpty } = domService.el;
        if (plSearchClear) plSearchClear.disabled = !plSearch?.value;
        if (plSearchEmpty) {
            plSearchEmpty.hidden = visibleCount > 0;
            plSearchEmpty.textContent = searchTerms.length ? '没有匹配的歌曲' : '播放列表为空';
        }
    }

    function filterRow(row, track, index) {
        searchKeys[index] = playlistSearchKey(track);
        row.hidden = !matchesPlaylistSearch(searchKeys[index], searchTerms);
        return !row.hidden;
    }

    function setSearchQuery(value = '', { restore = true } = {}) {
        window.cancelAnimationFrame(searchFrame); searchFrame = 0;
        const hadSearch = searchTerms.length > 0;
        searchTerms = normalizePlaylistSearch(value).split(/\s+/u).filter(Boolean);
        if (!hadSearch && searchTerms.length) unfilteredScrollTop = domService.el.plSidebar.scrollTop || 0;
        if (domService.el.plSearch) domService.el.plSearch.value = String(value);
        visibleCount = 0;
        for (const { row, index } of rowEntries()) {
            const match = matchesPlaylistSearch(searchKeys[index] || '', searchTerms);
            if (row.hidden === match) row.hidden = !match;
            if (match) visibleCount++;
        }
        if (restore) domService.el.plSidebar.scrollTop = searchTerms.length ? 0 : hadSearch ? unfilteredScrollTop : domService.el.plSidebar.scrollTop;
        updateSearchUI();
        playlistCovers.visibilityChanged();
    }

    function scheduleSearch() {
        if (composing || searchFrame) return;
        searchFrame = window.requestAnimationFrame(() => { searchFrame = 0; setSearchQuery(domService.el.plSearch?.value || ''); });
    }

    function updatePlaylistActiveItem() {
        const nextRow = rowAt(queueService.curIdx) || null;
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
        persistenceService.schedulePlaylistStateSave();
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
        const row = rowAt(index);
        const track = queueService.playlist[index];
        if (!row || !track) return;
        const wasVisible = !row.hidden;
        const isVisible = filterRow(row, track, index);
        visibleCount += Number(isVisible) - Number(wasVisible);
        updateSearchUI();

        row.setAttribute('aria-label', track.needsFile
            ? (track.fileHandle ? `授权并播放第 ${index + 1} 首：${track.name}` : `第 ${index + 1} 首：${track.name}，需要重新选择本地文件`)
            : row._temporaryNumber ? `播放临时点播第 ${row._temporaryNumber} 首：${track.name}` : `播放第 ${index + 1} 首：${track.name}`);
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
        if (wasVisible !== isVisible) observePlaylistCovers();
    }

    function ensurePlaylistRenderedAndActive() {
        if (searchQueue !== queueService.playlist || domService.el.plContainer.children.length !== base().length) renderPlaylist();
        else {
            const temporary = queueService.temporaryEntries || [];
            if (temporary.length !== renderedTemporary.length || temporary.some((track, index) => track !== renderedTemporary[index])
                || [...temporaryRows].some(([index, row]) => queueService.playlist[index] !== row._track)) renderTemporaryRows();
            updatePlaylistActiveItem();
        }
    }

    function createPlaylistRow(track, index, number = index + 1) {
        const d = document.createElement('button');
        d.type = 'button';
        d.className = 'pl-item';
        d.setAttribute('aria-current', 'false');
        const indexEl = document.createElement('span');
        indexEl.className = 'pl-item-index';
        indexEl.textContent = String(number);

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
                prefetchService.cancelNextPreload();
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

    function renderTemporaryRows() {
        if (!domService.el.plTemporaryContainer) return;
        for (const row of temporaryRows.values()) {
            if (!row.hidden) visibleCount--;
            const cover = row.querySelector('.pl-item-cover');
            if (cover) playlistCovers.bind(cover, '');
        }
        temporaryRows = new Map();
        renderedTemporary = queueService.temporaryEntries || [];
        domService.el.plTemporaryContainer.style.setProperty('--playlist-index-digits', String(Math.max(3, String(renderedTemporary.length).length)));
        domService.el.plTemporaryContainer.classList.toggle('pl-large', renderedTemporary.length > 500);
        domService.el.plTemporaryContainer.innerHTML = '';
        renderedTemporary.forEach((track, number) => {
            const index = queueService.indexOfTrack(track);
            const row = createPlaylistRow(track, index, number + 1);
            row._track = track;
            row._temporaryNumber = number + 1;
            row.setAttribute('aria-label', `播放临时点播第 ${number + 1} 首：${track.name}`);
            if (filterRow(row, track, index)) visibleCount++;
            temporaryRows.set(index, row);
            domService.el.plTemporaryContainer.appendChild(row);
        });
        domService.el.plTemporary.hidden = !renderedTemporary.length;
        domService.el.plBaseLabel.hidden = !renderedTemporary.length || !base().length;
        if (domService.el.plClearTemporary) domService.el.plClearTemporary.disabled = !(queueService.manualState?.pending.length);
        observePlaylistCovers();
        updateSearchUI();
    }

    function appendPlaylistRows(startIndex = 0, force = false) {
        if (!force && domService.el.plContainer.children.length !== startIndex) {
            renderPlaylist();
            return;
        }
        const digits = Math.max(3, String(base().length).length);
        domService.el.plContainer.classList.toggle('pl-large', base().length > 500);
        if (digits !== playlistIndexDigits) {
            playlistIndexDigits = digits;
            domService.el.plContainer.style.setProperty('--playlist-index-digits', String(digits));
        }
        const frag = document.createDocumentFragment();
        for (let i = startIndex; i < base().length; i++) {
            const row = createPlaylistRow(base()[i], i);
            if (filterRow(row, base()[i], i)) visibleCount++;
            frag.appendChild(row);
        }
        domService.el.plContainer.appendChild(frag);
        renderTemporaryRows();
        updatePlaylistActiveItem();
        observePlaylistCovers();
        updateSearchUI();
        persistenceService.schedulePlaylistStateSave(true);
    }

    function renderPlaylist() {
        if (searchQueue !== queueService.playlist) {
            searchQueue = queueService.playlist;
            window.cancelAnimationFrame(searchFrame); searchFrame = 0;
            searchTerms = []; unfilteredScrollTop = 0; composing = false;
            if (domService.el.plSearch) domService.el.plSearch.value = '';
        }
        searchKeys = []; visibleCount = 0;
        temporaryRows = new Map();
        playlistCovers.reset();
        domService.el.plContainer.innerHTML = '';
        activePlaylistRow = null;
        appendPlaylistRows(0, true);
        persistenceService.schedulePlaylistStateSave(true);
    }

    function scrollPlaylistToCurrent() {
        if (!domService.el.plSidebar || !queueService.playlist || queueService.playlist.length === 0 || queueService.curIdx < 0) return;
        const active = rowAt(queueService.curIdx);
        if (!active) return; // no current item in list, keep still
        if (active.hidden) setSearchQuery('', { restore: false });
        active.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function scrollPlaylistToTop() {
        if (!domService.el.plSidebar) return;
        domService.el.plSidebar.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function getVisiblePlaylistIndexes() {
        if (!domService.el.plSidebar.classList.contains('show')) return [];
        const viewport = domService.el.plSidebar.getBoundingClientRect();
        const rows = Array.from(domService.el.plContainer.children, (row, index) => ({ row, index })).filter(item => !item.row.hidden);
        let low = 0, high = rows.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (rows[mid].row.getBoundingClientRect().bottom <= viewport.top) low = mid + 1;
            else high = mid;
        }
        const indexes = [];
        for (let index = low; index < rows.length && indexes.length < 20; index++) {
            if (rows[index].row.getBoundingClientRect().top >= viewport.bottom) break;
            indexes.push(rows[index].index);
        }
        return indexes;
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
        getVisiblePlaylistIndexes,
        setSearchQuery,
        initialize() {
            if (initialized) return;
            initialized = true;
            playlistCovers.initialize();
            domService.el.plClearTemporary?.addEventListener('click', () => queueService.clearTemporaryQueue());
            domService.el.plSearch?.addEventListener('input', event => { if (!event.isComposing) scheduleSearch(); });
            domService.el.plSearch?.addEventListener('compositionstart', () => { composing = true; window.cancelAnimationFrame(searchFrame); searchFrame = 0; });
            domService.el.plSearch?.addEventListener('compositionend', () => { composing = false; scheduleSearch(); });
            domService.el.plSearch?.addEventListener('keydown', event => {
                if (event.key !== 'Escape' || composing || event.isComposing || !domService.el.plSearch.value) return;
                event.preventDefault(); event.stopPropagation(); setSearchQuery('');
            });
            domService.el.plSearchClear?.addEventListener('click', () => { setSearchQuery(''); domService.el.plSearch?.focus(); });
        }
    };
}
