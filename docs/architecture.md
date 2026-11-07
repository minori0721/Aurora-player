# 源码结构

[项目首页](../README.md) · [使用指南](usage.md) · [部署指南](deployment.md) · [技术说明](technical.md)

Aurora 采用原生 JavaScript 模块开发，由 esbuild 合并代码，再将样式、配置、固定版本第三方库和 Worker 源码内嵌进 `dist/index.html`。日常维护 `src/`，`dist/` 为自动生成并由 Git 忽略的产物。

## 修改入口

| 目录 / 文件 | 职责 |
| --- | --- |
| `src/app.js` | 组装模块、连接接口、安排初始化顺序 |
| `src/index.html` | 页面结构与动作标记 |
| `src/assets/` | 原创图标 SVG 母版与已导出的 32/48 像素透明 PNG，构建时内嵌 PNG |
| `src/audio/playback.js` | 统一播放状态、双引擎切换、完整准备、加载令牌与播放控制 |
| `src/audio/media.js` | 原生流式播放、缓冲查询、无进展检测和实例释放 |
| `src/audio/local.js`、`online.js` | 本地/在线音频加载，复用统一播放核心 |
| `src/audio/prefetch.js`、`transfer.js` | 下一首任务、大小预算、超时和音频传输 |
| `src/audio/loop.js`、`quality.js`、`mp3.js`、`metadata.js` | 循环设定、音频格式信息、MP3 文件头解析和标签应用 |
| `src/playlist/` | 原列表与临时点播计划、播放队列、目录导入、伴随文件配对、列表显示与视口封面调度 |
| `src/playlist/rows.js` | 歌曲行索引、长列表分组、筛选状态与可见数量，保留现有按钮和封面节点 |
| `src/playlist/fade.js` | 列表文字溢出判断、近屏渐隐准备、测量缓存与面板生命周期 |
| `src/playlist/file-picker.js` | Android 标准文件选择、取消保护和兼容入口分流 |
| `src/lyrics/` | LRC/YRC/JSON 解析、来源优先级、在线匹配和歌词显示 |
| `src/lyrics/timeline.js` | 普通与逐字歌词对齐、片段组合及翻译/罗马音附着 |
| `src/netease/` | API、登录、内容浏览、路由、歌单分页、下载 |
| `src/netease/song-details.js` | 歌曲详情前瞻、按 ID 共享请求、优先级提升与账号隔离 |
| `src/netease/match-sources.js` | 备用音源名单及普通、无损、Hi-Res 的优先顺序 |
| `src/netease/song-actions.js`、`song-action-errors.js`、`account-request.js` | 喜欢状态、收藏与核验、操作结果分类、账号写请求与业务响应校验 |
| `src/netease/my-playlists.js` | 我的歌单与收藏选择器共用的账号分页数据、在途请求与订阅生命周期 |
| `src/netease/cloud.js`、`cloud-preparation.js` | 云盘任务、直接导入、临时文件直传、入库核验及 Worker 生命周期 |
| `src/audio/cloud-tags.js`、`cloud-worker.js` | MP3/FLAC 元数据增补、最终文件 MD5、按需离线计算 |
| `src/netease/images.js` | 云音乐缩略图近屏加载、可见失败重试和迷你封面复用 |
| `src/analysis/algorithms.js` | 三档周期搜索、原采样率精修和联合接缝选点的纯计算模块 |
| `src/analysis/signal.js` | 低通降采样、FFT 相关曲线及多声道频谱特征 |
| `src/analysis/input.js` | A/B 局部声道窗口、原始采样位置映射与 Worker 数据准备 |
| `src/analysis/worker.js`、`controller.js` | Worker 消息处理、任务生命周期、分析面板 |
| `src/storage/` | 请求缓存、IndexedDB、播放列表持久化与数据迁移 |
| `src/ui/`、`src/styles/` | 页面元素、弹层、控件、封面、渲染调度与样式 |
| `src/ui/track-header.js` | 桌面多行标题位移、顶部工具栏间距与尺寸观察 |
| `src/ui/toolbar-visibility.js` | 顶部工具栏闲置隐藏与桌面收藏胶囊淡化 |
| `src/ui/bottom-sheet.js` | 手机智能分析、循环设定共用的自由高度抽屉、边缘吸附、触摸与可视视口适配 |
| `src/ui/background-field.js` | 封面空间采样、加权模糊、色调映射与 WebGL 网格 |
| `src/ui/background.js`、`background-thread.js`、`background-worker.js` | 背景绘制调度、主线程桥接、独立 Worker 与静态降级 |
| `src/vendor/` | 前端库的固定源码与原许可证 |
| `server/` | Cloudflare 同站下载入口、音频流转发与目标地址校验 |
| `scripts/`、`tests/` | 构建、配置注入、检查、开发服务、发布及测试 |

## 状态与依赖

有状态模块通过 `createXxx()` 创建独立闭包，声明自己需要的接口。跨模块操作使用 `playbackService.startAudio()` 等具名调用；共享状态通过显式 getter/setter 保持实时引用。

`src/shared/ports.js` 先创建稳定的接口句柄，再安装各模块，确认全部服务已安装后冻结接口结构。全部模块连接完成后执行事件绑定与启动任务。内部必需服务直接调用；浏览器可选能力、尚未创建的对象和外部数据在各自入口检查。

纯解析、规范化、路由和匹配算法使用命名导入/导出。UI 调用业务模块，网络请求、算法和缓存迁移分别由所属模块负责。HTML 的 `data-action` 由统一的委托事件处理器绑定。

有事件绑定或启动副作用的模块提供可重复调用的 `initialize()`，绑定和启动逻辑仅执行一次。异步操作提交结果前校验曲目身份、播放令牌、账号代数或导航令牌。

播放控制由 `playback.js` 统一维护，业务模块通过接口查询当前引擎、请求完整准备或跳转。精确功能共享完整准备任务，应用前校验曲目和操作版本。

`playlist/plan.js` 是独立的播放顺序模型，维护原列表、临时待播、实际历史和原列表续播位置；`queue.js` 负责把选择交给播放核心。播放投影复用曲目对象，原列表增删、重排和替换通过具名方法更新结构版本。歌单来源绑定时验证曲目，后续以原列表引用和结构版本确认归属。UI 通过队列接口操作列表，预取查询计划中的实际下一首。

预取状态由 `audio/prefetch.js` 持有，在线播放通过 `takeNeteasePreload()` 接管在途任务、完整压缩数据或预热实例。取消先作废状态再通知下游。歌词异常每轮渲染报告一次并暂停该轮更新，重建后恢复；网络、存储等失败由所属模块处理。

## 文档边界

- `README.md`：项目入口、核心功能、快速开始、重要限制和文档导航。
- `docs/usage.md`：面向操作的行为和常见问题。
- `docs/deployment.md`：环境、平台与公开地址配置。
- `docs/technical.md`：播放、预取、循环、歌词、背景、缓存和隐私机制；具体实现参数集中在此维护。
- 本文：源码职责、模块约束、构建检查和版本发布。
- `changelog.md`：每个版本一个日期，记录功能与修复。

## 单文件构建

`scripts/build.mjs` 分别打包循环分析和背景 Worker，再通过虚拟模块 `aurora:loop-worker`、`aurora:background-worker` 将源码字符串注入主程序，运行时通过 Blob 创建 Worker。循环分析的主线程回退导入同一份算法；背景 Worker 或离屏 WebGL 不可用时使用静态渐变。新增构建入口同样内嵌到单文件产物中。

歌曲详情由 `song-details.js` 按 ID 共享并调度，音频预取由 `audio/prefetch.js` 管理，歌词预取保存原始数据供正式播放使用。窗口、预算与生命周期见 [技术说明](technical.md)。

样式按原有顺序合并，标签和取色库作为独立内联脚本保留全局加载行为和许可证，最后内联主程序。`src/vendor/fft.mjs` 固定为 fft.js 4.0.4，适配 ESM 导出并保留 MIT 许可证，随分析模块打包进 Worker 和主线程回退。构建读取 `API_BASE_URL`、`DOWNLOAD_PROXY_URL` 两个公开地址，版本号从 `package.json` 注入模板中的 `{{VERSION}}`。

## 检查与发布

运行 `npm run check`、`npm test`、`npm run build`。静态检查验证未解析变量、模块导入环、外部脚本/样式、残留内联动作及版本占位符；测试覆盖纯函数、模拟播放状态、Worker 协议与构建产物。

### 音源自动维护

`match-sources.yml` 每天北京时间 11:00 触发一次短测，周一当日检测完成后汇总最近七天；也可在 Actions 的 `Update music sources` 手动运行，周一手动运行会同时汇总。工作流仅使用默认分支，实际启动时间取决于 GitHub 调度。

每日读取上游 `UnblockNeteaseMusic-utils` 的现用模块目录，并批量核验当天样本的公开 VIP 属性和时长。中、日、英各一首固定基准曲，另外从九首轮换曲中每天取三首，三天覆盖十二首。测试 API 优先取仓库变量 `SOURCE_CHECK_API_URL`，其次是 `API_BASE_URL`，都未设置时使用项目默认 API；不使用账号凭据。CDN 检查携带播放器的 Origin，站点来源取 `SOURCE_CHECK_ORIGIN`，默认 `https://music.moerika.com`。

每日最多两个请求并发，每条执行链在请求前等待 700ms。每个来源最多六首、总计最多十二个来源，即最多 73 次 API 请求；七个来源时每天 43 次、每周 301 次，其中 match 为 294 次。文件头另向音频 CDN 读取，每段最多 4KiB，MP3 最多两段。格式、跨域和时长检查通过才计为成功。12 分钟停止分配新探测，整个每日任务上限 15 分钟；限流后停止新探测，未完成的整轮记录为无结论。

每天只保存 `match-sources-daily` 附件，保留 30 天。周一从同仓库、同工作流、默认分支的历史运行读取记录，同一北京时间日期只取最后一次，排除不同 API、站点来源和检测版本的数据。重跑不会增加该日权重；失败日作为缺测。至少三个有效日且当天检测有效时才提出排序建议。

周排序使用两天半衰期：`weight = 2 ** (-ageDays / 2)`，按每天的比例加权。普通模式比较可用率、MP3 率，无损比较 FLAC 率、可用率，Hi-Res 比较高精度 FLAC 率、FLAC 率、可用率。差距不足 10 个百分点时继续比较下一指标；指标近似时保留原顺序，仅将耗时中位数达到 5 秒的来源排在同等结果的其他来源之后。最新一轮至少三首全失败的来源降低优先级；全局故障或限流不参与排序。新增来源至少三个有效日各通过两首、合计三首不同歌曲才纳入建议，上游移除的来源从名单删除，暂时失败的现有来源保留。耗时代表 GitHub runner 的测试线路。高音质播放先尝试对应名单中排前的两个来源，再使用有损兜底。

周建议名单通过源码检查、自动测试和单文件构建后，更新 `automation/match-sources` 分支上的同一个 PR，只提交 `src/netease/match-sources.js`；没有变化时不新建 PR。周报保存为 `match-sources-weekly` 附件，保留 30 天，包含有效日期、加权指标和建议顺序。附件只保存检测数据与文字报告，不保存音频链接或凭据。每日探测仅持有内容读权限，周汇总增加 Actions 读权限，创建 PR 的独立任务才持有仓库内容和 PR 写权限。

首次启用需将工作流推送到默认分支，并在仓库 Settings → Actions → General → Workflow permissions 打开 **Allow GitHub Actions to create and approve pull requests**。工作流使用内置 `GITHUB_TOKEN`，不需要新增个人 Token。机器人 PR 的常规检查可能显示 **Approve workflows to run**，仓库维护者批准后运行。名单更新仍需人工合并，版本号和 Release 沿用现有发布规则。

本地可运行 `npm run sources:check` 只比对目录，或 `npm run sources:audit` 生成单次报告和建议文件；后者的输出位于 `work/match-sources-audit/`，加 `-- --write` 才写入源码，单次建议不等同于周排序。`npm run sources:audit -- --daily` 只保存当天记录。`npm run sources:weekly` 在 Actions 中下载历史附件并生成 `work/match-sources-weekly/` 周报及候选名单。播放器运行和普通单文件构建不访问 GitHub，继续使用 HTML 内嵌的名单。

### 版本发布

版本号以 `package.json` 为准，构建自动写入页脚；准备版本时可用 `npm version <目标版本> --no-git-tag-version` 同步包与锁文件，再添加 changelog 对应条目。功能迭代提升次版本，修复提升补丁版本，参见 [SemVer](https://semver.org/spec/v2.0.0.html)。

`check.yml` 在 Windows、Linux 上检查、测试和构建，Linux 同时保存按提交 SHA 命名的单文件产物。矩阵全部成功后，Pages 与 Release 从同次运行下载这一份产物，不重复测试或重新打包；两者使用相同的公开地址配置。重跑全部检查可替换同次运行的产物，仅重试发布任务则继续使用已有受检产物。PR 和其他分支没有发布权限。发布任务固定检出 `github.sha`，读取 package.json 的版本号；同版本已发布时跳过，否则验证 changelog 和单文件产物，通过 GitHub API 创建精确指向受检提交的标签，并在同一任务内创建草稿、上传、核对附件大小及标签归属后发布，不依赖标签事件二次触发工作流。

发布任务全局串行执行。已有轻量或附注标签必须解析到当前受检提交，草稿也只能从相同提交恢复，禁止移动标签或覆盖已发布版本；网络或权限错误不能当作不存在。版本号不自动递增，重试入口为 Actions 的失败任务或发布分支上的 `Check` 手动运行。发布写权限仅授予发布调用与发布任务，常规构建和 PR 检查保持只读；音源维护的 PR 创建任务另按上述范围授权。

`.github/workflows/pages.yml` 由 `Check` 调用，部署 `minori0721-test-1` 分支；手动部署运行该分支的 `Check`。产物转换为 Pages 附件后，通过 `github-pages` 环境和官方 Pages Actions 发布。部署权限授予调用与部署任务，检查和附件准备保持只读；部署串行执行。两个公开地址从仓库 Actions Variables 传入受检构建，未设置时使用默认值。首次使用时，将仓库 Pages 发布来源设为 `GitHub Actions`。

Cloudflare Workers 使用 `server/cloudflare.js` 和 `dist/`；Pages 构建自动向 `dist/` 增加下载函数与路由配置。两者的前端默认使用同站下载入口。Vercel、GitHub Pages 和普通单文件构建默认使用公共 Cloudflare 下载代理，显式配置优先。Pages 与 Release 的工作流继续只传递 `dist/index.html`。API 后端独立部署，平台设置见 [部署指南](deployment.md)。
