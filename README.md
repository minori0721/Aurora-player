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
* **双语歌词 (NEW!)**：内置歌词翻译切换功能，支持“仅原文”与“原文+翻译”模式，精准时间轴同步。

### 🎧 专业音频回放 & 体验

* **全格式支持**：完美播放 MP3, FLAC, OGG, WAV, M4A 等主流格式。
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

* **自动波形匹配**：内置 MSE（均方误差）与过零点检测算法。
* **智能对齐**：只需粗略设定 A/B 点，算法会自动在 ±2秒 范围内寻找最佳无爆音接缝。
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
    window.API_BASE_URL = 'https://minorimusicapi.zeabur.app';
    
    // 下载代理 Worker 地址 (用于绕过 Referer 限制下载音频)
    window.DOWNLOAD_PROXY_URL = 'https://proxy.minori0721.dpdns.org';
</script>

```

* **API_BASE_URL**: 依赖 [NeteaseCloudMusicApiEnhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced/) ，我的网页使用了经我小优化的 Fork 版本（ [api-enhanced](https://github.com/minori0721/api-enhanced)）。
* **DOWNLOAD_PROXY_URL**: 需要一个简单的 Cloudflare Worker 或 Nginx 反代，用于处理跨域和 Referer 头，以便浏览器能触发文件下载。

经我测试，国内可直连的部署服务包括：
[zeabur](https://zeabur.com/) | [hugging face](https://huggingface.co/)

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
* `LoopAnalyzer`: 波形匹配与过零点分析算法
* `NeteaseIntegrator`: 网易云 API 完整对接模块 (含二维码登录/下载逻辑)



## 🎯 算法细节

### 循环点匹配 (Loop Matching)

算法采用了 **双阶段搜索** 策略：

1. **粗略扫描**：使用均方差 (MSE) 在目标区域进行步进扫描，找到波形相似度最高的区域。
2. **精细对齐**：在粗选点附近寻找最近的 **过零点 (Zero Crossing)**，确保循环连接处电压为零，从而消除“啪”的爆音。

### 置信度 (Confidence)

算法会返回一个置信度评分：

* `> 99.0%`：完美匹配，自动应用。
* `< 99.0%`：匹配度较低，建议手动微调 A/B 点范围。

## 📄 许可证

[MIT License](https://www.google.com/search?q=LICENSE) © 2025 Aurora Project
