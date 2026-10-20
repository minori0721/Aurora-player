import { cleanCookie, escapeHtml, toHttps } from '../shared/text.js';
import { MUSIC_ROUTE_PREFIX, parseMusicRoute } from './routes.js';

export const SMS_RESEND_MS = 60000;
export const LOGIN_TIMEOUT_MS = 15000;

export function normalizeLoginPhone(country, number) {
    const countrycode = String(country).trim().replace(/^\+/, '');
    let phone = String(number).replace(/[\s()-]/g, '');
    if (!/^[1-9]\d{0,2}$/.test(countrycode)) return null;
    if (phone.startsWith('+')) {
        if (!phone.startsWith('+' + countrycode)) return null;
        phone = phone.slice(countrycode.length + 1);
    }
    if (!/^\d{6,14}$/.test(phone) || countrycode.length + phone.length > 15) return null;
    if (countrycode === '86' && !/^1\d{10}$/.test(phone)) return null;
    return { phone, countrycode, key: `${countrycode}:${phone}` };
}

function errorMessage(data, fallback) {
    const message = String(data?.message || data?.msg || '');
    if (/频繁|频率|次数|限流|limit|frequen/i.test(message)) return '操作过于频繁，请稍后再试';
    if (/滑块|易盾|安全验证|风控|风险|cheating/i.test(message)) return '需要网易安全验证，请改用扫码登录';
    if (/验证码|captcha/i.test(message)) return '验证码错误或已过期，请检查后重试';
    const code = Number(data?.code);
    return Number.isFinite(code) && code !== 200 ? `${fallback}（错误码 ${code}）` : fallback;
}

export function createLoginPage({ api, browser, dom, captureAuthSnapshot, isAuthSnapshotCurrent, commitLogin } = {},
    { environment = window, document: doc = document } = {}) {
    let session = null, lastMode = null, requestId = 0, countdownTimer = 0, initialized = false;
    const cooldowns = new Map();
    const node = id => doc.getElementById(id);
    const now = () => environment.Date?.now() ?? Date.now();
    const phoneValue = () => normalizeLoginPhone(node('login-country').value, node('login-phone').value);
    const captchaValue = () => node('login-captcha').value.trim();
    const current = value => session === value && !value.controller.signal.aborted
        && browser.currentMusicNavigationIs(value.navToken, value.hash)
        && dom.neteasePanel.classList.contains('show') && isAuthSnapshotCurrent(value.authSnapshot);
    const remaining = phone => Math.max(0, Math.ceil(((cooldowns.get(phone?.key) || 0) - now()) / 1000));

    function status(text = '', kind = '') {
        const target = node(session?.mode === 'sms' ? 'sms-login-status' : 'qrcode-status');
        target.textContent = text;
        target.dataset.state = kind;
    }

    function render() {
        environment.clearTimeout(countdownTimer); countdownTimer = 0;
        if (!session) return;
        const busy = !!session.busy, locked = busy || session.completed;
        const sms = session.mode === 'sms', phone = phoneValue(), seconds = remaining(phone);
        node('login-send-code').disabled = !phone || locked || seconds > 0 || !!session.candidate;
        node('login-send-code').textContent = session.busy === 'sending' ? '发送中…' : seconds ? `${seconds} 秒后重发` : '获取验证码';
        node('login-submit').disabled = locked || !!session.candidate || !phone || !/^\d{4,8}$/.test(captchaValue());
        node('login-submit').textContent = session.busy === 'login' || session.busy === 'checking' ? '登录中…' : '登录';
        node('login-captcha').readOnly = locked;
        node('login-phone').readOnly = node('login-country').readOnly = !!session.completed;
        node('login-retry').hidden = !session.candidate || busy || session.completed;
        node('login-refresh-qr').disabled = locked;
        node('login-mode-qr').disabled = node('login-mode-sms').disabled = !!session.completed;
        if (sms && seconds && !session.completed) countdownTimer = environment.setTimeout(render, 1000);
    }

    function cancel(clearReturn = true) {
        const previous = session;
        session = null;
        previous?.controller.abort();
        environment.clearTimeout(previous?.timer);
        environment.clearTimeout(previous?.returnTimer);
        environment.clearTimeout(countdownTimer); countdownTimer = 0;
        if (previous) previous.candidate = '';
        if (initialized) { node('login-captcha').value = ''; node('login-retry').hidden = true; }
        if (clearReturn) {
            browser.musicBrowserState.authReturnHash = '';
            browser.musicBrowserState.authReturnContext = null;
            if (initialized) node('netease-login-btn').hidden = false;
        }
    }

    function begin(mode, clearCaptcha = true) {
        const captcha = clearCaptcha ? '' : captchaValue();
        cancel(false);
        node('login-captcha').value = captcha;
        session = {
            mode, controller: new AbortController(), timer: 0, returnTimer: 0, busy: '', completed: false, candidate: '',
            navToken: browser.musicBrowserState.navToken, hash: environment.location.hash,
            authSnapshot: captureAuthSnapshot(),
            returnHash: browser.musicBrowserState.authReturnContext?.hash || environment.location.hash,
            returnScroll: browser.musicBrowserState.authReturnContext?.scrollTop || 0
        };
        lastMode = mode;
        for (const name of ['qr', 'sms']) {
            node(`login-mode-${name}`).setAttribute('aria-pressed', String(mode === name));
            node(`login-${name}-view`).hidden = mode !== name;
        }
        status(); render();
        return session;
    }

    // Each request has its own deadline; abort also settles mocks/transports that ignore signals.
    async function request(value, path, data) {
        const controller = new AbortController();
        let timer, abort, httpError;
        const stopped = new Promise((_, reject) => {
            abort = () => { controller.abort(); reject(new DOMException('Cancelled', 'AbortError')); };
            value.controller.signal.addEventListener('abort', abort, { once: true });
            if (value.controller.signal.aborted) abort();
            timer = environment.setTimeout(() => {
                controller.abort();
                reject(httpError || Object.assign(new Error('请求超时'), { name: 'TimeoutError' }));
            }, LOGIN_TIMEOUT_MS);
        });
        try {
            const separator = path.includes('?') ? '&' : '?';
            const url = api.buildApiUrl(`${path}${separator}timestamp=${now()}&loginNonce=${++requestId}`);
            return await Promise.race([stopped, (async () => {
                const response = await environment.fetch(url, {
                    method: data ? 'POST' : 'GET', cache: 'no-store', credentials: 'omit', signal: controller.signal,
                    ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {})
                });
                const retry = response.headers?.get('Retry-After')?.trim() || '';
                const retryAt = /^\d+$/.test(retry) ? now() + Number(retry) * 1000 : Date.parse(retry);
                if (!response.ok) httpError = Object.assign(new Error('请求失败'), { status: response.status, retryAt });
                let json;
                try { json = await response.json(); }
                catch (error) { if (response.ok) throw error; }
                if (!response.ok) {
                    throw Object.assign(httpError, { response: json });
                }
                return json;
            })()]);
        } finally {
            environment.clearTimeout(timer);
            value.controller.signal.removeEventListener('abort', abort);
        }
    }

    async function confirmLogin(value) {
        if (!current(value) || value.busy === 'checking' || !value.candidate) return;
        value.busy = 'checking'; status('正在确认账号…'); render();
        try {
            const json = await request(value, '/login/status', { cookie: value.candidate });
            if (!current(value)) return;
            const profile = json.data?.profile;
            if (!Number.isSafeInteger(Number(profile?.userId)) || Number(profile.userId) <= 0) {
                const code = Number(json.data?.code ?? json.code);
                if (![200, 301, 401].includes(code)) throw new Error('账号状态暂不可用');
                value.candidate = '';
                status('登录凭据已失效，请重新登录', 'error'); return;
            }
            const snapshot = commitLogin(value.candidate, profile, () => current(value));
            if (!snapshot) return;
            value.authSnapshot = snapshot;
            if (!current(value)) return;
            value.candidate = ''; value.completed = true;
            node('login-captcha').value = '';
            status('登录成功', 'success');
            value.returnTimer = environment.setTimeout(() => {
                if (!current(value)) return;
                const parsed = parseMusicRoute(value.returnHash);
                const route = parsed && parsed.kind !== 'invalid' ? parsed : { kind: 'search', q: '', type: 'all', page: 1 };
                browser.musicBrowserState.authReturnHash = '';
                browser.navigateMusic(route, { replace: true, restoreScroll: route === parsed ? value.returnScroll : 0 });
            }, 600);
        } catch (error) {
            if (!current(value)) return;
            if (error.status === 401 || Number(error.response?.code) === 301) {
                value.candidate = '';
                status('登录凭据已失效，请重新登录', 'error');
            } else status('账号校验暂时失败，可重试校验，无需重新获取验证码', 'error');
        } finally {
            if (current(value)) { value.busy = ''; render(); }
        }
    }

    async function generateQRCode() {
        if (!session || session.mode !== 'qr' || !current(session) || session.completed) return;
        const value = begin('qr'), image = node('qrcode-img-wrap');
        value.busy = 'qr'; image.innerHTML = '<div class="netease-loading">生成二维码中…</div>';
        status('正在生成二维码…'); render();
        try {
            const key = await request(value, '/login/qr/key');
            if (!current(value)) return;
            if (!key.data?.unikey) throw new Error('缺少二维码 key');
            const qrKey = encodeURIComponent(key.data.unikey);
            const result = await request(value, `/login/qr/create?key=${qrKey}&qrimg=true`);
            if (!current(value)) return;
            if (!result.data?.qrimg) throw new Error('缺少二维码图片');
            image.innerHTML = `<img src="${escapeHtml(toHttps(result.data.qrimg))}" alt="网易云登录二维码">`;
            value.busy = ''; status('等待扫描…'); render();
            const poll = async () => {
                if (!current(value) || value.completed || value.candidate) return;
                try {
                    const json = await request(value, `/login/qr/check?key=${qrKey}&noCookie=true`);
                    if (!current(value)) return;
                    if (json.code === 800) { status('二维码已过期，请刷新', 'error'); return; }
                    if (json.code === 801) status('等待扫描…');
                    else if (json.code === 802) status('已扫描，请在手机上确认登录');
                    else if (json.code === 803) {
                        value.candidate = typeof json.cookie === 'string' ? cleanCookie(json.cookie) : '';
                        if (!value.candidate) { status('未收到登录凭据，请刷新二维码', 'error'); return; }
                        await confirmLogin(value); return;
                    } else status('扫码状态异常，请刷新二维码', 'error');
                } catch (_) { if (current(value)) status('网络异常，正在重试…', 'error'); }
                if (current(value) && !value.completed) value.timer = environment.setTimeout(poll, 2000);
            };
            value.timer = environment.setTimeout(poll, 2000);
        } catch (_) {
            if (!current(value)) return;
            value.busy = ''; image.innerHTML = '';
            status('二维码生成失败，请刷新重试', 'error'); render();
        }
    }

    function selectMode(mode) {
        if (!session || !current(session) || session.completed || !['qr', 'sms'].includes(mode)) return;
        if (session.mode === mode) return;
        begin(mode);
        if (mode === 'qr') void generateQRCode();
    }

    async function sendCode() {
        const value = session, phone = phoneValue();
        if (!value || value.mode !== 'sms' || !current(value) || value.busy || value.completed || value.candidate || !phone || remaining(phone)) return;
        for (const [key, deadline] of cooldowns) if (deadline <= now()) cooldowns.delete(key);
        if (cooldowns.size >= 64) cooldowns.delete(cooldowns.keys().next().value);
        cooldowns.set(phone.key, now() + SMS_RESEND_MS);
        value.busy = 'sending'; status('正在发送验证码…'); render();
        try {
            const json = await request(value, '/captcha/sent/v1', { phone: phone.phone, ctcode: phone.countrycode });
            if (!current(value)) return;
            if (json.code !== 200) { status(errorMessage(json, '验证码发送失败'), 'error'); return; }
            status('验证码已发送，请查收短信', 'success');
        } catch (error) {
            if (!current(value)) return;
            if (Number.isFinite(error.retryAt)) cooldowns.set(phone.key, Math.max(cooldowns.get(phone.key) || 0, error.retryAt));
            status(error.status === 429 ? '操作过于频繁，请稍后再试'
                : error.response ? errorMessage(error.response, '验证码发送失败')
                : '发送结果未确认，可能已发送，请检查短信；收到后可直接登录', 'error');
        } finally {
            if (current(value)) { value.busy = ''; render(); }
        }
    }

    async function submit(event) {
        event?.preventDefault();
        const value = session, phone = phoneValue(), captcha = captchaValue();
        if (!value || value.mode !== 'sms' || !current(value) || value.busy || value.completed || value.candidate || !phone || !/^\d{4,8}$/.test(captcha)) return;
        value.busy = 'login'; status('正在登录…'); render();
        try {
            const json = await request(value, '/login/cellphone', { phone: phone.phone, countrycode: phone.countrycode, captcha });
            if (!current(value)) return;
            if (json.code !== 200) { status(errorMessage(json, '登录失败，请稍后重试'), 'error'); return; }
            value.candidate = typeof json.cookie === 'string' ? cleanCookie(json.cookie) : '';
            if (!value.candidate) { status('未收到登录凭据，请重试登录', 'error'); return; }
            await confirmLogin(value);
        } catch (error) {
            if (!current(value)) return;
            status(errorMessage(error.response, '登录请求失败，请重试，无需重新获取验证码'), 'error');
        } finally {
            if (current(value)) { value.busy = ''; render(); }
        }
    }

    function open() {
        if (!browser.musicBrowserState.authReturnHash && environment.location.hash.startsWith(MUSIC_ROUTE_PREFIX)) browser.musicBrowserState.authReturnHash = environment.location.hash;
        if (!browser.musicBrowserState.authReturnContext) {
            const hash = browser.musicBrowserState.authReturnHash || environment.location.hash;
            browser.musicBrowserState.authReturnContext = {
                hash, scrollTop: hash === environment.location.hash ? Math.max(0, dom.neteaseBrowserScroll.scrollTop || 0) : 0
            };
            browser.saveMusicScrollState();
        }
        doc.querySelectorAll('.netease-tab').forEach(tab => { tab.classList.remove('active'); tab.setAttribute('aria-selected', 'false'); });
        doc.querySelectorAll('.netease-tab-content').forEach(view => { view.style.display = 'none'; });
        node('tab-qrlogin').style.display = 'block';
        node('netease-login-btn').hidden = true;
        dom.neteasePageTitle.textContent = '登录网易云';
        const mode = lastMode || (environment.matchMedia('(max-width: 900px)').matches ? 'sms' : 'qr');
        begin(mode);
        node(`login-mode-${mode}`).focus({ preventScroll: true });
        if (mode === 'qr') return generateQRCode();
    }

    return {
        open, cancel, refreshQRCode: generateQRCode,
        initialize() {
            if (initialized) return;
            initialized = true;
            node('login-mode-qr').onclick = () => selectMode('qr');
            node('login-mode-sms').onclick = () => selectMode('sms');
            node('login-send-code').onclick = sendCode;
            node('sms-login-form').onsubmit = submit;
            node('login-retry').onclick = () => session && confirmLogin(session);
            for (const id of ['login-country', 'login-phone']) node(id).oninput = () => {
                if (!session || session.mode !== 'sms' || !current(session) || session.completed) return;
                begin('sms');
            };
            node('login-captcha').oninput = () => { if (session && current(session)) render(); };
        }
    };
}
