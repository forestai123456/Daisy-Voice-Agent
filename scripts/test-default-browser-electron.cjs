#!/usr/bin/env node
const assert = require("node:assert/strict");
const { app } = require("electron");

app.whenReady().then(async () => {
  try {
    const { DEFAULT_BROWSER_LAUNCH_URL, openDefaultBrowser } = require("../dist/main/control/openExternal.js");
    const openedUrl = await openDefaultBrowser();
    assert.equal(openedUrl, DEFAULT_BROWSER_LAUNCH_URL);
    console.log(`Default browser launch request completed: ${openedUrl}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    setTimeout(() => app.quit(), 300);
  }
});
