const EFFECT_NAMES = { none: '无特效', snow: '凛冬飞雪', bars: '律动频谱', waves: '极光波浪' };

export function createEffectsMenu(options) {
    const { select, env = window } = options;
    const doc = env.document;
    const menu = doc.getElementById('effect-menu'), trigger = doc.getElementById('effect-menu-trigger');
    const label = doc.getElementById('effect-current-label'), icon = doc.getElementById('effect-current-icon');
    const inputs = Object.keys(EFFECT_NAMES).map(mode => doc.getElementById(`effect-option-${mode}`)).filter(Boolean);
    const compact = env.matchMedia('(max-width: 900px)');
    const listeners = [];
    let initialized = false, navigating = false;

    function sync() {
        const mode = Object.prototype.hasOwnProperty.call(EFFECT_NAMES, select.value) ? select.value : 'none';
        label.textContent = EFFECT_NAMES[mode];
        trigger.setAttribute('aria-label', `视觉特效：${EFFECT_NAMES[mode]}`);
        for (const input of inputs) input.checked = input.value === mode;
        const copy = doc.getElementById(`effect-icon-${mode}`)?.cloneNode?.(true);
        if (copy) { copy.removeAttribute('id'); icon.replaceChildren(copy); }
    }

    function close(restoreFocus = false) {
        const wasOpen = menu.open;
        navigating = false;
        menu.open = false;
        trigger.setAttribute('aria-expanded', 'false');
        if (wasOpen && restoreFocus) trigger.focus({ preventScroll: true });
    }

    function listen(target, type, callback) {
        target.addEventListener(type, callback);
        listeners.push(() => target.removeEventListener?.(type, callback));
    }

    return {
        sync,
        initialize() {
            if (initialized || !select || !menu || !trigger || !label || !icon || inputs.length !== 4) return;
            initialized = true;
            for (const input of inputs) {
                const choose = () => {
                    if (!Object.prototype.hasOwnProperty.call(EFFECT_NAMES, input.value)) return;
                    const changed = select.value !== input.value;
                    select.value = input.value;
                    if (changed) select.dispatchEvent(new env.Event('change', { bubbles: true }));
                    else sync();
                };
                listen(input, 'change', choose);
                listen(input, 'click', event => {
                    choose();
                    // Native radio arrow navigation also emits a click before keyup.
                    if (!navigating || event.detail !== 0) close(true);
                });
                listen(input, 'pointerdown', () => { navigating = false; });
                listen(input, 'keyup', () => { navigating = false; });
                listen(input, 'keydown', event => {
                    navigating = event.key.startsWith('Arrow');
                    if (event.key !== 'Enter') return;
                    event.preventDefault(); choose(); close(true);
                });
            }
            listen(select, 'change', sync);
            listen(menu, 'toggle', () => trigger.setAttribute('aria-expanded', String(menu.open)));
            listen(menu, 'focusout', event => { if (!menu.contains(event.relatedTarget)) close(); });
            listen(doc, 'click', event => { if (!menu.contains(event.target)) close(); });
            listen(doc, 'keydown', event => {
                if (event.key !== 'Escape' || !menu.open || !menu.contains(event.target)) return;
                event.preventDefault(); event.stopPropagation(); close(true);
            });
            listen(doc, 'visibilitychange', () => { if (doc.hidden) close(); });
            listen(compact, 'change', () => { if (compact.matches) close(); });
            sync();
            select.hidden = true;
            menu.hidden = false;
        },
        dispose() {
            if (!initialized) return;
            close();
            listeners.splice(0).forEach(remove => remove());
            select.hidden = false;
            menu.hidden = true;
            initialized = false;
        }
    };
}
