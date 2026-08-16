import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "../config/env";
import { log } from "../utils/logger";
import {
  AsrCredentials,
  buildAudioRequest,
  buildFullClientRequest,
  buildRequestHeaders,
  buildStreamingWavHeader,
  extractTranscript,
  parseVolcengineResponse,
} from "./volcengine";

const SAMPLE_RATE = 16000;
const AUDIO_SEGMENT_MS = 100;
const AUDIO_SEGMENT_BYTES = Math.floor((SAMPLE_RATE * 2 * AUDIO_SEGMENT_MS) / 1000);
export const MAX_PENDING_AUDIO_BYTES = SAMPLE_RATE * 2 * 20;
const MAX_WEBSOCKET_BUFFERED_BYTES = 2 * 1024 * 1024;
export const ASR_CONNECT_TIMEOUT_MS = 8000;
const ASR_MAX_RETRY_BACKOFF_MS = 30000;

export enum AsrSessionState {
  IDLE = "IDLE",
  CONNECTING = "CONNECTING",
  RECORDING = "RECORDING",
  STOPPING = "STOPPING",
  FINALIZING = "FINALIZING",
}

export interface AsrSessionEvents {
  partial: (text: string) => void;
  final: (text: string) => void;
  error: (message: string) => void;
}

let networkFailureCount = 0;
let networkRetryNotBefore = 0;

function resetNetworkBackoff(): void {
  networkFailureCount = 0;
  networkRetryNotBefore = 0;
}

function recordNetworkFailure(now = Date.now()): number {
  networkFailureCount += 1;
  const delay = Math.min(
    1000 * 2 ** (networkFailureCount - 1),
    ASR_MAX_RETRY_BACKOFF_MS,
  );
  networkRetryNotBefore = now + delay;
  return delay;
}

export function getAsrNetworkRetryDelayMs(now = Date.now()): number {
  return Math.max(0, networkRetryNotBefore - now);
}

export class AsrSession extends EventEmitter {
  private socket: WebSocket | null = null;
  private seq = 1;
  private ready = false;
  private sentWavHeader = false;
  private audioChunks: Buffer[] = [];
  private audioChunkIndex = 0;
  private audioChunkOffset = 0;
  private bufferedAudioBytes = 0;
  private lastText = "";
  private sessionActive = false;
  private stopping = false;
  private lastSent = false;
  private finalEmitted = false;
  private credentials: AsrCredentials;
  private fastFinishTimer: NodeJS.Timeout | null = null;
  private connectTimeout: NodeJS.Timeout | null = null;
  private totalAudioBytes = 0;
  private state = AsrSessionState.IDLE;
  private generation = 0;
  private readonly socketFactory: (url: string, options: unknown) => WebSocket;
  private readonly connectTimeoutMs: number;

  constructor(options: {
    socketFactory?: (url: string, options: unknown) => WebSocket;
    connectTimeoutMs?: number;
  } = {}) {
    super();
    this.credentials = {
      appId: config.asr.appId,
      accessToken: config.asr.accessToken,
      resourceId: config.asr.resourceId,
    };
    this.socketFactory = options.socketFactory || ((url, socketOptions) =>
      new WebSocket(url, socketOptions as WebSocket.ClientOptions));
    this.connectTimeoutMs = options.connectTimeoutMs ?? ASR_CONNECT_TIMEOUT_MS;
  }

  start(): void {
    if (this.state !== AsrSessionState.IDLE || this.sessionActive) return;
    const retryDelay = getAsrNetworkRetryDelayMs();
    if (retryDelay > 0) {
      queueMicrotask(() => {
        if (this.state !== AsrSessionState.IDLE) return;
        this.emit(
          "error",
          `ASR 网络正在恢复，请在 ${Math.ceil(retryDelay / 1000)} 秒后重试`,
        );
      });
      return;
    }

    this.cleanup(false);
    const generation = ++this.generation;
    this.seq = 1;
    this.ready = false;
    this.sentWavHeader = false;
    this.sessionActive = true;
    this.stopping = false;
    this.lastSent = false;
    this.finalEmitted = false;
    this.lastText = "";
    this.totalAudioBytes = 0;
    this.transition(AsrSessionState.CONNECTING);
    log(`ASR: start() called, connecting WebSocket generation=${generation}`);
    this.connect(generation);
  }

  stop(): void {
    if (!this.sessionActive || this.stopping) return;
    this.stopping = true;
    this.transition(AsrSessionState.STOPPING);
    log(
      `ASR: stop() called, total audio: ${this.totalAudioBytes} bytes, lastText="${this.lastText}"`,
    );

    // A key release during CONNECTING keeps only the bounded pre-buffer. The
    // open handler sends it as the final packet; the connection timer provides
    // a deterministic terminal failure if the transport never becomes ready.
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      log("ASR: stop requested while CONNECTING; waiting for open/timeout");
      return;
    }
    this.flushAudio(true);
  }

  /** Cancel without producing a transcript or an error. */
  cancel(): void {
    this.generation += 1;
    this.finalEmitted = true;
    this.cleanup(false);
    this.lastText = "";
    this.totalAudioBytes = 0;
  }

  feedPcm(buffer: Buffer): void {
    if (!this.sessionActive || this.stopping || buffer.length === 0) return;
    this.totalAudioBytes += buffer.length;
    if (this.bufferedAudioBytes + buffer.length > MAX_PENDING_AUDIO_BYTES) {
      this.failAndCleanup(
        "ASR 音频缓存已达到 20 秒上限，请检查网络后重试",
        true,
      );
      return;
    }
    // Queue immutable PCM chunks. Rebuilding the complete recording through
    // Buffer.concat([old, next]) caused quadratic copying and unbounded memory.
    this.audioChunks.push(buffer);
    this.bufferedAudioBytes += buffer.length;
    this.flushAudio(false);
  }

  getLastText(): string {
    return this.lastText;
  }

  getBufferedAudioBytes(): number {
    return this.bufferedAudioBytes;
  }

  getState(): AsrSessionState {
    return this.state;
  }

  getGenerationForTest(): number {
    return this.generation;
  }

  private transition(nextState: AsrSessionState): void {
    if (this.state === nextState) return;
    const previous = this.state;
    this.state = nextState;
    log(`ASR state: ${previous} -> ${nextState} (generation=${this.generation})`);
  }

  private clearBufferedAudio(): void {
    this.audioChunks = [];
    this.audioChunkIndex = 0;
    this.audioChunkOffset = 0;
    this.bufferedAudioBytes = 0;
  }

  private takeBufferedAudio(requestedBytes: number): Buffer {
    const bytesToTake = Math.min(requestedBytes, this.bufferedAudioBytes);
    if (bytesToTake <= 0) return Buffer.alloc(0);

    const output = Buffer.allocUnsafe(bytesToTake);
    let outputOffset = 0;
    while (outputOffset < bytesToTake) {
      const chunk = this.audioChunks[this.audioChunkIndex];
      if (!chunk) break;
      const available = chunk.length - this.audioChunkOffset;
      const copyBytes = Math.min(available, bytesToTake - outputOffset);
      chunk.copy(
        output,
        outputOffset,
        this.audioChunkOffset,
        this.audioChunkOffset + copyBytes,
      );
      outputOffset += copyBytes;
      this.audioChunkOffset += copyBytes;
      if (this.audioChunkOffset >= chunk.length) {
        this.audioChunkIndex += 1;
        this.audioChunkOffset = 0;
      }
    }

    this.bufferedAudioBytes -= outputOffset;
    if (this.bufferedAudioBytes === 0) {
      this.clearBufferedAudio();
    } else if (
      this.audioChunkIndex >= 256 &&
      this.audioChunkIndex * 2 >= this.audioChunks.length
    ) {
      this.audioChunks = this.audioChunks.slice(this.audioChunkIndex);
      this.audioChunkIndex = 0;
    }
    return outputOffset === output.length
      ? output
      : output.subarray(0, outputOffset);
  }

  private finish(): void {
    if (this.finalEmitted) return;
    this.finalEmitted = true;
    const finalText = this.lastText;
    this.cleanup(false);
    this.emit("final", finalText);
  }

  private failAndCleanup(message: string, networkFailure = false): void {
    if (this.finalEmitted) return;
    this.finalEmitted = true;
    if (networkFailure) {
      const delay = recordNetworkFailure();
      log(`ASR: network retry backoff=${delay}ms`);
    }
    log(`ASR: terminal error: ${message}`);
    this.cleanup(true);
    this.emit("error", message);
  }

  private cleanup(terminateSocket: boolean): void {
    this.sessionActive = false;
    this.stopping = false;
    this.ready = false;
    this.lastSent = false;
    this.sentWavHeader = false;
    this.transition(AsrSessionState.IDLE);
    if (this.fastFinishTimer) {
      clearTimeout(this.fastFinishTimer);
      this.fastFinishTimer = null;
    }
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    this.clearBufferedAudio();

    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.removeAllListeners();
    socket.on("error", () => {});
    try {
      if (terminateSocket) socket.terminate();
      else if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
    } catch {
      // State, timers and buffers are already terminal even if close fails.
    }
  }

  private connect(generation: number): void {
    if (!this.credentials.appId || !this.credentials.accessToken) {
      this.failAndCleanup("缺少火山引擎 App ID 或 Access Token");
      return;
    }

    log("ASR: creating WebSocket connection");
    const socket = this.socketFactory(config.asr.wsUrl, {
      headers: buildRequestHeaders(this.credentials),
    });
    this.socket = socket;
    this.connectTimeout = setTimeout(() => {
      if (
        this.socket !== socket ||
        this.generation !== generation ||
        this.ready
      ) return;
      this.connectTimeout = null;
      this.failAndCleanup("ASR 连接超时，请检查网络后重试", true);
    }, this.connectTimeoutMs);

    socket.on("open", () => {
      if (this.socket !== socket || this.generation !== generation) return;
      if (!this.sessionActive) {
        this.cleanup(false);
        return;
      }
      if (this.connectTimeout) {
        clearTimeout(this.connectTimeout);
        this.connectTimeout = null;
      }
      this.ready = true;
      resetNetworkBackoff();
      this.transition(
        this.stopping ? AsrSessionState.STOPPING : AsrSessionState.RECORDING,
      );
      log("ASR: WebSocket connected, sending config + flushing audio");
      try {
        socket.send(buildFullClientRequest(this.seq++));
      } catch (error) {
        this.failAndCleanup(
          `发送 ASR 配置失败：${error instanceof Error ? error.message : String(error)}`,
          true,
        );
        return;
      }
      this.flushAudio(this.stopping);
    });

    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      if (
        this.socket !== socket ||
        this.generation !== generation ||
        this.finalEmitted
      ) return;
      try {
        const response = parseVolcengineResponse(Buffer.from(data as Buffer));
        if (response.code) {
          this.failAndCleanup(`火山 ASR 错误 ${response.code}`);
          return;
        }
        const text = extractTranscript(response.payloadMsg);
        if (text) {
          const normalized = text.replace(/\s+/g, " ").trim();
          if (normalized !== this.lastText) {
            this.lastText = normalized;
            this.emit("partial", normalized);
          }
        }
        if (response.isLastPackage) {
          log(`ASR: received last package, final text="${this.lastText}"`);
          this.finish();
        }
      } catch (error) {
        this.failAndCleanup(
          `解析 ASR 响应失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

    socket.on("error", (error: Error) => {
      if (
        this.socket !== socket ||
        this.generation !== generation ||
        this.finalEmitted
      ) return;
      this.failAndCleanup(`ASR 网络错误：${error.message}`, true);
    });

    socket.on("close", () => {
      if (
        this.socket !== socket ||
        this.generation !== generation ||
        this.finalEmitted
      ) return;
      log("ASR: WebSocket closed unexpectedly");
      if (this.stopping) this.finish();
      else this.failAndCleanup("ASR 网络连接已断开，请重试", true);
    });
  }

  private flushAudio(isLast: boolean): void {
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.lastSent || this.finalEmitted) return;

    while (this.bufferedAudioBytes >= AUDIO_SEGMENT_BYTES) {
      const segment = this.takeBufferedAudio(AUDIO_SEGMENT_BYTES);
      if (!this.sendAudioSegment(segment, false)) return;
    }

    if (isLast) {
      const finalSegment = this.takeBufferedAudio(this.bufferedAudioBytes);
      if (!this.sendAudioSegment(finalSegment, true)) return;
      this.lastSent = true;
      this.clearBufferedAudio();
      this.transition(AsrSessionState.FINALIZING);
      this.scheduleFinalizationWatchdog();
      log("ASR: sent last audio segment and cleared PCM queue");
    }
  }

  private scheduleFinalizationWatchdog(): void {
    if (this.finalEmitted || this.fastFinishTimer) return;
    let stableCount = 0;
    let lastText = this.lastText;
    let elapsed = 0;
    const checkStable = () => {
      this.fastFinishTimer = null;
      if (this.finalEmitted || this.state !== AsrSessionState.FINALIZING) return;
      elapsed += 300;
      if (this.lastText !== lastText) {
        stableCount = 0;
        lastText = this.lastText;
      } else if (this.lastText.length > 0) {
        stableCount += 1;
      }
      if ((this.lastText.length > 0 && stableCount >= 10) || elapsed >= 10000) {
        log(
          `ASR: finish (stable ${stableCount * 300}ms, elapsed ${elapsed}ms), lastText="${this.lastText}"`,
        );
        this.finish();
      } else {
        this.fastFinishTimer = setTimeout(checkStable, 300);
      }
    };
    this.fastFinishTimer = setTimeout(checkStable, 300);
  }

  private sendAudioSegment(segment: Buffer, isLast: boolean): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    if (this.socket.bufferedAmount > MAX_WEBSOCKET_BUFFERED_BYTES) {
      this.failAndCleanup(
        "ASR 网络发送队列已达到上限，请检查网络后重试",
        true,
      );
      return false;
    }

    let pcm = segment;
    if (!this.sentWavHeader) {
      this.sentWavHeader = true;
      pcm = Buffer.concat([buildStreamingWavHeader(SAMPLE_RATE), segment]);
    }
    try {
      this.socket.send(buildAudioRequest(this.seq++, pcm, isLast));
      return true;
    } catch (error) {
      this.failAndCleanup(
        `发送音频失败：${error instanceof Error ? error.message : String(error)}`,
        true,
      );
      return false;
    }
  }
}

export function __resetAsrNetworkBackoffForTest(): void {
  resetNetworkBackoff();
}
