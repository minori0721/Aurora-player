import test from 'node:test';
import assert from 'node:assert/strict';
import { coverImageKey, createCoverImageUrls } from '../src/shared/cover-url.js';

const path = '/0_wnulBd-6lgQuSkp0bW9g==/109951169976598406.jpg';
const p3 = `https://p3.music.126.net${path}`, p4 = `https://p4.music.126.net${path}`;

test('catalog artwork shares its first CDN host across sizes and source aliases', () => {
    const { url } = createCoverImageUrls();
    assert.equal(url(p4, 512), `${p4}?param=512y512`);
    assert.equal(url(p3, 120), `${p4}?param=120y120`);
    assert.equal(url(`${p3}?param=320y320`, 80), `${p4}?param=80y80`);
    assert.equal(url(p3), p4);
    assert.equal(coverImageKey(`${p3}?param=512y512`), coverImageKey(`${p4}?param=80y80`));
});

test('the opposite first host is also retained without merging different image paths', () => {
    const { url } = createCoverImageUrls();
    assert.equal(url(p3, 120), `${p3}?param=120y120`);
    assert.equal(url(p4, 512), `${p3}?param=512y512`);
    assert.equal(url(p4.replace('598406', '598407'), 120), `${p4.replace('598406', '598407')}?param=120y120`);
});

test('URL parameters are replaced structurally and meaningful queries keep source identity', () => {
    const { url } = createCoverImageUrls();
    assert.equal(url(`${p3}?param=500y500&v=2`, 120), `${p3}?param=120y120&v=2`);
    assert.equal(url(`${p4}?v=2`, 120), `${p4}?v=2&param=120y120`);
    assert.notEqual(coverImageKey(`${p3}?v=2`), coverImageKey(`${p4}?v=2`));
    assert.notEqual(coverImageKey(`${p3}?v=2`), coverImageKey(`${p3}?v=3`));
    assert.notEqual(coverImageKey(`${p3}?param=80y100`), coverImageKey(p3));
    assert.notEqual(coverImageKey(`${p3}?param=80y80&param=crop`), coverImageKey(p3));
});

test('external, animated, credentialed and unrelated NetEase hosts are not aliased', () => {
    const { url } = createCoverImageUrls();
    for (const source of ['https://cover.example/a.jpg?token=signature&param=original',
        'data:image/png;base64,AA', 'blob:https://player.test/cover', '', 'bad-url',
        `${p3.replace('.jpg', '.gif')}?param=80y80`, p3.replace('.jpg', '.webp'),
        p3.replace('p3.', 'p3.music.126.net.example/'), p3.replace('p3.', 'user:pass@p3.')]) {
        assert.equal(url(source, 120), source);
    }
    assert.notEqual(coverImageKey(p3), coverImageKey(p3.replace('p3.', 'p3.alt.')));
    assert.equal(url(p3.replace('https:', 'http:'), 120), `${p3}?param=120y120`);
});

test('CDN alias bookkeeping is bounded and retains recently used image identities', () => {
    const { url } = createCoverImageUrls();
    url(p4);
    for (let i = 0; i < 511; i++) url(`https://p3.music.126.net/hash/${i}.jpg`);
    assert.equal(url(p3), p4);
    url('https://p3.music.126.net/hash/511.jpg');
    assert.equal(url(p3), p4);
    for (let i = 512; i < 1024; i++) url(`https://p3.music.126.net/hash/${i}.jpg`);
    assert.equal(url(p3), p3);
});

test('an image retry moves aliases to the alternate host without touching opaque URLs', () => {
    const { url, retryUrl } = createCoverImageUrls();
    assert.equal(url(p3, 120), `${p3}?param=120y120`);
    assert.equal(retryUrl(`${p3}?param=120y120`), `${p4}?param=120y120`);
    assert.equal(url(p3, 512), `${p4}?param=512y512`);
    assert.equal(retryUrl(`${p4}?param=120y120`), `${p3}?param=120y120`);
    for (const source of [`${p3}?token=signed`, 'https://example.test/image.jpg', 'blob:test']) assert.equal(retryUrl(source), '');
});
