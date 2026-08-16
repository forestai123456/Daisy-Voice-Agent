import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import https from "node:https";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { app, ipcMain, Menu, BrowserWindow, screen, clipboard, dialog, shell, systemPreferences } from "electron";
import { autoUpdater } from "electron-updater";
import { config, isAsrConfigured, isLlmConfigured, getWhisperModelPath, getBundledBin, WHISPER_MODELS, getWritableEnvPath } from "./config/env";
import { IPC_CHANNELS } from "./ipc/channels";
import { createFloatWindow, getFloatWindow, sendToFloatWindow, showFloatWindow, hideFloatWindow } from "./windows/floatWindow";
import { createPanelWindow, ensurePanelWindow, getPanelWindow, showPanelWindow, hidePanelWindow, sendToPanelWindow } from "./windows/panelWindow";
import { createSettingsWindow, getSettingsWindow } from "./windows/settingsWindow";
import { initializeDockVisibility, setDockVisibility, syncDockVisibility } from "./windows/dockVisibility";
import { initAudioRecorder, ensureAudioWindow, startRecording, stopRecording, getIsRecording, setWakeWordCaptureEnabled, getAudioWindow } from "./audio/recorder";
import { AsrSession } from "./asr";
import { WhisperAsrSession } from "./asr/whisper";
import { DeepSeekClient, cleanTextForTTS, type DualChannel } from "./llm/deepseek";
import { ConversationManager } from "./llm/conversation";
import { EdgeTTSPlayer, startTTSCleanup, stopTTSCleanup } from "./tts/edgeTTS";
import { GlobalShortcut } from "./shortcut/globalShortcut";
import { WakeWordMonitor, VAD } from "./wakeword/monitor";
import { tryLocalCommand, initCommandRouter } from "./command/router";
import {
  formatFinderSelectionContext,
  getSelectedFinderItems,
  allowsMultipleSelectedFinderItems,
  isSelectedFinderItemReference,
  warmupExplorerSelection,
  type FinderSelectionResult,
} from "./control/finderSelection";
import { log, logDebug, logError } from "./utils/logger";

{
  if (process.platform === "darwin") {
    const pathParts = (process.env.PATH || "").split(":").filter(Boolean);
    for (const p of ["/opt/homebrew/bin", "/usr/local/bin"]) {
      if (!pathParts.includes(p)) pathParts.unshift(p);
    }
    process.env.PATH = pathParts.join(":");
  }
  // Windows: no PATH manipulation needed; bundled binaries resolve via getBundledBin.
}

// Daisy's short TTS clips are UI feedback, not media playback. Chromium would
// otherwise publish every <audio> element to Windows System Media Transport
// Controls, which makes Windows show the media-player flyout for each reply.
// These switches must be registered before Electron is ready.
if (process.platform === "win32") {
  app.commandLine.appendSwitch(
    "disable-features",
    "HardwareMediaKeyHandling,MediaSessionService",
  );
}

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const AUTO_HIDE_TIMEOUT_MS = 500;
const CONVERSATION_EXPIRE_MS = 3 * 60 * 1000; // 3 minutes
const ACCESSIBILITY_PREFERENCES_URL = process.platform === "win32"
  ? "ms-settings:privacy-microphone"
  : "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const SHORTCUT_LISTENER_MAX_RESTARTS = 5;
const SHORTCUT_LISTENER_RESTART_BASE_DELAY_MS = 1500;

// Persistent hidden window for near-instant UI sound playback on Windows.
// PowerShell startup (~2.5s) is far too slow for UI feedback, so Windows
// sounds are played via a Chromium <audio> element in floatWindow's webContents.
// The base64 data URL avoids file:// cross-origin restrictions.
const soundCache = new Map<string, string>();
const SOUND_MAP_WIN: Record<string, string> = {
  Tink: "Windows Startup",
  Purr: "Windows Pop-up Blocked",
  Frog: "Speech Sleep",
  Send: "Windows Minimize",
  Pop: "notify",
  Glass: "Windows Notify",
  Hero: "Windows Notify",
  Submarine: "Windows Critical Stop",
};

function getSoundDataUrl(name: string): string | null {
  if (soundCache.has(name)) return soundCache.get(name)!;
  const wav = SOUND_MAP_WIN[name] || "Windows Notify";
  const file = `C:\\Windows\\Media\\${wav}.wav`;
  try {
    if (!fs.existsSync(file)) return null;
    const b64 = fs.readFileSync(file).toString("base64");
    const url = `data:audio/wav;base64,${b64}`;
    soundCache.set(name, url);
    return url;
  } catch {
    return null;
  }
}

function playSound(name: string): void {
  if (process.platform === "darwin") {
    exec(`afplay /System/Library/Sounds/${name}.aiff &`);
    return;
  }
  if (process.platform === "win32") {
    const url = getSoundDataUrl(name);
    if (!url) return;
    const win = getFloatWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents
      .executeJavaScript(`new Audio(${JSON.stringify(url)}).play().catch(() => {})`)
      .catch(() => {});
    return;
  }
}

let asrSession: AsrSession | WhisperAsrSession | null = null;
let llmClient: DeepSeekClient | null = null;
let isSystemMutedByApp = false;
let pausedChromeTabs: string[] = [];
let ttsPlayer: EdgeTTSPlayer | null = null;
let globalShortcut: GlobalShortcut | null = null;
let conversationManager: ConversationManager | null = null;
let autoHideTimer: NodeJS.Timeout | null = null;
let safetyNetTimer: NodeJS.Timeout | null = null;
let isOrbVisible = false;
let currentAiResponse = "";
let isSpeaking = false;
let isPanelSticky = false;
let currentPlayingFile: string | null = null;
let ttsFileQueue: string[] = [];  // queued TTS file paths ready to play
let activeTtsSynthesisSessionId: number | null = null;  // tracks which session is synthesizing
let currentTtsPlayToken = 0;  // increments each time a new TTS file is sent to renderer
let playingTtsSessionId: number | null = null;  // session ID when TTS playback started
let toolAckPending = false;
let pendingFinalResponse: string | null = null;
let wakeWordMonitor: WakeWordMonitor | null = null;
let currentSessionId = 0;  // increments on each new session, used to detect stale async callbacks
let isScreenLocked = false;
let activeMutePromise: Promise<void> | null = null;
let accessibilityAuthorizationPoll: NodeJS.Timeout | null = null;
let shortcutListenerRestartTimer: NodeJS.Timeout | null = null;
let shortcutListenerStabilityTimer: NodeJS.Timeout | null = null;
let shortcutListenerRestartAttempts = 0;
let finderSelectionCapture: { sessionId: number; promise: Promise<FinderSelectionResult> } | null = null;
let runtimeStarted = false;
let ipcHandlersRegistered = false;
const WINDOWS_INITIAL_SETUP_MARKER = "windows-initial-setup-shown-1.6.0";

// Windows customers commonly launch Daisy again from the Start menu when the
// first launch is still in the background.  Without a single-instance lock
// that second launch exits silently, which looks exactly like a broken
// installation.  Always bring the existing UI forward instead.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!app.isReady()) return;
    createSettingsWindow(true);
  });
}

app.whenReady().then(() => {
  log("App ready");

  // Register IPC before starting the runtime.
  setupIpc();

  initializeDockVisibility(config.showDockIcon, persistDockVisibilityPreference);
  startRuntime(false);

  // macOS-specific menu + Dock setup (after runtime start for dev).
  if (process.platform === "darwin") {
    // Register standard editing shortcuts menu for macOS to allow Cmd+C, Cmd+A in focusable windows
    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: "about", label: "关于 Daisy" },
          { type: "separator" },
          { role: "hide", label: "隐藏 Daisy" },
          { role: "hideOthers", label: "隐藏其他" },
          { role: "unhide", label: "显示全部" },
          { type: "separator" },
          { role: "quit", label: "退出 Daisy" }
        ]
      },
      {
        label: "编辑",
        submenu: [
          { role: "undo", label: "撤销" },
          { role: "redo", label: "重做" },
          { type: "separator" },
          { role: "cut", label: "剪切" },
          { role: "copy", label: "复制" },
          { role: "paste", label: "粘贴" },
          { role: "selectAll", label: "全选" }
        ]
      }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  }
  // Sync auto-launch setting on startup
  if (config.autoLaunch) {
    app.setLoginItemSettings({ openAtLogin: true });
  }
  startTTSCleanup();
  // On macOS, overlays must be born as UIElement windows in order to join a
  // different application's fullscreen Space. Daisy returns to regular mode
  // immediately after these hidden windows have been created.
  if (process.platform === "darwin") {
    app.setActivationPolicy("accessory");
  }
  // The runtime was initialized above.

  // The overlay windows opt into macOS's fullscreen-workspace behaviour. Keep
  // a hidden-Dock installation as an accessory app after initialization;
  // forcing it back to regular would make macOS restore its Dock icon.
  if (process.platform === "darwin") {
    app.setActivationPolicy(config.showDockIcon ? "regular" : "accessory");
    syncDockVisibility(true);
  }

  // A development launch needs a visible entry point.  The normal customer
  // build intentionally starts in the background, while the separately
  // installed "Daisy Dev.app" should immediately show the settings window.
  const isDaisyDevBundle = process.platform === "darwin"
    && app.getPath("exe").includes("/Daisy Dev.app/");
  if (!app.isPackaged || isDaisyDevBundle) {
    createSettingsWindow();
  }

  // A global key listener cannot receive keyboard events on macOS until the
  // user grants Accessibility access. Request the microphone through macOS
  // and then take first-time customers directly to the matching settings pane.
  // Do not run this in Daisy Dev: its separate ad-hoc identity would create
  // unnecessary permission prompts during development.
  if (app.isPackaged && !isDaisyDevBundle) {
    requestInitialMacPermissions();
  }
}).catch((error) => {
  // Never leave a packaged application apparently doing nothing.  The log is
  // retained for support, while the dialog gives the customer an immediate,
  // human-visible failure signal.
  logError("Fatal startup error", error);
  dialog.showErrorBox("Daisy 启动失败", "Daisy 未能正常启动。请重启程序；如果问题持续，请将日志发送给客服。\n\n日志位置：%APPDATA%\\Daisy\\logs");
});

app.on("window-all-closed", () => {
  // Keep running in the background with the tray available.
});

app.on("activate", () => {
  if (!getFloatWindow() || getFloatWindow()!.isDestroyed()) {
    createFloatWindow();
  }
  createSettingsWindow();
});

app.on("before-quit", () => {
  if (accessibilityAuthorizationPoll) {
    clearInterval(accessibilityAuthorizationPoll);
    accessibilityAuthorizationPoll = null;
  }
  if (shortcutListenerRestartTimer) {
    clearTimeout(shortcutListenerRestartTimer);
    shortcutListenerRestartTimer = null;
  }
  if (shortcutListenerStabilityTimer) {
    clearTimeout(shortcutListenerStabilityTimer);
    shortcutListenerStabilityTimer = null;
  }
  globalShortcut?.destroy();
  asrSession?.stop();
  wakeWordMonitor?.stop();
  stopTTSCleanup();
  // Clean up TTS temp files
  const ttsDir = path.join(require("os").tmpdir(), "diri-tts");
  try {
    if (fs.existsSync(ttsDir)) {
      for (const f of fs.readdirSync(ttsDir)) {
        if (f.startsWith("diri-tts-") && f.endsWith(".mp3")) {
          fs.unlinkSync(path.join(ttsDir, f));
        }
      }
    }
  } catch { /* ignore */ }
  if (safetyNetTimer) {
    clearTimeout(safetyNetTimer);
    safetyNetTimer = null;
  }
});

function logMemStep(stepName: string): void {
  const mem = process.memoryUsage();
  log(`[MEM_STEP] ${stepName}: Main RSS=${(mem.rss / 1024 / 1024).toFixed(2)}MB | HeapUsed=${(mem.heapUsed / 1024 / 1024).toFixed(2)}MB | External=${(mem.external / 1024 / 1024).toFixed(2)}MB`);
}

function startRuntime(openSettingsAfterStart = false): void {
  if (runtimeStarted) return;
  runtimeStarted = true;
  log("Initializing...");
  logMemStep("01_start_runtime");
  log(`ASR configured: ${isAsrConfigured()}, LLM configured: ${isLlmConfigured()}, shortcutUseWhisper: ${config.whisper.shortcutUseWhisper}`);
  createFloatWindow();
  logMemStep("02_after_floatWindow");
  // Pre-warm the Windows File Explorer selection reader (persistent STA
  // PowerShell) so the first "处理选中的文件" capture is near-instant.
  warmupExplorerSelection();
  logMemStep("03_after_warmupExplorer");

  setupIpc();
  logMemStep("04_after_setupIpc");
  setupAudio();
  logMemStep("05_after_setupAudio");
  setupShortcut();
  logMemStep("06_after_setupShortcut");
  setupWakeWord();
  logMemStep("07_after_setupWakeWord");
  setupPowerMonitor();
  logMemStep("08_after_setupPowerMonitor");
  initCommandRouter();
  logMemStep("09_after_initCommandRouter");
  loadConversationHistory();
  logMemStep("10_after_loadHistory");
  log("Initialization complete");

  if (process.env.DAISY_LOG_METRICS === "1") {
    setInterval(() => {
      const list = getDetailedProcessMetrics();
      const str = list.map(item => `PID ${item.pid} [${item.role}]: CPU=${item.cpuPercent.toFixed(2)}%`).join(" | ");
      log(`[PERF_METRICS] ${str}`);
    }, 1000);
  }

  if (process.env.DAISY_OPEN_SETTINGS === "1") {
    setTimeout(() => {
      log("[test] Opening settings window via DAISY_OPEN_SETTINGS env");
      createSettingsWindow(true);
    }, 3000);
  }





  // A Windows installer launches Daisy when it completes.  Show the setup UI
  // on that first packaged launch instead of starting invisibly in the tray.
  // The marker prevents the window from opening again on every later launch
  // (including launch-at-login).
  const shouldShowInitialWindowsSettings = consumeInitialWindowsSetupMarker();

  // On first packaged Windows launch, show settings so the user can configure services.
  if (openSettingsAfterStart || shouldShowInitialWindowsSettings) {
    createSettingsWindow(true);
  }
}

function consumeInitialWindowsSetupMarker(): boolean {
  if (process.platform !== "win32" || !app.isPackaged) return false;

  try {
    const markerPath = path.join(app.getPath("userData"), WINDOWS_INITIAL_SETUP_MARKER);
    if (fs.existsSync(markerPath)) return false;
    fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`, "utf-8");
    log("[setup] First packaged Windows launch: opening settings window");
    return true;
  } catch (error) {
    // Failing open is better than leaving a new customer without a visible
    // setup path. The tray remains available as a fallback.
    logError("Unable to persist Windows initial-setup marker", error);
    return true;
  }
}

function requestInitialMacPermissions(): void {
  if (process.platform !== "darwin") return;

  const microphoneStatus = systemPreferences.getMediaAccessStatus("microphone");
  const accessibilityTrusted = systemPreferences.isTrustedAccessibilityClient(false);
  if (microphoneStatus !== "not-determined" && accessibilityTrusted) return;

  void (async () => {
    try {
      const { response } = await dialog.showMessageBox({
        type: "info",
        title: "完成 Daisy 权限授权",
        message: "首次使用需要授权麦克风和辅助功能",
        detail: "麦克风用于识别语音指令；辅助功能用于全局快捷键。点击“开始授权”后，Daisy 会先请求麦克风权限，再自动打开“辅助功能”设置页，请在 Daisy 右侧开启开关。",
        buttons: ["稍后", "开始授权"],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) return;

      if (microphoneStatus === "not-determined") {
        const granted = await systemPreferences.askForMediaAccess("microphone");
        log(`Initial permission guide: microphone granted=${granted}`);
      }

      if (!systemPreferences.isTrustedAccessibilityClient(false)) {
        // `true` asks macOS to show its native Accessibility prompt. Opening
        // the pane as well avoids leaving non-technical users to find it.
        systemPreferences.isTrustedAccessibilityClient(true);
        await shell.openExternal(ACCESSIBILITY_PREFERENCES_URL);
        log("Initial permission guide: opened Accessibility preferences");
        monitorAccessibilityAuthorization();
      }
    } catch (error) {
      logError("Initial permission guide failed", error);
    }
  })();
}

/**
 * The keyboard helper is spawned during app startup.  On a first launch it
 * exits immediately if Accessibility has not been granted yet.  macOS does
 * not relaunch the app after the user flips the permission switch, so recreate
 * the helper as soon as the authorization becomes available.
 */
function monitorAccessibilityAuthorization(): void {
  if (process.platform !== "darwin") return;

  if (accessibilityAuthorizationPoll) {
    clearInterval(accessibilityAuthorizationPoll);
    accessibilityAuthorizationPoll = null;
  }

  let attempts = 0;
  const checkAuthorization = (): boolean => {
    let trusted = false;
    try {
      trusted = systemPreferences.isTrustedAccessibilityClient(false);
    } catch (error) {
      logError("Unable to check Accessibility authorization", error);
      return false;
    }

    if (trusted) {
      if (accessibilityAuthorizationPoll) {
        clearInterval(accessibilityAuthorizationPoll);
        accessibilityAuthorizationPoll = null;
      }
      const previousShortcut = globalShortcut;
      globalShortcut = null;
      try {
        previousShortcut?.destroy();
      } catch (error) {
        logError("Unable to stop pre-authorization shortcut listener", error);
      }
      setupShortcut();
      log("Accessibility granted: global shortcut listener restarted");
      return true;
    }

    attempts += 1;
    if (attempts >= 600 && accessibilityAuthorizationPoll) {
      clearInterval(accessibilityAuthorizationPoll);
      accessibilityAuthorizationPoll = null;
      log("Accessibility authorization was not granted within 10 minutes; stopped shortcut listener polling");
    }
    return false;
  };

  if (!checkAuthorization()) {
    accessibilityAuthorizationPoll = setInterval(checkAuthorization, 1000);
  }
}

function persistDockVisibilityPreference(showInDock: boolean): void {
  try {
    const envPath = getWritableEnvPath();
    const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
    const lines = existing
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trimStart().startsWith("SHOW_DOCK_ICON="));
    lines.push(`SHOW_DOCK_ICON=${showInDock}`);
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");

    config.showDockIcon = showInDock;
    setDockVisibility(showInDock);
    log(`Saved Dock visibility preference: showInDock=${showInDock}`);
  } catch (error) {
    logError("Unable to save Dock visibility preference", error);
  }
}

function setupPowerMonitor(): void {
  const { powerMonitor } = require("electron");
  
  powerMonitor.on("lock-screen", () => {
    isScreenLocked = true;
    log("PowerMonitor: Screen locked. Stopping wake word monitor for privacy/avoiding false triggers.");
    if (wakeWordMonitor) {
      try {
        wakeWordMonitor.stop();
        log("PowerMonitor: Wake word monitor successfully stopped.");
      } catch (err) {
        logError("PowerMonitor: Failed to stop wake word monitor", err);
      }
    }
    setWakeWordCaptureEnabled(false);
  });

  powerMonitor.on("unlock-screen", () => {
    isScreenLocked = false;
    log("PowerMonitor: Screen unlocked. Resuming wake word monitor.");
    if (wakeWordMonitor && config.wakeWord.enabled) {
      try {
        wakeWordMonitor.start();
        setWakeWordCaptureEnabled(true);
        log("PowerMonitor: Wake word monitor successfully resumed.");
      } catch (err) {
        logError("PowerMonitor: Failed to resume wake word monitor", err);
      }
    }
  });
}

function setupWakeWord(): void {
  if (!config.wakeWord.enabled) {
    log("Wake word detection disabled");
    setWakeWordCaptureEnabled(false);
    return;
  }
  const whisperBin = getBundledBin("whisper-cli");
  let whisperAvailable = fs.existsSync(whisperBin);
  if (!whisperAvailable) {
    try {
      require("child_process").execSync("which whisper-cli", { stdio: "ignore" });
      whisperAvailable = true;
    } catch {}
  }
  if (!whisperAvailable) {
    log("Wake word disabled: whisper-cli not found (not bundled and not on PATH)");
    setWakeWordCaptureEnabled(false);
    return;
  }
  log(`Wake word detection enabled, keyword: ${config.wakeWord.keyword}`);
  wakeWordMonitor = new WakeWordMonitor(config.wakeWord.keyword);

  wakeWordMonitor.on("wake", () => {
    log("Wake word detected! Starting voice listening...");

    // If already in voice listening mode, ignore (don't re-trigger)
    if (voiceWakeMode) {
      log("Already in voice listening mode, ignoring wake word");
      return;
    }

    // Abort all current tasks (LLM, TTS, ASR, timers)
    abortAllTasks();

    stopAutoHideTimer();
    showOrb();
    playSound("Purr");

    // Start voice listening mode
    startVoiceListening();
  });

  wakeWordMonitor.start();
  setWakeWordCaptureEnabled(true);
}

function setupAudio(): void {
  initAudioRecorder(
    (buffer) => {
      asrSession?.feedPcm(buffer);
      wakeWordMonitor?.feedPcm(buffer);
    },
    (message) => {
      logError("Audio error", message);
      updateState("error", message);
    },
  );
}

let lastPressTime = 0;

/**
 * At login macOS may report Accessibility as granted before the event-tap
 * service has finished accepting clients. Retry only in that narrow case;
 * never loop when the user has not actually granted the permission.
 */
function restartShortcutListenerAfterFailure(failedListener: GlobalShortcut, message: string): void {
  if (failedListener !== globalShortcut || shortcutListenerRestartTimer) return;

  let accessibilityTrusted = false;
  try {
    accessibilityTrusted = process.platform !== "darwin"
      || systemPreferences.isTrustedAccessibilityClient(false);
  } catch (error) {
    logError("Unable to check Accessibility while restarting shortcut listener", error);
    return;
  }

  if (!accessibilityTrusted) {
    log(`Global shortcut listener stopped: Accessibility is not currently authorized (${message})`);
    monitorAccessibilityAuthorization();
    return;
  }

  if (shortcutListenerRestartAttempts >= SHORTCUT_LISTENER_MAX_RESTARTS) {
    log(`Global shortcut listener gave up after ${SHORTCUT_LISTENER_MAX_RESTARTS} post-login restart attempts: ${message}`);
    return;
  }

  const attempt = ++shortcutListenerRestartAttempts;
  const delay = Math.min(
    SHORTCUT_LISTENER_RESTART_BASE_DELAY_MS * 2 ** (attempt - 1),
    8000,
  );
  log(`Global shortcut listener exited despite Accessibility access; retrying in ${delay}ms (attempt ${attempt}/${SHORTCUT_LISTENER_MAX_RESTARTS})`);

  globalShortcut = null;
  try {
    failedListener.destroy();
  } catch (error) {
    logError("Unable to stop failed global shortcut listener", error);
  }

  shortcutListenerRestartTimer = setTimeout(() => {
    shortcutListenerRestartTimer = null;
    setupShortcut();
  }, delay);
}

function setupShortcut(): void {
  log("Setting up global shortcut");
  const previousShortcut = globalShortcut;
  globalShortcut = null;
  try {
    previousShortcut?.destroy();
  } catch (error) {
    logError("Unable to replace previous global shortcut listener", error);
  }

  const shortcutListener = new GlobalShortcut();
  globalShortcut = shortcutListener;

  if (shortcutListenerStabilityTimer) {
    clearTimeout(shortcutListenerStabilityTimer);
  }
  shortcutListenerStabilityTimer = setTimeout(() => {
    if (globalShortcut === shortcutListener) {
      shortcutListenerRestartAttempts = 0;
      log("Global shortcut listener is running");
    }
    shortcutListenerStabilityTimer = null;
  }, 5000);

  shortcutListener.on("listener-info", (message: string) => {
    if (message) log(`Global shortcut listener: ${message}`);
  });

  shortcutListener.on("listener-error", (message: string) => {
    if (shortcutListenerStabilityTimer) {
      clearTimeout(shortcutListenerStabilityTimer);
      shortcutListenerStabilityTimer = null;
    }
    log(`Global shortcut listener unavailable: ${message}`);
    restartShortcutListenerAfterFailure(shortcutListener, message);
  });

  shortcutListener.on("captured", (keyName: string) => {
    const win = getSettingsWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.SHORTCUT_CAPTURED, { keyName });
    }
  });

  shortcutListener.on("pressed", () => {
    log("Shortcut pressed");
    if (isPanelSticky) {
      log("Shortcut pressed while panel is sticky: dismiss panel and abort active response");
      // Expanding the panel marks it sticky, but the same shortcut must still
      // behave as a full interruption: stop renderer playback, cancel queued
      // synthesis, invalidate stale callbacks, and clear the sticky state.
      abortAllTasks();
      isSessionActive = false;
      updateState("idle");
      startAutoHideTimer();
      return;
    }
    lastPressTime = Date.now();
    wakeAndStartListening();
  });

  shortcutListener.on("released", () => {
    log("Shortcut released");
    endListening();
  });
}

function ensureConversation(): ConversationManager {
  if (!conversationManager || conversationManager.isExpired(CONVERSATION_EXPIRE_MS)) {
    log("Creating new conversation");
    conversationManager = new ConversationManager();
  }
  return conversationManager;
}

function clearEarlyCommandTimer(): void {
  if (earlyCommandTimer) {
    clearTimeout(earlyCommandTimer);
    earlyCommandTimer = null;
  }
}

async function tryHandleLocalCommandEarly(text: string): Promise<boolean> {
  if (!text.trim() || asrResultConsumed || !isSessionActive) return false;
  const result = await tryLocalCommand(text);
  if (result.handled) {
    log(`Local command handled early: ${result.action || ""}`);
    asrResultConsumed = true;
    isSessionActive = false;
    if (safetyNetTimer) {
      clearTimeout(safetyNetTimer);
      safetyNetTimer = null;
    }
    clearEarlyCommandTimer();
    sendToFloatWindow(IPC_CHANNELS.ASR_FINAL, text);
    if (result.message) {
      addChatEntry("daisy", result.message);
      updateState("speaking", undefined, { isFinal: true, text: result.message });
      speakResponse(result.message);
      return true;
    }
    playSound("Tink");
    updateState("idle");
    startAutoHideTimer();
    return true;
  }
  return false;
}

let isSessionActive = false;
let voiceWakeMode = false; // true when woken by voice (auto-send on silence)
let voiceSilenceTimer: NodeJS.Timeout | null = null;
let voiceStartSilenceTimer: NodeJS.Timeout | null = null;
let earlyCommandTimer: NodeJS.Timeout | null = null;
let asrResultConsumed = false;
function beginFinderSelectionCapture(sessionId = currentSessionId, refresh = false): Promise<FinderSelectionResult> {
  if (!refresh && finderSelectionCapture?.sessionId === sessionId) {
    return finderSelectionCapture.promise;
  }

  const promise = getSelectedFinderItems().then((result) => {
    if (result.status === "ok") {
      log(`Finder selection: captured ${result.items.length} item(s) for session ${sessionId}`);
    } else {
      log(`Finder selection: ${result.status} for session ${sessionId}${result.error ? ` (${result.error})` : ""}`);
    }
    return result;
  });

  finderSelectionCapture = { sessionId, promise };
  return promise;
}

function checkEarlyFinderSelectionCapture(text: string): void {
  if (!isSelectedFinderItemReference(text)) return;
  void beginFinderSelectionCapture();
}

function getFinderSelectionFailureMessage(result: FinderSelectionResult): string {
  const isWin = process.platform === "win32";
  switch (result.status) {
    case "empty":
      return isWin
        ? "没有找到选中的文件。请先在文件资源管理器中选中一个文件后，再试一次。"
        : "没有找到选中的文件。请先在 Finder 或桌面选中一个文件后，再说一次。";
    case "not-file-manager":
      return "请先在 Windows 文件资源管理器或桌面上选中目标文件，然后再说一次。";
    case "access-denied":
      return isWin
        ? "暂时无法读取文件资源管理器的选中项。请确认资源管理器仍处于前台后重试。"
        : "请先允许 Daisy 自动化访问 Finder，然后再试一次。";
    default:
      return isWin
        ? "暂时无法读取文件资源管理器的选中项。请确认资源管理器仍处于前台后重试。"
        : "暂时无法读取 Finder 的选中文件。请确认 Finder 已打开、目标文件仍在，再试一次。";
  }
}

async function addFinderSelectionContext(text: string, sessionId: number): Promise<{
  text: string;
  selectionError?: string;
}> {
  if (!isSelectedFinderItemReference(text)) return { text };

  const result = await beginFinderSelectionCapture(sessionId);
  if (sessionId !== currentSessionId) return { text };
  if (result.status !== "ok") {
    return { text, selectionError: getFinderSelectionFailureMessage(result) };
  }
  if (result.items.length > 1 && !allowsMultipleSelectedFinderItems(text)) {
    return {
      text,
      selectionError: `你当前选中了 ${result.items.length} 个项目。请只选中一个文件，或明确说“处理全部选中的文件”。`,
    };
  }

  return { text: `${text}${formatFinderSelectionContext(result.items)}` };
}

const VOICE_SILENCE_MS = 3000;

function stopSpeaking(): void {
  if (ttsPlayer) {
    try {
      ttsPlayer.stop();
    } catch (e) {}
    ttsPlayer = null;
  }
  isSpeaking = false;
  activeTtsSynthesisSessionId = null;
  playingTtsSessionId = null;

  for (const f of ttsFileQueue) {
    fs.promises.unlink(f).catch(() => {});
  }
  ttsFileQueue = [];

  if (currentPlayingFile) {
    fs.promises.unlink(currentPlayingFile).catch(() => {});
    currentPlayingFile = null;
  }

  sendToFloatWindow(IPC_CHANNELS.TTS_END);
}

/**
 * Stop only the audio part of a completed answer.  Unlike abortAllTasks(), this
 * deliberately leaves the LLM session, answer state, and display panel intact.
 */
function muteCurrentAnswerSpeech(): void {
  // Tool acknowledgements use the same TTS pipeline, but do not have a final
  // answer panel to keep on screen.  Do not let an orb click alter that flow.
  if (!isSpeaking || toolAckPending) {
    log("TTS mute request ignored — no final answer is currently being spoken");
    return;
  }

  log("TTS muted by orb click; retaining current answer state and panel");
  isPanelSticky = true;

  try {
    ttsPlayer?.stop();
  } catch {
    // The renderer stop below still interrupts any audio already playing.
  }
  ttsPlayer = null;
  isSpeaking = false;
  activeTtsSynthesisSessionId = null;
  playingTtsSessionId = null;

  for (const filePath of ttsFileQueue) {
    fs.promises.unlink(filePath).catch(() => {});
  }
  ttsFileQueue = [];

  if (currentPlayingFile) {
    fs.promises.unlink(currentPlayingFile).catch(() => {});
    currentPlayingFile = null;
  }

  // This tells the float renderer to pause the active Audio element. It emits
  // no completion event, and the isSpeaking guard also makes any in-flight
  // completion notification harmless.
  sendToFloatWindow(IPC_CHANNELS.TTS_END);
}

function abortAllTasks(): void {
  // Increment session ID — all async callbacks from old session become stale
  currentSessionId++;
  isPanelSticky = false;
  finderSelectionCapture = null;

  // 1. Abort LLM
  if (llmClient) {
    llmClient.abort();
    llmClient = null;
  }

  // 2. Stop TTS playback + synthesis
  stopSpeaking();

  // 3. Stop ASR — remove listeners FIRST to prevent stale final events
  if (asrSession) {
    asrSession.removeAllListeners();
    asrSession.stop();
    asrSession = null;
  }

  // 4. Clear all timers
  clearEarlyCommandTimer();
  if (safetyNetTimer) {
    clearTimeout(safetyNetTimer);
    safetyNetTimer = null;
  }
  if (voiceSilenceTimer) {
    clearTimeout(voiceSilenceTimer);
    voiceSilenceTimer = null;
  }
  if (voiceStartSilenceTimer) {
    clearTimeout(voiceStartSilenceTimer);
    voiceStartSilenceTimer = null;
  }
  if (autoHideTimer) {
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }
  // 5. Reset state
  isSessionActive = false;
  voiceWakeMode = false;
  toolAckPending = false;
  pendingFinalResponse = null;
  asrResultConsumed = false;

  // 6. Stop recording
  if (getIsRecording()) {
    stopRecording();
  }

  // 7. Pause wake word monitor
  wakeWordMonitor?.pause();

  // 8. Restore volume (unmute if muted)
  unmuteSystemOnly();

  log(`abortAllTasks: session ${currentSessionId} (all tasks cleared)`);
}

function wakeAndStartListening(): void {
  const useWhisper = config.whisper.shortcutUseWhisper;
  if (!isLlmConfigured()) {
    log("Cannot start session: missing LLM API key");
    updateState("error", "请先配置大模型 API Key");
    createSettingsWindow();
    return;
  }
  if (!useWhisper && !isAsrConfigured()) {
    log("Cannot start session: missing ASR config");
    updateState("error", "请先配置 ASR 或启用本地 Whisper");
    createSettingsWindow();
    return;
  }

  // Abort all ongoing tasks (LLM, TTS, ASR, timers) and start fresh
  abortAllTasks();

  muteSystemAndPauseMedia();
  const sessionId = currentSessionId;
  log(`wakeAndStartListening: new session ${sessionId}, useWhisper=${useWhisper}`);
  isSessionActive = true;
  sendToFloatWindow(IPC_CHANNELS.TTS_END);

  // Ensure recorder is not stuck from a previous failed session
  if (getIsRecording()) {
    log("Recorder was stuck, force-stopping");
    stopRecording();
  }

  // Clean up any stale ASR session
  if (asrSession) {
    log("Stopping stale ASR session");
    asrSession.removeAllListeners();
    asrSession.stop();
    asrSession = null;
  }

  stopAutoHideTimer();
  showOrb();
  playSound("Purr");

  asrSession = useWhisper ? new WhisperAsrSession() : new AsrSession();
  asrSession.on("partial", (text) => {
    sendToFloatWindow(IPC_CHANNELS.ASR_PARTIAL, text);
    checkEarlyFinderSelectionCapture(text);
  });
  asrSession.on("final", (text) => {
    clearEarlyCommandTimer();
    if (asrResultConsumed) {
      log(`ASR final arrived but already handled early: "${text}"`);
      return;
    }
    log(`ASR final: ${text}`);
    if (safetyNetTimer) {
      clearTimeout(safetyNetTimer);
      safetyNetTimer = null;
    }
    isSessionActive = false;
    stopRecording();
    sendToFloatWindow(IPC_CHANNELS.ASR_FINAL, text);
    handleUserInput(text);
  });
  asrSession.on("error", (message) => {
    clearEarlyCommandTimer();
    logError("ASR error", message);
    if (safetyNetTimer) {
      clearTimeout(safetyNetTimer);
      safetyNetTimer = null;
    }
    isSessionActive = false;
    stopRecording();
    updateState("error", message);
    startAutoHideTimer();
  });

  updateState("listening");
  asrSession.start();
  startRecording();
}

function endListening(): void {
  if (!isSessionActive) {
    log("No active session, ignoring release");
    return;
  }

  const holdDuration = Date.now() - lastPressTime;
  log(`endListening: key was held for ${holdDuration}ms`);

  if (holdDuration < 300) {
    log("Hold duration too short (<300ms), treating as quick release / double click. Cancelling ASR immediately.");
    if (asrSession) {
      asrSession.removeAllListeners();
      asrSession.stop();
      asrSession = null;
    }
    isSessionActive = false;
    stopRecording();
    unmuteSystemOnly();
    restoreMediaOnly();
    updateState("idle");
    startAutoHideTimer();
    return;
  }

  voiceWakeMode = false;

  // A user may select the target before pressing the shortcut, while holding
  // it, or even after the ASR partial first mentions "this file". Refresh the
  // already-requested Finder selection at release so the final target always
  // reflects the last item selected before the user sends the request.
  // On Windows the orb is already shown by release time, which deactivates
  // Explorer (foreground becomes the desktop), so a refresh would read the
  // wrong window; the press-time capture taken before the orb appeared is the
  // correct one and must be kept.
  if (process.platform !== "win32" && finderSelectionCapture?.sessionId === currentSessionId) {
    log(`Finder selection: refreshing at shortcut release for session ${currentSessionId}`);
    void beginFinderSelectionCapture(currentSessionId, true);
  }

  log("Stopping recording and ASR");
  playSound("Send");
  stopRecording();

  // Check if we got any speech at all
  const hasPartial = asrSession?.getLastText()?.trim();
  if (hasPartial) {
    updateState("processing");
  } else {
    // No speech detected — go straight to idle, skip processing state
    updateState("idle");
  }

  asrSession?.stop();

  // Fast path: if the ASR server is slow to emit the final package, use the
  // latest partial transcript to execute local commands immediately.
  clearEarlyCommandTimer();
  earlyCommandTimer = setTimeout(async () => {
    if (!isSessionActive || !asrSession || asrResultConsumed) return;
    const partialText = asrSession.getLastText();
    if (partialText) {
      log(`Early local command check from partial: "${partialText}"`);
      const handled = await tryHandleLocalCommandEarly(partialText);
      if (handled) {
        asrSession?.removeAllListeners();
        asrSession = null;
      }
    }
  }, 500);

  // Safety net: ASR fast path returns in 800ms, slow path 10s. Use 12s.
  safetyNetTimer = setTimeout(() => {
    if (isSessionActive) {
      log("ASR final timeout (12s), forcing session reset");
      isSessionActive = false;
      asrSession = null;
      updateState("idle");
      startAutoHideTimer();
    }
    safetyNetTimer = null;
  }, 12000);
}

function startVoiceListening(): void {
  log("Starting voice listening mode (auto-send on 3s silence)");
  muteSystemAndPauseMedia();
  voiceWakeMode = true;
  isSessionActive = true;
  asrResultConsumed = false;
  clearEarlyCommandTimer();

  // CRITICAL: pause wake word monitor so it doesn't re-trigger
  wakeWordMonitor?.pause();

  if (voiceSilenceTimer) {
    clearTimeout(voiceSilenceTimer);
    voiceSilenceTimer = null;
  }
  if (voiceStartSilenceTimer) {
    clearTimeout(voiceStartSilenceTimer);
    voiceStartSilenceTimer = null;
  }
  if (getIsRecording()) {
    stopRecording();
  }
  if (asrSession) {
    asrSession.stop();
    asrSession = null;
  }

  asrSession = new WhisperAsrSession();
  asrSession.on("partial", (text) => {
    if (!voiceWakeMode) return;
    log(`Voice ASR partial: ${text}`);
    sendToFloatWindow(IPC_CHANNELS.ASR_PARTIAL, text);
    checkEarlyFinderSelectionCapture(text);
    
    // Clear initial silence timer since user started speaking
    if (voiceStartSilenceTimer) {
      clearTimeout(voiceStartSilenceTimer);
      voiceStartSilenceTimer = null;
    }

    if (voiceSilenceTimer) {
      clearTimeout(voiceSilenceTimer);
    }
    if (!(asrSession instanceof WhisperAsrSession)) {
      voiceSilenceTimer = setTimeout(() => {
        log("Voice silence timeout, auto-sending");
        endVoiceListening();
      }, VOICE_SILENCE_MS);
    }
  });
  asrSession.on("final", (text) => {
    clearEarlyCommandTimer();
    if (!voiceWakeMode) return;
    if (asrResultConsumed) {
      log(`Voice ASR final arrived but already handled early: "${text}"`);
      return;
    }
    log(`Voice ASR final: ${text}`);
    if (voiceSilenceTimer) {
      clearTimeout(voiceSilenceTimer);
      voiceSilenceTimer = null;
    }
    if (safetyNetTimer) {
      clearTimeout(safetyNetTimer);
      safetyNetTimer = null;
    }
    sendToFloatWindow(IPC_CHANNELS.ASR_FINAL, text);
    voiceWakeMode = false;
    handleUserInput(text);
  });
  asrSession.on("error", (message) => {
    clearEarlyCommandTimer();
    if (!voiceWakeMode) return;
    logError("Voice ASR error", message);
    if (voiceSilenceTimer) {
      clearTimeout(voiceSilenceTimer);
      voiceSilenceTimer = null;
    }
    if (voiceStartSilenceTimer) {
      clearTimeout(voiceStartSilenceTimer);
      voiceStartSilenceTimer = null;
    }
    isSessionActive = false;
    voiceWakeMode = false;
    stopRecording();
    asrSession = null;
    updateState("error", message);
    startAutoHideTimer();
  });

  updateState("listening");
  asrSession.start();
  startRecording();

  // If no speech starts within 3 seconds, end voice listening
  voiceStartSilenceTimer = setTimeout(() => {
    log("Voice start silence timeout (no speech detected), going to idle");
    endVoiceListening();
  }, 3000);
}

function endVoiceListening(): void {
  if (!voiceWakeMode) return;
  log("Ending voice listening, sending to ASR");
  voiceWakeMode = false;
  if (voiceSilenceTimer) {
    clearTimeout(voiceSilenceTimer);
    voiceSilenceTimer = null;
  }
  if (voiceStartSilenceTimer) {
    clearTimeout(voiceStartSilenceTimer);
    voiceStartSilenceTimer = null;
  }
  stopRecording();

  const hasPartial = asrSession?.getLastText()?.trim();
  if (hasPartial) {
    playSound("Frog");
    updateState("processing");
  } else {
    updateState("idle");
    isSessionActive = false;
    startAutoHideTimer();
  }

  asrSession?.stop();

  // Fast path for voice mode: try partial text for local commands.
  clearEarlyCommandTimer();
  earlyCommandTimer = setTimeout(async () => {
    if (!isSessionActive || !asrSession || asrResultConsumed) return;
    const partialText = asrSession.getLastText();
    if (partialText) {
      log(`Early local command check from voice partial: "${partialText}"`);
      const handled = await tryHandleLocalCommandEarly(partialText);
      if (handled) {
        asrSession?.removeAllListeners();
        asrSession = null;
      }
    }
  }, 500);

  safetyNetTimer = setTimeout(() => {
    if (isSessionActive) {
      log("Voice ASR final timeout (12s), forcing session reset");
      isSessionActive = false;
      asrSession = null;
      updateState("idle");
      startAutoHideTimer();
    }
    safetyNetTimer = null;
  }, 12000);
}

function handleUserInput(text: string): void {
  const inputSessionId = currentSessionId;
  asrSession = null;
  isSessionActive = false;
  if (!text.trim()) {
    log("Empty transcript, going idle");
    updateState("idle");
    startAutoHideTimer();
    return;
  }

  addChatEntry("user", text);

  const continueWithLlm = async (): Promise<void> => {
    if (inputSessionId !== currentSessionId) return;

    // Not a local command — proceed to LLM
    let processedText = text;
    if (/剪贴板|剪切板|复制的内容|我复制的/i.test(text)) {
      try {
        const { clipboard } = require("electron");
        const clipText = clipboard.readText().trim();
        if (clipText) {
          processedText = `${text}\n\n【我刚刚复制的内容如下，请根据此内容回答我：】\n${clipText}`;
          log(`Clipboard: injected ${clipText.length} characters into prompt`);
        }
      } catch (err) {
        logError("Clipboard injection failed", err);
      }
    }

    const contextualized = await addFinderSelectionContext(processedText, inputSessionId);
    if (inputSessionId !== currentSessionId) return;
    if (contextualized.selectionError) {
      const message = contextualized.selectionError;
      addChatEntry("daisy", message);
      updateState("speaking", undefined, { isFinal: true, text: message });
      speakResponse(message);
      return;
    }

    const isFinderSelectionTask = isSelectedFinderItemReference(processedText);
    handleLLMRequest(contextualized.text, {
      // 选中文件任务不朗读工具调用前的确认语，但完成结果和内容概述仍正常朗读。
      suppressToolAcknowledgement: isFinderSelectionTask,
      announceSilentFinderCompletion: isFinderSelectionTask,
    });
  };

  // Try local command router first (zero-latency for simple commands)
  tryLocalCommand(text).then((result) => {
    if (inputSessionId !== currentSessionId) return;
    if (result.handled) {
      log(`Local command handled: ${result.action || ""}`);
      if (result.message) {
        addChatEntry("daisy", result.message);
        updateState("speaking", undefined, { isFinal: true, text: result.message });
        speakResponse(result.message);
        return;
      }
      playSound("Tink");
      updateState("idle");
      startAutoHideTimer();
      return;
    }
    void continueWithLlm();
  }).catch((error) => {
    logError("Local command error", error);
    void continueWithLlm();
  });
}

function handleLLMRequest(text: string, options: {
  suppressToolAcknowledgement?: boolean;
  announceSilentFinderCompletion?: boolean;
} = {}): void {
  const sessionId = currentSessionId;
  const suppressToolAcknowledgement = options.suppressToolAcknowledgement === true;
  const announceSilentFinderCompletion = options.announceSilentFinderCompletion === true;
  const conversation = ensureConversation();

  updateState("thinking");
  currentAiResponse = "";
  toolAckPending = false;
  pendingFinalResponse = null;
  ttsFileQueue = [];

  let hasSpokenToolAck = false;

  llmClient = new DeepSeekClient(conversation.getMessages());

  llmClient.on("stream", (chunk) => {
    if (sessionId !== currentSessionId) return;
    currentAiResponse += chunk;
  });

  llmClient.on("tool_ack", (ackText: string) => {
    if (sessionId !== currentSessionId) return;
    if (suppressToolAcknowledgement) {
      log(`Finder selection task tool acknowledgement suppressed: ${ackText}`);
      return;
    }
    if (hasSpokenToolAck) {
      log(`Tool ack ignored (already spoken once in this session): ${ackText}`);
      return;
    }
    log(`Tool ack: ${ackText}`);
    toolAckPending = true;
    hasSpokenToolAck = true;
    if (ackText.trim()) {
      if (isSpeaking) {
        ttsPlayer?.stop();
        ttsPlayer = null;
      }
      // Delete current playing file
      if (currentPlayingFile) {
        fs.promises.unlink(currentPlayingFile).catch(() => {});
        currentPlayingFile = null;
      }
      // Delete queued files
      for (const f of ttsFileQueue) {
        fs.promises.unlink(f).catch(() => {});
      }
      ttsFileQueue = [];
      activeTtsSynthesisSessionId = null;
      isSpeaking = false;
      updateState("speaking");
      speakResponse(ackText);
    }
  });
 
  llmClient.on("silent_done", () => {
    if (sessionId !== currentSessionId) return;
    log("LLM silent_done: all actions executed silently.");
    isSessionActive = false;
    toolAckPending = false;
    playSound("Tink");
    // Stop any active TTS confirmation/acknowledgment speech first, ensuring isSpeaking is false
    stopSpeaking();
    conversationManager?.reset();

    if (announceSilentFinderCompletion) {
      const message = "已完成选中文件操作。";
      log("Finder selection silent task completed: speaking concise result");
      addChatEntry("daisy", message);
      updateState("speaking", undefined, { isFinal: true, text: message });
      speakResponse(message);
      return;
    }

    updateState("idle");
    startAutoHideTimer();
  });

  llmClient.on("done", ({ display: displayText, speech: speechText }: DualChannel) => {
    if (sessionId !== currentSessionId) return;
    log(`LLM done, display length: ${displayText.length}, speech length: ${speechText.length}`);
    if (llmClient) {
      conversation.setMessages(llmClient.getConversation());
    } else {
      conversation.addAssistantMessage(displayText);
    }
    addChatEntry("daisy", displayText);
    toolAckPending = false;

    if (!displayText.trim()) {
      isSessionActive = false;
      updateState("idle");
      startAutoHideTimer();
      return;
    }

    const chunks = splitForPipeline(speechText);
    log(`TTS pipeline: ${chunks.length} chunks, sizes: ${chunks.map(c => c.length).join(", ")}`);

    if (chunks.length === 0) {
      isSessionActive = false;
      updateState("idle");
      startAutoHideTimer();
      return;
    }

    // Keep the unmodified model response for the visual surface. TTS receives
    // only the separately cleaned speech channel below.
    updateState("speaking", undefined, { isFinal: true, text: displayText });

    if (!isSpeaking) {
      speakResponse(chunks[0]);
      if (chunks.length > 1) {
        synthesizeRemaining(chunks.slice(1), sessionId);
      }
    } else {
      synthesizeRemaining(chunks, sessionId);
    }
  });

  llmClient.on("error", (message) => {
    if (sessionId !== currentSessionId) return;
    logError("LLM error", message);
    isSessionActive = false;
    updateState("error", message);
    startAutoHideTimer();
  });

  llmClient.sendMessage(text).catch((error) => {
    if (sessionId !== currentSessionId) return;
    logError("LLM sendMessage failed", error);
    updateState("error", error instanceof Error ? error.message : String(error));
    startAutoHideTimer();
  });
}

function splitForPipeline(text: string): string[] {
  const clean = cleanTextForTTS(text);
  if (!clean) return [];

  // Split into sentences
  const sentences: string[] = [];
  let current = "";
  for (const char of clean) {
    current += char;
    if (/[。！？；\n]/.test(char)) {
      const trimmed = current.trim();
      if (trimmed) sentences.push(trimmed);
      current = "";
    }
  }
  if (current.trim()) sentences.push(current.trim());

  if (sentences.length === 0) return [];

  const chunks: string[] = [];

  // First chunk: first 2 sentences (or 1 if only 1 sentence total)
  if (sentences.length <= 2) {
    // Short response — just one chunk
    chunks.push(sentences.join(""));
    return chunks;
  }

  chunks.push(sentences[0] + sentences[1]);

  // Remaining text
  const remaining = sentences.slice(2).join("");
  if (!remaining) return chunks;

  // Split remaining into ~200 char chunks at sentence boundaries
  const CHUNK_SIZE = 200;
  let pos = 0;
  while (pos < remaining.length) {
    let end = pos + CHUNK_SIZE;
    if (end >= remaining.length) {
      chunks.push(remaining.slice(pos));
      break;
    }
    // Find nearest sentence-ending punctuation after target position
    let cutPos = end;
    for (let i = end; i < Math.min(end + 50, remaining.length); i++) {
      if (/[。！？；，\n]/.test(remaining[i])) {
        cutPos = i + 1;
        break;
      }
    }
    // If no punctuation found, just cut at target position
    chunks.push(remaining.slice(pos, cutPos));
    pos = cutPos;
  }

  // If last two chunks combined < 400 chars, merge them
  if (chunks.length >= 3) {
    const lastTwo = chunks[chunks.length - 2] + chunks[chunks.length - 1];
    if (lastTwo.length < 400) {
      chunks.splice(chunks.length - 2, 2, lastTwo);
    }
  }

  return chunks;
}

async function synthesizeRemaining(chunks: string[], sessionId: number): Promise<void> {
  // Don't start if another synthesis is already running for this session
  if (activeTtsSynthesisSessionId !== null && activeTtsSynthesisSessionId !== sessionId) {
    log(`TTS synthesis skipped — another session ${activeTtsSynthesisSessionId} is synthesizing`);
    return;
  }
  activeTtsSynthesisSessionId = sessionId;

  for (const chunk of chunks) {
    // Check if session was aborted during synthesis
    if (sessionId !== currentSessionId || activeTtsSynthesisSessionId !== sessionId) {
      log("TTS synthesis aborted (session changed)");
      break;
    }
    if (!chunk.trim()) continue;
    const player = new EdgeTTSPlayer();
    const filePath = await player.synthesize(chunk);
    // Check again after synthesis
    if (sessionId !== currentSessionId || activeTtsSynthesisSessionId !== sessionId) {
      if (filePath) fs.promises.unlink(filePath).catch(() => {});
      log("TTS synthesis result discarded (session changed)");
      break;
    }
    if (filePath) {
      ttsFileQueue.push(filePath);
      log(`TTS synthesized and queued: ${filePath} (${chunk.length} chars)`);
    }
  }

  activeTtsSynthesisSessionId = null;
}

function speakResponse(text: string): void {
  log(`Speaking response, length: ${text.length}`);
  log(`TTS text: ${text.substring(0, 100)}${text.length > 100 ? "..." : ""}`);
  if (!text || !text.trim()) {
    updateState("idle");
    startAutoHideTimer();
    return;
  }

  unmuteSystemOnly();
  isSpeaking = true;
  if (!isScreenLocked) {
    wakeWordMonitor?.resume();
  }
  ttsPlayer = new EdgeTTSPlayer();

  ttsPlayer.on("start", () => {
    sendToFloatWindow(IPC_CHANNELS.TTS_START);
  });

  ttsPlayer.on("play", (filePath: string) => {
    log(`[TTS_PERF] IPC Sent: ${filePath}`);
    currentPlayingFile = filePath;
    playingTtsSessionId = currentSessionId;
    sendToFloatWindow(IPC_CHANNELS.TTS_PLAY, filePath);
  });

  ttsPlayer.on("end", () => {
    log("TTS end");
    // Don't reset state here — TTS_PLAY_ENDED handles queue + state
  });

  ttsPlayer.on("error", (message) => {
    logError("TTS error", message);
    isSpeaking = false;
    isSessionActive = false;
    updateState("error", message);
    startAutoHideTimer();
  });

  ttsPlayer.speak(text);
}

function playTTSFile(filePath: string): void {
  log(`[TTS_PERF] IPC Sent (queued): ${filePath}`);
  unmuteSystemOnly();
  currentPlayingFile = filePath;
  playingTtsSessionId = currentSessionId;
  sendToFloatWindow(IPC_CHANNELS.TTS_PLAY, filePath);
}

function showOrb(): void {
  createFloatWindow();
  showFloatWindow();
  isOrbVisible = true;
  sendToFloatWindow(IPC_CHANNELS.SHOW_WINDOW);
}
function hideOrb(): void {
  hideFloatWindow();
  hidePanelWindow();
  isOrbVisible = false;
  unmuteSystemOnly();
  restoreMediaOnly();
}
function startAutoHideTimer(): void {
  stopAutoHideTimer();
  if (isSpeaking) {
    log("Auto-hide deferred: TTS still playing");
    return;
  }
  autoHideTimer = setTimeout(() => {
    if (isSpeaking) {
      log("Auto-hide deferred: TTS started during wait");
      return;
    }
    log("Auto-hiding orb after inactivity");
    hideOrb();
  }, AUTO_HIDE_TIMEOUT_MS);

  unmuteSystemOnly();
  restoreMediaOnly();
  if (wakeWordMonitor && !isSessionActive && !isSpeaking && !isScreenLocked) {
    wakeWordMonitor.resume();
  }
}

function stopAutoHideTimer(): void {
  if (autoHideTimer) {
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }
}

function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("osascript", [], (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
    child.stdin?.write(script);
    child.stdin?.end();
  });
}

/**
 * Send the Windows global play/pause media key without going through cmd.exe.
 * The script is written to a temp .ps1 file and invoked via -File to avoid
 * the -EncodedCommand base64 pattern that matches malware heuristics.
 */
async function sendWindowsMediaPlayPause(): Promise<void> {
  const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class U { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); }'; [U]::keybd_event(0xB3, 0, 0, [UIntPtr]::Zero); [U]::keybd_event(0xB3, 0, 2, [UIntPtr]::Zero)`;
  const tmpFile = path.join(os.tmpdir(), `daisy-media-${Date.now()}.ps1`);
  fs.writeFileSync(tmpFile, script, "utf-8");
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tmpFile],
      { timeout: 5000, windowsHide: true },
    );
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

async function muteSystemAndPauseMedia(): Promise<void> {
  if (activeMutePromise) {
    return activeMutePromise;
  }

  const muteAction = async () => {
    log("Muting system and pausing Chrome media...");

    if (process.platform === "win32") {
      // Windows: send VK_MEDIA_PLAY_PAUSE (0xB3) to globally pause media playback
      // (works for Chrome/Edge HTML5 video + Spotify/etc.). System mute toggle
      // via VK_VOLUME_MUTE (0xAD) is intentionally NOT used because it is a
      // toggle and could leave the system muted if state diverges.
      try {
        await sendWindowsMediaPlayPause();
        isSystemMutedByApp = true;
        log("VolumeControl: Sent VK_MEDIA_PLAY_PAUSE on Windows");
      } catch (err) {
        logError("VolumeControl: Windows media-pause failed", err);
      }
      return;
    }

    // 1. Pause Chrome playing tabs
    try {
      const script = `tell application "Google Chrome"
      set pausedTabs to {}
      if it is running then
          repeat with w in windows
              repeat with t in tabs of w
                  try
                      set isPlaying to execute t javascript "(function() {
                          var played = false;
                          function scan(root) {
                              if (!root) return;
                              var v = root.querySelectorAll('video, audio');
                              for (var i = 0; i < v.length; i++) {
                                  if (!v[i].paused && v[i].muted === false && (typeof v[i].volume !== 'number' || v[i].volume > 0)) {
                                      v[i].setAttribute('data-diri-paused', 'true');
                                      v[i].pause();
                                      played = true;
                                  }
                              }
                              root.querySelectorAll('*').forEach(function(el) {
                                  if (el.shadowRoot) scan(el.shadowRoot);
                              });
                              root.querySelectorAll('iframe').forEach(function(f) {
                                  try { if (f.contentDocument) scan(f.contentDocument); } catch(e) {}
                              });
                          }
                          scan(document);
                          return played;
                      })()"
                      if isPlaying is true then
                          set end of pausedTabs to (id of t as string)
                      end if
                  end try
              end repeat
          end repeat
      end if
      return pausedTabs
  end tell`;

      const stdout = await runAppleScript(script);
      const trimmed = stdout.trim();
      if (trimmed) {
        const newPaused = trimmed.split(",").map(id => id.trim());
        for (const id of newPaused) {
          if (!pausedChromeTabs.includes(id)) {
            pausedChromeTabs.push(id);
          }
        }
        log(`VolumeControl: Paused Chrome tabs (accumulated): ${pausedChromeTabs.join(", ")}`);
      }
    } catch (err) {
      logError("VolumeControl: Chrome pause failed", err);
    }

    // 2. Mute system volume (for other browser/system sounds to ensure 100% silent recording)
    try {
      await execAsync("osascript -e 'set volume with output muted'");
      isSystemMutedByApp = true;
      log("VolumeControl: Muted system output");
    } catch (err) {
      logError("VolumeControl: Mute failed", err);
    }
  };

  activeMutePromise = muteAction().finally(() => {
    activeMutePromise = null;
  });

  return activeMutePromise;
}

async function unmuteSystemOnly(): Promise<void> {
  if (activeMutePromise) {
    log("unmuteSystemOnly: waiting for active mute operation to complete first...");
    await activeMutePromise;
  }

  if (isSystemMutedByApp) {
    if (process.platform === "win32") {
      // Windows did not actually mute the system in muteSystemAndPauseMedia
      // (only paused media), so there is nothing to undo here.
      isSystemMutedByApp = false;
      log("VolumeControl: Windows unmute is a no-op (system was not muted)");
      return;
    }
    try {
      await execAsync("osascript -e 'set volume without output muted'");
      isSystemMutedByApp = false;
      log("VolumeControl: Unmuted system output");
    } catch (err) {
      logError("VolumeControl: Unmute failed", err);
    }
  }
}

async function restoreMediaOnly(): Promise<void> {
  if (activeMutePromise) {
    log("restoreMediaOnly: waiting for active mute operation to complete first...");
    await activeMutePromise;
  }

  if (process.platform === "win32") {
    // Windows: send VK_MEDIA_PLAY_PAUSE again to resume playback.
    if (isSystemMutedByApp) {
      try {
        await sendWindowsMediaPlayPause();
        isSystemMutedByApp = false;
        log("VolumeControl: Resumed Windows media playback");
      } catch (err) {
        logError("VolumeControl: Windows media-resume failed", err);
      }
    }
    return;
  }

  if (pausedChromeTabs.length > 0) {
    try {
      const idsString = pausedChromeTabs.map(id => `"${id}"`).join(", ");
      const script = `tell application "Google Chrome"
    if it is running then
        repeat with w in windows
            repeat with t in tabs of w
                if (id of t as string) is in {${idsString}} then
                    try
                        execute t javascript "(function() {
                            var found = false;
                            function scan(root) {
                                if (!root) return;
                                var v = root.querySelectorAll('video[data-diri-paused=true], audio[data-diri-paused=true]');
                                for (var i = 0; i < v.length; i++) {
                                    v[i].play();
                                    v[i].removeAttribute('data-diri-paused');
                                    found = true;
                                }
                                root.querySelectorAll('*').forEach(function(el) {
                                    if (el.shadowRoot) scan(el.shadowRoot);
                                });
                                root.querySelectorAll('iframe').forEach(function(f) {
                                    try { if (f.contentDocument) scan(f.contentDocument); } catch(e) {}
                                });
                            }
                            scan(document);
                            if (!found) {
                                function resumeFallback(root) {
                                    if (!root) return;
                                    var all = root.querySelectorAll('video, audio');
                                    for (var i = 0; i < all.length; i++) {
                                        if (all[i].paused && all[i].muted === false && (typeof all[i].volume !== 'number' || all[i].volume > 0)) {
                                            all[i].play();
                                        }
                                    }
                                    root.querySelectorAll('*').forEach(function(el) {
                                        if (el.shadowRoot) resumeFallback(el.shadowRoot);
                                    });
                                    root.querySelectorAll('iframe').forEach(function(f) {
                                        try { if (f.contentDocument) resumeFallback(f.contentDocument); } catch(e) {}
                                    });
                                }
                                resumeFallback(document);
                            }
                        })()"
                    end try
                end if
            end repeat
        end repeat
    end if
end tell`;
      await runAppleScript(script);
      log(`VolumeControl: Resumed Chrome tabs: ${pausedChromeTabs.join(", ")}`);
    } catch (err) {
      logError("VolumeControl: Chrome resume failed", err);
    }
    pausedChromeTabs = [];
  }
}

function updateState(state: string, message?: string, metadata?: Record<string, any>): void {
  const payload = { state, ...(message ? { message } : {}), ...(metadata || {}) };
  log(`State update: ${state} ${message || ""} ${metadata ? JSON.stringify(metadata) : ""}`.trim());
  sendToFloatWindow(IPC_CHANNELS.STATE_UPDATE, JSON.stringify(payload));
  sendToPanelWindow(IPC_CHANNELS.STATE_UPDATE, JSON.stringify(payload));

  if (state === "speaking" && metadata?.isFinal) {
    showPanelWindow(metadata.text);
  } else if (state !== "speaking") {
    hidePanelWindow();
  }
}

function sendToSettingsWindow(channel: string, ...args: unknown[]): void {
  const win = getSettingsWindow();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, ...args);
  }
}

// ==================== 对话历史 ====================
interface ChatEntry {
  sender: "user" | "daisy";
  text: string;
  timestamp: number;
}

const MAX_HISTORY = 20;
let conversationHistory: ChatEntry[] = [];

function getHistoryFilePath(): string {
  return path.join(app.getPath("userData"), "conversation-history.json");
}

function loadConversationHistory(): void {
  try {
    const p = getHistoryFilePath();
    if (fs.existsSync(p)) {
      conversationHistory = JSON.parse(fs.readFileSync(p, "utf-8"));
    }
  } catch { conversationHistory = []; }
}

function saveConversationHistory(): void {
  try {
    fs.writeFileSync(getHistoryFilePath(), JSON.stringify(conversationHistory), "utf-8");
  } catch { /* ignore */ }
}

function addChatEntry(sender: "user" | "daisy", text: string): void {
  if (!text.trim()) return;
  conversationHistory.push({ sender, text: text.trim(), timestamp: Date.now() });
  if (conversationHistory.length > MAX_HISTORY * 2) {
    // Keep last MAX_HISTORY pairs (user + daisy)
    conversationHistory = conversationHistory.slice(-MAX_HISTORY * 2);
  }
  saveConversationHistory();
}

function downloadWhisperModel(modelName: string): void {
  const modelInfo = WHISPER_MODELS[modelName];
  if (!modelInfo) {
    sendToSettingsWindow(IPC_CHANNELS.WHISPER_DOWNLOAD_PROGRESS, { percent: 0, status: "未知模型" });
    return;
  }

  const modelDir = path.join(os.homedir(), "Models", "whisper");
  const modelPath = path.join(modelDir, modelName);

  if (!fs.existsSync(modelDir)) {
    fs.mkdirSync(modelDir, { recursive: true });
  }

  if (fs.existsSync(modelPath)) {
    sendToSettingsWindow(IPC_CHANNELS.WHISPER_DOWNLOAD_PROGRESS, { percent: 100, status: "已存在" });
    return;
  }

  sendToSettingsWindow(IPC_CHANNELS.WHISPER_DOWNLOAD_PROGRESS, { percent: 0, status: "开始下载..." });
  log(`Downloading whisper model: ${modelName} from ${modelInfo.url}`);

  // 支持多级 301/302 重定向（HF -> CloudFront）
  const requestWithRedirect = (url: string, hops: number) => {
    if (hops > 5) {
      handleDownloadError(new Error("重定向次数过多"), modelPath);
      return;
    }
    https
      .get(url, (response) => {
        if (
          (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) &&
          response.headers.location
        ) {
          const redirectUrl = response.headers.location;
          response.resume(); // 消耗掉响应体
          requestWithRedirect(redirectUrl, hops + 1);
          return;
        }
        if (response.statusCode !== 200) {
          handleDownloadError(new Error(`HTTP ${response.statusCode}`), modelPath);
          return;
        }
        const file = fs.createWriteStream(modelPath);
        handleDownloadResponse(response, file, modelPath, modelName);
      })
      .on("error", (err) => handleDownloadError(err, modelPath));
  };

  requestWithRedirect(modelInfo.url, 0);
}

function handleDownloadResponse(response: any, file: fs.WriteStream, modelPath: string, modelName: string): void {
  const totalBytes = parseInt(response.headers["content-length"] || "0", 10);
  let receivedBytes = 0;

  response.pipe(file);

  response.on("data", (chunk: Buffer) => {
    receivedBytes += chunk.length;
    if (totalBytes > 0) {
      const percent = Math.round((receivedBytes / totalBytes) * 100);
      sendToSettingsWindow(IPC_CHANNELS.WHISPER_DOWNLOAD_PROGRESS, { percent, status: `下载中 ${percent}%` });
    }
  });

  file.on("finish", () => {
    file.close();
    config.whisper.model = modelName;
    sendToSettingsWindow(IPC_CHANNELS.WHISPER_DOWNLOAD_PROGRESS, { percent: 100, status: "下载完成" });
    log(`Whisper model downloaded: ${modelPath}`);
  });

  file.on("error", (err) => {
    handleDownloadError(err, modelPath);
  });
}

function handleDownloadError(err: Error, modelPath: string): void {
  logError("Whisper model download failed", err);
  try { if (fs.existsSync(modelPath)) fs.unlinkSync(modelPath); } catch { /* ignore */ }
  sendToSettingsWindow(IPC_CHANNELS.WHISPER_DOWNLOAD_PROGRESS, { percent: 0, status: `下载失败: ${err.message}` });
}

function setupIpc(): void {
  // Electron throws when ipcMain.handle registers an already-handled channel.
  if (ipcHandlersRegistered) return;
  ipcHandlersRegistered = true;

  ipcMain.on(IPC_CHANNELS.START_RECORDING, () => {
    if (!runtimeStarted) return;
    wakeAndStartListening();
  });

  ipcMain.on(IPC_CHANNELS.STOP_RECORDING, () => {
    if (!runtimeStarted) return;
    endListening();
  });

  ipcMain.on(IPC_CHANNELS.SEND_TEXT, (_event, text: string) => {
    if (!runtimeStarted) return;
    wakeAndStartListening();
    sendToFloatWindow(IPC_CHANNELS.ASR_FINAL, text);
    handleUserInput(text);
  });

  ipcMain.on(IPC_CHANNELS.OPEN_SETTINGS, () => {
    createSettingsWindow();
  });

  ipcMain.on(IPC_CHANNELS.CLOSE_SETTINGS, () => {
    const win = getSettingsWindow();
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });

  ipcMain.on(IPC_CHANNELS.QUIT_APP, () => {
    app.quit();
  });

  ipcMain.on("window:set-ignore-mouse", (event, ignore: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(ignore, { forward: true });
    }
  });

  ipcMain.on("window:lock-panel-open", () => {
    isPanelSticky = true;
    log("Panel locked open by user interaction (sticky mode active)");
  });

  ipcMain.on(IPC_CHANNELS.TTS_MUTE_CURRENT, () => {
    muteCurrentAnswerSpeech();
  });

  ipcMain.on("window:resize-float", (_event, width: number, height: number) => {
    const win = getFloatWindow();
    if (win && !win.isDestroyed()) {
      const { x: screenX, y: screenY, width: screenWidth } = screen.getPrimaryDisplay().bounds;
      const x = screenX + Math.round((screenWidth - width) / 2);
      const y = screenY - 20;
      win.setBounds({ x, y, width, height });
    }
  });

  ipcMain.on(IPC_CHANNELS.RENDERER_ERROR, (_event, message: string) => {
    logError("Renderer error", message);
  });

  ipcMain.on(IPC_CHANNELS.RENDERER_LOG, (_event, message: string) => {
    logDebug(`Renderer: ${message}`);
  });

  ipcMain.on(IPC_CHANNELS.TTS_PLAY_ENDED, (_event, filePath?: string) => {
    log("TTS playback ended (renderer notification)");

    // Delete the played file
    const fileToDelete = filePath || currentPlayingFile;
    if (fileToDelete) {
      fs.promises.unlink(fileToDelete).catch(() => {});
    }
    currentPlayingFile = null;

    // If TTS was from an aborted session, ignore this event
    if (playingTtsSessionId !== null && playingTtsSessionId !== currentSessionId) {
      log(`TTS_PLAY_ENDED ignored — stale session ${playingTtsSessionId} (current: ${currentSessionId})`);
      playingTtsSessionId = null;
      return;
    }
    playingTtsSessionId = null;

    // If no longer speaking (aborted), ignore
    if (!isSpeaking) {
      log("TTS_PLAY_ENDED ignored — not speaking");
      return;
    }

    // Play next queued TTS file
    if (ttsFileQueue.length > 0) {
      const nextFile = ttsFileQueue.shift()!;
      log(`Playing next TTS file from queue (${ttsFileQueue.length} remaining)`);
      playTTSFile(nextFile);
      return;
    }

    // No more files — check if still synthesizing
    if (activeTtsSynthesisSessionId !== null) {
      log("Waiting for background TTS synthesis to complete...");
      let waitCount = 0;
      const waitInterval = setInterval(() => {
        if (!isSpeaking) {
          clearInterval(waitInterval);
          return;
        }
        waitCount++;
        if (ttsFileQueue.length > 0) {
          clearInterval(waitInterval);
          const nextFile = ttsFileQueue.shift()!;
          log(`Synthesis wait over, playing queued file (${ttsFileQueue.length} remaining)`);
          playTTSFile(nextFile);
        } else if (waitCount >= 30 || activeTtsSynthesisSessionId === null) {
          // Waited 15s (30 × 500ms) or synthesis finished
          clearInterval(waitInterval);
          if (ttsFileQueue.length > 0) {
            const nextFile = ttsFileQueue.shift()!;
            playTTSFile(nextFile);
          } else {
            isSpeaking = false;
            ttsPlayer = null;
            isSessionActive = false;
            updateState("idle");
            startAutoHideTimer();
          }
        }
      }, 500);
      return;
    }

    // All done
    isSpeaking = false;
    ttsPlayer = null;
    // If ack just finished and LLM is still processing, don't hide — wait for done
    if (toolAckPending) {
      log("Ack finished, waiting for LLM final answer");
      updateState("thinking");
      return;
    }
    if (isPanelSticky) {
      log("TTS ended, but panel is sticky: lock open");
      return;
    }
    isSessionActive = false;
    updateState("idle");
    startAutoHideTimer();
  });

  ipcMain.handle(IPC_CHANNELS.GET_CONFIG, () => {
    return {
      VOLCENGINE_APP_ID: config.asr.appId,
      VOLCENGINE_ACCESS_TOKEN: config.asr.accessToken,
      VOLCENGINE_RESOURCE_ID: config.asr.resourceId,
      DEEPSEEK_API_KEY: config.llm.apiKey,
      DEEPSEEK_BASE_URL: config.llm.baseUrl,
      DEEPSEEK_MODEL: config.llm.model,
      EDGE_TTS_VOICE: config.tts.voice,
      EDGE_TTS_RATE: config.tts.rate,
      GLOBAL_SHORTCUT: config.shortcut.globalShortcut,
      SHOW_DOCK_ICON: String(config.showDockIcon),
      WAKE_WORD_ENABLED: String(config.wakeWord.enabled),
      WAKE_WORD: config.wakeWord.keyword,
      FIRECRAWL_API_KEY: config.firecrawl.apiKey,
      WHISPER_MODEL: config.whisper.model,
      SHORTCUT_USE_WHISPER: String(config.whisper.shortcutUseWhisper),
      AUTO_LAUNCH: String(config.autoLaunch),
    };
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_CONFIG, async (_event, cfg: Record<string, string>) => {
    try {
      const envPath = getWritableEnvPath();

      const managedKeys = new Set([
        "VOLCENGINE_APP_ID", "VOLCENGINE_ACCESS_TOKEN", "VOLCENGINE_RESOURCE_ID",
        "VOLCENGINE_ASR_WS_URL",
        "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL",
        "EDGE_TTS_VOICE", "EDGE_TTS_RATE",
        "GLOBAL_SHORTCUT", "SHOW_DOCK_ICON",
        "WAKE_WORD_ENABLED", "WAKE_WORD",
        "FIRECRAWL_API_KEY",
        "WHISPER_MODEL", "SHORTCUT_USE_WHISPER",
        "AUTO_LAUNCH",
      ]);

      const existing: Record<string, string> = {};
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) {
            const k = trimmed.slice(0, eqIdx).trim();
            const v = trimmed.slice(eqIdx + 1).trim();
            existing[k] = v;
          }
        }
      }
      delete existing.CONTINUOUS_SHORTCUT;

      for (const [key, value] of Object.entries(cfg)) {
        if (managedKeys.has(key)) {
          existing[key] = value || "";
        }
      }

      const lines = Object.entries(existing).map(([k, v]) => `${k}=${v}`);
      fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");

      if (cfg.VOLCENGINE_APP_ID !== undefined) config.asr.appId = cfg.VOLCENGINE_APP_ID;
      if (cfg.VOLCENGINE_ACCESS_TOKEN !== undefined) config.asr.accessToken = cfg.VOLCENGINE_ACCESS_TOKEN;
      if (cfg.VOLCENGINE_RESOURCE_ID !== undefined) config.asr.resourceId = cfg.VOLCENGINE_RESOURCE_ID;
      if (cfg.DEEPSEEK_API_KEY !== undefined) config.llm.apiKey = cfg.DEEPSEEK_API_KEY;
      if (cfg.DEEPSEEK_BASE_URL !== undefined) config.llm.baseUrl = cfg.DEEPSEEK_BASE_URL;
      if (cfg.DEEPSEEK_MODEL !== undefined) config.llm.model = cfg.DEEPSEEK_MODEL;
      if (cfg.EDGE_TTS_VOICE !== undefined) config.tts.voice = cfg.EDGE_TTS_VOICE;
      if (cfg.EDGE_TTS_RATE !== undefined) config.tts.rate = cfg.EDGE_TTS_RATE;
      if (cfg.FIRECRAWL_API_KEY !== undefined) config.firecrawl.apiKey = cfg.FIRECRAWL_API_KEY;
      if (cfg.WHISPER_MODEL !== undefined) config.whisper.model = cfg.WHISPER_MODEL;
      if (cfg.WAKE_WORD !== undefined) config.wakeWord.keyword = cfg.WAKE_WORD;

      const prevWakeEnabled = config.wakeWord.enabled;
      if (cfg.WAKE_WORD_ENABLED !== undefined) {
        config.wakeWord.enabled = cfg.WAKE_WORD_ENABLED === "true";
      }
      if (cfg.SHORTCUT_USE_WHISPER !== undefined) {
        config.whisper.shortcutUseWhisper = cfg.SHORTCUT_USE_WHISPER === "true";
      }
      if (cfg.AUTO_LAUNCH !== undefined) {
        config.autoLaunch = cfg.AUTO_LAUNCH === "true";
        app.setLoginItemSettings({ openAtLogin: config.autoLaunch });
      }
      if (cfg.SHOW_DOCK_ICON !== undefined) {
        config.showDockIcon = cfg.SHOW_DOCK_ICON !== "false";
        setDockVisibility(config.showDockIcon);
      }
      if (cfg.GLOBAL_SHORTCUT !== undefined && cfg.GLOBAL_SHORTCUT.trim()) {
        config.shortcut.globalShortcut = cfg.GLOBAL_SHORTCUT;
        globalShortcut?.updateShortcut(cfg.GLOBAL_SHORTCUT);
      }
      if (config.wakeWord.enabled !== prevWakeEnabled) {
        if (config.wakeWord.enabled) {
          setupWakeWord();
        } else {
          wakeWordMonitor?.stop();
          wakeWordMonitor = null;
          setWakeWordCaptureEnabled(false);
        }
      }

      return true;
    } catch (error) {
      logError("Save config failed", error);
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.WHISPER_STATUS, async (_event, modelName?: string) => {
    const modelPath = getWhisperModelPath(modelName);
    let cliInstalled = false;
    try {
      const whichCmd = process.platform === "win32" ? "where whisper-cli" : "which whisper-cli";
      await execAsync(whichCmd);
      cliInstalled = true;
    } catch { /* not installed */ }
    if (!cliInstalled && process.platform === "darwin") {
      try {
        cliInstalled = fs.existsSync("/opt/homebrew/bin/whisper-cli");
      } catch { /* ignore */ }
    }
    // Bundled binary: on Windows whisper-cli.exe ships in assets/bin (never on
    // PATH), so `where` won't find it. getBundledBin resolves the packaged exe.
    if (!cliInstalled) {
      try {
        const bundled = getBundledBin("whisper-cli");
        if (path.isAbsolute(bundled) && fs.existsSync(bundled)) {
          cliInstalled = true;
        }
      } catch { /* ignore */ }
    }
    return {
      cliInstalled,
      modelExists: fs.existsSync(modelPath),
      modelPath,
      modelName: modelName || config.whisper.model,
    };
  });

  ipcMain.on(IPC_CHANNELS.WHISPER_DOWNLOAD, (_event, modelName: string) => {
    downloadWhisperModel(modelName);
  });

  ipcMain.on(IPC_CHANNELS.SHORTCUT_CAPTURE, (_event, requestedMode?: unknown) => {
    if (globalShortcut) {
      globalShortcut.startCapture(requestedMode === "single" ? "single" : "combo");
    }
  });

  ipcMain.on(IPC_CHANNELS.SHORTCUT_CAPTURE_CANCEL, () => {
    if (globalShortcut) {
      globalShortcut.stopCapture();
    }
    const win = getSettingsWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.SHORTCUT_CAPTURED, { keyName: "", cancelled: true });
    }
  });

  ipcMain.handle(IPC_CHANNELS.AUTOLAUNCH_GET, () => {
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle(IPC_CHANNELS.AUTOLAUNCH_SET, (_event, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled });
    config.autoLaunch = enabled;
    log(`Auto launch set to: ${enabled}`);
  });

  ipcMain.handle(IPC_CHANNELS.HISTORY_GET, () => {
    return conversationHistory;
  });

  ipcMain.handle(IPC_CHANNELS.HISTORY_CLEAR, () => {
    conversationHistory = [];
    saveConversationHistory();
    log("Conversation history cleared");
  });

  // ==================== 应用更新 ====================
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  ipcMain.handle(IPC_CHANNELS.APP_VERSION, () => {
    return app.getVersion();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    try {
      log("Checking for updates...");
      const result = await autoUpdater.checkForUpdates();
      if (!result || !result.updateInfo) {
        return { updateAvailable: false, currentVersion: app.getVersion() };
      }
      const latest = result.updateInfo.version;
      const current = app.getVersion();
      const updateAvailable = latest !== current;
      log(`Update check: current=${current}, latest=${latest}, available=${updateAvailable}`);
      return { updateAvailable, currentVersion: current, latestVersion: latest, releaseNotes: result.updateInfo.releaseNotes || "" };
    } catch (error: any) {
      logError("Update check failed", error);
      return { updateAvailable: false, currentVersion: app.getVersion(), error: error?.message || String(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, async () => {
    try {
      log("Downloading update...");
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (error: any) {
      logError("Update download failed", error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  autoUpdater.on("download-progress", (progress) => {
    const win = getSettingsWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.UPDATE_DOWNLOAD_PROGRESS, {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      });
    }
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, () => {
    log("Installing update and restarting...");
    autoUpdater.quitAndInstall(false, true);
  });

  // Right-click context menu (triggered from preload via IPC)
  ipcMain.on("context-menu:show", (_event, { isInput, selection }: { isInput: boolean; selection: string }) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win) return;

    const template: Electron.MenuItemConstructorOptions[] = [];

    if (selection) {
      template.push({
        label: "复制",
        click: () => {
          clipboard.writeText(selection);
        }
      });
    }
    if (isInput) {
      if (selection) template.push({ label: "剪切", role: "cut" });
      template.push({ label: "粘贴", role: "paste" });
      template.push({
        label: "全选",
        click: () => {
          win.webContents.selectAll();
        }
      });
    } else {
      template.push({
        label: "全选",
        click: () => {
          win.webContents.selectAll();
        }
      });
    }

    if (template.length > 0) {
      Menu.buildFromTemplate(template).popup({ window: win });
    }
  });

  ipcMain.handle("debug:get-metrics", () => {
    return getDetailedProcessMetrics();
  });
}

export function getDetailedProcessMetrics() {
  const roleMap: Record<number, string> = {
    [process.pid]: "Main Process"
  };

  const floatWin = getFloatWindow();
  if (floatWin && !floatWin.isDestroyed()) {
    roleMap[floatWin.webContents.getOSProcessId()] = "FloatBall Renderer";
  }

  const panelWin = getPanelWindow();
  if (panelWin && !panelWin.isDestroyed()) {
    roleMap[panelWin.webContents.getOSProcessId()] = "Panel Renderer";
  }

  const settingsWin = getSettingsWindow();
  if (settingsWin && !settingsWin.isDestroyed()) {
    roleMap[settingsWin.webContents.getOSProcessId()] = "Settings Renderer";
  }

  const audioWin = getAudioWindow();
  if (audioWin && !audioWin.isDestroyed()) {
    roleMap[audioWin.webContents.getOSProcessId()] = "Audio Renderer";
  }

  const metrics = app.getAppMetrics();
  for (const m of metrics) {
    if (m.type === "GPU") {
      roleMap[m.pid] = "GPU Process";
    }
  }

  return metrics.map((m) => ({
    pid: m.pid,
    type: m.type,
    role: roleMap[m.pid] || `Other (${m.type})`,
    cpuPercent: m.cpu.percentCPUUsage,
    memoryKB: m.memory.workingSetSize
  }));
}
