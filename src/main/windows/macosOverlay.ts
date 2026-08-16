import { app, BrowserWindow } from "electron";
import { getBundledBin } from "../config/env";
import { logError } from "../utils/logger";
import { shouldShowInDock, syncDockVisibility } from "./dockVisibility";

interface NativeOverlayBridge {
  configureOverlay(handle: Buffer): boolean;
  raiseOverlay(handle: Buffer): boolean;
}

let bridge: NativeOverlayBridge | null = null;
const configuredWindows = new WeakSet<BrowserWindow>();
const visibleOverlayNames = new Set<string>();

function getBridge(): NativeOverlayBridge | null {
  if (process.platform !== "darwin") return null;
  if (bridge) return bridge;
  try {
    bridge = require(getBundledBin("daisy-window-selector.node")) as NativeOverlayBridge;
    return bridge;
  } catch (error) {
    logError("Unable to load native macOS overlay bridge", error);
    return null;
  }
}

export function configureMacOSOverlay(window: BrowserWindow): void {
  if (process.platform !== "darwin" || window.isDestroyed() || configuredWindows.has(window)) return;

  const nativeBridge = getBridge();
  if (!nativeBridge) return;
  try {
    if (nativeBridge.configureOverlay(window.getNativeWindowHandle())) {
      configuredWindows.add(window);
    }
  } catch (error) {
    logError("Unable to configure native macOS overlay", error);
  }
}

export function raiseMacOSOverlay(window: BrowserWindow): void {
  if (process.platform !== "darwin" || window.isDestroyed()) return;

  const nativeBridge = getBridge();
  if (!nativeBridge) return;
  try {
    nativeBridge.raiseOverlay(window.getNativeWindowHandle());
  } catch (error) {
    logError("Unable to raise native macOS overlay", error);
  }
}

/**
 * macOS does not let a normal foreground (Dock) application place a window in
 * another application's fullscreen Space. Electron switches between its
 * foreground and UIElement process types when `setVisibleOnAllWorkspaces` is
 * invoked at show time. When the user hides Daisy from the Dock, it must stay
 * an accessory app after the final overlay hides; switching back to regular
 * would make macOS put its Dock icon back.
 */
export function setMacOSOverlayVisible(name: string, visible: boolean): void {
  if (process.platform !== "darwin") return;

  if (visible) {
    visibleOverlayNames.add(name);
    app.setActivationPolicy("accessory");
    return;
  }

  visibleOverlayNames.delete(name);
  if (visibleOverlayNames.size === 0) {
    app.setActivationPolicy(shouldShowInDock() ? "regular" : "accessory");
    // Reapply the preference after the activation-policy transition. This is
    // particularly important after a fullscreen overlay has just been hidden.
    syncDockVisibility(true);
  }
}
