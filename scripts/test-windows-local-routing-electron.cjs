#!/usr/bin/env node
const { app } = require("electron");

app.whenReady().then(async () => {
  try {
    const { tryLocalCommand } = require("../dist/main/command/router.js");
    const inputs = [
      "打开B站",
      "打开B站官网",
      "在B站搜索黑神话",
      "打开抖音",
      "打开淘宝",
      "打开GitHub",
      "打开微信",
      "打开计算器",
      "打开绝不存在的虚构应用",
    ];
    for (const input of inputs) {
      const result = await tryLocalCommand(input);
      console.log(JSON.stringify({ input, handled: result.handled, action: result.action, hasMessage: Boolean(result.message) }));
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
