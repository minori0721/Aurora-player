import { describeJsonCache, isJsonResponseCacheable } from './cache-policy.js';

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
        const { priority: requestedPriority = 'normal', requestPriority = null, ...fetchOptions } = options;
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
                fn: () => fetch(url, fetchOptions),
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

    const JSON_CACHE_MAX_ENTRIES = 200;

    const JSON_CACHE_MAX_AGE = 7 * 24 * 60 * 60_000;

    let publicJsonWritesSincePrune = 0;

    let publicJsonPruneTimer = null;

    function touchJsonMemoryEntry(cache, key, entry) {
        cache.delete(key);
        cache.set(key, entry);
        while (cache.size > JSON_CACHE_MAX_ENTRIES) {
            cache.delete(cache.keys().next().value);
        }
    }

    function clearAccountJsonCache() {
        accountJsonCache.clear();
        jsonInFlight.forEach((record, key) => {
            if (key.startsWith('json-account|')) record.controller.abort();
        });
    }

    async function prunePublicJsonCache(maxEntries = JSON_CACHE_MAX_ENTRIES, maxAge = JSON_CACHE_MAX_AGE) {
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
                            entries.push({ key: cursor.key, ts: Number(cursor.value?.ts || 0) });
                        }
                        cursor.continue();
                        return;
                    }
                    entries.sort((a, b) => b.ts - a.ts);
                    entries.forEach((entry, index) => {
                        if (!entry.ts || now - entry.ts > maxAge || index >= maxEntries) {
                            store.delete(entry.key);
                            publicJsonMemoryCache.delete(entry.key);
                            removed++;
                        }
                    });
                };
                request.onerror = () => reject(request.error);
                tx.oncomplete = () => resolve(removed);
                tx.onerror = () => reject(tx.error);
            });
        } catch (_) { return 0; }
    }

    function schedulePublicJsonCachePrune() {
        publicJsonWritesSincePrune++;
        if (publicJsonWritesSincePrune < 20 || publicJsonPruneTimer) return;
        publicJsonPruneTimer = setTimeout(() => {
            publicJsonPruneTimer = null;
            publicJsonWritesSincePrune = 0;
            prunePublicJsonCache().catch(() => {});
        }, 1000);
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

    async function invalidateJsonCache(url, requestedScope = 'auto') {
        const cache = describeJsonCache(url, requestedScope);
        if (cache.scope === 'public') {
            publicJsonMemoryCache.delete(cache.key);
            return idbDelete(cache.key);
        }
        if (cache.scope === 'account') accountJsonCache.delete(cache.key);
        return true;
    }

    // Public JSON persists in IDB; authenticated JSON is memory-only; none bypasses all caches.
    async function cachedFetchJson(url, options = {}, ttl = 3600_000) {
        const {
            useQueue = true,
            cacheScope = 'auto',
            priority = 'normal',
            requestPriority = null,
            forceRefresh = false,
            cachePredicate = null,
            signal,
            ...fetchOptions
        } = options;
        if (signal?.aborted) throw transferService.createAbortError();
        const cache = describeJsonCache(url, cacheScope);
        const now = Date.now();
        let entry = null;
        if (forceRefresh) await invalidateJsonCache(url, cacheScope);

        if (!forceRefresh && cache.scope === 'public') {
            entry = publicJsonMemoryCache.get(cache.key) || null;
            if (!entry) entry = await idbGet(cache.key);
        } else if (!forceRefresh && cache.scope === 'account') {
            entry = accountJsonCache.get(cache.key) || null;
        }
        if (signal?.aborted) throw transferService.createAbortError();
        if (entry?.ts && (now - entry.ts) < ttl && isJsonResponseCacheable(entry.data, cachePredicate)) {
            if (cache.scope === 'public') touchJsonMemoryEntry(publicJsonMemoryCache, cache.key, entry);
            else if (cache.scope === 'account') touchJsonMemoryEntry(accountJsonCache, cache.key, entry);
            return entry.data;
        }
        if (entry) await invalidateJsonCache(url, cacheScope);
        if (signal?.aborted) throw transferService.createAbortError();

        const inFlightKey = cache.scope === 'none' ? `json-none|${url}` : cache.key;
        const existing = jsonInFlight.get(inFlightKey);
        if (existing && !existing.controller.signal.aborted) {
            existing.priority.promote(requestPriority?.value || priority);
            const unsubscribe = requestPriority?.subscribe(next => existing.priority.promote(next));
            return subscribeJsonRequest(existing, signal).finally(() => unsubscribe?.());
        }

        const controller = new AbortController();
        const record = { key: inFlightKey, controller, consumers: 0, settled: false, promise: null,
            priority: requestPriority || createRequestPriority(priority) };
        record.promise = Promise.resolve().then(async () => {
            if (controller.signal.aborted) throw transferService.createAbortError();
            const requestOptions = { ...fetchOptions, signal: controller.signal };
            const resp = useQueue
                ? await qFetch(url, { ...requestOptions, requestPriority: record.priority })
                : await fetch(url, requestOptions);
            if (!resp.ok) {
                const error = new Error(`HTTP ${resp.status}`);
                error.status = resp.status;
                throw error;
            }
            const data = await resp.json();
            if (controller.signal.aborted) throw transferService.createAbortError();
            if (!isJsonResponseCacheable(data, cachePredicate)) return data;
            const nextEntry = { ts: Date.now(), data };
            if (cache.scope === 'public') {
                touchJsonMemoryEntry(publicJsonMemoryCache, cache.key, nextEntry);
                await idbSet(cache.key, nextEntry);
                schedulePublicJsonCachePrune();
            } else if (cache.scope === 'account') {
                touchJsonMemoryEntry(accountJsonCache, cache.key, nextEntry);
            }
            return data;
        }).finally(() => {
            record.settled = true;
            if (jsonInFlight.get(inFlightKey) === record) jsonInFlight.delete(inFlightKey);
        });
        jsonInFlight.set(inFlightKey, record);
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
