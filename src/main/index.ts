import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import https from "node:https";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { app, ipcMain, Menu, BrowserWindow, systemPreferences } from "electron";
import { autoUpdater } from "electron-updater";
import { config, isAsrConfigured, isLlmConfigured, getWhisperModelPath, getBundledBin, WHISPER_MODELS, getWritableEnvPath } from "./config/env";
import { IPC_CHANNELS } from "./ipc/channels";
import { createFloatWindow, getFloatWindow, sendToFloatWindow, showFloatWindow, hideFloatWindow } from "./windows/floatWindow";
import { createSettingsWindow, getSettingsWindow } from "./windows/settingsWindow";
import { initAudioRecorder, startRecording, stopRecording, getIsRecording, setWakeWordCaptureEnabled } from "./audio/recorder";
import { AsrSession } from "./asr";
import { WhisperAsrSession } from "./asr/whisper";
import { DeepSeekClient, DualChannel } from "./llm/deepseek";
import { ConversationManager } from "./llm/conversation";
import { EdgeTTSPlayer, startTTSCleanup, stopTTSCleanup } from "./tts/edgeTTS";
import { GlobalShortcut } from "./shortcut/globalShortcut";
import { WakeWordMonitor, VAD } from "./wakeword/monitor";
import { tryLocalCommand, initCommandRouter } from "./command/router";
import { log, logError } from "./utils/logger";

{
  const pathParts = (process.env.PATH || "").split(":").filter(Boolean);
  for (const p of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    if (!pathParts.includes(p)) pathParts.unshift(p);
  }
  process.env.PATH = pathParts.join(":");
}

const execAsync = promisify(exec);

const AUTO_HIDE_TIMEOUT_MS = 500;
const CONVERSATION_EXPIRE_MS = 5 * 60 * 1000; // 5 minutes

function playSound(name: string): void {
  exec(`afplay /System/Library/Sounds/${name}.aiff &`);
}

let asrSession: AsrSession | WhisperAsrSession | null = null;
let llmClient: DeepSeekClient | null = null;
let isSystemMutedByApp = false;
let pausedChromeTabs: string[] = [];
let ttsPlayer: EdgeTTSPlayer | null = null;
let globalShortcut: GlobalShortcut | null = null;
let shortcutPermissionTimer: NodeJS.Timeout | null = null;
let conversationManager: ConversationManager | null = null;
let autoHideTimer: NodeJS.Timeout | null = null;
let safetyNetTimer: NodeJS.Timeout | null = null;
let isOrbVisible = false;
let currentAiResponse = "";
let isSpeaking = false;
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

app.whenReady().then(() => {
  log("App ready");
  // Show dock icon on macOS
  if (process.platform === "darwin") {
    app.dock?.show();
  }
  // Sync auto-launch setting on startup
  if (config.autoLaunch) {
    app.setLoginItemSettings({ openAtLogin: true });
  }
  startTTSCleanup();
  initialize();
});

app.on("window-all-closed", () => {
  // Keep app running in background on macOS
});

app.on("activate", () => {
  if (!getFloatWindow() || getFloatWindow()!.isDestroyed()) {
    createFloatWindow();
  }
  createSettingsWindow();
});

app.on("before-quit", () => {
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

function initialize(): void {
  log("Initializing...");
  log(`ASR configured: ${isAsrConfigured()}, LLM configured: ${isLlmConfigured()}, shortcutUseWhisper: ${config.whisper.shortcutUseWhisper}`);
  createFloatWindow();
  createSettingsWindow();

  setupIpc();
  setupAudio();
  setupShortcut();
  setupWakeWord();
  setupPowerMonitor();
  initCommandRouter();
  loadConversationHistory();
  log("Initialization complete");
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
  });

  powerMonitor.on("unlock-screen", () => {
    isScreenLocked = false;
    log("PowerMonitor: Screen unlocked. Resuming wake word monitor.");
    if (wakeWordMonitor && config.wakeWord.enabled) {
      try {
        wakeWordMonitor.start();
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

    wasWokenByVoice = true;

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

function setupShortcut(): void {
  log("Setting up global shortcut");
  const startListener = () => {
    if (globalShortcut) return;
    globalShortcut = new GlobalShortcut();

    globalShortcut.on("captured", (keyName: string) => {
      const win = getSettingsWindow();
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.SHORTCUT_CAPTURED, { keyName });
      }
    });

    globalShortcut.on("pressed", () => {
      log("Shortcut pressed");
      wakeAndStartListening();
    });

    globalShortcut.on("released", () => {
      log("Shortcut released");
      endListening();
    });
  };

  if (process.platform === "darwin" && !systemPreferences.isTrustedAccessibilityClient(true)) {
    log("GlobalShortcut: waiting for macOS Accessibility permission");
    shortcutPermissionTimer = setInterval(() => {
      if (!systemPreferences.isTrustedAccessibilityClient(false)) return;
      if (shortcutPermissionTimer) clearInterval(shortcutPermissionTimer);
      shortcutPermissionTimer = null;
      log("GlobalShortcut: Accessibility permission granted");
      startListener();
    }, 1000);
    return;
  }

  startListener();
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
    playSound("Tink");
    updateState("idle");
    startAutoHideTimer();
    return true;
  }
  return false;
}

let isSessionActive = false;
let voiceWakeMode = false; // true when woken by voice (auto-send on silence)
let wasWokenByVoice = false; // tracks if session was initiated by voice wake-up
let voiceSilenceTimer: NodeJS.Timeout | null = null;
let voiceStartSilenceTimer: NodeJS.Timeout | null = null;
let earlyCommandTimer: NodeJS.Timeout | null = null;
let asrResultConsumed = false;
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

function muteCurrentAnswerSpeech(): void {
  if (!isSpeaking || toolAckPending) {
    log("TTS mute request ignored — no final answer is currently being spoken");
    return;
  }

  log("TTS muted by orb click; retaining current answer state");

  try {
    ttsPlayer?.stop();
  } catch {
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

  sendToFloatWindow(IPC_CHANNELS.TTS_END);
}

function abortAllTasks(): void {
  // Increment session ID — all async callbacks from old session become stale
  currentSessionId++;

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
  wasWokenByVoice = false;
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

  // Hold-to-talk should end on shortcut release, not on a brief pause between words.
  asrSession = useWhisper ? new WhisperAsrSession(false) : new AsrSession();
  asrSession.on("partial", (text) => {
    sendToFloatWindow(IPC_CHANNELS.ASR_PARTIAL, text);
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
  voiceWakeMode = false;
  log("Stopping recording and ASR");
  playSound("Frog");
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
    wasWokenByVoice = false;
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
    wasWokenByVoice = false;
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
  asrSession = null;
  isSessionActive = false;
  if (!text.trim()) {
    log("Empty transcript, going idle");
    updateState("idle");
    startAutoHideTimer();
    return;
  }

  addChatEntry("user", text);

  // Try local command router first (zero-latency for simple commands)
  tryLocalCommand(text).then((result) => {
    if (result.handled) {
      log(`Local command handled: ${result.action || ""}`);
      playSound("Tink");
      updateState("idle");
      startAutoHideTimer();
      return;
    }
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
    handleLLMRequest(processedText);
  }).catch((error) => {
    logError("Local command error", error);
    handleLLMRequest(text);
  });
}

function handleLLMRequest(text: string): void {
  const sessionId = currentSessionId;
  const conversation = ensureConversation();
  conversation.addUserMessage(text);

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
    updateState("idle");
    startAutoHideTimer();
    conversationManager?.reset();
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
  const clean = stripMarkdownForTTS(text);
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

function stripMarkdownForTTS(text: string): string {
  return text
    .replace(/\{"display"\s*:\s*"?/g, "")
    .replace(/"speech"\s*:\s*"?/g, "")
    .replace(/"\s*\}/g, "")
    .replace(/\\n/g, " ")
    .replace(/\\["\\/]/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*#_~|]/g, "")
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{2702}\u{2705}\u{2708}-\u{270F}\u{2764}\u{2763}\u{00A9}\u{00AE}\u{2122}\u{200D}\u{FE0F}]/gu, "")
    .replace(/℃/g, "度")
    .replace(/°C/g, "度")
    .replace(/°/g, "度")
    .replace(/~/g, "到")
    .replace(/\s{2,}/g, " ")
    .trim();
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
    log(`TTS play: ${filePath}`);
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
  log(`TTS play queued file: ${filePath}`);
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
  isOrbVisible = false;
  unmuteSystemOnly();
  restoreMediaOnly();
}

function startAutoHideTimer(): void {
  stopAutoHideTimer();
  // Don't start hide timer if TTS is still playing — will be called again when TTS ends
  if (isSpeaking) {
    log("Auto-hide deferred — TTS still playing");
    return;
  }
  autoHideTimer = setTimeout(() => {
    // Double-check: TTS might have started during the timer
    if (isSpeaking) {
      log("Auto-hide deferred again — TTS started during wait");
      return;
    }
    log("Auto-hiding orb after inactivity");
    hideOrb();
  }, AUTO_HIDE_TIMEOUT_MS);
  // 进入闲置立即恢复播放(不等悬浮球消失)
  unmuteSystemOnly();
  restoreMediaOnly();
  // Resume wake word monitoring when going idle
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

async function muteSystemAndPauseMedia(): Promise<void> {
  if (activeMutePromise) {
    return activeMutePromise;
  }

  const muteAction = async () => {
    log("Muting system and pausing Chrome media...");
    
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
  ipcMain.on("window:set-ignore-mouse", (event, ignore: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(ignore, { forward: true });
    }
  });

  ipcMain.on(IPC_CHANNELS.TTS_MUTE_CURRENT, () => {
    muteCurrentAnswerSpeech();
  });

  ipcMain.on(IPC_CHANNELS.RENDERER_LOG, (_event, message: string) => {
    log(`Renderer: ${message}`);
  });

  ipcMain.on(IPC_CHANNELS.START_RECORDING, () => {
    wakeAndStartListening();
  });

  ipcMain.on(IPC_CHANNELS.STOP_RECORDING, () => {
    endListening();
  });

  ipcMain.on(IPC_CHANNELS.SEND_TEXT, (_event, text: string) => {
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

  ipcMain.on(IPC_CHANNELS.RENDERER_ERROR, (_event, message: string) => {
    logError("Renderer error", message);
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
            if (wasWokenByVoice) {
              log("Continuous voice dialogue: loop back to listening");
              startVoiceListening();
            } else {
              isSessionActive = false;
              updateState("idle");
              startAutoHideTimer();
            }
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
    if (wasWokenByVoice) {
      log("Continuous voice dialogue: loop back to listening");
      startVoiceListening();
    } else {
      isSessionActive = false;
      updateState("idle");
      startAutoHideTimer();
    }
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
        "GLOBAL_SHORTCUT",
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
      if (cfg.GLOBAL_SHORTCUT !== undefined && cfg.GLOBAL_SHORTCUT.trim()) {
        config.shortcut.globalShortcut = cfg.GLOBAL_SHORTCUT;
        globalShortcut?.updateShortcut(cfg.GLOBAL_SHORTCUT);
      }

      if (config.wakeWord.enabled !== prevWakeEnabled) {
        if (config.wakeWord.enabled) {
          setupWakeWord();
        } else {
          wakeWordMonitor?.stop();
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
    const whisperCli = getBundledBin("whisper-cli");
    let cliInstalled = whisperCli !== "whisper-cli" && fs.existsSync(whisperCli);
    if (!cliInstalled) {
      try {
        await execAsync("which whisper-cli");
        cliInstalled = true;
      } catch { /* not installed */ }
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

  ipcMain.on(IPC_CHANNELS.SHORTCUT_CAPTURE, () => {
    if (globalShortcut) {
      globalShortcut.startCapture();
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
      template.push({ label: "复制", role: "copy" });
    }
    if (isInput) {
      if (selection) template.push({ label: "剪切", role: "cut" });
      template.push({ label: "粘贴", role: "paste" });
      template.push({ label: "全选", role: "selectAll" });
    } else if (selection) {
      template.push({ label: "全选", role: "selectAll" });
    }

    if (template.length > 0) {
      Menu.buildFromTemplate(template).popup({ window: win });
    }
  });
}
