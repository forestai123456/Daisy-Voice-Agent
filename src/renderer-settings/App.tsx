import { useState, useEffect, useRef } from "react";
import {
  Sparkles,
  Mic,
  Globe,
  Volume2,
  Zap,
  Keyboard,
  Settings,
  RefreshCw,
  Download,
  Check,
  AlertCircle,
  X,
  Power,
  History,
  ExternalLink,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { IdleOrb } from "./components/IdleOrb";

interface SettingsState {
  DEEPSEEK_API_KEY: string;
  DEEPSEEK_BASE_URL: string;
  DEEPSEEK_MODEL: string;
  VOLCENGINE_APP_ID: string;
  VOLCENGINE_ACCESS_TOKEN: string;
  VOLCENGINE_RESOURCE_ID: string;
  SHORTCUT_USE_WHISPER: boolean;
  FIRECRAWL_API_KEY: string;
  EDGE_TTS_VOICE: string;
  EDGE_TTS_RATE: number;
  WAKE_WORD_ENABLED: boolean;
  WHISPER_MODEL: string;
  GLOBAL_SHORTCUT_DISPLAY: string;
  AUTO_LAUNCH: boolean;
  SHOW_DOCK_ICON: boolean;
}

interface ChatEntry {
  sender: "user" | "daisy";
  text: string;
  timestamp: number;
}

const isWindows = navigator.userAgent.includes("Windows");
const DEFAULT_GLOBAL_SHORTCUT = isWindows ? "F8" : "RightOption";

const DEFAULT_SETTINGS: SettingsState = {
  DEEPSEEK_API_KEY: "",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  VOLCENGINE_APP_ID: "",
  VOLCENGINE_ACCESS_TOKEN: "",
  VOLCENGINE_RESOURCE_ID: "volc.seedasr.sauc.duration",
  SHORTCUT_USE_WHISPER: false,
  FIRECRAWL_API_KEY: "",
  EDGE_TTS_VOICE: "zh-CN-XiaoxiaoNeural",
  EDGE_TTS_RATE: 20,
  WAKE_WORD_ENABLED: true,
  WHISPER_MODEL: "ggml-base.bin",
  GLOBAL_SHORTCUT_DISPLAY: DEFAULT_GLOBAL_SHORTCUT,
  AUTO_LAUNCH: false,
  SHOW_DOCK_ICON: true,
};

function rateToStr(n: number): string {
  return (n >= 0 ? "+" : "") + n + "%";
}
function rateFromStr(s: string): number {
  const n = parseInt(s, 10);
  return isNaN(n) ? 20 : Math.max(-50, Math.min(50, n));
}

export default function App() {
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS);
  const [configLoaded, setConfigLoaded] = useState(false);

  const [activeSection, setActiveSection] = useState<string>("llm");
  const [whisperCliInstalled, setWhisperCliInstalled] = useState<boolean>(false);
  const [whisperModelStatus, setWhisperModelStatus] = useState<
    "not_downloaded" | "downloading" | "downloaded"
  >("not_downloaded");
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [shortcutCaptureTarget, setShortcutCaptureTarget] = useState<"wake" | null>(null);
  const [statusMessage, setStatusMessage] = useState<{
    text: string;
    type: "success" | "error" | "info" | "";
  }>({ text: "", type: "" });

  const [isHistoryOpen, setIsHistoryOpen] = useState<boolean>(false);
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [isQuitConfirmOpen, setIsQuitConfirmOpen] = useState<boolean>(false);

  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "available" | "downloading" | "ready" | "upToDate" | "error">("idle");
  const [updateMessage, setUpdateMessage] = useState<string>("");
  const [updateDownloadPercent, setUpdateDownloadPercent] = useState<number>(0);

  const isLLMActive = settings.DEEPSEEK_API_KEY.trim().length > 5;
  const isASRActive =
    settings.VOLCENGINE_APP_ID.trim().length > 0 &&
    settings.VOLCENGINE_ACCESS_TOKEN.trim().length > 0;
  const isWhisperActive = whisperCliInstalled && whisperModelStatus === "downloaded";
  const isFirecrawlActive = settings.FIRECRAWL_API_KEY.trim().length > 0;

  const statusTimerRef = useRef<number | null>(null);
  const showTemporaryStatus = (text: string, type: "success" | "error" | "info") => {
    setStatusMessage({ text, type });
    if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
    statusTimerRef.current = window.setTimeout(() => {
      setStatusMessage({ text: "", type: "" });
    }, 4000);
  };

  // ==================== 加载配置 ====================
  useEffect(() => {
    (async () => {
      try {
        if (!window.diriAPI) {
          /*
          showTemporaryStatus("Preload 未加载，请联系开发者", "error");
          */
          return;
        }
        const cfg = await window.diriAPI.getConfig();
        const merged: SettingsState = { ...DEFAULT_SETTINGS };
        if (cfg.DEEPSEEK_API_KEY !== undefined) merged.DEEPSEEK_API_KEY = cfg.DEEPSEEK_API_KEY;
        if (cfg.DEEPSEEK_BASE_URL !== undefined) merged.DEEPSEEK_BASE_URL = cfg.DEEPSEEK_BASE_URL;
        if (cfg.DEEPSEEK_MODEL !== undefined) merged.DEEPSEEK_MODEL = cfg.DEEPSEEK_MODEL;
        if (cfg.VOLCENGINE_APP_ID !== undefined) merged.VOLCENGINE_APP_ID = cfg.VOLCENGINE_APP_ID;
        if (cfg.VOLCENGINE_ACCESS_TOKEN !== undefined) merged.VOLCENGINE_ACCESS_TOKEN = cfg.VOLCENGINE_ACCESS_TOKEN;
        if (cfg.VOLCENGINE_RESOURCE_ID !== undefined) merged.VOLCENGINE_RESOURCE_ID = cfg.VOLCENGINE_RESOURCE_ID;
        if (cfg.SHORTCUT_USE_WHISPER !== undefined) merged.SHORTCUT_USE_WHISPER = cfg.SHORTCUT_USE_WHISPER === "true";
        if (cfg.FIRECRAWL_API_KEY !== undefined) merged.FIRECRAWL_API_KEY = cfg.FIRECRAWL_API_KEY;
        if (cfg.EDGE_TTS_VOICE !== undefined) merged.EDGE_TTS_VOICE = cfg.EDGE_TTS_VOICE;
        if (cfg.EDGE_TTS_RATE !== undefined) merged.EDGE_TTS_RATE = rateFromStr(cfg.EDGE_TTS_RATE);
        if (cfg.WAKE_WORD_ENABLED !== undefined) merged.WAKE_WORD_ENABLED = cfg.WAKE_WORD_ENABLED === "true";
        if (cfg.WHISPER_MODEL !== undefined) merged.WHISPER_MODEL = cfg.WHISPER_MODEL;
        if (cfg.GLOBAL_SHORTCUT !== undefined) merged.GLOBAL_SHORTCUT_DISPLAY = cfg.GLOBAL_SHORTCUT || DEFAULT_GLOBAL_SHORTCUT;
        if (cfg.AUTO_LAUNCH !== undefined) merged.AUTO_LAUNCH = cfg.AUTO_LAUNCH === "true";
        if (cfg.SHOW_DOCK_ICON !== undefined) merged.SHOW_DOCK_ICON = cfg.SHOW_DOCK_ICON !== "false";
        try {
          merged.AUTO_LAUNCH = await window.diriAPI.getAutoLaunch();
        } catch {}
        setSettings(merged);
        setConfigLoaded(true);
        await refreshWhisperStatus();
      } catch (err: any) {
        /*
        showTemporaryStatus("加载配置失败：" + (err?.message || err), "error");
        */
      }
    })();
  }, []);

  const refreshWhisperStatus = async (modelName?: string) => {
    try {
      const name = modelName || settings.WHISPER_MODEL;
      const status = await window.diriAPI.getWhisperStatus(name);
      setWhisperCliInstalled(status.cliInstalled);
      setWhisperModelStatus(status.modelExists ? "downloaded" : "not_downloaded");
    } catch {
      setWhisperCliInstalled(false);
      setWhisperModelStatus("not_downloaded");
    }
  };

  // ==================== 应用版本 + 下载进度 ====================
  useEffect(() => {
    (async () => {
      try {
        const v = await window.diriAPI.getAppVersion();
        setCurrentVersion(v);
      } catch { /* ignore */ }
    })();
    const off = window.diriAPI.onUpdateDownloadProgress((p) => {
      setUpdateDownloadPercent(p.percent);
      if (p.percent >= 100) {
        setUpdateStatus("ready");
        showTemporaryStatus("✓ 新版本已下载完成，点击重启安装", "success");
      }
    });
    return () => off();
  }, []);

  const handleInputChange = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  // ==================== 快捷键捕获 ====================
  useEffect(() => {
    if (!shortcutCaptureTarget) return;
    const target = shortcutCaptureTarget;
    const off = window.diriAPI.onShortcutCaptured((payload) => {
      if (payload.cancelled) {
        setShortcutCaptureTarget(null);
        showTemporaryStatus("已取消快捷键设置", "info");
        return;
      }
      if (payload.keyName) {
        handleInputChange("GLOBAL_SHORTCUT_DISPLAY", payload.keyName);
        setShortcutCaptureTarget(null);
        showTemporaryStatus(`快捷键已设置为：${payload.keyName}（保存后生效）`, "success");
      }
    });
    window.diriAPI.captureShortcut("single");
    return () => off();
  }, [shortcutCaptureTarget]);

  // The native listener owns global shortcuts.  Capture inside this focused
  // settings window as a fallback too, so a temporarily unavailable native
  // listener (for example, while Windows is scanning its helper process) does
  // not make the “设置快捷键” buttons appear broken.
  useEffect(() => {
    if (!shortcutCaptureTarget) return;

    const pressed = new Set<string>();
    const order: string[] = [];
    const labelFor = (event: KeyboardEvent): string => {
      const labels: Record<string, string> = {
        AltLeft: "LeftAlt", AltRight: "RightAlt",
        ControlLeft: "LeftControl", ControlRight: "RightControl",
        ShiftLeft: "LeftShift", ShiftRight: "RightShift",
        MetaLeft: "LeftWin", MetaRight: "RightWin",
        Space: "Space", Enter: "Return", Escape: "Escape",
        Tab: "Tab", Backspace: "Backspace", Delete: "Delete",
      };
      return labels[event.code] || event.key;
    };
    const apply = (keyName: string) => {
      handleInputChange("GLOBAL_SHORTCUT_DISPLAY", keyName);
      window.diriAPI.cancelShortcutCapture();
      setShortcutCaptureTarget(null);
      showTemporaryStatus(`快捷键已设置为：${keyName}（保存后生效）`, "success");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const key = labelFor(event);
      if (shortcutCaptureTarget === "wake") {
        apply(key);
        return;
      }
      if (!pressed.has(key)) {
        pressed.add(key);
        order.push(key);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      pressed.delete(labelFor(event));
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [shortcutCaptureTarget]);

  // ==================== Whisper 下载进度 ====================
  useEffect(() => {
    const off = window.diriAPI.onWhisperDownloadProgress((p) => {
      setDownloadProgress(p.percent);
      if (p.percent >= 100) {
        if (p.status === "下载完成" || p.status === "已存在") {
          setWhisperModelStatus("downloaded");
          showTemporaryStatus("✓ Whisper 模型下载完成", "success");
        } else if (p.status.startsWith("下载失败")) {
          setWhisperModelStatus("not_downloaded");
          showTemporaryStatus(p.status, "error");
        }
        setTimeout(() => refreshWhisperStatus(), 500);
      }
    });
    return () => off();
  }, []);

  // ==================== 保存设置 ====================
  const handleSaveSettings = async () => {
    if (!configLoaded) {
      showTemporaryStatus("配置正在加载，请稍候…", "error");
      return;
    }
    const payload: Record<string, string> = {
      DEEPSEEK_API_KEY: settings.DEEPSEEK_API_KEY.trim(),
      DEEPSEEK_BASE_URL: settings.DEEPSEEK_BASE_URL.trim(),
      DEEPSEEK_MODEL: settings.DEEPSEEK_MODEL.trim(),
      VOLCENGINE_APP_ID: settings.VOLCENGINE_APP_ID.trim(),
      VOLCENGINE_ACCESS_TOKEN: settings.VOLCENGINE_ACCESS_TOKEN.trim(),
      VOLCENGINE_RESOURCE_ID: settings.VOLCENGINE_RESOURCE_ID.trim(),
      SHORTCUT_USE_WHISPER: String(settings.SHORTCUT_USE_WHISPER),
      FIRECRAWL_API_KEY: settings.FIRECRAWL_API_KEY.trim(),
      EDGE_TTS_VOICE: settings.EDGE_TTS_VOICE,
      EDGE_TTS_RATE: rateToStr(settings.EDGE_TTS_RATE),
      WAKE_WORD_ENABLED: String(settings.WAKE_WORD_ENABLED),
      WHISPER_MODEL: settings.WHISPER_MODEL,
      GLOBAL_SHORTCUT: settings.GLOBAL_SHORTCUT_DISPLAY,
      AUTO_LAUNCH: String(settings.AUTO_LAUNCH),
      SHOW_DOCK_ICON: String(settings.SHOW_DOCK_ICON),
    };
    try {
      const ok = await window.diriAPI.updateConfig(payload);
      if (ok) {
        showTemporaryStatus("✓ 保存成功，已同步到 daisy.env", "success");
        await refreshWhisperStatus();
      } else {
        showTemporaryStatus("保存失败：主进程写入 daisy.env 出错", "error");
      }
    } catch (err: any) {
      showTemporaryStatus("保存失败：" + (err?.message || err), "error");
    }
  };

  // ==================== Whisper 操作 ====================
  const handleRefreshWhisper = async () => {
    showTemporaryStatus("正在检查本地 Whisper 状态…", "info");
    await refreshWhisperStatus();
    showTemporaryStatus("✓ Whisper 状态已刷新", "success");
  };

  const handleDownloadModel = () => {
    if (whisperModelStatus === "downloaded" || whisperModelStatus === "downloading") return;
    setWhisperModelStatus("downloading");
    setDownloadProgress(0);
    window.diriAPI.downloadWhisperModel(settings.WHISPER_MODEL);
    showTemporaryStatus(`开始下载 ${settings.WHISPER_MODEL} …`, "info");
  };

  // ==================== 对话历史 ====================
  const loadChatHistory = async () => {
    try {
      const history = await window.diriAPI.getChatHistory();
      setChatHistory(history);
    } catch {
      setChatHistory([]);
    }
  };

  const handleClearHistory = async () => {
    try {
      await window.diriAPI.clearChatHistory();
      setChatHistory([]);
      showTemporaryStatus("对话历史已清空", "info");
    } catch {}
  };

  const handleOpenHistory = () => {
    loadChatHistory();
    setIsHistoryOpen(true);
  };

  // ==================== 退出 ====================
  const handleConfirmQuit = () => {
    setIsQuitConfirmOpen(false);
    window.diriAPI.quitApp();
  };

  // ==================== 检查更新 ====================
  const handleCheckUpdate = async () => {
    if (updateStatus === "checking" || updateStatus === "downloading") return;
    try {
      setUpdateStatus("checking");
      setUpdateMessage("");
      setUpdateDownloadPercent(0);
      const result = await window.diriAPI.checkForUpdate();
      if (result.error) {
        setUpdateStatus("error");
        setUpdateMessage(result.error);
        showTemporaryStatus(`检查更新失败：${result.error}`, "error");
        return;
      }
      if (!result.updateAvailable) {
        setUpdateStatus("upToDate");
        setUpdateMessage(result.currentVersion);
        showTemporaryStatus("✓ 已是最新版本", "success");
        return;
      }
      setUpdateStatus("available");
      setUpdateMessage(`${result.currentVersion} → ${result.latestVersion}`);
      // 检查到更新后，自动开始下载
      try {
        const dl = await window.diriAPI.downloadUpdate();
        if (!dl.success) {
          setUpdateStatus("error");
          setUpdateMessage(dl.error || "下载失败");
          showTemporaryStatus(`下载失败：${dl.error || "未知错误"}`, "error");
          return;
        }
        setUpdateStatus("downloading");
        showTemporaryStatus(`正在下载新版本 ${result.latestVersion}…`, "info");
      } catch (err: any) {
        setUpdateStatus("error");
        setUpdateMessage(err?.message || String(err));
        showTemporaryStatus("下载失败：" + (err?.message || err), "error");
      }
    } catch (err: any) {
      setUpdateStatus("error");
      setUpdateMessage(err?.message || String(err));
      showTemporaryStatus("检查更新失败：" + (err?.message || err), "error");
    }
  };

  const handleInstallUpdate = () => {
    window.diriAPI.installUpdate();
  };

  return (
    <div className="settings-body min-h-screen text-slate-800 p-0 relative selection:bg-sky-100 flex items-center justify-center">
      <div className="bg-ambient-glow">
        <div className="orb orb-1"></div>
        <div className="orb orb-2"></div>
        <div className="orb orb-3"></div>
      </div>

      <div className="w-[1000px] h-[660px] relative z-10 grid grid-cols-[240px_1fr] gap-6 p-6">
        {/* Sidebar */}
        <aside className="liquid-glass flex flex-col h-full rounded-[28px] overflow-hidden p-5">
          <div className="flex items-center gap-[18px] pb-5 mb-5 border-b border-white/50 relative">
            <IdleOrb />
            <div>
              <h1 className="font-display font-bold text-[21px] tracking-wide text-slate-800">Daisy</h1>
              <p className="text-[11px] font-medium text-slate-400 mt-0.5">智能助理</p>
            </div>
          </div>

          <nav className="flex-1 flex flex-col gap-3.5 overflow-y-auto pr-1 pb-5 glass-scroll">
            {[
              { id: "llm", label: "模型配置", icon: Sparkles },
              { id: "asr", label: "语音识别", icon: Mic },
              { id: "search", label: "搜索工具", icon: Globe },
              { id: "tts", label: "语音播报", icon: Volume2 },
              { id: "wake", label: "语音唤醒", icon: Zap },
              { id: "shortcut", label: "快捷键", icon: Keyboard },
              { id: "system", label: "系统配置", icon: Settings },
            ].map((tab) => {
              const IconComp = tab.icon;
              const isActive = activeSection === tab.id;
              return (
                <button key={tab.id} onClick={() => setActiveSection(tab.id)}
                  className={`nav-item-3d ${isActive ? "active" : ""}`}>
                  <IconComp className={`w-4 h-4 ml-1.5 ${isActive ? "text-white" : "text-slate-500"}`} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="pt-4 mt-4 border-t border-white/50 flex flex-col gap-2.5">
            {[
              { label: "推理模型", active: isLLMActive },
              { label: "云端 ASR", active: isASRActive },
              { label: "Firecrawl", active: isFirecrawlActive },
            ].map((st, i) => (
              <div key={i} className="flex items-center justify-between text-[11px] px-1">
                <span className="text-slate-400 font-medium">{st.label}</span>
                <div className="flex items-center gap-2">
                  <span className="text-slate-500 font-mono text-[10px]">
                    {st.active ? "在线" : "未就绪"}
                  </span>
                  <div className={`glass-indicator-dot ${st.active ? "ok" : "warn"}`}></div>
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* Content */}
        <div className="relative flex flex-col h-full overflow-visible pb-2">
          <main className="flex-1 min-h-0 overflow-y-auto pb-4 pr-2 glass-scroll">
            <div key={activeSection} className="flex flex-col gap-5">
                {/* LLM */}
                {activeSection === "llm" && (
                  <div className="flex flex-col gap-3.5">
                    <div>
                      <div className="mb-1.5 px-1 flex items-baseline justify-between">
                        <h2 className="font-display font-semibold text-[13px] tracking-tight text-slate-800">推理模型</h2>
                        <p className="text-[11px] text-slate-400 flex items-center gap-1">
                          <span>配置推理模型</span>
                          <span className="text-slate-300 select-none">•</span>
                          <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-slate-400 hover:text-slate-600 transition-all active:scale-95 cursor-pointer font-medium hover:underline">
                            <ExternalLink className="w-3.5 h-3.5" />
                            <span>获取</span>
                          </a>
                        </p>
                      </div>
                      <div className="liquid-glass py-2.5 px-4 rounded-[16px] flex flex-col gap-2.5">
                        <div className="flex flex-col gap-1">
                          <label className="text-[11px] font-semibold text-slate-500 ml-1">API Key</label>
                          <input type="password" value={settings.DEEPSEEK_API_KEY}
                            onChange={(e) => handleInputChange("DEEPSEEK_API_KEY", e.target.value)}
                            placeholder="sk-..." className="glass-input !py-1.5 !px-3 text-[12px]" autoComplete="off" />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[11px] font-semibold text-slate-500 ml-1">模型 (Model)</label>
                          <input type="text" value={settings.DEEPSEEK_MODEL}
                            onChange={(e) => handleInputChange("DEEPSEEK_MODEL", e.target.value)}
                            placeholder="deepseek-v4-flash" className="glass-input !py-1.5 !px-3 text-[12px]" />
                        </div>
                      </div>
                    </div>

                  </div>
                )}

                {/* ASR */}
                {activeSection === "asr" && (
                  <div className="flex flex-col gap-5">
                    <div>
                     <div className="mb-5 px-1">
                       <p className="text-[12px] text-slate-400 mt-1">{isWindows ? "Windows：按住快捷键说话，松开后发送；推荐使用 F8 / F9。" : "全局唤醒设置：按住说话，松手发送。点击右侧按钮后按下任意按键设置"}</p>
                        <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">语音识别</h2>
                        <p className="text-[12px] text-slate-400 mt-1 flex items-center gap-1.5 flex-wrap">
                          <span>火山引擎 / 豆包 Seed ASR，用于将语音转成文字</span>
                          <span className="text-slate-300 select-none">•</span>
                          <a
                            href="https://console.volcengine.com/speech/service/10038"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-slate-400 hover:text-slate-600 transition-all active:scale-95 cursor-pointer font-medium hover:underline"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            <span>获取</span>
                          </a>
                        </p>
                      </div>
                      <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-5">
                        <div className="flex flex-col gap-2">
                          <label className="text-[12px] font-semibold text-slate-500 ml-1">App ID</label>
                          <input type="text" value={settings.VOLCENGINE_APP_ID}
                            onChange={(e) => handleInputChange("VOLCENGINE_APP_ID", e.target.value)}
                            placeholder="VOLCENGINE_APP_ID" className="glass-input" />
                        </div>
                        <div className="flex flex-col gap-2">
                          <label className="text-[12px] font-semibold text-slate-500 ml-1">Access Token</label>
                          <input type="password" value={settings.VOLCENGINE_ACCESS_TOKEN}
                            onChange={(e) => handleInputChange("VOLCENGINE_ACCESS_TOKEN", e.target.value)}
                            placeholder="VOLCENGINE_ACCESS_TOKEN" className="glass-input" autoComplete="off" />
                        </div>
                        <div className="flex flex-col gap-2">
                          <label className="text-[12px] font-semibold text-slate-500 ml-1">Resource ID</label>
                          <input type="text" value={settings.VOLCENGINE_RESOURCE_ID}
                            onChange={(e) => handleInputChange("VOLCENGINE_RESOURCE_ID", e.target.value)}
                            placeholder="volc.seedasr.sauc.duration" className="glass-input" />
                     </div>
                   </div>
                    </div>
                    <div className="liquid-glass p-5 rounded-[22px] flex items-center justify-between">
                      <div className="flex flex-col gap-1 pr-4">
                        <h4 className="text-sm font-semibold text-slate-800">快捷键模式改用本地 Whisper</h4>
                        <p className="text-[11px] text-slate-400">开启后按快捷键说话不调用云端 ASR，零成本但识别率略低</p>
                      </div>
                      <label className="glass-switch-container">
                        <input type="checkbox" checked={settings.SHORTCUT_USE_WHISPER}
                          onChange={(e) => handleInputChange("SHORTCUT_USE_WHISPER", e.target.checked)} />
                        <div className="glass-switch-track"><div className="glass-switch-thumb"></div></div>
                      </label>
                    </div>
                  </div>
                )}

                {/* Search */}
                {activeSection === "search" && (
                  <div>
                    <div className="mb-5 px-1">
                      <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">联网搜索</h2>
                      <p className="text-[12px] text-slate-400 mt-1 flex items-center gap-1.5 flex-wrap">
                        <span>Firecrawl 提供的网页智能搜索与实时爬取能力</span>
                        <span className="text-slate-300 select-none">•</span>
                        <a
                          href="https://www.firecrawl.dev/app/api-keys"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 text-slate-400 hover:text-slate-600 transition-all active:scale-95 cursor-pointer font-medium hover:underline"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span>获取</span>
                        </a>
                      </p>
                    </div>
                    <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-5">
                      <div className="flex flex-col gap-2">
                        <label className="text-[12px] font-semibold text-slate-500 ml-1">API Key</label>
                        <input type="password" value={settings.FIRECRAWL_API_KEY}
                          onChange={(e) => handleInputChange("FIRECRAWL_API_KEY", e.target.value)}
                          placeholder="fc-..." className="glass-input" autoComplete="off" />
                      </div>
                    </div>
                  </div>
                )}

                {/* TTS */}
                {activeSection === "tts" && (
                  <div>
                    <div className="mb-5 px-1">
                      <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">语音播报</h2>
                      <p className="text-[12px] text-slate-400 mt-1">Edge TTS 高自然语音合成</p>
                    </div>
                    <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-6">
                      <div className="flex flex-col gap-2">
                        <label className="text-[12px] font-semibold text-slate-500 ml-1">播报音色</label>
                        <div className="select-container">
                          <select value={settings.EDGE_TTS_VOICE}
                            onChange={(e) => handleInputChange("EDGE_TTS_VOICE", e.target.value)}
                            className="glass-select">
                            <optgroup label="女声">
                              <option value="zh-CN-XiaoxiaoNeural">晓晓 (默认, 温暖自然)</option>
                              <option value="zh-CN-XiaoyiNeural">晓伊 (活泼灵动)</option>
                            </optgroup>
                            <optgroup label="男声">
                              <option value="zh-CN-YunxiNeural">云希 (极富磁性)</option>
                              <option value="zh-CN-YunyangNeural">云扬 (新闻播报风格)</option>
                              <option value="zh-CN-YunjianNeural">云健 (浑厚有力)</option>
                            </optgroup>
                            <optgroup label="特色方言">
                              <option value="zh-CN-liaoning-XiaobeiNeural">晓贝 (爽朗东北话)</option>
                              <option value="zh-CN-shaanxi-XiaoniNeural">晓妮 (朴实陕西话)</option>
                              <option value="zh-TW-HsiaoChenNeural">曉臻 (嗲雅台湾腔)</option>
                              <option value="zh-HK-HiuMaanNeural">曉曼 (粤语女声)</option>
                            </optgroup>
                          </select>
                        </div>
                      </div>
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between ml-1">
                          <label className="text-[12px] font-semibold text-slate-500">语速调整</label>
                          <span className="text-[11px] font-bold font-mono text-sky-600 bg-sky-50/70 border border-sky-200/50 px-2 py-0.5 rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                            {rateToStr(settings.EDGE_TTS_RATE)}
                          </span>
                        </div>
                        <div className="pt-2">
                          <input type="range" min="-50" max="50" step="5"
                            value={settings.EDGE_TTS_RATE}
                            onChange={(e) => handleInputChange("EDGE_TTS_RATE", parseInt(e.target.value, 10))}
                            className="glass-slider" />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Wake */}
                {activeSection === "wake" && (
                  <div className="flex flex-col gap-5">
                    <div>
                      <div className="mb-5 px-1">
                        <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">语音唤醒</h2>
                        <p className="text-[12px] text-slate-400 mt-1">基于本地 Whisper.cpp 的智能唤醒词监听</p>
                      </div>
                      <div className="liquid-glass p-5 rounded-[22px] flex items-center justify-between">
                        <div className="flex flex-col gap-1 pr-4">
                          <h4 className="text-sm font-semibold text-slate-800">启用语音唤醒</h4>
                          <p className="text-[11px] text-slate-400">
                            对着麦克风说出 <strong className="font-semibold text-[14px] text-slate-800 bg-slate-100/80 px-1.5 py-0.5 rounded-[4px] mx-1">"Hey, Daisy"</strong> 即可唤醒助理
                          </p>
                        </div>
                        <label className="glass-switch-container">
                          <input type="checkbox" checked={settings.WAKE_WORD_ENABLED}
                            onChange={(e) => handleInputChange("WAKE_WORD_ENABLED", e.target.checked)} />
                          <div className="glass-switch-track"><div className="glass-switch-thumb"></div></div>
                        </label>
                      </div>
                    </div>
                    <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-4.5">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-1">
                        <span className="text-[13px] font-semibold text-slate-700">whisper-cli</span>
                        {whisperCliInstalled ? (
                          <span className="text-[12px] font-bold text-emerald-500 flex items-center gap-1">
                            <Check className="w-4 h-4" /> 已安装
                          </span>
                        ) : (
                          <span className="text-[12px] font-semibold text-rose-500 flex items-center gap-1">
                            <AlertCircle className="w-3.5 h-3.5" /> 未安装
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] font-semibold text-slate-700">依赖模型</span>
                        <div className="select-container w-44">
                          <select value={settings.WHISPER_MODEL}
                            onChange={(e) => { handleInputChange("WHISPER_MODEL", e.target.value); setTimeout(() => refreshWhisperStatus(e.target.value), 150); }}
                            className="glass-select py-1.5 text-[12px] pr-8">
                            <option value="ggml-tiny.bin">Tiny (39MB, 极速)</option>
                            <option value="ggml-base.bin">Base (142MB, 均衡)</option>
                            <option value="ggml-small.bin">Small (466MB, 精准)</option>
                          </select>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] font-semibold text-slate-700">模型状态</span>
                        {whisperModelStatus === "downloaded" ? (
                          <span className="text-[12px] font-bold text-emerald-500">✓ 已就绪 (本地缓存)</span>
                        ) : whisperModelStatus === "downloading" ? (
                          <span className="text-[12px] font-bold text-sky-500 animate-pulse">↓ 正在下载 ({downloadProgress}%)</span>
                        ) : (
                          <span className="text-[12px] font-semibold text-rose-500 flex items-center gap-1">
                            <AlertCircle className="w-3.5 h-3.5" /> ✗ 未下载 (需安装)
                          </span>
                        )}
                      </div>
                      {whisperModelStatus === "downloading" && (
                        <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden shadow-inner border border-white">
                          <div className="bg-gradient-to-r from-emerald-400 to-teal-400 h-full rounded-full transition-all duration-200"
                            style={{ width: `${downloadProgress}%` }} />
                        </div>
                      )}
                      <div className="flex gap-3 pt-2">
                        <button onClick={handleRefreshWhisper}
                          className="flex-1 py-2.5 rounded-full btn-glass-clear cursor-pointer text-[12px] flex items-center justify-center gap-1.5">
                          <RefreshCw className="w-3.5 h-3.5" /><span>刷新状态</span>
                        </button>
                        <button onClick={handleDownloadModel}
                          disabled={whisperModelStatus === "downloaded" || whisperModelStatus === "downloading"}
                          className={`flex-1 py-2.5 rounded-full cursor-pointer text-[12px] flex items-center justify-center gap-1.5 ${
                            whisperModelStatus === "downloaded"
                              ? "bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed"
                              : "btn-glass-blue text-white"}`}>
                          <Download className="w-3.5 h-3.5" />
                          <span>{whisperModelStatus === "downloaded" ? "模型已下载" : "下载模型"}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Shortcut */}
                {activeSection === "shortcut" && (
                  <div>
                    <div className="mb-5 px-1">
                      <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">快捷键</h2>
                      <p className="text-[12px] text-slate-400 mt-1">Windows：按住快捷键说话，松开后发送；默认 F8。</p>
                    </div>
                    <div className="flex flex-col gap-5">
                      <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-5">
                        <div className="flex flex-col gap-2">
                          <label className="text-[12px] font-semibold text-slate-500 ml-1">唤醒触发键</label>
                          <div className="flex gap-4 items-center">
                            <div className={`flex-1 font-mono font-semibold px-4 py-3.5 rounded-2xl border text-center transition-all ${
                              shortcutCaptureTarget === "wake" ? "bg-sky-50 text-sky-500 border-sky-300 animate-pulse" : "glass-input"}`}>
                              {shortcutCaptureTarget === "wake" ? "请按下快捷键，保存后生效" : settings.GLOBAL_SHORTCUT_DISPLAY}
                            </div>
                            <button onClick={() => setShortcutCaptureTarget("wake")} disabled={shortcutCaptureTarget !== null}
                              className="btn-glass-blue px-6 py-3.5 rounded-2xl cursor-pointer font-medium text-[13px]">
                              <span>{shortcutCaptureTarget === "wake" ? "监听中..." : "设置快捷键"}</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* System */}
                {activeSection === "system" && (
                  <div>
                    <div className="mb-5 px-1">
                      <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">系统</h2>
                      <p className="text-[12px] text-slate-400 mt-1">开机自启、版本与更新检查</p>
                    </div>
                    <div className="liquid-glass p-5 rounded-[22px] flex items-center justify-between">
                      <div className="flex flex-col gap-1 pr-4">
                        <h4 className="text-sm font-semibold text-slate-800">在 Dock 中显示 Daisy</h4>
                        <p className="text-[11px] text-slate-400">关闭后 Daisy 仍在后台运行，可从菜单栏图标打开设置或重新显示 Dock</p>
                      </div>
                      <label className="glass-switch-container">
                        <input type="checkbox" checked={settings.SHOW_DOCK_ICON}
                          onChange={(e) => handleInputChange("SHOW_DOCK_ICON", e.target.checked)} />
                        <div className="glass-switch-track"><div className="glass-switch-thumb"></div></div>
                      </label>
                    </div>
                    <div className="liquid-glass p-5 rounded-[22px] flex items-center justify-between mt-5">
                      <div className="flex flex-col gap-1 pr-4">
                        <h4 className="text-sm font-semibold text-slate-800">开机自启</h4>
                        <p className="text-[11px] text-slate-400">在您的计算机启动或登录系统时，自动激活并后台运行 Daisy</p>
                      </div>
                      <label className="glass-switch-container">
                        <input type="checkbox" checked={settings.AUTO_LAUNCH}
                          onChange={(e) => handleInputChange("AUTO_LAUNCH", e.target.checked)} />
                        <div className="glass-switch-track"><div className="glass-switch-thumb"></div></div>
                      </label>
                    </div>
                    <div className="liquid-glass p-5 rounded-[22px] flex items-center justify-between mt-5">
                      <div className="flex flex-col gap-1 pr-4">
                        <h4 className="text-sm font-semibold text-slate-800">当前版本</h4>
                        <p className="text-[11px] text-slate-400">
                          {currentVersion ? `v${currentVersion}` : "读取中…"}
                          {updateStatus === "upToDate" && updateMessage && (
                            <span className="ml-2 text-emerald-500">✓ 已是最新</span>
                          )}
                          {updateStatus === "available" && updateMessage && (
                            <span className="ml-2 text-amber-500">→ {updateMessage.split("→ ")[1]}</span>
                          )}
                          {(updateStatus === "checking" || updateStatus === "downloading") && (
                            <span className="ml-2 text-sky-500">
                              {updateStatus === "checking" ? "正在检查…" : `下载中 ${updateDownloadPercent}%`}
                            </span>
                          )}
                          {updateStatus === "ready" && (
                            <span className="ml-2 text-emerald-500">✓ 新版本已就绪</span>
                          )}
                          {updateStatus === "error" && (
                            <span className="ml-2 text-rose-500">{updateMessage || "出错"}</span>
                          )}
                        </p>
                        {updateStatus === "downloading" && (
                          <div className="w-full max-w-[260px] bg-slate-100 rounded-full h-2 overflow-hidden shadow-inner border border-white mt-2">
                            <div className="bg-gradient-to-r from-emerald-400 to-teal-400 h-full rounded-full transition-all duration-200"
                              style={{ width: `${updateDownloadPercent}%` }} />
                          </div>
                        )}
                      </div>
                      {(updateStatus === "ready") ? (
                        <button onClick={handleInstallUpdate}
                          className="btn-glass-blue px-6 py-3 rounded-full cursor-pointer text-[13px] font-medium">
                          <span>重启并安装</span>
                        </button>
                      ) : (
                        <button onClick={handleCheckUpdate}
                          disabled={updateStatus === "checking" || updateStatus === "downloading"}
                          className={`px-6 py-3 rounded-full text-[13px] font-medium ${
                            updateStatus === "checking" || updateStatus === "downloading"
                              ? "bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed"
                              : "btn-glass-red text-white cursor-pointer"
                          }`}>
                          <span>
                            {updateStatus === "checking" ? "检查中…" :
                             updateStatus === "downloading" ? `下载中 ${updateDownloadPercent}%` :
                             updateStatus === "upToDate" ? "再次检查" :
                             updateStatus === "error" ? "重试" :
                             updateStatus === "available" ? "下载中…" : "检查更新"}
                          </span>
                        </button>
                      )}
                    </div>
                  </div>
                )}
            </div>
          </main>

          {/* Footer */}
          <footer className="h-[72px] liquid-glass rounded-[22px] px-5 flex items-center justify-between gap-4 mr-2 shrink-0 mt-4">
            <div className="flex-1 min-w-0 pr-4">
              <AnimatePresence mode="wait">
                {statusMessage.text && (
                  <motion.div key={statusMessage.text}
                    initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }}
                    className={`text-[12px] font-medium flex items-center gap-1.5 truncate ${
                      statusMessage.type === "success" ? "text-emerald-500"
                      : statusMessage.type === "error" ? "text-rose-500" : "text-sky-500"}`}>
                    <span className="w-2 h-2 rounded-full bg-current" />
                    <span>{statusMessage.text}</span>
                  </motion.div>
                )}
              </AnimatePresence>
              {!statusMessage.text && (
                <span className="text-[11px] text-slate-400 font-medium">
                  配置项与后台服务动态同步
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <button onClick={handleOpenHistory}
                className="px-5 py-3 rounded-full btn-glass-green cursor-pointer text-[13px] flex items-center gap-1.5">
                <History className="w-4 h-4 text-emerald-600" />
                <span>对话历史</span>
              </button>
              <button onClick={handleSaveSettings} disabled={!configLoaded}
                className="px-6 py-3 rounded-full btn-glass-blue cursor-pointer text-[13px]">
                <span>保存设置</span>
              </button>
            </div>
          </footer>
        </div>
      </div>

      {/* 对话历史弹窗 */}
      <AnimatePresence>
        {isHistoryOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeInOut" }}
            className="absolute inset-0 bg-slate-900/20 backdrop-blur-md z-40 flex items-center justify-center p-8"
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.92, opacity: 0, y: 15 }}
              transition={{ type: "spring", stiffness: 350, damping: 28, mass: 0.8 }}
              className="w-[480px] max-h-[560px] liquid-glass p-6 rounded-[30px] flex flex-col shadow-[0_20px_50px_rgba(30,40,60,0.15)]">
              <div className="flex items-center justify-between pb-4 border-b border-slate-100 mb-4">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-sky-400 to-emerald-400 flex items-center justify-center shadow-md">
                    <History className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm text-slate-800">Daisy · 对话历史</h3>
                    <p className="text-[10px] text-slate-400 font-medium">最近 20 次交互记录</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {chatHistory.length > 0 && (
                    <button onClick={handleClearHistory}
                      className="text-[11px] text-slate-400 hover:text-rose-500 hover:bg-slate-100/50 px-2 py-1 rounded-lg transition-all font-medium cursor-pointer mr-1">
                      清空历史
                    </button>
                  )}
                  <button onClick={() => setIsHistoryOpen(false)}
                    className="w-7 h-7 rounded-full bg-slate-100 hover:bg-slate-200/80 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors cursor-pointer">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto mb-4 space-y-3.5 pr-1 glass-scroll min-h-[200px] max-h-[400px]">
                {chatHistory.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-center text-slate-400 py-12">
                    <History className="w-8 h-8 mb-3 opacity-30" />
                    <p className="text-[13px] font-medium">暂无对话历史</p>
                    <p className="text-[11px] mt-1">通过快捷键或唤醒词与 Daisy 对话后，记录会显示在这里</p>
                  </div>
                ) : (
                  chatHistory.map((chat, idx) => (
                    <div key={idx} className={`flex flex-col ${chat.sender === "user" ? "items-end" : "items-start"}`}>
                      <div className={`px-4 py-2.5 rounded-2xl text-[12px] leading-relaxed max-w-[85%] whitespace-pre-wrap ${
                        chat.sender === "user"
                          ? "bg-sky-500 text-white rounded-tr-none shadow-[0_4px_12px_rgba(14,165,233,0.18)] font-medium"
                          : "bg-white/75 backdrop-blur-md text-slate-800 rounded-tl-none border border-white/60 shadow-[0_4px_10px_rgba(15,23,42,0.03)]"}`}>
                        {chat.text}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 退出确认 */}
      <AnimatePresence>
        {isQuitConfirmOpen && (
          <div className="absolute inset-0 bg-slate-900/10 backdrop-blur-md z-40 flex items-center justify-center p-8">
            <motion.div initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.92, opacity: 0 }}
              className="w-[360px] liquid-glass p-6 rounded-[28px] text-center">
              <div className="w-12 h-12 rounded-full bg-rose-50 border border-rose-100 mx-auto flex items-center justify-center mb-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                <Power className="w-6 h-6 text-rose-500" />
              </div>
              <h3 className="font-semibold text-slate-800 text-base mb-2">退出 Daisy 助手</h3>
              <p className="text-[12px] text-slate-400 mb-5 leading-relaxed">退出后，语音监听及快捷键唤醒服务将会完全中断。确定要退出吗？</p>
              <div className="flex gap-3">
                <button onClick={() => setIsQuitConfirmOpen(false)}
                  className="flex-1 py-2.5 rounded-full btn-glass-clear cursor-pointer text-[12px]"><span>取消</span></button>
                <button onClick={handleConfirmQuit}
                  className="flex-1 py-2.5 rounded-full btn-glass-red cursor-pointer text-[12px]"><span>确认退出</span></button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
