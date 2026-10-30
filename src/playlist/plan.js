const HISTORY_LIMIT = 32;

// The base list keeps its source identity. Manual entries only affect playback order.
export class PlaybackPlan {
    constructor() { this.reset([]); }

    reset(base) {
        this.base = base;
        this.items = base.slice();
        this.index = -1;
        this.baseIndex = -1;
        this.manual = [];
        this.manualSet = new Set();
        this.pending = [];
        this.history = [];
        this.forward = [];
        this.revision = (this.revision || 0) + 1;
        this.indexes = new Map();
        this.items.forEach((track, index) => { if (!this.indexes.has(track)) this.indexes.set(track, index); });
    }

    get current() { return this.items[this.index] || null; }
    get isTemporary() { return this.manualSet.has(this.current); }
    get temporary() { return this.isTemporary ? [this.current, ...this.pending] : this.pending.slice(); }

    indexOf(track) { return this.indexes.get(track) ?? -1; }

    rebuild(selected = this.current, force = false) {
        const keep = new Set([...this.pending, ...this.history, ...this.forward, selected]);
        const retained = this.manual.filter(track => keep.has(track));
        if (!force && retained.length === this.manual.length && this.items.length === this.base.length + retained.length) {
            this.index = selected ? this.indexOf(selected) : -1;
            this.revision++;
            return;
        }
        this.manual = retained;
        this.manualSet = new Set(this.manual);
        this.items.length = 0;
        for (const track of this.base) this.items.push(track);
        for (const track of this.manual) this.items.push(track);
        this.indexes = new Map();
        this.items.forEach((track, index) => { if (!this.indexes.has(track)) this.indexes.set(track, index); });
        this.index = selected ? this.indexOf(selected) : -1;
        this.revision++;
    }

    setIndex(index) {
        this.index = index;
        if (index >= 0 && index < this.base.length) this.baseIndex = index;
        else if (index < 0 && !this.current) this.baseIndex = -1;
    }

    select(index, remember = true) {
        const target = this.items[index];
        if (!target) return -1;
        const previous = this.current;
        if (remember && previous && previous !== target) {
            this.history.push(previous);
            if (this.history.length > HISTORY_LIMIT) this.history.shift();
            if (this.forward.at(-1) === target) this.forward.pop();
            else this.forward = [];
        }
        this.pending = this.pending.filter(track => track !== target);
        if (index < this.base.length) this.baseIndex = index;
        this.rebuild(target);
        return this.index;
    }

    enqueue(tracks, next = false) {
        this.manual.push(...tracks);
        this.pending = next ? [...tracks, ...this.pending] : [...this.pending, ...tracks];
        this.forward = [];
        this.rebuild();
    }

    playNow(track) {
        this.manual.push(track);
        this.manualSet.add(track);
        this.items.push(track);
        this.indexes.set(track, this.items.length - 1);
        return this.select(this.items.length - 1);
    }

    nextIndex(mode = 0, lockedIndex = null, random = Math.random) {
        const next = this.forward.at(-1) || this.pending[0];
        if (next) return this.indexOf(next);
        if (!this.base.length) return null;
        if (mode === 1 && this.base.length > 1) {
            if (Number.isInteger(lockedIndex) && lockedIndex >= 0 && lockedIndex < this.base.length
                && lockedIndex !== this.baseIndex) return lockedIndex;
            let index = Math.floor(random() * this.base.length);
            if (index === this.baseIndex) index = (index + 1) % this.base.length;
            return index;
        }
        return (this.baseIndex + 1) % this.base.length;
    }

    previousIndex() {
        let target;
        while (this.history.length && !target) {
            const candidate = this.history.pop();
            if (this.indexOf(candidate) >= 0) target = candidate;
        }
        if (target) {
            if (this.current) this.forward.push(this.current);
            return this.select(this.indexOf(target), false);
        }
        if (!this.base.length) return null;
        const index = this.isTemporary ? Math.max(0, this.baseIndex)
            : (this.baseIndex - 1 + this.base.length) % this.base.length;
        return this.select(index, false);
    }

    reconcile(baseIndex = this.baseIndex) {
        const selected = this.current;
        const manual = this.isTemporary;
        this.baseIndex = Math.max(-1, Math.min(baseIndex, this.base.length - 1));
        this.rebuild(manual || this.base.includes(selected) ? selected : this.base[this.baseIndex], true);
        this.history = this.history.filter(track => this.indexOf(track) >= 0);
        this.forward = this.forward.filter(track => this.indexOf(track) >= 0);
    }

    clearPending() {
        this.pending = [];
        this.forward = [];
        this.rebuild();
    }

    detailEntries(mode, lockedIndex = null, loading = false) {
        if (mode === 2) return [];
        if (mode === 1) {
            const next = this.forward.at(-1) || this.pending[0] || this.items[lockedIndex];
            return next && next !== this.current ? [next] : [];
        }
        const result = [...this.forward].reverse().concat(this.pending).slice(0, 5);
        for (let offset = 1; result.length < 5 && offset <= this.base.length; offset++) {
            const index = this.baseIndex + offset;
            if (loading && index >= this.base.length) break;
            const track = this.base[index % this.base.length];
            if (track && track !== this.current) result.push(track);
        }
        return result;
    }

    restoreManual(state) {
        this.pending = state?.pending || [];
        this.manual = state?.current ? [state.current, ...this.pending] : this.pending.slice();
        const selected = state?.current || this.current;
        this.rebuild(selected, true);
    }
}
