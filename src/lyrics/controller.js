import { escapeHtml } from '../shared/text.js';
import { createLyricTimeLookup, extractLyricsText, parseLyricsToArray, parseYrc } from './parser.js';
import { chooseNeteaseSongMatch, extractNeteaseMatchSongs, getNeteaseSongArtists } from './matching.js';

export function createLyrics({
    api: apiService,
    cache: cacheService,
    debug: debugService,
    dom: domService,
    metadata: metadataService,
    playback: playbackService
} = {}) {
    let neteaseLyricAbortController = null;

    let localLyricSession = null;

    let lyrics = [], isSyncedLyrics = true;

    let activeLyricIndex = -1, lyricCursorTime = -Infinity;

    let neteaseSearchEnabled = false;

    function resetTrackLyrics() {
        lyrics = [];
        activeLyricIndex = -1;
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
        updateLyricToggleUI(false);
    }

    let lyricDisplayMode = localStorage.getItem('lyric_mode') || 'original';

    // 'original' or 'both'
    let originalLyricsText = '';

    let translatedLyricsText = '';

    let romanLyricsText = '';

    let originalLyricsArr = [];

    let translatedLyricsArr = [];

    let romanLyricsArr = [];

    let lyricMetadataArr = [];

    let yrcData = null;

    function updateLyricToggleUI(enabled) {
        if(!domService.lyricToggleBtn) return;
        domService.lyricToggleBtn.disabled = !enabled;
        domService.lyricToggleBtn.style.opacity = enabled ? '' : '0.45';
        if(!enabled) {
            domService.lyricToggleBtn.title = '暂无更多歌词文本';
        } else {
            if (lyricDisplayMode === 'original') domService.lyricToggleBtn.title = '当前：仅原文 (点击切至：+翻译)';
            else if (lyricDisplayMode === 'both') domService.lyricToggleBtn.title = '当前：原文+翻译 (点击切至：+罗马音)';
            else domService.lyricToggleBtn.title = '当前：原文+罗马音 (点击切至：仅原文)';
        }
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
        lyricCursorTime = -Infinity;
        _lastActiveLyric = null;
        domService.el.lyricBox.style.transform = 'translateY(0)';
        domService.el.lyricBox.innerHTML = `<div style="height:120px"></div>`;

        if(hasSynced && times.length) {
            const frag = document.createDocumentFragment();
            const findOriginal = createLyricTimeLookup(originalLyricsArr);
            const findTranslation = createLyricTimeLookup(translatedLyricsArr);
            const findRoman = createLyricTimeLookup(romanLyricsArr);
            const findYrc = createLyricTimeLookup(yrcData);
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
                container.onclick = () => playbackService.startAudio(t);

                // === YRC 逐字渲染分支 ===
                const yrcLine = findYrc(t);
                if (yrcLine && yrcLine.words.length > 0) {
                    // 找到对应逐字数据：用 span 包裹每个字
                    const odiv = document.createElement('div');
                    odiv.className = 'yrc-line';
                    yrcLine.words.forEach(w => {
                        const sp = document.createElement('span');
                        sp.className = 'yrc-char';
                        sp.textContent = w.txt;
                        // 存储时序信息供激活时使用（相对行起始的毫秒）
                        sp.dataset.start = w.start - (yrcLine.t * 1000);
                        sp.dataset.dur = w.dur;
                        odiv.appendChild(sp);
                    });
                    container.appendChild(odiv);
                } else {
                    // 无逐字数据：回退普通文字
                    if(lyricDisplayMode === 'original') {
                        container.textContent = otext || ttext || rtext || '';
                    } else {
                        const odiv = document.createElement('div'); odiv.textContent = otext || '';
                        const subDiv = document.createElement('div');
                        subDiv.className = 'lyric-translation';
                        subDiv.textContent = lyricDisplayMode === 'both' ? (ttext || '') : (rtext || '');
                        container.appendChild(odiv); container.appendChild(subDiv);
                    }
                }

                // 附加行（YRC 行也追加翻译或罗马音）
                if (yrcLine && lyricDisplayMode !== 'original') {
                    const subContent = lyricDisplayMode === 'both' ? ttext : rtext;
                    if (subContent) {
                        const subDiv = document.createElement('div');
                        subDiv.className = 'lyric-translation';
                        subDiv.textContent = subContent;
                        container.appendChild(subDiv);
                    }
                }

                frag.appendChild(container);
            });
            const botPad = document.createElement('div'); botPad.style.height = '150px'; frag.appendChild(botPad);
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
            if(lyricDisplayMode === 'original') {
                if (origText || transText || romaText) {
                    domService.el.lyricBox.innerHTML = `<div style="padding:20px; text-align:center; white-space:pre-wrap; color:var(--text-main); font-size:1rem; line-height:1.8;">${escapeHtml(origText || transText || romaText)}</div>`;
                } else {
                    domService.el.lyricBox.innerHTML = metaOnlyHtml;
                }
            } else {
                const subText = lyricDisplayMode === 'both' ? transText : romaText;
                if (origText || subText) {
                    domService.el.lyricBox.innerHTML = `<div style="padding:20px; text-align:center; white-space:pre-wrap; color:var(--text-main); font-size:1rem; line-height:1.4;">${escapeHtml(origText)}</div><div style="padding:8px 20px;text-align:center;white-space:pre-wrap;color:var(--text-sub);font-size:0.95rem;line-height:1.6;">${escapeHtml(subText)}</div>`;
                } else {
                    domService.el.lyricBox.innerHTML = metaOnlyHtml;
                }
            }
        } else {
            domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">暂无歌词</div>';
        }

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

            debugService.log(`Searching lyrics: "${searchSong}" by "${searchArtist}"`);

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
                    debugService.log('No songs found on Netease', 'error');
                    if (!options.preserveLyrics) domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">未找到匹配歌曲</div>';
                    return false;
                }
                debugService.log(`综合搜索返回 ${songs.length} 个候选`, 'success');
                bestMatch = chooseNeteaseSongMatch(songs, { name: searchSong, artist: searchArtist, album, duration });
            }
            if (!bestMatch?.id) throw new Error('没有可用的歌曲匹配结果');
            debugService.log(`Selected: "${bestMatch.name}" by ${getNeteaseSongArtists(bestMatch)[0] || '?'}`);

            const songId = bestMatch.id;
            debugService.log(`Found song ID: ${songId} - ${bestMatch.name}`);

            // 获取歌词
            const lyricResp = await fetch(apiService.buildApiUrl(`/lyric/new?id=${songId}`), { signal: options.signal });
            if (!isCurrent()) return false;
            if (!lyricResp.ok) throw new Error('获取歌词失败');

            const lyricData = await lyricResp.json();
            if (!isCurrent()) return false;

            if (lyricData?.lrc?.lyric) {
                debugService.log('Netease lyrics loaded!', 'success');
                const trans = lyricData?.tlyric?.lyric || lyricData?.trans?.lyric || '';
                // 解析逐字歌词
                const _roma = lyricData?.romalrc?.lyric || '';
                const wordLyrics = parseYrc(lyricData?.yrc?.lyric || '');
                if (wordLyrics) debugService.log(`YRC word-sync loaded: ${wordLyrics.length} lines`, 'success');
                const commit = options.onLyrics || parseAndRenderLyrics;
                if (!commit(lyricData.lrc.lyric, '网易云', trans, _roma, wordLyrics)) throw new Error('没有可用歌词');
                return true;
            } else if (lyricData?.nolyric || lyricData?.uncollected) {
                debugService.log('Song has no lyrics (instrumental)', 'warn');
                if (!options.preserveLyrics) {
                    resetTrackLyrics();
                    domService.el.lyricBox.innerHTML = '<div class="lyric-line active" style="margin-top:100px">🎵 纯音乐，无歌词</div>';
                    setArtistTag('网易云', metadataService.currentAudioQuality);
                }
                return false;
            } else {
                throw new Error('No lyrics in response');
            }
        } catch (e) {
            if (!isCurrent() || e?.name === 'AbortError') return false;
            debugService.log('Netease search error: ' + e.message, 'error');
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
            // 使用缓存队列获取歌词（ttl 1 hour）
            const data = await cacheService.cachedFetchJson(apiService.buildApiUrl(`/lyric/new?id=${songId}`), { signal: lyricSignal, useQueue: true }, 3600_000);
            if (!isCurrent()) return false;
            if (data) {
                if (data?.lrc?.lyric) {
                    debugService.log('Lyrics loaded!', 'success');
                    const trans = data?.tlyric?.lyric || data?.trans?.lyric || '';
                    // 解析逐字歌词
                    const _roma = data?.romalrc?.lyric || '';
                    const wordLyrics = parseYrc(data?.yrc?.lyric || '');
                    if (wordLyrics) debugService.log(`YRC word-sync loaded: ${wordLyrics.length} lines`, 'success');
                    parseAndRenderLyrics(data.lrc.lyric, '网易云', trans, _roma, wordLyrics);
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
            debugService.log('Lyric fetch error: ' + e.message, 'error');
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
        const originalArr = parseLyricsToArray(original, metadata);
        const translatedArr = parseLyricsToArray(translated, metadata);
        const romanArr = parseLyricsToArray(roman, metadata);
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

        const hasTranslation = translatedLyricsArr.length > 0;
        const hasRoman = romanLyricsArr.length > 0;
        // 如果检测到翻译或罗马音可用，启用切换按钮
        updateLyricToggleUI(hasTranslation || hasRoman);

        renderLyricsFromArrays(source);
        debugService.log(`Lyrics parsed. Original: ${originalLyricsArr.length}, Trans: ${translatedLyricsArr.length}, Roma: ${romanLyricsArr.length}${lyricMetadataArr.length ? `, Meta: ${lyricMetadataArr.length}` : ''}`, 'success');
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

    function refreshLyricHighlightAndCenter(force = false) {
        if(!isSyncedLyrics || !lyrics || !lyrics.length) return;
        const now = playbackService.getCurrentTime();
        const idx = findActiveLyricIndex(now, force);
        const activeLine = domService.el.lyricBox.children[idx + 1];
        if(!activeLine) return;

        // 避免每帧重复读取 DOM 宽高属性和清空类名（导致 Layout Thrashing/重排风暴）
        if (!force && _lastActiveLyric === activeLine) return;

        if (_lastActiveLyric) {
            _lastActiveLyric.classList.remove('active');
        } else {
            document.querySelectorAll('.lyric-line').forEach(l => l.classList.remove('active'));
        }
        activeLine.classList.add('active');
        _lastActiveLyric = activeLine;

        // === 如果是 YRC 逐字行，触发每个字的 CSS 动画 ===
        const yrcLine = activeLine.querySelector('.yrc-line');
        if (yrcLine) {
            const lineStartMs = parseFloat(activeLine.dataset.time) * 1000;
            const elapsedMs = now * 1000 - lineStartMs; // 已经过了多少毫秒
            const yrcAnimations = [];
            yrcLine.querySelectorAll('.yrc-char').forEach(sp => {
                const wStart = parseFloat(sp.dataset.start);  // 字相对行起始的ms
                const wDur   = parseFloat(sp.dataset.dur);    // 字持续ms
                const delay  = (wStart - elapsedMs) / 1000;   // 剩余等待时间(秒)
                const dur    = Math.max(wDur, 80) / 1000;     // 最小80ms防止闪烁
                sp.style.animation = 'none';
                sp.style.animationDuration = '';
                sp.style.animationDelay = '';
                yrcAnimations.push({ sp, dur, delay });
            });
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    yrcAnimations.forEach(({ sp, dur, delay }) => {
                        sp.style.animation = '';
                        sp.style.animationDuration = `${dur}s`;
                        sp.style.animationDelay = `${delay}s`;
                    });
                });
            });
        }

        const parentHeight = domService.el.lyricBox.parentNode.offsetHeight || (window.innerHeight * 0.5);
        const offset = activeLine.offsetTop - parentHeight/2 + activeLine.offsetHeight/2;
        domService.el.lyricBox.style.transform = `translateY(${-offset}px)`;
    }

    let initialized = false;
    return {
        get localLyricSession() { return localLyricSession; },
        get neteaseSearchEnabled() { return neteaseSearchEnabled; },
        set neteaseSearchEnabled(value) { neteaseSearchEnabled = value; },
        resetTrackLyrics,
        get lyricDisplayMode() { return lyricDisplayMode; },
        set lyricDisplayMode(value) { lyricDisplayMode = value; },
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
        parseAndRenderLyrics,
        refreshLyricHighlightAndCenter,
        initialize() {
            if (initialized) return;
            initialized = true;
            if(domService.lyricToggleBtn) {
                domService.lyricToggleBtn.onclick = () => {
                    // 三段式循环：original -> both (translation) -> roma (romanization)
                    if (lyricDisplayMode === 'original') lyricDisplayMode = 'both';
                    else if (lyricDisplayMode === 'both') lyricDisplayMode = 'roma';
                    else lyricDisplayMode = 'original';

                    localStorage.setItem('lyric_mode', lyricDisplayMode);

                    // If lyrics are time-synced, perform incremental DOM update to avoid layout jitter
                    const lines = domService.el.lyricBox.querySelectorAll('.lyric-line');
                    const hasExtraData = originalLyricsArr.some(l=>l.t>=0) || translatedLyricsArr.some(l=>l.t>=0) || romanLyricsArr.some(l=>l.t>=0);
                    if (lines && lines.length && hasExtraData) {
                        // 清除旧的附加行
                        domService.el.lyricBox.querySelectorAll('.lyric-translation').forEach(n => n.remove());

                        if (lyricDisplayMode !== 'original') {
                            const targetArr = lyricDisplayMode === 'both' ? translatedLyricsArr : romanLyricsArr;
                            const findExtra = createLyricTimeLookup(targetArr);
                            lines.forEach(lineEl => {
                                const t = parseFloat(lineEl.dataset.time || -1);
                                if (isNaN(t) || t < 0) return;
                                const sub = findExtra(t);
                                if (sub && sub.txt) {
                                    const sdiv = document.createElement('div');
                                    sdiv.className = 'lyric-translation';
                                    sdiv.textContent = sub.txt;
                                    lineEl.appendChild(sdiv);
                                }
                            });
                        }
                        updateLyricToggleUI(true);
                        try { refreshLyricHighlightAndCenter(true); } catch(e) {}
                        return;
                    }

                    // Fallback: non-synced or no existing DOM lines — rebuild
                    renderLyricsFromArrays();
                    updateLyricToggleUI(true);
                };
                updateLyricToggleUI(false);
            }
        }
    };
}
