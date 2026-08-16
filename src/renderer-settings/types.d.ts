// diriAPI 类型（跟 preload/index.ts 里的 DiriAPI 对齐）
export interface DiriAPI {
  startRecording: () => void;
  stopRecording: () => void;
  sendText: (text: string) => void;
  openSettings: () => void;
  closeSettings: () => void;
  getConfig: () => Promise<Record<string, string>>;
  updateConfig: (cfg: Record<string, string>) => Promise<boolean>;
  quitApp: () => void;

  sendAudioData: (base64: string) => void;
  sendAudioError: (message: string) => void;
  sendRendererError: (message: string) => void;
  sendRendererLog: (message: string) => void;
  sendTtsPlayEnded: () => void;
  muteCurrentTts: () => void;

  getWhisperStatus: (modelName?: string) => Promise<{
    cliInstalled: boolean;
    modelExists: boolean;
    modelPath: string;
    modelName: string;
  }>;
  downloadWhisperModel: (modelName: string) => void;
  onWhisperDownloadProgress: (
    cb: (p: { percent: number; status: string }) => void
  ) => () => void;

  captureShortcut: (mode: "single" | "combo") => void;
  cancelShortcutCapture: () => void;
  onShortcutCaptured: (
    cb: (payload: { keyName: string; cancelled?: boolean }) => void
  ) => () => void;

  getAutoLaunch: () => Promise<boolean>;
  setAutoLaunch: (enabled: boolean) => Promise<void>;

  getChatHistory: () => Promise<
    Array<{ sender: "user" | "daisy"; text: string; timestamp: number }>
  >;
  clearChatHistory: () => Promise<void>;

  // App update
  getAppVersion: () => Promise<string>;
  checkForUpdate: () => Promise<{
    updateAvailable: boolean;
    currentVersion: string;
    latestVersion?: string;
    releaseNotes?: string;
    error?: string;
  }>;
  downloadUpdate: () => Promise<{ success: boolean; error?: string }>;
  installUpdate: () => void;
  onUpdateDownloadProgress: (
    cb: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void
  ) => () => void;

  onAsrPartial: (cb: (text: string) => void) => () => void;
  onAsrFinal: (cb: (text: string) => void) => () => void;
  onAsrError: (cb: (message: string) => void) => () => void;
  onLlmStream: (cb: (chunk: string) => void) => () => void;
  onLlmDone: (cb: () => void) => () => void;
  onLlmError: (cb: (message: string) => void) => () => void;
  onTtsStart: (cb: () => void) => () => void;
  onTtsPlay: (cb: (filePath: string) => void) => () => void;
  onTtsEnd: (cb: () => void) => () => void;
  onStateUpdate: (cb: (state: string) => void) => () => void;
  onShowWindow: (cb: () => void) => () => void;
  onHideWindow: (cb: () => void) => () => void;
  onStartRecording: (cb: () => void) => () => void;
  onStopRecording: (cb: () => void) => () => void;
}

declare global {
  interface Window {
    diriAPI: DiriAPI;
  }
}

export {};
