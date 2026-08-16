import { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { log, logError } from "../utils/logger";

const NAMED_VIRTUAL_KEYS: Record<string, number> = {
  backspace: 0x08,
  tab: 0x09,
  enter: 0x0d,
  return: 0x0d,
  shift: 0x10,
  control: 0x11,
  ctrl: 0x11,
  alt: 0x12,
  option: 0x12,
  pause: 0x13,
  capslock: 0x14,
  escape: 0x1b,
  esc: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
  arrowleft: 0x25,
  arrowup: 0x26,
  arrowright: 0x27,
  arrowdown: 0x28,
  printscreen: 0x2c,
  insert: 0x2d,
  delete: 0x2e,
  leftwin: 0x5b,
  leftmeta: 0x5b,
  rightwin: 0x5c,
  rightmeta: 0x5c,
  contextmenu: 0x5d,
  numpadmultiply: 0x6a,
  numpadadd: 0x6b,
  numpadsubtract: 0x6d,
  numpaddecimal: 0x6e,
  numpaddivide: 0x6f,
  numlock: 0x90,
  scrolllock: 0x91,
  leftshift: 0xa0,
  rightshift: 0xa1,
  leftcontrol: 0xa2,
  leftctrl: 0xa2,
  rightcontrol: 0xa3,
  rightctrl: 0xa3,
  leftalt: 0xa4,
  leftoption: 0xa4,
  rightalt: 0xa5,
  rightoption: 0xa5,
  volumemute: 0xad,
  volumedown: 0xae,
  volumeup: 0xaf,
  medianext: 0xb0,
  mediaprevious: 0xb1,
  mediastop: 0xb2,
  mediaplaypause: 0xb3,
  semicolon: 0xba,
  equal: 0xbb,
  comma: 0xbc,
  minus: 0xbd,
  period: 0xbe,
  slash: 0xbf,
  backquote: 0xc0,
  bracketleft: 0xdb,
  backslash: 0xdc,
  bracketright: 0xdd,
  quote: 0xde,
};

for (let index = 0; index <= 9; index += 1) {
  NAMED_VIRTUAL_KEYS[`numpad${index}`] = 0x60 + index;
}
for (let index = 1; index <= 24; index += 1) {
  NAMED_VIRTUAL_KEYS[`f${index}`] = 0x6f + index;
}

export function resolveVirtualKey(keyName: string): number | null {
  const key = String(keyName || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(NAMED_VIRTUAL_KEYS, key)) {
    return NAMED_VIRTUAL_KEYS[key];
  }
  if (/^[a-z]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  return null;
}

export function resolveShortcutVks(shortcut: string): number[] | null {
  const parts = String(shortcut || "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const resolved = parts.map(resolveVirtualKey);
  if (resolved.some((value) => value === null)) return null;
  return [...new Set(resolved as number[])];
}

/** Backward-compatible helper retained for older tests and callers. */
export function resolveModifierVk(shortcut: string): number | null {
  const resolved = resolveShortcutVks(shortcut);
  return resolved?.length === 1 ? resolved[0] : null;
}

const POLL_INTERVAL_MS = 15;

function powershellIntArray(values: number[]): string {
  return values.length > 0 ? `@(${values.join(",")})` : "@()";
}

function buildPollerScript(wakeVks: number[]): string {
  return [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "Add-Type @\"",
    "using System;using System.Runtime.InteropServices;",
    "public class DaisyKeyState{[DllImport(\"user32.dll\")]public static extern short GetAsyncKeyState(int v);}",
    "\"@",
    `$wake=[int[]]${powershellIntArray(wakeVks)}`,
    "function ReadStates([int[]]$keys){",
    "  [System.Int16[]]$states=@()",
    "  foreach($key in $keys){$states += [DaisyKeyState]::GetAsyncKeyState($key)}",
    "  return $states",
    "}",
    "function AllDown([System.Int16[]]$states){",
    "  if($states.Count -eq 0){return $false}",
    "  foreach($state in $states){if(($state -band 0x8000) -eq 0){return $false}}",
    "  return $true",
    "}",
    // Prime GetAsyncKeyState once so the low-order latch cannot replay a key
    // that was pressed before this listener process started.
    "[System.Int16[]]$initialWakeStates=ReadStates $wake",
    "$previousWake=AllDown $initialWakeStates",
    "$wakeEngaged=$false",
    "while($true){",
    "  [System.Int16[]]$wakeStates=ReadStates $wake",
    "  $wakeDown=AllDown $wakeStates",
    // The low-order GetAsyncKeyState bit latches a press that happened between
    // two polls. Without it, a short press can disappear entirely when the
    // PowerShell process is briefly descheduled by Windows.
    "  $wakeLatched=($wakeStates.Count -eq 1 -and (($wakeStates[0] -band 1) -ne 0))",
    "  if(($wakeDown -or $wakeLatched) -and -not $previousWake){",
    "    [Console]::Out.WriteLine('WAKE_DOWN');[Console]::Out.Flush();$wakeEngaged=$true",
    "  }",
    "  if(-not $wakeDown -and $wakeEngaged){",
    "    [Console]::Out.WriteLine('WAKE_UP');[Console]::Out.Flush();$wakeEngaged=$false",
    "  }",
    "  $previousWake=$wakeDown",
    `  Start-Sleep -Milliseconds ${POLL_INTERVAL_MS}`,
    "}",
  ].join("\n");
}

/**
 * Polls physical Win32 key state and emits real down/up edges. Electron's
 * globalShortcut only exposes key-down callbacks, so keyboard auto-repeat can
 * never be used to infer release for push-to-talk.
 */
export class WinKeyStatePoller extends EventEmitter {
  private proc: ChildProcess | null = null;
  private restarter: NodeJS.Timeout | null = null;
  private wakeVks: number[] = [];
  private running = false;
  private paused = false;

  start(wakeShortcut: string): boolean {
    const wakeVks = resolveShortcutVks(wakeShortcut);
    if (!wakeVks) {
      setTimeout(() => {
        const shortcutText = wakeShortcut || "unset";
        this.emit("listener-error", `Windows shortcut cannot parse: ${shortcutText}`);
        /*
        this.emit("listener-error", `Windows 鏃犳硶璇嗗埆蹇嵎閿細${wakeShortcut || "绌?}`);
        */
      }, 0);
      return false;
    }
    this.wakeVks = wakeVks;
    this.running = true;
    this.restartProcess();
    setTimeout(() => {
      this.emit(
        "listener-info",
        `Windows push-to-talk enabled: ${wakeShortcut}`,
        /*
        */
      );
    }, 0);
    return true;
  }

  configure(wakeShortcut: string): boolean {
    return this.start(wakeShortcut);
  }

  private restartProcess(): void {
    if (this.restarter) {
      clearTimeout(this.restarter);
      this.restarter = null;
    }
    const previous = this.proc;
    this.proc = null;
    if (previous) {
      try { previous.kill(); } catch { /* already stopped */ }
    }
    this.spawnProc();
  }

  private spawnProc(): void {
    if (!this.running || this.wakeVks.length === 0) return;
    const script = buildPollerScript(this.wakeVks);
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    try {
      const proc = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        { windowsHide: true },
      );
      this.proc = proc;
      let buffer = "";
      let stderrBuffer = "";
      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk: string) => {
        if (this.proc !== proc) return;
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (this.paused) continue;
          if (line === "WAKE_DOWN") this.emit("pressed");
          else if (line === "WAKE_UP") this.emit("released");
        }
      });
      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (chunk: string) => {
        stderrBuffer += chunk;
        const detail = stderrBuffer.trim();
        // Windows PowerShell can serialize its harmless first-use progress as
        // CLIXML on redirected stderr. Do not misreport that as a key failure.
        if (detail.startsWith("#< CLIXML") && !detail.includes("</Objs>")) return;
        stderrBuffer = "";
        if (detail.startsWith("#< CLIXML") && detail.includes('S="progress"')) return;
        if (this.proc === proc && detail) {
          logError("[winKeyPoller] PowerShell error", detail);
          this.emit("listener-error", `Windows 蹇嵎閿洃鍚剼鏈敊璇細${detail}`);
        }
      });
      proc.on("error", (error) => {
        if (this.proc !== proc) return;
        this.proc = null;
        logError("[winKeyPoller] spawn error", error);
        this.emit("listener-error", `Windows 蹇嵎閿洃鍚惎鍔ㄥけ璐ワ細${error.message}`);
        this.scheduleRestart();
      });
      proc.on("exit", (code) => {
        if (this.proc !== proc) return;
        this.proc = null;
        if (!this.running) return;
        log(`[winKeyPoller] exited code=${code}`);
        this.scheduleRestart();
      });
      log(
        `[winKeyPoller] physical key polling started wake=${this.wakeVks.join("+")}`,
      );
    } catch (error) {
      logError("[winKeyPoller] spawn failed", error);
      const detail = error instanceof Error ? error.message : String(error);
      setTimeout(() => this.emit("listener-error", `Windows 蹇嵎閿洃鍚惎鍔ㄥけ璐ワ細${detail}`), 0);
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (!this.running || this.restarter) return;
    this.restarter = setTimeout(() => {
      this.restarter = null;
      if (!this.proc) this.spawnProc();
    }, 2000);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  kill(): void {
    this.running = false;
    if (this.restarter) {
      clearTimeout(this.restarter);
      this.restarter = null;
    }
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.kill(); } catch { /* already stopped */ }
    }
    this.wakeVks = [];
    this.paused = false;
  }
}
