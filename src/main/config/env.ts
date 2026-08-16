import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { app } from "electron";
import dotenv from "dotenv";

function getUserDataEnvPath(): string {
  try {
    return path.join(app.getPath("userData"), "daisy.env");
  } catch {
    return path.join(os.homedir(), ".daisy.env");
  }
}

function findEnvFile(): string | null {
  const userDataEnv = getUserDataEnvPath();
  const candidates = [
    userDataEnv,
    path.join(process.cwd(), "daisy.env"),
    path.join(__dirname, "..", "..", "..", "daisy.env"),
    path.join(__dirname, "..", "..", "daisy.env"),
    path.join(app?.getAppPath?.() || "", "daisy.env"),
    path.join(process.cwd(), ".env"),
    path.join(__dirname, "..", "..", "..", ".env"),
    path.join(__dirname, "..", "..", ".env"),
    path.join(app?.getAppPath?.() || "", ".env"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function loadEnv(): void {
  const envPath = findEnvFile();
  if (envPath) {
    // The user's persisted Daisy settings must win over inherited process
    // variables. Without override, a stale GLOBAL_SHORTCUT supplied by a
    // parent process can silently replace the value the user just saved.
    dotenv.config({ path: envPath, override: true });
  }
}

loadEnv();

export function getWritableEnvPath(): string {
  const userDataEnv = getUserDataEnvPath();
  if (fs.existsSync(userDataEnv)) return userDataEnv;
  const found = findEnvFile();
  if (found) {
    try {
      fs.accessSync(found, fs.constants.W_OK);
      return found;
    } catch {
      // bundled file is read-only, fall through to userData
    }
  }
  return userDataEnv;
}

export const config = {
  asr: {
    appId: process.env.VOLCENGINE_APP_ID || "",
    accessToken: process.env.VOLCENGINE_ACCESS_TOKEN || "",
    resourceId: process.env.VOLCENGINE_RESOURCE_ID || "volc.seedasr.sauc.duration",
    wsUrl: process.env.VOLCENGINE_ASR_WS_URL || "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
  },
  llm: {
    apiKey: process.env.DEEPSEEK_API_KEY || process.env.AI_TRANSLATION_API_KEY || "",
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    model: process.env.DEEPSEEK_MODEL || process.env.AI_TRANSLATION_MODEL || "deepseek-v4-flash",
    thinkingEnabled: process.env.DEEPSEEK_THINKING_ENABLED !== "false",
    reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT || "high",
  },
  tts: {
    voice: process.env.EDGE_TTS_VOICE || "zh-CN-XiaoxiaoNeural",
    rate: process.env.EDGE_TTS_RATE || "+20%",
  },
  whisper: {
    model: process.env.WHISPER_MODEL || "ggml-base.bin",
    shortcutUseWhisper: process.env.SHORTCUT_USE_WHISPER === "true",
  },
  shortcut: {
    // Windows uses the 3.0-style physical key poller so the wake shortcut has
    // real DOWN/UP edges: hold to talk and release to send. Default: F8.
    // macOS keeps RightOption hold-to-talk via the native key listener.
    globalShortcut: process.env.GLOBAL_SHORTCUT || (process.platform === "win32" ? "F8" : "RightOption"),
  },
  wakeWord: {
    enabled: process.env.WAKE_WORD_ENABLED !== "false",
    keyword: process.env.WAKE_WORD || "嘿 Daisy",
  },
  firecrawl: {
    apiKey: process.env.FIRECRAWL_API_KEY || "",
  },
  autoLaunch: process.env.AUTO_LAUNCH === "true",
  showDockIcon: process.env.SHOW_DOCK_ICON !== "false",
};

export const WHISPER_MODELS: Record<string, { label: string; size: string; url: string }> = {
  "ggml-tiny.bin": {
    label: "Tiny (39MB, 最快)",
    size: "39MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
  },
  "ggml-base.bin": {
    label: "Base (142MB, 推荐)",
    size: "142MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  },
  "ggml-small.bin": {
    label: "Small (466MB, 最准)",
    size: "466MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
  },
};

export function getWhisperModelPath(modelName?: string): string {
  const name = modelName || config.whisper.model;
  const appPath = app?.getAppPath?.() || "";
  const bundled = path.join(appPath, "assets", "models", name);
  if (fs.existsSync(bundled)) {
    // Resolve asar path to real filesystem path for external binaries (whisper-cli)
    if (appPath.includes(".asar")) {
      const unpacked = bundled.replace(".asar", ".asar.unpacked");
      if (fs.existsSync(unpacked)) return unpacked;
    }
    return bundled;
  }
  return path.join(os.homedir(), "Models", "whisper", name);
}

export function getBundledBin(name: string): string {
  const appPath = app?.getAppPath?.() || "";
  const isWin = process.platform === "win32";
  const bundled = path.join(appPath, "assets", "bin", name);
  const candidates: string[] = [];
  if (appPath.includes(".asar")) candidates.push(bundled.replace(".asar", ".asar.unpacked"));
  candidates.push(bundled);
  // On Windows, the bare name (e.g. "whisper-cli") won't match the .exe file.
  // Add an explicit <name>.exe candidate so callers can keep passing "whisper-cli".
  if (isWin && !name.toLowerCase().endsWith(".exe")) {
    const withExe = path.join(appPath, "assets", "bin", name + ".exe");
    if (appPath.includes(".asar")) candidates.push(withExe.replace(".asar", ".asar.unpacked"));
    candidates.push(withExe);
  }
  if (!isWin) {
    candidates.push("/opt/homebrew/bin/" + name);
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return name; // fallback to PATH
}

/**
 * Build the child-process env for spawning the bundled whisper-cli on Windows.
 * whisper-cli.exe lives in assets/bin but its ggml DLLs live in assets/lib,
 * which Windows does not search by default (DLL search order: exe dir, system,
 * cwd, PATH -- never a sibling `lib`). Prepend assets/lib to Path so the DLLs
 * resolve without hiding the orb, copying files, or touching PATH globally.
 * No-op on non-win32. Pass the resolved exe path to avoid recomputing it.
 */
export function getWhisperExecEnv(exePath?: string): NodeJS.ProcessEnv {
  if (process.platform !== "win32") return process.env;
  try {
    const exe = exePath || getBundledBin("whisper-cli");
    const libDir = path.join(path.dirname(exe), "..", "lib");
    if (libDir && fs.existsSync(libDir)) {
      // Node can expose both Path and PATH on Windows.  Environment variable
      // names are case-insensitive to Windows, but child_process chooses one
      // of the duplicate keys when it starts a program.  Keeping both meant
      // whisper-cli could receive the original PATH and fail to load its ggml
      // DLLs from assets/lib (STATUS_DLL_NOT_FOUND / 0xC0000135).
      const env: NodeJS.ProcessEnv = { ...process.env };
      const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
      const existing = pathKeys
        .map((key) => env[key])
        .find((value): value is string => Boolean(value)) || "";
      for (const key of pathKeys) delete env[key];
      env.PATH = `${libDir};${existing}`;
      return env;
    }
  } catch { /* ignore */ }
  return process.env;
}

export function isAsrConfigured(): boolean {
  return Boolean(config.asr.appId && config.asr.accessToken);
}

export function isLlmConfigured(): boolean {
  return Boolean(config.llm.apiKey);
}
