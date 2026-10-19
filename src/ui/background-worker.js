import { createFlowBackground, createFlowPainter } from './background.js';

let background = null, revision = 0, announced = '';
// Worker RAF is optional; the controller already limits the target draw frequency.
if (typeof self.requestAnimationFrame !== 'function') {
    self.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0);
    self.cancelAnimationFrame = clearTimeout;
}

function announce(force = false) {
    if (!background) return;
    const stats = background.getStats();
    const key = [revision, stats.ready, stats.failed, stats.lost, stats.width, stats.height].join('|');
    if (force || key !== announced) {
        announced = key;
        self.postMessage({ type: 'status', revision, stats });
    }
}

self.onmessage = event => {
    const message = event.data || {};
    if (message.type === 'init' && !background) {
        const canvas = message.canvas;
        revision = message.revision;
        background = createFlowBackground(canvas, { body: null, makePainter: target => {
            const painter = createFlowPainter(target);
            if (!painter) return null;
            return {
                setTheme: (...args) => painter.setTheme(...args),
                finishTransition: () => painter.finishTransition(),
                draw(...args) { painter.draw(...args); announce(); },
                dispose: () => painter.dispose()
            };
        } });
        canvas.addEventListener('webglcontextlost', () => announce(true));
        canvas.addEventListener('webglcontextrestored', () => announce(true));
        background.setTheme(message.theme);
        background.setState(message.state);
        announce(true);
    } else if (message.type === 'theme' && background) {
        revision = message.revision;
        background.setTheme(message.theme);
        announce();
    } else if (message.type === 'state' && background) {
        background.setState(message.state);
        announce();
    } else if (message.type === 'inspect' && background) {
        self.postMessage({ type: 'inspection', requestId: message.requestId, stats: background.getStats() });
    } else if (message.type === 'dispose') {
        background?.dispose(); background = null;
        self.postMessage({ type: 'disposed' }); self.close();
    }
};
