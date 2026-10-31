export function createApi({} = {}) {
    // 网易云音乐API服务（使用全局可修改的 API 地址）
    const NETEASE_API_HOST = (window.API_BASE_URL ).replace(/\/$/, '');

    // Vercel部署需要添加的参数（绕过IP限制）
    function buildApiUrl(path) {
        const separator = path.includes('?') ? '&' : '?';
        return path.includes('randomCNIP=') ? `${NETEASE_API_HOST}${path}` : `${NETEASE_API_HOST}${path}${separator}randomCNIP=true`;
    }

    return {
        buildApiUrl
    };
}
