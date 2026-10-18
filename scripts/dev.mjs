import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, buildHtml } from './build.mjs';

export async function startDevServer({ port = 8765, watch = true } = {}) {
    let current, error, requested = 0, finished = 0, pending = null, timer;
    const rebuild = () => {
        requested++;
        if (!pending) pending = (async () => {
            while (finished < requested) {
                const revision = requested;
                try { current = await buildHtml({ minify: false }); error = null; }
                catch (failure) { error = failure; console.error(failure.message); }
                finished = revision;
            }
        })().finally(() => { pending = null; });
        return pending;
    };
    await rebuild();
    if (error) throw error;
    const server = http.createServer(async (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { Allow: 'GET, HEAD' }).end();
            return;
        }
        if (!['/', '/index.html'].includes(new URL(request.url, 'http://localhost').pathname)) {
            response.writeHead(404).end();
            return;
        }
        if (pending) await pending;
        const body = error ? error.message : current.html;
        response.writeHead(error ? 500 : 200, { 'Content-Type': error ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : body);
    });
    for (let attempts = 0; ; attempts++, port++) {
        try {
            await new Promise((resolve, reject) => {
                const fail = failure => { server.off('listening', ready); reject(failure); };
                const ready = () => { server.off('error', fail); resolve(); };
                server.once('error', fail);
                server.once('listening', ready);
                server.listen(port, '127.0.0.1');
            });
            break;
        } catch (failure) {
            if (failure.code !== 'EADDRINUSE' || attempts >= 20) throw failure;
        }
    }
    const watchers = watch ? [
        fs.watch(path.join(ROOT, 'src'), { recursive: true }, changed),
        fs.watch(path.join(ROOT, 'package.json'), changed)
    ] : [];
    function changed() { clearTimeout(timer); timer = setTimeout(() => void rebuild(), 150); }
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        async close() {
            clearTimeout(timer);
            watchers.forEach(watcher => watcher.close());
            await new Promise(resolve => server.close(resolve));
            if (pending) await pending;
        }
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const server = await startDevServer();
    console.log(`Aurora dev: ${server.url} (refresh after editing src/)`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close().then(() => process.exit(0)));
}
