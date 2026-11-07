import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySongActionError, isDuplicateSongError } from '../src/netease/song-action-errors.js';

for (const [name, input, kind, retry] of [
    ['cancelled', { name: 'AbortError' }, 'cancelled', null],
    ['login code', { apiCode: 301 }, 'auth', 'login'],
    ['login HTTP', { status: 401, uncertain: true }, 'auth', 'login'],
    ['rate limit', { status: 429 }, 'rate-limited', null],
    ['rate-limit message', { apiCode: 502, message: '操作过于频繁' }, 'rate-limited', null],
    ['security challenge', { status: 403, message: '需要安全验证' }, 'verification', null],
    ['permission', { apiCode: 500, message: '没有权限' }, 'forbidden', null],
    ['full playlist', { apiCode: 512, message: '歌单已满' }, 'full', null],
    ['unavailable track', { apiCode: 502, message: '歌曲不存在' }, 'unavailable', null],
    ['bad parameters', { apiCode: 502, message: '参数错误' }, 'invalid', null],
    ['missing playlist', { apiCode: 512, message: '歌单不存在' }, 'invalid', null],
    ['unsupported endpoint', { status: 404 }, 'unsupported', null],
    ['missing endpoint method', { status: 405 }, 'unsupported', null],
    ['unknown 403', { status: 403 }, 'failed', 'retry'],
    ['unknown business error', { apiCode: 451 }, 'failed', 'retry'],
    ['ambiguous 502', { apiCode: 502 }, 'unconfirmed', 'check'],
    ['ambiguous 512', { apiCode: 512 }, 'unconfirmed', 'check'],
    ['unknown server failure', { apiCode: 500 }, 'unconfirmed', 'check'],
    ['timeout', { name: 'TimeoutError' }, 'unconfirmed', 'check'],
    ['network', { name: 'TypeError', message: 'https://secret.invalid?cookie=synthetic' }, 'unconfirmed', 'check'],
    ['incomplete membership', { kind: 'membership-unconfirmed' }, 'unconfirmed', 'check'],
    ['explicit duplicate', { apiCode: 500, message: '歌曲已存在' }, 'unconfirmed', 'check']
]) test(`collection error classification: ${name}`, () => {
    const result = classifySongActionError(input);
    assert.equal(result.kind, kind); assert.equal(result.retry, retry);
    assert.doesNotMatch(result.message, /secret|synthetic|https:/);
    assert.equal(result.error, kind !== 'cancelled');
});

test('read failures are not presented as an unconfirmed write', () => {
    const loading = classifySongActionError({ apiCode: 500 }, { loading: true });
    assert.equal(loading.kind, 'load-failed'); assert.equal(loading.retry, 'retry');
    assert.match(loading.message, /加载失败/); assert.doesNotMatch(loading.message, /收藏结果/);
    const checking = classifySongActionError({ apiCode: 500 }, { checking: true });
    assert.equal(checking.retry, 'check'); assert.match(checking.message, /确认收藏状态/);
    assert.equal(classifySongActionError({ apiCode: 301 }, { loading: true }).kind, 'auth');
});

test('duplicate hints depend on explicit wording, never only a reused status code', () => {
    for (const message of ['歌曲已存在，请勿重复收藏', 'Song already exists', 'Already in playlist', 'duplicate track']) {
        assert.equal(isDuplicateSongError({ message }), true);
    }
    assert.equal(isDuplicateSongError({ apiCode: 502 }), false);
    assert.equal(isDuplicateSongError({ apiCode: 512, message: '歌单已满' }), false);
});
