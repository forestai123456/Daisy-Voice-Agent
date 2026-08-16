import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { log, logError } from "../utils/logger";
import { announceToUser } from "../utils/announce";

const execFileAsync = promisify(execFile);

/**
 * Windows ffmpeg auto-installer. On first use of an audio/video tool, Daisy
 * downloads a portable ffmpeg build from BtbN/FFmpeg-Builds (SHA-256 verified),
 * extracts ffmpeg.exe into userData/tools/ffmpeg, announces the install via
 * TTS, then runs the requested ffmpeg command. No Node native addon, no
 * Defender-flagged binary, no PATH pollution.
 */
const FFMPEG_REPOSITORY = "BtbN/FFmpeg-Builds";
const FFMPEG_TAG = "latest";
const FFMPEG_TIMEOUT_MS = 300_000;

function getUserDataPath(): string {
  try {
    return app.getPath("userData");
  } catch {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "Daisy",
    );
  }
}

function getFfmpegDirectory(): string {
  return path.join(getUserDataPath(), "tools", "ffmpeg");
}

function getFfmpegBinaryPath(): string {
  return path.join(getFfmpegDirectory(), "ffmpeg.exe");
}

function getAssetName(): string {
  if (process.platform !== "win32") {
    throw new Error(`ffmpeg 自动安装仅支持 Windows，当前系统：${process.platform}`);
  }
  if (process.arch === "arm64") return "ffmpeg-master-latest-winarm64-gpl.zip";
  // x64 native. ia32 = 32-bit Electron on x64/arm64 Windows; the OS can still
  // spawn the x64 ffmpeg as a child process, so the x64 asset is correct.
  if (process.arch === "x64" || process.arch === "ia32") return "ffmpeg-master-latest-win64-gpl.zip";
  throw new Error(`当前 Windows 架构暂不支持自动安装 ffmpeg：${process.arch}`);
}

interface FfmpegRelease {
  assetName: string;
  sha256: string | null;
}

async function fetchLatestFfmpeg(): Promise<FfmpegRelease> {
  const assetName = getAssetName();
  // BtbN's rolling "latest" tag does not always publish a SHA256SUMS file; when
  // it is absent we fall back to HTTPS-only integrity (the download is served
  // over TLS from GitHub) plus a post-extraction `ffmpeg -version` health check.
  let sha256: string | null = null;
  try {
    const sumsResponse = await fetch(
      `https://github.com/${FFMPEG_REPOSITORY}/releases/download/${FFMPEG_TAG}/SHA256SUMS`,
      { headers: { "User-Agent": "Daisy-ffmpeg-Manager" } },
    );
    if (sumsResponse.ok) {
      const checksumLine = (await sumsResponse.text())
        .split(/\r?\n/)
        .find((line) => line.trim().endsWith(`  ${assetName}`));
      const hash = checksumLine?.trim().split(/\s+/)[0]?.toLowerCase();
      if (hash && /^[a-f0-9]{64}$/.test(hash)) sha256 = hash;
    }
  } catch {
    /* network hiccup; fall back to HTTPS-only */
  }
  if (!sha256) {
    log(`[ffmpeg] SHA256SUMS unavailable for ${assetName}; relying on HTTPS + health check`);
  }
  return { assetName, sha256 };
}

async function isFfmpegReady(binaryPath: string): Promise<boolean> {
  if (!fs.existsSync(binaryPath)) return false;
  try {
    await execFileAsync(binaryPath, ["-version"], { timeout: 15_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function findFileRecursive(root: string, name: string): Promise<string | null> {
  const lower = name.toLowerCase();
  async function walk(dir: string): Promise<string | null> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === lower) return full;
      if (entry.isDirectory()) {
        const found = await walk(full);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(root);
}

async function downloadAndExtract(release: FfmpegRelease): Promise<void> {
  const dir = getFfmpegDirectory();
  const binaryPath = getFfmpegBinaryPath();
  await fs.promises.mkdir(dir, { recursive: true });
  const zipPath = path.join(dir, release.assetName);
  const extractDir = path.join(dir, "extract");

  const response = await fetch(
    `https://github.com/${FFMPEG_REPOSITORY}/releases/download/${FFMPEG_TAG}/${release.assetName}`,
    { headers: { "User-Agent": "Daisy-ffmpeg-Manager" } },
  );
  if (!response.ok) {
    throw new Error(`ffmpeg 下载失败（HTTP ${response.status}）`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (release.sha256) {
    const actualSha = createHash("sha256").update(data).digest("hex");
    if (actualSha !== release.sha256) {
      throw new Error("ffmpeg 下载文件的 SHA-256 校验失败，已拒绝安装");
    }
  }
  await fs.promises.writeFile(zipPath, data);

  await fs.promises.rm(extractDir, { recursive: true, force: true });
  await fs.promises.mkdir(extractDir, { recursive: true });
  const ps = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    timeout: 120_000,
    windowsHide: true,
  });

  const found = await findFileRecursive(extractDir, "ffmpeg.exe");
  if (!found) throw new Error("ffmpeg 解压后未找到 ffmpeg.exe");

  await fs.promises.unlink(binaryPath).catch(() => {});
  await fs.promises.copyFile(found, binaryPath);

  await fs.promises.unlink(zipPath).catch(() => {});
  await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});

  if (!(await isFfmpegReady(binaryPath))) {
    throw new Error("ffmpeg 安装后的健康检查失败");
  }
  log(`[ffmpeg] installed at ${binaryPath}`);
}

let installPromise: Promise<string> | null = null;

async function ensureFfmpeg(): Promise<string> {
  const binaryPath = getFfmpegBinaryPath();
  if (await isFfmpegReady(binaryPath)) return binaryPath;

  if (!installPromise) {
    installPromise = (async () => {
      await announceToUser("首次使用音视频功能，正在下载安装 ffmpeg（约 100 兆），请稍候。");
      const release = await fetchLatestFfmpeg();
      log(`[ffmpeg] arch=${process.arch} platform=${process.platform} asset=${release.assetName}`);
      await downloadAndExtract(release);
      return getFfmpegBinaryPath();
    })()
      .catch((error) => {
        logError("[ffmpeg] install failed", error);
        throw error;
      })
      .finally(() => {
        installPromise = null;
      });
  }
  return installPromise;
}

/** Ensure ffmpeg is installed, then run it with the given args. */
export async function runFfmpeg(args: string[], timeout = FFMPEG_TIMEOUT_MS): Promise<string> {
  const binaryPath = await ensureFfmpeg();
  const { stdout, stderr } = await execFileAsync(binaryPath, args, {
    timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
}

/**
 * Return the ffmpeg directory IF ffmpeg.exe is already installed (no download).
 * Used by downloadMedia to pass --ffmpeg-location to yt-dlp so it can merge
 * separate video+audio streams into a single file.
 */
export function getFfmpegDirIfAvailable(): string | null {
  const binaryPath = getFfmpegBinaryPath();
  if (fs.existsSync(binaryPath)) return getFfmpegDirectory();
  return null;
}
