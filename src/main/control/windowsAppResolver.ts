import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_PROGRAM_SCAN_DEPTH = 5;

export type AppLaunchTarget =
  | { kind: "exe"; displayName: string; filePath: string; args?: string[]; aliases: string[] }
  | { kind: "shortcut"; displayName: string; filePath: string; aliases: string[] }
  | { kind: "uwp"; displayName: string; appUserModelId: string; aliases: string[] }
  | { kind: "system"; displayName: string; command: string; args?: string[]; aliases: string[] };

export type ResolveResult =
  | { found: true; target: AppLaunchTarget; match: "alias" | "exact" | "fuzzy" | "system" }
  | { found: false; reason: "not-found" };

export interface LaunchResult {
  found: boolean;
  launched: boolean;
  target?: AppLaunchTarget;
  match?: "alias" | "exact" | "fuzzy" | "system";
  reason?: "not-found" | "launch-failed";
}

export interface WindowsAppDiagnosis {
  found: boolean;
  target?: AppLaunchTarget;
  match?: "alias" | "exact" | "fuzzy" | "system";
  launchTargetExists?: boolean;
  processImageName?: string;
  running?: boolean;
  recentFailures: Array<{ time: string; provider: string; id: number }>;
}

interface IndexedTarget {
  target: AppLaunchTarget;
  displayKey: string;
  aliasKeys: string[];
}

interface ShortcutRecord {
  DisplayName?: string;
  ShortcutPath?: string;
  TargetPath?: string;
}

interface AppPathRecord {
  Name?: string;
  Command?: string;
}

interface StartAppRecord {
  Name?: string;
  AppID?: string;
  AppId?: string;
}

const APP_ALIASES: Record<string, string[]> = {
  wechat: ["微信", "wechat", "weixin"],
  微信: ["微信", "wechat", "weixin"],
  feishu: ["飞书", "feishu", "lark", "larksuite"],
  lark: ["飞书", "feishu", "lark", "larksuite"],
  qq: ["qq", "腾讯qq", "qq聊天"],
  visualstudiocode: ["vs code", "vscode", "code", "代码编辑器", "visual studio code"],
  code: ["vs code", "vscode", "code", "代码编辑器", "visual studio code"],
  chrome: ["chrome", "google chrome", "谷歌", "谷歌浏览器"],
  googlechrome: ["chrome", "google chrome", "谷歌", "谷歌浏览器"],
  edge: ["edge", "microsoft edge", "微软浏览器"],
  microsoftedge: ["edge", "microsoft edge", "微软浏览器"],
  firefox: ["firefox", "mozilla firefox", "火狐"],
  word: ["word", "microsoft word", "微软word"],
  microsoftword: ["word", "microsoft word", "微软word"],
  excel: ["excel", "microsoft excel", "微软excel"],
  microsoftexcel: ["excel", "microsoft excel", "微软excel"],
  powerpoint: ["powerpoint", "ppt", "microsoft powerpoint", "微软ppt"],
  steam: ["steam"],
  discord: ["discord"],
  bilibili: ["哔哩哔哩", "bilibili", "b站", "b 站"],
  哔哩哔哩: ["哔哩哔哩", "bilibili", "b站", "b 站"],
  douyin: ["抖音", "douyin", "tiktok"],
  抖音: ["抖音", "douyin", "tiktok"],
  jianying: ["剪映", "jianying", "capcut"],
  capcut: ["剪映", "jianying", "capcut"],
  telegram: ["telegram", "电报"],
  dingtalk: ["钉钉", "dingtalk"],
  notion: ["notion"],
  cursor: ["cursor", "光标编辑器"],
};

const SYSTEM_APPS: AppLaunchTarget[] = [
  { kind: "system", displayName: "计算器", command: "calc.exe", aliases: ["计算器", "calc", "calculator"] },
  { kind: "system", displayName: "记事本", command: "notepad.exe", aliases: ["记事本", "notepad"] },
  { kind: "system", displayName: "文件资源管理器", command: "explorer.exe", aliases: ["文件资源管理器", "资源管理器", "explorer"] },
  { kind: "system", displayName: "命令提示符", command: "cmd.exe", aliases: ["cmd", "命令提示符"] },
  { kind: "system", displayName: "PowerShell", command: "powershell.exe", aliases: ["powershell", "power shell"] },
];

let cachedIndex: IndexedTarget[] = [];
let cacheBuiltAt = 0;
let buildInFlight: Promise<IndexedTarget[]> | null = null;

export function normalizeWindowsAppName(name: string): string {
  return name
    .toLocaleLowerCase("zh-CN")
    .replace(/\.exe$/i, "")
    .replace(/[\s\-_.·'"“”‘’（）()【】\[\]{}]/g, "");
}

function aliasesFor(displayName: string, extra: string[] = []): string[] {
  const aliases = new Set<string>([displayName, ...extra]);
  const keys = new Set([...aliases].map(normalizeWindowsAppName));
  for (const [canonical, values] of Object.entries(APP_ALIASES)) {
    const group = [canonical, ...values];
    if (group.some((value) => keys.has(normalizeWindowsAppName(value)))) {
      for (const value of group) aliases.add(value);
    }
  }
  return [...aliases];
}

function makeIndexed(target: AppLaunchTarget): IndexedTarget {
  return {
    target,
    displayKey: normalizeWindowsAppName(target.displayName),
    aliasKeys: [...new Set(target.aliases.map(normalizeWindowsAppName).filter(Boolean))],
  };
}

function addTarget(index: IndexedTarget[], seen: Set<string>, target: AppLaunchTarget): void {
  const identity = target.kind === "uwp"
    ? `${target.kind}:${target.appUserModelId}`
    : target.kind === "system"
      ? `${target.kind}:${target.command}`
      : `${target.kind}:${target.filePath}`;
  if (seen.has(identity)) return;
  seen.add(identity);
  index.push(makeIndexed(target));
}

function walkExecutables(directory: string, depth: number, index: IndexedTarget[], seen: Set<string>): void {
  if (depth > MAX_PROGRAM_SCAN_DEPTH || !directory || !fs.existsSync(directory)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkExecutables(fullPath, depth + 1, index, seen);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".exe")) continue;
    const displayName = path.basename(entry.name, ".exe");
    addTarget(index, seen, {
      kind: "exe",
      displayName,
      filePath: fullPath,
      aliases: aliasesFor(displayName),
    });
  }
}

function writeTempScript(script: string): string {
  const tmpFile = path.join(os.tmpdir(), `daisy-app-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(tmpFile, script, "utf-8");
  return tmpFile;
}

async function runPowerShellJson<T>(script: string): Promise<T[]> {
  const tmpFile = writeTempScript(script);
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tmpFile],
      { timeout: 20_000, maxBuffer: 1024 * 1024 * 8, windowsHide: true },
    );
    const output = (stdout ?? "").trim();
    if (!output) return [];
    const parsed: unknown = JSON.parse(output);
    return Array.isArray(parsed) ? parsed as T[] : [parsed as T];
  } catch {
    return [];
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function discoverStartMenuShortcuts(): Promise<ShortcutRecord[]> {
  const roots = [
    path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(process.env.ProgramData || "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
  ].filter(Boolean);
  const script = `
$roots = @(${roots.map(psLiteral).join(",")})
$wsh = New-Object -ComObject WScript.Shell
$rows = @()
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $shortcut = $wsh.CreateShortcut($_.FullName)
      if ($shortcut.TargetPath -and (Test-Path -LiteralPath $shortcut.TargetPath)) {
        $rows += [pscustomobject]@{
          DisplayName = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
          ShortcutPath = $_.FullName
          TargetPath = [string]$shortcut.TargetPath
        }
      }
    } catch {}
  }
}
if ($rows.Count -gt 0) { $rows | ConvertTo-Json -Compress -Depth 3 }
`;
  return runPowerShellJson<ShortcutRecord>(script);
}

async function discoverAppPaths(): Promise<AppPathRecord[]> {
  const script = `
$roots = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths'
)
$rows = @()
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $value = $_.GetValue('')
      if ($value) {
        $rows += [pscustomobject]@{ Name = $_.PSChildName; Command = [string]$value }
      }
    } catch {}
  }
}
if ($rows.Count -gt 0) { $rows | ConvertTo-Json -Compress -Depth 3 }
`;
  return runPowerShellJson<AppPathRecord>(script);
}

async function discoverUwpApps(): Promise<StartAppRecord[]> {
  return runPowerShellJson<StartAppRecord>(`
$apps = Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.AppID }
if ($apps) { $apps | Select-Object Name, AppID | ConvertTo-Json -Compress -Depth 3 }
`);
}

function appPathToExecutable(command: string | undefined): string | null {
  const value = command?.trim();
  if (!value) return null;
  const quoted = value.match(/^"([^"]+\.exe)"/i)?.[1];
  const unquoted = value.match(/^([^\r\n]+?\.exe)(?:\s|$)/i)?.[1];
  const candidate = (quoted ?? unquoted ?? value).trim();
  return fs.existsSync(candidate) ? candidate : null;
}

async function buildWindowsAppIndex(): Promise<IndexedTarget[]> {
  const index: IndexedTarget[] = [];
  const seen = new Set<string>();

  const programDirectories = [
    path.join(process.env.LOCALAPPDATA || "", "Programs"),
    process.env.ProgramFiles || "C:\\Program Files",
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
  ].filter(Boolean);
  for (const directory of programDirectories) {
    walkExecutables(directory, 0, index, seen);
  }

  const [shortcuts, appPaths, uwpApps] = await Promise.all([
    discoverStartMenuShortcuts(),
    discoverAppPaths(),
    discoverUwpApps(),
  ]);

  for (const shortcut of shortcuts) {
    const filePath = shortcut.ShortcutPath?.trim();
    const displayName = shortcut.DisplayName?.trim();
    if (!filePath || !displayName || !fs.existsSync(filePath)) continue;
    addTarget(index, seen, {
      kind: "shortcut",
      displayName,
      filePath,
      aliases: aliasesFor(displayName, shortcut.TargetPath ? [path.basename(shortcut.TargetPath, path.extname(shortcut.TargetPath))] : []),
    });
  }

  for (const appPath of appPaths) {
    const filePath = appPathToExecutable(appPath.Command);
    if (!filePath) continue;
    const displayName = (appPath.Name || path.basename(filePath, ".exe")).replace(/\.exe$/i, "");
    addTarget(index, seen, {
      kind: "exe",
      displayName,
      filePath,
      aliases: aliasesFor(displayName, [path.basename(filePath, ".exe")]),
    });
  }

  for (const app of uwpApps) {
    const displayName = app.Name?.trim();
    const appUserModelId = (app.AppID || app.AppId || "").trim();
    if (!displayName || !appUserModelId) continue;
    addTarget(index, seen, {
      kind: "uwp",
      displayName,
      appUserModelId,
      aliases: aliasesFor(displayName),
    });
  }

  return index;
}

async function getWindowsAppIndex(forceRefresh = false): Promise<IndexedTarget[]> {
  const now = Date.now();
  if (!forceRefresh && cachedIndex.length > 0 && now - cacheBuiltAt < CACHE_TTL_MS) {
    return cachedIndex;
  }
  if (buildInFlight) return buildInFlight;

  buildInFlight = buildWindowsAppIndex()
    .then((index) => {
      cachedIndex = index;
      cacheBuiltAt = Date.now();
      return index;
    })
    .finally(() => {
      buildInFlight = null;
    });
  return buildInFlight;
}

function findInIndex(input: string, index: IndexedTarget[]): ResolveResult | null {
  const key = normalizeWindowsAppName(input);
  if (!key) return null;

  const alias = index.find((entry) => entry.aliasKeys.includes(key));
  if (alias) return { found: true, target: alias.target, match: "alias" };

  const exact = index.find((entry) => entry.displayKey === key);
  if (exact) return { found: true, target: exact.target, match: "exact" };

  if (key.length < 3) return null;
  const nameFuzzy = index.find((entry) => {
    if (entry.displayKey.length < 3) return false;
    if (!entry.displayKey.includes(key) && !key.includes(entry.displayKey)) return false;
    return Math.min(key.length, entry.displayKey.length) / Math.max(key.length, entry.displayKey.length) >= 0.45;
  });
  if (nameFuzzy) return { found: true, target: nameFuzzy.target, match: "fuzzy" };

  const aliasFuzzy = index.find((entry) => entry.aliasKeys.some((aliasKey) =>
    aliasKey.length >= 3
    && Math.abs(aliasKey.length - key.length) <= 2
    && (aliasKey.includes(key) || key.includes(aliasKey))
  ));
  return aliasFuzzy ? { found: true, target: aliasFuzzy.target, match: "fuzzy" } : null;
}

function findSystemApp(input: string): ResolveResult | null {
  const key = normalizeWindowsAppName(input);
  const target = SYSTEM_APPS.find((candidate) => candidate.aliases.some((alias) => normalizeWindowsAppName(alias) === key));
  return target ? { found: true, target, match: "system" } : null;
}

/** Pure matcher used by the unit test without inspecting or launching the host. */
export function matchWindowsAppTargets(input: string, targets: AppLaunchTarget[]): ResolveResult {
  return findInIndex(input, targets.map(makeIndexed)) ?? findSystemApp(input) ?? { found: false, reason: "not-found" };
}

export async function resolveWindowsApp(input: string, options: { forceRefresh?: boolean } = {}): Promise<ResolveResult> {
  const index = await getWindowsAppIndex(options.forceRefresh === true);
  return findInIndex(input, index) ?? findSystemApp(input) ?? { found: false, reason: "not-found" };
}

function processImageNameForTarget(target: AppLaunchTarget): string | null {
  if (target.kind === "exe") return path.basename(target.filePath);
  if (target.kind === "system") return path.basename(target.command);
  // A .lnk may launch a target with arguments or a protocol handler.  Do not
  // guess an image name here: diagnostics must remain read-only and precise.
  return null;
}

async function isProcessRunning(imageName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "tasklist.exe",
      ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"],
      { timeout: 5000, windowsHide: true },
    );
    return stdout.toLocaleLowerCase("en-US").includes(imageName.toLocaleLowerCase("en-US"));
  } catch {
    return false;
  }
}

async function getRecentApplicationFailures(imageName: string | null): Promise<Array<{ time: string; provider: string; id: number }>> {
  if (!imageName) return [];
  const script = `
$ErrorActionPreference = 'Stop'
$imageName = ${psLiteral(imageName)}
$providers = @('Application Error', 'Application Hang', 'Windows Error Reporting', 'SideBySide')
$events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = (Get-Date).AddDays(-7) } -MaxEvents 1000 |
  Where-Object { $providers -contains $_.ProviderName -and $_.Message -like "*$imageName*" } |
  Select-Object -First 3)
if ($events.Count -gt 0) {
  $events | ForEach-Object {
    [PSCustomObject]@{
      time = $_.TimeCreated.ToUniversalTime().ToString('o')
      provider = $_.ProviderName
      id = [int]$_.Id
    }
  } | ConvertTo-Json -Compress
}
`;
  return await runPowerShellJson<{ time?: string; provider?: string; id?: number }>(script)
    .then((events) => events
      .filter((event) => Boolean(event.time && event.provider && Number.isFinite(event.id)))
      .map((event) => ({ time: String(event.time), provider: String(event.provider), id: Number(event.id) })));
}

/**
 * Inspect an application without launching it.  This is deliberately kept
 * separate from resolveAndLaunchWindowsApp so a question such as “为什么微信
 * 打不开” can never turn into an unrequested launch attempt.
 */
export async function diagnoseWindowsApp(input: string): Promise<WindowsAppDiagnosis> {
  const resolved = await resolveWindowsApp(input);
  if (!resolved.found) return { found: false, recentFailures: [] };

  const { target } = resolved;
  const launchTargetExists = target.kind === "exe" || target.kind === "shortcut"
    ? fs.existsSync(target.filePath)
    : true;
  const processImageName = processImageNameForTarget(target);
  const [running, recentFailures] = await Promise.all([
    processImageName ? isProcessRunning(processImageName) : Promise.resolve(false),
    getRecentApplicationFailures(processImageName),
  ]);

  return {
    found: true,
    target,
    match: resolved.match,
    launchTargetExists,
    processImageName: processImageName || undefined,
    running,
    recentFailures,
  };
}

export function invalidateWindowsAppCache(): void {
  cachedIndex = [];
  cacheBuiltAt = 0;
}

export async function warmWindowsAppIndex(): Promise<number> {
  return (await getWindowsAppIndex()).length;
}

function spawnDetached(file: string, args: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function startShortcut(filePath: string): Promise<void> {
  const script = `Start-Process -FilePath ${psLiteral(filePath)} -ErrorAction Stop`;
  const tmpFile = writeTempScript(script);
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tmpFile],
      { timeout: 8000, windowsHide: true },
    );
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

export async function launchResolvedApp(target: AppLaunchTarget): Promise<void> {
  if (target.kind === "exe") {
    if (!fs.existsSync(target.filePath)) throw new Error("应用文件已不存在");
    await spawnDetached(target.filePath, target.args);
    return;
  }
  if (target.kind === "shortcut") {
    if (!fs.existsSync(target.filePath)) throw new Error("应用快捷方式已不存在");
    await startShortcut(target.filePath);
    return;
  }
  if (target.kind === "uwp") {
    await spawnDetached("explorer.exe", [`shell:AppsFolder\\${target.appUserModelId}`]);
    return;
  }
  await spawnDetached(target.command, target.args);
}

/** Resolve first, launch second. A failed launch invalidates the cache and retries once. */
export async function resolveAndLaunchWindowsApp(input: string): Promise<LaunchResult> {
  let resolved = await resolveWindowsApp(input);
  if (!resolved.found) return { found: false, launched: false, reason: "not-found" };

  try {
    await launchResolvedApp(resolved.target);
    return { found: true, launched: true, target: resolved.target, match: resolved.match };
  } catch {
    invalidateWindowsAppCache();
  }

  resolved = await resolveWindowsApp(input, { forceRefresh: true });
  if (!resolved.found) return { found: false, launched: false, reason: "not-found" };
  try {
    await launchResolvedApp(resolved.target);
    return { found: true, launched: true, target: resolved.target, match: resolved.match };
  } catch {
    return { found: true, launched: false, target: resolved.target, match: resolved.match, reason: "launch-failed" };
  }
}
