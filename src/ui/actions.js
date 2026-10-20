export function bindActions({ analysis, auth, loop, onlinePlaylist, debug }, root = document) {
    const actions = {
        login: () => auth.showLogin(),
        logout: () => auth.neteaseLogout(),
        'refresh-qr': () => auth.refreshQRCode(),
        capture: button => analysis.capturePoint(button.dataset.point),
        preview: button => analysis.previewPoint(button.dataset.point),
        analyze: () => analysis.runAnalysis(),
        'export-sli': () => analysis.exportSLI(),
        'set-loop': button => loop.setLoopPoint(button.dataset.point),
        'import-playlist': () => onlinePlaylist.importPlaylistToQueue(),
        'load-playlist': button => {
            const id = Number(button.dataset.id);
            if (Number.isSafeInteger(id) && id > 0) return onlinePlaylist.loadPlaylistById(id);
        }
    };
    const activate = event => {
        const button = event.target.closest?.('[data-action]');
        if (!button || button.disabled || !Object.hasOwn(actions, button.dataset.action)) return;
        event.preventDefault();
        try {
            Promise.resolve(actions[button.dataset.action](button)).catch(error => debug.log(error.message, 'error'));
        } catch (error) {
            debug.log(error.message, 'error');
        }
    };
    root.addEventListener('click', activate);
    return () => root.removeEventListener('click', activate);
}
