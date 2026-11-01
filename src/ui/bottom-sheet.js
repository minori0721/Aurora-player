const MIN_HEIGHT = 56;
const SNAP_DISTANCE = 18;

export function settleSheetHeight(height, min, max) {
    const value = Math.max(min, Math.min(max, height));
    if (value - min <= SNAP_DISTANCE && value - min <= max - value) return min;
    if (max - value <= SNAP_DISTANCE) return max;
    return value;
}

export function createBottomSheet({ panel, header, handle, body, controls, toolbar, label, env = window }) {
    const compact = env.matchMedia('(max-width: 900px)'), doc = env.document;
    const viewport = env.visualViewport;
    let initialized = false, open = false, watching = false, active = false;
    let preferredHeight = null, expandedHeight = null, defaultHeight = MIN_HEIGHT, height = 0;
    let bounds = { min: MIN_HEIGHT, max: MIN_HEIGHT }, bottom = null;
    let drag = null, ignoreClick = false, frame = 0, needsMeasure = false, pendingHeight = null;
    const resizeObserver = env.ResizeObserver ? new env.ResizeObserver(() => viewportChanged()) : null;
    const clamp = value => Math.max(bounds.min, Math.min(bounds.max, value));

    function measure() {
        const visibleHeight = viewport?.height || env.innerHeight;
        const top = viewport?.offsetTop || 0, visibleBottom = top + visibleHeight;
        const row = controls?.getBoundingClientRect();
        const toolbarBottom = toolbar?.getBoundingClientRect().bottom;
        const topInset = toolbarBottom > top && toolbarBottom < visibleBottom ? Math.max(12, toolbarBottom - top + 8) : 12;
        const dock = row && row.top >= top + MIN_HEIGHT + 24 && row.bottom <= visibleBottom + 1
            ? visibleBottom - row.top + 10 : 12;
        const nextBottom = Math.max(0, env.innerHeight - visibleBottom) + dock;
        if (bottom !== nextBottom) {
            bottom = nextBottom;
            panel.style.setProperty('--bottom-sheet-bottom', `${bottom}px`);
        }
        bounds = { min: MIN_HEIGHT, max: Math.max(MIN_HEIGHT, Math.min(visibleHeight * .7, visibleHeight - dock - topInset)) };
    }

    function write(nextHeight) {
        const value = clamp(nextHeight), collapsed = value <= bounds.min + .5;
        if (height !== value) {
            height = value;
            panel.style.setProperty('--bottom-sheet-height', `${height}px`);
        }
        panel.classList.toggle('bottom-sheet-collapsed', collapsed);
        if (collapsed && body.contains(doc.activeElement)) handle.focus({ preventScroll: true });
        body.inert = collapsed;
        handle.setAttribute('aria-expanded', String(!collapsed));
        handle.title = `${collapsed ? '展开' : '收拢'}${label}`;
    }

    function keepInputVisible() {
        const input = doc.activeElement;
        if (!body.contains(input) || !input.matches('input, select, textarea')) return;
        const box = input.getBoundingClientRect(), area = body.getBoundingClientRect();
        if (box.bottom > area.bottom - 8) body.scrollTop += box.bottom - area.bottom + 8;
        else if (box.top < area.top + 8) body.scrollTop -= area.top + 8 - box.top;
    }

    function schedule(measureFirst = false) {
        needsMeasure ||= measureFirst;
        if (frame || !active || !open || doc.hidden) return;
        frame = env.requestAnimationFrame(() => {
            frame = 0;
            if (needsMeasure) { needsMeasure = false; measure(); }
            write(pendingHeight ?? preferredHeight ?? defaultHeight);
            pendingHeight = null;
            if (!drag) keepInputVisible();
        });
    }

    function cancelFrame() {
        if (frame) env.cancelAnimationFrame(frame);
        frame = 0; pendingHeight = null; needsMeasure = false;
    }

    function finishDrag(cancelled = false, event) {
        if (!drag || event && event.pointerId !== drag.id) return;
        const current = drag;
        drag = null;
        panel.classList.remove('bottom-sheet-dragging');
        if (handle.hasPointerCapture(current.id)) handle.releasePointerCapture(current.id);
        cancelFrame();
        if (cancelled) { write(current.height); return; }
        if (!current.moved) return;
        ignoreClick = true;
        const target = clamp(current.height + current.y - event.clientY);
        preferredHeight = settleSheetHeight(target, bounds.min, bounds.max);
        if (preferredHeight > bounds.min) expandedHeight = preferredHeight;
        panel.classList.toggle('bottom-sheet-settling', preferredHeight !== target);
        schedule();
    }

    function pointerDown(event) {
        if (!active || !open || event.isPrimary === false || event.button !== undefined && event.button !== 0
            || event.target.closest('.panel-close') || drag) return;
        panel.classList.remove('bottom-sheet-settling');
        measure(); write(preferredHeight ?? height);
        ignoreClick = false;
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, height, moved: false };
        handle.setPointerCapture(event.pointerId);
    }

    function pointerMove(event) {
        if (!drag || drag.id !== event.pointerId) return;
        const delta = drag.y - event.clientY;
        if (!drag.moved && (Math.abs(delta) < 6 || Math.abs(delta) < Math.abs(drag.x - event.clientX))) return;
        drag.moved = true;
        event.preventDefault();
        panel.classList.add('bottom-sheet-dragging');
        pendingHeight = clamp(drag.height + delta);
        schedule();
    }

    function toggle() {
        if (!active || !open) return;
        measure();
        if (height <= bounds.min + .5) preferredHeight = clamp(expandedHeight || bounds.max);
        else { expandedHeight = height; preferredHeight = bounds.min; }
        panel.classList.add('bottom-sheet-settling');
        schedule();
    }

    function click(event) {
        if (ignoreClick && event.detail !== 0) { ignoreClick = false; event.preventDefault(); return; }
        ignoreClick = false;
        toggle();
    }

    function viewportChanged() {
        finishDrag(true);
        panel.classList.remove('bottom-sheet-settling');
        schedule(true);
    }

    function visibilityChanged() {
        if (doc.hidden) { finishDrag(true); cancelFrame(); }
        else schedule(true);
    }

    function watch(enabled) {
        if (watching === enabled) return;
        watching = enabled;
        const method = enabled ? 'addEventListener' : 'removeEventListener';
        env[method]('resize', viewportChanged);
        env[method]('scroll', viewportChanged, { passive: true });
        viewport?.[method]('resize', viewportChanged);
        viewport?.[method]('scroll', viewportChanged);
        doc[method]('visibilitychange', visibilityChanged);
        if (enabled && controls) resizeObserver?.observe(controls);
        else resizeObserver?.disconnect();
    }

    function syncMode() {
        const enabled = compact.matches;
        watch(open && enabled);
        if (!enabled) {
            finishDrag(true); cancelFrame();
            if (active) {
                panel.classList.remove('bottom-sheet-ready', 'bottom-sheet-collapsed', 'bottom-sheet-settling');
                panel.style.removeProperty('--bottom-sheet-height');
                panel.style.removeProperty('--bottom-sheet-bottom');
                body.inert = false;
                handle.setAttribute('aria-expanded', 'true');
                height = 0; bottom = null;
            }
            active = false;
            return;
        }
        active = true;
        if (open) {
            panel.classList.add('bottom-sheet-ready');
            measure();
            defaultHeight = body.scrollHeight + MIN_HEIGHT;
            write(preferredHeight ?? defaultHeight);
        }
    }

    const pointerUp = event => finishDrag(false, event);
    const pointerCancel = event => finishDrag(true, event);
    const transitionEnd = event => { if (event.target === panel && event.propertyName === 'height') panel.classList.remove('bottom-sheet-settling'); };
    const focusIn = () => { if (active && open) schedule(true); };
    return {
        setOpen(next) {
            open = Boolean(next);
            if (!open) { finishDrag(true); cancelFrame(); panel.classList.remove('bottom-sheet-settling'); }
            syncMode();
        },
        initialize() {
            if (initialized) return;
            initialized = true;
            compact.addEventListener('change', syncMode);
            header.addEventListener('pointerdown', pointerDown);
            header.addEventListener('pointermove', pointerMove);
            header.addEventListener('pointerup', pointerUp);
            header.addEventListener('pointercancel', pointerCancel);
            handle.addEventListener('lostpointercapture', pointerCancel);
            handle.addEventListener('click', click);
            body.addEventListener('focusin', focusIn);
            panel.addEventListener('transitionend', transitionEnd);
        },
        dispose() {
            finishDrag(true); cancelFrame(); watch(false);
            compact.removeEventListener('change', syncMode);
            header.removeEventListener('pointerdown', pointerDown);
            header.removeEventListener('pointermove', pointerMove);
            header.removeEventListener('pointerup', pointerUp);
            header.removeEventListener('pointercancel', pointerCancel);
            handle.removeEventListener('lostpointercapture', pointerCancel);
            handle.removeEventListener('click', click);
            body.removeEventListener('focusin', focusIn);
            panel.removeEventListener('transitionend', transitionEnd);
            initialized = false;
        }
    };
}
