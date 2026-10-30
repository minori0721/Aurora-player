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
    const matchFailures = new Map();
    const MATCH_FAILURE_COOLDOWN_MS = 30_000;
    let cacheGeneration = 0;

    function getNeteaseMatchStrategy(level = authService.neteaseQuality) {
        return (level === 'lossless' || level === 'hires') ? 'lossless' : 'balanced';
    }

    function getNeteaseMatchSources(strategy = 'balanced') {
        if (Array.isArray(strategy)) return strategy;
        return NETEASE_MATCH_SOURCE_ORDERS[strategy] || NETEASE_MATCH_SOURCE_ORDERS.balanced;
    }

    function clearNeteaseResolvedAudioCache() {
        cacheGeneration++;
        neteaseResolvedAudioCache.clear();
        matchFailures.clear();
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
        neteaseResolvedAudioCache.delete(getNeteaseResolvedAudioCacheKey(songId, level, cookie));
        const cookieParam = cookie ? `&cookie=${encodeURIComponent(cleanCookie(cookie))}` : '';
        const urls = [apiService.buildApiUrl(`/song/url/v1?id=${songId}&level=${level}&os=pc${cookieParam}`)];
        for (const source of getNeteaseMatchSources(getNeteaseMatchStrategy(level))) {
            const sourceParam = source ? `&source=${encodeURIComponent(source)}` : '';
            urls.push(apiService.buildApiUrl(`/song/url/match?id=${songId}${sourceParam}`));
        }
        await Promise.all(urls.map(url => cacheService.invalidateJsonCache(url)));
    }

    function getNeteaseResolvedAudioCacheKey(songId, level = authService.neteaseQuality, cookie = authService.neteaseCookie) {
        const authScope = cookie ? hashCacheScope(cleanCookie(cookie)) : 'anon';
        return `${songId}|${level}|${authService.authGeneration || 0}|${authScope}`;
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

    function describeMatchFailure(source, error) {
        const status = Number(error?.status) || 0;
        const apiCode = Number(error?.apiCode) || 0;
        const kind = status === 429 || apiCode === 429 ? 'rate-limit'
            : error?.timeout || error?.name === 'TimeoutError' ? 'timeout'
            : status ? 'http' : apiCode ? 'api' : error?.name === 'SyntaxError' ? 'response' : 'network';
        return { source: source || 'auto', kind, status, apiCode };
    }

    function matchError(failures, skippedTrial) {
        const descriptions = failures.slice(0, 3).map(failure => {
            const detail = failure.coolingDown ? `${failure.status ? `HTTP ${failure.status}，` : ''}${Math.ceil(failure.retryAfterMs / 1000)}秒后可重试`
                : failure.status ? `HTTP ${failure.status}` : failure.apiCode ? `接口错误 ${failure.apiCode}`
                : ({ timeout: '请求超时', network: '网络错误', response: '响应格式异常', empty: '没有完整链接', trial: '仅试听' }[failure.kind] || '暂不可用');
            return `${failure.source}: ${detail}`;
        });
        const unavailable = failures.some(failure => !['empty', 'trial'].includes(failure.kind));
        const message = unavailable ? '备用音源暂不可用' : skippedTrial ? '仅获取到试听片段，没有完整音频' : '没有找到可播放的完整音频';
        return Object.assign(new Error(`${message}${descriptions.length ? `（${descriptions.join('；')}${failures.length > 3 ? '；…' : ''}）` : ''}`), {
            code: 'AUDIO_URL_UNAVAILABLE', failures
        });
    }

    async function fetchNeteaseMatchAudio(songId, options = {}, ttl = 30_000, strategy = getNeteaseMatchStrategy(), level = authService.neteaseQuality) {
        let skippedTrial = false;
        const failures = [];
        const generation = cacheGeneration;
        const accountKey = getNeteaseResolvedAudioCacheKey(songId, level);
        const canCommit = () => generation === cacheGeneration && accountKey === getNeteaseResolvedAudioCacheKey(songId, level);
        const assertActive = () => {
            if (options.signal?.aborted) throw options.signal.reason || new DOMException('Cancelled', 'AbortError');
        };
        for (const [key, entry] of matchFailures) if (entry.until <= Date.now()) matchFailures.delete(key);

        for (const source of getNeteaseMatchSources(strategy)) {
            assertActive();
            const failureKey = `${accountKey}|${source || 'auto'}`;
            let previous = matchFailures.get(failureKey);
            if (previous?.until <= Date.now()) { matchFailures.delete(failureKey); previous = null; }
            if (previous && (options.priority === 'idle' || previous.failure.kind === 'rate-limit')) {
                failures.push({ ...previous.failure, coolingDown: true, retryAfterMs: Math.max(0, previous.until - Date.now()) });
                continue;
            }
            const sourceParam = source ? `&source=${encodeURIComponent(source)}` : '';
            try {
                // This endpoint does not consume account cookies; keep its short public cache shared.
                const matchJson = await cacheService.cachedFetchJson(apiService.buildApiUrl(`/song/url/match?id=${songId}${sourceParam}`), options, ttl);
                assertActive();
                if (Number(matchJson?.code) !== 200) {
                    const apiCode = Number(matchJson?.code);
                    throw Object.assign(new Error('匹配接口响应异常'), { apiCode: Number.isSafeInteger(apiCode) ? apiCode : 0, name: apiCode ? 'Error' : 'SyntaxError' });
                }
                const dataUrl = typeof matchJson.data === 'string' ? toHttps(matchJson.data) : '';
                const proxyUrl = typeof matchJson.proxyUrl === 'string' ? toHttps(matchJson.proxyUrl) : '';
                const dataIsTrial = isLikelyTrialAudioUrl(dataUrl);
                const proxyIsTrial = isLikelyTrialAudioUrl(proxyUrl);
                if (dataIsTrial || proxyIsTrial) skippedTrial = true;
                if (canCommit()) matchFailures.delete(failureKey);

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
                failures.push({ source: source || 'auto', kind: dataIsTrial || proxyIsTrial ? 'trial' : 'empty', status: 0, apiCode: 0 });
            } catch (e) {
                assertActive();
                if (e.name === 'AbortError') throw e;
                const failure = describeMatchFailure(source, e);
                failures.push(failure);
                if (canCommit() && (['rate-limit', 'timeout', 'network', 'response'].includes(failure.kind)
                    || failure.status >= 500 && failure.status < 600 || failure.apiCode >= 500 && failure.apiCode < 600)) {
                    const wait = failure.kind === 'rate-limit' && Number.isSafeInteger(e.retryAfterMs) && e.retryAfterMs >= 0 ? e.retryAfterMs : MATCH_FAILURE_COOLDOWN_MS;
                    matchFailures.delete(failureKey);
                    matchFailures.set(failureKey, { until: Date.now() + wait, failure });
                    while (matchFailures.size > NETEASE_RESOLVED_AUDIO_CACHE_MAX_ENTRIES) matchFailures.delete(matchFailures.keys().next().value);
                }
            }
        }

        return { audioUrl: '', proxyUrl: '', source: '', skippedTrial, error: matchError(failures, skippedTrial) };
    }

    async function resolveNeteaseAudioUrl(songId, cookieParam = '', level = authService.neteaseQuality, options = {}, ttl = 30_000, strategy = getNeteaseMatchStrategy(level)) {
        const cacheKey = getNeteaseResolvedAudioCacheKey(songId, level);
        const generation = cacheGeneration;
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

        let audioInfo = json?.data?.[0] ? { ...json.data[0] } : null;
        let audioUrl = audioInfo?.url ? toHttps(audioInfo.url) : '';
        let proxyUrl = audioInfo?.proxyUrl ? toHttps(audioInfo.proxyUrl) : '';
        const trialOnly = isNeteaseTrialOnly(audioInfo);
        const needsUnblock = !audioUrl || trialOnly;
        let usedMatch = false;
        let matchSource = '';
        let skippedTrial = false;
        let resolutionError = null;

        if (needsUnblock) {
            audioUrl = '';
            proxyUrl = '';
            const matchResult = await fetchNeteaseMatchAudio(songId, options, ttl, strategy, level);
            skippedTrial = !!matchResult.skippedTrial;
            resolutionError = matchResult.error || null;
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
            skippedTrial,
            error: resolutionError
        };

        if (candidates.length && generation === cacheGeneration && cacheKey === getNeteaseResolvedAudioCacheKey(songId, level) && !options.signal?.aborted) {
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
