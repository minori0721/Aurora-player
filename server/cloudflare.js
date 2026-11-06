import { proxyDownload } from './download-proxy.js';

export default {
    fetch(request, env) {
        if (new URL(request.url).pathname === '/proxy-download') return proxyDownload(request);
        return env.ASSETS.fetch(request);
    }
};
