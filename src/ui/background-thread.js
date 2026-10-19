import { backgroundSize } from './background.js';

export function createThreadedBackground(canvas, { body = document.body, workerFactory = null, workerSource = '' } = {}) {
    let worker = null, url = null, timeout = 0, disposed = false, failed = false, revision = 0, readyRevision = -1;
    let theme = {}, state = { playing: false, hidden: true, reduced: false, width: 1, height: 1 };
    let stats = { ready: false, failed: false };
    const revoke = () => { if (url) URL.revokeObjectURL(url); url = null; };
    const show = ready => {
        if (canvas) canvas.hidden = !ready;
        body?.classList?.toggle('flow-background-ready', ready);
    };
    show(false);

    function fail() {
        failed = true; stats = { ...stats, ready: false, failed: true };
        clearTimeout(timeout); timeout = 0;
        worker?.terminate(); worker = null; revoke(); show(false);
    }

    function start() {
        if (!canvas || worker || disposed || failed) return;
        if (!canvas.transferControlToOffscreen || (!workerFactory && (typeof Worker !== 'function' || !workerSource))) { fail(); return; }
        try {
            const size = backgroundSize(state.width, state.height);
            canvas.width = size.width; canvas.height = size.height;
            if (workerFactory) worker = workerFactory();
            else {
                url = URL.createObjectURL(new Blob([workerSource], { type: 'application/javascript' }));
                worker = new Worker(url, { name: 'aurora-background' });
            }
            worker.onmessage = event => {
                const message = event.data || {};
                if (disposed || failed || message.type !== 'status') return;
                clearTimeout(timeout); timeout = 0; revoke();
                if (message.revision !== revision) return;
                stats = message.stats;
                readyRevision = message.revision;
                if (canvas.dataset) {
                    canvas.dataset.bufferWidth = String(stats.width);
                    canvas.dataset.bufferHeight = String(stats.height);
                }
                show(!!stats.ready && !stats.lost && !state.hidden);
                if (stats.failed) fail();
            };
            worker.onerror = event => { event.preventDefault?.(); fail(); };
            worker.onmessageerror = fail;
            timeout = setTimeout(fail, 15_000);
            const offscreen = canvas.transferControlToOffscreen();
            worker.postMessage({ type: 'init', canvas: offscreen, theme, revision, state }, [offscreen]);
        } catch (_) { fail(); }
    }

    return {
        setTheme(next) {
            if (disposed || failed || next === theme) return;
            theme = next; revision++;
            worker?.postMessage({ type: 'theme', theme, revision });
        },
        setState(next) {
            if (disposed || failed) return;
            const changed = Object.keys(state).some(key => state[key] !== next[key]);
            state = { ...next };
            if (state.hidden) show(false);
            if (!worker && state.playing && !state.hidden && !state.reduced) start();
            else if (worker && changed) {
                worker.postMessage({ type: 'state', state });
                if (!state.hidden && stats.ready && !stats.lost && readyRevision === revision) show(true);
            }
        },
        getStats: () => stats,
        dispose() {
            if (disposed) return;
            disposed = true; clearTimeout(timeout); timeout = 0;
            worker?.terminate(); worker = null; revoke(); show(false);
        }
    };
}
