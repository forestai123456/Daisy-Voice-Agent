import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EdgeTTS } from "node-edge-tts";
import { config } from "../config/env";
import { log } from "../utils/logger";

const TTS_DIR = path.join(os.tmpdir(), "diri-tts");

// Clean old files on startup (in case of crash)
export function startTTSCleanup(): void {
  try {
    if (fs.existsSync(TTS_DIR)) {
      let deleted = 0;
      for (const file of fs.readdirSync(TTS_DIR)) {
        if (file.startsWith("diri-tts-") && file.endsWith(".mp3")) {
          fs.unlinkSync(path.join(TTS_DIR, file));
          deleted++;
        }
      }
      if (deleted > 0) log(`TTS startup cleanup: deleted ${deleted} leftover files`);
    }
  } catch {
    // ignore
  }
}

export function stopTTSCleanup(): void {}

export function unmarkPlaying(_filePath: string): void {}

export class EdgeTTSPlayer extends EventEmitter {
  private cancelled = false;

  async speak(text: string): Promise<void> {
    if (!text.trim()) {
      this.emit("end");
      return;
    }

    this.emit("start");

    if (!fs.existsSync(TTS_DIR)) {
      fs.mkdirSync(TTS_DIR, { recursive: true });
    }

    const fileName = `diri-tts-${Date.now()}.mp3`;
    const filePath = path.join(TTS_DIR, fileName);

    try {
      let retries = 3;
      let lastError: any = null;
      while (retries > 0) {
        try {
          const tts = new EdgeTTS({ voice: config.tts.voice, rate: config.tts.rate });
          log(`[TTS_PERF] TTS Request Start (speak) for text: "${text.slice(0, 30)}..."`);
          await tts.ttsPromise(text, filePath);
          log(`[TTS_PERF] TTS Response & File Saved (speak): ${filePath}`);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          retries--;
          if (retries > 0) {
            log(`TTS speak failed: ${error instanceof Error ? error.message : String(error)}. Retrying in 500ms (${retries} attempts left)...`);
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      }
      if (lastError) {
        throw lastError;
      }

      if (this.cancelled) {
        fs.promises.unlink(filePath).catch(() => {});
        return;
      }

      this.emit("play", filePath);
    } catch (error) {
      fs.promises.unlink(filePath).catch(() => {});
      if (this.cancelled) return;
      this.emit("error", error instanceof Error ? error.message : String(error));
      this.emit("end");
    }
  }

  async synthesize(text: string): Promise<string | null> {
    if (!text.trim()) return null;

    if (!fs.existsSync(TTS_DIR)) {
      fs.mkdirSync(TTS_DIR, { recursive: true });
    }

    const fileName = `diri-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
    const filePath = path.join(TTS_DIR, fileName);

    try {
      let retries = 3;
      let lastError: any = null;
      while (retries > 0) {
        try {
          const tts = new EdgeTTS({ voice: config.tts.voice, rate: config.tts.rate });
          log(`[TTS_PERF] TTS Request Start (synthesize) for text: "${text.slice(0, 30)}..."`);
          await tts.ttsPromise(text, filePath);
          log(`[TTS_PERF] TTS Response & File Saved (synthesize): ${filePath}`);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          retries--;
          if (retries > 0) {
            log(`TTS synthesize failed: ${error instanceof Error ? error.message : String(error)}. Retrying in 500ms (${retries} attempts left)...`);
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      }
      if (lastError) {
        throw lastError;
      }
      return filePath;
    } catch (error) {
      fs.promises.unlink(filePath).catch(() => {});
      log(`TTS synthesize failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  stop(): void {
    this.cancelled = true;
  }
}
