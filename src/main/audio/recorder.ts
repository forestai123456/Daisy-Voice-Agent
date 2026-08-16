import path from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../ipc/channels";
import { log } from "../utils/logger";

export enum RecorderState {
  IDLE = "IDLE",
  STARTING = "STARTING",
  RECORDING = "RECORDING",
  STOPPING = "STOPPING",
}

let audioWindow: BrowserWindow | null = null;
let currentState: RecorderState = RecorderState.IDLE;
let isReady = false;
let onAudioData: ((buffer: Buffer) => void) | null = null;
let onAudioError: ((message: string) => void) | null = null;

let startTimeout: NodeJS.Timeout | null = null;
let stopTimeout: NodeJS.Timeout | null = null;
let audioRecycleTimer: NodeJS.Timeout | null = null;
let pendingStartAfterStop = false;
let wakeWordCaptureEnabled = false;
let recordingGeneration = 0;
let activeRecordingGeneration = 0;

function cancelAudioRecycle(): void {
  if (audioRecycleTimer) {
    clearTimeout(audioRecycleTimer);
    audioRecycleTimer = null;
  }
}

export function destroyAudioWindow(): void {
  cancelAudioRecycle();
  if (audioWindow && !audioWindow.isDestroyed()) {
    log("[recorder] Recycling audioWindow after 30s idle");
    audioWindow.removeAllListeners();
    audioWindow.webContents?.removeAllListeners();
    audioWindow.destroy();
  }
  audioWindow = null;
  isReady = false;
}

function scheduleAudioRecycle(): void {
  cancelAudioRecycle();
  if (!wakeWordCaptureEnabled && currentState === RecorderState.IDLE) {
    audioRecycleTimer = setTimeout(() => {
      audioRecycleTimer = null;
      destroyAudioWindow();
    }, 30000);
  }
}

function transition(nextState: RecorderState): void {
  const prevState = currentState;
  if (prevState === nextState) return;
  currentState = nextState;
  log(`[recorder] State transition: ${prevState} -> ${nextState}`);
  if (nextState === RecorderState.IDLE) {
    scheduleAudioRecycle();
  }
}

export function getRecorderState(): RecorderState {
  return currentState;
}

export function getIsRecording(): boolean {
  return currentState === RecorderState.RECORDING || currentState === RecorderState.STARTING;
}

export function initAudioRecorder(
  onData: (buffer: Buffer) => void,
  onError: (message: string) => void,
): void {
  onAudioData = onData;
  onAudioError = onError;

  // Cleanup old listeners if any
  ipcMain.removeAllListeners(IPC_CHANNELS.AUDIO_DATA);
  ipcMain.removeAllListeners(IPC_CHANNELS.AUDIO_ERROR);
  ipcMain.removeAllListeners("audio:ready");
  ipcMain.removeAllListeners("audio:stopped");

  ipcMain.on(IPC_CHANNELS.AUDIO_DATA, (_event, base64: string, generation = 0) => {
    if (
      currentState !== RecorderState.IDLE &&
      Number(generation) !== activeRecordingGeneration
    ) {
      log(`[recorder] Ignoring stale audio data generation=${generation}, active=${activeRecordingGeneration}`);
      return;
    }
    if (onAudioData) {
      onAudioData(Buffer.from(base64, "base64"));
    }
  });

  ipcMain.on(IPC_CHANNELS.AUDIO_ERROR, (_event, message: string, generation = 0) => {
    if (
      currentState !== RecorderState.IDLE &&
      Number(generation) !== activeRecordingGeneration
    ) {
      log(`[recorder] Ignoring stale audio error generation=${generation}, active=${activeRecordingGeneration}`);
      return;
    }
    log(`[recorder] IPC Audio Error received: ${message}`);

    if (startTimeout) { clearTimeout(startTimeout); startTimeout = null; }
    if (stopTimeout) { clearTimeout(stopTimeout); stopTimeout = null; }
    pendingStartAfterStop = false;

    transition(RecorderState.IDLE);
    activeRecordingGeneration = 0;
    if (onAudioError) {
      onAudioError(message);
    }
  });

  ipcMain.on("audio:ready", (_event, generation = 0) => {
    log(`[recorder] IPC audio:ready received generation=${generation}.`);
    if (Number(generation) !== activeRecordingGeneration) {
      log(`[recorder] Ignoring stale audio:ready generation=${generation}, active=${activeRecordingGeneration}`);
      return;
    }
    if (currentState === RecorderState.STARTING) {
      if (startTimeout) {
        clearTimeout(startTimeout);
        startTimeout = null;
      }
      transition(RecorderState.RECORDING);
    } else {
      log(`[recorder] Warning: received audio:ready in state ${currentState}, ignoring.`);
    }
  });

  ipcMain.on("audio:stopped", (_event, generation = 0) => {
    log(`[recorder] IPC audio:stopped received generation=${generation}.`);
    if (Number(generation) !== activeRecordingGeneration) {
      log(`[recorder] Ignoring stale audio:stopped generation=${generation}, active=${activeRecordingGeneration}`);
      return;
    }
    if (currentState === RecorderState.STOPPING) {
      if (stopTimeout) {
        clearTimeout(stopTimeout);
        stopTimeout = null;
      }
      transition(RecorderState.IDLE);
      activeRecordingGeneration = 0;
      if (pendingStartAfterStop) {
        pendingStartAfterStop = false;
        log(`[recorder] Executing queued startRecording.`);
        startRecording();
      }
    } else {
      log(`[recorder] Warning: received audio:stopped in state ${currentState}, ignoring.`);
    }
  });

  // If wake word is enabled, ensure audio window is active; otherwise keep lazy
  if (wakeWordCaptureEnabled) {
    ensureAudioWindow();
  }
}

export function ensureAudioWindow(): BrowserWindow {
  cancelAudioRecycle();
  if (audioWindow && !audioWindow.isDestroyed()) {
    return audioWindow;
  }

  isReady = false;
  audioWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, "../../preload/index.js"),
    },
  });

  audioWindow.loadFile(path.join(__dirname, "../../renderer/audio.html"));

  audioWindow.webContents.on("did-finish-load", () => {
    isReady = true;
    log("[recorder] audio window loaded");
    sendToAudioWindow(IPC_CHANNELS.AUDIO_WAKE_WORD_ENABLED, wakeWordCaptureEnabled);
    // If we were waiting for the window to load to send START_RECORDING
    if (currentState === RecorderState.STARTING) {
      log("[recorder] audio window loaded while STARTING. Sending START_RECORDING.");
      sendToAudioWindow(IPC_CHANNELS.START_RECORDING);
    }
  });

  audioWindow.on("closed", () => {
    audioWindow = null;
    isReady = false;
  });

  return audioWindow;
}

export function getAudioWindow(): BrowserWindow | null {
  return audioWindow;
}

function sendToAudioWindow(channel: string, ...args: unknown[]): void {
  try {
    const win = ensureAudioWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  } catch (err) {
    console.error(`Error sending to audio window on channel ${channel}:`, err);
  }
}

/**
 * Keep the hidden audio renderer's microphone lifecycle synchronized with the
 * actual wake-word service. Shortcut recording remains independent: disabling
 * wake-word capture during a recording releases the microphone only after STOP.
 */
export function setWakeWordCaptureEnabled(enabled: boolean): void {
  wakeWordCaptureEnabled = enabled;
  log(`[recorder] Wake-word microphone capture enabled=${enabled}`);
  if (enabled) {
    cancelAudioRecycle();
    const win = ensureAudioWindow();
    if (isReady && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.AUDIO_WAKE_WORD_ENABLED, enabled);
    }
  } else {
    if (audioWindow && !audioWindow.isDestroyed() && isReady) {
      audioWindow.webContents.send(IPC_CHANNELS.AUDIO_WAKE_WORD_ENABLED, false);
    }
    if (currentState === RecorderState.IDLE) {
      scheduleAudioRecycle();
    }
  }
}

export function startRecording(): void {
  if (currentState === RecorderState.STOPPING) {
    log(`[recorder] startRecording called while STOPPING. Queuing start after stop completes.`);
    pendingStartAfterStop = true;
    return;
  }

  if (currentState !== RecorderState.IDLE) {
    log(`[recorder] startRecording called but state is ${currentState}, ignoring.`);
    return;
  }

  transition(RecorderState.STARTING);
  activeRecordingGeneration = ++recordingGeneration;

  // Set a safety timeout for STARTING state (e.g. if mic permission denied without error, or hangs)
  if (startTimeout) clearTimeout(startTimeout);
  startTimeout = setTimeout(() => {
    if (currentState === RecorderState.STARTING) {
      log(`[recorder] Start timeout. Force transitioning to IDLE.`);
      startTimeout = null;
      // A timeout must also cancel the renderer-side desired start; otherwise
      // it can keep capturing and poison the next recording attempt.
      sendToAudioWindow(IPC_CHANNELS.STOP_RECORDING, activeRecordingGeneration);
      transition(RecorderState.IDLE);
      activeRecordingGeneration = 0;
      if (onAudioError) {
        onAudioError("启动录音超时，请检查麦克风权限或重新尝试");
      }
    }
  }, 10000);
  sendToAudioWindow(IPC_CHANNELS.START_RECORDING, activeRecordingGeneration);
}

export function stopRecording(): void {
  // If we are calling stop, we should cancel any queued start
  pendingStartAfterStop = false;

  if (currentState === RecorderState.IDLE || currentState === RecorderState.STOPPING) {
    log(`[recorder] stopRecording called but state is ${currentState}, ignoring.`);
    return;
  }

  // Clear start timeout if we were still starting
  if (startTimeout) {
    clearTimeout(startTimeout);
    startTimeout = null;
  }

  transition(RecorderState.STOPPING);
  sendToAudioWindow(IPC_CHANNELS.STOP_RECORDING, activeRecordingGeneration);

  // Fallback timeout to ensure we return to IDLE even if renderer fails to send ACK
  if (stopTimeout) clearTimeout(stopTimeout);
  stopTimeout = setTimeout(() => {
    if (currentState === RecorderState.STOPPING) {
      log(`[recorder] Fallback: audio:stopped ACK timeout. Force transitioning to IDLE.`);
      stopTimeout = null;
      transition(RecorderState.IDLE);
      activeRecordingGeneration = 0;
      if (pendingStartAfterStop) {
        pendingStartAfterStop = false;
        log(`[recorder] Executing queued startRecording (fallback path).`);
        startRecording();
      }
    }
  }, 1000);
}
