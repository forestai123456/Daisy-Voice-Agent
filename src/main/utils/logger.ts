import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { app } from "electron";

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_LOG_ARCHIVES = 2;

function archivePath(logFile: string, index: number): string {
  return `${logFile}.${index}`;
}

function rotateLogIfNeeded(logFile: string, incomingBytes: number): void {
  const size = fs.statSync(logFile).size;
  if (size + incomingBytes <= MAX_LOG_BYTES) return;

  const oldestArchive = archivePath(logFile, MAX_LOG_ARCHIVES);
  if (fs.existsSync(oldestArchive)) fs.unlinkSync(oldestArchive);
  for (let index = MAX_LOG_ARCHIVES - 1; index >= 1; index--) {
    const source = archivePath(logFile, index);
    if (fs.existsSync(source)) fs.renameSync(source, archivePath(logFile, index + 1));
  }

  const newestArchive = archivePath(logFile, 1);
  if (size <= MAX_LOG_BYTES) {
    fs.renameSync(logFile, newestArchive);
    return;
  }

  // An old unbounded log may already be present when this version first runs.
  // Keep only its newest tail so the first rotation also restores the size cap.
  const retainedBytes = Math.max(0, MAX_LOG_BYTES - incomingBytes);
  const buffer = Buffer.alloc(retainedBytes);
  const fd = fs.openSync(logFile, "r");
  try {
    fs.readSync(fd, buffer, 0, retainedBytes, size - retainedBytes);
  } finally {
    fs.closeSync(fd);
  }
  fs.writeFileSync(newestArchive, buffer);
  fs.truncateSync(logFile, 0);
}

function getLogFile(): string {
  try {
    const logDir = app?.getPath?.("logs") || path.join(os.tmpdir(), "diri-logs");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    return path.join(logDir, "diri-main.log");
  } catch {
    return path.join(os.tmpdir(), "diri-main.log");
  }
}

export function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  try {
    process.stdout.write(line);
  } catch {
    // stdout may not be available in packaged app
  }
  try {
    const logFile = getLogFile();
    if (fs.existsSync(logFile)) {
      rotateLogIfNeeded(logFile, Buffer.byteLength(line));
    }
    fs.appendFileSync(logFile, line);
  } catch {
    // ignore
  }
}

export function logDebug(message: string): void {
  log(`DEBUG: ${message}`);
}

export function logError(message: string, error?: unknown): void {
  let detail = "";
  if (error instanceof Error) {
    detail = `${error.message}\n${error.stack || ""}`;
  } else if (error !== undefined) {
    detail = String(error);
  }
  log(`ERROR: ${message} ${detail}`.trim());
}
