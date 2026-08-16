import { shell } from "electron";

// `about:blank` is an internal browser URL, not an external protocol that
// Windows can reliably hand to the registered default browser.  Opening this
// neutral HTTPS page always invokes the user's actual default browser.
export const DEFAULT_BROWSER_LAUNCH_URL = "https://www.bing.com/";

/**
 * Open an http(s) URL through the operating system's default browser.
 * Keeping this in one place prevents Windows code from falling back to the
 * macOS-only `open` executable or interpolating URLs into a shell command.
 */
export function normalizeExternalUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("URL 不能为空");
  if (trimmed === "about:blank") return trimmed;

  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("只允许打开 http 或 https 网站");
  }
  return parsed.toString();
}

export async function openExternalUrl(input: string): Promise<string> {
  const url = normalizeExternalUrl(input);
  await shell.openExternal(url);
  return url;
}

/** Open the system default browser through a real externally handled URL. */
export async function openDefaultBrowser(): Promise<string> {
  return await openExternalUrl(DEFAULT_BROWSER_LAUNCH_URL);
}

/** A log-safe representation that never includes search terms or fragments. */
export function describeExternalUrlForLog(input: string): string {
  if (input.trim() === "about:blank") return "about:blank";
  const parsed = new URL(normalizeExternalUrl(input));
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}
