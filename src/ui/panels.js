export function createPanels({
    dom: domService,
    playlistView: playlistViewService
} = {}) {
    const floatingPanels = new Map([
        ['playlist-sidebar', 'toggle-list', 400], ['loop-panel', 'toggle-loop-panel', 300],
        ['analyze-panel', 'toggle-analyze', 300], ['vol-popup', 'vol-btn', 300],
        ['advanced-menu', 'toggle-advanced', 200]
    ].map(([id, triggerId, duration]) => {
        const panel = document.getElementById(id);
        panel.hidden = true;
        panel.inert = true;
        panel.setAttribute('aria-hidden', 'true');
        document.getElementById(triggerId)?.setAttribute('aria-expanded', 'false');
        return [id, { panel, triggerId, duration, open: false, timer: 0, frame: 0, finish: null }];
    }));

    function setFloatingPanel(id, open) {
        const state = floatingPanels.get(id);
        if (!state) return false;
        const { panel, triggerId, duration } = state;
        open = Boolean(open);
        clearTimeout(state.timer);
        cancelAnimationFrame(state.frame);
        state.timer = state.frame = 0;
        if (state.finish) panel.removeEventListener('transitionend', state.finish);
        state.finish = null;
        state.open = open;
        const setInteractive = node => {
            const saved = modalController.inertState.find(entry => entry[0] === node);
            if (saved) saved[1] = !open;
            node.inert = saved ? true : !open;
        };
        setInteractive(panel);
        panel.setAttribute('aria-hidden', String(!open));
        document.getElementById(triggerId)?.setAttribute('aria-expanded', String(open));
        const fab = id === 'playlist-sidebar' ? document.getElementById('playlist-fab-group') : null;
        if (fab) setInteractive(fab);
        if (open) {
            const wasHidden = panel.hidden;
            panel.hidden = false;
            if (fab) fab.hidden = false;
            if (wasHidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                // Establish the closed pose before starting the entry transition.
                void panel.offsetWidth;
                state.frame = requestAnimationFrame(() => {
                    state.frame = 0;
                    if (state.open) {
                        panel.classList.add('show');
                        if (id === 'playlist-sidebar') playlistViewService.observePlaylistCovers();
                    }
                });
            } else panel.classList.add('show');
            if (id === 'playlist-sidebar' && panel.classList.contains('show')) playlistViewService.observePlaylistCovers();
        } else {
            if (panel.contains(document.activeElement) || fab?.contains(document.activeElement)) {
                const trigger = document.getElementById(triggerId);
                if (trigger?.getClientRects().length) trigger.focus({ preventScroll: true });
                else document.getElementById('toggle-advanced')?.focus({ preventScroll: true });
            }
            panel.classList.remove('show');
            if (id === 'playlist-sidebar') playlistViewService.pausePlaylistCovers();
            const finish = event => {
                if (event && (event.target !== panel || event.propertyName !== 'transform')) return;
                if (state.open) return;
                clearTimeout(state.timer);
                state.timer = 0;
                panel.hidden = true;
                if (fab) fab.hidden = true;
                panel.removeEventListener('transitionend', finish);
                state.finish = null;
            };
            if (panel.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
            else {
                state.finish = finish;
                panel.addEventListener('transitionend', finish);
                // Detached elements and background tabs may not deliver transitionend.
                state.timer = setTimeout(finish, duration + 80);
            }
        }
        return open;
    }

    function toggleFloatingPanel(id) {
        return setFloatingPanel(id, !floatingPanels.get(id)?.open);
    }

    const modalController = {
        active: null,
        previousFocus: null,
        closeHandler: null,
        inertState: [],
        open(overlay, closeHandler) {
            if (this.active === overlay) return;
            if (this.active && this.closeHandler) this.closeHandler();
            this.active = overlay;
            this.closeHandler = closeHandler;
            this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            this.inertState = [];
            Array.from(document.body.children).forEach(node => {
                if (!(node instanceof HTMLElement) || node === overlay || node.tagName === 'SCRIPT') return;
                this.inertState.push([node, node.inert]);
                node.inert = true;
            });
            overlay.style.display = overlay === domService.downloadModal ? 'flex' : '';
            overlay.classList.add('show');
            overlay.setAttribute('aria-hidden', 'false');
            requestAnimationFrame(() => {
                const focusable = this.getFocusable(overlay);
                (focusable[0] || overlay.querySelector('[role="dialog"]') || overlay).focus({ preventScroll: true });
            });
        },
        close(overlay, restoreFocus = true) {
            if (this.active !== overlay) {
                overlay.classList.remove('show');
                overlay.setAttribute('aria-hidden', 'true');
                if (overlay === domService.downloadModal) overlay.style.display = 'none';
                return;
            }
            overlay.classList.remove('show');
            overlay.setAttribute('aria-hidden', 'true');
            if (overlay === domService.downloadModal) overlay.style.display = 'none';
            this.inertState.forEach(([node, previous]) => { node.inert = previous; });
            this.inertState = [];
            const focusTarget = this.previousFocus;
            this.active = null;
            this.closeHandler = null;
            this.previousFocus = null;
            if (restoreFocus && focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
        },
        getFocusable(overlay) {
            return Array.from(overlay.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'))
                .filter(node => node instanceof HTMLElement && !node.hidden && node.getClientRects().length > 0);
        }
    };

    let initialized = false;
    return {
        get floatingPanels() { return floatingPanels; },
        setFloatingPanel,
        toggleFloatingPanel,
        get modalController() { return modalController; },
        initialize() {
            if (initialized) return;
            initialized = true;
            document.getElementById('playlist-fab-group').hidden = true;

            document.addEventListener('keydown', event => {
                const overlay = modalController.active;
                if (!overlay) return;
                if (event.key === 'Escape') {
                    event.preventDefault();
                    modalController.closeHandler?.();
                    return;
                }
                if (event.key !== 'Tab') return;
                const focusable = modalController.getFocusable(overlay);
                if (!focusable.length) {
                    event.preventDefault();
                    (overlay.querySelector('[role="dialog"]') || overlay).focus();
                    return;
                }
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }, true);
        }
    };
}
