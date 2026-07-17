#!/usr/bin/env node
/**
 * Daisy 设置项自测脚本
 * 直接在 Node 层验证：daisy.env 读写、Whisper 路径、getWritableEnvPath 等
 * 用于验证主进程逻辑，不涉及 Electron IPC
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

console.log("========== Daisy 设置项自测 ==========\n");

// 1. daisy.env 读取
console.log("[1] 读取 daisy.env...");
const envCandidates = [
  path.join(process.cwd(), "daisy.env"),
  path.join(os.homedir(), "Library", "Application Support", "Daisy", "daisy.env"),
];
const projectEnv = envCandidates.find((candidate) => fs.existsSync(candidate));
if (!projectEnv) {
  console.error("  ✗ daisy.env 不存在:", envCandidates.join("、"));
} else {
  console.log("  ✓ 配置文件:", projectEnv);
  const raw = fs.readFileSync(projectEnv, "utf-8");
  const kv = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) kv[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  const managedKeys = [
    "VOLCENGINE_APP_ID", "VOLCENGINE_ACCESS_TOKEN", "VOLCENGINE_RESOURCE_ID",
    "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL",
    "EDGE_TTS_VOICE", "EDGE_TTS_RATE",
    "GLOBAL_SHORTCUT", "WAKE_WORD_ENABLED", "WAKE_WORD",
    "FIRECRAWL_API_KEY", "WHISPER_MODEL", "SHORTCUT_USE_WHISPER", "AUTO_LAUNCH",
  ];
  let ok = 0;
  const missing = [];
  for (const k of managedKeys) {
    if (kv[k] !== undefined) ok++;
    else missing.push(k);
  }
  console.log(`  ✓ 读到 ${Object.keys(kv).length} 个 key`);
  console.log(`  ✓ 已管理 key: ${ok}/${managedKeys.length}${missing.length ? " (缺失: " + missing.join(",") + ")" : ""}`);
  console.log("  ✓ WAKE_WORD 保留:", JSON.stringify(kv.WAKE_WORD));
  console.log("  ✓ EDGE_TTS_RATE:", JSON.stringify(kv.EDGE_TTS_RATE));
  console.log("  ✓ GLOBAL_SHORTCUT:", JSON.stringify(kv.GLOBAL_SHORTCUT));
  console.log("  ✓ WHISPER_MODEL:", JSON.stringify(kv.WHISPER_MODEL));
}

// 2. Whisper 模型路径 & CLI
console.log("\n[2] Whisper 模型路径...");
const home = os.homedir();
const modelDir = path.join(home, "Models/whisper");
const modelName = "ggml-base.bin";
const modelPath = path.join(modelDir, modelName);
console.log(`  模型目录: ${modelDir} (${fs.existsSync(modelDir) ? "存在" : "不存在"})`);
console.log(`  Base 模型: ${modelPath} (${fs.existsSync(modelPath) ? "存在" : "不存在"})`);
const cliCandidates = [
  path.join(process.cwd(), "assets", "bin", "whisper-cli"),
  "/Applications/Daisy.app/Contents/Resources/app.asar.unpacked/assets/bin/whisper-cli",
  "/opt/homebrew/bin/whisper-cli",
];
const cliPath = cliCandidates.find((candidate) => fs.existsSync(candidate));
console.log(`  whisper-cli: ${cliPath || "未找到"} (${cliPath ? "已安装" : "未安装"})`);

const cpuModel = os.cpus()[0]?.model || "";
const backendName = /Apple M1\b/i.test(cpuModel)
  ? "libggml-cpu-apple_m1.so"
  : /Apple M[23]\b/i.test(cpuModel)
    ? "libggml-cpu-apple_m2_m3.so"
    : /Apple M\d+\b/i.test(cpuModel)
      ? "libggml-cpu-apple_m4.so"
      : null;
const backendPath = cliPath && backendName
  ? path.resolve(path.dirname(cliPath), "..", "lib", backendName)
  : null;
console.log(`  CPU 后端: ${backendPath || "系统默认"} (${backendPath && fs.existsSync(backendPath) ? "可用" : "未找到或无需指定"})`);
const ffmpegPath = require("ffmpeg-static");
console.log(`  ffmpeg: ${ffmpegPath || "未找到"} (${ffmpegPath && fs.existsSync(ffmpegPath) ? "可用" : "未安装"})`);
const switchAudioPath = path.join(process.cwd(), "assets", "bin", "SwitchAudioSource");
console.log(`  SwitchAudioSource: ${switchAudioPath} (${fs.existsSync(switchAudioPath) ? "可用" : "未安装"})`);

// 3. userData 路径
console.log("\n[3] userData 目录...");
const dataDirDev = path.join(home, "Library/Application Support/Daisy Dev");
const dataDirProd = path.join(home, "Library/Application Support/Daisy");
console.log(`  Daisy Dev: ${dataDirDev} (${fs.existsSync(dataDirDev) ? "存在" : "不存在"})`);
console.log(`  Daisy:     ${dataDirProd} (${fs.existsSync(dataDirProd) ? "存在" : "不存在"})`);

// 4. 打包后 app.asar 内是否有 daisy.env
console.log("\n[4] 打包产物中的 daisy.env...");
const appEnv = "/Applications/Daisy Dev.app/Contents/Resources/app.asar";
if (fs.existsSync(appEnv)) {
  const { execSync } = require("child_process");
  try {
    const out = execSync(`npx asar list "${appEnv}" 2>&1 | grep daisy.env`).toString();
    console.log("  app.asar 内:", out.trim() || "(无)");
  } catch (e) {
    console.log("  (asar 未安装或解析失败)");
  }
}

// 5. daisy.env 写入模拟（UPDATE_CONFIG 逻辑复现）
console.log("\n[5] 模拟 UPDATE_CONFIG 增量写入...");
const testWritePath = path.join("/tmp", "daisy.env.test");
const original = {
  VOLCENGINE_APP_ID: "orig_appid",
  TRANSLATION_PROVIDER: "ai",  // 非管理 key，应该保留
  AI_TRANSLATION_API_KEY: "sk-oldkey",  // 非管理 key
  DEEPSEEK_API_KEY: "sk-old",
  WAKE_WORD: "嘿 Daisy",
};
fs.writeFileSync(testWritePath, Object.entries(original).map(([k,v])=>`${k}=${v}`).join("\n") + "\n");

const managedKeys = new Set([
  "VOLCENGINE_APP_ID", "VOLCENGINE_ACCESS_TOKEN", "VOLCENGINE_RESOURCE_ID",
  "VOLCENGINE_ASR_WS_URL",
  "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL",
  "EDGE_TTS_VOICE", "EDGE_TTS_RATE",
  "GLOBAL_SHORTCUT", "WAKE_WORD_ENABLED", "WAKE_WORD",
  "FIRECRAWL_API_KEY", "WHISPER_MODEL", "SHORTCUT_USE_WHISPER", "AUTO_LAUNCH",
]);

// 模拟前端保存
const newCfg = {
  DEEPSEEK_API_KEY: "sk-new-key",
  EDGE_TTS_VOICE: "zh-CN-YunxiNeural",
  EDGE_TTS_RATE: "+30%",
  AUTO_LAUNCH: "true",
};

const existing = {};
const raw = fs.readFileSync(testWritePath, "utf-8");
for (const line of raw.split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i > 0) existing[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
for (const [k, v] of Object.entries(newCfg)) {
  if (managedKeys.has(k)) existing[k] = v || "";
}
fs.writeFileSync(testWritePath, Object.entries(existing).map(([k,v])=>`${k}=${v}`).join("\n") + "\n");

const after = fs.readFileSync(testWritePath, "utf-8");
console.log("  写入结果:");
console.log("  " + after.split("\n").filter(Boolean).map(l => "    " + l).join("\n").trim());
if (!after.includes("TRANSLATION_PROVIDER=ai")) console.error("  ✗ 未管理的 key TRANSLATION_PROVIDER 被丢失！");
else console.log("  ✓ 未管理的 key TRANSLATION_PROVIDER 保留");
if (!after.includes("AI_TRANSLATION_API_KEY=sk-oldkey")) console.error("  ✗ 未管理的 AI_TRANSLATION_API_KEY 被丢失！");
else console.log("  ✓ 未管理的 AI_TRANSLATION_API_KEY 保留");
if (!after.includes("DEEPSEEK_API_KEY=sk-new-key")) console.error("  ✗ 新的 DEEPSEEK_API_KEY 未写入！");
else console.log("  ✓ DEEPSEEK_API_KEY 已更新为新值");
if (!after.includes("EDGE_TTS_VOICE=zh-CN-YunxiNeural")) console.error("  ✗ EDGE_TTS_VOICE 未更新！");
else console.log("  ✓ EDGE_TTS_VOICE 已更新");
if (!after.includes("EDGE_TTS_RATE=+30%")) console.error("  ✗ EDGE_TTS_RATE 未更新！");
else console.log("  ✓ EDGE_TTS_RATE 已更新");
if (!after.includes("AUTO_LAUNCH=true")) console.error("  ✗ AUTO_LAUNCH 未更新！");
else console.log("  ✓ AUTO_LAUNCH 已更新");

fs.unlinkSync(testWritePath);
console.log("\n========== 测试完成 ==========");
