import path from "node:path";
import { app, Menu, nativeImage, Tray } from "electron";
import { createSettingsWindow } from "./settingsWindow";
import { log, logError } from "../utils/logger";

type DockVisibilityChangeHandler = (showInDock: boolean) => void;

let showInDock = true;
let tray: Tray | null = null;
let onDockVisibilityChange: DockVisibilityChangeHandler | null = null;
let hideRetryTimer: NodeJS.Timeout | null = null;

function openSettings(): void {
  const window = createSettingsWindow(true);
  app.focus({ steal: true });
  window.show();
  window.focus();
}

function getTrayIcon() {
  // In a packaged Electron app, the product icon lives beside app.asar in
  // Contents/Resources (macOS) or resources/ (Windows). Loading it from there
  // avoids relying on native image decoding through an asar path. Development
  // keeps using the source asset. Windows requires .ico; macOS requires .icns.
  const iconFile = process.platform === "win32" ? "icon.ico" : "icon.icns";
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, iconFile), path.join(app.getAppPath(), "assets", iconFile)]
    : [path.join(app.getAppPath(), "assets", iconFile), path.join(process.resourcesPath, iconFile)];

  for (const iconPath of candidates) {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) return icon.resize({ width: 18, height: 18 });
  }
  return nativeImage.createEmpty();
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: "打开 Daisy 设置", click: openSettings },
  ];
  if (process.platform === "darwin") {
    items.push({
      label: "在 Dock 中显示 Daisy",
      type: "checkbox",
      checked: showInDock,
      click: (item) => onDockVisibilityChange?.(item.checked),
    });
  }
  items.push({ type: "separator" });
  items.push({ label: "退出 Daisy", click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function ensureTray(): void {
  if (tray) {
    rebuildTrayMenu();
    return;
  }

  try {
    tray = new Tray(getTrayIcon());
    tray.setToolTip("Daisy 智能助手");
    tray.on("click", openSettings);
    rebuildTrayMenu();
  } catch (error) {
    tray = null;
    logError("Unable to create Daisy menu-bar icon", error);
  }
}

function destroyTray(): void {
  if (!tray) return;
  tray.destroy();
  tray = null;
}

function scheduleHiddenDockRetry(): void {
  if (hideRetryTimer) clearTimeout(hideRetryTimer);
  // Electron documents that a hide call made within one second of a previous
  // hide can be ignored. The retry makes the preference survive rapid overlay
  // show/hide transitions without repeatedly toggling the Dock.
  hideRetryTimer = setTimeout(() => {
    hideRetryTimer = null;
    if (!showInDock) app.dock?.hide();
  }, 1100);
}

/** Apply the saved Dock preference after Electron has changed activation policy. */
export function syncDockVisibility(force = false): void {
  if (process.platform === "win32") {
    // Windows has no Dock; always show the tray so the user can access
    // settings and quit.
    ensureTray();
    return;
  }
  if (process.platform !== "darwin") return;

  if (showInDock) {
    if (hideRetryTimer) {
      clearTimeout(hideRetryTimer);
      hideRetryTimer = null;
    }
    destroyTray();
    void app.dock?.show();
    return;
  }

  ensureTray();
  app.dock?.hide();
  if (force) scheduleHiddenDockRetry();
}

export function initializeDockVisibility(
  initialShowInDock: boolean,
  changeHandler: DockVisibilityChangeHandler,
): void {
  showInDock = initialShowInDock;
  onDockVisibilityChange = changeHandler;
  if (process.platform === "darwin") {
    app.setActivationPolicy(showInDock ? "regular" : "accessory");
  }
  syncDockVisibility(true);
}

/** Whether Daisy should behave as a normal Dock application on macOS. */
export function shouldShowInDock(): boolean {
  return showInDock;
}

export function setDockVisibility(show: boolean): void {
  showInDock = show;
  if (process.platform === "darwin") {
    app.setActivationPolicy(showInDock ? "regular" : "accessory");
  }
  syncDockVisibility(true);
  rebuildTrayMenu();
  log(`Dock visibility preference applied: showInDock=${show}`);
}
