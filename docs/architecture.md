# 源码结构

[项目首页](../README.md) · [使用指南](usage.md) · [部署指南](deployment.md) · [技术说明](technical.md)

Aurora 采用原生 JavaScript 模块开发，由 esbuild 合并代码，再将样式、配置、固定版本第三方库和 Worker 源码内嵌进 `dist/index.html`。开发源码是唯一维护入口；`dist/` 为可重复生成的产物，不提交到 Git。

## 修改入口

| 目录 / 文件 | 职责 |
| --- | --- |
| `src/app.js` | 组装模块、连接接口、安排初始化顺序 |
| `src/index.html` | 页面结构与动作标记，不包含业务实现 |
| `src/audio/playback.js` | 统一播放状态、双引擎切换、完整准备、加载令牌与播放控制 |
| `src/audio/media.js` | 原生流式播放、缓冲查询、无进展检测和实例释放 |
| `src/audio/local.js`、`online.js` | 本地/在线音频加载，复用统一播放核心 |
| `src/audio/prefetch.js`、`transfer.js` | 下一首任务、大小预算、超时和音频传输 |
| `src/audio/loop.js`、`quality.js`、`mp3.js`、`metadata.js` | 循环设定、音频格式信息、MP3 文件头解析和标签应用 |
| `src/playlist/` | 播放队列、目录导入、伴随文件配对、播放列表显示与视口封面调度 |
| `src/playlist/file-picker.js` | Android 标准文件选择、取消保护和兼容入口分流 |
| `src/lyrics/` | LRC/YRC/JSON 解析、来源优先级、在线匹配和歌词显示 |
| `src/lyrics/timeline.js` | 普通与逐字歌词对齐、片段组合及翻译/罗马音附着 |
| `src/netease/` | API、登录、内容浏览、路由、歌单分页、下载 |
| `src/netease/song-details.js` | 歌曲详情前瞻、按 ID 共享请求、优先级提升与账号隔离 |
| `src/netease/images.js` | 云音乐缩略图近屏加载、可见失败重试和迷你封面复用 |
| `src/analysis/algorithms.js` | 三档周期搜索、原采样率精修和联合接缝选点，不依赖页面或播放控制器 |
| `src/analysis/signal.js` | 低通降采样、FFT 相关曲线及多声道频谱特征 |
| `src/analysis/input.js` | A/B 局部声道窗口、原始采样位置映射与 Worker 数据准备 |
| `src/analysis/worker.js`、`controller.js` | Worker 消息处理、任务生命周期、分析面板 |
| `src/storage/` | 请求缓存、IndexedDB、播放列表持久化与数据迁移 |
| `src/ui/`、`src/styles/` | 页面元素、弹层、控件、封面、渲染调度与样式 |
| `src/ui/background-field.js` | 封面空间采样、加权模糊、色调映射与 WebGL 网格 |
| `src/ui/background.js`、`background-thread.js`、`background-worker.js` | 背景绘制调度、主线程桥接、独立 Worker 与静态降级 |
| `src/vendor/` | 现有库的固定源码与原许可证，不在构建时下载 CDN 版本 |
| `scripts/`、`tests/` | 构建、配置注入、检查、开发服务、发布及测试 |

## 状态与依赖

有状态模块通过 `createXxx()` 创建独立闭包，内部状态不再挂在 `window`。模块声明自己需要的接口，跨模块操作使用 `playbackService.startAudio()` 等具名调用；必要的共享状态通过显式 getter/setter 保持实时引用，而不是复制容易过期的快照。

`src/shared/ports.js` 先创建稳定的接口句柄，再安装各模块，最后冻结接口结构。全部模块连接完成后才执行事件绑定与启动任务，避免循环导入和初始化期间访问未就绪模块。保留访问器是为了维持现有加载、切歌和队列语义；新增功能优先通过所属模块的方法修改状态，不扩展零散全局变量。

纯解析、规范化、路由和匹配算法直接使用命名导入/导出，不依赖接口容器。UI 调用业务模块；不要把网络请求、算法公式或缓存迁移重新塞进页面模板。HTML 的 `data-action` 由一个委托事件处理器绑定，不依赖全局函数名。

`initialize()` 用于事件绑定和启动副作用，并防止重复执行。异步操作仍必须检查曲目身份、播放令牌、账号代数或导航令牌；分模块不替代这些竞态保护。

播放控制由 `playback.js` 统一维护；业务模块通过接口查询当前引擎、请求完整准备或跳转，不直接控制原生音频元素。精确功能先共享完整准备任务，再检查曲目和操作版本决定是否应用，不让旧回调恢复已经取消的播放或循环。

## 文档边界

- `README.md`：项目入口、核心功能、快速开始、重要限制和文档导航。
- `docs/usage.md`：面向操作的行为和常见问题，不展开内部调度。
- `docs/deployment.md`：环境、平台与公开地址配置，不维护播放器算法参数。
- `docs/technical.md`：播放、预取、循环、歌词、背景、缓存和隐私机制；具体实现参数集中在此维护。
- 本文：源码职责、模块约束、构建检查和版本发布。
- `changelog.md`：每个版本一个日期，保留历史记录；不替代现行使用说明。

## 单文件构建

`scripts/build.mjs` 先分别打包循环分析和背景 Worker，再通过虚拟模块 `aurora:loop-worker`、`aurora:background-worker` 将其作为字符串注入主程序。运行时通过 Blob 创建 Worker，不请求旁边的脚本；循环分析的主线程回退也导入同一份算法，背景 Worker 或离屏 WebGL 不可用时使用静态渐变。不要恢复 `Function.toString()` 拼接，也不要添加需要额外 chunk 的运行时动态导入。

歌曲详情由 `song-details.js` 按 ID 共享并调度，音频预取仍由 `audio/prefetch.js` 单独管理；歌词预取只保存原始数据，不在后台渲染。窗口、预算与生命周期见 [技术说明](technical.md)。

样式按原有顺序合并，标签和取色库作为独立内联脚本保留原有全局加载行为和许可证，最后内联主程序。`src/vendor/fft.mjs` 固定为 fft.js 4.0.4，仅适配 ESM 导出，计算内核不变；它随分析模块打包进 Worker 和主线程回退，保留 MIT 许可证，不新增旁置脚本或运行时依赖。构建只读取 `API_BASE_URL`、`DOWNLOAD_PROXY_URL` 两个公开地址；环境变量的其他值不会注入 HTML。版本号来自 `package.json`，模板中的 `{{VERSION}}` 不手动替换。

## 检查与发布

运行 `npm run check`、`npm test`、`npm run build`。静态检查验证未解析变量、模块导入环、外部脚本/样式、残留内联动作及版本占位符；测试分别覆盖纯函数、模拟播放状态、Worker 协议与构建产物。模拟音频和页面宿主测试不能替代实际设备的声音、布局及浏览器权限验收。

版本号以 `package.json` 为准，构建自动写入页脚；准备版本时可用 `npm version <目标版本> --no-git-tag-version` 同步包与锁文件，再添加 changelog 对应条目。采用语义化版本表达更新阶段，`0.x` 仍处于初始开发期，不承诺稳定的公开 API；较完整的功能迭代可提升次版本，修复提升补丁版本。参见 [SemVer](https://semver.org/spec/v2.0.0.html)。

`check.yml` 在 Windows、Linux 上检查、测试和构建；矩阵全部成功后，发布分支的推送、手动运行和版本标签事件才可调用可复用的 `release.yml`。PR 和其他分支没有发布权限。发布任务固定检出 `github.sha`，读取 package.json 的版本号；同版本已发布时跳过，否则验证 changelog 和单文件产物，通过 GitHub API 创建精确指向受检提交的标签，并在同一任务内创建草稿、上传、核对附件大小及标签归属后发布，不依赖标签事件二次触发工作流。

发布任务全局串行执行。已有轻量或附注标签必须解析到当前受检提交，草稿也只能从相同提交恢复，禁止移动标签或覆盖已发布版本；网络或权限错误不能当作不存在。版本号不自动递增，重试入口为 Actions 的失败任务或发布分支上的 `Check` 手动运行。写权限仅授予发布调用与发布任务，构建和 PR 保持只读。

`.github/workflows/pages.yml` 只部署 `minori0721-test-1` 分支，手动触发也检查相同分支。构建任务通过检查、测试和构建后上传 `dist/`；部署任务依赖构建成功，使用 `github-pages` 环境和官方 Pages Actions，不向源码分支写回产物。只有部署任务持有 `pages: write` 和 `id-token: write`，并发部署串行执行，不主动取消正在进行的发布。两个公开地址从仓库 Actions Variables 传入构建，未设置时回退默认值。Pages 发布来源需要首次手动切换为 `GitHub Actions`，工作流不会自动启用或修改项目配置。

Cloudflare Workers、Pages 与 Vercel 均运行同一个构建入口、只发布 `dist/`，API 后端与下载代理仍是独立项目。平台首次设置和变量说明见 [部署指南](deployment.md)。
