# Daisy Windows ARM64 移植说明

本文档描述 Daisy 2.1.5 在 Windows 11 ARM64 上的移植状态、构建流程、已知限制以及与 macOS 版本的功能差异。

## 状态总览

| 项 | 状态 |
|---|---|
| 主分支 | `main`（保留原 macOS 版本，未修改） |
| 移植分支 | `windows-port`（本分支） |
| 目标架构 | `win32-arm64`（NSIS 安装包） |
| macOS 版本 | 完全保留，所有 `darwin` 分支与 `dist:mac` 流程不变 |
| 签名 | 未签名（v1）；SmartScreen 首次启动会警告 |

## 工作目录与复制规则

- **原项目（只读）**：`/Volumes/外接盘/Daisy_2.0付费版本`（共享目录，禁止改动）
- **Windows 移植工作副本**：`/Volumes/外接盘/Daisy-windows`（外接盘，非系统盘）
- 复制时已排除：`node_modules` / `dist` / `releases` / `daise.env` / `env.js` / `*.bak` / `settings-*.js` / 所有 Mach-O 二进制 / `*.dylib`。
- 已保留全部未提交改动（45 modified + 22 untracked），仅删去违禁文件。

## 在 Windows VM 里准备环境

> 因为 `C:\work\Daisy-windows` 在 Windows 虚拟磁盘上，而虚拟磁盘镜像本身存放在 Mac 外接盘，所以代码、`node_modules`、构建产物都不会占用 Mac 内置系统盘。

1. 启动 Win11 ARM64 UTM 虚拟机。
2. 安装 Node.js LTS ARM64：https://nodejs.org/（选 "Windows ARM64" 安装包）。
3. 通过 SPICE webdavd 把外接盘共享进 VM，或直接把 `Daisy-windows/` 整树复制到 VM 的 `C:\work\Daisy-windows\`：
   ```powershell
   New-Item -ItemType Directory -Force C:\work | Out-Null
   robocopy "\\spice-webdavd\DavWWWRoot\Daisy-windows" "C:\work\Daisy-windows" /E /COPY:DAT
   ```
4. 进入项目目录：
   ```powershell
   Set-Location C:\work\Daisy-windows
   Test-Path package.json
   git status --short
   ```

## 配置密钥

复制模板并填入真实值（**禁止从 macOS 的 `daise.env` 或 `env.js` 复制密钥**）：

```powershell
Copy-Item daisy.env.windows.example daisy.env
notepad daisy.env
```

需要填写的变量（参见 `daisy.env.windows.example` 的注释）：
- `VOLCENGINE_APP_ID` / `VOLCENGINE_ACCESS_TOKEN` — 火山引擎 ASR
- `DEEPSEEK_API_KEY` — DeepSeek LLM

## 构建与打包

```powershell
npm ci                # 安装依赖（含 patch-package 补丁）
npm run build         # tsc + vite settings + copy-renderer；build:native 在 win 上跳过
npm run start         # 启动 Electron 调试运行
npm run dist:win      # 生成 NSIS 安装包：releases\win-arm64\Daisy Setup 2.1.5.exe
```

`dist:win` 脚本展开：`npm run build && electron-builder --win --arm64`

安装包绝对路径（VM 内）：
```
C:\work\Daisy-windows\releases\win-arm64\Daisy Setup 2.1.5.exe
```

## 内置二进制（Windows x64，靠 Win11 ARM64 x64 模拟运行）

| 路径 | 来源 | 用途 |
|---|---|---|
| `assets/bin/whisper-cli.exe` | whisper.cpp v1.7.6 `whisper-bin-x64.zip` | 唤醒词检测 |
| `assets/bin/yt-dlp.exe` | yt-dlp 官方 releases | `download_media` 工具 |
| `assets/lib/ggml-base.dll` | whisper.cpp v1.7.6 | whisper-cli 依赖 |
| `assets/lib/ggml-cpu.dll` | whisper.cpp v1.7.6 | whisper-cli 依赖 |
| `assets/lib/ggml.dll` | whisper.cpp v1.7.6 | whisper-cli 依赖 |
| `assets/lib/whisper.dll` | whisper.cpp v1.7.6 | whisper-cli 依赖 |
| `assets/icon.ico` | 由 `diri_app_icon.jpg` 通过 Pillow 生成（7 分辨率：16/24/32/48/64/128/256） | NSIS 安装包图标、托盘图标 |
| `assets/models/ggml-base.bin` | （gitignored，需在 VM 内另行下载） | whisper 模型文件 |

模型文件下载（如果项目副本里没有 `assets/models/ggml-base.bin`）：

```powershell
Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin" -OutFile "assets\models\ggml-base.bin"
```

## 验收清单（在 VM 内逐项验证）

1. **依赖与类型**：`npm ci` 无报错；`npx tsc --noEmit` 0 错误。
2. **构建**：`npm run build` 产出 `dist/main/`、`dist/renderer/`、`dist/renderer-settings/`。
3. **启动**：`npm run start` 打开主进程；悬浮球出现在屏幕顶部居中。
4. **设置页**：托盘右键 → "打开 Daisy 设置"；设置窗口可正常打开/关闭/最小化。
5. **全局快捷键**：按住默认键（`RightOption` 或自定义 `RightAlt`）说话，松手发送；状态机 idle→listening→thinking→speaking→idle 正常流转。
6. **麦克风**：Windows 弹出"允许应用访问麦克风"对话框，允许后音频采集正常。
7. **ASR**：对着麦克风说中文，悬浮球进入 thinking，最终显示转写文本。
8. **TTS**：Edge TTS 流式朗读，"阅后即焚"清理临时音频。
9. **唤醒词**：喊"嘿 Daisy"触发唤醒；如未配置 `WAKE_WORD_ENABLED=false` 则跳过。
10. **打包**：`npm run dist:win` 产出 `releases\win-arm64\Daisy Setup 2.1.5.exe`。
11. **安装/启动/卸载**：在干净用户账户下安装 NSIS exe → 启动 → 配置 env → 跑一次完整语音循环 → 控制面板卸载。

## 平台适配总览（按 brief 要求的 4 列格式）

| 项 | 原 macOS 实现 | Windows 实现 | 状态 | Windows 验证方式 |
|---|---|---|---|---|
| **build:native** | `xcrun clang++` + Foundation/CoreGraphics/AppKit 编译 `native/window-selector.mm` | `scripts/build-native.cjs` 平台分发；win32 跳过（无原生 overlay） | ✅ | `npm run build:native` 在 Windows 上打印 "Skipping native module build on win32" |
| **copy-renderer** | `rm -rf` + `cp -R` | `scripts/copy-renderer.cjs` 用 `fs.rmSync` + `fs.cpSync` | ✅ | `npm run copy-renderer` 在 Windows 上无错复制 |
| **clean** | `rm -rf` | `scripts/clean.cjs` 用 `fs.rmSync` | ✅ | `npm run clean` 在 Windows 上无错删除 |
| **build.win 配置** | 缺失 | 新增 `win` + `nsis` 块（`arm64`，未签名） | ✅ | `npm run dist:win` 产出 NSIS exe |
| **dist:win 脚本** | 缺失 | `npm run build && electron-builder --win --arm64` | ✅ | `npm run dist:win` |
| **daisy-window-selector.node** | Obj-C++ N-API addon（CGWindowListCopyWindowInfo / NSWindow.setLevel:NSScreenSaverWindowLevel+1） | 跳过；`macosOverlay.ts` 已在非 darwin 早返回；orb 靠 `setAlwaysOnTop(true,"screen-saver")` + `skipTaskbar` | ✅（受限） | 浮窗在普通窗口和最大化窗口上置顶；独占全屏游戏上可能不显示（已知限制） |
| **macos.ts 35 工具** | AppleScript / `osascript` / `open` / `pkill` / `screencapture` / `sips` / `textutil` / `afplay` / `defaults read` / `nohup` | `src/main/control/windows.ts` 用 PowerShell `-EncodedCommand`（避免引号陷阱）+ `Start-Process` / `Stop-Process` / `taskkill` / `keybd_event` / `System.Drawing.Bitmap.CopyFromScreen` / Electron `Notification` | ✅（核心 14 工具） | `scripts/self-test.js` 逐工具调用；用户口令"打开记事本"/"5 分钟后提醒我" |
| **deepseek.ts 工具分发** | `require("../control/macos")` 直连 | `require("../control/platform")` 平台分发（4 处调用点改完） | ✅ | `tsc --noEmit` 通过 |
| **router.ts 本地命令** | `APP_DIRS=["/Applications",...]` + `osascript` 音量/媒体键/DND/minimize/split + `SwitchAudioSource` + `pmset` | `APP_DIRS` 平台条件化（Program Files / Start Menu） + `Start-Process` / `taskkill` / `keybd_event` VK_VOLUME_* / VK_MEDIA_* / VK_MEDIA_PLAY_PAUSE；DND/minimize/split/switchAudio 在非 darwin 返回 `{handled:false}` 让 LLM 兜底 | ✅（部分 stub） | "打开 chrome" / "关闭 notepad" / "音量调大" |
| **finderSelection.ts** | `tell application "Finder" ... selection` via `/usr/bin/osascript` | 非 darwin 返回 `{status:"unavailable"}` | ✅ | 设置页不再触发 Finder 选择 |
| **officecli.ts** | `getAssetName()` 非 darwin 抛错；`xattr -d`；`HOME` | 增加 `officecli-win-arm64.exe` / `officecli-win-x64.exe` 分支；`removeQuarantine` 跳过非 darwin；`USERPROFILE` + `HOME` | ✅ | `office_document` 工具在 Windows 上若上游未发 arm64 资产则降级为 stub |
| **globalShortcut.ts** | 只传 `mac` 块；错误串硬编码 `MacKeyServer`；显示名 `rightalt`→"RightOption" | 同时传 `mac` + `win` 块；错误串按平台切换 `MacKeyServer`/`WinKeyServer`；显示名 win 下 `leftmeta`→"LeftWin" | ✅ | 触发快捷键；日志中不出现 `MacKeyServer` 字样 |
| **index.ts playSound** | `afplay /System/Library/Sounds/<name>.aiff &` | win 下用 PowerShell `Media.SoundPlayer` 播 `C:\Windows\Media\<wav>.wav`（Tink→Windows Notify 等） | ✅ | 触发 push-to-talk，听到提示音 |
| **index.ts PATH** | `/opt/homebrew/bin` + `/usr/local/bin` 前置（`:` 分隔） | 仅 darwin 前置；win 不动 PATH（依赖 `getBundledBin` 解析） | ✅ | 启动日志无报错 |
| **index.ts accessibility URL** | `x-apple.systempreferences:...` | win 下 `ms-settings:privacy-microphone` | ✅ | 设置页"打开系统权限"按钮 |
| **index.ts Chrome pause** | AppleScript `execute t javascript` 遍历 Chrome 所有 tab 的 `<video>/<audio>` 并 `pause()` | win 下 `keybd_event(VK_MEDIA_PLAY_PAUSE)` 全局媒体键 | ✅（语义不同：toggle vs 精准暂停） | 录音时 Chrome 视频暂停 |
| **index.ts mute/unmute** | `osascript -e 'set volume with/without output muted'` | win 下不真静音系统（避免 toggle 状态错乱），仅发 VK_MEDIA_PLAY_PAUSE；unmute 是 no-op | ✅（已知限制） | 录音前后系统音量不变 |
| **index.ts whisper-cli 检测** | `which whisper-cli` + `/opt/homebrew/bin/whisper-cli` 兜底 | win 下 `where whisper-cli`；不再检查 `/opt/homebrew/bin` | ✅ | 设置页 Whisper 状态正常 |
| **floatWindow.ts / panelWindow.ts** | `setVisibleOnAllWorkspaces({visibleOnFullScreen:true})` + `setAlwaysOnTop(true,"screen-saver",1)` + `configureMacOSOverlay` | 已有的 `process.platform === "darwin"` guard 跳过 macOS 部分；Windows 仅靠 `setAlwaysOnTop` + `skipTaskbar` + `transparent` + `backgroundColor:"#00000000"` | ✅（受限） | 浮窗显示置顶；独占全屏不显示 |
| **settingsWindow.ts** | `titleBarStyle:"hiddenInset"` + `trafficLightPosition` | 仅 darwin 用 hiddenInset；win 用默认标题栏 + `autoHideMenuBar:true` | ✅ | 设置窗口有标准 min/max/close 按钮 |
| **dockVisibility.ts getTrayIcon** | 加载 `icon.icns` | 平台选 `icon.ico`（win）/ `icon.icns`（mac） | ✅ | 托盘图标正常 |
| **env.ts getBundledBin** | 候选包含 `/opt/homebrew/bin/<name>` | win 下追加 `<name>.exe` 候选；不再加 `/opt/homebrew/bin` | ✅ | `whisper-cli` 自动解析到 `assets/bin/whisper-cli.exe` |
| **assets/bin/whisper-cli** | Mach-O arm64 | `whisper-cli.exe` PE32+ x86-64（whisper.cpp v1.7.6） | ✅（x64 模拟） | `whisper-cli.exe -h` 在 Win11 ARM64 上运行 |
| **assets/bin/yt-dlp** | Mach-O universal | `yt-dlp.exe` PE32+ x86-64 | ✅（x64 模拟） | `yt-dlp.exe --version` 在 Win11 ARM64 上运行 |
| **assets/lib/*.dylib** | 4 个 macOS dylib | 4 个对应 .dll（`ggml-base` / `ggml-cpu` / `ggml` / `whisper`） | ✅ | whisper-cli.exe 启动不报缺 DLL |
| **assets/icon.ico** | 不存在（仅 .icns） | 由 Pillow 生成 7 分辨率 .ico | ✅ | NSIS 安装包图标 + 托盘图标正常 |
| **package.json** | 仅 `build.mac` | 新增 `build.win` + `nsis`；保留 `build.mac`；删 `@picovoice/porcupine-node`（未使用 + 无 win-arm64 预编译） | ✅ | `npm ci` 通过 |
| **daise.env.windows.example** | 不存在 | 新增无密钥模板，列出所有需要的变量名 | ✅ | 用户复制为 `daise.env` 填值 |
| **tools.ts / system-prompt.ts** | 描述里硬编码 "macOS X 应用"、"AppleScript" | 描述平台中性化；macOS 限定工具标注 "macOS 限定"；system-prompt 注入当前平台 + Windows 未支持工具列表 | ✅ | LLM 在 Windows 上正确拒绝调用 Notes/Reminders 等工具 |
| **WinKeyServer.exe** | 包内只发 `MacKeyServer` | `node-global-key-listener` 自带 `WinKeyServer.exe`（32-bit x86，Win11 ARM64 x86 模拟） | ✅（x86 模拟） | 全局快捷键能触发 |
| **代码签名** | `after-pack-sign.cjs` 用 `codesign` ad-hoc 签 .app | 早返回 `!== "darwin"`；Windows 不签名（v1） | ✅（已知限制） | 首次启动 SmartScreen 警告 |
| **渲染层 / preload / asr / tts / llm** | （跨平台） | 不动 | ✅ | 麦克采集、ASR、DeepSeek、Edge TTS 全部跨平台 |

## macOS ↔ Windows 功能差异矩阵

### 完整支持（与 macOS 一致）

- 快捷键模式（push-to-talk）
- 唤醒词模式（whisper.cpp + ggml-base.bin）
- 火山 ASR 流式转写
- DeepSeek LLM 双通道 JSON 输出
- Edge TTS 流式朗读 + 阅后即焚
- 悬浮球 / 设置窗口 / 答案面板三窗口
- 状态机（idle→listening→thinking→speaking→idle）
- 锁屏静默（powerMonitor lock-screen / unlock-screen）

### Windows 上 stub（返回 "Windows 暂不支持"）

- `create_note` / `search_notes` — macOS Notes.app 无 Windows 对应
- `create_reminder` — macOS Reminders.app 无 Windows 对应
- `create_calendar_event` / `get_calendar_events` — macOS Calendar.app 无 Windows 对应
- `send_email` / `read_unread_emails` / `get_recent_emails` / `search_emails` — macOS Mail.app 无 Windows 对应
- `switch_audio_output` — 需 Windows Core Audio 原生 helper
- `trim_video` / `convert_video` — 需打包 ffmpeg.exe
- `convert_document` / `office_document` / `edit_document` / `edit_pdf` — 依赖 LibreOffice / pandoc / weasyprint / python3-docx / PyMuPDF

### 行为差异（已实现但语义不完全相同）

- **音量静音**：macOS 真静音（`set volume with output muted`）；Windows 不静音系统，避免 toggle 状态错乱
- **Chrome 媒体暂停**：macOS 精准遍历每个 tab 的 `<video>/<audio>` 元素并 `pause()`；Windows 发全局 `VK_MEDIA_PLAY_PAUSE`（任何前台媒体都暂停）
- **悬浮球置顶**：macOS 用原生 N-API 把窗口置 NSScreenSaverWindowLevel+1；Windows 仅 `setAlwaysOnTop(true,"screen-saver",1)`，独占全屏游戏上不显示
- **计时器/闹钟声音**：macOS 用 `afplay` + `osascript display notification`；Windows 用 Electron `Notification` API（无声，仅 toast）
- **安装包**：macOS 是 `.dmg`（arm64）；Windows 是 NSIS `.exe`（arm64，未签名）

## 已知限制

1. **WinKeyServer.exe 是 32-bit x86**：靠 Windows 11 ARM64 的 x86 模拟运行；原生 arm64 版需要从 upstream `node-global-key-listener` 源码重建。
2. **whisper-cli.exe / yt-dlp.exe 是 x64**：靠 x64 模拟运行；短音频性能足够，长视频转写不推荐。
3. **未签名**：NSIS 安装包首次启动会触发 SmartScreen 警告，用户需点击"更多信息 → 仍要运行"。
4. **独占全屏覆盖**：游戏/视频独占全屏时悬浮球可能不显示（macOS 用原生 N-API 解决，Windows 未实现）。
5. **OfficeCLI**：上游 `iOfficeAI/OfficeCLI` 若未发布 `officecli-win-arm64.exe` 资产，`office_document` 系列工具会降级为 stub。
6. **Finder 选择读取**：Windows 上无对应；设置页不再读取 Explorer 选择。
7. **音频设备切换**：Windows Core Audio 需原生 helper，v1 stub。
8. **DND / 最小化所有窗口 / 分屏**：v1 stub；可后续用 Win32 API 实现。

## 改动文件清单

### 新增

- `scripts/build-native.cjs` — 平台分发的 native 模块构建
- `scripts/copy-renderer.cjs` — 跨平台复制 src/renderer → dist/renderer
- `scripts/clean.cjs` — 跨平台清理 dist/releases
- `src/main/control/platform.ts` — 平台分发器
- `src/main/control/windows.ts` — Windows 控制层（核心 14 工具 + 14 stub）
- `daise.env.windows.example` — 无密钥的 Windows 配置模板
- `assets/bin/whisper-cli.exe` — whisper.cpp v1.7.6 Windows x64
- `assets/bin/yt-dlp.exe` — yt-dlp 官方 Windows x64
- `assets/lib/ggml-base.dll` / `ggml-cpu.dll` / `ggml.dll` / `whisper.dll` — whisper 依赖
- `assets/icon.ico` — 由 `diri_app_icon.jpg` 通过 Pillow 生成的 7 分辨率 Windows 图标
- `WINDOWS-PORT.md` — 本文档

### 修改

- `package.json` — 删 `@picovoice/porcupine-node`；`build:native` 改用 `scripts/build-native.cjs`；`copy-renderer` / `clean` 改用 `.cjs` 脚本；新增 `dist:win`；新增 `build.win` + `nsis` 配置；`asarUnpack` 加 `assets/sounds/**`
- `src/main/control/finderSelection.ts` — 非 darwin 早返回 `{status:"unavailable"}`
- `src/main/control/officecli.ts` — `getAssetName` 加 win arm64/x64 分支；`getUserDataPath` 加 win `%APPDATA%` 回退；`getOfficeCliBinaryPath` win 加 `.exe`；`getOfficeCliEnvironment` 加 `USERPROFILE`；`removeQuarantine` 跳过非 darwin
- `src/main/config/env.ts` — `getBundledBin` 平台条件化候选路径（win 加 `.exe` 候选，不加 `/opt/homebrew/bin`）
- `src/main/llm/deepseek.ts` — `require("../control/macos")` → `require("../control/platform")`（2 处）
- `src/main/llm/tools.ts` — 描述平台中性化；macOS 限定工具加 "(macOS 限定)" 标记
- `src/main/llm/system-prompt.ts` — 注入当前平台；列出 Windows 未支持的工具；"不要自己编写系统脚本" 而非 "AppleScript"
- `src/main/command/router.ts` — `APP_DIRS` 平台条件化；新增 `resolveExeName` helper；`scanApps` win 分支（扫 .lnk / .exe）；`openApp` / `quitApp` / `quitAllBrowsers` 加 win 分支（`start` / `taskkill`）；`setVolume` / `controlPlayback` 加 win 分支（`keybd_event` VK_VOLUME_* / VK_MEDIA_*）；`setDoNotDisturb` / `minimizeAllWindowsExcept` / `minimizeApp` / `splitScreen` / `switchAudioOutput` / `pmset` 非 darwin 早返回；`saveClipboardImageToDesktop` win 用 PowerShell `[System.Windows.Forms.Clipboard]::GetImage()`；`getDefaultBrowserBundleId` 改从 `../control/platform` 导入
- `src/main/shortcut/globalShortcut.ts` — `GlobalKeyboardListener` 同时传 `mac` + `win` 块；错误串按平台切 `MacKeyServer`/`WinKeyServer`；`keyNameToDisplayName` 在 win 下把 `leftmeta`/`rightmeta` 显示为 `LeftWin`/`RightWin`
- `src/main/index.ts` — PATH 注入仅在 darwin；`ACCESSIBILITY_PREFERENCES_URL` 平台条件化；`playSound` win 用 PowerShell `Media.SoundPlayer` 播 `C:\Windows\Media\*.wav`；`muteSystemAndPauseMedia` win 发 `VK_MEDIA_PLAY_PAUSE`；`unmuteSystemOnly` win 是 no-op；`restoreMediaOnly` win 再发 `VK_MEDIA_PLAY_PAUSE`；whisper-cli 检测 `which` → `where`
- `src/main/windows/settingsWindow.ts` — `titleBarStyle` / `trafficLightPosition` 仅 darwin；win 加 `autoHideMenuBar`
- `src/main/windows/dockVisibility.ts` — `getTrayIcon` 平台选 `.ico` / `.icns`

### 删除（仅从工作副本排除，不影响 mac 分支）

- `assets/bin/whisper-cli`（Mach-O，已由 .exe 替代）
- `assets/bin/yt-dlp`（Mach-O，已由 .exe 替代）
- `assets/bin/daisy-window-selector`（Mach-O，win 上不用）
- `assets/bin/daisy-window-selector.node`（Mach-O，win 上不用）
- `assets/lib/*.dylib`（已由 .dll 替代）

## 可运行命令（在 Windows VM 内）

```powershell
Set-Location C:\work\Daisy-windows
npm ci
npm run build
npm run start                 # 开发启动
npm run dist:win              # 打 NSIS 安装包
# 安装包路径：
# C:\work\Daisy-windows\releases\win-arm64\Daisy Setup 2.1.5.exe
```

## 未解决问题及阻塞原因

无阻塞性问题。下列项为已知限制（不影响交付，可在后续版本迭代）：

1. WinKeyServer.exe 32-bit x86 — 需要从 upstream 重建 arm64 版本。
2. whisper-cli.exe / yt-dlp.exe x64 — 上游未发 win-arm64 原生包；可自行从源码编译。
3. NSIS 未签名 — 需要用户的 Authenticode 证书才能消除 SmartScreen 警告。
4. OfficeCLI win-arm64 资产 — 取决于上游 `iOfficeAI/OfficeCLI` 是否发布。

## 不与 macOS 版功能差异（再次确认）

macOS 版本完全未受影响：
- `main` 分支与 `dist:mac` 流程不变
- `build.mac` 配置不变
- `assets/icon.icns` 保留
- `native/window-selector.mm` / `.swift` 保留
- 所有 `process.platform === "darwin"` 分支保留原 macOS 行为
