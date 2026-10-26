export function createImportPicker({ input, onSelect, onFallback }, { environment = globalThis } = {}) {
    const navigator = environment.navigator;
    const android = navigator?.userAgentData?.platform === 'Android'
        || /Android/i.test(navigator?.userAgent || '');
    let selecting = false, compatibility = false;

    return {
        async open() {
            if (selecting) return;
            if (!android) { input.click(); return; }
            if (compatibility || !environment.isSecureContext || typeof environment.showOpenFilePicker !== 'function') {
                // An audio filter (or */*) can enable Chrome's microphone permission path.
                input.accept = 'application/octet-stream';
                input.removeAttribute('capture');
                input.click();
                return;
            }

            selecting = true;
            let handles;
            try {
                // Android's document picker must also allow unknown LRC/SLI MIME types.
                handles = await environment.showOpenFilePicker({ multiple: true });
            } catch (error) {
                if (error?.name !== 'AbortError') {
                    compatibility = true;
                    onFallback(error);
                }
                return;
            } finally {
                selecting = false;
            }
            if (handles?.length) return onSelect(handles);
        }
    };
}
