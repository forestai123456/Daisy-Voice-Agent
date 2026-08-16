const { execSync } = require("node:child_process");
const path = require("node:path");

if (process.platform === "darwin") {
  const nodeInclude = path.resolve(process.execPath, "../../include/node");
  execSync(
    `xcrun clang++ -std=c++17 -fobjc-arc -bundle -undefined dynamic_lookup -framework Foundation -framework CoreGraphics -framework AppKit -I"${nodeInclude}" native/window-selector.mm -o assets/bin/daisy-window-selector.node`,
    { stdio: "inherit" }
  );
  console.log("[build:native] macOS native overlay built.");
} else {
  console.log(
    `[build:native] Skipping native module build on ${process.platform}. ` +
      `Daisy uses Electron setAlwaysOnTop on this platform; the native overlay module is macOS-only.`
  );
}
