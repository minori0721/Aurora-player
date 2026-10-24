export function createMediaSession({ readState, play, pause, previous, next, seekTo }, {
    session = globalThis.navigator?.mediaSession,
    setTimer = setTimeout,
    clearTimer = clearTimeout
} = {}) {
    let initialized = false, disposed = false, timer = null, timerVersion = 0, generation = 0;
    let lastStatus = null, positionCleared = false;
    let positionSupported = typeof session?.setPositionState === 'function';
    const registered = [];

    function stopTimer() {
        timerVersion++;
        if (timer !== null) clearTimer(timer);
        timer = null;
    }

    function setStatus(status) {
        if (!session || lastStatus === status) return;
        try { session.playbackState = status; lastStatus = status; } catch (_) {}
    }

    function clearPosition() {
        if (!positionSupported || positionCleared) return;
        try { session.setPositionState(); positionCleared = true; }
        catch (_) { positionSupported = false; }
    }

    function sync() {
        if (!initialized || disposed || !session) return;
        const state = readState();
        const moving = state.hasAudio && state.status === 'playing' && state.running !== false;
        setStatus(moving ? 'playing' : (!state.hasAudio || state.status === 'idle' ? 'none' : 'paused'));
        const valid = state.hasAudio && state.status !== 'idle' && state.status !== 'error'
            && Number.isFinite(state.duration) && state.duration > 0 && Number.isFinite(state.position);
        if (valid && positionSupported) {
            try {
                session.setPositionState({ duration: state.duration, playbackRate: 1,
                    position: Math.max(0, Math.min(state.position, state.duration)) });
                positionCleared = false;
            } catch (_) { positionSupported = false; }
        } else clearPosition();
        if (!moving || !valid || !positionSupported) { stopTimer(); return; }
        if (timer !== null) return;
        const version = timerVersion;
        // Independent of visual RAF so hidden playback and PCM loop wraps still resync.
        timer = setTimer(() => {
            if (disposed || version !== timerVersion) return;
            timer = null;
            sync();
        }, 1000);
    }

    function seek(details, direction = 0) {
        const state = readState();
        if (!state.hasAudio || !Number.isFinite(state.duration) || state.duration <= 0) return;
        let target = details?.seekTime;
        if (direction) {
            if (!Number.isFinite(state.position)) return;
            const offset = Number.isFinite(details?.seekOffset) && details.seekOffset > 0 ? details.seekOffset : 10;
            target = state.position + direction * offset;
        }
        if (Number.isFinite(target)) return seekTo(Math.max(0, Math.min(target, state.duration)));
    }

    function reset() {
        generation++;
        stopTimer();
        if (!initialized || disposed) return;
        setStatus('none');
        clearPosition();
    }

    return {
        sync,
        reset,
        initialize() {
            if (initialized || disposed) return;
            initialized = true;
            if (typeof session?.setActionHandler === 'function') {
                const actions = { play, pause, previoustrack: previous, nexttrack: next,
                    seekto: details => seek(details), seekbackward: details => seek(details, -1), seekforward: details => seek(details, 1) };
                for (const [name, action] of Object.entries(actions)) {
                    if (typeof action !== 'function') continue;
                    try {
                        session.setActionHandler(name, details => {
                            if (disposed) return;
                            const version = generation;
                            try {
                                const result = action(details);
                                sync();
                                if (result?.then) {
                                    const finish = () => { if (version === generation) sync(); };
                                    return Promise.resolve(result).then(finish, finish);
                                }
                            } catch (_) { sync(); }
                        });
                        registered.push(name);
                    } catch (_) {}
                }
            }
            sync();
        },
        dispose() {
            if (disposed) return;
            reset();
            disposed = true;
            for (const name of registered) {
                try { session.setActionHandler(name, null); } catch (_) {}
            }
        }
    };
}
