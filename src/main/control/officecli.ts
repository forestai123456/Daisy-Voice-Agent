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

const OFFICECLI_REPOSITORY = "iOfficeAI/OfficeCLI";
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OFFICECLI_TIMEOUT_MS = 90_000;
const MAX_TOOL_OUTPUT_LENGTH = 30_000;

type OfficeDocumentOperation = "create" | "inspect" | "query" | "edit" | "validate" | "convert";

interface OfficeCliState {
  installedVersion?: string;
  lastUpdateCheckAt?: number;
}

interface ReleaseInfo {
  tag: string;
  version: string;
  assetName: string;
  sha256: string;
}

let installPromise: Promise<string> | null = null;
let updatePromise: Promise<void> | null = null;

function getUserDataPath(): string {
  try {
    return app.getPath("userData");
  } catch {
    return process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Daisy")
      : path.join(os.homedir(), "Library", "Application Support", "Daisy");
  }
}

function getOfficeCliDirectory(): string {
  return path.join(getUserDataPath(), "tools", "officecli");
}

function getOfficeCliBinaryPath(): string {
  const exe = process.platform === "win32" ? "officecli.exe" : "officecli";
  return path.join(getOfficeCliDirectory(), exe);
}

function getOfficeCliStatePath(): string {
  return path.join(getOfficeCliDirectory(), "state.json");
}

function getOfficeCliHome(): string {
  // OfficeCLI also knows how to install MCP/skill integrations for coding tools.
  // Daisy must never let a document helper modify the user's Codex/Claude/Cursor
  // configuration, so its HOME is intentionally isolated inside Daisy data.
  return path.join(getOfficeCliDirectory(), "home");
}

function getAssetName(): string {
  if (process.platform === "win32") {
    if (process.arch === "arm64") return "officecli-win-arm64.exe";
    // x64 native. ia32 = 32-bit Electron on x64/arm64 Windows; the OS can still
    // spawn the x64 binary as a child process, so the x64 asset is correct.
    if (process.arch === "x64" || process.arch === "ia32") return "officecli-win-x64.exe";
    throw new Error(`当前 Windows 架构暂不支持自动安装 OfficeCLI：${process.arch}`);
  }
  if (process.platform !== "darwin") {
    throw new Error(`当前系统暂不支持自动安装 OfficeCLI：${process.platform}`);
  }
  if (process.arch === "arm64") return "officecli-mac-arm64";
  if (process.arch === "x64") return "officecli-mac-x64";
  throw new Error(`当前 Mac 架构暂不支持自动安装 OfficeCLI：${process.arch}`);
}

function getOfficeCliEnvironment(): NodeJS.ProcessEnv {
  const home = getOfficeCliHome();
  return {
    ...process.env,
    HOME: home,
    // Windows uses USERPROFILE; setting both is harmless on macOS/Linux.
    USERPROFILE: home,
    OFFICECLI_SKIP_UPDATE: "1",
  };
}

function sanitizeVersion(value: string): string | null {
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(value.trim());
  return match ? match[1] : null;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function trimOutput(value: string): string {
  if (value.length <= MAX_TOOL_OUTPUT_LENGTH) return value;
  return `${value.slice(0, MAX_TOOL_OUTPUT_LENGTH)}\n…（OfficeCLI 输出过长，已截断）`;
}

async function readState(): Promise<OfficeCliState> {
  try {
    const raw = await fs.promises.readFile(getOfficeCliStatePath(), "utf-8");
    const parsed = JSON.parse(raw) as OfficeCliState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(state: OfficeCliState): Promise<void> {
  const statePath = getOfficeCliStatePath();
  await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.partial`;
  await fs.promises.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  await fs.promises.rename(temporaryPath, statePath);
}

async function getInstalledVersion(binaryPath: string): Promise<string | null> {
  if (!fs.existsSync(binaryPath)) return null;
  try {
    const { stdout } = await execFileAsync(binaryPath, ["--version"], {
      timeout: 20_000,
      env: getOfficeCliEnvironment(),
      maxBuffer: 64 * 1024,
    });
    return sanitizeVersion(stdout);
  } catch {
    return null;
  }
}

async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const latestResponse = await fetch(
    `https://github.com/${OFFICECLI_REPOSITORY}/releases/latest`,
    {
      redirect: "follow",
      headers: { "User-Agent": "Daisy-OfficeCLI-Manager" },
    },
  );
  if (!latestResponse.ok) {
    throw new Error(`无法查询 OfficeCLI 最新版本（HTTP ${latestResponse.status}）`);
  }

  const tag = decodeURIComponent(new URL(latestResponse.url).pathname)
    .match(/\/releases\/tag\/(v?\d+\.\d+\.\d+)$/)?.[1];
  const version = tag ? sanitizeVersion(tag) : null;
  if (!tag || !version) {
    throw new Error("无法识别 OfficeCLI 最新版本号");
  }

  const assetName = getAssetName();
  const sumsResponse = await fetch(
    `https://github.com/${OFFICECLI_REPOSITORY}/releases/download/${tag}/SHA256SUMS`,
    { headers: { "User-Agent": "Daisy-OfficeCLI-Manager" } },
  );
  if (!sumsResponse.ok) {
    throw new Error(`无法下载 OfficeCLI 校验清单（HTTP ${sumsResponse.status}）`);
  }

  const checksumLine = (await sumsResponse.text())
    .split(/\r?\n/)
    .find((line) => line.trim().endsWith(`  ${assetName}`));
  const sha256 = checksumLine?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`OfficeCLI 发布包缺少 ${assetName} 的 SHA-256 校验值`);
  }

  return { tag, version, assetName, sha256 };
}

async function downloadVerifiedBinary(release: ReleaseInfo, temporaryPath: string): Promise<void> {
  const response = await fetch(
    `https://github.com/${OFFICECLI_REPOSITORY}/releases/download/${release.tag}/${release.assetName}`,
    { headers: { "User-Agent": "Daisy-OfficeCLI-Manager" } },
  );
  if (!response.ok) {
    throw new Error(`OfficeCLI 下载失败（HTTP ${response.status}）`);
  }

  const data = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash("sha256").update(data).digest("hex");
  if (actualSha256 !== release.sha256) {
    throw new Error("OfficeCLI 下载文件的 SHA-256 校验失败，已拒绝安装");
  }

  await fs.promises.writeFile(temporaryPath, data, { mode: 0o755 });
  await fs.promises.chmod(temporaryPath, 0o755);
}

async function removeQuarantine(binaryPath: string): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await execFileAsync("/usr/bin/xattr", ["-d", "com.apple.quarantine", binaryPath], {
      timeout: 5_000,
    });
  } catch {
    // Files fetched by Daisy normally have no quarantine attribute. If there is
    // none, xattr exits non-zero, which is also harmless.
  }
}

async function installOrUpdateBinary(release: ReleaseInfo, previousVersion: string | null): Promise<string> {
  const directory = getOfficeCliDirectory();
  const binaryPath = getOfficeCliBinaryPath();
  const temporaryPath = path.join(directory, `${release.assetName}.${release.version}.partial`);
  const backupPath = `${binaryPath}.previous`;

  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.mkdir(getOfficeCliHome(), { recursive: true });
  await fs.promises.unlink(temporaryPath).catch(() => {});

  try {
    await downloadVerifiedBinary(release, temporaryPath);
    await removeQuarantine(temporaryPath);

    const downloadedVersion = await getInstalledVersion(temporaryPath);
    if (downloadedVersion !== release.version) {
      throw new Error(`OfficeCLI 版本校验失败，期望 ${release.version}，实际 ${downloadedVersion ?? "无法读取"}`);
    }

    await fs.promises.unlink(backupPath).catch(() => {});
    const hadCurrentBinary = fs.existsSync(binaryPath);
    if (hadCurrentBinary) await fs.promises.rename(binaryPath, backupPath);

    try {
      await fs.promises.rename(temporaryPath, binaryPath);
      const installedVersion = await getInstalledVersion(binaryPath);
      if (installedVersion !== release.version) {
        throw new Error("OfficeCLI 安装后的健康检查失败");
      }
      await fs.promises.unlink(backupPath).catch(() => {});
      await writeState({ installedVersion, lastUpdateCheckAt: Date.now() });
      log(`OfficeCLI ${previousVersion ? `updated ${previousVersion} ->` : "installed"} ${installedVersion}`);
      return binaryPath;
    } catch (error) {
      await fs.promises.unlink(binaryPath).catch(() => {});
      if (hadCurrentBinary && fs.existsSync(backupPath)) {
        await fs.promises.rename(backupPath, binaryPath);
      }
      throw error;
    }
  } finally {
    await fs.promises.unlink(temporaryPath).catch(() => {});
  }
}

async function installLatestOfficeCli(): Promise<string> {
  await announceToUser("首次使用文档功能，正在下载安装 OfficeCLI，请稍候。");
  const release = await fetchLatestRelease();
  log(`[OfficeCLI] arch=${process.arch} platform=${process.platform} asset=${release.assetName}`);
  return await installOrUpdateBinary(release, null);
}

function scheduleOfficeCliUpdate(currentVersion: string): void {
  if (updatePromise) return;

  updatePromise = (async () => {
    const state = await readState();
    if (state.lastUpdateCheckAt && Date.now() - state.lastUpdateCheckAt < UPDATE_INTERVAL_MS) return;

    const release = await fetchLatestRelease();
    await writeState({ ...state, installedVersion: currentVersion, lastUpdateCheckAt: Date.now() });
    if (compareVersions(release.version, currentVersion) <= 0) return;

    await installOrUpdateBinary(release, currentVersion);
  })()
    .catch((error) => {
      logError("OfficeCLI automatic update failed", error);
    })
    .finally(() => {
      updatePromise = null;
    });
}

async function ensureOfficeCli(): Promise<string> {
  const binaryPath = getOfficeCliBinaryPath();
  const installedVersion = await getInstalledVersion(binaryPath);
  if (installedVersion) {
    scheduleOfficeCliUpdate(installedVersion);
    return binaryPath;
  }

  if (!installPromise) {
    installPromise = installLatestOfficeCli().finally(() => {
      installPromise = null;
    });
  }
  return await installPromise;
}

async function runOfficeCli(args: string[], timeout = OFFICECLI_TIMEOUT_MS): Promise<string> {
  const binaryPath = await ensureOfficeCli();
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, args, {
      timeout,
      env: getOfficeCliEnvironment(),
      maxBuffer: 8 * 1024 * 1024,
    });
    return trimOutput(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim());
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${details.stdout ?? ""}${details.stderr ? `\n${details.stderr}` : ""}`.trim();
    throw new Error(trimOutput(output || details.message || "OfficeCLI 执行失败"));
  }
}

async function validateOfficeDocument(filePath: string): Promise<{ passed: boolean; output: string }> {
  try {
    return {
      passed: true,
      output: await runOfficeCli(["validate", filePath, "--json"]),
    };
  } catch (error) {
    // Existing Office files in the wild can contain pre-existing schema issues.
    // Keep the edit result truthful: surface the warning, but do not report a
    // successfully written file as an editing failure merely because validation
    // found an inherited issue.
    const message = error instanceof Error ? error.message : String(error);
    return { passed: false, output: message };
  }
}

function getFileExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function ensureOfficeSource(source: string): void {
  if (!fs.existsSync(source)) {
    throw new Error(`找不到源文件「${source}」`);
  }
}

function validateBatchCommands(rawCommands: string): string {
  let commands: unknown;
  try {
    commands = JSON.parse(rawCommands);
  } catch {
    throw new Error("文档编辑 commands 必须是合法的 JSON 数组");
  }
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error("文档编辑 commands 必须至少包含一项操作");
  }

  const allowedOperations = new Set(["set", "add", "remove", "move", "swap"]);
  for (const command of commands) {
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      throw new Error("文档编辑 commands 中包含无效操作");
    }
    const operation = (command as { command?: unknown }).command;
    if (typeof operation !== "string" || !allowedOperations.has(operation)) {
      throw new Error(`不允许的 OfficeCLI 编辑操作：${String(operation)}。仅允许 set、add、remove、move、swap`);
    }
  }
  return JSON.stringify(commands);
}

async function closeOfficeCliDocument(filePath: string): Promise<void> {
  try {
    await runOfficeCli(["close", filePath, "--json"], 30_000);
  } catch (error) {
    // The document may not be in resident mode. A successful batch has already
    // flushed on close when one exists, so this is diagnostic-only.
    logError(`OfficeCLI close failed for ${path.basename(filePath)}`, error);
  }
}

async function copyForEditing(source: string, target: string): Promise<string> {
  if (source === target) return source;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.copyFile(source, target);
  return target;
}

export async function officeDocument(
  sourceInput: string | undefined,
  operation: OfficeDocumentOperation,
  options: { target?: string; query?: string; commands?: string } = {},
): Promise<string> {
  const source = sourceInput?.trim() ? path.resolve(expandPath(sourceInput)) : undefined;
  const target = options.target ? path.resolve(expandPath(options.target)) : undefined;

  try {
    if (operation === "create") {
      if (!target) return "创建文档需要提供 target 输出路径";
      const extension = getFileExtension(target);
      if (!new Set([".docx", ".xlsx", ".pptx"]).has(extension)) {
        return "OfficeCLI 只能创建 .docx、.xlsx 或 .pptx 文档";
      }
      if (fs.existsSync(target)) {
        return `目标文件已存在，未覆盖：「${path.basename(target)}」`;
      }

      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const result = await runOfficeCli(["create", target]);
      if (!fs.existsSync(target)) {
        throw new Error("OfficeCLI 未生成目标文件");
      }
      const validation = await validateOfficeDocument(target);
      return `已用 OfficeCLI 创建「${path.basename(target)}」：\n${result}\n校验${validation.passed ? "通过" : "发现问题"}：${validation.output}`;
    }

    if (!source) return "此文档操作需要提供 source 源文件路径";
    ensureOfficeSource(source);

    switch (operation) {
      case "inspect":
        return `OfficeCLI 文档结构：\n${await runOfficeCli(["view", source, "annotated", "--json"])}`;
      case "query":
        if (!options.query?.trim()) return "查询文档需要提供 query";
        return `OfficeCLI 查询结果：\n${await runOfficeCli(["query", source, options.query, "--json"])}`;
      case "validate":
        {
          const validation = await validateOfficeDocument(source);
          return `OfficeCLI 校验${validation.passed ? "通过" : "发现问题"}：\n${validation.output}`;
        }
      case "edit": {
        if (!target) return "编辑文档需要提供 target 输出路径";
        if (!options.commands) return "编辑文档需要提供 commands JSON 操作数组";
        const commands = validateBatchCommands(options.commands);
        const editTarget = await copyForEditing(source, target);
        try {
          const result = await runOfficeCli(["batch", editTarget, "--commands", commands, "--json"]);
          const validation = await validateOfficeDocument(editTarget);
          return `已用 OfficeCLI 编辑「${path.basename(editTarget)}」：\n${result}\n校验${validation.passed ? "通过" : "发现问题"}：${validation.output}`;
        } finally {
          await closeOfficeCliDocument(editTarget);
        }
      }
      case "convert": {
        if (!target) return "文档格式转换需要提供 target 输出路径";
        const targetExtension = getFileExtension(target);
        const renderModeByExtension: Record<string, string> = {
          ".html": "html",
          ".htm": "html",
          ".png": "screenshot",
          ".svg": "svg",
          ".pdf": "pdf",
        };
        const renderMode = renderModeByExtension[targetExtension];
        if (renderMode) {
          try {
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            const result = await runOfficeCli(["view", source, renderMode, "-o", target, "--json"], 180_000);
            if (fs.existsSync(target)) {
              return `已用 OfficeCLI 转换并保存「${path.basename(target)}」：\n${result}`;
            }
          } catch (error) {
            logError(`OfficeCLI conversion fallback for ${path.basename(source)}`, error);
          }
        }
        // OfficeCLI plugins may later cover more formats. Until a matching
        // plugin is installed, keep Daisy's established converter as a safe
        // fallback instead of pretending the conversion succeeded.
        const { convertDocument } = await import("./macos");
        return await convertDocument(source, target);
      }
      default:
        return "未知的 OfficeCLI 文档操作";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`OfficeCLI ${operation} failed`, error);
    return `OfficeCLI 文档处理失败: ${message}`;
  }
}

function expandPath(input: string): string {
  if (input === "~") return os.homedir();
  return input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
}
