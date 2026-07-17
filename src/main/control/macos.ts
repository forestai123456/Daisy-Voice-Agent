import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BrowserWindow } from "electron";
import ffmpegStaticPath from "ffmpeg-static";
import { log, logError } from "../utils/logger";
import { matchApp } from "../command/router";
import { getBundledBin, config } from "../config/env";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function getFfmpegPath(): string {
  if (!ffmpegStaticPath) return "ffmpeg";
  if (ffmpegStaticPath.includes(".asar")) {
    const unpacked = ffmpegStaticPath.replace(".asar", ".asar.unpacked");
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return ffmpegStaticPath;
}

function resolveOutputPath(sourcePath: string, output: string | undefined, defaultName: string): string {
  if (!output) return path.join(path.dirname(sourcePath), defaultName);
  const expanded = expandPath(output);
  return path.isAbsolute(expanded) ? expanded : path.join(path.dirname(sourcePath), expanded);
}

function expandPath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export async function runAppleScript(script: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    return stdout.trim();
  } catch (error) {
    throw new Error(`AppleScript 执行失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function getDefaultBrowserBundleId(): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers | grep -B 1 -A 2 "http" | grep LSHandlerRoleAll | head -n 1 | awk -F'"' '{print $2}'`
    );
    const trimmed = stdout.trim();
    return trimmed || "com.apple.Safari";
  } catch {
    return "com.apple.Safari";
  }
}

export async function openApplication(name: string): Promise<string> {
  let target = name;
  let useBundleId = false;

  const isBrowserKeyword = ["browser", "默认浏览器", "浏览器", "default_browser", "default browser"].includes(name.trim().toLowerCase());
  
  if (isBrowserKeyword) {
    target = await getDefaultBrowserBundleId();
    useBundleId = true;
  } else {
    const matched = matchApp(name);
    if (matched) {
      target = matched.name;
    }
  }

  try {
    if (useBundleId) {
      await execAsync(`open -b "${target}"`);
      return `已打开默认浏览器`;
    } else {
      await runAppleScript(`tell application "${target}" to activate`);
      return `已打开 ${target}`;
    }
  } catch {
    try {
      if (useBundleId) {
        await execAsync(`open -b com.apple.Safari`);
        return `已打开默认浏览器`;
      } else {
        await execAsync(`open -a "${target}"`);
        return `已打开 ${target}`;
      }
    } catch (error) {
      return `无法打开 ${name}，请检查应用名称是否正确`;
    }
  }
}

export async function quitApplication(name: string): Promise<string> {
  try {
    let targetName = name;
    const isBrowserKeyword = ["browser", "默认浏览器", "浏览器", "default_browser", "default browser"].includes(name.trim().toLowerCase());

    if (isBrowserKeyword) {
      const bundleId = await getDefaultBrowserBundleId();
      if (bundleId.includes("chrome")) {
        targetName = "Google Chrome";
      } else if (bundleId.includes("safari")) {
        targetName = "Safari";
      } else {
        try {
          const { stdout } = await execAsync(`osascript -e 'tell application "Finder" to name of application file id "${bundleId}"'`);
          const resolvedName = stdout.trim().replace(/\.app$/, "");
          if (resolvedName) targetName = resolvedName;
        } catch {
          targetName = "Safari";
        }
      }
    } else {
      const matched = matchApp(name);
      if (matched) {
        targetName = matched.name;
      }
    }

    log(`quitApplication: resolved "${name}" -> "${targetName}"`);

    const checkScript = `tell application "System Events" to exists process "${targetName}"`;
    const beforeCheck = await runAppleScript(checkScript).catch(() => "false");
    if (beforeCheck.trim() === "false") {
      log(`quitApplication: process "${targetName}" is not running`);
      return `已关闭 ${name}`;
    }

    try {
      await execAsync(`osascript -e 'tell application "${targetName}" to quit'`, { timeout: 3000 });
    } catch {
      // Ignore AppleScript error as Electron apps close abruptly and throw connection invalid errors
    }

    await new Promise((resolve) => setTimeout(resolve, 500));

    const afterCheck = await runAppleScript(checkScript).catch(() => "false");
    if (afterCheck.trim() === "false") {
      log(`quitApplication: process "${targetName}" quitted gracefully`);
      return `已关闭 ${name}`;
    }

    try {
      await execAsync(`pkill -x "${targetName}"`, { timeout: 2000 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const finalCheck = await runAppleScript(checkScript).catch(() => "false");
      if (finalCheck.trim() === "false") {
        log(`quitApplication: process "${targetName}" forced killed`);
        return `已关闭 ${name}`;
      }
    } catch {
      // Ignore shell errors
    }

    log(`quitApplication: failed to close process "${targetName}"`);
    return `无法关闭 ${name}，可能该应用有未保存的工作或无法响应`;
  } catch (error) {
    return `关闭 ${name} 失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function quitAllApplications(excludeNames: string[] = []): Promise<string> {
  try {
    const defaultExcludes = ["Finder", "Terminal", "iTerm", "iTerm2", "Diri", "Daisy", "Xcode"];
    const allExcludes = Array.from(new Set([...defaultExcludes, ...excludeNames]));
    const conditions = allExcludes.map(name => `appStr is not "${name}"`).join(" and ");
    
    const script = `
tell application "System Events"
    set appNames to name of every application process whose background only is false
end tell
repeat with appName in appNames
    set appStr to appName as string
    if ${conditions} then
        try
            tell application appStr to quit
        end try
    end if
end repeat
    `;
    
    await runAppleScript(script);
    return "已成功关闭所有其他应用程序";
  } catch (error) {
    return `关闭应用程序失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function typeText(text: string): Promise<string> {
  try {
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await runAppleScript(`tell application "System Events" to keystroke "${escaped}"`);
    return "已输入文字";
  } catch (error) {
    return `输入文字失败: ${error instanceof Error ? error.message : String(error)}。请检查是否已授予辅助功能权限。`;
  }
}

export async function pressKeys(keys: string): Promise<string> {
  try {
    const normalized = keys.toLowerCase().replace(/\s+/g, "");
    const parts = normalized.split("+");
    const mainKey = parts[parts.length - 1];
    const modifiers = parts.slice(0, -1);

    const keyMap: Record<string, string> = {
      command: "command down",
      cmd: "command down",
      option: "option down",
      alt: "option down",
      control: "control down",
      ctrl: "control down",
      shift: "shift down",
      return: "return",
      enter: "return",
      escape: "escape",
      esc: "escape",
      tab: "tab",
      space: "space",
      backspace: "delete",
      delete: "delete",
      up: "key code 126",
      down: "key code 125",
      left: "key code 123",
      right: "key code 124",
    };

    const modifierList = modifiers
      .map((m) => keyMap[m])
      .filter(Boolean)
      .join(", ");

    let script: string;
    if (mainKey in keyMap && keyMap[mainKey].startsWith("key code")) {
      script = `tell application "System Events" to ${keyMap[mainKey]}${modifierList ? ` using {${modifierList}}` : ""}`;
    } else {
      const key = mainKey.length === 1 ? mainKey : mainKey in keyMap ? keyMap[mainKey] : mainKey;
      if (key.startsWith("key code")) {
        script = `tell application "System Events" to ${key}${modifierList ? ` using {${modifierList}}` : ""}`;
      } else {
        script = `tell application "System Events" to keystroke "${key}"${modifierList ? ` using {${modifierList}}` : ""}`;
      }
    }

    await runAppleScript(script);
    return `已发送快捷键 ${keys}`;
  } catch (error) {
    return `发送快捷键失败: ${error instanceof Error ? error.message : String(error)}。请检查是否已授予辅助功能权限。`;
  }
}

export async function getFrontmostApplication(): Promise<string> {
  try {
    const name = await runAppleScript(
      'tell application "System Events" to get name of first application process whose frontmost is true',
    );
    return `当前最前面的应用是：${name}`;
  } catch (error) {
    return `获取当前应用失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function readSelectedText(): Promise<string> {
  try {
    // Save current clipboard (may fail if clipboard has non-text content)
    let originalClipboard = "";
    try {
      originalClipboard = await runAppleScript("get the clipboard as text");
    } catch {
      // Clipboard might contain image or other non-text content
    }

    // Copy selected text
    await runAppleScript('tell application "System Events" to keystroke "c" using command down');

    // Wait a bit for clipboard
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Read clipboard
    let selected = "";
    try {
      selected = await runAppleScript("get the clipboard as text");
    } catch {
      return "没有读取到选中的文字，请确认当前有选中的内容";
    }

    // Restore original clipboard
    if (originalClipboard) {
      try {
        await runAppleScript(`set the clipboard to "${originalClipboard.replace(/"/g, '\\"')}"`);
      } catch {
        // ignore restore failure
      }
    }

    if (!selected || selected === originalClipboard) {
      return "没有读取到选中的文字，请确认当前有选中的内容";
    }

    return `选中的文字是：${selected}`;
  } catch (error) {
    return `读取选中文本失败: ${error instanceof Error ? error.message : String(error)}。请检查是否已授予辅助功能权限。`;
  }
}

export async function getClipboardText(): Promise<string> {
  try {
    const text = await runAppleScript("get the clipboard as text");
    return text.trim() || "剪贴板为空，或不包含文本内容。";
  } catch (error) {
    return `获取剪贴板失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function writeClipboardText(text: string): Promise<string> {
  try {
    const { clipboard } = require("electron");
    clipboard.writeText(text);
    log(`writeClipboardText: successfully wrote ${text.length} characters to clipboard`);
    return `已成功复制到剪贴板。`;
  } catch (error) {
    return `写入剪贴板失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function sendEmail(to: string, subject: string, body: string): Promise<string> {
  const script = `
tell application "Mail"
    try
        set newMessage to make new outgoing message with properties {subject:${JSON.stringify(subject)}, content:${JSON.stringify(body)} & linefeed}
        tell newMessage
            make new to recipient at end of to recipients with properties {address:${JSON.stringify(to)}}
            send
        end tell
        return "SUCCESS"
    on error errMsg
        return errMsg
    end try
end tell
  `;
  try {
    log(`sendEmail: sending to "${to}", subject: "${subject}"`);
    const result = await runAppleScript(script);
    if (result.trim() === "SUCCESS") {
      return `已成功发送邮件给「${to}」，主题：「${subject}」。`;
    } else {
      return `发送邮件失败: ${result}`;
    }
  } catch (error) {
    return `发送邮件出错: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function readUnreadEmails(limit: number = 5): Promise<string> {
  const script = `
tell application "Mail"
    try
        set unreadMessages to (messages of inbox whose read status is false)
        set msgCount to count of unreadMessages
        if msgCount is 0 then
            return "没有未读邮件。"
        end if
        set limitCount to msgCount
        if limitCount > ${limit} then set limitCount to ${limit}
        set results to ""
        -- Loop backwards to get newest unread emails first
        repeat with i from msgCount to (msgCount - limitCount + 1) by -1
            set msg to item i of unreadMessages
            set senderName to sender of msg
            set subj to subject of msg
            set sentDate to (date sent of msg) as string
            set bodyText to content of msg
            if length of bodyText > 120 then
                set bodyText to (characters 1 thru 120 of bodyText) as string
            end if
            set results to results & "邮件 " & ((msgCount - i + 1) as string) & ":\\n  发件人: " & senderName & "\\n  主题: " & subj & "\\n  时间: " & sentDate & "\\n  正文: " & bodyText & "\\n\\n"
        end repeat
        return results
    on error errMsg
        return "读取邮件错误: " & errMsg
    end try
end tell
  `;
  try {
    log(`readUnreadEmails: reading up to ${limit} unread emails`);
    const result = await runAppleScript(script);
    return result;
  } catch (error) {
    return `获取未读邮件出错: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function getRecentEmails(limit: number = 5): Promise<string> {
  const script = `
tell application "Mail"
    try
        set inboxMessages to messages of inbox
        set msgCount to count of inboxMessages
        if msgCount is 0 then
            return "收件箱为空。"
        end if
        set limitCount to msgCount
        if limitCount > ${limit} then set limitCount to ${limit}
        set results to ""
        -- Loop backwards to get newest emails first
        repeat with i from msgCount to (msgCount - limitCount + 1) by -1
            set msg to item i of inboxMessages
            set senderName to sender of msg
            set subj to subject of msg
            set sentDate to (date sent of msg) as string
            set readStatus to (read status of msg)
            set isRead to "已读"
            if readStatus is false then set isRead to "未读"
            set bodyText to content of msg
            if length of bodyText > 120 then
                set bodyText to (characters 1 thru 120 of bodyText) as string
            end if
            set results to results & "邮件 " & ((msgCount - i + 1) as string) & " [" & isRead & "]:\\n  发件人: " & senderName & "\\n  主题: " & subj & "\\n  时间: " & sentDate & "\\n  正文: " & bodyText & "\\n\\n"
        end repeat
        return results
    on error errMsg
        return "获取邮件错误: " & errMsg
    end try
end tell
  `;
  try {
    log(`getRecentEmails: fetching recent ${limit} emails`);
    const result = await runAppleScript(script);
    return result;
  } catch (error) {
    return `获取最新邮件出错: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function searchEmails(query: string, limit: number = 5): Promise<string> {
  const script = `
tell application "Mail"
    try
        set q to ${JSON.stringify(query)}
        set matches to (messages of inbox whose subject contains q or sender contains q or content contains q)
        set msgCount to count of matches
        if msgCount is 0 then
            return "未找到匹配的邮件。"
        end if
        set limitCount to msgCount
        if limitCount > ${limit} then set limitCount to ${limit}
        set results to ""
        -- Loop backwards to get newest matching emails first
        repeat with i from msgCount to (msgCount - limitCount + 1) by -1
            set msg to item i of matches
            set senderName to sender of msg
            set subj to subject of msg
            set sentDate to (date sent of msg) as string
            set readStatus to (read status of msg)
            set isRead to "已读"
            if readStatus is false then set isRead to "未读"
            set bodyText to content of msg
            if length of bodyText > 120 then
                set bodyText to (characters 1 thru 120 of bodyText) as string
            end if
            set results to results & "邮件 " & ((msgCount - i + 1) as string) & " [" & isRead & "]:\\n  发件人: " & senderName & "\\n  主题: " & subj & "\\n  时间: " & sentDate & "\\n  正文: " & bodyText & "\\n\\n"
        end repeat
        return results
    on error errMsg
        return "搜索邮件错误: " & errMsg
    end try
end tell
  `;
  try {
    log(`searchEmails: searching inbox for "${query}" (limit ${limit})`);
    const result = await runAppleScript(script);
    return result;
  } catch (error) {
    return `搜索邮件出错: ${error instanceof Error ? error.message : String(error)}`;
  }
}




export async function getCurrentTime(): Promise<string> {
  const now = new Date();
  const days = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const dayOfWeek = days[now.getDay()];
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const date = now.getDate();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `当前时间是 ${year}年${month}月${date}日 ${dayOfWeek} ${hours}:${minutes}`;
}

export async function readFile(filePath: string): Promise<string> {
  const resolved = expandPath(filePath);
  try {
    const ext = path.extname(resolved).toLowerCase();
    let content: string;
    if (ext === ".docx" || ext === ".doc") {
      const { stdout } = await execAsync(`textutil -convert txt -stdout "${resolved}"`);
      content = stdout;
    } else {
      content = fs.readFileSync(resolved, "utf-8");
    }
    const truncated = content.length > 100000 ? content.slice(0, 100000) + "\n...(内容过长，已截断)" : content;
    return `文件 ${filePath} 的内容：\n${truncated}`;
  } catch (error) {
    return `读取文件失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function writeFile(filePath: string, content: string): Promise<string> {
  const resolved = expandPath(filePath);
  try {
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolved, content, "utf-8");
    return `已写入文件 ${filePath}（${content.length} 字符）`;
  } catch (error) {
    return `写入文件失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function createFile(filePath: string, content: string): Promise<string> {
  const resolved = expandPath(filePath);
  try {
    if (fs.existsSync(resolved)) {
      return `文件 ${filePath} 已存在，未做修改。如需覆盖请明确说明。`;
    }
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolved, content, "utf-8");
    return `已创建文件 ${filePath}`;
  } catch (error) {
    return `创建文件失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function deleteFile(filePath: string): Promise<string> {
  const resolved = expandPath(filePath);
  try {
    if (!fs.existsSync(resolved)) {
      return `文件 ${filePath} 不存在`;
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      fs.rmdirSync(resolved);
    } else {
      fs.unlinkSync(resolved);
    }
    return `已删除 ${filePath}`;
  } catch (error) {
    return `删除文件失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function downloadMedia(url: string, type: string = "video", destination?: string): Promise<string> {
  try {
    const defaultDir = path.join(os.homedir(), "Downloads");
    let saveDir = destination ? expandPath(destination) : defaultDir;

    // Resolve target path if it's a symlink (handles broken Downloads folder symlink!)
    try {
      saveDir = fs.realpathSync(saveDir);
    } catch (err) {
      try {
        const stat = fs.lstatSync(saveDir);
        if (stat.isSymbolicLink()) {
          const linkTarget = fs.readlinkSync(saveDir);
          saveDir = path.isAbsolute(linkTarget) ? linkTarget : path.resolve(path.dirname(saveDir), linkTarget);
          log(`downloadMedia: saveDir is a symlink pointing to ${saveDir}. Re-creating target folder...`);
        }
      } catch (lstatErr) {
        // saveDir doesn't exist at all, it will be created by mkdirSync
      }
    }

    if (!fs.existsSync(saveDir)) {
      fs.mkdirSync(saveDir, { recursive: true });
    }

    log(`downloadMedia: starting download for ${url} (type: ${type}) to saveDir: ${saveDir}`);
    
    let ytdlpPath = getBundledBin("yt-dlp");
    
    let args = "";
    if (type === "audio") {
      args = `-x --audio-format mp3 --audio-quality 0 -o "%(title)s.%(ext)s"`;
    } else {
      args = `-f "bv*+ba/b" --merge-output-format mp4 -o "%(title)s.mp4"`;
    }
    
    const cmd = `"${ytdlpPath}" ${args} -P "${saveDir}" "${url}"`;
    log(`downloadMedia: running command: ${cmd}`);
    
    const { stdout } = await execAsync(cmd);
    
    const destMatch = stdout.match(/Destination:\s*(.+)/i) || stdout.match(/Merging formats into\s*"(.*?)"/i);
    let filename = "";
    if (destMatch && destMatch[1]) {
      filename = path.basename(destMatch[1].replace(/"/g, "").trim());
    }
    
    const savedName = filename ? `「${filename}」` : "媒体文件";
    const destName = saveDir.includes("Desktop") ? "桌面" : "下载（Downloads）文件夹";
    return `已成功下载${type === "audio" ? "音频" : "视频"}${savedName}并保存至${destName}。`;
  } catch (error) {
    logError("downloadMedia failed", error);
    return `下载失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function listDirectory(dirPath: string): Promise<string> {
  const resolved = expandPath(dirPath || "~/Desktop");
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const items = entries.map((entry) => {
      const type = entry.isDirectory() ? "📁" : "📄";
      return `${type} ${entry.name}`;
    });
    if (items.length === 0) {
      return `目录 ${dirPath} 为空`;
    }
    return `目录 ${dirPath} 的内容：\n${items.join("\n")}`;
  } catch (error) {
    return `列出目录失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function runShellCommand(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 1024 * 1024 * 5,
      timeout: 30000,
      cwd: os.homedir(),
    });
    const output = (stdout + (stderr ? `\nSTDERR: ${stderr}` : "")).trim();
    const truncated = output.length > 5000 ? output.slice(0, 5000) + "\n...(输出过长，已截断)" : output;
    return truncated || "命令执行完成（无输出）";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `命令执行失败: ${message}`;
  }
}

export async function createNote(title: string, body: string): Promise<string> {
  try {
    const escapedTitle = title.replace(/"/g, '\\"');
    const escapedBody = body ? body.replace(/"/g, '\\"') : "";

    // Auto-detect the first account
    const accountName = await runAppleScript(`
      tell application "Notes"
        return name of account 1
      end tell
    `);

    await runAppleScript(`
      tell application "Notes"
        tell account "${accountName.replace(/"/g, '\\"')}"
          make new note with properties {name:"${escapedTitle}", body:"${escapedBody}"}
        end tell
      end tell
    `);
    return `已创建备忘录「${title}」`;
  } catch (error) {
    return `创建备忘录失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function searchNotes(query: string): Promise<string> {
  try {
    const escaped = query.replace(/"/g, '\\"');
    const result = await runAppleScript(`
      tell application "Notes"
        set output to ""
        repeat with n in (every note whose name contains "${escaped}" or body contains "${escaped}")
          set output to output & "【" & (name of n) & "】" & return & (body of n) & return & return
        end repeat
        return output
      end tell
    `);
    return result || `没有找到包含「${query}」的备忘录`;
  } catch (error) {
    return `搜索备忘录失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function createReminder(title: string, dueDate?: string, notes?: string): Promise<string> {
  try {
    const escapedTitle = title.replace(/"/g, '\\"');
    const escapedNotes = notes ? notes.replace(/"/g, '\\"') : "";
    let script = `
      tell application "Reminders"
        set newReminder to make new reminder with properties {name:"${escapedTitle}"}
    `;
    if (dueDate) {
      const parts = dueDate.trim().split(/[\s/]/);
      const datePart = parts[0].split("-");
      const timePart = parts[1] ? parts[1].split(":") : ["9", "0"];
      const y = parseInt(datePart[0]);
      const m = parseInt(datePart[1]);
      const d = parseInt(datePart[2]);
      const h = parseInt(timePart[0]);
      const min = parseInt(timePart[1] || "0");
      script += `
        set dueDate to (current date)
        set year of dueDate to ${y}
        set month of dueDate to ${m}
        set day of dueDate to ${d}
        set hours of dueDate to ${h}
        set minutes of dueDate to ${min}
        set seconds of dueDate to 0
        set due date of newReminder to dueDate
      `;
    }
    if (notes) {
      script += `        set body of newReminder to "${escapedNotes}"\n`;
    }
    script += `      end tell`;
    await runAppleScript(script);
    return `已创建提醒「${title}」${dueDate ? `，提醒时间：${dueDate}` : ""}`;
  } catch (error) {
    return `创建提醒失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function createCalendarEvent(title: string, startDate: string, endDate?: string, location?: string, notes?: string): Promise<string> {
  try {
    const escapedTitle = title.replace(/"/g, '\\"');
    const escapedLocation = location ? location.replace(/"/g, '\\"') : "";
    const escapedNotes = notes ? notes.replace(/"/g, '\\"') : "";

    const startParts = startDate.trim().split(/[\s/]/);
    const startDatePart = startParts[0].split("-");
    const startTimePart = startParts[1] ? startParts[1].split(":") : ["9", "0"];
    const sy = parseInt(startDatePart[0]);
    const sm = parseInt(startDatePart[1]);
    const sd = parseInt(startDatePart[2]);
    const sh = parseInt(startTimePart[0]);
    const smin = parseInt(startTimePart[1] || "0");

    let ey = sy, em = sm, ed = sd, eh = sh, emin = smin;
    if (endDate) {
      const endParts = endDate.trim().split(/[\s/]/);
      const endDatePart = endParts[0].split("-");
      const endTimePart = endParts[1] ? endParts[1].split(":") : [String(sh + 1), "0"];
      ey = parseInt(endDatePart[0]);
      em = parseInt(endDatePart[1]);
      ed = parseInt(endDatePart[2]);
      eh = parseInt(endTimePart[0]);
      emin = parseInt(endTimePart[1] || "0");
    } else {
      eh = sh + 1;
    }

    // Auto-detect the first writable calendar (skip read-only system calendars)
    const systemCalendars = ["中国大陆节假日", "US Holidays", "生日", "Birthdays", "Siri建议", "Siri Suggestions", "计划的提醒事项"];
    const calName = await runAppleScript(`
      tell application "Calendar"
        set calName to ""
        repeat with c in calendars
          set n to name of c
          if n is not "中国大陆节假日" and n is not "US Holidays" and n is not "生日" and n is not "Birthdays" and n is not "Siri建议" and n is not "Siri Suggestions" and n is not "计划的提醒事项" then
            set calName to n
            exit repeat
          end if
        end repeat
        if calName is "" then
          set calName to name of calendar 1
        end if
        return calName
      end tell
    `);

    let script = `
      tell application "Calendar"
        tell calendar "${calName.replace(/"/g, '\\"')}"
          set startDate to (current date)
          set year of startDate to ${sy}
          set month of startDate to ${sm}
          set day of startDate to ${sd}
          set hours of startDate to ${sh}
          set minutes of startDate to ${smin}
          set seconds of startDate to 0
          set endDate to (current date)
          set year of endDate to ${ey}
          set month of endDate to ${em}
          set day of endDate to ${ed}
          set hours of endDate to ${eh}
          set minutes of endDate to ${emin}
          set seconds of endDate to 0
          make new event with properties {summary:"${escapedTitle}", start date:startDate, end date:endDate`;
    if (location) {
      script += `, location:"${escapedLocation}"`;
    }
    if (notes) {
      script += `, description:"${escapedNotes}"`;
    }
    script += `}
        end tell
      end tell`;
    await runAppleScript(script);
    return `已创建日历事件「${title}」，时间：${startDate}${endDate ? " 至 " + endDate : ""}`;
  } catch (error) {
    return `创建日历事件失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function getCalendarEvents(days: number): Promise<string> {
  try {
    const result = await runAppleScript(`
      tell application "Calendar"
        set output to ""
        set startDate to (current date)
        set endDate to (current date) + (${days} * days)
        repeat with c in calendars
          repeat with e in (every event of c whose start date is greater than startDate and start date is less than endDate)
            set output to output & (short date string of (start date of e)) & " " & (time string of (start date of e)) & " " & (summary of e) & return
          end repeat
        end repeat
        return output
      end tell
    `);
    return result || `未来${days}天内没有日历事件`;
  } catch (error) {
    return `获取日历事件失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function setTimer(seconds: number): Promise<string> {
  try {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const desc = mins > 0 ? `${mins}分${secs > 0 ? secs + "秒" : ""}` : `${secs}秒`;

    const cmd = `nohup bash -c 'sleep ${seconds} && afplay /System/Library/Sounds/Glass.aiff && osascript -e "display notification \\"计时器完成：${desc}\\" with title \\"Daisy 计时器\\"" ' > /dev/null 2>&1 &`;
    await execAsync(cmd);

    return `已设置计时器：${desc}，时间到了会播放提示音`;
  } catch (error) {
    return `设置计时器失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function setAlarm(time: string, label?: string): Promise<string> {
  try {
    const parts = time.trim().split(/[\s/]/);
    const datePart = parts[0].split("-");
    const timePart = parts[1] ? parts[1].split(":") : ["7", "0"];
    const y = parseInt(datePart[0]);
    const m = parseInt(datePart[1]);
    const d = parseInt(datePart[2]);
    const h = parseInt(timePart[0]);
    const min = parseInt(timePart[1] || "0");

    const now = new Date();
    const alarmDate = new Date(y, m - 1, d, h, min, 0);
    const diffMs = alarmDate.getTime() - now.getTime();

    if (diffMs <= 0) {
      return `闹钟时间 ${time} 已过期，请指定一个未来的时间`;
    }

    const diffSec = Math.round(diffMs / 1000);
    const diffMins = Math.round(diffSec / 60);
    let timeDesc: string;
    if (diffMins < 60) {
      timeDesc = `${diffMins}分钟后`;
    } else if (diffMins < 1440) {
      timeDesc = `${Math.round(diffMins / 60 * 10) / 10}小时后`;
    } else {
      timeDesc = `${Math.round(diffMins / 1440 * 10) / 10}天后`;
    }

    const alarmLabel = label ? label.replace(/"/g, '\\"') : "闹钟";
    const alarmTimeStr = `${m}月${d}日 ${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;

    // Background process: sleep until alarm time, then play alarm sound repeatedly + notification
    const cmd = `nohup bash -c 'sleep ${diffSec} && for i in 1 2 3 4 5; do afplay /System/Library/Sounds/Alarm.aiff 2>/dev/null || afplay /System/Library/Sounds/Sosumi.aiff; sleep 1; done && osascript -e "display notification \\"${alarmLabel}：${alarmTimeStr}\\" with title \\"Daisy 闹钟\\" sound name \\"Sosumi\\"" ' > /dev/null 2>&1 &`;
    await execAsync(cmd);

    return `已设置闹钟「${label || "闹钟"}」，时间：${alarmTimeStr}（${timeDesc}响起）`;
  } catch (error) {
    return `设置闹钟失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function searchMaps(query: string): Promise<string> {
  try {
    await execAsync(`open "maps://?q=${encodeURIComponent(query)}"`);
    return `已在地图中搜索「${query}」`;
  } catch (error) {
    return `地图搜索失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function openUrl(url: string): Promise<string> {
  try {
    let finalUrl = url.trim();
    if (!/^https?:\/\//.test(finalUrl)) {
      finalUrl = "https://" + finalUrl;
    }
    await execAsync(`open "${finalUrl}"`);
    return `已用默认浏览器打开 ${finalUrl}`;
  } catch (error) {
    return `打开网址失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function switchAudioOutput(deviceName: string): Promise<string> {
  try {
    // List devices to find the best match
    const SW = getBundledBin("SwitchAudioSource");
    const { stdout } = await execAsync(`"${SW}" -a -t output`);
    const lines = stdout.split("\n").map((l) => l.replace(/\s*\(.*\)\s*$/, "").trim()).filter(Boolean);

    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "");
    const target = deviceName.toLowerCase();
    const targetNorm = normalize(deviceName);

    let best = lines.find((d) => d.toLowerCase() === target);
    if (!best) {
      best = lines.find((d) => normalize(d) === targetNorm);
    }
    if (!best) {
      best = lines.find((d) => d.toLowerCase().includes(target) || target.includes(d.toLowerCase()));
    }
    if (!best) {
      best = lines.find((d) => normalize(d).includes(targetNorm) || targetNorm.includes(normalize(d)));
    }
    // "声卡"/"音频接口" → try to find a pro audio interface device
    if (!best && /声卡|音频接口|audio\s*interface/i.test(deviceName)) {
      best = lines.find((d) => /SSL|audio|interface|usb|thunderbolt|firewire|rme|focusrite|apollo|motu|ua[ -]|volt/i.test(d));
    }
    if (!best) {
      return `找不到音频设备「${deviceName}」。当前可用设备：${lines.join("、")}`;
    }
    await execAsync(`"${SW}" -t output -s "${best}"`);
    log(`switchAudioOutput: switched to "${best}"`);
    return `已切换音频输出到「${best}」`;
  } catch (error) {
    return `切换音频输出失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function trimVideo(source: string, start: string, end: string, output?: string): Promise<string> {
  try {
    const src = expandPath(source);
    if (!fs.existsSync(src)) return `找不到源文件「${source}」`;

    const defaultName = `clip_${start.replace(/:/g, "m")}s-${end.replace(/:/g, "m")}s.mp4`;
    const outPath = resolveOutputPath(src, output, defaultName);
    const outName = path.basename(outPath);

    const dur = toSeconds(end) - toSeconds(start);
    if (dur <= 0) return `截取时间范围无效：${start} 到 ${end}`;

    const ffmpeg = getFfmpegPath();
    const args = [
      "-y", "-ss", start, "-i", src, "-t", String(dur),
      "-c:v", "libx264", "-preset", "fast", "-c:a", "aac",
      "-movflags", "+faststart", outPath,
    ];
    log(`trimVideo: ${ffmpeg} ${args.join(" ")}`);
    await execFileAsync(ffmpeg, args, { timeout: 120000 });
    return `已截取视频片段，保存至「${outName}」（${dur} 秒）`;
  } catch (error) {
    return `视频截取失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function convertVideo(source: string, format: string, output?: string): Promise<string> {
  try {
    const src = expandPath(source);
    if (!fs.existsSync(src)) return `找不到源文件「${source}」`;

    const normalizedFormat = format.trim().replace(/^\./, "").toLowerCase();
    const baseName = path.basename(src, path.extname(src));
    const outPath = resolveOutputPath(src, output, `${baseName}.${normalizedFormat}`);
    const outName = path.basename(outPath);
    const ffmpeg = getFfmpegPath();
    const args = ["-y", "-i", src];

    if (normalizedFormat === "gif") {
      args.push("-vf", "fps=12,scale='min(960,iw)':-2:flags=lanczos", "-loop", "0");
    } else if (["mp3", "m4a", "wav", "flac", "ogg"].includes(normalizedFormat)) {
      args.push("-vn");
      if (normalizedFormat === "mp3") args.push("-c:a", "libmp3lame");
      if (normalizedFormat === "m4a") args.push("-c:a", "aac");
    } else if (normalizedFormat === "webm") {
      args.push("-c:v", "libvpx-vp9", "-c:a", "libopus");
    } else if (normalizedFormat === "avi") {
      args.push("-c:v", "mpeg4", "-c:a", "libmp3lame");
    } else {
      args.push("-c:v", "libx264", "-preset", "fast", "-c:a", "aac", "-movflags", "+faststart");
    }
    args.push(outPath);

    log(`convertVideo: ${ffmpeg} ${args.join(" ")}`);
    await execFileAsync(ffmpeg, args, { timeout: 300000 });
    return `已转换视频格式，保存至「${outName}」`;
  } catch (error) {
    return `视频格式转换失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Use Electron's built-in Chromium to render HTML → PDF (no external tools needed) */
async function htmlToPdfViaElectron(htmlPath: string, pdfPath: string): Promise<void> {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  try {
    // file:// protocol to load local HTML with correct origin for relative resources
    const fileUrl = `file://${htmlPath}`;
    await win.loadURL(fileUrl);

    // Wait for any deferred rendering (fonts, images, etc.)
    await new Promise(resolve => setTimeout(resolve, 500));

    const pdfData = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0.59, bottom: 0.59, left: 0.47, right: 0.47 }, // inches
    });

    await fs.promises.writeFile(pdfPath, pdfData);
  } finally {
    // Always clean up the hidden window
    if (!win.isDestroyed()) win.destroy();
  }
}

export async function convertDocument(source: string, target: string): Promise<string> {
  try {
    const src = expandPath(source);
    const dst = expandPath(target);
    if (!fs.existsSync(src)) return `找不到源文件「${source}」`;

    const srcExt = path.extname(src).toLowerCase();
    const dstExt = path.extname(dst).toLowerCase();

    const textutilFormats: Record<string, string> = {
      ".txt": "txt",
      ".md": "txt",
      ".rtf": "rtf",
      ".html": "html",
      ".htm": "html",
      ".doc": "doc",
      ".docx": "docx",
      ".odt": "odt",
      ".wordml": "wordml",
    };

    if (dstExt === ".pdf" && srcExt !== ".pdf") {
      let htmlPath = src;
      let temporaryHtml: string | null = null;
      if (srcExt !== ".html" && srcExt !== ".htm") {
        temporaryHtml = path.join(os.tmpdir(), `diri-convert-${Date.now()}.html`);
        await execFileAsync("/usr/bin/textutil", ["-convert", "html", "-output", temporaryHtml, src], { timeout: 60000 });
        htmlPath = temporaryHtml;
      }
      try {
        await htmlToPdfViaElectron(htmlPath, dst);
      } finally {
        if (temporaryHtml) await fs.promises.unlink(temporaryHtml).catch(() => {});
      }
      return `已转换为 PDF，保存至「${path.basename(dst)}」`;
    }

    if (srcExt === ".pdf") {
      if (!textutilFormats[dstExt]) return `暂不支持 PDF 转换为 ${dstExt || "无扩展名格式"}`;
      const tmpTxt = path.join(os.tmpdir(), `diri-convert-${Date.now()}.txt`);
      const script = [
        "import fitz, sys",
        "doc = fitz.open(sys.argv[1])",
        "open(sys.argv[2], 'w', encoding='utf-8').write('\\n'.join(page.get_text() for page in doc))",
      ].join("\n");
      try {
        await execFileAsync("python3", ["-c", script, src, tmpTxt], { timeout: 60000 });
        await execFileAsync("/usr/bin/textutil", ["-convert", textutilFormats[dstExt], "-output", dst, tmpTxt], { timeout: 60000 });
      } finally {
        await fs.promises.unlink(tmpTxt).catch(() => {});
      }
      return `已转换文档，保存至「${path.basename(dst)}」`;
    }

    const targetFormat = textutilFormats[dstExt];
    if (!targetFormat) return `暂不支持转换为 ${dstExt || "无扩展名格式"}`;
    await execFileAsync("/usr/bin/textutil", ["-convert", targetFormat, "-output", dst, src], { timeout: 60000 });
    return `已转换文档，保存至「${path.basename(dst)}」`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `文档转换失败: ${msg}`;
  }
}

export async function editDocument(
  source: string, target: string, operation: string,
  color?: string, pageStart?: number, pageEnd?: number,
  code?: string
): Promise<string> {
  try {
    const src = expandPath(source);
    const dst = expandPath(target);
    if (!fs.existsSync(src)) return `找不到源文件「${source}」`;

    const ext = path.extname(src).toLowerCase();
    if (ext !== ".docx") return `edit_document 仅支持 .docx 文件，源文件扩展名为「${ext}」`;

    let script: string;

    if (operation === "remove_colored_text") {
      const c = (color || "FF0000").replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
      const pageClause = (pageStart != null && pageEnd != null)
        ? `
# —— 页码范围 ——
page_start = ${pageStart}
page_end = ${pageEnd}

# 用节分页符构建真实页码映射
page_map = []
cur = 0
for i, p in enumerate(doc.paragraphs):
    has_break = False
    for run in p.runs:
        for br in run._element.findall(f"{{{W_NS}}}br"):
            if br.get(f"{{{W_NS}}}type") == "page":
                has_break = True
    sp = p._element.find(f"{{{W_NS}}}pPr/{{{W_NS}}}sectPr")
    if sp is not None:
        t = sp.find(f"{{{W_NS}}}type")
        if t is None or t.get(f"{{{W_NS}}}val") != "continuous":
            has_break = True
    if has_break and i > cur:
        page_map.append((cur, i))
        cur = i + 1
page_map.append((cur, len(doc.paragraphs) - 1))

if page_start > len(page_map) or page_end > len(page_map):
    print(f"文档只有 {len(page_map)} 页，无法处理第 {page_start}-{page_end} 页")
    sys.exit(0)

target = range(page_map[page_start-1][0], page_map[page_end-1][1] + 1)
print(f"总页数: {len(page_map)}, 目标页码: {page_start}-{page_end}, 段落范围: {min(target)}-{max(target)}")
`
        : `
target = range(len(doc.paragraphs))
print(f"处理全文，共 {len(doc.paragraphs)} 个段落")
`;

      script = `import sys, os
sys.path.insert(0, os.path.expanduser("~/.local/lib/python3/site-packages"))
import docx
from docx.shared import RGBColor

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
TARGET_COLOR = "${c}"
TARGET_R = int(TARGET_COLOR[0:2], 16)
TARGET_G = int(TARGET_COLOR[2:4], 16)
TARGET_B = int(TARGET_COLOR[4:6], 16)

doc = docx.Document(${JSON.stringify(src)})
${pageClause}

# —— 统计 ——
total_colored = 0
table_colored = 0
for i in target:
    for run in doc.paragraphs[i].runs:
        if run.font.color and run.font.color.rgb == RGBColor(TARGET_R, TARGET_G, TARGET_B):
            total_colored += 1
for t in doc.tables:
    for row in t.rows:
        for cell in row.cells:
            for p in cell.paragraphs:
                for run in p.runs:
                    if run.font.color and run.font.color.rgb == RGBColor(TARGET_R, TARGET_G, TARGET_B):
                        table_colored += 1
print(f"目标范围段落色 #{TARGET_COLOR}: {total_colored}, 表格: {table_colored}")

# —— 执行删除 ——
cleared = 0
for i in target:
    for run in doc.paragraphs[i].runs:
        if run.font.color and run.font.color.rgb == RGBColor(TARGET_R, TARGET_G, TARGET_B):
            run.text = " " * len(run.text)
            run.font.color.rgb = None
            cleared += 1

doc.save(${JSON.stringify(dst)})
print(f"已清除 {cleared} 个 run（下划线/格式已保留）")
`;

    } else if (operation === "run_code") {
      script = `import sys, os
sys.path.insert(0, os.path.expanduser("~/.local/lib/python3/site-packages"))
import docx
from docx.shared import RGBColor

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

doc = docx.Document(${JSON.stringify(src)})

# === 用户代码 ===
${code ?? ""}
# === 结束 ===

doc.save(${JSON.stringify(dst)})
empty_ul = 0
for p in doc.paragraphs:
    if any(r.underline and (r.text is None or r.text.strip() == "") for r in p.runs):
        empty_ul += 1
for tbl in doc.tables:
    for row in tbl.rows:
        for cell in row.cells:
            for p in cell.paragraphs:
                if any(r.underline and (r.text is None or r.text.strip() == "") for r in p.runs):
                    empty_ul += 1
print("OK: document saved")
print("RESCAN: remaining_empty_underlined_paragraphs=" + str(empty_ul))
`;
    } else {
      return `未知操作: ${operation}`;
    }

    const scriptPath = path.join(os.tmpdir(), `diri-edit-doc-${Date.now()}.py`);
    await fs.promises.writeFile(scriptPath, script, "utf-8");

    try {
      const { stdout, stderr } = await execAsync(`python3 "${scriptPath}"`, { timeout: 30000 });
      const output = stdout.trim() + (stderr.trim() ? `\nstderr: ${stderr.trim()}` : "");
      log(`editDocument: ${output}`);
      return `已编辑文档，保存至「${path.basename(dst)}」（${output}）`;
    } finally {
      await fs.promises.unlink(scriptPath).catch(() => {});
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `文档编辑失败: ${msg}`;
  }
}

export async function editPdf(
  source: string, target: string, operation: string,
  query?: string, anchor?: string, text?: string, color?: string,
  fontsize?: number, mode?: string, replaceWith?: string
): Promise<string> {
  try {
    const src = expandPath(source);
    const dst = expandPath(target);
    if (!fs.existsSync(src)) return `找不到源文件「${source}」`;
    if (path.extname(src).toLowerCase() !== ".pdf") return `edit_pdf 仅支持 .pdf 文件`;

    let script: string;

    if (operation === "find") {
      script = `import fitz
doc = fitz.open(${JSON.stringify(src)})
query = ${JSON.stringify(query || "")}
results = []
for pno in range(len(doc)):
    page = doc[pno]
    try:
        rects = page.search_for(query)
    except Exception:
        rects = []
    for r in rects:
        results.append(f"页{pno+1} ({r.x0:.0f},{r.y0:.0f},{r.x1:.0f},{r.y1:.0f})")
print(f"找到 {len(results)} 处" if results else "未找到")
for x in results[:30]:
    print(x)
`;
    } else if (operation === "fill") {
      const c = (color || "FF0000").toUpperCase();
      script = `import fitz
doc = fitz.open(${JSON.stringify(src)})
anchor = ${JSON.stringify(anchor || "")}
text = ${JSON.stringify(text || "")}
color_hex = ${JSON.stringify(c)}
cr = int(color_hex[0:2], 16) / 255
cg = int(color_hex[2:4], 16) / 255
cb = int(color_hex[4:6], 16) / 255
fontsize = ${fontsize ?? 11}
fn = "helv" if all(ord(c) < 128 for c in text) else "china-s"
count = 0
for pno in range(len(doc)):
    page = doc[pno]
    rects = page.search_for(anchor)
    for rect in rects:
        point = fitz.Point(rect.x1 + 1, rect.y1 - 2)
        maxw = page.rect.width - point.x - 10
        if maxw < 20:
            maxw = 200
        fs = fontsize
        while fs > 6 and fitz.get_text_length(text, fontname=fn, fontsize=fs) > maxw:
            fs -= 0.5
        page.insert_text(point, text, fontname=fn, fontsize=fs, color=(cr, cg, cb))
        count += 1
doc.save(${JSON.stringify(dst)})
print(f"已填入 {count} 处（锚点='{anchor}'，文字='{text}'，颜色=#{color_hex}）")
`;
    } else if (operation === "delete") {
      const c = (color || "FF0000").toUpperCase();
      script = `import fitz
doc = fitz.open(${JSON.stringify(src)})
mode = ${JSON.stringify(mode || "text")}
count = 0
if mode == "color":
    color_hex = ${JSON.stringify(c)}
    target_int = int(color_hex, 16)
    for pno in range(len(doc)):
        page = doc[pno]
        d = page.get_text("dict")
        rects = []
        for block in d.get("blocks", []):
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    if span.get("color") == target_int:
                        rects.append(fitz.Rect(span["bbox"]))
        for r in rects:
            page.add_redact_annot(r, fill=(1, 1, 1))
        if rects:
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
            count += len(rects)
else:
    target = ${JSON.stringify(text || query || "")}
    for pno in range(len(doc)):
        page = doc[pno]
        rects = page.search_for(target)
        for r in rects:
            page.add_redact_annot(r, fill=(1, 1, 1))
        if rects:
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
            count += len(rects)
doc.save(${JSON.stringify(dst)})
print(f"已删除 {count} 处（模式={mode}）")
`;
    } else if (operation === "replace") {
      const c = (color || "000000").toUpperCase();
      script = `import fitz
doc = fitz.open(${JSON.stringify(src)})
find_text = ${JSON.stringify(query || anchor || "")}
new_text = ${JSON.stringify(replaceWith || text || "")}
color_hex = ${JSON.stringify(c)}
cr = int(color_hex[0:2], 16) / 255
cg = int(color_hex[2:4], 16) / 255
cb = int(color_hex[4:6], 16) / 255
fn = "helv" if all(ord(c) < 128 for c in new_text) else "china-s"
count = 0
for pno in range(len(doc)):
    page = doc[pno]
    rects = page.search_for(find_text)
    for r in rects:
        page.add_redact_annot(r, fill=(1, 1, 1))
    if rects:
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
        for r in rects:
            point = fitz.Point(r.x0, r.y1 - 2)
            page.insert_text(point, new_text, fontname=fn, fontsize=11, color=(cr, cg, cb))
            count += 1
doc.save(${JSON.stringify(dst)})
print(f"已替换 {count} 处")
`;
    } else {
      return `未知操作: ${operation}`;
    }

    const scriptPath = path.join(os.tmpdir(), `diri-edit-pdf-${Date.now()}.py`);
    await fs.promises.writeFile(scriptPath, script, "utf-8");
    try {
      const { stdout, stderr } = await execAsync(`python3 "${scriptPath}"`, { timeout: 60000, env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH || ""}` } });
      const output = stdout.trim() + (stderr.trim() ? `\nstderr: ${stderr.trim()}` : "");
      log(`editPdf: ${output}`);
      if (operation === "find") return output;
      return `已编辑 PDF，保存至「${path.basename(dst)}」（${output}）`;
    } finally {
      await fs.promises.unlink(scriptPath).catch(() => {});
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `PDF 编辑失败: ${msg}`;
  }
}

function toSeconds(t: string): number {
  const parts = t.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

export async function executeTool(name: string, argsJson: string): Promise<string> {
  try {
    const args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    log(`executeTool: ${name} with args ${argsJson}`);

    switch (name) {
      case "web_search": {
        const { webSearch } = await import("./search");
        return await webSearch(String(args.query));
      }
      case "scrape_url": {
        const { scrapeUrl } = await import("./search");
        return await scrapeUrl(String(args.url));
      }
      case "search_wallpapers": {
        const { searchWallpapers } = await import("./search");
        return await searchWallpapers(String(args.query));
      }
      case "open_application":
        return await openApplication(String(args.name));
      case "quit_application":
        return await quitApplication(String(args.name));
      case "quit_all_applications": {
        const excludes = args.exclude_names ? (Array.isArray(args.exclude_names) ? args.exclude_names.map(String) : [String(args.exclude_names)]) : [];
        return await quitAllApplications(excludes);
      }
      case "type_text":
        return await typeText(String(args.text));
      case "press_keys":
        return await pressKeys(String(args.keys));
      case "get_frontmost_application":
        return await getFrontmostApplication();
      case "read_selected_text":
        return await readSelectedText();
      case "get_clipboard_text":
        return await getClipboardText();
      case "write_clipboard_text":
        return await writeClipboardText(String(args.text));
      case "get_current_time":
        return await getCurrentTime();
      case "weather_forecast": {
        const { weatherForecast } = await import("./weather");
        const days = parseInt(String(args.days ?? "1"), 10);
        return await weatherForecast(String(args.city), isNaN(days) ? 1 : Math.min(Math.max(days, 1), 10));
      }
      case "read_file":
        return await readFile(String(args.path));
      case "write_file":
        return await writeFile(String(args.path), String(args.content ?? ""));
      case "create_file":
        return await createFile(String(args.path), String(args.content ?? ""));
      case "delete_file":
        return await deleteFile(String(args.path));
      case "download_media":
        return await downloadMedia(
          String(args.url),
          args.type ? String(args.type) : "video",
          args.destination ? String(args.destination) : undefined
        );
      case "list_directory":
        return await listDirectory(String(args.path ?? "~/Desktop"));
      case "run_shell_command":
        return await runShellCommand(String(args.command));
      case "create_note":
        return await createNote(String(args.title), String(args.body ?? ""));
      case "search_notes":
        return await searchNotes(String(args.query));
      case "create_reminder":
        return await createReminder(String(args.title), args.due_date ? String(args.due_date) : undefined, args.notes ? String(args.notes) : undefined);
      case "create_calendar_event":
        return await createCalendarEvent(String(args.title), String(args.start_date), args.end_date ? String(args.end_date) : undefined, args.location ? String(args.location) : undefined, args.notes ? String(args.notes) : undefined);
      case "get_calendar_events": {
        const d = parseInt(String(args.days ?? "7"), 10);
        return await getCalendarEvents(isNaN(d) ? 7 : d);
      }
      case "set_timer": {
        const s = parseInt(String(args.seconds), 10);
        return await setTimer(isNaN(s) ? 300 : s);
      }
      case "set_alarm":
        return await setAlarm(String(args.time), args.label ? String(args.label) : undefined);
      case "search_maps":
        return await searchMaps(String(args.query));
      case "sports_schedule": {
        const { sportsSchedule } = await import("./sports");
        return await sportsSchedule(String(args.league));
      }
      case "open_url":
        return await openUrl(String(args.url));
      case "switch_audio_output":
        return await switchAudioOutput(String(args.device));
      case "trim_video":
        return await trimVideo(String(args.source), String(args.start), String(args.end), args.output ? String(args.output) : undefined);
      case "convert_video":
        return await convertVideo(String(args.source), String(args.format), args.output ? String(args.output) : undefined);
      case "convert_document":
        return await convertDocument(String(args.source), String(args.target));
      case "edit_document":
        return await editDocument(
          String(args.source), String(args.target), String(args.operation ?? "remove_colored_text"),
          args.color ? String(args.color) : undefined,
          args.page_start != null ? Number(args.page_start) : undefined,
          args.page_end != null ? Number(args.page_end) : undefined,
          args.code ? String(args.code) : undefined
        );
      case "edit_pdf":
        return await editPdf(
          String(args.source), String(args.target), String(args.operation ?? "find"),
          args.query ? String(args.query) : undefined,
          args.anchor ? String(args.anchor) : undefined,
          args.text ? String(args.text) : undefined,
          args.color ? String(args.color) : undefined,
          args.fontsize != null ? Number(args.fontsize) : undefined,
          args.mode ? String(args.mode) : undefined,
          args.replace_with ? String(args.replace_with) : undefined
        );
      case "send_email":
        return await sendEmail(
          String(args.to),
          String(args.subject ?? "无主题"),
          String(args.body ?? "")
        );
      case "read_unread_emails": {
        const l = parseInt(String(args.limit ?? "5"), 10);
        return await readUnreadEmails(isNaN(l) ? 5 : l);
      }
      case "get_recent_emails": {
        const l = parseInt(String(args.limit ?? "5"), 10);
        return await getRecentEmails(isNaN(l) ? 5 : l);
      }
      case "search_emails": {
        const l = parseInt(String(args.limit ?? "5"), 10);
        return await searchEmails(String(args.query), isNaN(l) ? 5 : l);
      }
      default:
        return `未知工具: ${name}`;
    }
  } catch (error) {
    return `工具执行失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}
