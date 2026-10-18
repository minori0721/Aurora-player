# 源码结构

Aurora 采用原生 JavaScript 模块开发，由 esbuild 合并代码，再将样式、配置、固定版本第三方库和 Worker 源码内嵌进 `dist/index.html`。开发源码是唯一维护入口；`dist/` 为可重复生成的产物，不提交到 Git。

## 修改入口

| 目录 / 文件 | 职责 |
| --- | --- |
| `src/app.js` | 组装模块、连接接口、安排初始化顺序 |
| `src/index.html` | 页面结构与动作标记，不包含业务实现 |
| `src/audio/playback.js` | AudioContext、音频节点、加载令牌、播放/暂停与循环播放 |
| `src/audio/local.js`、`online.js` | 本地/在线音频加载，复用统一播放核心 |
| `src/audio/prefetch.js`、`transfer.js` | 下一首任务、大小预算、超时和音频传输 |
| `src/audio/loop.js`、`quality.js`、`metadata.js` | 循环设定、音频格式信息和标签应用 |
| `src/playlist/` | 播放队列、目录导入、伴随文件配对、播放列表显示 |
| `src/lyrics/` | LRC/YRC/JSON 解析、来源优先级、在线匹配和歌词显示 |
| `src/netease/` | API、登录、内容浏览、路由、歌单分页、下载 |
| `src/analysis/algorithms.js` | 三档循环匹配算法，不依赖页面或播放控制器 |
| `src/analysis/worker.js`、`controller.js` | Worker 消息处理、任务生命周期、分析面板 |
| `src/storage/` | 请求缓存、IndexedDB、播放列表持久化与数据迁移 |
| `src/ui/`、`src/styles/` | 页面元素、弹层、控件、封面、渲染调度与样式 |
| `src/vendor/` | 现有库的固定源码与原许可证，不在构建时下载 CDN 版本 |
| `scripts/`、`tests/` | 构建、配置注入、检查、开发服务、发布及测试 |

## 状态与依赖

有状态模块通过 `createXxx()` 创建独立闭包，内部状态不再挂在 `window`。模块声明自己需要的接口，跨模块操作使用 `playbackService.startAudio()` 等具名调用；必要的共享状态通过显式 getter/setter 保持实时引用，而不是复制容易过期的快照。

`src/shared/ports.js` 先创建稳定的接口句柄，再安装各模块，最后冻结接口结构。全部模块连接完成后才执行事件绑定与启动任务，避免循环导入和初始化期间访问未就绪模块。保留访问器是为了维持现有加载、切歌和队列语义；新增功能优先通过所属模块的方法修改状态，不扩展零散全局变量。

纯解析、规范化、路由和匹配算法直接使用命名导入/导出，不依赖接口容器。UI 调用业务模块；不要把网络请求、算法公式或缓存迁移重新塞进页面模板。HTML 的 `data-action` 由一个委托事件处理器绑定，不依赖全局函数名。

`initialize()` 用于事件绑定和启动副作用，并防止重复执行。异步操作仍必须检查曲目身份、播放令牌、账号代数或导航令牌；分模块不替代这些竞态保护。

## 单文件构建

`scripts/build.mjs` 先独立打包 Worker，再通过虚拟模块 `aurora:loop-worker` 将其作为字符串注入主程序。运行时通过 Blob 创建 Worker，不请求旁边的脚本；主线程回退也导入同一份算法。不要恢复 `Function.toString()` 拼接，也不要添加需要额外 chunk 的运行时动态导入。

样式按原有顺序合并，第三方库作为独立内联脚本保留原有全局加载行为和许可证，最后内联主程序。构建只读取 `API_BASE_URL`、`DOWNLOAD_PROXY_URL` 两个公开地址；环境变量的其他值不会注入 HTML。版本号来自 `package.json`，模板中的 `{{VERSION}}` 不手动替换。

## 检查与发布

运行 `npm run check`、`npm test`、`npm run build`。静态检查验证未解析变量、模块导入环、外部脚本/样式、残留内联动作及版本占位符；测试分别覆盖纯函数、模拟播放状态、Worker 协议与构建产物。模拟音频和页面宿主测试不能替代实际设备的声音、布局及浏览器权限验收。

`check.yml` 在 Windows、Linux 上检查、测试和构建；矩阵全部成功后，发布分支的推送、手动运行和版本标签事件才可调用可复用的 `release.yml`。PR 和其他分支没有发布权限。发布任务固定检出 `github.sha`，读取 package.json 的版本号；同版本已发布时跳过，否则验证 changelog 和单文件产物，通过 GitHub API 创建精确指向受检提交的标签，并在同一任务内创建草稿、上传、核对附件大小及标签归属后发布，不依赖标签事件二次触发工作流。

发布任务全局串行执行。已有轻量或附注标签必须解析到当前受检提交，草稿也只能从相同提交恢复，禁止移动标签或覆盖已发布版本；网络或权限错误不能当作不存在。版本号不自动递增，重试入口为 Actions 的失败任务或发布分支上的 `Check` 手动运行。写权限仅授予发布调用与发布任务，构建和 PR 保持只读。

`.github/workflows/pages.yml` 只部署 `minori0721-test-1` 分支，手动触发也检查相同分支。构建任务通过检查、测试和构建后上传 `dist/`；部署任务依赖构建成功，使用 `github-pages` 环境和官方 Pages Actions，不向源码分支写回产物。只有部署任务持有 `pages: write` 和 `id-token: write`，并发部署串行执行，不主动取消正在进行的发布。两个公开地址从仓库 Actions Variables 传入构建，未设置时回退默认值。Pages 发布来源需要首次手动切换为 `GitHub Actions`，工作流不会自动启用或修改项目配置。

Cloudflare Workers、Pages 与 Vercel 均运行同一个构建入口、只发布 `dist/`。Workers 使用 `wrangler.json` 的静态资源目录，不添加后端脚本或 ASSETS 绑定；Hash 路由不需要未知路径回退首页。Wrangler 本地部署前自动构建，Workers Builds 则需要在面板首次设置 `npm run build`，部署命令保持 `npx wrangler deploy`。公开 API 地址必须设置为构建变量，而不是 Worker 运行时绑定。Vercel 从 `vercel.json` 读取构建设置；Pages 的构建命令和输出目录在平台填写。API 后端和下载代理仍是独立项目，不属于这次源码拆分。
