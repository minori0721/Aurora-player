export class FakeElement {
    constructor(id = '') {
        this.id = id;
        this.style = { setProperty(name, value) { this[name] = value; } };
        this.dataset = {};
        this.attributes = new Map();
        this.listeners = new Map();
        this.children = [];
        this.value = '';
        this.textContent = '';
        this.innerHTML = '';
        this.isConnected = true;
        this.offsetWidth = 400;
        this.offsetHeight = 300;
        this.parentNode = { offsetHeight: 600 };
        const names = new Set();
        this.classList = {
            add: (...items) => items.forEach(item => names.add(item)),
            remove: (...items) => items.forEach(item => names.delete(item)),
            contains: item => names.has(item),
            toggle: (item, force = !names.has(item)) => { force ? names.add(item) : names.delete(item); return force; }
        };
    }
    setAttribute(key, value) { this.attributes.set(key, value); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    dispatchEvent(event) {
        for (const callback of this.listeners.get(event.type) || []) callback.call(this, event);
        return this[`on${event.type}`]?.call(this, event);
    }
    appendChild(child) {
        if (child.fragment) { this.children.push(...child.children); child.children = []; }
        else this.children.push(child);
        return child;
    }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    removeChild(child) { this.children = this.children.filter(item => item !== child); }
    remove() { this.isConnected = false; }
    replaceChildren(...children) { this.children = children; }
    get innerHTML() { return this._html || ''; }
    set innerHTML(value) { this._html = value; this.children = []; }
    querySelectorAll(selector) {
        const found = [];
        const visit = node => {
            for (const child of node.children) {
                if (selector.startsWith('.') && String(child.className || '').split(/\s+/).includes(selector.slice(1))) found.push(child);
                visit(child);
            }
        };
        visit(this);
        return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return selector === '[data-action]' && this.dataset.action ? this : null; }
    getClientRects() { return [{}]; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 400 }; }
    focus() {}
    contains(node) { return node === this || this.children.includes(node); }
    scrollIntoView() {}
    setPointerCapture() {}
    releasePointerCapture() {}
    click() { return this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} }); }
    getContext() {
        return { clearRect() {}, fillRect() {}, drawImage() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {}, createLinearGradient() { return { addColorStop() {} }; } };
    }
}

export class FakeAudioContext {
    static instances = [];
    constructor() {
        FakeAudioContext.instances.push(this);
        this.state = 'running';
        this.currentTime = 0;
        this.sampleRate = 44100;
        this.destination = {};
        this.sources = [];
        this.decodeCalls = [];
        this.decoded = { duration: 120, numberOfChannels: 2, sampleRate: 44100 };
    }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    createAnalyser() { return { connect() {}, fftSize: 512, frequencyBinCount: 256, getByteFrequencyData() {} }; }
    createBuffer() { return { duration: 0, getChannelData: () => new Float32Array(1) }; }
    createBufferSource() {
        const node = { connect() {}, disconnect() {}, start(...args) { this.started = args; }, stop() { this.stopped = true; } };
        this.sources.push(node);
        return node;
    }
    decodeAudioData(data) {
        this.decodeCalls.push(data);
        return this.decodeHook ? this.decodeHook(data) : Promise.resolve(this.decoded);
    }
    resume() { return this.resumeHook ? this.resumeHook() : Promise.resolve(); }
}

export function storage() {
    const entries = new Map();
    return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)), removeItem: key => entries.delete(key) };
}

export function createHost(html = '') {
    const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new FakeElement(match[1])]));
    const body = new FakeElement('body'), doc = new FakeElement('document');
    doc.body = body;
    doc.documentElement = new FakeElement('html');
    doc.hidden = false;
    doc.getElementById = id => elements.get(id) || null;
    doc.createElement = tag => { const element = new FakeElement(); element.tagName = tag.toUpperCase(); return element; };
    doc.createDocumentFragment = () => Object.assign(new FakeElement(), { fragment: true });
    doc.querySelector = () => null;
    doc.querySelectorAll = () => [];
    for (const element of elements.values()) element.value = element.id === 'effect-select' ? 'none' : element.id === 'base-rate' ? '44100' : '';
    const frames = new Map(), timers = new Map(), logs = [], requests = [];
    let sequence = 0;
    const host = {
        document: doc, navigator: {}, localStorage: storage(), sessionStorage: storage(),
        location: { href: 'http://localhost/', hash: '', origin: 'http://localhost' },
        history: { state: null, replaceState(value) { this.state = value; }, pushState(value) { this.state = value; }, back() {}, forward() {} },
        innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
        AudioContext: FakeAudioContext, HTMLElement: FakeElement, Element: FakeElement,
        Image: FakeElement, Blob, URL, URLSearchParams, AbortController, DOMException, TextDecoder,
        Uint8Array, Uint32Array, Float32Array, ArrayBuffer, DataView, Response, ReadableStream,
        performance, console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        requestAnimationFrame: callback => { const id = ++sequence; frames.set(id, callback); return id; },
        cancelAnimationFrame: id => frames.delete(id),
        setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
        clearTimeout: id => timers.delete(id), setInterval: () => ++sequence, clearInterval() {},
        addEventListener: (...args) => doc.addEventListener(...args), removeEventListener: (...args) => doc.removeEventListener(...args),
        IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
        ResizeObserver: class { observe() {} disconnect() {} },
        fetch: async (...args) => { requests.push(args); throw new Error('Unexpected network request in mock-host test'); },
        alert() {}, confirm: () => false,
        crypto: { randomUUID: () => 'mock-uuid' }
    };
    host.window = host;
    host.self = host;
    return { host, elements, frames, timers, logs, requests };
}
