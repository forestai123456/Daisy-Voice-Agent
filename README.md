# Daisy 语音助手

> 开源的 macOS AI 语音助手。

Daisy 通过全局快捷键或语音唤醒词来接收指令，能够使用你自己的 AI 与语音识别服务完成问答、系统控制、网页搜索、日程与提醒等任务。

## 功能

- 按住右侧 `Option` 键说话，松手自动发送
- 可选的“嘿 Daisy”语音唤醒
- 流式 AI 回复与中文语音播报
- 本地快捷命令：打开或关闭应用、调节音量、媒体控制、打开网页等
- macOS 系统工具：备忘录、提醒事项、日历、地图、天气、文件操作等
- 悬浮球状态提示与对话历史

## 下载与安装

请在 [Releases](../../releases) 页面下载最新的 `Daisy-*.dmg`，打开后将 **Daisy** 拖到“应用程序”文件夹。

本项目目前没有 Apple 开发者签名或公证。首次运行时，macOS 可能提示“无法验证开发者”：请在“应用程序”中按住 Control 键点击 Daisy，选择“打开”，再在确认框中点击“打开”；必要时可到“系统设置 → 隐私与安全性”中选择“仍要打开”。请只从本仓库的 Release 页面下载。

## 首次配置

安装后打开 Daisy 的设置页面，填入你自己的服务凭据：

1. DeepSeek API Key（用于 AI 回答）；
2. 火山引擎 / 豆包 ASR 的 App ID 与 Access Token（用于语音识别）。

这些配置仅保存在你本机的 Daisy 应用数据目录，不包含在本仓库或发布的安装包中。语音合成默认使用 Microsoft Edge TTS。

首次使用时，按 macOS 提示授予麦克风、辅助功能和输入监控权限。语音唤醒功能还需要 [whisper.cpp](https://github.com/ggml-org/whisper.cpp) 的模型文件；将模型放到 `~/Models/whisper/`，或在设置中选择相应配置。

## 从源码运行

环境要求：macOS、Node.js 22 或更新版本，以及 npm。

```bash
git clone https://github.com/forestai123456/Daisy-Voice-Agent.git
cd Daisy-Voice-Agent
npm install
cp .env.example daisy.env
# 编辑 daisy.env，填入你自己的密钥；请勿提交该文件
npm run dev
```

构建未签名 DMG：

```bash
npm run dist:mac
```

产物会生成在 `releases/`。`daisy.env` 被 Git 忽略且明确排除在安装包外。

## 隐私与安全

- 本仓库不包含任何开发者 API Key、Access Token 或用户配置。
- 请不要把自己的 `daisy.env` 上传到 GitHub 或发送给他人。
- Daisy 可以按你的指令控制系统、访问文件或运行命令。请仅在你信任的设备上使用，并审阅 AI 执行的敏感操作。

## 开源许可

本项目采用 [MIT License](LICENSE) 开源。项目使用 Electron、whisper.cpp、yt-dlp 等第三方组件；各组件仍适用其各自的许可条款。

## 贡献

欢迎提交 Issue 和 Pull Request。请不要在 Issue、日志或 PR 中粘贴 API Key、Token 或个人隐私数据。
