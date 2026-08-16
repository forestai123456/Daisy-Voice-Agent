import path from "node:path";
import { BrowserWindow, screen } from "electron";
import { IPC_CHANNELS } from "../ipc/channels";
import { log } from "../utils/logger";
import {
  configureMacOSOverlay,
  raiseMacOSOverlay,
  setMacOSOverlayVisible,
} from "./macosOverlay";
import {
  calculateFloatWindowBounds,
  FLOAT_ORB_SIZE,
} from "./floatPosition";

let floatWindow: BrowserWindow | null = null;

let hideTimeout: NodeJS.Timeout | null = null;

/**
 * Fullscreen macOS apps live in their own Space. Re-assert the overlay
 * collection behaviour whenever it is shown; only setting it at creation can
 * leave a transparent, non-focusable window behind the active fullscreen app.
 */
function prepareFloatOverlayForFullScreen(): void {
  if (!floatWindow || floatWindow.isDestroyed()) return;

  if (process.platform === "darwin") {
    floatWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      // The native window was created while Daisy was an accessory app. Keep
      // that process type while it joins the active fullscreen Space.
      skipTransformProcessType: true,
    });
  }
  // One level above the screen-saver layer is Electron's documented maximum
  // recommended overlay level on macOS. It keeps the orb above fullscreen
  // app content without turning it into a focus-stealing normal window.
  floatWindow.setAlwaysOnTop(true, "screen-saver", 1);
  configureMacOSOverlay(floatWindow);
}

export function createFloatWindow(): BrowserWindow {
  if (floatWindow && !floatWindow.isDestroyed()) {
    return floatWindow;
  }

  const initialBounds = calculateFloatWindowBounds(
    screen.getPrimaryDisplay().bounds,
  );

  floatWindow = new BrowserWindow({
    width: FLOAT_ORB_SIZE,
    height: FLOAT_ORB_SIZE,
    x: initialBounds.x,
    y: initialBounds.y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  floatWindow.loadFile(path.join(__dirname, "../../renderer/float.html"));
  // Do not use Electron's system-wide content protection here. It also hides
  // the orb from third-party screen recorders such as Screen Studio. Daisy's
  // own full-screen capture path hides the orb only for that single frame.
  floatWindow.setAlwaysOnTop(true, "screen-saver", 1);
  configureMacOSOverlay(floatWindow);
  floatWindow.setIgnoreMouseEvents(true);

  if (process.platform === "win32") {
    floatWindow.setContentProtection(true);
  }

  floatWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("Float window render process gone:", details);
  });

  floatWindow.webContents.on("console-message", (_event, level, message) => {
    const levels = ["debug", "log", "warn", "error"];
    console.error(`[float:${levels[level] ?? level}] ${message}`);
  });

  floatWindow.on("closed", () => {
    floatWindow = null;
  });

  return floatWindow;
}

export function getFloatWindow(): BrowserWindow | null {
  return floatWindow;
}

export function showFloatWindow(): void {
  if (!floatWindow || floatWindow.isDestroyed()) return;
  
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }

  // 1. Restore the overlay above the active fullscreen Space before showing.
  setMacOSOverlayVisible("float", true);
  prepareFloatOverlayForFullScreen();

  // 2. Show the window immediately to eliminate visual delay!
  floatWindow.showInactive();
  raiseMacOSOverlay(floatWindow);
  floatWindow.moveTop();

  // 3. Reposition it only if display boundary changed, to avoid blocking display server queries
  try {
    const targetBounds = calculateFloatWindowBounds(
      screen.getPrimaryDisplay().bounds,
    );
    const currentPos = floatWindow.getPosition();
    if (
      currentPos[0] !== targetBounds.x ||
      currentPos[1] !== targetBounds.y
    ) {
      floatWindow.setPosition(targetBounds.x, targetBounds.y);
    }
  } catch (err) {
    console.error("Error setting float window position:", err);
  }

  sendToFloatWindow(IPC_CHANNELS.SHOW_WINDOW);
  log("Float window shown");
}

export function hideFloatWindow(): void {
  if (!floatWindow || floatWindow.isDestroyed()) return;
  sendToFloatWindow(IPC_CHANNELS.HIDE_WINDOW);
  
  if (hideTimeout) {
    clearTimeout(hideTimeout);
  }
  
  hideTimeout = setTimeout(() => {
    hideTimeout = null;
    if (floatWindow && !floatWindow.isDestroyed()) {
      floatWindow.hide();
      setMacOSOverlayVisible("float", false);
      log("Float window hidden");
    }
  }, 300);
}

export function sendToFloatWindow(channel: string, ...args: unknown[]): void {
  try {
    if (floatWindow && !floatWindow.isDestroyed() && !floatWindow.webContents.isDestroyed()) {
      floatWindow.webContents.send(channel, ...args);
    }
  } catch (err) {
    // Suppress disposed frame or hidden webContents errors
    console.error(`Error sending to float window on channel ${channel}:`, err);
  }
}
