import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';
import { inlineScript, readPublicConfig } from './config.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = async file => (await fs.readFile(path.join(ROOT, file), 'utf8')).replace(/\r\n/g, '\n');

export async function buildHtml({ env = process.env, minify = true } = {}) {
    const pkg = JSON.parse(await read('package.json'));
    const config = readPublicConfig(env);
    const common = { absWorkingDir: ROOT, bundle: true, write: false, minify, target: ['es2020'], legalComments: 'inline', charset: 'utf8', logLevel: 'silent' };
    const worker = await bundle({ ...common, entryPoints: ['src/analysis/worker.js'], format: 'iife', platform: 'browser' });
    const app = await bundle({
        ...common,
        entryPoints: ['src/app.js'],
        format: 'iife',
        platform: 'browser',
        plugins: [{
            name: 'inline-loop-worker',
            setup(build) {
                build.onResolve({ filter: /^aurora:loop-worker$/ }, () => ({ path: 'loop-worker', namespace: 'aurora' }));
                build.onLoad({ filter: /.*/, namespace: 'aurora' }, () => ({
                    contents: `export const LOOP_WORKER_SOURCE = ${JSON.stringify(worker.outputFiles[0].text)};`,
                    loader: 'js'
                }));
            }
        }]
    });
    const css = await bundle({ ...common, entryPoints: ['src/styles/index.css'], loader: { '.css': 'css' } });
    const vendors = ['src/vendor/jsmediatags.js', 'src/vendor/color-thief.js'];
    const vendorTags = [];
    for (const vendor of vendors) vendorTags.push(`<script data-vendor="${path.basename(vendor, '.js')}">\n${inlineScript(await read(vendor))}</script>`);
    const replacements = {
        license: `<!-- Aurora Player v${pkg.version}\n${await read('LICENSE')}\n-->`,
        vendors: vendorTags.join('\n'),
        config: `<script data-aurora="config">${inlineScript(Object.entries(config).map(([key, value]) => `window.${key}=${JSON.stringify(value)};`).join(''))}</script>`,
        preferences: `<script data-aurora="preferences">\n${inlineScript(await read('src/ui/preferences.js'))}\n</script>`,
        styles: `<style>\n${css.outputFiles[0].text}\n</style>`,
        app: `<script data-aurora="app">\n${inlineScript(app.outputFiles[0].text)}\n</script>`
    };
    let html = await read('src/index.html');
    for (const [key, value] of Object.entries(replacements)) {
        const marker = `<!-- aurora:${key} -->`;
        if (html.split(marker).length !== 2) throw new Error(`Expected one ${key} marker`);
        html = html.replace(marker, () => value);
    }
    html = html.replaceAll('{{VERSION}}', pkg.version);
    if (/<!-- aurora:|\{\{VERSION\}\}/.test(html)) throw new Error('Unresolved template marker');
    return { html, workerSource: worker.outputFiles[0].text, appSource: app.outputFiles[0].text, version: pkg.version, config };
}

export async function build({ outdir = 'dist', ...options } = {}) {
    const result = await buildHtml(options);
    const output = path.resolve(ROOT, outdir);
    await fs.mkdir(output, { recursive: true });
    const temporary = path.join(output, `.index-${process.pid}.tmp`);
    try {
        await fs.writeFile(temporary, result.html);
        await fs.rename(temporary, path.join(output, 'index.html'));
    } finally {
        await fs.rm(temporary, { force: true });
    }
    return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = await build();
    console.log(`Built dist/index.html (${Buffer.byteLength(result.html)} bytes), v${result.version}`);
}
