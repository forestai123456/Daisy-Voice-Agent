import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "../utils/logger";
import { getWhisperModelPath, getBundledBin, getWhisperExecutionEnv } from "../config/env";

const execFileAsync = promisify(execFile);

const WHISPER_CLI = getBundledBin("whisper-cli");
const TEMP_DIR = path.join(os.tmpdir(), "diri-wakeword");

const SAMPLE_RATE = 16000;
const MIN_AUDIO_BYTES = SAMPLE_RATE * 2 * 0.5; // 0.5s minimum
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 8;   // 8s maximum
const SILENCE_THRESHOLD = 0.008;
const SILENCE_END_MS = 2000;
const SPEECH_START_MS = 0; // Trigger on first loud frame

const WAKE_WORD_PATTERNS: RegExp[] = [
  // 1. Chinese prefix + Chinese Daisy (e.g. 嘿黛西, 嘿代茜)
  /[嘿嗨黑喂][,\s]*[呆戴代带袋大达][西茜希溪喜细]/,
  
  // 2. English prefix + English Daisy (e.g. hey daisy, hi daisy, hello daisy)
  /\b(hey|hi|hello|okay|ok)[,\s]*(daisy|daysi|dayzi|deisy|deizy)\b/i,
  
  // 3. English prefix + Chinese Daisy (e.g. hey 黛西)
  /\b(hey|hi|hello|okay|ok)[,\s]*[呆戴代带袋大达][西茜希溪喜细]/i,
  
  // 4. Chinese prefix + English Daisy (e.g. 嘿 daisy)
  /[嘿嗨黑喂][,\s]*(daisy|daysi|dayzi|deisy|deizy)/i,
];
type MonitorState = "idle" | "recording" | "paused";

export class WakeWordMonitor extends EventEmitter {
  private state: MonitorState = "idle";
  private audioBuffer: Buffer[] = [];
  private preRollBuffer: Buffer[] = [];
  private totalBytes = 0;
  private vad: VAD;
  private processing = false;

  constructor(_keyword: string) {
    super();
    this.vad = new VAD(800);
  }

  start(): void {
    this.state = "idle";
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
    log("WakeWordMonitor: started, using whisper.cpp local detection");
  }

  stop(): void {
    this.pause();
    this.state = "paused";
  }

  pause(): void {
    this.state = "paused";
    this.audioBuffer = [];
    this.totalBytes = 0;
    this.vad.reset();
  }

  resume(): void {
    if (this.state === "paused") {
      this.state = "idle";
      this.audioBuffer = [];
      this.totalBytes = 0;
      this.vad.reset();
      log("WakeWordMonitor: resumed");
    }
  }

  feedPcm(buffer: Buffer): void {
    if (this.state === "paused") return;

    const vadEvent = this.vad.feed(buffer);

    if (this.state === "idle") {
      // Maintain a sliding window pre-roll buffer of 500ms (16000 bytes)
      this.preRollBuffer.push(buffer);
      let preRollBytes = this.preRollBuffer.reduce((sum, b) => sum + b.length, 0);
      while (preRollBytes > 16000 && this.preRollBuffer.length > 1) {
        preRollBytes -= this.preRollBuffer.shift()!.length;
      }

      if (vadEvent.speechStart) {
        this.state = "recording";
        this.audioBuffer = [...this.preRollBuffer];
        this.totalBytes = preRollBytes;
        this.preRollBuffer = [];
      }
    } else if (this.state === "recording") {
      this.audioBuffer.push(buffer);
      this.totalBytes += buffer.length;

      // Stop recording on silence or max length
      if (vadEvent.silenceEnd || this.totalBytes >= MAX_AUDIO_BYTES) {
        this.state = "idle";
        this.vad.reset();
        this.preRollBuffer = [];
        if (this.totalBytes >= MIN_AUDIO_BYTES) {
          this.processAudio();
        } else {
          this.audioBuffer = [];
          this.totalBytes = 0;
        }
      }
    }
  }

  private async processAudio(): Promise<void> {
    if (this.processing) {
      this.audioBuffer = [];
      this.totalBytes = 0;
      return;
    }

    this.processing = true;
    const audioData = Buffer.concat(this.audioBuffer);
    this.audioBuffer = [];
    this.totalBytes = 0;

    try {
      const text = await this.transcribeWithWhisper(audioData);
      if (text) {
        log(`WakeWordMonitor: whisper.cpp result="${text}"`);
        if (this.containsWakeWord(text)) {
          const command = this.extractCommand(text);
          log(`WakeWordMonitor: wake word detected! command="${command}"`);
          this.emit("wake", command);
        }
      }
    } catch (error) {
      log(`WakeWordMonitor: whisper error: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.processing = false;
  }

  private async transcribeWithWhisper(audioData: Buffer): Promise<string> {
    const wavPath = path.join(TEMP_DIR, `wake-${Date.now()}.wav`);

    // Write WAV file with header
    const wav = this.toWav(audioData);
    fs.writeFileSync(wavPath, wav);

    try {
      const { stdout } = await execFileAsync(WHISPER_CLI, [
        "-m", getWhisperModelPath(),
        "-f", wavPath,
        "-l", "en",
        "--no-timestamps",
        "-t", "4",
        "-np",
        "--prompt", "Hey Daisy",
        "-sns",
      ], {
        env: getWhisperExecutionEnv(WHISPER_CLI),
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });

      // whisper-cli outputs transcript to stdout, clean it up
      const text = stdout.trim().replace(/\[.*?\]/g, "").trim();
      return text;
    } finally {
      fs.promises.unlink(wavPath).catch(() => {});
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

  private containsWakeWord(text: string): boolean {
    const normalized = text.replace(/[\s,，。！!？?、~""''']/g, "");
    for (const pattern of WAKE_WORD_PATTERNS) {
      if (pattern.test(normalized) || pattern.test(text)) {
        log(`WakeWordMonitor: matched pattern ${pattern.source}`);
        return true;
      }
    }
    return false;
  }

  private extractCommand(text: string): boolean | string {
    for (const pattern of WAKE_WORD_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        const idx = text.indexOf(match[0]);
        if (idx >= 0) {
          const remaining = text.slice(idx + match[0].length);
          return remaining.replace(/^[,，。！!？?、\s]+/, "").trim();
        }
      }
    }
    return "";
  }
}

export class VAD {
  private noiseFloor = 0.005; // adaptive noise baseline
  private speechStartMs = 0;
  private silenceEndMs = 2000;
  private inSpeech = false;
  private speechCounter = 0;
  private silenceCounter = 0;
  private frameCount = 0;

  constructor(silenceEndMs = 2000) {
    this.silenceEndMs = silenceEndMs;
  }

  feed(buffer: Buffer): { speechStart: boolean; silenceEnd: boolean } {
    const energy = this.calculateEnergy(buffer);
    const chunkMs = ((buffer.length / 2) / SAMPLE_RATE) * 1000;

    // Adaptive noise floor: only update when NOT in speech
    if (!this.inSpeech) {
      // Slowly adapt to background noise
      this.noiseFloor = this.noiseFloor * 0.97 + energy * 0.03;
    }
    // Threshold is 2x above noise floor, minimum 0.02
    const threshold = Math.max(this.noiseFloor * 2, 0.02);
    const isLoud = energy > threshold;

    this.frameCount++;
    if (this.frameCount % 50 === 0) {
      log(`VAD: energy=${energy.toFixed(4)} noiseFloor=${this.noiseFloor.toFixed(4)} threshold=${threshold.toFixed(4)} isLoud=${isLoud} inSpeech=${this.inSpeech}`);
    }

    if (!this.inSpeech) {
      if (isLoud) {
        this.speechCounter += chunkMs;
        this.silenceCounter = 0;
        if (this.speechCounter >= this.speechStartMs) {
          this.inSpeech = true;
          return { speechStart: true, silenceEnd: false };
        }
      } else {
        this.speechCounter = 0;
      }
      return { speechStart: false, silenceEnd: false };
    } else {
      if (isLoud) {
        this.silenceCounter = 0;
      } else {
        this.silenceCounter += chunkMs;
        if (this.silenceCounter >= this.silenceEndMs) {
          this.inSpeech = false;
          this.speechCounter = 0;
          this.silenceCounter = 0;
          return { speechStart: false, silenceEnd: true };
        }
      }
      return { speechStart: false, silenceEnd: false };
    }
  }

  reset(): void {
    this.inSpeech = false;
    this.speechCounter = 0;
    this.silenceCounter = 0;
    this.noiseFloor = 0.005;
  }

  private calculateEnergy(buffer: Buffer): number {
    let sum = 0;
    const samples = buffer.length / 2;
    if (samples === 0) return 0;
    for (let i = 0; i < buffer.length; i += 2) {
      const sample = buffer.readInt16LE(i);
      sum += Math.abs(sample);
    }
    return sum / samples / 32768;
  }
}
