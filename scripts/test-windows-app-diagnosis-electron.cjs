#!/usr/bin/env node
const assert = require("node:assert/strict");
const { app } = require("electron");

app.whenReady().then(async () => {
  try {
    const { tryLocalCommand } = require("../dist/main/command/router.js");
    const result = await tryLocalCommand("你看一下微信为什么打不开了");

    console.log(JSON.stringify({ action: result.action, message: result.message }));
    assert.equal(result.handled, true, "diagnostic request must be handled locally");
    assert.equal(result.action, "diagnose:application", "diagnostic request must not use an open action");
    assert.ok(result.message?.includes("没有尝试启动"), "diagnostic response must explicitly state that it did not launch the app");

    const { executeTool } = require("../dist/main/control/windows.js");
    const toolResult = await executeTool("diagnose_application", JSON.stringify({ name: "微信" }));
    assert.ok(toolResult.includes("没有尝试启动"), "LLM diagnostic tool must remain read-only");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
