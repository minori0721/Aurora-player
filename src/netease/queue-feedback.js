export function createQueueFeedback(options) {
    const { element, isActive, env = window } = options;
    const doc = env.document;
    let timer = null, generation = 0, initialized = false;

    function clear() {
        generation++;
        if (timer !== null) env.clearTimeout(timer);
        timer = null;
        element?.classList.remove('show');
        if (element) element.textContent = '';
    }

    function show(message) {
        clear();
        if (!element || !message || doc.hidden || !isActive()) return;
        const token = generation;
        element.textContent = message;
        element.classList.add('show');
        timer = env.setTimeout(() => {
            if (token !== generation) return;
            timer = null;
            element.classList.remove('show');
            if (env.matchMedia('(prefers-reduced-motion: reduce)').matches) clear();
            else timer = env.setTimeout(() => {
                if (token === generation) clear();
            }, 150);
        }, 3000);
    }

    const onVisibility = () => { if (doc.hidden) clear(); };
    return {
        show, clear,
        initialize() {
            if (initialized) return;
            initialized = true;
            doc.addEventListener('visibilitychange', onVisibility);
        },
        dispose() {
            clear();
            doc.removeEventListener('visibilitychange', onVisibility);
            initialized = false;
        }
    };
}
