const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

const execFileAsync = promisify(execFile);

async function main() {
  if (process.platform !== "win32") {
    console.log("Skipping Windows-only Whisper runtime environment test.");
    return;
  }

  const { getWhisperExecEnv } = require("../dist/main/config/env.js");
  const cli = path.resolve(__dirname, "..", "assets", "bin", "whisper-cli.exe");
  const expectedLibDir = path.resolve(__dirname, "..", "assets", "lib");

  // Reproduce the duplicate-key environment inherited by the packaged app.
  process.env.Path = process.env.PATH || process.env.Path || "";
  const env = getWhisperExecEnv(cli);
  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
  assert.deepEqual(pathKeys, ["PATH"], "child process environment must contain exactly one PATH key");
  assert.ok(env.PATH.startsWith(`${expectedLibDir};`), "PATH must begin with bundled Whisper DLL directory");

  await execFileAsync(cli, ["--help"], {
    env,
    windowsHide: true,
    timeout: 10_000,
  });
  console.log("Whisper runtime environment test passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
