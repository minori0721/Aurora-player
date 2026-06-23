# 🎵 Aurora Player (极光播放器) preview.ver

**在线体验**：[https://minori0721-test-1.aurora-player.pages.dev/](https://minori0721-test-1.aurora-player.pages.dev/)
或：[https://player.minori0721.dpdns.org/](https://player.minori0721.dpdns.org/)

> 一个基于 Web Audio API 的现代网页音乐播放器，专为 **无缝循环 (Seamless Loop)**、**高保真音频** 及 **跨平台体验** 设计。

## ✨ 项目简介

**Aurora Player** 是一个纯前端、单文件的音乐播放器。它摆脱了传统 HTML5 `<audio>` 标签的限制，直接利用浏览器的 AudioContext 进行音频解码与播放。

本项目致力于解决两大痛点：**游戏 BGM 的无缝循环播放** 与 **高质量的在线音乐体验**。通过内置的原生二进制解析器和网易云音乐深度集成，它既能作为本地离线播放器，也能变身为强大的在线流媒体客户端。

## 🚀 核心功能

### ☁️ 网易云音乐深度集成 (Enhanced)

不再局限于本地文件，Aurora Player 现已接入完整的网易云音乐生态：

* **全功能搜索面板**：点击「☁️ 云音乐」即可搜索全网歌曲，支持按歌名、歌手智能匹配。
* **无损音质下载 (NEW!)**：支持直接下载歌曲文件。系统会自动检测并提供 **标准 (128k) / 较高 (192k) / 极高 (320k) / 无损 (FLAC) / Hi-Res** 等多种音质选项（视账号权益而定）。
* **账号登录**：支持 **APP 扫码登录**，同步加载「我创建的歌单」和「我收藏的歌单」，解锁 VIP 音质。
* **歌单导入**：支持粘贴网易云歌单链接或 ID，一键导入整张歌单到播放列表。
* **三段式歌词切换 (NEW!)**：独家支持 **仅原文 / 原文+翻译 / 原文+罗马音** 三段式循环切换，完美适配日语歌曲学习与欣赏需求。
* **逐字同步歌词 (NEW!)**：深度对接逐字歌词 (YRC) 引擎，实现 **Apple Music 风格的逐字渐进高亮** (逐字点亮动画)，给您极致的视觉律动感。

### 🎧 专业音频回放 & 体验

* **全格式支持**：完美播放 MP3, FLAC, OGG, WAV, M4A 等主流格式。
* **极致性能优化 (NEW!)**：通过 GPU 硬件加速 (`transform`) 重构动画、应用 `DocumentFragment` 解决 DOM 重排阻塞、以及精确的 AudioBuffer 内存池主动释放，确保持续平稳的高帧率与极低内存/显存占用。
* **智能断点记忆 (NEW!)**：利用 `localStorage` 自动保存当前的播放列表和播放索引，刷新页面或关闭浏览器后归来，音乐依旧。
* **无缝循环 (Seamless Loop)**：基于 Web Audio API 的采样级（Sample-Accurate）无间断循环，彻底告别卡顿感。
* **SLI 支持**：原生支持 `.sli` (Sound Loop Information) 格式，自动识别 Galgame/RPG 游戏的循环断点。

### 📱 响应式设计 (Mobile Ready)

* **多端适配**：精心设计的响应式布局，在 **手机、平板** 和 **桌面端** 均有完美表现。
* **手势操作**：移动端支持底部面板滑出、触摸拖动进度条。
* **自适应菜单**：
* 桌面端：显示完整工具栏。
* 移动端：自动折叠至「⚙️ 高级」菜单（包含 Debug、智能分析、循环设定、特效切换等）。



### 🔍 智能循环分析

* **三档匹配算法**：支持「速度优先 / 均衡推荐 / 准确优先」，可按歌曲复杂度和等待时间选择匹配策略。
* **智能对齐**：只需粗略设定 A/B 点，算法会自动在附近寻找最佳无爆音接缝。
* **后台分析**：默认使用 Web Worker 执行智能匹配，降低长时间分析时主界面卡住的概率。
* **一键导出**：支持将分析结果导出为 `.sli` 文件。

### 🎨 沉浸式 UI

* **流体极光背景**：使用 `ColorThief` 提取专辑封面主色调，生成动态流体背景。
* **动态特效**：内置多种 Canvas 可视化效果：
* ✨ **无特效** (纯净模式)
* ❄️ **凛冬飞雪** (随低音鼓点加速)
* 📊 **律动频谱**
* 🌊 **极光波浪**



## 📖 使用指南

### 方式一：本地播放 (拖拽投喂)

1. **文件支持**：直接将 `.mp3`, `.flac`, `.ogg` 等音频文件拖入窗口。
2. **配套文件**：支持同时拖入同名歌词 (`.lrc`) 或循环信息 (`.sli`)。
3. **快捷键**：
* `Space`: 播放/暂停
* `← / →`: 快退/快进
* `↑ / ↓`: 音量调节



### 方式二：网易云在线模式

1. 点击顶部工具栏的 **「☁️ 云音乐」** 按钮打开面板。
2. **搜索**：输入歌名或歌手，点击播放。
3. **扫码登录**：点击「🔐 扫码登录」，使用网易云 APP 扫码，即可解锁完整歌单和高音质权限。
4. **下载音乐**：播放歌曲时，点击控制栏右侧的 **下载图标** (⬇️)，选择心仪的音质进行下载。

### 方式三：智能循环制作

1. 点击 **「🔍 智能分析」** (移动端在高级菜单中)。
2. 播放到循环起点，点击 `📍 定位 A`；播放到终点，点击 `📍 定位 B`。
3. 点击 `✨ 开始精确匹配`，系统会自动计算最佳接缝。
4. 点击 `💾 导出 .sli` 保存你的劳动成果。

## 📦 部署说明

本项目为纯静态页面，但网易云功能及下载代理功能依赖后端 API。

### 1. 静态页面托管

将 `index.html` (及相关资源) 上传至 GitHub Pages, Vercel, 或 Cloudflare Pages 即可。

### 2. 后端 API 配置 (重要)

HTML 文件头部包含全局配置变量，请根据你的部署环境修改：

```html
<script>
    // 全局 API 地址 (网易云音乐 API)
    window.API_BASE_URL = 'https://musicproxy.minori.eu.cc';
    
    // 下载代理 Worker 地址 (用于绕过 Referer 限制下载音频)
    window.DOWNLOAD_PROXY_URL = 'https://proxy.minori0721.dpdns.org';
</script>

```

* **API_BASE_URL**: 依赖 [NeteaseCloudMusicApiEnhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced/) ，我的网页使用了经我小优化的 Fork 版本（ [api-enhanced](https://github.com/minori0721/api-enhanced)）。
* **DOWNLOAD_PROXY_URL**: 需要一个简单的 Cloudflare Worker 或 Nginx 反代，用于处理跨域和 Referer 头，以便浏览器能触发文件下载。

如果部署平台支持构建期环境变量，也可以不直接改业务代码，而是在平台里配置后由构建步骤注入到这两个变量：

* `API_BASE_URL`: 网易云音乐 API 地址。
* `DOWNLOAD_PROXY_URL`: 下载代理 Worker / 反代地址。

注意：Aurora Player 是纯前端静态页面，浏览器运行时不能直接读取服务器环境变量；环境变量需要在部署平台的构建流程里替换进 `index.html`，或通过平台提供的静态变量注入能力生成最终页面。

经我测试，国内可直连的部署服务包括：
~~[zeabur](https://zeabur.com/)~~（zeabur的serverless函数已经挂掉啦！） | [hugging face](https://huggingface.co/)

## 🔧 技术栈

* **Core**: HTML5, CSS3, ES6+ JavaScript
* **Audio**: Web Audio API (`AudioContext`, `AudioBuffer`)
* **UI Framework**: Vanilla CSS (Glassmorphism, Grid/Flexbox, Responsive)
* **Visualization**: HTML5 Canvas API
* **Libraries**:
* `jsmediatags`: ID3 标签解析
* `color-thief`: 图片颜色提取


* **Self-Developed Modules**:
* `NativeFlacParser`: 手写 FLAC 二进制解析器 (无需 Wasm)
* `YrcEngine`: 高性能逐字歌词渲染引擎，基于 CSS GPU 加速实现扫光动画
* `LoopAnalyzer`: 波形匹配与过零点分析算法
* `NeteaseIntegrator`: 网易云 API 完整对接模块 (包含 VIP 下载 Fallback 机制及智能格式判定)



## 🎯 算法细节

### 循环点匹配 (Loop Matching)

智能循环匹配提供三档策略：

1. **速度优先**：保留旧版快速 MSE 匹配逻辑，适合 A/B 点已经比较准的场景。
2. **均衡推荐**：默认档，使用低采样率 NCC 粗筛，再回到原采样率进行接缝评分与精修。
3. **准确优先**：全筛候选与精修流程，覆盖更强但耗时更长。

评分会综合接缝前后波形相似度、跳变误差、循环长度偏差、粗点距离和风险项。默认档还会对低风险的临界候选做小幅置信度校准，提升可用结果的采纳率。

### 置信度 (Confidence)

算法会返回一个置信度评分：

* `>= 80%`：高置信度，自动应用并显示“找到了”。
* `>= 30%`：候选结果，自动应用但建议先试听确认。
* `< 30%`：不可靠结果，不自动应用，建议重新靠近 A/B 粗点。

## 📄 许可证

[MIT License](https://www.google.com/search?q=LICENSE) © 2025 Aurora Project
