import { EdgeTTS } from "node-edge-tts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import dotenv from "dotenv";

dotenv.config();

async function testTTS() {
  console.log("Testing Edge TTS...");
  const tts = new EdgeTTS({ voice: "zh-CN-XiaoxiaoNeural" });
  const tempDir = path.join(os.tmpdir(), "diri-tts-test");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const filePath = path.join(tempDir, "test.mp3");

  await tts.ttsPromise("你好，我是 diri。", filePath);
  const stats = fs.statSync(filePath);
  console.log(`TTS OK: ${filePath} (${stats.size} bytes)`);
  fs.unlinkSync(filePath);
}

async function testLLM() {
  console.log("Testing DeepSeek LLM...");
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.AI_TRANSLATION_API_KEY;
  const baseUrl = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
  const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

  if (!apiKey) {
    console.log("LLM skipped: no API key");
    return;
  }

  const endpoint = /\/v1$/i.test(baseUrl)
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "你好" }],
      max_tokens: 50,
    }),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek API error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  console.log("LLM OK:", data.choices?.[0]?.message?.content?.slice(0, 50));
}

async function testASRConfig() {
  console.log("Testing ASR config...");
  const appId = process.env.VOLCENGINE_APP_ID;
  const token = process.env.VOLCENGINE_ACCESS_TOKEN;
  if (!appId || !token) {
    console.log("ASR skipped: missing credentials");
    return;
  }
  console.log(`ASR credentials present (appId length: ${appId.length})`);
}

async function main() {
  try {
    await testASRConfig();
    await testLLM();
    await testTTS();
    console.log("\nAll service tests passed!");
  } catch (error) {
    console.error("\nTest failed:", error.message);
    process.exit(1);
  }
}

main();
