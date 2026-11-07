export function isDuplicateSongError(error) {
    return /重复|已存在|已在歌单|already\s+(?:exists?|in|added|collected)|duplicate|\brepeat(?:ed)?\b/i.test(error?.message || '');
}

export function classifySongActionError(error, { checking = false, loading = false } = {}) {
    const result = (kind, message, retry = null) => ({ kind, message, retry, error: kind !== 'cancelled' });
    const message = error?.message || '';
    if (error?.name === 'AbortError') return result('cancelled', '');
    if (error?.apiCode === 301 || error?.status === 401 || /未登录|登录失效|重新登录|login required/i.test(message)) {
        return result('auth', '登录已失效，请重新登录。', 'login');
    }
    if (error?.status === 429 || error?.apiCode === 429 || /频繁|频率|too many|rate.?limit/i.test(message)) {
        return result('rate-limited', '操作过于频繁，请稍后再试。');
    }
    if (/验证码|安全验证|风控|captcha|verification required/i.test(message)) return result('verification', '需要安全验证，请先在网易云完成验证。');
    if (/无权|没有权限|不可编辑|无操作权限|permission|not writable|forbidden/i.test(message)) return result('forbidden', '没有权限向这个歌单添加歌曲。');
    if (/歌单.*(?:已满|上限)|playlist.*(?:full|limit)/i.test(message)) return result('full', '歌单已满，请选择其他歌单。');
    if (/歌曲.*不存在|资源不存在|版权|不可收藏|song.*(?:not found|unavailable)|copyright/i.test(message)) return result('unavailable', '这首歌曲暂时无法收藏。');
    if (/参数|歌单不存在|invalid (?:id|param)|playlist.*not found/i.test(message)) return result('invalid', '歌曲或歌单信息无效，请重新选择。');
    if ([404, 405].includes(error?.status)) return result('unsupported', '当前服务不支持这项收藏操作。');
    if (loading) return result('load-failed', '歌单加载失败，请稍后重试。', 'retry');
    if (checking || error?.uncertain || error?.name === 'TimeoutError' || error?.name === 'TypeError'
        || error?.kind === 'membership-unconfirmed' || isDuplicateSongError(error)
        || error?.status >= 500 || error?.apiCode >= 500) {
        return result('unconfirmed', checking ? '暂时无法确认收藏状态，请稍后检查。' : '收藏结果暂未确认，可以检查歌单状态。', 'check');
    }
    return result('failed', '收藏失败，请稍后重试。', 'retry');
}
