import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPublicProfile, normalizePublicProfile, parsePublicProfileInput } from '../src/netease/public-profile.js';
import { createMyPlaylists } from '../src/netease/my-playlists.js';
import { createHost, FakeElement } from './helpers/host.mjs';

const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const profile = id => ({ userId: id, nickname: `User ${id}`, avatarUrl: 'https://p1.music.126.net/example.jpg?param=100y100' });
const playlist = (id, owner = 123) => ({ id, creator: { userId: owner, nickname: 'Creator' }, name: `Playlist ${id}`, privacy: 0, trackCount: 10 });

class View extends FakeElement {
    set innerHTML(value) { super.innerHTML = value; this.controls = new Map(); }
    get innerHTML() { return super.innerHTML; }
    querySelector(selector) {
        const attribute = selector.match(/^\[([^\]]+)\]$/)?.[1];
        if (!attribute || !this.innerHTML.includes(attribute)) return null;
        if (!this.controls.has(attribute)) this.controls.set(attribute, new FakeElement());
        return this.controls.get(attribute);
    }
}

function fixture({ saved = null, handler = null, loggedIn = false } = {}) {
    const { host, elements } = createHost(html);
    elements.set('public-profile-results', new View());
    elements.set('mylist-content', new View());
    elements.get('public-profile-remember').checked = true;
    if (saved) host.localStorage.setItem('aurora_public_profile', JSON.stringify(saved));
    const calls = [], navigations = [], logins = [], images = [], tab = new FakeElement();
    host.document.querySelector = selector => selector.includes('data-tab="mylist"') ? tab : null;
    const state = { time: 1000, handler };
    const auth = { neteaseUser: loggedIn ? profile(456) : null, neteaseCookie: loggedIn ? 'synthetic-private-credential' : '',
        showLogin: mode => logins.push(mode) };
    const service = createPublicProfile({ auth, api: { buildApiUrl: path => `https://fixture.invalid${path}` },
        browser: { navigateMusic: route => navigations.push(route) },
        content: { clearMusicImages: target => images.push(['clear', target]), observeMusicImages: target => images.push(['observe', target]) },
        myPlaylists: createMyPlaylists({}),
        transfer: { async fetchJsonWithStageTimeout(raw, options, timeout) {
            const url = new URL(raw);
            calls.push({ url, options, timeout });
            if (state.handler) return state.handler(url, options);
            if (url.pathname === '/search') return { code: 200, result: { userprofiles: [profile(123), profile(456)], userprofileCount: 2 } };
            if (url.pathname === '/user/detail') return { code: 200, profile: profile(Number(url.searchParams.get('uid'))) };
            return { code: 200, playlist: [playlist(1), playlist(2, 999)], more: false };
        } }
    }, { document: host.document, storage: host.localStorage, now: () => state.time });
    service.initialize();
    const node = id => elements.get(id);
    const submit = value => { node('public-profile-query').value = value; node('public-profile-query').oninput(); return node('public-profile-form').onsubmit({ preventDefault() {} }); };
    return { service, auth, calls, navigations, logins, images, tab, state, node, submit, storage: host.localStorage };
}

test('public profile input accepts UID and official desktop, hash and mobile links', () => {
    for (const value of ['123', ' 00123 ', 'https://music.163.com/#/user/home?id=123',
        'https://music.163.com/user/home?id=123', 'music.163.com/user/home?id=123', 'https://y.music.163.com/m/user/home?id=123']) {
        assert.deepEqual(parsePublicProfileInput(value), { id: 123 });
    }
    assert.deepEqual(parsePublicProfileInput(' PixelMix '), { query: 'PixelMix' });
    for (const value of ['', '0', '9007199254740992', 'https://other.invalid/user/home?id=123',
        'https://music.163.com/playlist?id=123', 'https://music.163.com/#/user/home?id=0', 'https://name:pass@music.163.com/user/home?id=123']) {
        assert.equal(parsePublicProfileInput(value), null, value);
    }
});

test('remembered identity contains only public display fields, never privileges or credentials', () => {
    assert.deepEqual(normalizePublicProfile({ ...profile(123), cookie: 'synthetic', vipType: 11, token: 'synthetic' }), profile(123));
    assert.equal(normalizePublicProfile({ userId: 0 }), null);
    assert.equal(normalizePublicProfile({ userId: 'NaN' }), null);
    assert.equal(normalizePublicProfile({ userId: 1, avatarUrl: 'javascript:alert(1)' }).avatarUrl, '');
});

test('opening the public option makes no request and offers the remembered public identity', () => {
    const f = fixture({ saved: profile(123) });
    f.service.openSearch();
    assert.equal(f.calls.length, 0);
    assert.match(f.node('public-profile-results').innerHTML, /已记住的主页/);
    assert.match(f.node('public-profile-results').innerHTML, /User 123/);
    assert.equal(f.service.currentUserId, 123);
    assert.equal(f.auth.neteaseUser, null);
});

test('search uses explicit anonymous credentials even when a real account is signed in', async () => {
    const f = fixture({ loggedIn: true }), account = f.auth.neteaseUser;
    await f.submit('PixelMix');
    assert.equal(f.calls.length, 1);
    const { url, options, timeout } = f.calls[0];
    assert.equal(url.pathname, '/search');
    assert.equal(url.searchParams.get('type'), '1002');
    assert.equal(url.searchParams.get('cookie'), 'os=pc');
    assert.equal(url.searchParams.get('noCookie'), 'true');
    assert.equal(options.credentials, 'omit');
    assert.equal(timeout, 15000);
    assert.equal(JSON.stringify(f.calls).includes(f.auth.neteaseCookie), false);
    assert.match(f.node('public-profile-results').innerHTML, /data-public-user="123"/);
    assert.equal(f.auth.neteaseUser, account);
    assert.equal(f.storage.getItem('netease_cookie'), null);
});

test('numeric input skips search and stores nothing until a valid public profile is loaded', async () => {
    const f = fixture();
    await f.submit('123');
    assert.deepEqual(f.navigations, [{ kind: 'user-playlists', id: 123 }]);
    assert.equal(f.calls.length, 0);
    assert.equal(f.storage.getItem('aurora_public_profile'), null);
    await f.service.renderPlaylistsPage(123, { signal: new AbortController().signal });
    assert.deepEqual(JSON.parse(f.storage.getItem('aurora_public_profile')), profile(123));
    assert.equal(f.auth.neteaseUser, null);
    assert.equal(f.auth.neteaseCookie, '');
    assert.equal(f.calls.length, 2);
    assert.match(f.node('mylist-content').innerHTML, /公开浏览/);
    assert.match(f.node('mylist-content').innerHTML, /TA创建的歌单/);
    assert.match(f.node('mylist-content').innerHTML, /TA收藏的歌单/);
    assert.equal(f.tab.textContent, '公开歌单');
});

test('opting out of remembering and changing or forgetting profiles never logs an account out', async () => {
    const f = fixture({ loggedIn: true });
    f.node('public-profile-remember').checked = false;
    await f.submit('123');
    await f.service.renderPlaylistsPage(123, { signal: new AbortController().signal });
    assert.equal(f.storage.getItem('aurora_public_profile'), null);
    f.node('mylist-content').querySelector('[data-public-remember]').click();
    assert.equal(JSON.parse(f.storage.getItem('aurora_public_profile')).userId, 123);
    f.node('mylist-content').querySelector('[data-public-remember]').click();
    assert.equal(f.storage.getItem('aurora_public_profile'), null);
    assert.equal(f.auth.neteaseUser.userId, 456);
    assert.equal(f.calls.length, 2);
});

test('returning through the other playlist entry reuses public responses for one minute', async () => {
    const f = fixture(), options = () => ({ signal: new AbortController().signal });
    await f.service.renderPlaylistsPage(123, options());
    await f.service.renderPlaylistsPage(f.service.currentUserId, options());
    assert.equal(f.calls.length, 2);
    f.state.time += 60001;
    await f.service.renderPlaylistsPage(123, options());
    assert.equal(f.calls.length, 4);
});

test('public requests and selected profiles do not overwrite a newer navigation after abort', async () => {
    const resolvers = [];
    const f = fixture({ handler: () => new Promise(done => { resolvers.push(done); }) });
    const controller = new AbortController();
    const loading = f.service.renderPlaylistsPage(123, { signal: controller.signal });
    controller.abort();
    f.node('mylist-content').innerHTML = 'next page';
    // Both mocked transports ignore abort, but their submissions still must be discarded.
    assert.equal(f.calls.length, 2);
    resolvers[0]({ code: 200, profile: profile(123) });
    resolvers[1]({ code: 200, playlist: [], more: false });
    assert.equal(f.service.currentUserId, null);
    assert.equal(f.node('mylist-content').innerHTML, 'next page');
    await loading;
    assert.equal(f.storage.getItem('aurora_public_profile'), null);
});

test('editing a nickname aborts old search results and never navigates or remembers an account', async () => {
    let resolve;
    const f = fixture({ handler: () => new Promise(done => { resolve = done; }) });
    const old = f.submit('old nickname');
    f.node('public-profile-query').value = 'new nickname'; f.node('public-profile-query').oninput();
    assert.equal(f.calls[0].options.signal.aborted, true);
    resolve({ code: 200, result: { userprofiles: [profile(123)] } });
    await old;
    assert.equal(f.node('public-profile-results').innerHTML, '');
    assert.equal(f.navigations.length, 0);
    assert.equal(f.storage.getItem('aurora_public_profile'), null);
});

test('public paging deduplicates IDs, hides private entries and preserves the requested offset', async () => {
    const f = fixture({ handler: url => url.pathname === '/user/detail' ? { code: 200, profile: profile(123) }
        : { code: 200, playlist: url.searchParams.get('offset') === '0'
            ? [playlist(1), { ...playlist(10), privacy: 10 }] : [playlist(1), playlist(2)], more: url.searchParams.get('offset') === '0' } });
    await f.service.renderPlaylistsPage(123, { signal: new AbortController().signal });
    assert.doesNotMatch(f.node('mylist-content').innerHTML, /Playlist 10/);
    f.node('mylist-content').querySelector('[data-public-page]').click();
    await settle();
    assert.equal(f.calls.at(-1).url.searchParams.get('offset'), '30');
    assert.equal(f.node('mylist-content').innerHTML.split('data-id="1"').length - 1, 1);
    assert.match(f.node('mylist-content').innerHTML, /已显示 2 个歌单/);
    assert.equal(f.node('mylist-content').querySelector('[data-public-page]'), null);
});

test('anonymous permission errors are shown inside the public view without triggering login', async () => {
    const f = fixture({ handler: () => ({ code: 301 }) });
    await f.service.renderPlaylistsPage(123, { signal: new AbortController().signal });
    assert.match(f.node('mylist-content').innerHTML, /该内容未公开或需要登录/);
    assert.equal(f.logins.length, 0);
    assert.equal(f.auth.neteaseUser, null);
    assert.equal(f.storage.getItem('aurora_public_profile'), null);
});

test('public names and playlist text are escaped, with no inherited VIP or account controls', async () => {
    const f = fixture({ handler: url => url.pathname === '/search' ? { code: 200, result: { userprofiles: [{ ...profile(123), nickname: '<img onerror=bad>' }] } }
        : url.pathname === '/user/detail' ? { code: 200, profile: { ...profile(123), nickname: '<script>bad</script>', vipType: 11 } }
            : { code: 200, playlist: [{ ...playlist(1), name: '<script>bad</script>' }], more: false } });
    await f.submit('name');
    assert.match(f.node('public-profile-results').innerHTML, /&lt;img onerror=bad&gt;/);
    await f.service.renderPlaylistsPage(123, { signal: new AbortController().signal });
    assert.doesNotMatch(f.node('mylist-content').innerHTML, /<script>|VIP|data-song-like|data-action="logout"/);
    assert.match(f.node('mylist-content').innerHTML, /&lt;script&gt;bad&lt;\/script&gt;/);
});

test('remembering failure does not prevent public browsing, and an unknown profile is not saved', async () => {
    const f = fixture();
    f.storage.setItem = () => { throw new Error('storage blocked'); };
    await f.submit('123');
    await f.service.renderPlaylistsPage(123, { signal: new AbortController().signal });
    assert.match(f.node('mylist-content').innerHTML, /无法记住此主页/);
    assert.equal(f.service.currentUserId, 123);
    const invalid = fixture({ handler: () => ({ code: 200, profile: null, playlist: [] }) });
    await invalid.submit('123');
    await invalid.service.renderPlaylistsPage(123, { signal: new AbortController().signal });
    assert.equal(invalid.storage.getItem('aurora_public_profile'), null);
    assert.match(invalid.node('mylist-content').innerHTML, /公开资料返回不完整/);
});
