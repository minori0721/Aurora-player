import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { analyze } from 'eslint-scope';
import { ROOT, buildHtml } from './build.mjs';

const globals = new Set(`window document navigator localStorage sessionStorage indexedDB history location console performance
    AudioContext ColorThief jsmediatags Image File FileReader Blob Worker URL URLSearchParams ResizeObserver
    IntersectionObserver HTMLElement Element Event MediaMetadata AbortController AbortSignal DOMException TextDecoder
    ReadableStream Response Request Headers
    Uint8Array Uint16Array Uint32Array Int16Array Float32Array Float64Array ArrayBuffer DataView WeakMap WeakSet Map Set
    Object Reflect Array String Number Boolean Math Date Promise Error TypeError RangeError JSON RegExp Symbol Infinity
    NaN undefined globalThis fetch alert confirm matchMedia setTimeout clearTimeout setInterval clearInterval requestAnimationFrame
    cancelAnimationFrame encodeURIComponent decodeURIComponent btoa atob parseFloat parseInt isNaN self`.split(/\s+/));

export async function sourceFiles(directory = path.join(ROOT, 'src')) {
    const result = [];
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, item.name);
        if (item.isDirectory()) result.push(...await sourceFiles(file));
        else if (/\.m?js$/.test(item.name)) result.push(file);
    }
    return result;
}

export async function checkSource() {
    const graph = new Map();
    const contracts = new Map(), consumers = [];
    const files = await sourceFiles();
    for (const file of files) {
        const code = await fs.readFile(file, 'utf8');
        const classicVendor = file.includes(`${path.sep}vendor${path.sep}`) && file.endsWith('.js');
        if (classicVendor || file.endsWith(`${path.sep}preferences.js`)) {
            new vm.Script(code, { filename: file });
            continue;
        }
        const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module', ranges: true, locations: true });
        const scope = analyze(ast, { ecmaVersion: 2024, sourceType: 'module', optimistic: true });
        const unresolved = scope.globalScope.through.filter(ref => !globals.has(ref.identifier.name));
        if (unresolved.length) throw new Error(`${path.relative(ROOT, file)}: unresolved ${unresolved.map(ref => `${ref.identifier.name}:${ref.identifier.loc.start.line}`).join(', ')}`);
        const imports = ast.body.filter(node => node.type === 'ImportDeclaration').map(node => node.source.value);
        if (imports.some(name => !name.startsWith('.') && !['aurora:loop-worker', 'aurora:background-worker'].includes(name))) throw new Error(`Unexpected runtime dependency in ${file}`);
        graph.set(file, imports.filter(name => name.startsWith('.')).map(name => path.resolve(path.dirname(file), name)));
        for (const statement of ast.body) {
            const factory = statement.type === 'ExportNamedDeclaration' ? statement.declaration : null;
            const parameters = factory?.params?.[0]?.left;
            if (factory?.type !== 'FunctionDeclaration' || parameters?.type !== 'ObjectPattern') continue;
            const returned = factory.body.body.findLast(node => node.type === 'ReturnStatement')?.argument;
            if (returned?.type !== 'ObjectExpression') continue;
            const name = factory.id.name.replace(/^create/, '');
            const key = name[0].toLowerCase() + name.slice(1);
            contracts.set(key, new Set(returned.properties.map(property => property.key.name)));
            const aliases = new Map(parameters.properties.map(property => [property.value.name, property.key.name]));
            const walk = node => {
                if (!node || typeof node !== 'object') return;
                if (node.type === 'MemberExpression' && !node.computed && aliases.has(node.object.name)) consumers.push([file, aliases.get(node.object.name), node.property.name]);
                for (const value of Object.values(node)) {
                    if (Array.isArray(value)) value.forEach(walk);
                    else if (value && typeof value === 'object') walk(value);
                }
            };
            walk(factory.body);
        }
    }
    const active = new Set(), visited = new Set();
    const visit = file => {
        if (active.has(file)) throw new Error(`Circular module import: ${path.relative(ROOT, file)}`);
        if (visited.has(file)) return;
        if (!graph.has(file)) throw new Error(`Missing module: ${file}`);
        active.add(file);
        for (const dependency of graph.get(file)) visit(dependency);
        active.delete(file);
        visited.add(file);
    };
    for (const file of graph.keys()) visit(file);
    for (const [file, service, member] of consumers) {
        if (!contracts.get(service)?.has(member)) throw new Error(`${path.relative(ROOT, file)}: unknown service interface ${service}.${member}`);
    }
    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(await fs.readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
    if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) throw new Error('package.json and package-lock.json versions differ');
    return files.length;
}

export function checkHtml(html, version) {
    if (/<script\b[^>]*\bsrc\s*=/i.test(html) || /<link\b[^>]*\brel=["']stylesheet/i.test(html)) throw new Error('External script or stylesheet in standalone HTML');
    if (/\sonclick\s*=["']/i.test(html)) throw new Error('Inline click handler remains');
    if (/<style\b[^>]*>[\s\S]*?@import\s+(?:url\()?\s*["']?https?:/i.test(html)) throw new Error('External CSS import in standalone HTML');
    if (!html.includes(`>v${version}</`)) throw new Error('Footer version differs from package.json');
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    if (scripts.length !== 5) throw new Error(`Expected 5 inline scripts, found ${scripts.length}`);
    scripts.forEach((script, index) => new vm.Script(script[1], { filename: `dist/index.html:script-${index}` }));
    return scripts.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const count = await checkSource();
    const result = await buildHtml();
    const scripts = checkHtml(result.html, result.version);
    console.log(`Checked ${count} source files, acyclic module imports, ${scripts} inline scripts and standalone output`);
}
