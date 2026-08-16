/**
 * Platform dispatcher for the Daisy control layer.
 *
 * On macOS  -> delegates to ./macos  (AppleScript / open / pkill / screencapture ...)
 * On Windows-> delegates to ./windows (PowerShell / Start-Process / taskkill ...)
 *
 * External callers (deepseek.ts, router.ts, index.ts) MUST import from here
 * instead of reaching directly into ./macos, so the right implementation is
 * loaded per platform at runtime.
 */

// `require` is used (rather than `import`) so that the unused platform's
// module is never parsed by the bundler at build time on the other platform.
// Both modules export the same surface; the cast keeps TS happy.
type PlatformApi = {
  executeTool: (name: string, argsJson: string) => Promise<string>;
  getDefaultBrowserBundleId: () => Promise<string>;
};

const impl: PlatformApi =
  process.platform === "win32" ? require("./windows") : require("./macos");

export const executeTool = impl.executeTool.bind(impl) as PlatformApi["executeTool"];
export const getDefaultBrowserBundleId = impl.getDefaultBrowserBundleId.bind(impl) as PlatformApi["getDefaultBrowserBundleId"];
