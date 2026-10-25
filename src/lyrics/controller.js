import { escapeHtml } from '../shared/text.js';
import { alignWordLyricTimeline, createLyricTimeLookup, extractLyricsText, parseLyricsToArray, selectNeteaseLyricTracks } from './parser.js';
import { chooseNeteaseSongMatch, extractNeteaseMatchSongs, getNeteaseSongArtists } from './matching.js';
import { createLyricViewport } from './viewport.js';
import { LYRIC_SCROLL_LEAD_MS } from './motion.js';
import { createLyricRequests, isLyricResponse } from './requests.js';
import { createWordLyricMotion } from './word-motion.js';

export function createLyrics({
    api: apiService,
    cache: cacheService,
    debug: debugService,
    dom: domService,
    metadata: metadataService,
    playback: playbackService
} = {}) {
    let neteaseLyricAbortController = null;
    const lyricRequests = createLyricRequests({ api: apiService, cache: cacheService });

    let localLyricSession = null;

    let lyrics = [], isSyncedLyrics = true;

    let activeLyricIndex = -1, lyricCursorTime = -Infinity;
    let scrollAheadIndex = -1;

    let neteaseSearchEnabled = false;

    let lyricViewport = null;
    let wordMotion = null;

    function resetTrackLyrics() {
        lyricRequests.cancelTaken();
        wordMotion?.reset();
        lyricViewport?.reset();
        lyrics = [];
        activeLyricIndex = -1;
        scrollAheadIndex = -1;
        lyricCursorTime = -Infinity;
        isSyncedLyrics = true;
        originalLyricsText = translatedLyricsText = romanLyricsText = '';
        originalLyricsArr = [];
        translatedLyricsArr = [];
        romanLyricsArr = [];
        lyricMetadataArr = [];
        yrcData = null;
        _lastActiveLyric = null;
        domService.el.lyricBox.style.transform = 'translateY(0)';
        updateLyricToggleUI();
    }

    let lyricDisplayMode = localStorage.getItem('lyric_mode') || 'original';
    if (!['original', 'both', 'roma'].includes(lyricDisplayMode)) lyricDisplayMode = 'original';

    // The preferred mode survives tracks that temporarily lack its extra text.
    let originalLyricsText = '';

    let translatedLyricsText = '';

    let romanLyricsText = '';

    let originalLyricsArr = [];

    let translatedLyricsArr = [];

    let romanLyricsArr = [];

    let lyricMetadataArr = [];

    let yrcData = null;

    function availableLyricModes() {
        const hasTranslation = translatedLyricsArr.some(line => line.txt.trim());
        const hasRoman = romanLyricsArr.some(line => line.txt.trim());
        if (!originalLyricsArr.some(line => line.txt.trim()) && !hasTranslation && !hasRoman) return [];
        return ['original', ...(hasTranslation ? ['both'] : []), ...(hasRoman ? ['roma'] : [])];
    }

    function effectiveLyricMode() {
        return availableLyricModes().includes(lyricDisplayMode) ? lyricDisplayMode : 'original';
    }

    function updateLyricToggleUI() {
        const modes = availableLyricModes(), mode = effectiveLyricMode();
        const names = { original: '仅原文', both: '原文＋翻译', roma: '原文＋罗马音' };
        const missing = { original: '歌词', both: '翻译', roma: '罗马音' };
        for (const input of domService.lyricModeInputs || []) {
            input.disabled = !modes.includes(input.value);
            input.checked = !input.disabled && input.value === mode;
            input.title = input.disabled ? `当前歌曲暂无${missing[input.value]}` : names[input.value];
        }
        const button = domService.lyricToggleBtn;
        if (!button) return;
        button.disabled = modes.length < 2;
        button.style.opacity = button.disabled ? '0.45' : '';
        button.title = button.disabled ? '暂无更多歌词文本'
            : `当前：${names[mode]}（点击切至：${names[modes[(modes.indexOf(mode) + 1) % modes.length]]}）`;
        button.setAttribute('aria-label', button.title);
    }

    function setNeteaseSearchEnabled(value) {
        const enabled = Boolean(value), changed = enabled !== neteaseSearchEnabled;
        neteaseSearchEnabled = enabled;
        if (domService.cloudLyricsSwitch) domService.cloudLyricsSwitch.checked = enabled;
        if (domService.neteaseBtn) {
            domService.neteaseBtn.style.background = enabled ? '#27ae60' : '';
            domService.neteaseBtn.style.color = enabled ? '#fff' : '';
            domService.neteaseBtn.setAttribute('aria-pressed', String(enabled));
        }
        if (changed && localLyricSession) {
            if (enabled) updateLocalLyrics(localLyricSession);
            else cancelLocalLyricSearch(localLyricSession);
        }
    }

    function setLyricDisplayMode(mode) {
        if (!availableLyricModes().includes(mode)) { updateLyricToggleUI(); return false; }
        const previousMode = effectiveLyricMode();
        lyricDisplayMode = mode;
        try { localStorage.setItem('lyric_mode', mode); } catch (_) {}
        updateLyricToggleUI();
        if (previousMode === mode) return true;
        const lines = domService.el.lyricBox.querySelectorAll('.lyric-line');
        const hasTimedData = originalLyricsArr.some(line => line.t >= 0) || translatedLyricsArr.some(line => line.t >= 0) || romanLyricsArr.some(line => line.t >= 0);
        if (lines.length && hasTimedData) {
            domService.el.lyricBox.querySelectorAll('.lyric-translation').forEach(node => node.remove());
            if (mode !== 'original') {
                const target = mode === 'both' ? translatedLyricsArr : romanLyricsArr;
                const exactExtra = new Map(target.map(line => [line.t.toFixed(3), line]));
                const findExtra = yrcData?.length ? time => exactExtra.get(time.toFixed(3)) : createLyricTimeLookup(target);
                lines.forEach(line => {
                    const time = Number.parseFloat(line.dataset.time ?? '-1');
                    if (!Number.isFinite(time) || time < 0) return;
                    const extra = findExtra(time);
                    if (!extra?.txt) return;
                    const text = document.createElement('div');
                    text.className = 'lyric-translation';
                    text.textContent = extra.txt;
                    (line.querySelector('.lyric-visual') || line).appendChild(text);
                });
            }
            lyricViewport?.relayout();
            refreshLyricHighlightAndCenter();
        } else renderLyricsFromArrays();
        return true;
    }

    // Safe set artist tags (avoid duplicate appends)
    function setArtistTag(sourceText, qualityText) {
        const artistEl = domService.el.artist;
        // Remove existing tag spans
        const existingSource = artistEl.querySelector('.tag-source');
        if (existingSource) existingSource.remove();
        const existingQuality = artistEl.querySelector('.tag-quality');
        if (existingQuality) existingQuality.remove();
        // Append new ones if provided
        if (sourceText) {
            const sp = document.createElement('span');
            sp.className = 'tag-source';
            sp.textContent = sourceText;
            artistEl.appendChild(document.createTextNode(' '));
            artistEl.appendChild(sp);
        }
        if (qualityText) {
            const sp2 = document.createElement('span');
            sp2.className = 'tag-quality';
            sp2.textContent = qualityText;
            artistEl.appendChild(document.createTextNode(' '));
            artistEl.appendChild(sp2);
        }
    }

    // 渲染函数（在切换显示模式时复用）
    function renderLyricsFromArrays(source) {
        const displayMode = effectiveLyricMode();
        const hasSynced = originalLyricsArr.some(l=>l.t>=0) || translatedLyricsArr.some(l=>l.t>=0);
        isSyncedLyrics = hasSynced;
        // 合并时间点（保留三位小数作为key）
        const timeSet = new Set();
        originalLyricsArr.filter(l=>l.t>=0).forEach(l=>timeSet.add(l.t.toFixed(3)));
        translatedLyricsArr.filter(l=>l.t>=0).forEach(l=>timeSet.add(l.t.toFixed(3)));
        const times = Array.from(timeSet).map(t=>parseFloat(t)).sort((a,b)=>a-b);
        // 构建主 lyrics 数组（用于高亮与滚动）
        lyrics = [];
        activeLyricIndex = -1;
        scrollAheadIndex = -1;
        lyricCursorTime = -Infinity;
        _lastActiveLyric = null;
        wordMotion?.reset();
        domService.el.lyricBox.style.transform = 'translateY(0)';
        lyricViewport?.reset();
        domService.el.lyricBox.innerHTML = '';

        if(hasSynced && times.length) {
            const frag = document.createDocumentFragment();
            const exactOriginal = new Map(originalLyricsArr.map(line => [line.t.toFixed(3), line]));
            const findOriginal = yrcData?.length ? t => exactOriginal.get(t.toFixed(3)) : createLyricTimeLookup(originalLyricsArr);
            const exactTranslation = new Map(translatedLyricsArr.map(line => [line.t.toFixed(3), line]));
            const exactRoman = new Map(romanLyricsArr.map(line => [line.t.toFixed(3), line]));
            const findTranslation = yrcData?.length ? t => exactTranslation.get(t.toFixed(3)) : createLyricTimeLookup(translatedLyricsArr);
            const findRoman = yrcData?.length ? t => exactRoman.get(t.toFixed(3)) : createLyricTimeLookup(romanLyricsArr);
            const yrcByTime = new Map((yrcData || []).map(line => [line.t.toFixed(3), line]));
            times.forEach(t => {
                const orig = findOriginal(t);
                const trans = findTranslation(t);
                const roman = findRoman(t);

                const otext = orig ? orig.txt : (trans ? trans.txt : (roman ? roman.txt : ''));
                const ttext = trans ? trans.txt : '';
                const rtext = roman ? roman.txt : '';

                lyrics.push({ t, txt: otext });

                const container = document.createElement('div');
                container.className = 'lyric-line';
                container.dataset.time = t;
                container.dataset.lyricTime = t;
                container.setAttribute('role', 'button');
                container.tabIndex = -1;
                const visual = document.createElement('div');
                visual.className = 'lyric-visual';
                container.appendChild(visual);

                // === YRC 逐字渲染分支 ===
                const yrcLine = yrcByTime.get(t.toFixed(3));
                if (yrcLine && yrcLine.words.length > 0) {
                    container.classList.add('lyric-word');
                    // 找到对应逐字数据：用 span 包裹每个字
                    const odiv = document.createElement('div');
                    odiv.className = 'lyric-original yrc-line';
                    yrcLine.words.forEach(w => {
                        const sp = document.createElement('span');
                        sp.className = 'yrc-char';
                        sp.textContent = w.txt;
                        // 存储时序信息供激活时使用（相对行起始的毫秒）
                        sp.dataset.start = w.start - (yrcLine.t * 1000);
                        sp.dataset.dur = w.dur;
                        odiv.appendChild(sp);
                    });
                    visual.appendChild(odiv);
                } else {
                    // 无逐字数据：回退普通文字
                    const odiv = document.createElement('div');
                    odiv.className = 'lyric-original';
                    odiv.textContent = otext || ttext || rtext || '';
                    visual.appendChild(odiv);
                }

                // 原文保持同一节点，附属文本只在下面增减。
                if (displayMode !== 'original') {
                    const subContent = displayMode === 'both' ? ttext : rtext;
                    if (subContent) {
                        const subDiv = document.createElement('div');
                        subDiv.className = 'lyric-translation';
                        subDiv.textContent = subContent;
                        visual.appendChild(subDiv);
                    }
                }

                frag.appendChild(container);
            });
            domService.el.lyricBox.appendChild(frag);
        } else if(!hasSynced) {
            // 无时间标签的纯文本歌词
            const origText = originalLyricsArr.map(l=>l.txt).join('\n');
            const transText = translatedLyricsArr.map(l=>l.txt).join('\n');
            const romaText = romanLyricsArr.map(l=>l.txt).join('\n');
            const metaText = lyricMetadataArr.map(l=>l.txt).join('\n');
            const metaOnlyHtml = metaText
                ? `<div class="lyric-line active" style="margin-top:100px; cursor:default;"><div>🎵 纯音乐，无歌词</div><div class="lyric-translation" style="white-space:pre-wrap;">${escapeHtml(metaText)}</div></div>`
                : `<div class="lyric-line active" style="margin-top:100px; cursor:default;">暂无歌词</div>`;
            if(displayMode === 'original') {
                if (origText || transText || romaText) {
                    domService.el.lyricBox.innerHTML = `<div class="lyric-original" style="padding:20px; text-align:center; white-space:pre-wrap; color:var(--text-main); font-size:1rem; line-height:1.8;">${escapeHtml(origText || transText || romaText)}</div>`;
                } else {
                    domService.el.lyricBox.innerHTML = metaOnlyHtml;
                }
            } else {
                const subText = displayMode === 'both' ? transText : romaText;
                if (origText || subText) {
                    domService.el.lyricBox.innerHTML = `<div class="lyric-original" style="padding:20px; text-align:center; white-space:pre-wrap; color:var(--text-main); font-size:1rem; line-height:1.4;">${escapeHtml(origText)}</div><div class="lyric-translation" style="margin:0;padding:8px 20px;text-align:center;white-space:pre-wrap;color:var(--text-sub);font-size:0.95rem;line-height:1.6;">${escapeHtml(subText)}</div>`;
                } else {
                    domService.el.lyricBox.innerHTML = metaOnlyHtml;
                }
            }
        } else {
            domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">暂无歌词</div>';
        }

        lyricViewport?.setLines(hasSynced ? domService.el.lyricBox.querySelectorAll('[data-lyric-time]') : []);

        // 无论有没有歌词，都设置来源和音质标签（修复无歌词时不显示标签的bug）
        setArtistTag(source || '', metadataService.currentAudioQuality || '');

        // 尝试立即刷新高亮并居中当前播放位置
        try { refreshLyricHighlightAndCenter(true); } catch(e) {}
    }

    function cancelLocalLyricSearch(session) {
        if (!session) return;
        session.requestId++;
        session.controller?.abort();
        session.controller = null;
        session.searchKey = null;
    }

    function cancelLocalLyricSession() {
        cancelLocalLyricSearch(localLyricSession);
        localLyricSession = null;
    }

    function createLocalLyricSession(track, isCurrent) {
        cancelLocalLyricSession();
        localLyricSession = {
            track, isCurrent, source: null, metadata: null, embedded: null,
            lrcVersion: 0, lrcFile: null, lrcPending: !!track.lrcFile,
            requestId: 0, controller: null, searchKey: null
        };
        return localLyricSession;
    }

    function isLocalLyricSessionCurrent(session) {
        return !!session && localLyricSession === session && session.isCurrent();
    }

    function applyLocalLyricMetadata(session, common, source) {
        if (!isLocalLyricSessionCurrent(session)) return;
        session.metadata = { title: common.title || domService.el.title.textContent, artist: common.artist || '', album: common.album || '' };
        try {
            let text = extractLyricsText(common.lyrics);
            if (common.lyrics && !text.trim()) debugService.log('内嵌歌词格式无法识别，忽略该标签', 'warn');
            text = text.replace(/\/\s*(?=\[\d{2}:)/g, '\n');
            if (!text.includes('\n') && text.includes('/')) text = text.replace(/\s*\/\s*/g, '\n');
            const payload = prepareLyricsPayload(text);
            if (payload) session.embedded = { payload, source };
        } catch (error) {
            debugService.log(`内嵌歌词解析失败: ${error?.message || error}`, 'warn');
        }
        updateLocalLyrics(session);
    }

    function updateLocalLyrics(session) {
        if (!isLocalLyricSessionCurrent(session) || session.source === 'lrc' || session.lrcPending) return;
        if (session.embedded) {
            cancelLocalLyricSearch(session);
            if (session.source !== 'embedded') commitPreparedLyrics(session.embedded.payload, session.embedded.source);
            session.source = 'embedded';
            return;
        }
        if (!session.metadata) return;
        if (!neteaseSearchEnabled) {
            if (!session.source) domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">Pure Music</div>';
            return;
        }
        const { title, artist, album } = session.metadata;
        const duration = playbackService.playbackState.duration || 0;
        const key = JSON.stringify([title, artist, album, duration]);
        if (session.searchKey === key) return;
        cancelLocalLyricSearch(session);
        session.searchKey = key;
        const controller = new AbortController();
        session.controller = controller;
        const requestId = session.requestId;
        const guard = () => isLocalLyricSessionCurrent(session) && session.requestId === requestId
            && !controller.signal.aborted && !session.lrcPending && session.source !== 'lrc' && session.source !== 'embedded';
        searchNeteaselyrics(title, artist, duration, guard, album, {
            signal: controller.signal,
            preserveLyrics: !!session.source,
            onLyrics: (text, source, trans, roma, words) => {
                if (!guard()) return false;
                const payload = prepareLyricsPayload(text, trans, roma, words);
                if (!payload) return false;
                commitPreparedLyrics(payload, source);
                session.source = 'cloud';
                return true;
            }
        }).finally(() => {
            if (session.controller === controller) session.controller = null;
        });
    }

    async function readLrcFile(file, isCurrent = () => true, session = localLyricSession) {
        if (!isLocalLyricSessionCurrent(session) || session.track.lrcFile !== file) return;
        if (session.lrcFile === file && (session.lrcPending || session.source === 'lrc')) return;
        const version = ++session.lrcVersion;
        session.lrcFile = file;
        session.lrcPending = true;
        cancelLocalLyricSearch(session);
        const guard = () => isCurrent() && isLocalLyricSessionCurrent(session)
            && session.lrcVersion === version && session.track.lrcFile === file;
        try {
            const text = await file.text();
            if (!guard()) return;
            const payload = prepareLyricsPayload(text);
            if (!payload) throw new Error('文件中没有可用歌词或歌曲信息');
            commitPreparedLyrics(payload, "LRC File");
            session.source = 'lrc';
        } catch (error) {
            if (!guard()) return;
            debugService.log(`LRC 读取失败: ${error?.message || error}`, 'warn');
        } finally {
            if (guard()) {
                session.lrcPending = false;
                updateLocalLyrics(session);
            }
        }
    }

    async function searchNeteaselyrics(songName, artist, duration, isCurrent = () => true, album = '', options = {}) {
        try {
            if (!isCurrent()) return false;
            if (!options.preserveLyrics) domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">🔍 正在搜索歌词...</div>';

            // 智能提取歌名和歌手 - 处理 "歌手 - 歌名" 格式
            let searchSong = songName;
            let searchArtist = artist || '';

            // 如果没有单独的歌手标签，且标题包含 " - "，分离歌手和歌名
            if (!searchArtist && songName.includes(' - ')) {
                const parts = songName.split(' - ');
                if (parts.length >= 2) {
                    searchArtist = parts[0].trim();
                    searchSong = parts.slice(1).join(' - ').trim();
                }
            }

            debugService.log(`正在搜索歌词：歌曲「${searchSong}」，歌手「${searchArtist}」`);

            let bestMatch = null;
            const matchPath = `/search/match?title=${encodeURIComponent(searchSong)}&album=${encodeURIComponent(album || '')}&artist=${encodeURIComponent(searchArtist)}&duration=${encodeURIComponent(Number(duration || 0).toFixed(3))}`;
            try {
                const matchData = await cacheService.cachedFetchJson(apiService.buildApiUrl(matchPath), { useQueue: true, signal: options.signal }, 300_000);
                if (!isCurrent()) return false;
                const matchedSongs = extractNeteaseMatchSongs(matchData);
                if (matchedSongs.length) {
                    bestMatch = chooseNeteaseSongMatch(matchedSongs, { name: searchSong, artist: searchArtist, album, duration });
                    debugService.log(`本地匹配接口返回 ${matchedSongs.length} 个候选`, 'success');
                }
            } catch (error) {
                if (!isCurrent()) return false;
                if (error?.name === 'AbortError') throw error;
                debugService.log(`本地匹配接口不可用，回退综合搜索: ${error?.message || error}`, 'warn');
            }

            if (!bestMatch) {
                const searchData = await cacheService.cachedFetchJson(apiService.buildApiUrl(`/cloudsearch?keywords=${encodeURIComponent(searchSong)}&limit=20`), { useQueue: true, signal: options.signal }, 300_000);
                if (!isCurrent()) return false;
                const songs = searchData?.result?.songs || [];
                if (searchData?.code !== 200 || !songs.length) {
                    debugService.log('网易云未找到匹配歌曲', 'error');
                    if (!options.preserveLyrics) domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">未找到匹配歌曲</div>';
                    return false;
                }
                debugService.log(`综合搜索返回 ${songs.length} 个候选`, 'success');
                bestMatch = chooseNeteaseSongMatch(songs, { name: searchSong, artist: searchArtist, album, duration });
            }
            if (!bestMatch?.id) throw new Error('没有可用的歌曲匹配结果');
            debugService.log(`已选中：${bestMatch.name} - ${getNeteaseSongArtists(bestMatch)[0] || '未知歌手'}`);

            const songId = bestMatch.id;
            debugService.log(`匹配歌曲 ID：${songId} - ${bestMatch.name}`);

            // 获取歌词
            const lyricData = await lyricRequests.load(songId, { signal: options.signal, priority: 'interactive' });
            if (!isCurrent()) return false;

            const tracks = selectNeteaseLyricTracks(lyricData);
            const { wordLyrics } = tracks;
            if (tracks.original || wordLyrics) {
                debugService.log('网易云歌词已加载', 'success');
                if (wordLyrics) debugService.log(`YRC 逐字歌词已加载：${wordLyrics.length} 行`, 'success');
                const commit = options.onLyrics || parseAndRenderLyrics;
                if (!commit(tracks.original, '网易云', tracks.translated, tracks.roman, wordLyrics)) throw new Error('没有可用歌词');
                return true;
            } else if (lyricData?.nolyric || lyricData?.uncollected) {
                debugService.log('歌曲无歌词（纯音乐）', 'warn');
                if (!options.preserveLyrics) {
                    resetTrackLyrics();
                    domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">🎵 纯音乐，无歌词</div>';
                    setArtistTag('网易云', metadataService.currentAudioQuality);
                }
                return false;
            } else {
                throw new Error('接口未返回歌词');
            }
        } catch (e) {
            if (!isCurrent() || e?.name === 'AbortError') return false;
            debugService.log('网易云歌词搜索失败：' + e.message, 'error');
            if (!options.preserveLyrics) {
                domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">歌词搜索失败</div>';
                setArtistTag('网易云', metadataService.currentAudioQuality);
            }
            return false;
        }
    }

    // 直接通过歌曲ID获取歌词（用于已知ID的网易云歌曲）
    async function fetchLyricById(songId) {
        // 支持外部传入AbortController
        const options = arguments.length > 1 && arguments[1] ? arguments[1] : {};
        const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
        let lyricSignal;
        if (options.signal) {
            lyricSignal = options.signal;
        } else {
            if (neteaseLyricAbortController) neteaseLyricAbortController.abort();
            neteaseLyricAbortController = new AbortController();
            lyricSignal = neteaseLyricAbortController.signal;
        }
        try {
            if (!isCurrent()) return false;
            domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">🔍 获取歌词...</div>';
            let data = null;
            if (options.prefetched) {
                try { data = await options.prefetched; } catch (_) {}
                if (!isCurrent() || lyricSignal.aborted) return false;
            }
            // An invalid/failed prefetch falls back once; playback itself never awaits lyrics.
            if (!isLyricResponse(data)) data = await lyricRequests.load(songId, { signal: lyricSignal, priority: 'interactive' });
            if (!isCurrent()) return false;
            if (data) {
                const tracks = selectNeteaseLyricTracks(data);
                const { wordLyrics } = tracks;
                if (tracks.original || wordLyrics) {
                    debugService.log('歌词已加载', 'success');
                    if (wordLyrics) debugService.log(`YRC 逐字歌词已加载：${wordLyrics.length} 行`, 'success');
                    parseAndRenderLyrics(tracks.original, '网易云', tracks.translated, tracks.roman, wordLyrics);
                    return true;
                } else if (data?.nolyric || data?.uncollected) {
                    resetTrackLyrics();
                    domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">🎵 纯音乐，无歌词</div>';
                    setArtistTag('网易云', metadataService.currentAudioQuality); // 纯音乐也显示标签
                    return false;
                }
            }
            resetTrackLyrics();
            domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">暂无歌词</div>';
            setArtistTag('网易云', metadataService.currentAudioQuality); // 暂无歌词也显示标签
            return false;
        } catch (e) {
            if (!isCurrent() || e.name === 'AbortError') {
                // 切歌时中断，UI 将被重置，无需设置标签
                return false;
            }
            debugService.log('歌词获取失败：' + e.message, 'error');
            domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">歌词获取失败</div>';
            setArtistTag('网易云', metadataService.currentAudioQuality); // 失败也显示标签
            return false;
        }
    }

    function prepareLyricsPayload(text, transText, romaText, wordLyrics = null, allowEmpty = false) {
        const original = extractLyricsText(text);
        const translated = extractLyricsText(transText);
        const roman = extractLyricsText(romaText);
        const metadata = [];
        const { original: originalArr, translated: translatedArr, roman: romanArr } = alignWordLyricTimeline(
            parseLyricsToArray(original, metadata), parseLyricsToArray(translated, metadata),
            parseLyricsToArray(roman, metadata), wordLyrics);
        if (!allowEmpty && !originalArr.length && !translatedArr.length && !romanArr.length && !metadata.length) return null;
        return { original, translated, roman, originalArr, translatedArr, romanArr, metadata, wordLyrics };
    }

    function commitPreparedLyrics(payload, source) {
        yrcData = payload.wordLyrics;
        originalLyricsText = payload.original;
        translatedLyricsText = payload.translated;
        romanLyricsText = payload.roman;
        originalLyricsArr = payload.originalArr;
        translatedLyricsArr = payload.translatedArr;
        romanLyricsArr = payload.romanArr;
        lyricMetadataArr = payload.metadata;

        updateLyricToggleUI();

        renderLyricsFromArrays(source);
        debugService.log(`歌词解析完成：原文 ${originalLyricsArr.length} 行，翻译 ${translatedLyricsArr.length} 行，注音 ${romanLyricsArr.length} 行${lyricMetadataArr.length ? `，歌曲信息 ${lyricMetadataArr.length} 行` : ''}`, 'success');
        return true;
    }

    function parseAndRenderLyrics(text, source, transText, romaText, wordLyrics = null) {
        const payload = prepareLyricsPayload(text, transText, romaText, wordLyrics, true);
        return payload ? commitPreparedLyrics(payload, source) : false;
    }

    // 刷新当前高亮行并将其居中（可被外部调用以立即更新）
    let _lastActiveLyric = null;

    function findActiveLyricIndex(now, force = false) {
        if (!lyrics.length) return -1;
        if (force || activeLyricIndex < 0 || now < lyricCursorTime || now - lyricCursorTime > 1) {
            let low = 0, high = lyrics.length;
            while (low < high) {
                const mid = (low + high) >>> 1;
                if (lyrics[mid].t <= now) low = mid + 1;
                else high = mid;
            }
            activeLyricIndex = Math.max(0, low - 1);
        } else {
            while (activeLyricIndex + 1 < lyrics.length && lyrics[activeLyricIndex + 1].t <= now) activeLyricIndex++;
        }
        lyricCursorTime = now;
        return activeLyricIndex;
    }

    function getNextLyricTime() {
        if (!isSyncedLyrics || activeLyricIndex < 0) return null;
        return lyrics[activeLyricIndex + 1]?.t ?? null;
    }

    function getNextLyricUpdateTime() {
        const next = getNextLyricTime();
        if (next === null || !playbackService.playbackState?.isPlaying || scrollAheadIndex === activeLyricIndex + 1
            || next - lyrics[activeLyricIndex].t <= LYRIC_SCROLL_LEAD_MS * 2 / 1000) return next;
        return next - LYRIC_SCROLL_LEAD_MS / 1000;
    }

    function refreshLyricHighlightAndCenter(force = false) {
        lyricViewport?.syncPlayback();
        if(!isSyncedLyrics || !lyrics || !lyrics.length) return;
        const now = playbackService.getCurrentTime();
        const continuous = !force && now >= lyricCursorTime && now - lyricCursorTime <= .25;
        if (force || !playbackService.playbackState?.isPlaying) scrollAheadIndex = -1;
        const idx = findActiveLyricIndex(now, force);
        const activeLine = domService.el.lyricBox.children[idx];
        if(!activeLine) return;

        const next = getNextLyricTime(), updateAt = getNextLyricUpdateTime();
        // Anticipate only scrolling; highlighting and YRC still use the real playback time.
        if (!force && next !== null && updateAt < next && now >= updateAt && now < next) {
            scrollAheadIndex = idx + 1;
            if (continuous) lyricViewport?.anticipate(idx + 1);
        }

        // 避免每帧重复读取 DOM 宽高属性和清空类名（导致 Layout Thrashing/重排风暴）
        if (!force && _lastActiveLyric === activeLine) { wordMotion?.sync(); return; }

        if (_lastActiveLyric) {
            _lastActiveLyric.classList.remove('active');
            _lastActiveLyric.removeAttribute('aria-current');
        } else {
            document.querySelectorAll('.lyric-line').forEach(l => l.classList.remove('active'));
        }
        activeLine.classList.add('active');
        activeLine.setAttribute('aria-current', 'true');
        _lastActiveLyric = activeLine;

        wordMotion?.activate(activeLine, force);
        lyricViewport?.setActive(idx, force);
    }

    let initialized = false;
    return {
        get localLyricSession() { return localLyricSession; },
        get neteaseSearchEnabled() { return neteaseSearchEnabled; },
        set neteaseSearchEnabled(value) { setNeteaseSearchEnabled(value); },
        resetTrackLyrics,
        get lyricDisplayMode() { return lyricDisplayMode; },
        set lyricDisplayMode(value) { if (['original', 'both', 'roma'].includes(value)) lyricDisplayMode = value; },
        setLyricDisplayMode,
        get effectiveLyricDisplayMode() { return effectiveLyricMode(); },
        get originalLyricsArr() { return originalLyricsArr; },
        get translatedLyricsArr() { return translatedLyricsArr; },
        updateLyricToggleUI,
        setArtistTag,
        renderLyricsFromArrays,
        cancelLocalLyricSession,
        createLocalLyricSession,
        isLocalLyricSessionCurrent,
        applyLocalLyricMetadata,
        updateLocalLyrics,
        readLrcFile,
        fetchLyricById,
        prefetchLyricById: lyricRequests.prefetch,
        takePrefetchedLyric: lyricRequests.take,
        cancelLyricPrefetch: lyricRequests.cancelPrefetch,
        parseAndRenderLyrics,
        getNextLyricTime,
        getNextLyricUpdateTime,
        refreshLyricHighlightAndCenter,
        syncWordLyricPlayback() { wordMotion?.sync(true); },
        initialize() {
            if (initialized) return;
            initialized = true;
            lyricViewport = createLyricViewport(document.getElementById('lyrics-box'), {
                content: domService.el.lyricBox,
                returnButton: document.getElementById('lyric-return-current'),
                timeHint: document.getElementById('lyric-browse-time'),
                alignmentTarget: document.getElementById('cover-wrap'),
                isPlaying: () => playbackService.playbackState.isPlaying,
                seek: time => {
                    if (!(playbackService.hasAudio ?? playbackService.audioBuffer) || time > playbackService.playbackState.duration) return false;
                    try {
                        playbackService.seekAudio(time);
                        if (!playbackService.playbackState.isPlaying && playbackService.startAudio(playbackService.getCurrentTime()) === false) return false;
                        refreshLyricHighlightAndCenter(true);
                        return true;
                    } catch (error) {
                        debugService.log(`歌词跳转失败：${error.message || error}`, 'warn');
                        return false;
                    }
                }
            });
            wordMotion = createWordLyricMotion(document.getElementById('lyrics-box'), {
                getTime: () => playbackService.getCurrentTime(),
                isPlaying: () => !!playbackService.playbackState?.isPlaying,
                isClockRunning: () => playbackService.audioContextRunning !== false,
                getTransportVersion: () => playbackService.transportVersion || 0
            });
            if (_lastActiveLyric) wordMotion.activate(_lastActiveLyric);
            if(domService.lyricToggleBtn) {
                domService.lyricToggleBtn.onclick = () => {
                    const modes = availableLyricModes(), current = effectiveLyricMode();
                    if (modes.length < 2) return;
                    setLyricDisplayMode(modes[(modes.indexOf(current) + 1) % modes.length]);
                };
            }
            updateLyricToggleUI();
            setNeteaseSearchEnabled(neteaseSearchEnabled);
        }
    };
}
