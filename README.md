# 🎵 Aurora Player (极光播放器) preview.ver

**在线体验**：[https://minori0721-test-1.aurora-player.pages.dev/](https://minori0721-test-1.aurora-player.pages.dev/)

> 一个基于 Web Audio API 的现代网页音乐播放器，专为 **无缝循环 (Seamless Loop)**、**高保真音频** 及 **跨平台体验** 设计。

## ✨ 项目简介

**Aurora Player** 是一个纯前端、单文件的音乐播放器。它摆脱了传统 HTML5 `<audio>` 标签的限制，直接利用浏览器的 AudioContext 进行音频解码与播放。

本项目致力于解决两大痛点：**游戏 BGM 的无缝循环播放** 与 **高质量的在线音乐体验**。通过内置的原生二进制解析器和网易云音乐深度集成，它既能作为本地离线播放器，也能变身为强大的在线流媒体客户端。

## 🚀 核心功能

### ☁️ 网易云音乐深度集成 (NEW!)

不再局限于本地文件，Aurora Player 现已接入完整的网易云音乐生态：

* **全功能搜索面板**：点击「☁️ 云音乐」即可搜索全网歌曲，支持按歌名、歌手搜索。
* **歌单导入**：支持粘贴网易云歌单链接或 ID，一键导入整张歌单到播放列表。
* **账号登录**：支持 **APP 扫码登录**，同步加载「我创建的歌单」和「我收藏的歌单」。
* **无损音质**：支持切换 **标准 / 极高 / 无损 (FLAC) / Hi-Res** 音质（需 VIP 账号）。
* **云端歌词**：自动匹配并加载云端歌词，支持精确的时间轴同步。

### 🎧 专业音频回放

* **全格式支持**：完美播放 MP3, FLAC, OGG, WAV, M4A 等主流格式。
* **无缝循环 (Seamless Loop)**：基于 Web Audio API 的采样级（Sample-Accurate）无间断循环，彻底告别卡顿感。
* **SLI 支持**：原生支持 `.sli` (Sound Loop Information) 格式，自动识别 Galgame/RPG 游戏的循环断点。

### 📱 响应式设计 (Mobile Ready)

* **多端适配**：精心设计的响应式布局，在 **手机、平板** 和 **桌面端** 均有完美表现。
* **手势操作**：移动端支持底部面板滑出、触摸拖动进度条。
* **自适应菜单**：桌面端显示完整工具栏，移动端自动折叠至「⚙️ 高级」菜单。

### 🔍 智能循环分析

* **自动波形匹配**：内置 MSE（均方误差）与过零点检测算法。
* **智能对齐**：只需粗略设定 A/B 点，算法会自动在 ±2秒 范围内寻找最佳无爆音接缝。
* **一键导出**：支持将分析结果导出为 `.sli` 文件。

### 🎨 沉浸式 UI

* **流体极光背景**：使用 `ColorThief` 提取专辑封面主色调，生成动态流体背景。
* **动态特效**：内置多种 Canvas 可视化效果：
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
4. **导入歌单**：在「📋 导入歌单」标签页粘贴链接，将喜欢的歌单加入播放列表。

### 方式三：智能循环制作

1. 点击 **「🔍 智能分析」** (移动端在高级菜单中)。
2. 播放到循环起点，点击 `📍 定位 A`；播放到终点，点击 `📍 定位 B`。
3. 点击 `✨ 开始精确匹配`，系统会自动计算最佳接缝。
4. 点击 `💾 导出 .sli` 保存你的劳动成果。

## 📦 部署说明

本项目为纯静态页面，但网易云功能依赖后端 API 代理。

### 1. 静态页面托管

将 `index.html` 上传至 GitHub Pages, Vercel, 或 Cloudflare Pages 即可。

### 2. 后端 API 配置 (重要)

网易云功能依赖 [NeteaseCloudMusicApiEnhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced/)。
但是试用网站使用了我fork后修改的版本 [api-enhanced](https://github.com/minori0721/api-enhanced)
项目代码中默认配置了 API 地址：

```javascript
// index.html 中的配置
const NETEASE_API_HOST = 'https://minorimusicapi.zeabur.app'; 

```
经我测试，国内可直连的部署服务包括：
[zeabur](https://zeabur.com/)

[hugging face](https://huggingface.co/)

如果你部署了自己的 API 服务，请在代码中搜索 `NETEASE_API_HOST` 并修改为你自己的地址。（不要用我的呀

## 🔧 技术栈

* **Core**: HTML5, CSS3, ES6+ JavaScript
* **Audio**: Web Audio API (`AudioContext`, `AudioBuffer`)
* **UI Framework**: Vanilla CSS (Glassmorphism, Grid/Flexbox)
* **Visualization**: HTML5 Canvas API
* **Libraries**:
* `jsmediatags`: ID3 标签解析
* `color-thief`: 图片颜色提取


* **Self-Developed Modules**:
* `NativeFlacParser`: 手写 FLAC 二进制解析器 (无需 Wasm)
* `LoopAnalyzer`: 波形匹配与过零点分析算法
* `NeteaseIntegrator`: 网易云 API 完整对接模块



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
