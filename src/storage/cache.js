import { describeJsonCache, isJsonResponseCacheable, canRevalidateJson, jsonCacheEntryBytes,
    jsonCacheTtl, jsonCacheEvictions, JSON_CACHE_LIMITS } from './cache-policy.js';

const REQUEST_PRIORITY_ORDER = ['interactive', 'normal', 'idle'];

export function createRequestPriority(initial = 'normal') {
    let value = REQUEST_PRIORITY_ORDER.includes(initial) ? initial : 'normal';
    const listeners = new Set();
    return {
        get value() { return value; },
        promote(next) {
            if (!REQUEST_PRIORITY_ORDER.includes(next) || REQUEST_PRIORITY_ORDER.indexOf(next) >= REQUEST_PRIORITY_ORDER.indexOf(value)) return;
            value = next;
            listeners.forEach(listener => listener(value));
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
}

export function createCache({
    transfer: transferService
} = {}) {
    // --- 请求队列与缓存工具 ---
    // 当前交互优先于普通后台任务，预取最多占用一个并发槽。
    const requestQueues = { interactive: [], normal: [], idle: [] };

    let requestActive = 0;

    let requestIdleActive = 0;

    const REQUEST_CONCURRENCY = 3;

    const REQUEST_IDLE_CONCURRENCY = 1;

    function takeQueuedRequest() {
        for (const priority of REQUEST_PRIORITY_ORDER) {
            if (priority === 'idle' && requestIdleActive >= REQUEST_IDLE_CONCURRENCY) continue;
            const queue = requestQueues[priority];
            while (queue.length) {
                const task = queue.shift();
                if (!task || task.finished) continue;
                if (task.signal?.aborted) {
                    task.finished = true;
                    task.cleanup();
                    task.reject(transferService.createAbortError());
                    continue;
                }
                return task;
            }
        }
        return null;
    }

    function _processQueue() {
        while (requestActive < REQUEST_CONCURRENCY) {
            const task = takeQueuedRequest();
            if (!task) return;
            task.started = true;
            requestActive++;
            if (task.priority === 'idle') requestIdleActive++;
            Promise.resolve()
                .then(() => task.fn())
                .then(task.resolve, task.reject)
                .finally(() => {
                    task.finished = true;
                    task.cleanup();
                    requestActive--;
                    if (task.priority === 'idle') requestIdleActive--;
                    _processQueue();
                });
        }
    }

    function qFetch(url, options = {}) {
        const { priority: requestedPriority = 'normal', requestPriority = null, onRequestStart = null,
            readResponse = null, ...fetchOptions } = options;
        const priority = requestPriority?.value || (REQUEST_PRIORITY_ORDER.includes(requestedPriority) ? requestedPriority : 'normal');
        const signal = fetchOptions.signal;
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(transferService.createAbortError());
                return;
            }
            let unsubscribe = () => {};
            const task = {
                priority,
                signal,
                started: false,
                finished: false,
                fn: async () => {
                    onRequestStart?.();
                    const response = await transferService.awaitWithSignal(fetch(url, fetchOptions), signal);
                    return readResponse ? transferService.awaitWithSignal(readResponse(response), signal) : response;
                },
                resolve,
                reject,
                cleanup: () => { signal?.removeEventListener('abort', onAbort); unsubscribe(); }
            };
            const onAbort = () => {
                if (task.started || task.finished) return;
                task.finished = true;
                task.cleanup();
                reject(transferService.createAbortError());
                _processQueue();
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            unsubscribe = requestPriority?.subscribe(next => {
                if (task.started || task.finished || task.priority === next) return;
                const previous = requestQueues[task.priority];
                const index = previous.indexOf(task);
                if (index >= 0) previous.splice(index, 1);
                task.priority = next;
                requestQueues[next].push(task);
                _processQueue();
            }) || unsubscribe;
            requestQueues[priority].push(task);
            _processQueue();
        });
    }

    // IndexedDB v2: public metadata and structured player state are isolated.
    const IDB_DB = 'aurora-cache';

    const IDB_VERSION = 2;

    const IDB_STORE = 'metadata';

    const IDB_PLAYER_STORE = 'player-state';

    const LEGACY_SENSITIVE_CACHE_KEY = /(?:[?&]|%3[fF]|%26)(?:cookie|token|key|csrf|music_u)=/i;

    let idbOpenPromise = null;

    function openIdb() {
        if (idbOpenPromise) return idbOpenPromise;
        idbOpenPromise = new Promise((res, rej) => {
            const rq = indexedDB.open(IDB_DB, IDB_VERSION);
            rq.onupgradeneeded = () => {
                const db = rq.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
                if (!db.objectStoreNames.contains(IDB_PLAYER_STORE)) db.createObjectStore(IDB_PLAYER_STORE);
                const metadataStore = rq.transaction.objectStore(IDB_STORE);
                const cursorRequest = metadataStore.openCursor();
                cursorRequest.onsuccess = () => {
                    const cursor = cursorRequest.result;
                    if (!cursor) return;
                    if (typeof cursor.key === 'string' && LEGACY_SENSITIVE_CACHE_KEY.test(cursor.key)) cursor.delete();
                    cursor.continue();
                };
            };
            rq.onsuccess = () => {
                const db = rq.result;
                db.onversionchange = () => { db.close(); idbOpenPromise = null; };
                res(db);
            };
            rq.onerror = () => { idbOpenPromise = null; rej(rq.error); };
            rq.onblocked = () => { idbOpenPromise = null; rej(new Error('IndexedDB upgrade blocked')); };
        });
        return idbOpenPromise;
    }

    async function idbGet(key, storeName = IDB_STORE) {
        try {
            const db = await openIdb();
            return await new Promise((res, rej) => {
                const r = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error);
            });
        } catch (e) { return null; }
    }

    async function idbSet(key, value, storeName = IDB_STORE) {
        try {
            const db = await openIdb();
            return await new Promise((res, rej) => {
                const tx = db.transaction(storeName, 'readwrite');
                tx.oncomplete = () => res(true);
                tx.onabort = tx.onerror = () => rej(tx.error || new Error('IndexedDB write failed'));
                tx.objectStore(storeName).put(value, key);
            });
        } catch (e) { return false; }
    }

    async function idbDelete(key, storeName = IDB_STORE) {
        try {
            const db = await openIdb();
            return await new Promise((res, rej) => {
                const r = db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key);
                r.onsuccess = () => res(true);
                r.onerror = () => rej(r.error);
            });
        } catch (e) { return false; }
    }

    async function idbDeleteMatching(predicate, storeName = IDB_STORE) {
        try {
            const db = await openIdb();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, 'readwrite');
                const request = tx.objectStore(storeName).openCursor();
                let removed = 0;
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) return;
                    if (predicate(cursor.key, cursor.value)) {
                        cursor.delete();
                        removed++;
                    }
                    cursor.continue();
                };
                request.onerror = () => reject(request.error);
                tx.oncomplete = () => resolve(removed);
                tx.onerror = () => reject(tx.error);
            });
        } catch (_) { return 0; }
    }

    async function purgeSensitiveIdbCache() {
        try {
            const db = await openIdb();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                const request = tx.objectStore(IDB_STORE).openCursor();
                let removed = 0;
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) return;
                    if (typeof cursor.key === 'string' && LEGACY_SENSITIVE_CACHE_KEY.test(cursor.key)) {
                        cursor.delete();
                        removed++;
                    }
                    cursor.continue();
                };
                request.onerror = () => reject(request.error);
                tx.oncomplete = () => resolve(removed);
                tx.onerror = () => reject(tx.error);
            });
        } catch (_) { return 0; }
    }

    const publicJsonMemoryCache = new Map();

    const accountJsonCache = new Map();

    const jsonInFlight = new Map();

    const memoryBytes = new WeakMap();

    const revalidationFailures = new Map();

    const REVALIDATION_TIMEOUT_MS = 12_000;

    const REVALIDATION_COOLDOWN_MS = 300_000;

    let publicJsonWritesSincePrune = 0;

    let publicJsonBytesSincePrune = 0;

    let publicJsonPruneTimer = null;

    function deleteJsonMemoryEntry(cache, key) {
        const previous = cache.get(key);
        if (!previous) return;
        memoryBytes.set(cache, Math.max(0, (memoryBytes.get(cache) || 0) - previous.bytes));
        cache.delete(key);
    }

    function touchJsonMemoryEntry(cache, key, entry) {
        deleteJsonMemoryEntry(cache, key);
        const size = jsonCacheEntryBytes(entry);
        if (size > JSON_CACHE_LIMITS.memoryBytes) return;
        cache.set(key, entry);
        memoryBytes.set(cache, (memoryBytes.get(cache) || 0) + size);
        while (cache.size > JSON_CACHE_LIMITS.entries || memoryBytes.get(cache) > JSON_CACHE_LIMITS.memoryBytes) {
            deleteJsonMemoryEntry(cache, cache.keys().next().value);
        }
    }

    function clearAccountJsonCache() {
        accountJsonCache.clear();
        memoryBytes.set(accountJsonCache, 0);
        jsonInFlight.forEach((record, key) => {
            if (key.startsWith('json-account|')) record.controller.abort();
        });
    }

    async function prunePublicJsonCache() {
        try {
            const db = await openIdb();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                const store = tx.objectStore(IDB_STORE);
                const request = store.openCursor();
                const entries = [];
                const now = Date.now();
                let removed = 0;
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (cursor) {
                        if (typeof cursor.key === 'string' && cursor.key.startsWith('json|')) {
                            entries.push({ key: cursor.key, ts: Number(cursor.value?.ts || 0), bytes: cursor.value?.bytes });
                        }
                        cursor.continue();
                        return;
                    }
                    jsonCacheEvictions(entries, now).forEach(entry => {
                        store.delete(entry.key);
                        removed++;
                    });
                };
                request.onerror = () => reject(request.error);
                tx.oncomplete = () => resolve(removed);
                tx.onerror = () => reject(tx.error);
            });
        } catch (_) { return 0; }
    }

    function schedulePublicJsonCachePrune(bytes = 0) {
        publicJsonWritesSincePrune++;
        publicJsonBytesSincePrune += bytes;
        if (publicJsonWritesSincePrune < 20 && publicJsonBytesSincePrune < 4 * 1024 * 1024 || publicJsonPruneTimer) return;
        publicJsonPruneTimer = setTimeout(() => {
            publicJsonPruneTimer = null;
            publicJsonWritesSincePrune = 0;
            publicJsonBytesSincePrune = 0;
            prunePublicJsonCache().catch(() => {});
        }, 1000);
    }

    async function backfillJsonEntrySize(key, entry) {
        try {
            const db = await openIdb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                const store = tx.objectStore(IDB_STORE), request = store.get(key);
                let updated = false;
                request.onsuccess = () => {
                    const current = request.result;
                    if (current?.ts === entry.ts && (!Number.isSafeInteger(current.bytes) || current.bytes < 0)) {
                        store.put({ ...current, bytes: entry.bytes }, key);
                        updated = true;
                    }
                };
                tx.oncomplete = () => { if (updated) schedulePublicJsonCachePrune(entry.bytes); resolve(); };
                tx.onabort = tx.onerror = () => reject(tx.error);
            });
        } catch (_) {}
    }

    function subscribeJsonRequest(record, signal) {
        if (signal?.aborted) return Promise.reject(transferService.createAbortError());
        record.consumers++;
        return new Promise((resolve, reject) => {
            let finished = false;
            const finish = (handler, value) => {
                if (finished) return;
                finished = true;
                signal?.removeEventListener('abort', onAbort);
                record.consumers = Math.max(0, record.consumers - 1);
                handler(value);
                if (!record.settled && record.consumers === 0) {
                    if (jsonInFlight.get(record.key) === record) jsonInFlight.delete(record.key);
                    record.controller.abort();
                }
            };
            const onAbort = () => finish(reject, transferService.createAbortError());
            signal?.addEventListener('abort', onAbort, { once: true });
            record.promise.then(value => finish(resolve, value), error => finish(reject, error));
        });
    }

    function joinJsonRequest(record, signal, priority, requestPriority) {
        record.priority.promote(requestPriority?.value || priority);
        const unsubscribe = requestPriority?.subscribe(next => record.priority.promote(next));
        return subscribeJsonRequest(record, signal).finally(() => unsubscribe?.());
    }

    async function invalidateJsonCache(url, requestedScope = 'auto') {
        const cache = describeJsonCache(url, requestedScope);
        revalidationFailures.delete(cache.key);
        if (cache.scope === 'public') {
            deleteJsonMemoryEntry(publicJsonMemoryCache, cache.key);
            return idbDelete(cache.key);
        }
        if (cache.scope === 'account') deleteJsonMemoryEntry(accountJsonCache, cache.key);
        return true;
    }

    function retainRevalidation(record, signal) {
        if (record.backgroundSignals.has(signal)) return;
        record.backgroundSignals.add(signal);
        const lease = new AbortController();
        // Cancel queued work on navigation; a sent public request can finish and populate the cache.
        const cancel = () => { if (!record.started) lease.abort(); };
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        subscribeJsonRequest(record, lease.signal).catch(() => {}).finally(() => {
            signal?.removeEventListener('abort', cancel);
            record.backgroundSignals.delete(signal);
        });
    }

    // Public JSON persists in IDB; authenticated JSON is memory-only; none bypasses all caches.
    async function cachedFetchJson(url, options = {}, ttl = 3600_000) {
        const {
            useQueue = true,
            cacheScope = 'auto',
            priority = 'normal',
            requestPriority = null,
            forceRefresh = false,
            staleWhileRevalidate = false,
            cachePredicate = null,
            signal,
            ...fetchOptions
        } = options;
        if (signal?.aborted) throw transferService.createAbortError();
        const cache = describeJsonCache(url, cacheScope);
        const now = Date.now();
        const inFlightKey = cache.scope === 'none' ? `json-none|${url}` : cache.key;
        const preservePublic = forceRefresh
            && canRevalidateJson(url, cache.scope, { ...fetchOptions, staleWhileRevalidate });
        const pending = preservePublic ? jsonInFlight.get(inFlightKey) : null;
        if (pending && !pending.controller.signal.aborted) return joinJsonRequest(pending, signal, priority, requestPriority);
        let entry = null;
        if (forceRefresh && !preservePublic) await invalidateJsonCache(url, cacheScope);

        if (!forceRefresh && cache.scope === 'public') {
            entry = publicJsonMemoryCache.get(cache.key) || null;
            if (!entry) entry = await idbGet(cache.key);
        } else if (!forceRefresh && cache.scope === 'account') {
            entry = accountJsonCache.get(cache.key) || null;
        }
        if (signal?.aborted) throw transferService.createAbortError();
        const valid = entry?.ts > 0 && entry.ts <= now && isJsonResponseCacheable(entry.data, cachePredicate);
        const age = valid ? now - entry.ts : Infinity;
        const fresh = valid && age < jsonCacheTtl(ttl, entry.data);
        const stale = !fresh && !forceRefresh && valid && age <= JSON_CACHE_LIMITS.maxAge
            && canRevalidateJson(url, cache.scope, { ...fetchOptions, staleWhileRevalidate });
        if (fresh || stale) {
            const legacy = !Number.isSafeInteger(entry.bytes) || entry.bytes < 0;
            touchJsonMemoryEntry(cache.scope === 'public' ? publicJsonMemoryCache : accountJsonCache, cache.key, entry);
            if (legacy && cache.scope === 'public') void backfillJsonEntrySize(cache.key, entry);
            if (fresh) return entry.data;
            const retryAt = revalidationFailures.get(cache.key) || 0;
            if (retryAt > now || typeof navigator !== 'undefined' && navigator.onLine === false) return entry.data;
            revalidationFailures.delete(cache.key);
        }
        if (signal?.aborted) throw transferService.createAbortError();

        const existing = jsonInFlight.get(inFlightKey);
        if (existing && !existing.controller.signal.aborted) {
            if (stale) { retainRevalidation(existing, signal); return entry.data; }
            return joinJsonRequest(existing, signal, priority, requestPriority);
        }

        const controller = new AbortController();
        const record = { key: inFlightKey, controller, consumers: 0, settled: false, promise: null,
            started: false, backgroundSignals: new Set(),
            priority: stale ? createRequestPriority('idle') : requestPriority || createRequestPriority(priority) };
        const timer = stale ? setTimeout(() => controller.abort(), REVALIDATION_TIMEOUT_MS) : null;
        record.promise = Promise.resolve().then(async () => {
            if (controller.signal.aborted) throw transferService.createAbortError();
            const requestOptions = { ...fetchOptions, signal: controller.signal };
            const onRequestStart = () => { record.started = true; };
            const readResponse = async resp => {
                if (!resp.ok) {
                    const error = new Error(`HTTP ${resp.status}`);
                    error.status = resp.status;
                    throw error;
                }
                return resp.json();
            };
            const response = useQueue || stale
                ? qFetch(url, { ...requestOptions, requestPriority: record.priority, onRequestStart, readResponse })
                : (onRequestStart(), transferService.awaitWithSignal(fetch(url, requestOptions), controller.signal).then(readResponse));
            const data = await transferService.awaitWithSignal(response, controller.signal);
            if (controller.signal.aborted) throw transferService.createAbortError();
            if (!isJsonResponseCacheable(data, cachePredicate)) {
                if (stale) throw new Error('Invalid cache refresh response');
                return data;
            }
            revalidationFailures.delete(cache.key);
            const nextEntry = { ts: Date.now(), data };
            if (cache.scope === 'public') {
                touchJsonMemoryEntry(publicJsonMemoryCache, cache.key, nextEntry);
                if (nextEntry.bytes <= JSON_CACHE_LIMITS.diskBytes) {
                    await idbSet(cache.key, nextEntry);
                    schedulePublicJsonCachePrune(nextEntry.bytes);
                } else await idbDelete(cache.key);
            } else if (cache.scope === 'account') {
                touchJsonMemoryEntry(accountJsonCache, cache.key, nextEntry);
            }
            return data;
        }).catch(error => {
            if (stale && (error?.name !== 'AbortError' || record.started)) {
                revalidationFailures.delete(cache.key);
                revalidationFailures.set(cache.key, Date.now() + REVALIDATION_COOLDOWN_MS);
                while (revalidationFailures.size > JSON_CACHE_LIMITS.entries) {
                    revalidationFailures.delete(revalidationFailures.keys().next().value);
                }
            }
            throw error;
        }).finally(() => {
            clearTimeout(timer);
            record.settled = true;
            if (jsonInFlight.get(inFlightKey) === record) jsonInFlight.delete(inFlightKey);
        });
        jsonInFlight.set(inFlightKey, record);
        if (stale) { retainRevalidation(record, signal); return entry.data; }
        return subscribeJsonRequest(record, signal);
    }

    let initialized = false;
    return {
        get IDB_PLAYER_STORE() { return IDB_PLAYER_STORE; },
        openIdb,
        idbSet,
        purgeSensitiveIdbCache,
        clearAccountJsonCache,
        invalidateJsonCache,
        cachedFetchJson,
        initialize() {
            if (initialized) return;
            initialized = true;
            purgeSensitiveIdbCache().catch(() => {});

            prunePublicJsonCache().catch(() => {});
        }
    };
}
