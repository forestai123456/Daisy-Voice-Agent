#!/usr/bin/env node
const assert = require("node:assert/strict");

const {
  findKnownSiteHome,
  parseAppDiagnosisRequest,
  parseKnownSiteSearch,
} = require("../dist/main/command/router.js");
const {
  matchWindowsAppTargets,
} = require("../dist/main/control/windowsAppResolver.js");

const targets = [
  {
    kind: "shortcut",
    displayName: "WeChat",
    filePath: "C:\\mock\\WeChat.lnk",
    aliases: ["wechat", "微信", "weixin"],
  },
  {
    kind: "exe",
    displayName: "Code",
    filePath: "C:\\mock\\Code.exe",
    aliases: ["code", "vscode", "vs code", "visual studio code", "代码编辑器"],
  },
  {
    kind: "uwp",
    displayName: "Discord",
    appUserModelId: "Discord.Discord",
    aliases: ["discord"],
  },
];

const bSearch = parseKnownSiteSearch("打开 B站官网 搜 黑神话");
assert.ok(bSearch, "B站站内搜索必须被识别");
assert.equal(bSearch.siteName, "哔哩哔哩");
assert.equal(bSearch.url, "https://search.bilibili.com/all?keyword=%E9%BB%91%E7%A5%9E%E8%AF%9D");

const bHome = findKnownSiteHome("B站官方网站");
assert.ok(bHome, "B站官网必须在通用官网词之前命中");
assert.equal(bHome.url, "https://www.bilibili.com/");

const wechat = matchWindowsAppTargets("微信", targets);
assert.equal(wechat.found, true);
assert.equal(wechat.match, "alias");
assert.equal(wechat.target.displayName, "WeChat");

const code = matchWindowsAppTargets("Visual Studio Code", targets);
assert.equal(code.found, true);
assert.equal(code.match, "alias");
assert.equal(code.target.displayName, "Code");

const discord = matchWindowsAppTargets("discordd", targets);
assert.equal(discord.found, true);
assert.equal(discord.match, "fuzzy");
assert.equal(discord.target.kind, "uwp");

const calculator = matchWindowsAppTargets("计算器", []);
assert.equal(calculator.found, true);
assert.equal(calculator.match, "system");
assert.equal(calculator.target.kind, "system");

const unknown = matchWindowsAppTargets("绝不存在的虚构应用", targets);
assert.deepEqual(unknown, { found: false, reason: "not-found" });

assert.equal(parseAppDiagnosisRequest("你看一下微信为什么打不开了"), "微信");
assert.equal(parseAppDiagnosisRequest("帮我排查一下 WeChat 启动不了"), "WeChat");
assert.equal(parseAppDiagnosisRequest("帮我看看我的微信为什么打不开"), "微信");
assert.equal(parseAppDiagnosisRequest("微信打不开了怎么回事"), "微信");
assert.equal(parseAppDiagnosisRequest("打开微信"), null, "explicit open request must not become a diagnosis");

console.log("Windows local routing tests passed");
