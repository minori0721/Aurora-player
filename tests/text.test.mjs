import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanCookie, redactDiagnosticText } from '../src/shared/text.js';
import { createDebug } from '../src/ui/debug.js';
import { FakeElement } from './helpers/host.mjs';

test('cookie normalization drops attributes and empty segments but preserves unknown names', () => {
    assert.equal(cleanCookie(' MUSIC_U=first; ; Path=/; Max-Age=123; expires=Wed, 21 Oct 2026; SameSite=None; Secure; HttpOnly; priority=High; Partitioned; unknown=keep; MUSIC_U=last==; __csrf=fake '),
        'MUSIC_U=last==; unknown=keep; __csrf=fake');
});

test('cookie normalization is idempotent, case-sensitive and preserves values after the first equals', () => {
    const value = 'MUSIC_U=old; music_u=lower; MUSIC_U=new==; unknown=a=b=c; empty=; empty=gone; empty=';
    const result = cleanCookie(value);
    assert.equal(result, 'MUSIC_U=new==; music_u=lower; unknown=a=b=c; empty=');
    assert.equal(cleanCookie(result), result);
    assert.equal(cleanCookie('SecureToken=valid; Pathology=valid'), 'SecureToken=valid; Pathology=valid');
});

test('cookie normalization rejects malformed segments and control characters without throwing', () => {
    for (const value of [null, undefined, 3, {}, []]) assert.equal(cleanCookie(value), '');
    assert.equal(cleanCookie('invalid; =value; bad name=x; good=safe; bad=header\r\nInjected; no\tname=value'), 'good=safe');
});

test('diagnostics redact credentials in URL queries, raw cookies and encoded cookie pairs', () => {
    for (const text of [
        'HTTP 500: https://api.test/song/url?cookie=synthetic-secret&source=one',
        'HTTP 500: https://api.test/song/url?%63ookie=synthetic-secret',
        'request MUSIC_U=synthetic-secret; __csrf=synthetic-secret',
        'cookie=MUSIC_U%3Dsynthetic-secret%3B%20unknown%3Dsynthetic-secret',
        'MUSIC_U%3Dsynthetic-secret%3B',
        'response token: synthetic-secret',
        'https://synthetic-secret:synthetic-secret@api.test/path?key=synthetic-secret'
    ]) {
        const safe = redactDiagnosticText(text);
        assert.ok(!safe.includes('synthetic-secret'));
        assert.match(safe, /REDACTED/);
    }
    assert.equal(redactDiagnosticText('备用来源 HTTP 500，请稍后重试'), '备用来源 HTTP 500，请稍后重试');
});

test('application logs redact before both console output and in-page insertion', t => {
    const panel = new FakeElement('debug-console'); panel.style.display = 'none';
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
        getElementById: () => panel, createElement: () => new FakeElement()
    } });
    t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
    const messages = [];
    t.mock.method(console, 'log', message => messages.push(message));
    createDebug().log('请求 cookie=MUSIC_U=synthetic-secret', 'error');
    assert.equal(messages.length, 1);
    assert.ok(!messages[0].includes('synthetic-secret'));
    assert.ok(!panel.children[0].textContent.includes('synthetic-secret'));
    assert.equal(panel.children[0].className, 'log-item log-err');
});
