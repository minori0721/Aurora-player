import { toHttps } from '../shared/text.js';
import { createPlaylistCovers } from './covers.js';
import { createPlaylistFade } from './fade.js';
import { createPlaylistRows } from './rows.js';
import { matchesPlaylistSearch, normalizePlaylistSearch, playlistSearchKey } from './search.js';

export function createPlaylistView({
    dom: domService,
    persistence: persistenceService,
    prefetch: prefetchService,
    queue: queueService
} = {}) {
    const playlistCovers = createPlaylistCovers({ root: domService.el.plSidebar, container: domService.el.plItems || domService.el.plContainer });
    const playlistFade = createPlaylistFade({ root: domService.el.plSidebar, containers: [domService.el.plContainer, domService.el.plTemporaryContainer] });
    const observePlaylistCovers = () => { playlistCovers.observe(); playlistFade.observe(); };
    const pausePlaylistCovers = () => { playlistCovers.suspend(); playlistFade.suspend(); };

    let activePlaylistRow = null;
    let playlistIndexDigits = 0, sharedIndexDigits = 0;
    let searchQueue = queueService.playlist, searchTerms = [], searchKeys = [];
    let searchFrame = 0, composing = false, unfilteredScrollTop = 0;
    let temporaryRows = new Map(), renderedTemporary = [];
    const baseRows = createPlaylistRows(domService.el.plContainer);
    const manualRows = domService.el.plTemporaryContainer ? createPlaylistRows(domService.el.plTemporaryContainer) : null;
    const base = () => queueService.basePlaylist;
    const rowAt = index => index < base().length ? baseRows.at(index) : temporaryRows.get(index);

    function updateSearchUI() {
        const { plSearch, plSearchClear, plSearchEmpty } = domService.el;
        if (plSearchClear) plSearchClear.disabled = !plSearch?.value;
        if (plSearchEmpty) {
            plSearchEmpty.hidden = baseRows.visibleCount + (manualRows?.visibleCount || 0) > 0;
            plSearchEmpty.textContent = searchTerms.length ? '没有匹配的歌曲' : '播放列表为空';
        }
    }

    function matchesTrack(track, index) {
        searchKeys[index] = playlistSearchKey(track);
        return matchesPlaylistSearch(searchKeys[index], searchTerms);
    }

    function setSearchQuery(value = '', { restore = true } = {}) {
        window.cancelAnimationFrame(searchFrame); searchFrame = 0;
        const hadSearch = searchTerms.length > 0;
        const previousScrollTop = domService.el.plSidebar.scrollTop || 0;
        searchTerms = normalizePlaylistSearch(value).split(/\s+/u).filter(Boolean);
        if (!hadSearch && searchTerms.length) unfilteredScrollTop = previousScrollTop;
        if (domService.el.plSearch) domService.el.plSearch.value = String(value);
        baseRows.filter(index => matchesPlaylistSearch(searchKeys[index] || '', searchTerms));
        manualRows?.filter(index => matchesPlaylistSearch(searchKeys[manualRows.at(index)._queueIndex] || '', searchTerms));
        updateSearchUI();
        const nextScrollTop = searchTerms.length ? 0 : hadSearch ? unfilteredScrollTop : previousScrollTop;
        const hasResults = baseRows.visibleCount + (manualRows?.visibleCount || 0) > 0;
        // Settle nonempty results before cover scheduling; empty layouts need no redundant scroll write.
        if (restore && (searchTerms.length && hasResults || nextScrollTop !== previousScrollTop)) domService.el.plSidebar.scrollTop = nextScrollTop;
        playlistCovers.visibilityChanged();
        playlistFade.refresh();
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
                playlistFade.invalidate(activePlaylistRow);
                activePlaylistRow.setAttribute('aria-current', 'false');
            }
            if (nextRow) {
                nextRow.classList.add('active');
                playlistFade.invalidate(nextRow);
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

    function updatePlaylistTitle(titleEl, track) {
        const song = track.songData;
        const title = typeof song?.name === 'string' && song.name.trim() ? song.name : track.name;
        const artists = Array.isArray(song?.ar) && song.ar.length ? song.ar : song?.artists;
        const artist = Array.isArray(artists) ? artists.map(item => item?.name || item?.artistName || '').filter(Boolean).join(', ') : '';
        const icon = !track.netease && track.needsFile ? '⚠️ ' : '';
        let nameEl = titleEl.querySelector('.pl-song-name');
        if (!nameEl) {
            nameEl = document.createElement('span');
            nameEl.className = 'pl-song-name';
            titleEl.appendChild(nameEl);
        }
        nameEl.textContent = `${icon}${title}`;
        titleEl.title = `${icon}${title}${artist ? ` - ${artist}` : ''}`;
        let artistEl = titleEl.querySelector('.pl-song-artists');
        let separatorEl = titleEl.querySelector('.pl-song-separator');
        if (artist && !artistEl) {
            separatorEl = document.createElement('span');
            separatorEl.className = 'pl-song-separator';
            separatorEl.textContent = ' - ';
            separatorEl.setAttribute('aria-hidden', 'true');
            artistEl = document.createElement('span');
            artistEl.className = 'pl-song-artists';
            titleEl.appendChild(separatorEl);
            titleEl.appendChild(artistEl);
        }
        if (artistEl) {
            artistEl.textContent = artist;
            artistEl.hidden = separatorEl.hidden = !artist;
        }
    }

    function refreshPlaylistItem(index) {
        persistenceService.schedulePlaylistTrackSave(index);
        const track = queueService.playlist[index];
        if (!track) return;
        const isVisible = matchesTrack(track, index);
        const row = rowAt(index);
        if (!row) return;
        const visibilityChanged = index < base().length ? baseRows.setVisible(index, isVisible)
            : manualRows?.setVisible(row._temporaryNumber - 1, isVisible);
        updateSearchUI();

        row.setAttribute('aria-label', track.needsFile
            ? (track.fileHandle ? `授权并播放第 ${index + 1} 首：${track.name}` : `第 ${index + 1} 首：${track.name}，需要重新选择本地文件`)
            : row._temporaryNumber ? `播放临时点播第 ${row._temporaryNumber} 首：${track.name}` : `播放第 ${index + 1} 首：${track.name}`);
        const titleEl = row.querySelector('.pl-item-title');
        if (titleEl) updatePlaylistTitle(titleEl, track);
        updatePlaylistCompanionMarker(row, track);
        playlistFade.invalidate(row);

        const coverEl = row.querySelector('.pl-item-cover');
        if (!coverEl) return;
        const coverUrl = toHttps(track.songData?.album?.picUrl || track.songData?.al?.picUrl || '');
        playlistCovers.bind(coverEl, coverUrl);
        if (visibilityChanged) playlistCovers.visibilityChanged();
    }

    function ensurePlaylistRenderedAndActive() {
        if (searchQueue !== queueService.playlist || baseRows.length !== base().length) renderPlaylist();
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
        d._track = track;
        d._queueIndex = index;
        d.setAttribute('aria-label', track.needsFile
            ? (track.fileHandle ? `授权并播放第 ${index + 1} 首：${track.name}` : `第 ${index + 1} 首：${track.name}，需要重新选择本地文件`)
            : `播放第 ${index + 1} 首：${track.name}`);
        updatePlaylistTitle(titleEl, track);
        return d;
    }

    function playRow(event) {
        const row = event.target.closest?.('.pl-item');
        if (!row) return;
        const index = row._queueIndex, track = row._track;
        if (queueService.playlist[index] !== track) return;
        if (!prefetchService.isNextPreloadCompatible(queueService.playlist, index, track)) prefetchService.cancelNextPreload();
        queueService.playTrackFromPlaylist(index);
    }

    domService.el.plContainer.addEventListener('click', playRow);
    domService.el.plTemporaryContainer?.addEventListener('click', playRow);

    function renderTemporaryRows() {
        if (!domService.el.plTemporaryContainer) return;
        for (const row of temporaryRows.values()) {
            const cover = row.querySelector('.pl-item-cover');
            if (cover) playlistCovers.bind(cover, '');
        }
        temporaryRows = new Map();
        renderedTemporary = queueService.temporaryEntries || [];
        const digits = Math.max(3, String(Math.max(base().length, renderedTemporary.length)).length);
        if (digits !== sharedIndexDigits) {
            sharedIndexDigits = digits;
            domService.el.plSidebar.style.setProperty('--playlist-shared-index-digits', String(digits));
        }
        domService.el.plTemporaryContainer.style.setProperty('--playlist-index-digits', String(Math.max(3, String(renderedTemporary.length).length)));
        domService.el.plTemporaryContainer.classList.toggle('pl-large', renderedTemporary.length > 500);
        manualRows.clear();
        const rows = [], matches = [];
        renderedTemporary.forEach((track, number) => {
            const index = queueService.indexOfTrack(track);
            const row = createPlaylistRow(track, index, number + 1);
            row._track = track;
            row._temporaryNumber = number + 1;
            row.setAttribute('aria-label', `播放临时点播第 ${number + 1} 首：${track.name}`);
            matches.push(matchesTrack(track, index));
            temporaryRows.set(index, row);
            rows.push(row);
        });
        manualRows.append(rows, matches);
        domService.el.plTemporary.hidden = !renderedTemporary.length;
        domService.el.plBaseLabel.hidden = !renderedTemporary.length || !base().length;
        if (domService.el.plClearTemporary) domService.el.plClearTemporary.disabled = !(queueService.manualState?.pending.length);
        observePlaylistCovers();
        updateSearchUI();
    }

    function appendPlaylistRows(startIndex = 0, force = false) {
        if (!force && baseRows.length !== startIndex) {
            renderPlaylist();
            return;
        }
        const digits = Math.max(3, String(base().length).length);
        domService.el.plContainer.classList.toggle('pl-large', base().length > 500);
        if (digits !== playlistIndexDigits) {
            playlistIndexDigits = digits;
            domService.el.plContainer.style.setProperty('--playlist-index-digits', String(digits));
        }
        const rows = [], matches = [];
        for (let i = startIndex; i < base().length; i++) {
            const row = createPlaylistRow(base()[i], i);
            matches.push(matchesTrack(base()[i], i));
            rows.push(row);
        }
        baseRows.append(rows, matches);
        renderTemporaryRows();
        updatePlaylistActiveItem();
        observePlaylistCovers();
        updateSearchUI();
        persistenceService.schedulePlaylistStateSave(true);
    }

    function renderPlaylist({ preservePosition = false } = {}) {
        const sidebar = domService.el.plSidebar;
        const scrollTop = sidebar.scrollTop || 0;
        const anchors = preservePosition && scrollTop > 1 ? getVisiblePlaylistIndexes().map(index => {
            const row = baseRows.at(index);
            return { track: row._track, top: row.getBoundingClientRect().top };
        }) : [];
        const focused = preservePosition && domService.el.plContainer.contains(document.activeElement)
            ? document.activeElement?._track : null;
        if (searchQueue !== queueService.playlist) {
            searchQueue = queueService.playlist;
            window.cancelAnimationFrame(searchFrame); searchFrame = 0;
            searchTerms = []; unfilteredScrollTop = 0; composing = false;
            if (domService.el.plSearch) domService.el.plSearch.value = '';
        }
        searchKeys = [];
        temporaryRows = new Map();
        playlistCovers.reset();
        playlistFade.reset();
        baseRows.clear();
        activePlaylistRow = null;
        appendPlaylistRows(0, true);
        if (preservePosition) {
            if (focused) rowAt(queueService.indexOfTrack(focused))?.focus({ preventScroll: true });
            const anchor = anchors.find(item => queueService.indexOfTrack(item.track) >= 0);
            if (anchor) {
                const row = rowAt(queueService.indexOfTrack(anchor.track));
                sidebar.scrollTop += row.getBoundingClientRect().top - anchor.top;
            } else sidebar.scrollTop = scrollTop;
        }
        persistenceService.schedulePlaylistStateSave(true);
    }

    function scrollPlaylistToCurrent() {
        if (!domService.el.plSidebar || !queueService.playlist || queueService.playlist.length === 0 || queueService.curIdx < 0) return;
        const active = rowAt(queueService.curIdx);
        if (!active) return; // no current item in list, keep still
        const visible = queueService.curIdx < base().length ? baseRows.isVisible(queueService.curIdx)
            : manualRows?.isVisible(active._temporaryNumber - 1);
        if (!visible) setSearchQuery('', { restore: false });
        active.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function scrollPlaylistToTop() {
        if (!domService.el.plSidebar) return;
        domService.el.plSidebar.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function getVisiblePlaylistIndexes() {
        if (!domService.el.plSidebar.classList.contains('show')) return [];
        const viewport = domService.el.plSidebar.getBoundingClientRect();
        const indexes = baseRows.visibleIndexes();
        let low = 0, high = indexes.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (baseRows.at(indexes[mid]).getBoundingClientRect().bottom <= viewport.top) low = mid + 1;
            else high = mid;
        }
        const visible = [];
        for (let index = low; index < indexes.length && visible.length < 20; index++) {
            if (baseRows.at(indexes[index]).getBoundingClientRect().top >= viewport.bottom) break;
            visible.push(indexes[index]);
        }
        return visible;
    }

    let initialized = false;
    return {
        observePlaylistCovers,
        pausePlaylistCovers,
        refreshPlaylistItem,
        ensurePlaylistRenderedAndActive,
        appendPlaylistRows,
        getRenderedPlaylistLength: () => baseRows.length,
        renderPlaylist,
        scrollPlaylistToCurrent,
        scrollPlaylistToTop,
        getVisiblePlaylistIndexes,
        setSearchQuery,
        initialize() {
            if (initialized) return;
            initialized = true;
            playlistCovers.initialize();
            playlistFade.initialize();
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
