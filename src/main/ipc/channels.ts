export const IPC_CHANNELS = {
  // Audio recorder -> main
  AUDIO_DATA: "audio:data",
  AUDIO_ERROR: "audio:error",
  AUDIO_WAKE_WORD_ENABLED: "audio:wake-word-enabled",

  // Main -> renderer
  ASR_PARTIAL: "asr:partial",
  ASR_FINAL: "asr:final",
  ASR_ERROR: "asr:error",
  LLM_STREAM: "llm:stream",
  LLM_DONE: "llm:done",
  LLM_ERROR: "llm:error",
  TTS_START: "tts:start",
  TTS_PLAY: "tts:play",
  TTS_END: "tts:end",
  TTS_PLAY_ENDED: "tts:play-ended",
  TTS_MUTE_CURRENT: "tts:mute-current",
  STATE_UPDATE: "state:update",
  SHOW_WINDOW: "window:show",
  HIDE_WINDOW: "window:hide",
  RENDERER_ERROR: "renderer:error",
  RENDERER_LOG: "renderer:log",

  // Renderer -> main
  START_RECORDING: "recording:start",
  STOP_RECORDING: "recording:stop",
  SEND_TEXT: "text:send",
  OPEN_SETTINGS: "settings:open",
  CLOSE_SETTINGS: "settings:close",
  GET_CONFIG: "config:get",
  UPDATE_CONFIG: "config:update",
  QUIT_APP: "app:quit",

  // Whisper model management
  WHISPER_STATUS: "whisper:status",
  WHISPER_DOWNLOAD: "whisper:download",
  WHISPER_DOWNLOAD_PROGRESS: "whisper:download-progress",

  // Shortcut capture
  SHORTCUT_CAPTURE: "shortcut:capture",
  SHORTCUT_CAPTURE_CANCEL: "shortcut:capture-cancel",
  SHORTCUT_CAPTURED: "shortcut:captured",

  // Auto launch
  AUTOLAUNCH_GET: "autolaunch:get",
  AUTOLAUNCH_SET: "autolaunch:set",

  // Conversation history
  HISTORY_GET: "history:get",
  HISTORY_CLEAR: "history:clear",

  // App update
  APP_VERSION: "app:version",
  UPDATE_CHECK: "update:check",
  UPDATE_DOWNLOAD: "update:download",
  UPDATE_DOWNLOAD_PROGRESS: "update:download-progress",
  UPDATE_INSTALL: "update:install",

} as const;
