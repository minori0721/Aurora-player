export function createToolbarVisibility(options) {
    const { toolbar, capsule = null, env = window, readStatus, isBlocked = () => false } = options;
    const doc = env.document;
    const compact = env.matchMedia('(max-width: 700px), (hover: none)');
    let timer = null, deadline = 0, keyboard = false, hovering = false, capsuleHovering = false, nativeSelect = false;
    let ownsInert = false, previousInert = false;
    const now = () => env.performance.now();
    const show = () => {
        toolbar.classList.remove('toolbar-hidden');
        capsule?.classList.remove('song-actions-idle');
        if (ownsInert) { toolbar.inert = previousInert; ownsInert = false; }
    };
    const cancel = () => { if (timer !== null) env.clearTimeout(timer); timer = null; };
    const eligible = () => !compact.matches && !doc.hidden && readStatus() === 'playing';
    function locked(blocked) {
        const focus = toolbar.contains(doc.activeElement);
        return nativeSelect || blocked || (doc.hasFocus?.() !== false
            && (hovering || focus && (keyboard || /^(INPUT|SELECT|TEXTAREA)$/.test(doc.activeElement?.tagName || ''))));
    }
    function check() {
        timer = null;
        if (!eligible()) { show(); return; }
        if (deadline > now()) { timer = env.setTimeout(check, deadline - now()); return; }
        const blocked = isBlocked();
        if (!locked(blocked)) {
            if (!ownsInert) { previousInert = !!toolbar.inert; ownsInert = true; }
            toolbar.inert = true;
            toolbar.classList.add('toolbar-hidden');
        }
        const capsuleLocked = blocked || nativeSelect || (doc.hasFocus?.() !== false
            && (capsuleHovering || keyboard && capsule?.contains(doc.activeElement)));
        capsule?.classList.toggle('song-actions-idle', !capsuleLocked);
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
    const enterCapsule = () => { capsuleHovering = true; activity(); };
    const leaveCapsule = () => { capsuleHovering = false; activity(); };
    const select = event => { if (event.target?.tagName === 'SELECT') nativeSelect = true; activity(); };
    const finishSelect = () => { nativeSelect = false; activity(); };
    const visibility = () => { cancel(); activity(); };
    const listeners = [
        [doc, 'pointermove', activity], [doc, 'pointerdown', pointer], [doc, 'keydown', key],
        [doc, 'focusin', activity], [doc, 'focusout', activity], [doc, 'visibilitychange', visibility],
        [env, 'focus', activity], [env, 'blur', activity], [doc, 'dragover', activity], [doc, 'wheel', activity],
        [toolbar, 'pointerenter', enter], [toolbar, 'pointerleave', leave],
        [toolbar, 'pointerdown', select], [toolbar, 'change', finishSelect], [toolbar, 'focusout', finishSelect]
    ];
    if (capsule) listeners.push([capsule, 'pointerenter', enterCapsule], [capsule, 'pointerleave', leaveCapsule]);
    for (const [target, event, handler] of listeners) target.addEventListener(event, handler, { capture: event === 'keydown', passive: event.startsWith('pointer') || event === 'wheel' });
    compact.addEventListener('change', activity);
    activity();
    return { sync: activity, dispose() {
        cancel(); show();
        for (const [target, event, handler] of listeners) target.removeEventListener(event, handler, { capture: event === 'keydown' });
        compact.removeEventListener?.('change', activity);
    } };
}
