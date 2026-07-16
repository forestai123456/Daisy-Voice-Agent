import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "../utils/logger";
import { VAD } from "../wakeword/monitor";
import { getWhisperModelPath, getBundledBin, getWhisperExecutionEnv } from "../config/env";

const execFileAsync = promisify(execFile);

const WHISPER_CLI = getBundledBin("whisper-cli");
const TEMP_DIR = path.join(os.tmpdir(), "diri-wakeword");

const SAMPLE_RATE = 16000;
const MIN_AUDIO_BYTES = SAMPLE_RATE * 2 * 0.5; // 0.5s minimum
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 15;  // 15s maximum for commands

export class WhisperAsrSession extends EventEmitter {
  private audioBuffer: Buffer[] = [];
  private preRollBuffer: Buffer[] = [];
  private totalBytes = 0;
  private vad: VAD;
  private sessionActive = false;
  private processing = false;
  private lastText = "";

  constructor() {
    super();
    this.vad = new VAD();
  }

  getLastText(): string {
    return this.lastText;
  }

  start(): void {
    this.sessionActive = true;
    this.audioBuffer = [];
    this.preRollBuffer = [];
    this.totalBytes = 0;
    this.vad.reset();
    log("WhisperAsrSession: started local Whisper command recognition");
  }

  stop(): void {
    if (!this.sessionActive) return;
    this.sessionActive = false;
    log(`WhisperAsrSession: stop() called, total audio: ${this.totalBytes} bytes`);
    if (this.totalBytes >= MIN_AUDIO_BYTES) {
      this.processAudio();
    } else {
      this.emit("final", "");
    }
  }

  feedPcm(buffer: Buffer): void {
    if (!this.sessionActive || this.processing) return;

    const vadEvent = this.vad.feed(buffer);

    if (this.audioBuffer.length === 0) {
      // Maintain sliding window pre-roll of 500ms (16000 bytes)
      this.preRollBuffer.push(buffer);
      let preRollBytes = this.preRollBuffer.reduce((sum, b) => sum + b.length, 0);
      while (preRollBytes > 16000 && this.preRollBuffer.length > 1) {
        preRollBytes -= this.preRollBuffer.shift()!.length;
      }

      if (vadEvent.speechStart) {
        // First chunk of speech
        this.emit("partial", "...");
        this.audioBuffer = [...this.preRollBuffer];
        this.totalBytes = preRollBytes;
        this.preRollBuffer = [];
      }
    } else {
      this.audioBuffer.push(buffer);
      this.totalBytes += buffer.length;

      // Stop on silence or max length
      if (vadEvent.silenceEnd || this.totalBytes >= MAX_AUDIO_BYTES) {
        log("WhisperAsrSession: silence or max length reached, transcribing...");
        this.sessionActive = false;
        this.preRollBuffer = [];
        this.processAudio();
      }
    }
  }

  private async processAudio(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    const audioData = Buffer.concat(this.audioBuffer);
    this.audioBuffer = [];
    this.totalBytes = 0;

    const wavPath = path.join(TEMP_DIR, `cmd-${Date.now()}.wav`);
    const wav = this.toWav(audioData);
    fs.writeFileSync(wavPath, wav);

    try {
      log("WhisperAsrSession: running whisper-cli...");
      const { stdout } = await execFileAsync(WHISPER_CLI, [
        "-m", getWhisperModelPath(),
        "-f", wavPath,
        "-l", "zh",
        "--no-timestamps",
        "-t", "4",
        "-np",
        "--prompt", "Daisy, 黛西",
        "-sns",
      ], {
        env: getWhisperExecutionEnv(WHISPER_CLI),
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });

      const text = stdout.trim().replace(/\[.*?\]/g, "").trim();
      this.lastText = text;
      log(`WhisperAsrSession: result="${text}"`);
      this.emit("final", text);
    } catch (error) {
      log(`WhisperAsrSession error: ${error instanceof Error ? error.message : String(error)}`);
      this.emit("error", error instanceof Error ? error.message : String(error));
    } finally {
      fs.promises.unlink(wavPath).catch(() => {});
      this.processing = false;
    }
  }

  private toWav(pcm: Buffer): Buffer {
    const header = Buffer.alloc(44);
    const dataLength = pcm.length;
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(dataLength + 36, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);          // PCM
    header.writeUInt16LE(1, 22);          // mono
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
    header.writeUInt16LE(2, 32);          // block align
    header.writeUInt16LE(16, 34);         // bits per sample
    header.write("data", 36, "ascii");
    header.writeUInt32LE(dataLength, 40);
    return Buffer.concat([header, pcm]);
  }
}
