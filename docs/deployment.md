# 部署指南

[项目首页](../README.md) · [使用指南](usage.md) · [源码结构与发布](architecture.md)

## 单文件与源码

发布产物是一个 `index.html`，脚本、样式、Worker 以及 `jsmediatags`、`color-thief` 的固定源码和许可证均已内嵌，不需要额外上传资源目录。

从 [Releases](https://github.com/minori0721/Aurora-player/releases) 下载该文件即可直接打开，或上传到静态主机。本地播放不依赖在线 API；网易云功能和下载代理分别依赖后端服务。

从源码构建时，使用 Node.js 22 或 24：

```sh
npm ci
npm run build
```

输出为 `dist/index.html`，不再维护仓库根目录的播放器 HTML。`dist/` 不提交到 Git，日常修改 `src/`，不要手工编辑构建产物。

## 本地开发

```sh
npm run dev
```

开发服务只监听 `127.0.0.1`，默认端口 8765；占用时使用后续可用端口，以命令输出为准。源码修改后自动重新构建，刷新浏览器查看；修改构建脚本或环境变量后需重启开发服务。按 Ctrl+C 关闭。

也可以先构建，再直接打开 `dist/index.html`。更换端口、域名或本地文件路径后，浏览器的账号、列表与偏好记录可能不同，不是构建过程清除了数据。

## 从 GitHub 托管前端

平台连接包含当前源码的分支，根目录保持仓库根目录，不要选择 `src/` 或 `dist/`。

| 平台 | 首次配置 |
| --- | --- |
| Cloudflare Workers | 构建命令 `npm run build`，部署命令 `npx wrangler deploy`，名称与 `wrangler.json` 一致 |
| Cloudflare Pages | 框架 `None`，构建命令 `npm run build`，输出目录 `dist` |
| Vercel | 框架 `Other`，安装、构建及输出目录使用仓库 `vercel.json`，无需重复覆盖 |
| GitHub Pages | 发布来源选 `GitHub Actions`，使用仓库已有 `pages.yml` |

这些平台只发布静态产物，不需要为播放器维持一个 Node.js 服务。Hash 路由使用 `#music/...`，不依赖服务器把任意路径重写到首页，也支持 GitHub Pages 仓库子路径。

### Cloudflare Workers 与 Pages

Workers 使用 [wrangler.json](../wrangler.json) 的 `assets.directory` 发布 `dist/`，不需要编写后端 Worker 或添加 ASSETS 绑定。当前名称为 `aurora-player`；使用其他平台项目名时同步修改配置。

Wrangler 本地部署会先运行配置中的构建命令，但 Workers Builds 不执行这项自定义构建配置，因此面板的构建命令不能留空。公开 API 地址应放在构建变量中，仅修改运行时 Variables / Secrets 不会改变静态页面。参见 [Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。

已有 Pages 项目可继续使用上表配置，无需为了源码拆分迁移到 Workers。仓库 `.node-version` 指定 Node.js 22；已有项目若手动设置了版本，需检查没有被旧配置覆盖。

### Vercel

[vercel.json](../vercel.json) 已设置安装命令 `npm ci`、构建命令 `npm run build`、输出目录 `dist`。项目选 `Other`，避免平台框架预设覆盖静态构建。Node.js 使用仓库允许的版本；其他设置以当前项目面板和 [Vercel 配置说明](https://vercel.com/docs/project-configuration/vercel-json) 为准。

构建变量可按 Production、Preview 等环境分别配置；修改后重新部署，不会自动改写已经生成的 HTML。

### GitHub Pages

1. 仓库进入 `Settings → Pages → Build and deployment`。
2. 将 `Source` 设置为 `GitHub Actions`，不要再添加一份模板工作流。
3. 按需要配置下面的公开地址变量，然后推送部署分支或手动运行 `GitHub Pages` 工作流。

[pages.yml](../.github/workflows/pages.yml) 当前仅从 `minori0721-test-1` 部署，手动运行也检查该分支。构建经过检查、测试和打包后，只上传 `dist/`，不发布源码和 `node_modules/`。

换用其他分支时，同步修改工作流的 `push.branches`、`jobs.build.if`；若 `github-pages` 环境限制了分支，也需允许该分支。工作流不会自动修改仓库的 Pages 发布来源。仍从分支根目录发布的旧配置，不能生成拆分源码后的播放器。

## API 与下载代理地址

构建只读取两个公开环境变量：

| 名称 | 用途 |
| --- | --- |
| `API_BASE_URL` | 兼容网易云 API 的 HTTPS 服务地址 |
| `DOWNLOAD_PROXY_URL` | 下载代理 Worker 或反代地址 |

在 Cloudflare 填构建变量，在 Vercel 填对应环境的变量；GitHub Pages 和自动 Release 使用仓库 `Settings → Secrets and variables → Actions → Variables` 中的同名变量。

这些是构建期配置，修改后必须重新构建或部署。浏览器不能直接读取平台运行时环境变量，两个地址都会写入公开 HTML，不要填入 Cookie、Token 或密钥。构建脚本不会将其他环境变量注入页面。

未设置时使用 [scripts/config.mjs](../scripts/config.mjs) 的默认地址。可以修改默认值后构建，也可以修改下载后的单文件中以下头部配置：

```html
<script>
    window.API_BASE_URL = 'https://api.example.com';
    window.DOWNLOAD_PROXY_URL = 'https://download.example.com';
</script>
```

服务地址不应包含用户名、密码、查询参数或片段。构建器会验证 URL，只接受 HTTP(S)；公开部署建议使用 HTTPS。

## 部署后端 API

播放器使用兼容 [NeteaseCloudMusicApiEnhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced/) 的接口，本项目使用的 Fork 是 [minori0721/api-enhanced](https://github.com/minori0721/api-enhanced)。API 后端与静态播放器是独立项目，部署前端不等于已经部署后端。

推荐使用 Vercel 配合自定义域名：

1. 在 Vercel 导入自己的 `api-enhanced` 仓库，按该项目的配置部署。
2. 在 `Settings → Domains` 绑定域名或子域名，并按平台提示配置 DNS。
3. 将播放器的 `API_BASE_URL` 设置为该 HTTPS 地址，重新构建前端。

面向中国大陆使用时，不建议依赖默认 `*.vercel.app` 域名；Vercel 官方说明这些域名可能被屏蔽或限速，而自定义域名也仍可能受到网络与域名访问限制。应按目标地区、运营商及具体接口验证可达性，不把换域名视为稳定性的保证。参见 [Vercel 中国大陆访问说明](https://vercel.com/kb/guide/accessing-vercel-hosted-sites-from-mainland-china)。

下载代理需另外部署为可处理跨域与 Referer 的 Worker 或反代，再配置 `DOWNLOAD_PROXY_URL`。代理地址可访问并不代表每条音源都能下载；API、音频 CDN 和下载代理应分别验证。

## 自动部署与 Release

Cloudflare 和 Vercel 原生 Git 部署跟随平台选定分支，GitHub Pages 跟随仓库工作流；它们不是跟随 Release 附件部署。构建变量不同时，即使同一源码版本，HTML 内的 API 地址也可能不同。

Release 由 `Check` 工作流检查成功后按 `package.json` 和 changelog 决定是否创建。同版本已经公开发布时跳过，不覆盖旧附件；升级版本仍由维护者决定，不会每次提交自动加版本。

版本准备、受检提交、标签与失败恢复规则见 [源码结构与发布](architecture.md)。本仓库不会自动创建或修改你的 Cloudflare、Vercel 项目。
