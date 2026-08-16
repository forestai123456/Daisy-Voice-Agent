import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "../utils/logger";

const execFileAsync = promisify(execFile);
const FIELD_SEPARATOR = "\u001f";
const FINDER_SELECTION_TIMEOUT_MS = 800;
export const FINDER_SELECTION_CONTEXT_MARKER = "【Daisy 本次选中项】";

export interface FinderSelectionItem {
  path: string;
  name: string;
}

export type FinderSelectionStatus = "ok" | "empty" | "not-file-manager" | "access-denied" | "unavailable";

export interface FinderSelectionResult {
  status: FinderSelectionStatus;
  items: FinderSelectionItem[];
  error?: string;
}

/**
 * This script deliberately has no user-provided interpolation. It returns
 * POSIX paths only, separated by a control character that macOS filenames
 * cannot normally contain.
 */
const FINDER_SELECTION_SCRIPT = `
tell application "Finder"
  set selectedItems to selection
  if (count of selectedItems) is 0 then return ""

  set selectedPaths to {}
  repeat with selectedItem in selectedItems
    try
      set end of selectedPaths to POSIX path of (selectedItem as alias)
    end try
  end repeat

  set AppleScript's text item delimiters to ASCII character 31
  return selectedPaths as text
end tell
`;

function getErrorText(error: unknown): string {
  if (error instanceof Error) {
    const withStderr = error as Error & { stderr?: string | Buffer };
    const stderr = withStderr.stderr ? String(withStderr.stderr).trim() : "";
    return [error.message, stderr].filter(Boolean).join(" | ");
  }
  return String(error);
}

function isAutomationDenied(errorText: string): boolean {
  return /-1743|not authorized to send apple events|not permitted to send apple events|不允许.*发送.*Apple 事件/i.test(errorText);
}

export function isSelectedFinderItemReference(text: string): boolean {
  const normalized = text.replace(/\s+/g, "");
  // 只有明确说到“选中的 + 文件类型”时才读取 Finder 选择，避免日常
  // 对话里的“这个文件”被误当成系统级文件操作。
  const hasSelectionMarker = /(?:当前)?选中(?:的)?/.test(normalized);
  const hasItemType = /(文件|文档|图片|照片|文件夹|目录|项目|资料|PPT|PDF|表格|Excel|Word|代码|脚本|压缩包|视频|音频)/i.test(normalized);
  return hasSelectionMarker && hasItemType;
}

export function allowsMultipleSelectedFinderItems(text: string): boolean {
  const normalized = text.replace(/\s+/g, "");
  return /这几个|这些|全部(?:的)?|所有(?:的)?|多个|几(?:个|份)|这批|批量/.test(normalized);
}

export function formatFinderSelectionContext(items: FinderSelectionItem[]): string {
  const metadata = JSON.stringify(items.map((item) => ({ path: item.path, name: item.name })));
  return [
    "",
    FINDER_SELECTION_CONTEXT_MARKER,
    metadata,
  ].join("\n");
}

/**
 * Finder 选中项只为当前一次模型调用补充目标路径，绝不能进入后续对话历史。
 * 上下文始终由 formatFinderSelectionContext() 追加在消息末尾，因此只移除标记
 * 及其后的内容，不影响用户的原始指令或可能附带的剪贴板文本。
 */
export function stripFinderSelectionContext(text: string): string {
  const markerIndex = text.indexOf(FINDER_SELECTION_CONTEXT_MARKER);
  return markerIndex === -1 ? text : text.slice(0, markerIndex).trimEnd();
}

// ============================================================================
// Windows: read the live selection of the foreground File Explorer window.
//
// A fresh `powershell.exe -STA` spawn costs ~2.5s+ on this machine, which
// would drag the voice response even though the capture starts speculatively
// on the first ASR partial. To stay within the ~1.5s budget, one long-lived
// STA PowerShell process is warmed at startup; each capture is then a single
// stdin "go" -> stdout RESULT_BEGIN/RESULT_END round trip (~200ms).
//
// The COM call only reads the foreground window's selection; it never injects
// user speech, filenames, or paths, and it returns the previous selection only
// if the same Explorer window is still foreground (it never falls back to a
// stale window).
// ============================================================================

const EXPLORER_SELECTION_TIMEOUT_MS = 1500;

const EXPLORER_SELECTION_PS = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class WinFW{
  [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
  [DllImport("user32.dll",CharSet=CharSet.Auto)]public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll",CharSet=CharSet.Auto)]public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindow(string c, IntPtr w);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, IntPtr w);
}
"@
Add-Type -AssemblyName Accessibility
Add-Type -ReferencedAssemblies Accessibility -TypeDefinition @"
using System;using System.Runtime.InteropServices;using Accessibility;using System.Collections.Generic;
public static class DesktopAcc{
  public const uint OBJID_CLIENT = 0xFFFFFFFC;
  public const int STATE_SELECTED = 0x00000002;
  [DllImport("oleacc.dll")]public static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint dwId, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IAccessible ppv);
  // Strongly-typed IAccessible calls in C# avoid PowerShell's late-binding
  // failure for the parameterized get_accState/get_accName methods.
  public static string[] GetSelectedNames(IntPtr lvHwnd){
    IAccessible ia; Guid iid=new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
    int hr=AccessibleObjectFromWindow(lvHwnd,OBJID_CLIENT,ref iid,out ia);
    if(hr!=0||ia==null) return null;
    int count=ia.accChildCount; var names=new List<string>();
    for(int cid=1;cid<=count;cid++){
      try{
        object so=ia.get_accState(cid);
        int s=(so==null)?0:(int)so;
        if((s&STATE_SELECTED)!=0){ string n=ia.get_accName(cid); if(!string.IsNullOrEmpty(n)) names.Add(n); }
      }catch{}
    }
    return names.ToArray();
  }
  public static int GetChildCount(IntPtr lvHwnd){
    IAccessible ia; Guid iid=new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
    int hr=AccessibleObjectFromWindow(lvHwnd,OBJID_CLIENT,ref iid,out ia);
    if(hr!=0||ia==null) return -1;
    return ia.accChildCount;
  }
}
"@
$shell=New-Object -ComObject Shell.Application
$debugOn = $env:DAISY_DEBUG_SELECTION -eq '1'
$IID_IAccessible=[Guid]"618736e0-3c3d-11cf-810c-00aa00389b71"
function GetTitle($h){ $sb=New-Object System.Text.StringBuilder(256); [void][WinFW]::GetWindowText($h,$sb,256); return $sb.ToString() }
function GetClass($h){ $sb=New-Object System.Text.StringBuilder(256); [void][WinFW]::GetClassName($h,$sb,256); return $sb.ToString() }

# Locate the desktop icon ListView (Progman/WorkerW -> SHELLDLL_DefView -> SysListView32)
# via Win32 API, not UI Automation.
function FindDesktopListView(){
  $z=[IntPtr]::Zero
  $progman=[WinFW]::FindWindow('Progman',$z)
  if($progman -ne [IntPtr]::Zero){
    $dv=[WinFW]::FindWindowEx($progman,$z,'SHELLDLL_DefView',$z)
    if($dv -ne [IntPtr]::Zero){
      $lv=[WinFW]::FindWindowEx($dv,$z,'SysListView32',$z)
      if($lv -ne [IntPtr]::Zero){ return $lv }
    }
  }
  $prev=[IntPtr]::Zero
  while($true){
    $w=[WinFW]::FindWindowEx([IntPtr]::Zero,$prev,'WorkerW',$z)
    if($w -eq [IntPtr]::Zero){ break }
    $dv=[WinFW]::FindWindowEx($w,$z,'SHELLDLL_DefView',$z)
    if($dv -ne [IntPtr]::Zero){
      $lv=[WinFW]::FindWindowEx($dv,$z,'SysListView32',$z)
      if($lv -ne [IntPtr]::Zero){ return $lv }
    }
    $prev=$w
  }
  return [IntPtr]::Zero
}

function ReadDesktopSelection(){
  $lvHwnd=FindDesktopListView
  if($lvHwnd -eq [IntPtr]::Zero){ return @{ ok=$false; info='no desktop SysListView32' } }
  $childCount=[DesktopAcc]::GetChildCount($lvHwnd)
  $names=[DesktopAcc]::GetSelectedNames($lvHwnd)
  if($null -eq $names){ return @{ ok=$false; info=('AccessibleObjectFromWindow failed childCount='+$childCount); lv=$lvHwnd } }
  if($names.Count -eq 0){ return @{ ok=$true; items=@(); method='DesktopAcc.GetSelectedNames'; itemCount=$childCount; lv=$lvHwnd } }
  $desktop=$shell.NameSpace(0)
  if(-not $desktop){ return @{ ok=$false; info='NameSpace(0) unavailable' } }
  $nameToItem=@{}
  $nameCount=@{}
  foreach($fi in $desktop.Items()){
    $n=$fi.Name
    if($nameCount.ContainsKey($n)){ $nameCount[$n]++ } else { $nameCount[$n]=1; $nameToItem[$n]=$fi }
  }
  $items=@()
  $ambiguousNames=@()
  foreach($n in $names){
    if(-not $nameToItem.ContainsKey($n)){ continue }
    if($nameCount[$n] -gt 1){ $ambiguousNames += $n }
    $fi=$nameToItem[$n]
    $items += [PSCustomObject]@{path=$fi.Path; name=$fi.Name}
  }
  $warn = if($ambiguousNames.Count -gt 0){ ' ambiguousPickedFirst='+($ambiguousNames -join ',') } else { '' }
  return @{ ok=$true; items=$items; method='DesktopAcc.GetSelectedNames'; itemCount=$childCount; lv=$lvHwnd; warn=$warn }
}

while($true){
  $line=[Console]::In.ReadLine()
  if($null -eq $line){break}
  $src='unavailable'; $items=@(); $cls=''; $title=''; $err=''; $fgRoot=[IntPtr]::Zero; $deskInfo=''
  try{
    $fg=[WinFW]::GetForegroundWindow()
    $fgRoot=[WinFW]::GetAncestor($fg,2)
    if($fgRoot -eq [IntPtr]::Zero){$fgRoot=$fg}
    $cls=GetClass $fgRoot
    if($cls -eq 'CabinetWClass'){
      $src='explorer'
      $fgInt=[long]$fgRoot.ToInt64()
      $found=$false
      foreach($w in $shell.Windows()){
        try{
          $wRoot=[WinFW]::GetAncestor([IntPtr]$w.HWND,2)
          if([long]$wRoot.ToInt64() -eq $fgInt){
            $found=$true
            $sel=$w.Document.SelectedItems()
            foreach($item in $sel){$items += [PSCustomObject]@{path=$item.Path;name=$item.Name}}
            break
          }
        }catch{continue}
      }
      if(-not $found){ $src='none'; $title=GetTitle $fgRoot }
    }elseif($cls -eq 'Progman' -or $cls -eq 'WorkerW'){
      $src='desktop'
      $d=ReadDesktopSelection
      if(-not $d -or -not $d.ok){ $src='unavailable'; $err=('desktop: '+($d.info)) }
      else {
        $items=@($d.items)
        $deskInfo=('method='+$d.method+' itemCount='+$d.itemCount + $d.warn)
      }
    }else{
      $src='none'; $title=GetTitle $fgRoot
    }
  }catch{
    $src='unavailable'; $err=$_.Exception.Message
  }
  $obj=[PSCustomObject]@{ source=$src; items=$items }
  if($src -eq 'none'){ $obj | Add-Member -NotePropertyName class -NotePropertyValue $cls; $obj | Add-Member -NotePropertyName title -NotePropertyValue $title }
  if($src -eq 'unavailable' -and $err){ $obj | Add-Member -NotePropertyName error -NotePropertyValue $err }
  if($src -eq 'desktop' -and $deskInfo){ $obj | Add-Member -NotePropertyName desktopInfo -NotePropertyValue $deskInfo }
  if($debugOn -and $fgRoot -ne [IntPtr]::Zero){
    $winSummary=@()
    foreach($w in $shell.Windows()){ try{ $winSummary += [PSCustomObject]@{hwnd=$w.HWND; title=$w.LocationName} }catch{} }
    $obj | Add-Member -NotePropertyName debug -NotePropertyValue ([PSCustomObject]@{ hwnd=([long]$fgRoot.ToInt64()); class=$cls; title=(GetTitle $fgRoot); windows=$winSummary })
  }
  [Console]::Out.WriteLine('RESULT_BEGIN')
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.WriteLine('RESULT_END')
  [Console]::Out.Flush()
}
`;

let explorerProc: ChildProcess | null = null;
let explorerScriptFile: string | null = null;
let pendingResolve: ((value: string) => void) | null = null;
let pendingBuffer = "";
let pendingTimer: NodeJS.Timeout | null = null;

function handleExplorerStdout(chunk: string): void {
  pendingBuffer += chunk;
  const endIdx = pendingBuffer.indexOf("RESULT_END");
  if (endIdx < 0 || !pendingResolve) return;
  const beginIdx = pendingBuffer.indexOf("RESULT_BEGIN");
  const start = beginIdx >= 0 ? beginIdx + "RESULT_BEGIN".length : 0;
  const content = pendingBuffer.slice(start, endIdx).replace(/^[\r\n]+|[\r\n]+$/g, "");
  pendingBuffer = pendingBuffer.slice(endIdx + "RESULT_END".length);
  const resolve = pendingResolve;
  pendingResolve = null;
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  resolve(content);
}

function ensureExplorerProcess(): ChildProcess | null {
  if (explorerProc && !explorerProc.killed && explorerProc.exitCode === null && explorerProc.stdin && !explorerProc.stdin.destroyed) {
    return explorerProc;
  }
  try {
    const tmpFile = path.join(os.tmpdir(), `daisy-explorer-${Date.now()}.ps1`);
    fs.writeFileSync(tmpFile, EXPLORER_SELECTION_PS, "utf-8");
    explorerScriptFile = tmpFile;
    const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", tmpFile], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", handleExplorerStdout);
    proc.on("error", () => { explorerProc = null; });
    proc.on("exit", () => {
      explorerProc = null;
      if (explorerScriptFile) { try { fs.unlinkSync(explorerScriptFile); } catch { /* ignore */ } explorerScriptFile = null; }
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
        resolve("UNAVAILABLE");
      }
    });
    explorerProc = proc;
    return proc;
  } catch {
    explorerProc = null;
    return null;
  }
}

/** Pre-warm the Windows Explorer selection reader so the first capture is fast. */
export function warmupExplorerSelection(): void {
  if (process.platform === "win32") ensureExplorerProcess();
}

function readExplorerSelection(): Promise<string> {
  return new Promise((resolve) => {
    const proc = ensureExplorerProcess();
    if (!proc || !proc.stdin || proc.stdin.destroyed) { resolve("UNAVAILABLE"); return; }
    if (pendingResolve) { resolve("UNAVAILABLE"); return; }
    pendingResolve = resolve;
    pendingBuffer = "";
    pendingTimer = setTimeout(() => {
      pendingResolve = null;
      resolve("UNAVAILABLE");
    }, EXPLORER_SELECTION_TIMEOUT_MS);
    try {
      proc.stdin.write("go\n");
    } catch {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      pendingResolve = null;
      resolve("UNAVAILABLE");
    }
  });
}

export async function getSelectedFinderItems(): Promise<FinderSelectionResult> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync(
        "/usr/bin/osascript",
        ["-e", FINDER_SELECTION_SCRIPT],
        {
          timeout: FINDER_SELECTION_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        },
      );

      const paths = stdout
        .replace(/\r?\n$/, "")
        .split(FIELD_SEPARATOR)
        .filter((candidate) => candidate.startsWith("/"));

      if (paths.length === 0) {
        return { status: "empty", items: [] };
      }

      return {
        status: "ok",
        items: paths.map((selectedPath) => ({
          path: selectedPath,
          name: path.basename(selectedPath) || selectedPath,
        })),
      };
    } catch (error) {
      const errorText = getErrorText(error);
      return {
        status: isAutomationDenied(errorText) ? "access-denied" : "unavailable",
        items: [],
        error: errorText,
      };
    }
  }

  // Windows: foreground File Explorer OR Windows desktop selection via a warm
  // STA PowerShell + Shell.Application COM (+ UI Automation for the desktop).
  // Only the foreground window is consulted; nothing is cached across calls.
  try {
    const content = await readExplorerSelection();
    let parsed: { source?: unknown; items?: unknown; class?: unknown; title?: unknown; error?: unknown; debug?: unknown; desktopInfo?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      return { status: "unavailable", items: [], error: "invalid selection JSON" };
    }
    const source = String(parsed.source || "unavailable");
    if (source === "explorer" || source === "desktop") {
      const arr = Array.isArray(parsed.items) ? parsed.items : [];
      const items: FinderSelectionItem[] = [];
      for (const entry of arr) {
        const p = String((entry as { path?: unknown })?.path || "");
        if (!p) continue;
        const name = String((entry as { name?: unknown })?.name || path.basename(p) || p);
        items.push({ path: p, name });
      }
      log(`[finderSelection] source=${source} items=${items.length}`);
      if (parsed.desktopInfo) log(`[finderSelection] desktopInfo=${String(parsed.desktopInfo)}`);
      if (parsed.debug) log(`[finderSelection] debug=${JSON.stringify(parsed.debug)}`);
      if (items.length === 0) return { status: "empty", items: [] };
      return { status: "ok", items };
    }
    if (source === "none") {
      const cls = String(parsed.class || "");
      const title = String(parsed.title || "");
      log(`[finderSelection] source=none foregroundClass=${cls} title="${title}"`);
      if (parsed.debug) log(`[finderSelection] debug=${JSON.stringify(parsed.debug)}`);
      return { status: "not-file-manager", items: [] };
    }
    log(`[finderSelection] source=unavailable error=${String(parsed.error || "")}`);
    if (parsed.debug) log(`[finderSelection] debug=${JSON.stringify(parsed.debug)}`);
    return { status: "unavailable", items: [], error: String(parsed.error || "selection read failed") };
  } catch (error) {
    return { status: "unavailable", items: [], error: getErrorText(error) };
  }
}
