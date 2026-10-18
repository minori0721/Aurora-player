import { cleanCookie, hashCacheScope, toHttps } from '../shared/text.js';
import { inferAudioTypeFromUrl } from '../audio/quality.js';

export function createResolver({
    api: apiService,
    auth: authService,
    cache: cacheService,
    transfer: transferService
} = {}) {
    function getAudioUrlCandidates(...sources) {
        const urls = [];
        const addUrl = (url) => {
            if (!url) return;
            const normalized = toHttps(String(url));
            if (normalized && !urls.includes(normalized)) urls.push(normalized);
        };
        sources.forEach(source => {
            if (!source) return;
            if (typeof source === 'string') {
                addUrl(source);
            } else {
                addUrl(source.url);
                addUrl(source.proxyUrl);
                addUrl(source.data);
            }
        });
        return urls;
    }

    function isNeteaseTrialOnly(info) {
        if (!info) return false;
        const trialInfo = info.freeTrialInfo;
        if (trialInfo != null && trialInfo !== '' && trialInfo !== 'null') return true;
        if (info.freeTrialPrivilege?.resConsumable === true) return true;
        const durationMs = Number(info.time || 0);
        return Number(info.fee) === 1 && Number(info.payed || 0) === 0 && durationMs > 0 && durationMs <= 35_000 && info.urlSource === 0;
    }

    const NETEASE_MATCH_SOURCE_ORDERS = {
        balanced: ['msls', 'qijieya', 'baka', 'bikonoo', 'gdmusic', 'unm', null],
        lossless: ['bikonoo', 'msls', 'qijieya', 'baka', 'gdmusic', 'unm', null]
    };

    const NETEASE_RESOLVED_AUDIO_CACHE_TTL = 10 * 60_000;

    const NETEASE_RESOLVED_AUDIO_CACHE_MAX_ENTRIES = 200;

    const neteaseResolvedAudioCache = new Map();

    function getNeteaseMatchStrategy(level = authService.neteaseQuality) {
        return (level === 'lossless' || level === 'hires') ? 'lossless' : 'balanced';
    }

    function getNeteaseMatchSources(strategy = 'balanced') {
        if (Array.isArray(strategy)) return strategy;
        return NETEASE_MATCH_SOURCE_ORDERS[strategy] || NETEASE_MATCH_SOURCE_ORDERS.balanced;
    }

    function clearNeteaseResolvedAudioCache() {
        neteaseResolvedAudioCache.clear();
    }

    function pruneNeteaseResolvedAudioCache(now = Date.now()) {
        for (const [key, entry] of neteaseResolvedAudioCache) {
            if (now - entry.ts >= NETEASE_RESOLVED_AUDIO_CACHE_TTL) neteaseResolvedAudioCache.delete(key);
        }
        while (neteaseResolvedAudioCache.size > NETEASE_RESOLVED_AUDIO_CACHE_MAX_ENTRIES) {
            neteaseResolvedAudioCache.delete(neteaseResolvedAudioCache.keys().next().value);
        }
    }

    async function invalidateNeteaseResolvedAudioCache(songId, level = authService.neteaseQuality, cookie = authService.neteaseCookie) {
        neteaseResolvedAudioCache.delete(getNeteaseResolvedAudioCacheKey(songId, level));
        const cookieParam = cookie ? `&cookie=${encodeURIComponent(cleanCookie(cookie))}` : '';
        const urls = [apiService.buildApiUrl(`/song/url/v1?id=${songId}&level=${level}&os=pc${cookieParam}`)];
        for (const source of getNeteaseMatchSources(getNeteaseMatchStrategy(level))) {
            const sourceParam = source ? `&source=${encodeURIComponent(source)}` : '';
            urls.push(apiService.buildApiUrl(`/song/url/match?id=${songId}${sourceParam}${cookieParam}`));
        }
        await Promise.all(urls.map(url => cacheService.invalidateJsonCache(url)));
    }

    function getNeteaseResolvedAudioCacheKey(songId, level = authService.neteaseQuality) {
        const authScope = authService.neteaseCookie ? hashCacheScope(cleanCookie(authService.neteaseCookie)) : 'anon';
        return `${songId}|${level}|${authScope}`;
    }

    function isLikelyTrialAudioUrl(url) {
        if (!url) return false;
        const raw = String(url).toLowerCase();
        let decoded = raw;
        try { decoded = decodeURIComponent(raw); } catch (_) {}
        return raw.includes('/jd-musicrep-ts/') ||
               raw.includes('/musicrep-ts/') ||
               decoded.includes('/jd-musicrep-ts/') ||
               decoded.includes('/musicrep-ts/');
    }

    async function fetchNeteaseMatchAudio(songId, cookieParam = '', options = {}, ttl = 30_000, strategy = getNeteaseMatchStrategy()) {
        let skippedTrial = false;
        let lastError = null;

        for (const source of getNeteaseMatchSources(strategy)) {
            const sourceParam = source ? `&source=${encodeURIComponent(source)}` : '';
            try {
                const matchJson = await cacheService.cachedFetchJson(apiService.buildApiUrl(`/song/url/match?id=${songId}${sourceParam}${cookieParam}`), options, ttl);
                const dataUrl = matchJson?.code === 200 ? toHttps(matchJson.data) : '';
                const proxyUrl = matchJson?.code === 200 ? toHttps(matchJson.proxyUrl) : '';
                const dataIsTrial = isLikelyTrialAudioUrl(dataUrl);
                const proxyIsTrial = isLikelyTrialAudioUrl(proxyUrl);
                if (dataIsTrial || proxyIsTrial) skippedTrial = true;

                if (dataUrl && !dataIsTrial) {
                    return {
                        audioUrl: dataUrl,
                        proxyUrl: proxyUrl && !proxyIsTrial ? proxyUrl : '',
                        source: source || 'auto',
                        skippedTrial
                    };
                }
                if (proxyUrl && !proxyIsTrial) {
                    return {
                        audioUrl: proxyUrl,
                        proxyUrl: '',
                        source: source || 'auto',
                        skippedTrial
                    };
                }
            } catch (e) {
                if (e.name === 'AbortError') throw e;
                lastError = e;
            }
        }

        return { audioUrl: '', proxyUrl: '', source: '', skippedTrial, error: lastError };
    }

    async function resolveNeteaseAudioUrl(songId, cookieParam = '', level = authService.neteaseQuality, options = {}, ttl = 30_000, strategy = getNeteaseMatchStrategy(level)) {
        const cacheKey = getNeteaseResolvedAudioCacheKey(songId, level);
        const now = Date.now();
        const cached = neteaseResolvedAudioCache.get(cacheKey);
        if (cached && (now - cached.ts) < NETEASE_RESOLVED_AUDIO_CACHE_TTL) {
            neteaseResolvedAudioCache.delete(cacheKey);
            neteaseResolvedAudioCache.set(cacheKey, cached);
            return {
                ...cached.value,
                audioInfo: cached.value.audioInfo ? { ...cached.value.audioInfo } : null,
                candidates: [...cached.value.candidates]
            };
        }
        if (cached) neteaseResolvedAudioCache.delete(cacheKey);

        const apiUrl = apiService.buildApiUrl(`/song/url/v1?id=${songId}&level=${level}&os=pc${cookieParam}`);
        const json = await cacheService.cachedFetchJson(apiUrl, options, ttl);
        if (!json || json.code !== 200) throw new Error('获取音频失败');

        let audioInfo = json?.data?.[0] || null;
        let audioUrl = audioInfo?.url ? toHttps(audioInfo.url) : '';
        let proxyUrl = audioInfo?.proxyUrl ? toHttps(audioInfo.proxyUrl) : '';
        const trialOnly = isNeteaseTrialOnly(audioInfo);
        const needsUnblock = !audioUrl || trialOnly;
        let usedMatch = false;
        let matchSource = '';
        let skippedTrial = false;

        if (needsUnblock) {
            audioUrl = '';
            proxyUrl = '';
            const matchResult = await fetchNeteaseMatchAudio(songId, cookieParam, options, ttl, strategy);
            skippedTrial = !!matchResult.skippedTrial;
            if (matchResult.audioUrl) {
                usedMatch = true;
                matchSource = matchResult.source || '';
                audioUrl = toHttps(matchResult.audioUrl);
                proxyUrl = toHttps(matchResult.proxyUrl || '');
                if (!audioInfo) audioInfo = {};
                audioInfo.url = audioUrl;
                audioInfo.proxyUrl = proxyUrl;
                audioInfo.type = inferAudioTypeFromUrl(audioUrl, audioInfo.type);
                audioInfo.br = null;
                audioInfo.sr = null;
                audioInfo.freeTrialInfo = null;
            }
        }

        const candidates = needsUnblock ? getAudioUrlCandidates(audioUrl, proxyUrl) : getAudioUrlCandidates(audioInfo);
        const result = {
            audioInfo,
            audioUrl,
            proxyUrl,
            candidates,
            trialOnly,
            needsUnblock,
            usedMatch,
            matchSource,
            skippedTrial
        };

        if (candidates.length) {
            neteaseResolvedAudioCache.set(cacheKey, {
                ts: Date.now(),
                value: {
                    ...result,
                    audioInfo: result.audioInfo ? { ...result.audioInfo } : null,
                    candidates: [...result.candidates]
                }
            });
            pruneNeteaseResolvedAudioCache();
        }

        return result;
    }

    function resolveNeteaseAudioUrlWithTimeout(songId, cookieParam, level, options, ttl, strategy) {
        return transferService.withRequestTimeout(options?.signal, transferService.NETEASE_URL_TIMEOUT_MS, '音频链接解析超时', signal =>
            resolveNeteaseAudioUrl(songId, cookieParam, level, { ...options, signal }, ttl, strategy));
    }

    let initialized = false;
    return {
        isNeteaseTrialOnly,
        getNeteaseMatchStrategy,
        clearNeteaseResolvedAudioCache,
        invalidateNeteaseResolvedAudioCache,
        fetchNeteaseMatchAudio,
        resolveNeteaseAudioUrlWithTimeout,
        initialize() {
            if (initialized) return;
            initialized = true;

        }
    };
}
