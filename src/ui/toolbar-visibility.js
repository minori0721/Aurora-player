export function createToolbarVisibility(options) {
    const { toolbar, env = window, readStatus, isBlocked = () => false } = options;
    const doc = env.document;
    const compact = env.matchMedia('(max-width: 700px), (hover: none)');
    let timer = null, deadline = 0, keyboard = false, hovering = false, nativeSelect = false;
    let ownsInert = false, previousInert = false;
    const now = () => env.performance.now();
    const show = () => {
        toolbar.classList.remove('toolbar-hidden');
        if (ownsInert) { toolbar.inert = previousInert; ownsInert = false; }
    };
    const cancel = () => { if (timer !== null) env.clearTimeout(timer); timer = null; };
    const eligible = () => !compact.matches && !doc.hidden && readStatus() === 'playing';
    function locked() {
        const focus = toolbar.contains(doc.activeElement);
        return nativeSelect || isBlocked() || (doc.hasFocus?.() !== false
            && (hovering || focus && (keyboard || /^(INPUT|SELECT|TEXTAREA)$/.test(doc.activeElement?.tagName || ''))));
    }
    function check() {
        timer = null;
        if (!eligible()) { show(); return; }
        if (deadline > now()) { timer = env.setTimeout(check, deadline - now()); return; }
        if (locked()) return;
        if (!ownsInert) { previousInert = !!toolbar.inert; ownsInert = true; }
        toolbar.inert = true;
        toolbar.classList.add('toolbar-hidden');
    }
    function activity() {
        show();
        deadline = now() + 4000;
        if (!eligible()) cancel();
        else if (timer === null) timer = env.setTimeout(check, 4000);
    }
    const key = event => { if (event.key === 'Escape') nativeSelect = false; keyboard = true; activity(); };
    const pointer = event => { if (event.target?.tagName !== 'SELECT') nativeSelect = false; keyboard = false; activity(); };
    const enter = () => { hovering = true; activity(); };
    const leave = () => { hovering = false; activity(); };
    const select = event => { if (event.target?.tagName === 'SELECT') nativeSelect = true; activity(); };
    const finishSelect = () => { nativeSelect = false; activity(); };
    const visibility = () => { cancel(); activity(); };
    const listeners = [
        [doc, 'pointermove', activity], [doc, 'pointerdown', pointer], [doc, 'keydown', key],
        [doc, 'focusin', activity], [doc, 'focusout', activity], [doc, 'visibilitychange', visibility],
        [env, 'focus', activity], [env, 'blur', activity], [doc, 'dragover', activity],
        [toolbar, 'pointerenter', enter], [toolbar, 'pointerleave', leave],
        [toolbar, 'pointerdown', select], [toolbar, 'change', finishSelect], [toolbar, 'focusout', finishSelect]
    ];
    for (const [target, event, handler] of listeners) target.addEventListener(event, handler, { capture: event === 'keydown', passive: event.startsWith('pointer') });
    compact.addEventListener('change', activity);
    activity();
    return { sync: activity, dispose() {
        cancel(); show();
        for (const [target, event, handler] of listeners) target.removeEventListener(event, handler, { capture: event === 'keydown' });
        compact.removeEventListener?.('change', activity);
    } };
}
