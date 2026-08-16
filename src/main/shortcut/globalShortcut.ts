import { GlobalKeyboardListener } from "node-global-key-listener";
import { EventEmitter } from "node:events";
import { config } from "../config/env";
import { WinKeyStatePoller } from "./winKeyStatePoller";

export class GlobalShortcut extends EventEmitter {
  private listener: GlobalKeyboardListener | null = null;
  private targetKeys: string[];
  private pressedKeys = new Set<string>();
  private isRecording = false;
  private releaseDebounceTimer: NodeJS.Timeout | null = null;
  private readonly RELEASE_DEBOUNCE_MS = 50;
  private captureMode: "single" | "combo" | null = null;
  private capturePressedKeys = new Set<string>();
  private captureKeysInOrder: string[] = [];
  private pressedTimer: NodeJS.Timeout | null = null;
  private windowsPoller: WinKeyStatePoller | null = null;

  constructor(listenerForTest?: GlobalKeyboardListener) {
    super();
    this.targetKeys = this.parseShortcut(config.shortcut.globalShortcut);

    // Deterministic unit tests inject a listener so they can exercise the
    // press/release state machine without registering a real OS shortcut.
    if (listenerForTest) {
      this.listener = listenerForTest;
      this.setupNativeListener();
      return;
    }

    // Electron's globalShortcut exposes key-down only. It cannot implement
    // push-to-talk because Windows key auto-repeat looks like a second press.
    // Poll physical state so DOWN starts recording and UP sends it.
    if (process.platform === "win32") {
      const poller = new WinKeyStatePoller();
      this.windowsPoller = poller;
      poller.on("pressed", () => {
        if (this.isRecording) return;
        this.isRecording = true;
        this.emit("pressed");
      });
      poller.on("released", () => {
        if (!this.isRecording) return;
        this.isRecording = false;
        this.emit("released");
      });
      poller.on("listener-info", (message: string) => this.emit("listener-info", message));
      poller.on("listener-error", (message: string) => this.emit("listener-error", message));
      poller.start(config.shortcut.globalShortcut);
      return;
    }

    const keyServerName = "MacKeyServer";
    this.listener = new GlobalKeyboardListener({
      mac: {
        onInfo: (message) => this.emit("listener-info", message.trim()),
        onError: (exitCode) => this.emit(
          "listener-error",
          `${keyServerName} exited${exitCode === null ? "" : ` (code ${exitCode})`}`,
        ),
      },
      windows: {
        onInfo: (message) => this.emit("listener-info", message.trim()),
        onError: (exitCode) => this.emit(
          "listener-error",
          `${keyServerName} exited${exitCode === null ? "" : ` (code ${exitCode})`}`,
        ),
      },
    });
    this.setupNativeListener();
  }

  startCapture(mode: "single" | "combo" = "combo"): void {
    this.captureMode = mode;
    this.pressedKeys.clear();
    this.capturePressedKeys.clear();
    this.captureKeysInOrder = [];
    this.windowsPoller?.setPaused(true);
  }

  stopCapture(): void {
    this.captureMode = null;
    this.capturePressedKeys.clear();
    this.captureKeysInOrder = [];
    this.windowsPoller?.setPaused(false);
  }

  private keyNameToDisplayName(key: string): string {
    const isMac = process.platform === "darwin";
    const displayNames: Record<string, string> = {
      leftalt: isMac ? "LeftOption" : "LeftAlt",
      rightalt: isMac ? "RightOption" : "RightAlt",
      leftmeta: isMac ? "LeftCommand" : "LeftWin",
      rightmeta: isMac ? "RightCommand" : "RightWin",
      leftcontrol: "LeftControl",
      rightcontrol: "RightControl",
      leftshift: "LeftShift",
      rightshift: "RightShift",
      space: "Space",
      return: "Return",
      escape: "Escape",
      tab: "Tab",
      backspace: "Backspace",
      delete: "Delete",
      mouseleft: "Mouse Left",
      mouseright: "Mouse Right",
      mousemiddle: "Mouse Middle",
    };
    return displayNames[key] || key;
  }

  private parseShortcut(shortcut: string): string[] {
    if (!shortcut || typeof shortcut !== "string") return ["rightalt"];
    return shortcut
      .toLowerCase()
      .split(/[+\s]/)
      .map((k) => k.trim())
      .filter(Boolean);
  }

  private normalizeKey(key: string): string {
    const lower = key.toLowerCase().replace(/\s+/g, "");
    const aliases: Record<string, string> = {
      leftalt: "leftalt",
      rightalt: "rightalt",
      option: "alt",
      leftoption: "leftalt",
      rightoption: "rightalt",
      alt: "alt",
      leftcommand: "leftmeta",
      rightcommand: "rightmeta",
      command: "meta",
      cmd: "meta",
      meta: "meta",
      leftcontrol: "leftcontrol",
      rightcontrol: "rightcontrol",
      control: "control",
      ctrl: "control",
      leftshift: "leftshift",
      rightshift: "rightshift",
      shift: "shift",
      space: "space",
      return: "return",
      enter: "return",
      escape: "escape",
      esc: "escape",
      tab: "tab",
      backspace: "backspace",
      delete: "delete",
    };
    return aliases[lower] || lower;
  }

  private normalizeEmittedKey(name: string): string {
    const standard = (name || "").toLowerCase().replace(/\s+/g, "");
    // node-global-key-listener emits standard names like "LEFT ALT", "RIGHT ALT"
    if (standard === "leftalt") return "leftalt";
    if (standard === "rightalt") return "rightalt";
    if (standard === "leftcommand" || standard === "leftmeta") return "leftmeta";
    if (standard === "rightcommand" || standard === "rightmeta") return "rightmeta";
    if (standard === "leftcontrol") return "leftcontrol";
    if (standard === "rightcontrol") return "rightcontrol";
    if (standard === "leftshift") return "leftshift";
    if (standard === "rightshift") return "rightshift";
    return standard;
  }

  /**
   * Shortcut settings are deliberately keyboard-only. Without this guard, the
   * mouse-up event generated by clicking 鈥滆缃揩鎹烽敭鈥?can be captured as
   * "Mouse Left" before the user has a chance to press a key.
   */
  private isMouseButton(key: string): boolean {
    return key.startsWith("mouse");
  }

  private matchesShortcut(targetKeys: string[]): boolean {
    return targetKeys.length > 0 && targetKeys.every((k) => {
      const target = this.normalizeKey(k);
      if (target === "alt") {
        return this.pressedKeys.has("leftalt") || this.pressedKeys.has("rightalt");
      }
      if (target === "meta") {
        return this.pressedKeys.has("leftmeta") || this.pressedKeys.has("rightmeta");
      }
      if (target === "control") {
        return this.pressedKeys.has("leftcontrol") || this.pressedKeys.has("rightcontrol");
      }
      if (target === "shift") {
        return this.pressedKeys.has("leftshift") || this.pressedKeys.has("rightshift");
      }
      return this.pressedKeys.has(target);
    });
  }

  private matchesTargetShortcut(): boolean {
    return this.matchesShortcut(this.targetKeys);
  }

  private shortcutContainsKey(targetKeys: string[], key: string): boolean {
    return targetKeys.some((k) => {
      const target = this.normalizeKey(k);
      if (target === "alt") return key === "leftalt" || key === "rightalt";
      if (target === "meta") return key === "leftmeta" || key === "rightmeta";
      if (target === "control") return key === "leftcontrol" || key === "rightcontrol";
      if (target === "shift") return key === "leftshift" || key === "rightshift";
      return target === key;
    });
  }

  private setupNativeListener(): void {
    if (!this.listener) return;
    void this.listener.addListener((event) => {
      const key = this.normalizeEmittedKey(event.name || "");
      if (!key) return;

      if (this.captureMode) {
        // Ignore the click that opened the shortcut-capture UI, and do not
        // allow mouse buttons to become a voice-wake shortcut.
        if (this.isMouseButton(key)) return;

        const captureMode = this.captureMode;
        if (event.state === "DOWN") {
          if (captureMode === "single") {
            this.stopCapture();
            this.emit("captured", this.keyNameToDisplayName(key));
            return;
          }
          if (!this.capturePressedKeys.has(key)) {
            this.capturePressedKeys.add(key);
            this.captureKeysInOrder.push(key);
          }
        } else if (event.state === "UP") {
          this.capturePressedKeys.delete(key);
          if (this.capturePressedKeys.size === 0 && this.captureKeysInOrder.length > 0) {
            const displayName = this.captureKeysInOrder
              .map((capturedKey) => this.keyNameToDisplayName(capturedKey))
              .join("+");
            this.captureMode = null;
            this.captureKeysInOrder = [];
            this.emit("captured", displayName);
          }
        }
        return;
      }

      if (event.state === "DOWN") {
        // Cancel any pending release (key bounce: user held key, phantom UP, then real DOWN)
        if (this.releaseDebounceTimer) {
          clearTimeout(this.releaseDebounceTimer);
          this.releaseDebounceTimer = null;
        }
        this.pressedKeys.add(key);
        
        // If any key other than rightalt is pressed, clear the pressedTimer
        if (key !== "rightalt" && this.pressedTimer) {
          clearTimeout(this.pressedTimer);
          this.pressedTimer = null;
        }

        if (this.matchesTargetShortcut() && !this.isRecording) {
          if (this.pressedTimer) clearTimeout(this.pressedTimer);
          this.pressedTimer = setTimeout(() => {
            this.pressedTimer = null;
            this.isRecording = true;
            this.emit("pressed");
          }, 20);
        }
      } else if (event.state === "UP") {
        if (this.shortcutContainsKey(this.targetKeys, key) && this.pressedTimer) {
          clearTimeout(this.pressedTimer);
          this.pressedTimer = null;
        }
        if (this.shortcutContainsKey(this.targetKeys, key) && this.isRecording) {
          // Debounce the release to filter out key bounce.
          // If the key comes back down within RELEASE_DEBOUNCE_MS, cancel the release.
          this.releaseDebounceTimer = setTimeout(() => {
            this.isRecording = false;
            this.pressedKeys.clear();
            this.releaseDebounceTimer = null;
            this.emit("released");
          }, this.RELEASE_DEBOUNCE_MS);
        } else {
          this.pressedKeys.delete(key);
        }
      }
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      const keyServerName = process.platform === "win32" ? "WinKeyServer" : "MacKeyServer";
      this.emit("listener-error", `Unable to start ${keyServerName}: ${detail}`);
    });
  }

  destroy(): void {
    if (process.platform === "win32") {
      this.windowsPoller?.kill();
      this.windowsPoller = null;
      return;
    }
    this.listener?.kill();
  }

  updateShortcut(shortcut: string): void {
    if (this.pressedTimer) {
      clearTimeout(this.pressedTimer);
      this.pressedTimer = null;
    }
    if (this.releaseDebounceTimer) {
      clearTimeout(this.releaseDebounceTimer);
      this.releaseDebounceTimer = null;
    }
    this.targetKeys = this.parseShortcut(shortcut);
    this.pressedKeys.clear();
    this.isRecording = false;
    if (process.platform === "win32") {
      this.windowsPoller?.configure(shortcut);
    }
  }
}
