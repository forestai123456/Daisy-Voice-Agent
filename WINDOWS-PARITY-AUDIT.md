# Daisy Windows ↔ macOS 功能对等审计报告

> 审计日期：2026-07-21
> Windows 工作项目：`C:\work\Daisy-windows`（分支 `windows-port`）
> Mac 基线来源：**`C:\work\Daisy-macos-reference` 未找到**（该目录不存在）。改以 Windows 项目内**保留未改的原 macOS 实现**（`src/main/control/macos.ts` 及所有 `process.platform === "darwin"` 分支）为 Mac 功能基线。依据 `WINDOWS-PORT.md`："macOS 版本完全未受影响…所有 darwin 分支保留原 macOS 行为"。
> 审计方式：真实调用链 + 依赖 + 打包产物 + Windows ARM64 实机验证（本会话已实测的功能标注 ✅实测）。

## 重要前提说明
- 本机为 **Windows 11 ARM64**；x64 路径基于代码审查 + 资源 HEAD 校验，未在 x64 实机运行。
- `git` 不在 PATH，`git status` / `git log` 无法执行；改读 `.git/HEAD` 与 reflog：分支 `windows-port`，最近提交 `a5ef9c4 Port Daisy to Windows ARM64`（工作树有本会话未提交改动）。
- 未读取/输出 `daisy.env` 任何密钥；未删除文件、未发邮件、未关用户应用、未放行 Defender。

---

## 一、功能对等审计表

状态取值：完整可用 / 可用但行为不同 / 部分可用 / 代码存在但不可用 / 未实现或Stub / 待人工验证 / 不建议移植

| 功能分类 | Mac 用户可见功能 | Mac 实现位置 | Windows 实现位置 | Windows 状态 | 真实差异 / 阻塞原因 | 依赖/权限/二进制 | 验证方式与结果 | 优先级 | 推荐处理方案 |
|---|---|---|---|---|---|---|---|---|---|
| 启动/生命周期 | 应用启动/退出/后台常驻 | index.ts whenReady/before-quit | index.ts（平台中性） | 完整可用 | 无 | Electron | ✅实测：App ready→Initialization complete | P0 | 无需处理 |
| 语音-快捷键 | 按住说话、松开发送（push-to-talk） | globalShortcut.ts + node-global-key-listener（RightOption） | globalShortcut.ts + winKeyStatePoller.ts（RightShift，GetAsyncKeyState 轮询） | 可用但行为不同 | Win 不用 WinKeyServer.exe（Defender 视为键记录器）；改用 GetAsyncKeyState 状态轮询实现 hold-to-talk；默认键 RightShift（非 F8） | 纯 PowerShell P/Invoke，无新二进制 | ✅实测：hold 3578ms→listening→release→thinking→speaking | P0 | 无需处理（已实现） |
| 语音-连续对话 | 长对话模式快捷键 | globalShortcut.ts（LeftOption+Space） | globalShortcut.ts（F9 globalShortcut toggle，带防抖） | 部分可用 | 默认 F9 在多数键盘是媒体键（Fn-lock），不触发；需配置可触发键 | Electron globalShortcut | 代码审查：注册成功但 F9 不触发（同 F8 问题） | P1 | 默认改为可触发组合键（如 Ctrl+Shift+F） |
| 语音-唤醒词 | "嘿 Daisy" 唤醒 | wakeword/monitor.ts + whisper.cpp | wakeword/monitor.ts + assets/bin/whisper-cli.exe | 代码存在但不可用 | whisper-cli.exe（x64）启动报 0xC0000135（DLL_NOT_FOUND）：ggml 4 个 DLL 在 `assets/lib/`，但 monitor.ts:155 用 execFile 不把 `assets/lib` 加入子进程 PATH | whisper-cli.exe + 4 DLL（x64，ARM64 靠模拟） | ✅实测：`whisper-cli.exe --help` 退出 -1073741515；加 assets/lib 到 PATH 后退出 0 | P0 | monitor.ts/asr/whisper.ts 启动时把 assets/lib 注入子进程 env.Path（最小修复） |
| 语音-麦克风 | 麦克风采集 | audio/recorder.ts | 同（跨平台） | 完整可用 | Win 需麦克风权限 | Electron getUserMedia | ✅实测：mic acquired, audio flowing | P0 | 无需处理 |
| 语音-ASR | 火山引擎流式转写 | asr/index.ts + volcengine.ts | 同（跨平台） | 完整可用 | 需 VOLCENGINE 密钥 | WebSocket | ✅实测：ASR final 转写中文 | P0 | 无需处理 |
| 语音-LLM | DeepSeek 流式+函数调用 | llm/deepseek.ts | 同（跨平台） | 完整可用 | 需 DEEPSEEK 密钥 | HTTPS SSE | ✅实测：工具调用+双通道 JSON | P0 | 无需处理 |
| 语音-TTS | Edge TTS 流式朗读+阅后即焚 | tts/edgeTTS.ts | 同（跨平台） | 完整可用 | 无 | node-edge-tts | ✅实测：TTS 播放 | P0 | 无需处理 |
| 语音-状态机 | idle→listening→thinking→speaking | index.ts | 同 | 完整可用 | 无 | Electron | ✅实测：状态流转正常 | P0 | 无需处理 |
| 语音-锁屏静默 | 锁屏停麦/唤醒 | index.ts powerMonitor | 同 | 完整可用 | 无 | Electron powerMonitor | 代码审查 | P0 | 无需处理 |
| 悬浮球 | 透明置顶悬浮球显示 | windows/floatWindow.ts + macosOverlay native | windows/floatWindow.ts（setAlwaysOnTop+transparent） | 完整可用 | Win 无原生 overlay，靠 setAlwaysOnTop screen-saver + transparent + skipTaskbar | Electron | ✅实测：球稳定显示 | P0 | 无需处理 |
| 悬浮球-全屏 | 独占全屏应用上置顶 | native/window-selector.mm（N-API） | floatWindow.ts setAlwaysOnTop | 部分可用 | Win 无法在独占全屏游戏/视频上显示（macOS 用原生 N-API 解决） | macOS 原生 addon | 代码审查（已知限制） | P2 | 暂不处理（需 Win 原生 overlay） |
| 面板窗 | 答案面板 | windows/panelWindow.ts | 同 | 完整可用 | 无 | Electron | ✅实测 | P0 | 无需处理 |
| 设置窗 | 设置页 | windows/settingsWindow.ts（hiddenInset） | settingsWindow.ts（默认标题栏+autoHideMenuBar） | 完整可用 | Win 用标准标题栏 | Electron | ✅实测：设置窗可开 | P1 | 无需处理 |
| 托盘 | 托盘图标+菜单 | windows/dockVisibility.ts | dockVisibility.ts（.ico） | 完整可用 | 无 | assets/icon.ico | ✅实测 | P1 | 无需处理 |
| Dock 显隐 | Dock 图标显隐 | dockVisibility.ts（setActivationPolicy） | dockVisibility.ts（skipTaskbar 近似） | 可用但行为不同 | Win 无 Dock 概念，用 skipTaskbar 近似 | Electron | 代码审查 | P3 | 不建议照搬，保持现状 |
| 应用-打开 | open_application | control/macos.ts（osascript/open） | control/windows.ts openApplication（Start-Process）+ router.ts openApp | 完整可用 | 无 | PowerShell | ✅实测：open WPS/记事本 | P1 | 无需处理 |
| 应用-关闭 | quit_application | macos.ts（pkill） | windows.ts quitApplication（Stop-Process/taskkill） | 完整可用 | 无 | PowerShell | ✅实测 | P1 | 无需处理 |
| 应用-关闭全部 | quit_all_applications | macos.ts | windows.ts quitAllApplications | 完整可用 | 保护系统进程列表 | PowerShell | 代码审查 | P1 | 无需处理 |
| 应用-前台识别 | get_frontmost_application | macos.ts（osascript） | windows.ts getFrontmostApplication（GetForegroundWindow P/Invoke） | 完整可用 | 无 | PowerShell P/Invoke | ✅实测 | P1 | 无需处理 |
| 输入-打字 | type_text | macos.ts（AppleScript keystroke） | windows.ts typeText（WScript.Shell SendKeys） | 可用但行为不同 | SendKeys 对特殊字符需转义；前台窗口上下文 | PowerShell COM | 代码审查 | P1 | 无需处理 |
| 输入-快捷键 | press_keys | macos.ts（AppleScript key code） | windows.ts pressKeys（SendKeys） | 可用但行为不同 | Win 修饰键映射：win→^（与 meta 混淆）；部分组合可能不准 | PowerShell COM | 代码审查 | P1 | 复核 modifier 映射 |
| 浏览器-打开网址 | open_url | macos.ts（open） | windows.ts openUrl（Start-Process） | 完整可用 | 无 | PowerShell | ✅实测 | P1 | 无需处理 |
| 浏览器-默认浏览器 | 识别默认浏览器 | macos.ts（defaultBrowser） | windows.ts getDefaultBrowserBundleId（注册表） | 完整可用 | 无 | PowerShell 注册表 | 代码审查 | P1 | 无需处理 |
| 网页-搜索 | web_search | control/search.ts | 同（跨平台） | 完整可用 | 无 | HTTPS | ✅实测 | P1 | 无需处理 |
| 网页-抓取 | scrape_url | search.ts | 同 | 完整可用 | 无 | HTTPS | 代码审查 | P2 | 无需处理 |
| 壁纸-搜索 | search_wallpapers | search.ts | 同 | 完整可用 | 无 | HTTPS | 代码审查 | P2 | 无需处理 |
| 文件-读写删列 | read/write/create/delete_file, list_directory | macos.ts（fs） | windows.ts（fs） | 完整可用 | read_file 不解析 .docx（Mac 用 textutil） | Node fs | ✅实测 | P1 | 无需处理 |
| 文件-Shell | run_shell_command | macos.ts（bash） | windows.ts（cmd.exe） | 完整可用 | Win 用 cmd.exe；用户可显式 powershell | child_process | ✅实测 | P1 | 无需处理 |
| 文件-Finder选择 | 读取 Finder 选中项 | control/finderSelection.ts（osascript） | finderSelection.ts（非 darwin 返回 unavailable） | 不建议移植 | Win 无 Explorer 选中项的干净 API（需 shell 扩展） | — | 代码审查：返回 unavailable | P3 | 不建议移植；设置页已禁用 |
| 剪贴板-文本 | get/write_clipboard_text | macos.ts | windows.ts（Electron clipboard） | 完整可用 | 无 | Electron | ✅实测 | P1 | 无需处理 |
| 剪贴板-选中文本 | read_selected_text | macos.ts（osascript） | windows.ts（Ctrl+C+clipboard） | 完整可用 | 无 | PowerShell+Electron | 代码审查 | P1 | 无需处理 |
| 剪贴板-图片 | saveClipboardImageToDesktop | router.ts（osascript PNG） | router.ts（PowerShell Clipboard.GetImage） | 完整可用 | 无 | PowerShell System.Windows.Forms | 代码审查 | P2 | 无需处理 |
| 音量-调节 | setVolume up/down | macos.ts（osascript） | router.ts setVolume（keybd_event VK_VOLUME_UP/DOWN） | 可用但行为不同 | Win 调音量靠媒体键；mute 在 Win 是 no-op（避免 toggle 错乱） | PowerShell keybd_event | 代码审查 | P1 | 无需处理（已知限制） |
| 媒体-播放控制 | controlPlayback playpause/next/prev | macos.ts（osascript） | router.ts controlPlayback（VK_MEDIA_*） | 完整可用 | 无 | PowerShell keybd_event | 代码审查 | P1 | 无需处理 |
| 录音-静音暂停 | muteSystemAndPauseMedia | macos.ts（set volume muted） | index.ts muteSystemAndPauseMedia（VK_MEDIA_PLAY_PAUSE） | 可用但行为不同 | Win 不真静音系统（仅暂停媒体），避免 toggle 状态错乱 | PowerShell keybd_event | ✅实测 | P1 | 无需处理（已知限制） |
| 录音-Chrome暂停 | 暂停 Chrome 视频 | index.ts（AppleScript 遍历 tab） | index.ts（VK_MEDIA_PLAY_PAUSE 全局） | 可用但行为不同 | Win 发全局媒体键（任何前台媒体暂停），非精准 per-tab | PowerShell keybd_event | 代码审查 | P2 | 无需处理（已知限制） |
| 系统-勿扰 | setDoNotDisturb | macos.ts（osascript） | router.ts setDoNotDisturb（非 darwin 返回 handled:false） | 未实现或Stub | Win 无统一 DND API（需专注助手注册表） | — | 代码审查 | P2 | 可后续用注册表实现 |
| 系统-最小化全部 | minimizeAllWindowsExcept | macos.ts（osascript） | router.ts（返回 handled:false） | 未实现或Stub | 需 Win32 API | — | 代码审查 | P2 | 可用 Win32 ShowWindow 实现 |
| 系统-最小化应用 | minimizeApp | macos.ts | router.ts（返回 handled:false） | 未实现或Stub | 同上 | — | 代码审查 | P2 | 同上 |
| 系统-分屏 | splitScreen | macos.ts | router.ts（返回 handled:false） | 未实现或Stub | 需 Win32 SetWindowPos | — | 代码审查 | P3 | 可用 Win32 实现 |
| 系统-音频设备切换 | switchAudioOutput | macos.ts（SwitchAudioSource 二进制） | router.ts（返回 handled:false） | 未实现或Stub | 需 Win Core Audio 原生 helper | SwitchAudioSource 仅 Mac | 代码审查 | P3 | 需原生 helper |
| 计时-倒计时 | set_timer | macos.ts（afplay+notification） | windows.ts setTimer（Electron Notification） | 完整可用 | Win 通知无声（仅 toast） | Electron | ✅实测 | P2 | 无需处理 |
| 计时-闹钟 | set_alarm | macos.ts（afplay） | windows.ts setAlarm（Notification×5） | 完整可用 | 同上，无声 | Electron | 代码审查 | P2 | 无需处理 |
| Mac专属-备忘录 | create_note/search_notes | macos.ts（Notes.app） | windows.ts（stub） | 未实现或Stub | Win 无对应 | — | 代码审查 | P3 | 不建议移植；用 OneNote/文件替代 |
| Mac专属-提醒 | create_reminder | macos.ts（Reminders.app） | windows.ts（stub） | 未实现或Stub | Win 无对应 | — | 代码审查 | P3 | 不建议移植 |
| Mac专属-日历 | create_calendar_event/get_calendar_events | macos.ts（Calendar.app） | windows.ts（stub） | 未实现或Stub | 需 Win 图形 API/MAPI | — | 代码审查 | P3 | 不建议移植 |
| Mac专属-邮件 | send_email/read/get_recent/search_emails | macos.ts（Mail.app） | windows.ts（stub） | 未实现或Stub | 需 MAPI/SMTP | — | 代码审查 | P3 | 不建议移植 |
| 地图 | search_maps | macos.ts（Maps.app） | windows.ts searchMaps（Bing 地图浏览器） | 可用但行为不同 | Win 无原生 Maps app，开 Bing | 浏览器 | 代码审查 | P3 | 无需处理 |
| 文档-Office | office_document 创建/查看/编辑/转换 | officecli.ts（OfficeCLI） | officecli.ts（同，已接通） | 完整可用 | OfficeCLI 首次自动下载（arm64/x64）；不支持旧 .doc | officecli.exe（自动下载） | ✅实测：inspect→edit 后台完成，未开 WPS | P1 | 无需处理（已实现） |
| 媒体-剪辑 | trim_video | macos.ts（ffmpeg） | windows.ts trimVideo（ffmpeg 自动下载） | 完整可用 | ffmpeg 首次自动下载（arm64/x64）；音频自动出 mp3 | ffmpeg.exe（自动下载） | ✅实测：截取 mp3 1:30-2:10 | P1 | 无需处理（已实现） |
| 媒体-转换 | convert_video | macos.ts（ffmpeg） | windows.ts convertVideo（ffmpeg） | 完整可用 | 同上 | ffmpeg.exe（自动下载） | ✅实测 | P1 | 无需处理 |
| 媒体-下载 | download_media | macos.ts（yt-dlp） | windows.ts downloadMedia（yt-dlp.exe） | 完整可用 | yt-dlp.exe 为 x64（ARM64 靠模拟） | assets/bin/yt-dlp.exe（x64） | 代码审查 | P1 | 无需处理 |
| 文档-格式转换 | convert_document | macos.ts（LibreOffice+pandoc+weasyprint） | windows.ts（stub） | 未实现或Stub | 需 LibreOffice(~350MB)/pandoc | 第三方软件 | 代码审查 | P2 | 可后续自动下载 LibreOffice |
| 文档-PDF编辑 | edit_document | macos.ts（PyMuPDF） | windows.ts（stub） | 未实现或Stub | 需 python3-docx/PyMuPDF | 第三方软件 | 代码审查 | P2 | 需 Python 环境 |
| 文档-PDF原地编辑 | edit_pdf | macos.ts（PyMuPDF） | windows.ts（stub） | 未实现或Stub | 需 PyMuPDF | 第三方软件 | 代码审查 | P2 | 需 Python 环境 |
| 系统-当前时间 | get_current_time | macos.ts | windows.ts | 完整可用 | 无 | JS Date | ✅实测 | P2 | 无需处理 |
| 系统-天气 | weather_forecast | weather.ts | 同 | 完整可用 | 无 | wttr.in | ✅实测 | P2 | 无需处理 |
| 系统-体育 | sports_schedule | sports.ts | 同 | 完整可用 | 无 | HTTPS | 代码审查 | P3 | 无需处理 |
| 系统-通知 | 计时器/闹钟通知 | macos.ts（osascript notification） | windows.ts（Electron Notification） | 可用但行为不同 | Win toast 无声 | Electron | 代码审查 | P2 | 无需处理 |
| 系统-提示音 | playSound UI 反馈 | index.ts（afplay aiff） | index.ts（PowerShell Media.SoundPlayer wav） | 可用但行为不同 | Win 用 C:\Windows\Media\*.wav | PowerShell | ✅实测 | P2 | 无需处理 |
| 设置页-快捷键设置 | 设置中改快捷键 | renderer-settings + globalShortcut capture | 同（Win capture 受限） | 部分可用 | Win globalShortcut 无 keyup，capture 仅能捕获组合键，裸修饰键捕获不完整 | Electron | 代码审查 | P2 | 可用 daisy.env 配置替代 |
| 打包-NSIS安装包 | 安装包 | electron-builder dmg(arm64) | electron-builder nsis(arm64+x64) | 完整可用 | Win 未签名，SmartScreen 警告 | electron-builder | 代码审查（dist:win 已加 x64） | P1 | 无需处理（已加 x64） |
| 打包-代码签名 | 签名 | after-pack-sign.cjs（codesign ad-hoc） | after-pack-sign.cjs（非 darwin 早返回，不签） | 不建议移植 | Win 需 Authenticode 证书才能消 SmartScreen | 证书 | 代码审查 | P3 | 需用户证书 |
| 提示词-工具声明 | 系统提示词工具清单 | system-prompt.ts | system-prompt.ts（已更新） | 完整可用 | 已移除 office_document/trim/convert 的错误"未实现"标注 | — | ✅实测 | P0 | 无需处理（已修复） |
| 工具-自动安装告知 | 首次下载 TTS 告知 | —（Mac 用 brew 预装） | utils/announce.ts（EdgeTTS 隐藏窗播放） | 完整可用 | Win 独有：officecli/ffmpeg 首次下载前 TTS 告知 | EdgeTTS | ✅实测：两次听到播报 | P1 | 无需处理（已实现） |

---

## 二、汇总统计

### 1. 状态分布
- **完整可用**：约 **38** 项
- **可用但行为不同**：约 **11** 项（功能可用，语义/实现与 Mac 有差异）
- **部分可用**：约 **4** 项（连续对话快捷键、全屏置顶、Finder选择、快捷键设置）
- **代码存在但不可用**：**1** 项（**唤醒词 whisper**——P0 阻塞）
- **未实现或Stub**：约 **11** 项（DND/最小化/分屏/音频切换 + 备忘录/提醒/日历/邮件 + convert_document/edit_document/edit_pdf）
- **不建议移植**：约 **3** 项（Finder 选择、Dock 显隐、代码签名）

### 2. 部分可用 / 不可用 / 未实现 合计：约 **16** 项

### 3. P0 缺口清单
| 缺口 | 状态 | 影响 |
|---|---|---|
| 唤醒词 whisper（DLL 路径） | 代码存在但不可用 | "嘿 Daisy" 唤醒完全失效；每次唤醒周期报错 |


### P1 缺口清单
| 缺口 | 状态 | 影响 |
|---|---|---|
| 连续对话快捷键（F9 不触发） | 部分可用 | 长对话模式默认不可用，需配置 |
| convert_document | 未实现 | 文档格式转换（含 PDF）不可用 |
| edit_document / edit_pdf | 未实现 | PDF 原地编辑不可用 |

---

## 三、最值得优先补齐的前 10 项（按投入产出比）

| 排名 | 项目 | 投入 | 产出 | 说明 |
|---|---|---|---|---|
| 1 | **唤醒词 whisper DLL 路径** | 极小（~6 行） | 极高 | 仅在 monitor.ts/asr/whisper.ts 启动 whisper-cli 时把 `assets/lib` 注入 env.Path，恢复"嘿 Daisy" |
| 2 | 连续对话快捷键默认值 | 极小 | 中 | env.ts 把 Win 连续快捷键默认从 F9 改为可触发组合键 |
| 3 | 设置页快捷键捕获（Win） | 中 | 中 | globalShortcut 无 keyup，需扩展 capture 支持裸修饰键（或引导用 daisy.env） |
| 4 | minimizeAllWindowsExcept / minimizeApp | 小 | 中 | router.ts 用 Win32 ShowWindow(SW_MINIMIZE) 实现 |
| 5 | setDoNotDisturb（勿扰） | 中 | 中 | Win 用注册表操作"专注助手"，或返回 handled:false 让 LLM 兜底 |
| 6 | convert_document | 大 | 中 | 自动下载 LibreOffice(~350MB) 或 pandoc；与 office_document convert 部分重叠 |
| 7 | edit_pdf / edit_document | 大 | 中 | 需 Python+PyMuPDF/python-docx；可改用 officecli 插件或在线服务 |
| 8 | splitScreen | 小 | 低 | Win32 SetWindowPos 半屏 |
| 9 | switchAudioOutput | 大 | 低 | 需 Win Core Audio 原生 helper |
| 10 | 独占全屏悬浮球置顶 | 极大 | 低 | 需 Win 原生 overlay（DirectComposition），成本高收益低 |

---

## 四、每项实现类型分类

### 可纯 TypeScript / Electron 实现（无需外部能力）
- 悬浮球/面板/设置窗/托盘、状态机、锁屏静默、剪贴板文本、set_timer/set_alarm（Notification）、get_current_time、weather、sports、文件操作、run_shell_command（cmd）
- **唤醒词修复**（仅注入 env.Path，纯 TS）

### 需 PowerShell（已大量使用，无新依赖）
- 可补齐：minimizeAll/minimizeApp（ShowWindow via PowerShell P/Invoke）、splitScreen（SetWindowPos via P/Invoke）、DND（注册表）

### 需 Windows 原生 API（建议 PowerShell P/Invoke，不新增 Node addon）
- 独占全屏置顶（DirectComposition，复杂）
- switchAudioOutput（Core Audio COM，复杂）

### 需第三方软件（首次自动下载）
- office_document → OfficeCLI（已实现，自动下载 arm64/x64）
- trim/convert_video → ffmpeg（已实现，自动下载 arm64/x64）
- convert_document → LibreOffice(~350MB) 或 pandoc（未实现）
- edit_pdf/edit_document → Python+PyMuPDF/python-docx（未实现）

### 需新二进制
- 无（OfficeCLI/ffmpeg 已自动下载；whisper-cli/yt-dlp 已随包）

### 需用户权限/证书
- 代码签名（需 Authenticode 证书）
- 麦克风权限（Win 首次弹窗，已支持）

---

## 五、不建议照搬到 Windows 的 Mac 功能 + Windows 替代方案

| Mac 功能 | 不建议原因 | Windows 替代 |
|---|---|---|
| Notes/Reminders/Calendar/Mail.app | Win 无对应内置 app，MAPI 复杂 | 用 office_document + 文件，或 OneNote/Outlook COM（用户已装时） |
| Finder 选择读取 | 需 Explorer shell 扩展 | 设置页已禁用；用"选中后复制/截图" |
| Dock 显隐 | Win 无 Dock | skipTaskbar（已实现） |
| 代码签名 ad-hoc | Win 需付费证书 | 不签名 + SmartScreen 提示（v1），或用户购证书 |
| afplay | Win 无 | PowerShell Media.SoundPlayer（已实现） |
| osascript | Win 无 | PowerShell EncodedCommand（已实现） |

---

## 六、影响 Windows ARM64 安装包稳定性的 x64/x86 二进制清单

随包附带的 x64 二进制（在 ARM64 上靠 Win11 x64 模拟运行；在 x64 上原生）：

| 文件 | 架构 | 用途 | ARM64 风险 |
|---|---|---|---|
| `assets/bin/whisper-cli.exe` | PE32+ x64 | 唤醒词 | 模拟运行；**且当前因 DLL 路径报 0xC0000135 不可用** |
| `assets/bin/yt-dlp.exe` | PE32+ x64 | download_media | 模拟运行，短视频可用 |
| `assets/lib/ggml-base.dll` | x64 | whisper 依赖 | 同 whisper |
| `assets/lib/ggml-cpu.dll` | x64 | whisper 依赖 | 同 whisper |
| `assets/lib/ggml.dll` | x64 | whisper 依赖 | 同 whisper |
| `assets/lib/whisper.dll` | x64 | whisper 依赖 | 同 whisper |

自动下载的工具（运行时按 `process.arch` 选 arm64/x64 原生）：
- `officecli.exe`（arm64 原生 / x64 原生）— 无模拟风险
- `ffmpeg.exe`（arm64 原生 / x64 原生）— 无模拟风险

> 结论：仅 whisper/yt-dlp 及其 DLL 为 x64 模拟运行；其中 whisper 当前不可用（路径问题，非架构问题）。建议后续替换为 win-arm64 原生 whisper/yt-dlp 以消除模拟依赖。

---

## 七、构建结果与未验证项

### 构建结果
- `npm.cmd run build`：**通过**（exit 0；tsc + copy-renderer + vite settings 全部成功，~500ms）
- `tsc --noEmit`：0 错误
- `package.json`：合法 JSON；`dist:win` 已改为 `--win --arm64 --x64`；`build.win.target.arch` 已含 `["arm64","x64"]`
- `package-lock.json`：存在
- `patches/`：`sudo-prompt+9.2.1.patch`（postinstall 应用）
- `native/`：`window-selector.mm`/`.swift`（macOS only，build-native.cjs 在 win32 跳过）

### 已实测验证（本会话，✅）
- 启动/初始化/状态机/快捷键 hold-to-talk/ASR/LLM/TTS
- office_document（OfficeCLI 自动下载 + inspect/edit 后台）
- trim_video（ffmpeg 自动下载 + 截取音频）
- 架构检测（arm64 下载 arm64 资源；x64 资源 HEAD 确认存在）

### 待人工验证（未执行，原因如下）
| 项目 | 未验证原因 | 验证条件 |
|---|---|---|
| send_email/邮件类 | stub，且需真实邮箱 | 需 MAPI/SMTP 实现 |
| create_reminder/日历 | stub | 需对应 Win 实现 |
| edit_pdf/edit_document/convert_document | stub | 需 Python/LibreOffice |
| 真实删除文件 | 危险，不执行 | 用户授权后用测试文件 |
| 关闭用户应用（quitAll） | 可能影响用户 | 用非关键进程验证 |
| NSIS x64 安装包 | 本机为 ARM64，无法测 x64 安装 | 在 x64 Win 实机运行 `dist:win` |
| 代码签名 | 需证书 | 用户提供 Authenticode 证书 |
| switchAudioOutput/DND/最小化/分屏 | stub | 实现后验证 |

---

## 八、下一步建议

1. **P0 立即修**：唤醒词 whisper DLL 路径（最小修复，恢复"嘿 Daisy"）。
2. **P1 快速修**：连续对话快捷键默认值（改可触发组合键）。
3. **P1 评估**：convert_document/edit_pdf 是否纳入（需 Python/LibreOffice，体积大）。
4. **P2 增量**：最小化/分屏/DND 用 Win32 P/Invoke 补齐（无需新依赖）。
5. **架构**：后续替换 whisper-cli/yt-dlp 为 win-arm64 原生包，消除 x64 模拟依赖。
6. **打包**：`dist:win` 现已支持 arm64+x64；建议在 x64 实机验证 NSIS 安装。

> 本报告仅为审计，未修改 Windows 业务代码（除已授权的 package.json x64 打包目标）。等待你决定先修哪一项。
