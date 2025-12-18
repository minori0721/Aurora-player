# 🎵 Aurora Player (极光播放器)

> 一个基于 Web Audio API 的现代网页音乐播放器，专为无缝循环 (Seamless Loop) 和高保真音频体验设计。


## ✨ 项目简介

**Aurora Player** 是一个由Gemini3pro编写的纯前端、单文件的音乐播放器。它不需要后端服务器支持，直接利用浏览器的计算能力解码音频。

它的核心目标是解决网页播放器在 **游戏 BGM 无缝循环** 和 **FLAC 内置歌词解析** 方面的痛点。通过手写的原生二进制解析器，它摆脱了对臃肿第三方库的依赖，实现了轻量级与高性能的统一。

## 🚀 核心功能

### 🎧 专业音频回放
- **全格式支持**：完美播放 MP3, FLAC, OGG, WAV 等主流格式。
- **无缝循环 (Seamless Loop)**：基于 Web Audio API 的 `AudioBuffer` 技术，实现采样级（Sample-Accurate）的无间断循环，彻底告别 `<audio>` 标签的“卡顿”感。
- **SLI 支持**：原生支持 `.sli` (Sound Loop Information) 格式，可自动识别 Galgame 或 RPG Maker 游戏音乐的循环断点。

### 📜 歌词系统
- **多源歌词解析**：
  - **外部歌词**：支持拖入同名 `.lrc` 文件。
  - **内置歌词**：支持读取 ID3 (MP3) 和 Vorbis Comments (FLAC) 中的嵌入式歌词。
  - **非同步支持**：智能识别纯文本歌词并格式化显示。
- **智能纠错**：内置强大的正则清洗引擎，能自动修复不规范的歌词格式（如 `/` 分隔符）。

### 🎨 沉浸式 UI
- **流体极光背景**：使用 `ColorThief` 提取专辑封面主色调，生成动态的流体渐变背景。
- **玻璃拟态设计**：全界面采用 Frosted Glass 风格，清透美观。
- **动态特效**：内置多种 Canvas 可视化效果：
  - ❄️ **凛冬飞雪** (随低音鼓点加速)
  - 📊 **律动频谱**
  - 🌊 **极光波浪**

### 🛠️ 设置功能
- **AB 循环控制台**：手动打点 Loop Start / Loop End，支持毫秒级微调。
- **采样率修正**：提供 Base Rate 修正功能 (44100Hz / 48000Hz)，解决不同声卡导致的循环错位问题。
- **原生 FLAC 解析内核**：内置手写的二进制解析器，直接读取 `fLaC` 文件头和 `VORBIS_COMMENT`，无需重型依赖。

## 📖 使用指南

1. **打开播放器**：访问部署好的网页（如 GitHub Pages）。
2. **投喂音乐**：
   - 将 **音频文件** (.mp3/.flac/.ogg) 直接拖入网页。
   - 如果有 **歌词** (.lrc) 或 **循环信息** (.sli)，请**同时**选中它们一起拖入。
3. **控制循环**：
   - 点击右上角的 `🔁 循环设定` 打开控制面板。
   - 如果拖入了 `.sli` 文件，循环点会自动填入。
   - 你也可以手动点击 `Set A` 和 `Set B` 设定循环区间。
4. **切换特效**：在左上角的下拉菜单中选择你喜欢的视觉效果。

## 📦 部署方法

本项目为纯静态页面，可以部署在任何 Web 服务器上。

### GitHub Pages (推荐)
1. Fork 本仓库或新建仓库。
2. 将 `index.html` 上传至仓库根目录。
3. 在仓库 `Settings` -> `Pages` 中，将 Source 设置为 `main` 分支。
4. 访问生成的 URL 即可使用。

### 本地运行
无需安装 Node.js 或 Python，直接用 Chrome / Edge 浏览器打开 `index.html` 即可运行。

## 🔧 技术栈

- **Core**: HTML5, CSS3, Vanilla JavaScript (ES6+)
- **Audio Engine**: Web Audio API (AudioContext, AudioBufferSourceNode)
- **Visualization**: HTML5 Canvas API
- **Libraries**:
  - `jsmediatags`: 用于 MP3 ID3 标签读取。
  - `color-thief`: 用于封面颜色提取。
  - *(Self-Written)* `NativeFlacParser`: 自研 FLAC 元数据解析器。

## 📄 许可证

[MIT License](LICENSE) © 2025 Aurora Project
