import { redactDiagnosticText } from '../shared/text.js';

export function createDebug({} = {}) {
    const debugConsole = document.getElementById('debug-console');

    const DEBUG_LOG_LIMIT = 1000;

    let debugScrollFrame = null;

    function scheduleDebugScroll() {
        if (debugConsole.style.display !== 'block' || debugScrollFrame !== null) return;
        debugScrollFrame = requestAnimationFrame(() => {
            debugScrollFrame = null;
            if (debugConsole.style.display === 'block') debugConsole.scrollTop = debugConsole.scrollHeight;
        });
    }

    function log(msg, type='') {
        msg = redactDiagnosticText(msg);
        console.log(msg);
        const div = document.createElement('div');
        div.className = `log-item ${type==='error'?'log-err':(type==='success'?'log-suc':'')}`;
        div.textContent = `> ${msg}`;
        debugConsole.appendChild(div);
        while (debugConsole.children.length > DEBUG_LOG_LIMIT) debugConsole.firstElementChild.remove();
        scheduleDebugScroll();
    }

    return {
        scheduleDebugScroll,
        log
    };
}
