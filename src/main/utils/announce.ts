import { BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EdgeTTS } from "node-edge-tts";
import { config } from "../config/env";
import { log, logError } from "./logger";

/**
 * Isolated "speak to the user right now" path for tool-driven announcements
 * (e.g. "正在下载安装 ffmpeg，请稍候"). It synthesizes the text with Edge TTS
 * and plays it in a throwaway hidden BrowserWindow, so it never touches the
 * main TTS queue / session state in index.ts (no isSpeaking flip, no
 * TTS_PLAY_ENDED handling). Fire-and-forget callers may ignore the promise;
 * awaiting it guarantees the announcement finished before continuing.
 */
const ANNOUNCE_DIR = path.join(os.tmpdir(), "diri-announce");

let announceLock: Promise<void> = Promise.resolve();

export function announceToUser(text: string): Promise<void> {
  const run = announceLock.then(() => playAnnouncement(text));
  announceLock = run.catch(() => {});
  return run;
}

async function playAnnouncement(text: string): Promise<void> {
  if (!text || !text.trim()) return;
  let filePath = "";
  let htmlPath = "";
  try {
    if (!fs.existsSync(ANNOUNCE_DIR)) fs.mkdirSync(ANNOUNCE_DIR, { recursive: true });
    filePath = path.join(ANNOUNCE_DIR, `announce-${Date.now()}.mp3`);
    const tts = new EdgeTTS({ voice: config.tts.voice, rate: config.tts.rate });
    await tts.ttsPromise(text, filePath);
    if (!fs.existsSync(filePath)) throw new Error("announcement synthesis produced no file");

    htmlPath = path.join(ANNOUNCE_DIR, `play-${Date.now()}.html`);
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>` +
      `<audio src="${path.basename(filePath)}" autoplay ` +
      `onended="window.close()" onerror="window.close()" oncanplay="this.play()"></audio></body></html>`;
    fs.writeFileSync(htmlPath, html, "utf-8");

    await playInHiddenWindow(htmlPath);
  } catch (err) {
    logError("[announce] failed", err);
  } finally {
    if (filePath) fs.promises.unlink(filePath).catch(() => {});
    if (htmlPath) fs.promises.unlink(htmlPath).catch(() => {});
  }
}

function playInHiddenWindow(htmlPath: string): Promise<void> {
  return new Promise((resolve) => {
    let win: BrowserWindow | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
      resolve();
    };
    try {
      win = new BrowserWindow({
        width: 1, height: 1, show: false, frame: false, skipTaskbar: true,
        resizable: false, focusable: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          autoplayPolicy: "no-user-gesture-required",
        },
      });
      win.on("closed", finish);
      win.loadFile(htmlPath).catch(() => finish());
      // Hard cap so a stuck player can never block the tool forever.
      setTimeout(finish, 20000);
    } catch (err) {
      logError("[announce] hidden window failed", err);
      finish();
    }
  });
}
