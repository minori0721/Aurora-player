import test from 'node:test';
import assert from 'node:assert/strict';
import { createImportPicker } from '../src/playlist/file-picker.js';

function fixture(overrides = {}) {
    const input = {
        accept: 'audio/*,.lrc,.sli', clicks: 0, captureRemoved: false,
        click() { this.clicks++; },
        removeAttribute(name) { if (name === 'capture') this.captureRemoved = true; }
    };
    const selected = [], failures = [], calls = [];
    const environment = {
        navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 16) Chrome/142.0' },
        isSecureContext: true,
        async showOpenFilePicker(options) {
            assert.equal(this, environment, 'preserve the browser API receiver');
            calls.push(options);
            return [{ name: 'test.mp3', kind: 'file' }];
        },
        ...overrides
    };
    const picker = createImportPicker({ input, onSelect: handles => selected.push(handles), onFallback: error => failures.push(error) }, { environment });
    return { input, selected, failures, calls, environment, picker };
}

test('Android uses the document API without audio filters, capture or write permissions', async () => {
    const f = fixture();
    await f.picker.open();
    assert.deepEqual(f.calls, [{ multiple: true }]);
    assert.equal(f.selected.length, 1);
    assert.equal(f.input.clicks, 0);
    assert.equal(f.failures.length, 0);
});

test('Android client hints still select the document API in desktop-site mode', async () => {
    const f = fixture({ navigator: { userAgentData: { platform: 'Android' }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } });
    await f.picker.open();
    assert.equal(f.calls.length, 1);
    assert.equal(f.input.clicks, 0);
});

for (const userAgent of ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', '']) {
    test(`non-Android leaves the existing picker and filter unchanged: ${userAgent || 'unknown host'}`, async () => {
        const f = fixture({ navigator: { userAgent } });
        const action = f.picker.open();
        assert.equal(f.input.clicks, 1, 'open synchronously within the user gesture');
        await action;
        assert.equal(f.calls.length, 0);
        assert.equal(f.input.accept, 'audio/*,.lrc,.sli');
        assert.equal(f.input.captureRemoved, false);
    });
}

for (const overrides of [{ showOpenFilePicker: undefined }, { isSecureContext: false }]) {
    test(`Android compatibility path for ${overrides.isSecureContext === false ? 'insecure context' : 'missing API'}`, async () => {
        const f = fixture(overrides);
        const action = f.picker.open();
        assert.equal(f.input.clicks, 1);
        await action;
        assert.equal(f.input.accept, 'application/octet-stream');
        assert.equal(f.input.captureRemoved, true);
        assert.equal(f.selected.length, 0);
        assert.equal(f.calls.length, 0);
        assert.equal(f.failures.length, 0);
    });
}

test('cancellation does not import, report failure, open fallback or disable the native picker', async () => {
    const f = fixture({ showOpenFilePicker: async () => { throw new DOMException('Cancelled', 'AbortError'); } });
    await f.picker.open();
    assert.equal(f.input.clicks, 0);
    assert.equal(f.selected.length, 0);
    assert.equal(f.failures.length, 0);
    f.environment.showOpenFilePicker = async () => [{ kind: 'file', name: 'next.mp3' }];
    await f.picker.open();
    assert.equal(f.selected.length, 1);
    assert.equal(f.input.clicks, 0);
});

for (const name of ['SecurityError', 'NotAllowedError', 'NotSupportedError', 'Error']) {
    test(`${name} requires another user click before opening the compatibility picker`, async () => {
        const error = Object.assign(new Error('Picker unavailable'), { name });
        const f = fixture({ showOpenFilePicker: async () => { throw error; } });
        await f.picker.open();
        assert.equal(f.input.clicks, 0, 'never open a second dialog after async failure');
        assert.deepEqual(f.failures, [error]);
        assert.equal(f.selected.length, 0);
        await f.picker.open();
        assert.equal(f.input.clicks, 1);
        assert.equal(f.input.accept, 'application/octet-stream');
        assert.equal(f.failures.length, 1);
    });
}

test('rapid clicks share the active native dialog and preserve the complete multi-selection', async () => {
    let finish, count = 0;
    const f = fixture({ showOpenFilePicker: () => { count++; return new Promise(resolve => { finish = resolve; }); } });
    const pending = f.picker.open();
    await f.picker.open();
    assert.equal(count, 1);
    const handles = ['music.flac', 'music.lrc', 'music.sli'].map(name => ({ name, kind: 'file' }));
    finish(handles);
    await pending;
    assert.deepEqual(f.selected, [handles]);
    assert.equal(f.input.clicks, 0);
});

test('an empty selection is a no-op and does not prevent another selection', async () => {
    const f = fixture({ showOpenFilePicker: async () => [] });
    await f.picker.open();
    assert.equal(f.selected.length, 0);
    f.environment.showOpenFilePicker = async () => [{ kind: 'file', name: 'next.mp3' }];
    await f.picker.open();
    assert.equal(f.selected.length, 1);
});
