import { UiohookKey, uIOhook, type UiohookKeyboardEvent, type UiohookMouseEvent } from "uiohook-napi";
import { EventEmitter } from "node:events";
import { config } from "../config/env";
import { log, logError } from "../utils/logger";

export class GlobalShortcut extends EventEmitter {
  private targetKeys: string[];
  private pressedKeys = new Set<string>();
  private isRecording = false;
  private releaseDebounceTimer: NodeJS.Timeout | null = null;
  private readonly RELEASE_DEBOUNCE_MS = 50;
  private captureMode = false;
  private capturePressedKeys = new Set<string>();
  private captureKeysInOrder: string[] = [];
  private pressedTimer: NodeJS.Timeout | null = null;
  private listenerStarted = false;

  private readonly handleKeyDown = (event: UiohookKeyboardEvent): void => {
    const key = this.keyCodeToName(event.keycode);
    if (key) this.handleInput(key, "DOWN");
  };

  private readonly handleKeyUp = (event: UiohookKeyboardEvent): void => {
    const key = this.keyCodeToName(event.keycode);
    if (key) this.handleInput(key, "UP");
  };

  private readonly handleMouseDown = (event: UiohookMouseEvent): void => {
    const key = this.mouseButtonToName(event.button);
    if (key) this.handleInput(key, "DOWN");
  };

  private readonly handleMouseUp = (event: UiohookMouseEvent): void => {
    const key = this.mouseButtonToName(event.button);
    if (key) this.handleInput(key, "UP");
  };

  constructor() {
    super();
    this.targetKeys = this.parseShortcut(config.shortcut.globalShortcut);
    this.setup();
  }

  startCapture(): void {
    this.captureMode = true;
    this.pressedKeys.clear();
    this.capturePressedKeys.clear();
    this.captureKeysInOrder = [];
  }

  stopCapture(): void {
    this.captureMode = false;
    this.capturePressedKeys.clear();
    this.captureKeysInOrder = [];
  }

  private keyNameToDisplayName(key: string): string {
    const displayNames: Record<string, string> = {
      leftalt: "LeftOption",
      rightalt: "RightOption",
      leftmeta: "LeftCommand",
      rightmeta: "RightCommand",
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

  private keyCodeToName(keyCode: number): string | null {
    const modifierNames = new Map<number, string>([
      [UiohookKey.Alt, "leftalt"],
      [UiohookKey.AltRight, "rightalt"],
      [UiohookKey.Meta, "leftmeta"],
      [UiohookKey.MetaRight, "rightmeta"],
      [UiohookKey.Ctrl, "leftcontrol"],
      [UiohookKey.CtrlRight, "rightcontrol"],
      [UiohookKey.Shift, "leftshift"],
      [UiohookKey.ShiftRight, "rightshift"],
      [UiohookKey.Space, "space"],
      [UiohookKey.Enter, "return"],
      [UiohookKey.Escape, "escape"],
      [UiohookKey.Tab, "tab"],
      [UiohookKey.Backspace, "backspace"],
      [UiohookKey.Delete, "delete"],
    ]);
    const modifierName = modifierNames.get(keyCode);
    if (modifierName) return modifierName;

    for (const [name, code] of Object.entries(UiohookKey)) {
      if (code === keyCode) return name.toLowerCase();
    }
    return null;
  }

  private mouseButtonToName(button: unknown): string | null {
    const buttonNumber = Number(button);
    if (buttonNumber === 1) return "mouseleft";
    if (buttonNumber === 2) return "mouseright";
    if (buttonNumber === 3) return "mousemiddle";
    return null;
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

  private setup(): void {
    uIOhook.on("keydown", this.handleKeyDown);
    uIOhook.on("keyup", this.handleKeyUp);
    uIOhook.on("mousedown", this.handleMouseDown);
    uIOhook.on("mouseup", this.handleMouseUp);

    try {
      uIOhook.start();
      this.listenerStarted = true;
      log("GlobalShortcut: native Apple Silicon listener started");
    } catch (error) {
      logError("GlobalShortcut: failed to start native listener", error);
    }
  }

  private handleInput(key: string, state: "DOWN" | "UP"): void {
    if (this.captureMode) {
      if (state === "DOWN") {
        if (!this.capturePressedKeys.has(key)) {
          this.capturePressedKeys.add(key);
          this.captureKeysInOrder.push(key);
        }
      } else {
        this.capturePressedKeys.delete(key);
        if (this.capturePressedKeys.size === 0 && this.captureKeysInOrder.length > 0) {
          const displayName = this.captureKeysInOrder
            .map((capturedKey) => this.keyNameToDisplayName(capturedKey))
            .join("+");
          this.captureMode = false;
          this.captureKeysInOrder = [];
          this.emit("captured", displayName);
        }
      }
      return;
    }

    if (state === "DOWN") {
      if (this.releaseDebounceTimer) {
        clearTimeout(this.releaseDebounceTimer);
        this.releaseDebounceTimer = null;
      }
      this.pressedKeys.add(key);

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
      return;
    }

    if (this.shortcutContainsKey(this.targetKeys, key) && this.pressedTimer) {
      clearTimeout(this.pressedTimer);
      this.pressedTimer = null;
    }
    if (this.shortcutContainsKey(this.targetKeys, key) && this.isRecording) {
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

  destroy(): void {
    uIOhook.off("keydown", this.handleKeyDown);
    uIOhook.off("keyup", this.handleKeyUp);
    uIOhook.off("mousedown", this.handleMouseDown);
    uIOhook.off("mouseup", this.handleMouseUp);
    if (this.listenerStarted) {
      uIOhook.stop();
      this.listenerStarted = false;
    }
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
  }
}
