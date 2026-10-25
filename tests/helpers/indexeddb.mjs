export function createMemoryIndexedDb() {
    const stores = new Map([['metadata', new Map()], ['player-state', new Map()]]);
    const stats = { reads: 0, writes: 0, deletes: 0 };
    const db = {
        objectStoreNames: { contains: name => stores.has(name) }, close() {},
        transaction(name) {
            const values = stores.get(name), tx = {};
            let pending = 0;
            const complete = () => queueMicrotask(() => { if (!pending) tx.oncomplete?.(); });
            const request = work => {
                const result = {}; pending++;
                queueMicrotask(() => {
                    try { result.result = work(); result.onsuccess?.(); }
                    catch (error) { result.error = error; result.onerror?.(); tx.onerror?.(); }
                    pending--; complete();
                });
                return result;
            };
            tx.objectStore = () => ({
                get(key) { stats.reads++; return request(() => structuredClone(values.get(key))); },
                put(value, key) { stats.writes++; const copy = structuredClone(value); return request(() => values.set(key, copy)); },
                delete(key) { stats.deletes++; return request(() => values.delete(key)); },
                openCursor() {
                    const result = {}, keys = [...values.keys()]; let index = 0; pending++;
                    const deliver = () => {
                        const key = keys[index++];
                        result.result = key === undefined ? null : {
                            key, value: structuredClone(values.get(key)),
                            delete() { stats.deletes++; values.delete(key); },
                            continue() { queueMicrotask(deliver); }
                        };
                        result.onsuccess?.();
                        if (key === undefined) { pending--; complete(); }
                    };
                    queueMicrotask(deliver); return result;
                }
            });
            complete(); return tx;
        }
    };
    return { stores, stats, open() {
        const request = {}; queueMicrotask(() => { request.result = db; request.onsuccess?.(); }); return request;
    } };
}
