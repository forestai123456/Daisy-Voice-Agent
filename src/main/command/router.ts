import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { log, logError } from "../utils/logger";
import { getBundledBin } from "../config/env";

const execAsync = promisify(exec);

function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("osascript", [], (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
    child.stdin?.write(script);
    child.stdin?.end();
  });
}

export interface AppEntry {
  name: string;       // display name without .app
  path: string;        // full path to .app
  aliases: string[];   // lowercase aliases for matching
}

const APP_DIRS = [
  "/Applications",
  "/System/Applications",
  "/System/Applications/Utilities",
  path.join(process.env.HOME || "", "Applications"),
  "/Volumes/外接盘/Applications",
];

let appCache: AppEntry[] = [];
let lastScanTime = 0;
const SCAN_INTERVAL_MS = 30 * 60 * 1000; // rescan every 30 minutes

function scanApps(): AppEntry[] {
  const apps: AppEntry[] = [];
  const seen = new Set<string>();

  for (const dir of APP_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (!entry.endsWith(".app")) continue;
        const fullPath = path.join(dir, entry);
        const name = entry.replace(/\.app$/, "");
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const aliases = generateAliases(name);
        apps.push({ name, path: fullPath, aliases });
      }
    } catch {
      // ignore
    }
  }

  log(`CommandRouter: scanned ${apps.length} apps`);
  // Debug: check if specific apps are in cache
  const debugApps = ["lark", "wechat", "qqmusic"];
  for (const dbg of debugApps) {
    const found = apps.find(a => a.name.toLowerCase() === dbg);
    log(`CommandRouter: cache check "${dbg}" → ${found ? `found (${found.name}, aliases: ${found.aliases.join(",")})` : "NOT FOUND"}`);
  }
  return apps;
}

function generateAliases(name: string): string[] {
  const aliases = new Set<string>();
  const lower = name.toLowerCase();
  aliases.add(lower);

  // Remove spaces
  aliases.add(lower.replace(/\s+/g, ""));

  // Common Chinese names for popular apps
  const cnMap: Record<string, string[]> = {
    "wechat": ["微信"],
    "google chrome": ["谷歌浏览器", "chrome", "谷歌", "浏览器chrome"],
    "safari": ["safari浏览器", "苹果浏览器"],
    "terminal": ["终端"],
    "finder": ["访达"],
    "notes": ["备忘录"],
    "reminders": ["提醒事项"],
    "calendar": ["日历"],
    "contacts": ["通讯录", "联系人"],
    "clock": ["时钟", "闹钟"],
    "stocks": ["股票"],
    "maps": ["地图"],
    "music": ["apple音乐", "苹果音乐"],
    "qqmusic": ["qq音乐", "QQ音乐", "qq 音乐"],
    "photos": ["照片", "相册"],
    "messages": ["信息", "短信"],
    "mail": ["邮件", "邮箱"],
    "app store": ["应用商店"],
    "system settings": ["系统设置", "设置"],
    "calculator": ["计算器"],
    "preview": ["预览"],
    "textedit": ["文本编辑"],
    "quicktime player": ["播放器", "quicktime"],
    "logic pro": ["音频编辑", "logic"],
    "final cut pro": ["视频剪辑", "fcp", "final cut"],
    "cursor": ["光标编辑器"],
    "visual studio code": ["代码编辑器", "vscode", "vs code", "code"],
    "discord": ["迪斯科"],
    "spotify": ["音乐播放器"],
    "notion": ["笔记应用"],
    "figma": ["设计工具"],
    "slack": ["办公通讯"],
    "zoom": ["视频会议"],
    "pages": ["文档", "文稿"],
    "numbers": ["表格"],
    "keynote": ["演示文稿", "ppt"],
    "imovie": ["视频编辑"],
    "garageband": ["音乐制作"],
    "doubaoime": ["豆包输入法"],
    "doubao": ["豆包", "豆包app", "豆包ai"],
    "bluetooth": ["蓝牙"],
    "activity monitor": ["活动监视器"],
    "screenshot": ["截图"],
    "stickies": ["便签", "便利贴"],
    "videofusion-macos": ["剪映", "capcut", "jianying"],
    "qq": ["腾讯qq", "qq聊天"],
    "lark": ["飞书", "larksuite"],
    "codex": ["codex", "openai codex"],
    "telegram": ["电报"],
    "bilibili": ["b站", "哔哩哔哩", "b 站"],
    "xcode": ["开发者工具"],
    "android studio": ["安卓开发"],
    "docker": ["容器"],
    "postman": ["接口测试"],
    "obs": ["直播软件", "录屏"],
    "claude": ["克劳德"],
    "chatgpt": ["gpt", "chat gpt"],
    "opencode": ["open code", "opencode"],
    "douyin": ["抖音", "tiktok"],
    "baidunetdisk": ["百度网盘", "百度云", "百度云盘"],
    "netease cloudmusic": ["网易云音乐", "网易云"],
    "qq音乐": ["qq音乐"],
  };

  const lowerKey = lower;
  if (cnMap[lowerKey]) {
    for (const alias of cnMap[lowerKey]) {
      aliases.add(alias.toLowerCase());
    }
  }

  return Array.from(aliases);
}

function ensureCache(): void {
  const now = Date.now();
  if (appCache.length === 0 || now - lastScanTime > SCAN_INTERVAL_MS) {
    appCache = scanApps();
    lastScanTime = now;
  }
}

export function matchApp(target: string): AppEntry | null {
  ensureCache();
  const targetLower = target.toLowerCase().trim();

  // 1. Exact alias match (highest priority)
  for (const app of appCache) {
    if (app.aliases.includes(targetLower)) return app;
  }

  // 2. Exact app name match
  for (const app of appCache) {
    if (app.name.toLowerCase() === targetLower) return app;
  }

  // 3. Target is a prefix of app name or vice versa (e.g. "chrome" → "Google Chrome")
  //    Only if target length >= 3 to avoid "qq" matching "qqmusic"
  if (targetLower.length >= 3) {
    for (const app of appCache) {
      const appNameLower = app.name.toLowerCase();
      if (appNameLower.includes(targetLower) || targetLower.includes(appNameLower)) {
        // But don't match if target is a substring that's too short relative to app name
        const ratio = targetLower.length / appNameLower.length;
        if (ratio > 0.4 || targetLower.length >= 4) {
          return app;
        }
      }
    }
  }

  // 4. Check aliases for substring match (e.g. "飞书" in alias list)
  for (const app of appCache) {
    for (const alias of app.aliases) {
      if (alias.length < 2) continue;
      if (alias === targetLower) return app;
      // Only match if lengths are similar
      if (Math.abs(alias.length - targetLower.length) <= 2 && alias.length >= 2) {
        if (alias.includes(targetLower) || targetLower.includes(alias)) {
          return app;
        }
      }
    }
  }

  return null;
}

export interface CommandResult {
  handled: boolean;
  action?: string;
}

interface KnownSiteSearch {
  siteName: string;
  url: string;
  query: string;
}

interface SiteSearchProvider {
  siteName: string;
  aliases: string[];
  buildUrl: (query: string) => string;
  homeUrl?: string;
}

const SITE_SEARCH_PROVIDERS: SiteSearchProvider[] = [
  // 国内内容、资讯与购物
  { siteName: "抖音", aliases: ["抖音", "douyin"], buildUrl: q => `https://www.douyin.com/search/${encodeURIComponent(q)}`, homeUrl: "https://www.douyin.com/" },
  { siteName: "微博", aliases: ["微博", "weibo"], buildUrl: q => `https://s.weibo.com/weibo?q=${encodeURIComponent(q)}`, homeUrl: "https://weibo.com/" },
  { siteName: "哔哩哔哩", aliases: ["哔哩哔哩", "b站", "b 站", "bilibili"], buildUrl: q => `https://search.bilibili.com/all?keyword=${encodeURIComponent(q)}`, homeUrl: "https://www.bilibili.com/" },
  { siteName: "小红书", aliases: ["小红书", "xiaohongshu", "rednote"], buildUrl: q => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}`, homeUrl: "https://www.xiaohongshu.com/" },
  { siteName: "知乎", aliases: ["知乎", "zhihu"], buildUrl: q => `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(q)}` },
  { siteName: "百度", aliases: ["百度", "baidu"], buildUrl: q => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`, homeUrl: "https://www.baidu.com/" },
  { siteName: "豆瓣", aliases: ["豆瓣", "douban"], buildUrl: q => `https://www.douban.com/search?q=${encodeURIComponent(q)}` },
  { siteName: "淘宝", aliases: ["淘宝", "taobao"], buildUrl: q => `https://s.taobao.com/search?q=${encodeURIComponent(q)}` },
  { siteName: "京东", aliases: ["京东", "jd"], buildUrl: q => `https://search.jd.com/Search?keyword=${encodeURIComponent(q)}` },
  { siteName: "腾讯视频", aliases: ["腾讯视频", "qq视频", "tencentvideo"], buildUrl: q => `https://v.qq.com/x/search/?q=${encodeURIComponent(q)}`, homeUrl: "https://v.qq.com/" },
  { siteName: "爱奇艺", aliases: ["爱奇艺", "iqiyi"], buildUrl: q => `https://so.iqiyi.com/so/q_${encodeURIComponent(q)}`, homeUrl: "https://www.iqiyi.com/" },
  { siteName: "网易云音乐", aliases: ["网易云音乐", "网易云", "neteasecloudmusic"], buildUrl: q => `https://music.163.com/#/search/m/?s=${encodeURIComponent(q)}&type=1`, homeUrl: "https://music.163.com/" },
  { siteName: "QQ 音乐", aliases: ["qq音乐", "qqmusic"], buildUrl: q => `https://y.qq.com/n/ryqq/search?w=${encodeURIComponent(q)}`, homeUrl: "https://y.qq.com/" },
  { siteName: "掘金", aliases: ["掘金", "juejin"], buildUrl: q => `https://juejin.cn/search?query=${encodeURIComponent(q)}` },
  { siteName: "CSDN", aliases: ["csdn"], buildUrl: q => `https://so.csdn.net/so/search?q=${encodeURIComponent(q)}` },

  // 国内综合搜索、新闻与科技媒体
  { siteName: "搜狗", aliases: ["搜狗", "sogou"], buildUrl: q => `https://www.sogou.com/web?query=${encodeURIComponent(q)}` },
  { siteName: "360 搜索", aliases: ["360搜索", "360", "so"], buildUrl: q => `https://www.so.com/s?q=${encodeURIComponent(q)}` },
  { siteName: "今日头条", aliases: ["今日头条", "头条", "toutiao"], buildUrl: q => `https://so.toutiao.com/search?keyword=${encodeURIComponent(q)}` },
  { siteName: "凤凰网", aliases: ["凤凰网", "凤凰", "ifeng"], buildUrl: q => `https://search.ifeng.com/sofeng/search.action?q=${encodeURIComponent(q)}` },
  { siteName: "澎湃新闻", aliases: ["澎湃", "澎湃新闻", "thepaper"], buildUrl: q => `https://www.thepaper.cn/searchResult.jsp?searchWord=${encodeURIComponent(q)}` },
  { siteName: "36氪", aliases: ["36氪", "36kr"], buildUrl: q => `https://search.36kr.com/search/articles/${encodeURIComponent(q)}` },
  { siteName: "虎嗅", aliases: ["虎嗅", "huxiu"], buildUrl: q => `https://www.huxiu.com/search.html?query=${encodeURIComponent(q)}` },
  { siteName: "IT之家", aliases: ["it之家", "ithome"], buildUrl: q => `https://www.ithome.com/search/?q=${encodeURIComponent(q)}` },
  { siteName: "少数派", aliases: ["少数派", "sspai"], buildUrl: q => `https://sspai.com/search/post/${encodeURIComponent(q)}` },
  { siteName: "钛媒体", aliases: ["钛媒体", "tmtpost"], buildUrl: q => `https://www.tmtpost.com/search?keyword=${encodeURIComponent(q)}` },
  { siteName: "雷锋网", aliases: ["雷锋网", "leiphone"], buildUrl: q => `https://www.leiphone.com/search?query=${encodeURIComponent(q)}` },
  { siteName: "机器之心", aliases: ["机器之心", "jiqizhixin"], buildUrl: q => `https://www.jiqizhixin.com/search?q=${encodeURIComponent(q)}` },

  // 国内财经、股票与企业信息
  { siteName: "东方财富", aliases: ["东方财富", "eastmoney"], buildUrl: q => `https://so.eastmoney.com/web/s?keyword=${encodeURIComponent(q)}` },
  { siteName: "同花顺", aliases: ["同花顺", "10jqka"], buildUrl: q => `https://search.10jqka.com.cn/?keyword=${encodeURIComponent(q)}` },
  { siteName: "雪球", aliases: ["雪球", "xueqiu"], buildUrl: q => `https://xueqiu.com/k?q=${encodeURIComponent(q)}` },
  { siteName: "新浪财经", aliases: ["新浪财经", "sina财经", "sinafinance"], buildUrl: q => `https://search.sina.com.cn/?q=${encodeURIComponent(q)}&range=all&c=news&sort=time` },
  { siteName: "财联社", aliases: ["财联社", "cls"], buildUrl: q => `https://www.cls.cn/searchPage?keyword=${encodeURIComponent(q)}` },
  { siteName: "第一财经", aliases: ["第一财经", "yicai"], buildUrl: q => `https://www.yicai.com/search?keyword=${encodeURIComponent(q)}` },
  { siteName: "证券时报", aliases: ["证券时报", "stcn"], buildUrl: q => `https://search.stcn.com/?q=${encodeURIComponent(q)}` },
  { siteName: "巨潮资讯", aliases: ["巨潮资讯", "cninfo"], buildUrl: q => `https://www.cninfo.com.cn/new/fulltextSearch?keyWord=${encodeURIComponent(q)}` },
  { siteName: "天眼查", aliases: ["天眼查", "tianyancha"], buildUrl: q => `https://www.tianyancha.com/search?key=${encodeURIComponent(q)}` },

  // 国内论文、资料、医学与法律
  { siteName: "百度学术", aliases: ["百度学术", "xueshu"], buildUrl: q => `https://xueshu.baidu.com/s?wd=${encodeURIComponent(q)}` },
  { siteName: "中国知网", aliases: ["中国知网", "知网", "cnki"], buildUrl: q => `https://kns.cnki.net/kns8s/defaultresult/index?kw=${encodeURIComponent(q)}` },
  { siteName: "万方数据", aliases: ["万方", "万方数据", "wanfang"], buildUrl: q => `https://s.wanfangdata.com.cn/paper?q=${encodeURIComponent(q)}` },
  { siteName: "国家哲学社会科学文献中心", aliases: ["哲学社会科学文献中心", "国家社科文献中心", "ncpssd"], buildUrl: q => `https://www.ncpssd.org/Literature/search?searchType=0&searchWord=${encodeURIComponent(q)}` },
  { siteName: "国家图书馆", aliases: ["国家图书馆", "国图", "nlc"], buildUrl: q => `https://find.nlc.cn/search?query=${encodeURIComponent(q)}` },
  { siteName: "丁香园", aliases: ["丁香园", "dxy", "用药助手"], buildUrl: q => `https://drugs.dxy.cn/search?keyword=${encodeURIComponent(q)}` },
  { siteName: "医脉通", aliases: ["医脉通", "medlive"], buildUrl: q => `https://so.medlive.cn/?q=${encodeURIComponent(q)}` },
  { siteName: "好大夫在线", aliases: ["好大夫", "好大夫在线", "haodf"], buildUrl: q => `https://www.haodf.com/search?q=${encodeURIComponent(q)}` },
  { siteName: "春雨医生", aliases: ["春雨医生", "春雨", "chunyuyisheng"], buildUrl: q => `https://www.chunyuyisheng.com/pc/search/?keyword=${encodeURIComponent(q)}` },
  { siteName: "北大法宝", aliases: ["北大法宝", "法宝", "pkulaw"], buildUrl: q => `https://www.pkulaw.com/Search?keyword=${encodeURIComponent(q)}` },

  // 国内求职、出行、汽车、房产与学习
  { siteName: "BOSS直聘", aliases: ["boss直聘", "boss", "zhipin"], buildUrl: q => `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(q)}` },
  { siteName: "猎聘", aliases: ["猎聘", "liepin"], buildUrl: q => `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(q)}` },
  { siteName: "智联招聘", aliases: ["智联招聘", "智联", "zhaopin"], buildUrl: q => `https://sou.zhaopin.com/?kw=${encodeURIComponent(q)}` },
  { siteName: "前程无忧", aliases: ["前程无忧", "51job"], buildUrl: q => `https://we.51job.com/pc/search?keyword=${encodeURIComponent(q)}` },
  { siteName: "携程", aliases: ["携程", "ctrip"], buildUrl: q => `https://s.ctrip.com/?keyword=${encodeURIComponent(q)}` },
  { siteName: "马蜂窝", aliases: ["马蜂窝", "mafengwo"], buildUrl: q => `https://www.mafengwo.cn/search/q.php?q=${encodeURIComponent(q)}` },
  { siteName: "穷游", aliases: ["穷游", "qyer"], buildUrl: q => `https://www.qyer.com/search/qsite?wd=${encodeURIComponent(q)}` },
  { siteName: "汽车之家", aliases: ["汽车之家", "autohome"], buildUrl: q => `https://sou.autohome.com.cn/zonghe?q=${encodeURIComponent(q)}` },
  { siteName: "懂车帝", aliases: ["懂车帝", "dongchedi"], buildUrl: q => `https://www.dongchedi.com/search?keyword=${encodeURIComponent(q)}` },
  { siteName: "易车", aliases: ["易车", "yiche"], buildUrl: q => `https://so.yiche.com/?keyword=${encodeURIComponent(q)}` },
  { siteName: "贝壳找房", aliases: ["贝壳找房", "贝壳", "ke"], buildUrl: q => `https://www.ke.com/s/${encodeURIComponent(q)}` },
  { siteName: "安居客", aliases: ["安居客", "anjuke"], buildUrl: q => `https://www.anjuke.com/s/?kw=${encodeURIComponent(q)}` },
  { siteName: "中国大学MOOC", aliases: ["中国大学mooc", "慕课", "icourse163"], buildUrl: q => `https://www.icourse163.org/search.htm?search=${encodeURIComponent(q)}` },
  { siteName: "学堂在线", aliases: ["学堂在线", "xuetang"], buildUrl: q => `https://www.xuetangx.com/search?query=${encodeURIComponent(q)}` },
  { siteName: "微信读书", aliases: ["微信读书", "weread"], buildUrl: q => `https://weread.qq.com/web/search/books?keyword=${encodeURIComponent(q)}` },

  // 国内生活、设计与开源社区
  { siteName: "什么值得买", aliases: ["什么值得买", "值得买", "smzdm"], buildUrl: q => `https://search.smzdm.com/?c=home&s=${encodeURIComponent(q)}` },
  { siteName: "下厨房", aliases: ["下厨房", "xiachufang"], buildUrl: q => `https://www.xiachufang.com/search/?keyword=${encodeURIComponent(q)}` },
  { siteName: "花瓣", aliases: ["花瓣", "huaban"], buildUrl: q => `https://huaban.com/search?q=${encodeURIComponent(q)}` },
  { siteName: "站酷", aliases: ["站酷", "zcool"], buildUrl: q => `https://www.zcool.com.cn/search/content?word=${encodeURIComponent(q)}` },
  { siteName: "Gitee", aliases: ["gitee", "码云"], buildUrl: q => `https://search.gitee.com/?q=${encodeURIComponent(q)}` },

  // 国内娱乐：短视频、长视频、短剧、小说与播客
  { siteName: "快手", aliases: ["快手", "kuaishou"], buildUrl: q => `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(q)}`, homeUrl: "https://www.kuaishou.com/" },
  { siteName: "西瓜视频", aliases: ["西瓜视频", "西瓜", "ixigua"], buildUrl: q => `https://www.ixigua.com/search/${encodeURIComponent(q)}`, homeUrl: "https://www.ixigua.com/" },
  { siteName: "优酷", aliases: ["优酷", "youku"], buildUrl: q => `https://so.youku.com/search_video/q_${encodeURIComponent(q)}`, homeUrl: "https://www.youku.com/" },
  { siteName: "芒果TV", aliases: ["芒果tv", "芒果", "mgtv"], buildUrl: q => `https://so.mgtv.com/so?k=${encodeURIComponent(q)}`, homeUrl: "https://www.mgtv.com/" },
  { siteName: "搜狐视频", aliases: ["搜狐视频", "搜狐", "sohutv"], buildUrl: q => `https://so.tv.sohu.com/mts?wd=${encodeURIComponent(q)}`, homeUrl: "https://tv.sohu.com/" },
  { siteName: "央视网", aliases: ["央视网", "央视", "cctv"], buildUrl: q => `https://search.cctv.com/search.php?qtext=${encodeURIComponent(q)}`, homeUrl: "https://www.cctv.com/" },
  { siteName: "番茄小说", aliases: ["番茄小说", "番茄", "fanqienovel"], buildUrl: q => `https://fanqienovel.com/search/${encodeURIComponent(q)}`, homeUrl: "https://fanqienovel.com/" },
  { siteName: "起点中文网", aliases: ["起点", "起点中文网", "qidian"], buildUrl: q => `https://www.qidian.com/search?kw=${encodeURIComponent(q)}`, homeUrl: "https://www.qidian.com/" },
  { siteName: "晋江文学城", aliases: ["晋江", "晋江文学城", "jjwxc"], buildUrl: q => `https://www.jjwxc.net/search.php?kw=${encodeURIComponent(q)}`, homeUrl: "https://www.jjwxc.net/" },
  { siteName: "纵横中文网", aliases: ["纵横", "纵横中文网", "zongheng"], buildUrl: q => `https://search.zongheng.com/s?keyword=${encodeURIComponent(q)}`, homeUrl: "https://www.zongheng.com/" },
  { siteName: "七猫小说", aliases: ["七猫", "七猫小说", "qimao"], buildUrl: q => `https://www.qimao.com/search/?keyword=${encodeURIComponent(q)}`, homeUrl: "https://www.qimao.com/" },
  { siteName: "QQ阅读", aliases: ["qq阅读", "qqread"], buildUrl: q => `https://book.qq.com/search.html?keyword=${encodeURIComponent(q)}`, homeUrl: "https://book.qq.com/" },
  { siteName: "小宇宙", aliases: ["小宇宙", "xiaoyuzhou"], buildUrl: q => `https://www.xiaoyuzhoufm.com/search?q=${encodeURIComponent(q)}`, homeUrl: "https://www.xiaoyuzhoufm.com/" },
  { siteName: "喜马拉雅", aliases: ["喜马拉雅", "ximalaya"], buildUrl: q => `https://www.ximalaya.com/search/${encodeURIComponent(q)}/`, homeUrl: "https://www.ximalaya.com/" },
  { siteName: "蜻蜓FM", aliases: ["蜻蜓fm", "蜻蜓", "qtfm"], buildUrl: q => `https://www.qtfm.cn/search?keyword=${encodeURIComponent(q)}`, homeUrl: "https://www.qtfm.cn/" },
  { siteName: "荔枝FM", aliases: ["荔枝fm", "荔枝", "lizhi"], buildUrl: q => `https://www.lizhi.fm/search?keyword=${encodeURIComponent(q)}`, homeUrl: "https://www.lizhi.fm/" },

  // 国内新一代搜索入口与内容检索
  { siteName: "夸克", aliases: ["夸克", "quark"], buildUrl: q => `https://quark.sm.cn/s?q=${encodeURIComponent(q)}`, homeUrl: "https://quark.sm.cn/" },
  { siteName: "神马搜索", aliases: ["神马", "神马搜索", "shenma"], buildUrl: q => `https://m.sm.cn/s?q=${encodeURIComponent(q)}`, homeUrl: "https://m.sm.cn/" },
  { siteName: "微信搜一搜", aliases: ["微信搜一搜", "搜一搜", "微信文章"], buildUrl: q => `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(q)}`, homeUrl: "https://weixin.sogou.com/" },
  { siteName: "百度贴吧", aliases: ["百度贴吧", "贴吧", "tieba"], buildUrl: q => `https://tieba.baidu.com/f/search/res?ie=utf-8&qw=${encodeURIComponent(q)}`, homeUrl: "https://tieba.baidu.com/" },
  { siteName: "秘塔AI搜索", aliases: ["秘塔", "秘塔ai", "metaso"], buildUrl: q => `https://metaso.cn/?q=${encodeURIComponent(q)}`, homeUrl: "https://metaso.cn/" },

  // 国际搜索、社区与购物
  { siteName: "Google", aliases: ["google", "谷歌"], buildUrl: q => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  { siteName: "Bing", aliases: ["bing", "必应"], buildUrl: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  { siteName: "YouTube", aliases: ["youtube", "油管"], buildUrl: q => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` },
  { siteName: "TikTok", aliases: ["tiktok"], buildUrl: q => `https://www.tiktok.com/search?q=${encodeURIComponent(q)}` },
  { siteName: "X", aliases: ["x", "推特", "twitter"], buildUrl: q => `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query` },
  { siteName: "Reddit", aliases: ["reddit"], buildUrl: q => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}` },
  { siteName: "维基百科", aliases: ["维基百科", "维基", "wikipedia"], buildUrl: q => `https://zh.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}` },
  { siteName: "GitHub", aliases: ["github"], buildUrl: q => `https://github.com/search?q=${encodeURIComponent(q)}` },
  { siteName: "Stack Overflow", aliases: ["stackoverflow"], buildUrl: q => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}` },
  { siteName: "Amazon", aliases: ["amazon", "亚马逊"], buildUrl: q => `https://www.amazon.com/s?k=${encodeURIComponent(q)}` },
  { siteName: "eBay", aliases: ["ebay"], buildUrl: q => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}` },
  { siteName: "Steam", aliases: ["steam"], buildUrl: q => `https://store.steampowered.com/search/?term=${encodeURIComponent(q)}` },
];

// These services have a useful web entry point but do not expose a stable
// public URL for keyword search. They still support a deterministic "打开…".
const SITE_HOME_ONLY_PROVIDERS = [
  { siteName: "视频号", aliases: ["视频号", "微信视频号"], homeUrl: "https://channels.weixin.qq.com/" },
  { siteName: "红果免费短剧", aliases: ["红果", "红果短剧", "红果影视", "红果免费短剧"], homeUrl: "https://www.hongguoduanju.com/" },
  { siteName: "河马剧场", aliases: ["河马剧场", "河马短剧"], homeUrl: "https://www.kuaikaw.cn/" },
  { siteName: "Kimi", aliases: ["kimi"], homeUrl: "https://kimi.moonshot.cn/" },
  { siteName: "豆包", aliases: ["豆包", "doubao"], homeUrl: "https://www.doubao.com/" },
  { siteName: "腾讯元宝", aliases: ["腾讯元宝", "元宝"], homeUrl: "https://yuanbao.tencent.com/" },
] as const;

function normalizeSiteName(name: string): string {
  return name.toLowerCase().replace(/[\s·.（）()]/g, "");
}

function escapeSiteAliasForRegex(alias: string): string {
  return alias
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s*");
}

// Match the complete site alias before the "搜索" verb. This matters for
// providers such as "微信搜一搜", whose name itself contains the character “搜”.
const SITE_SEARCH_ALIAS_PATTERN = SITE_SEARCH_PROVIDERS
  .flatMap((provider) => provider.aliases)
  .sort((a, b) => b.length - a.length)
  .map(escapeSiteAliasForRegex)
  .join("|");

function findSiteSearchProvider(name: string): SiteSearchProvider | null {
  const siteKey = normalizeSiteName(name);
  return SITE_SEARCH_PROVIDERS.find((candidate) =>
    candidate.aliases.some((alias) => normalizeSiteName(alias) === siteKey)
  ) ?? null;
}

/**
 * Match short, unambiguous "open a site and search" voice commands locally.
 *
 * These commands used to fall through to the LLM.  If the model interpreted
 * the complete phrase (for example "抖音搜索世界杯") as an application name,
 * it could only open the browser and perform a generic web search instead of
 * navigating to the requested site's search page.
 */
export function parseKnownSiteSearch(text: string): KnownSiteSearch | null {
  const normalized = text.trim().replace(/[\s,，。！!？?、~]+$/, "");
  const match = normalized.match(new RegExp(
    `^(?:帮我|麻烦|请)?\\s*(?:(?:在|用)?\\s*浏览器\\s*(?:里|中|上)?\\s*)?(?:(?:打开|启动|开启|运行|开一下|进入|访问)\\s*)?(?:在\\s*)?(${SITE_SEARCH_ALIAS_PATTERN})\\s*(?:网站|官网)?\\s*(?:上|里|中)?\\s*[，,、]?\\s*(?:(?:然后|再|并且|并)\\s*)?(?:搜索|搜)\\s*(?:一下)?\\s*(.+)$`,
    "i"
  ));

  if (!match) return null;

  const [, rawSiteName, rawQuery] = match;
  const provider = findSiteSearchProvider(rawSiteName);
  if (!provider) return null;

  const query = rawQuery.trim().replace(/[\s,，。！!？?、~]+$/, "");
  if (!query) return null;

  return {
    siteName: provider.siteName,
    query,
    url: provider.buildUrl(query),
  };
}

export function findKnownSiteHome(name: string): { siteName: string; url: string } | null {
  const searchProvider = findSiteSearchProvider(name);
  if (searchProvider?.homeUrl) {
    return { siteName: searchProvider.siteName, url: searchProvider.homeUrl };
  }

  const siteKey = normalizeSiteName(name);
  const homeOnlyProvider = SITE_HOME_ONLY_PROVIDERS.find((candidate) =>
    candidate.aliases.some((alias) => normalizeSiteName(alias) === siteKey)
  );
  return homeOnlyProvider
    ? { siteName: homeOnlyProvider.siteName, url: homeOnlyProvider.homeUrl }
    : null;
}

async function openKnownSiteSearch(search: KnownSiteSearch): Promise<CommandResult> {
  // This is specifically a website search command, so always navigate the
  // default browser to the site's own results page.  It does not depend on
  // an LLM decision or on a native app being installed.
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("open", [search.url], (error) => error ? reject(error) : resolve());
    });
    log(`CommandRouter: opened ${search.siteName} search for "${search.query}"`);
    return { handled: true, action: `search:${search.siteName}:${search.query}` };
  } catch (error) {
    logError(`CommandRouter: failed to open ${search.siteName} search`, error);
    return { handled: false };
  }
}

async function openKnownSiteHome(site: { siteName: string; url: string }): Promise<CommandResult> {
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("open", [site.url], (error) => error ? reject(error) : resolve());
    });
    log(`CommandRouter: opened ${site.siteName} home page`);
    return { handled: true, action: `open-site:${site.siteName}` };
  } catch (error) {
    logError(`CommandRouter: failed to open ${site.siteName} home page`, error);
    return { handled: false };
  }
}

async function openApp(name: string): Promise<CommandResult> {
  const isBrowserKeyword = ["browser", "默认浏览器", "浏览器", "default_browser", "default browser"].includes(name.trim().toLowerCase());
  
  if (isBrowserKeyword) {
    try {
      const { getDefaultBrowserBundleId } = require("../control/macos");
      const bundleId = await getDefaultBrowserBundleId();
      await execAsync(`open -b "${bundleId}"`);
      log(`CommandRouter: opened default browser (${bundleId})`);
      return { handled: true, action: `open:browser` };
    } catch (e) {
      log(`CommandRouter: failed to open default browser, falling back to matchApp`);
    }
  }

  const app = matchApp(name);
  if (!app) {
    log(`CommandRouter: openApp("${name}") — no match found in ${appCache.length} apps`);
    return { handled: false };
  }
  try {
    await execAsync(`open -a "${app.path}"`);
    log(`CommandRouter: opened ${app.name} (${app.path})`);
    return { handled: true, action: `open:${app.name}` };
  } catch {
    return { handled: false };
  }
}

const BROWSER_APP_NAMES = [
  "Google Chrome", "Safari", "Firefox", "Microsoft Edge",
  "Opera", "Brave Browser", "Arc", "Vivaldi", "Chromium",
];

async function quitAllBrowsers(): Promise<CommandResult> {
  let quitCount = 0;
  for (const browserName of BROWSER_APP_NAMES) {
    try {
      // Check if the app is running before trying to quit
      const { stdout } = await execAsync(
        `osascript -e 'tell application "System Events" to (name of every process) contains "${browserName}"'`
      );
      if (stdout.trim() === "true") {
        await execAsync(`osascript -e 'tell application "${browserName}" to quit'`);
        quitCount++;
        log(`CommandRouter: quit browser ${browserName}`);
      }
    } catch {
      // App not installed or not running, skip
    }
  }
  if (quitCount > 0) {
    return { handled: true, action: `quit:browsers(${quitCount})` };
  }
  return { handled: false };
}

async function quitApp(name: string): Promise<CommandResult> {
  // Special case: "浏览器" → quit ALL running browsers
  if (name === "浏览器" || name === "browser" || name === "browsers") {
    return await quitAllBrowsers();
  }

  const app = matchApp(name);
  if (!app) {
    log(`CommandRouter: quitApp("${name}") — no match found in ${appCache.length} apps`);
    return { handled: false };
  }

  const bundleName = path.basename(app.path, ".app");

  // Step 1: Try AppleScript quit (graceful)
  try {
    await execAsync(`osascript -e 'tell application "${app.name}" to quit'`, { timeout: 3000 });
  } catch {
    // AppleScript failed — will try kill below
  }

  // Step 2: Wait briefly, check if process still running
  await new Promise(r => setTimeout(r, 300));
  try {
    const { stdout: stillRunning } = await execAsync(`pgrep -x "${bundleName}" 2>/dev/null || true`, { timeout: 2000 });
    if (!stillRunning.trim()) {
      log(`CommandRouter: quit ${app.name} (AppleScript)`);
      return { handled: true, action: `quit:${app.name}` };
    }
  } catch {
    // pgrep failed — assume not running
    log(`CommandRouter: quit ${app.name} (AppleScript)`);
    return { handled: true, action: `quit:${app.name}` };
  }

  // Step 3: Process still running — force kill
  try {
    await execAsync(`pkill -x "${bundleName}"`, { timeout: 3000 });
    log(`CommandRouter: quit ${app.name} (kill - fallback)`);
    return { handled: true, action: `quit:${app.name}` };
  } catch {
    log(`CommandRouter: failed to quit ${app.name}`);
    return { handled: false };
  }
}

async function setVolume(direction: "up" | "down" | "mute"): Promise<CommandResult> {
  try {
    if (direction === "mute") {
      await execAsync(`osascript -e 'set volume with output muted'`);
    } else {
      // Get current volume
      const { stdout } = await execAsync(`osascript -e 'output volume of (get volume settings)'`);
      let vol = parseInt(stdout.trim(), 10);
      vol = direction === "up" ? Math.min(100, vol + 10) : Math.max(0, vol - 10);
      await execAsync(`osascript -e 'set volume ${vol}'`);
    }
    log(`CommandRouter: volume ${direction}`);
    return { handled: true, action: `volume:${direction}` };
  } catch {
    return { handled: false };
  }
}

async function controlPlayback(action: "playpause" | "next" | "prev"): Promise<CommandResult> {
  try {
    const keyMap: Record<string, string> = {
      playpause: "space",
      next: "fast forward",
      prev: "rewind",
    };
    await execAsync(`osascript -e 'tell application "System Events" to key code ${action === "playpause" ? "49" : action === "next" ? "123" : "124"}'`);
    log(`CommandRouter: playback ${action}`);
    return { handled: true, action: `playback:${action}` };
  } catch {
    return { handled: false };
  }
}

async function setDoNotDisturb(enable: boolean): Promise<CommandResult> {
  const targetVal = enable ? 1 : 0;
  const script = `
tell application "System Events"
    tell process "ControlCenter"
        key code 53
        delay 0.1
        set menuItems to menu bar items of menu bar 1
        repeat with itemRef in menuItems
            set desc to description of itemRef
            if desc contains "控制中心" or desc contains "Control Center" then
                perform action "AXPress" of itemRef
                exit repeat
            end if
        end repeat
        delay 0.5
        try
            set checkBoxes to checkboxes of UI elements of window 1
            repeat with chk in checkBoxes
                set chkDesc to description of chk
                set chkName to name of chk
                if chkDesc contains "专注" or chkDesc contains "勿扰" or chkDesc contains "Focus" or chkName contains "专注" or chkName contains "勿扰" or chkName contains "Focus" then
                    set curVal to value of chk
                    if curVal is not ${targetVal} then
                        perform action "AXPress" of chk
                    end if
                    exit repeat
                end if
            end repeat
        end try
        delay 0.1
        key code 53
    end tell
end tell
  `;
  try {
    await runAppleScript(script);
    log(`CommandRouter: Set DND to ${enable}`);
    return { handled: true, action: `dnd:${enable ? "on" : "off"}` };
  } catch (err) {
    logError("CommandRouter: Set DND failed", err);
    return { handled: false };
  }
}

async function minimizeAllWindowsExcept(exceptName: string): Promise<CommandResult> {
  const app = matchApp(exceptName);
  const keepAppName = app ? app.name : exceptName;
  
  const script = `
tell application "System Events"
    set allProcesses to application processes whose visible is true
    repeat with p in allProcesses
        set pName to name of p
        if pName is not in {"${keepAppName}", "Daisy", "Finder"} then
            try
                set value of attribute "AXMinimized" of every window of p to true
            end try
        end if
    end repeat
end tell
  `;
  try {
    await runAppleScript(script);
    log(`CommandRouter: Minimized all windows except ${keepAppName}`);
    return { handled: true, action: `window:minimize-except:${keepAppName}` };
  } catch (err) {
    logError("CommandRouter: Minimize except failed", err);
    return { handled: false };
  }
}

async function minimizeApp(appName: string): Promise<CommandResult> {
  const app = matchApp(appName);
  const targetName = app ? app.name : appName;
  
  const script = `
tell application "System Events"
    repeat with p in (application processes whose visible is true)
        if name of p is "${targetName}" then
            try
                set value of attribute "AXMinimized" of every window of p to true
            end try
        end if
    end repeat
end tell
  `;
  try {
    await runAppleScript(script);
    log(`CommandRouter: Minimized app ${targetName}`);
    return { handled: true, action: `window:minimize-app:${targetName}` };
  } catch (err) {
    logError("CommandRouter: Minimize app failed", err);
    return { handled: false };
  }
}

async function splitScreen(leftName: string, rightName: string): Promise<CommandResult> {
  const leftApp = matchApp(leftName);
  const rightApp = matchApp(rightName);
  
  if (!leftApp || !rightApp) {
    log(`CommandRouter: Split screen apps not found: left="${leftName}" right="${rightName}"`);
    return { handled: false };
  }
  
  const script = `
tell application "Finder"
    set desktopBounds to bounds of window of desktop
    set screenWidth to item 3 of desktopBounds
    set screenHeight to item 4 of desktopBounds
end tell

tell application "System Events"
    -- Left app
    if exists process "${leftApp.name}" then
        set frontmost of process "${leftApp.name}" to true
        try
            set value of attribute "AXPosition" of window 1 of process "${leftApp.name}" to {0, 23}
            set value of attribute "AXSize" of window 1 of process "${leftApp.name}" to {(screenWidth / 2), (screenHeight - 23)}
        end try
    end if
    
    -- Right app
    if exists process "${rightApp.name}" then
        set frontmost of process "${rightApp.name}" to true
        try
            set value of attribute "AXPosition" of window 1 of process "${rightApp.name}" to {(screenWidth / 2), 23}
            set value of attribute "AXSize" of window 1 of process "${rightApp.name}" to {(screenWidth / 2), (screenHeight - 23)}
        end try
    end if
end tell
  `;
  try {
    await runAppleScript(script);
    log(`CommandRouter: Split screen ${leftApp.name} (left) and ${rightApp.name} (right)`);
    return { handled: true, action: `window:split-screen:${leftApp.name}:${rightApp.name}` };
  } catch (err) {
    logError("CommandRouter: Split screen failed", err);
    return { handled: false };
  }
}

async function saveClipboardImageToDesktop(): Promise<CommandResult> {
  try {
    const { clipboard } = require("electron");
    const img = clipboard.readImage();
    if (img.isEmpty()) {
      log("CommandRouter: Clipboard does not contain an image");
      // The command itself was recognized and handled locally. Do not fall
      // through to the LLM just because the clipboard currently has no image.
      return { handled: true, action: "clipboard:save-image:no-image" };
    }
    
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    
    const desktopPath = path.join(os.homedir(), "Desktop");
    const now = new Date();
    const dateStr = now.getFullYear() + 
      String(now.getMonth() + 1).padStart(2, '0') + 
      String(now.getDate()).padStart(2, '0') + "_" + 
      String(now.getHours()).padStart(2, '0') + 
      String(now.getMinutes()).padStart(2, '0') + 
      String(now.getSeconds()).padStart(2, '0');
      
    const filename = `剪贴板图片_${dateStr}.png`;
    const targetPath = path.join(desktopPath, filename);
    
    fs.writeFileSync(targetPath, img.toPNG());
    log(`CommandRouter: Saved clipboard image to ${targetPath}`);
    return { handled: true, action: `clipboard:save-image:${filename}` };
  } catch (err) {
    logError("CommandRouter: Save clipboard image failed", err);
    // This is still a local command. Returning handled=false would incorrectly
    // send the same request to the LLM after a local I/O failure.
    return { handled: true, action: "clipboard:save-image:failed" };
  }
}

export function isSaveClipboardImageToDesktopCommand(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/[\s,，。！!？?、~]+$/g, "")
    .replace(/\s+/g, "");

  const hasSaveAction = /(?:保存|存到|存至|存进|存入|放到|放在)/.test(normalized);
  const targetsDesktop = /(?:桌面|desktop)(?:上)?/i.test(normalized);
  const refersToClipboardImage = /(?:图片|照片|截图|(?:刚才|刚刚|刚)?(?:截取?|复制|拷贝)(?:的)?(?:这张|那张|这个|那个)?图|剪(?:切)?贴板(?:里|中)?(?:的)?图(?:片)?)/.test(normalized);

  return hasSaveAction && targetsDesktop && refersToClipboardImage;
}

async function switchAudioOutput(target: string): Promise<CommandResult> {
  try {
    const SW = getBundledBin("SwitchAudioSource");
    const { stdout } = await execAsync(`"${SW}" -a -t output`);
    const lines = stdout.split("\n").map(l => l.trim()).filter(Boolean);
    // The active device has (*) appended; strip it for matching
    const devices = lines.map((l) => l.replace(/\s*\(.*\)\s*$/, "").trim());
    log(`switchAudioOutput: available devices: ${devices.join(", ")}`);

    // Normalize helper: strip spaces for comparison ("SSL2" ↔ "SSL 2")
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "");
    const targetLower = target.toLowerCase();
    const targetNorm = normalize(target);

    // 1. Exact match (case-insensitive)
    let best = devices.find((d) => d.toLowerCase() === targetLower);

    // 2. Normalized match (ignoring spaces)
    if (!best) {
      best = devices.find((d) => normalize(d) === targetNorm);
    }

    // 3. Fuzzy includes match
    if (!best) {
      best = devices.find((d) => d.toLowerCase().includes(targetLower) || targetLower.includes(d.toLowerCase()));
    }

    // 4. Normalized includes match
    if (!best) {
      best = devices.find((d) => normalize(d).includes(targetNorm) || targetNorm.includes(normalize(d)));
    }

    // 5. "声卡"/"音频接口" → try to find a pro audio interface device
    if (!best && /声卡|音频接口|audio\s*interface/i.test(target)) {
      best = devices.find((d) => /SSL|audio|interface|usb|thunderbolt|firewire|rme|focusrite|apollo|motu|ua[ -]|volt/i.test(d));
    }

    // 6. Last resort: substring scoring
    if (!best) {
      const scored = devices
        .map((d) => ({ name: d, score: d.toLowerCase().includes(targetLower) ? d.length : 999 }))
        .sort((a, b) => a.score - b.score);
      if (scored[0] && scored[0].score < 999) best = scored[0].name;
    }

    if (!best) {
      log(`switchAudioOutput: no device matching "${target}"`);
      return { handled: false };
    }

    await execAsync(`"${SW}" -t output -s "${best}"`);
    log(`switchAudioOutput: switched to "${best}"`);
    return { handled: true, action: `audio:切换至 ${best}` };
  } catch (err) {
    logError("switchAudioOutput failed", err);
    return { handled: false };
  }
}

// Parse user command and execute if it matches a local command pattern
export async function tryLocalCommand(text: string): Promise<CommandResult> {
  const normalized = text.trim().replace(/[\s,，。！!？?、~]+$/, "");

  // "打开抖音搜索世界杯" / "打开微博，搜索世界杯" must enter the
  // requested site's own search page, rather than becoming a generic web
  // search selected by the LLM.
  const knownSiteSearch = parseKnownSiteSearch(normalized);
  if (knownSiteSearch) {
    return await openKnownSiteSearch(knownSiteSearch);
  }

  // Other website requests still go through the LLM/open_url path.
  if (/官网|网站|网页|网址|首页|dot com|\.com|\.cn|\.net/i.test(normalized)) {
    return { handled: false };
  }

  // 打开/启动 应用
  let m = normalized.match(/^(?:帮我|麻烦|请)?(?:打开|启动|开启|运行|开一下)(.+)$/);
  if (m) {
    const target = m[1].replace(/^(一下|这个|那个)\s*/, "").trim();
    // Make sure it's just an app name, not a complex command
    if (target.length > 0 && !target.match(/[，,。！!？?]/)) {
      const result = await openApp(target);
      if (result.handled) return result;

      // Some services (for example 视频号、红果短剧 and 夸克) are websites
      // without a conventional macOS app. When app matching fails, open their
      // known web entry directly instead of making the model guess.
      const knownSiteHome = findKnownSiteHome(target);
      if (knownSiteHome) return await openKnownSiteHome(knownSiteHome);
    }
  }

  // 关闭/退出/关掉 应用
  m = normalized.match(/^(?:帮我|麻烦|请)?(?:关闭|关掉|退出|关一下|杀掉|结束|关了|关)(.+)$/);
  if (m) {
    const target = m[1].replace(/^(一下|这个|那个|了)\s*/, "").trim();
    if (target.length > 0 && !target.match(/[，,。！!？?]/)) {
      const result = await quitApp(target);
      if (result.handled) return result;
    }
  }

  // 音量控制
  if (/^(?:调高|增大|加大|开大|调大)(?:音量|声音)$/.test(normalized) || /^(?:音量|声音)(?:大一点|调高|调大)$/.test(normalized)) {
    return await setVolume("up");
  }
  if (/^(?:调低|减小|关小|调小|降低)(?:音量|声音)$/.test(normalized) || /^(?:音量|声音)(?:小一点|调低|调小)$/.test(normalized)) {
    return await setVolume("down");
  }
  // 播放控制
  if (/^(?:暂停|继续播放|播放)$/.test(normalized)) {
    return await controlPlayback("playpause");
  }
  if (/^(?:下一首|下一曲|下一个)$/.test(normalized)) {
    return await controlPlayback("next");
  }
  if (/^(?:上一首|上一曲|上一个)$/.test(normalized)) {
    return await controlPlayback("prev");
  }

  // 勿扰/专注模式
  if (/^(?:开启|打开|启动|进入)(?:勿扰|专注)(?:模式)?$/.test(normalized)) {
    return await setDoNotDisturb(true);
  }
  if (/^(?:关闭|退出|取消)(?:勿扰|专注)(?:模式)?$/.test(normalized)) {
    return await setDoNotDisturb(false);
  }

  // 最小化所有窗口除了
  let m2 = normalized.match(/^(?:最小化|关闭|隐藏)除了\s*(.+?)\s*之外的(?:所有|其他|其它|全部)?窗口$/);
  if (!m2) {
    m2 = normalized.match(/^除了\s*(.+?)\s*之外的(?:所有|其他|其它|全部)?窗口都(?:最小化|关闭|隐藏)$/);
  }
  if (m2) {
    const except = m2[1].trim();
    if (except) {
      const result = await minimizeAllWindowsExcept(except);
      if (result.handled) return result;
    }
  }

  // 最小化/隐藏单个应用
  let mApp = normalized.match(/^(?:帮我|把|请)?\s*(.+?)\s*(?:窗口)?(?:最小化|隐藏)$/);
  if (!mApp) {
    mApp = normalized.match(/^(?:最小化|隐藏)\s*(.+?)\s*(?:窗口)?$/);
  }
  if (mApp) {
    const target = mApp[1].replace(/^(一下|这个|那个)\s*/, "").trim();
    if (target.length > 0 && !target.match(/[，,。！!？?]/) && !/除了|之外/.test(target)) {
      const result = await minimizeApp(target);
      if (result.handled) return result;
    }
  }

  // 保存最近截图/复制的图片到桌面：固定本地执行，不经过大模型。
  if (isSaveClipboardImageToDesktopCommand(normalized)) {
    return await saveClipboardImageToDesktop();
  }

  // 分屏/左右分屏
  let m3 = normalized.match(/^(?:把)?\s*(.+?)\s*(?:放左边|在左边).+?(?:把)?\s*(.+?)\s*(?:放右边|在右边)$/);
  if (!m3) {
    m3 = normalized.match(/^(.+?)\s*(?:和|与)\s*(.+?)\s*(?:左右分屏|分屏)$/);
  }
  if (!m3) {
    m3 = normalized.match(/^(?:左右分屏|分屏)\s*(.+?)\s*(?:和|与)\s*(.+?)$/);
  }
  if (m3) {
    const left = m3[1].trim();
    const right = m3[2].trim();
    if (left && right) {
      const result = await splitScreen(left, right);
      if (result.handled) return result;
    }
  }

  // 锁屏 / 息屏
  if (/^(?:电脑|把电脑|笔记本)?\s*(?:锁屏|息屏|锁屏幕|黑屏|锁定屏幕|屏幕关闭|关闭屏幕|休眠屏幕)(?:\s*(?:吧|一下|了))?$/.test(normalized)
    || /^(?:锁屏|息屏|锁屏幕|黑屏)$/.test(normalized)) {
    try {
      await execAsync("pmset displaysleepnow");
      return { handled: true, action: "screen:sleep" };
    } catch {
      return { handled: false };
    }
  }

  // 音频输出切换
  let mAudio: RegExpMatchArray | null;
  // 把音频输出切换到XXX / 把声音输出改为XXX
  mAudio = normalized.match(/(?:把|将)?(?:音频|声音)(?:输出)?(?:切换|改|换|切|换成)(?:为|到|成)?(.+?)(?:\s*(?:吧|一下|了))?$/);
  if (!mAudio) {
    // 切换音频输出到XXX / 换声音到XXX
    mAudio = normalized.match(/^(?:切换|换|改)(?:音频|声音)(?:输出)?(?:为|到|成)?(.+?)(?:\s*(?:吧|一下|了))?$/);
  }
  if (!mAudio) {
    // 用XXX播放 / 用XXX当输出
    mAudio = normalized.match(/^用(.+?)(?:播放|输出|当输出|来(?:播放|输出))(?:\s*(?:吧|一下|了))?$/);
  }
  if (!mAudio) {
    // 切换到XXX / 换成XXX (简短说法，但排除"切换到下一个"之类的)
    mAudio = normalized.match(/^(?:切换到|换成|换到)(.+?)(?:\s*(?:吧|一下|了))?$/);
  }
  if (mAudio) {
    // Clean up: strip leading action words, then cut at commas/descriptive suffixes
    let device = mAudio[1].replace(/^(?:音频|声音)(?:输出)?(?:切换|改|换|切|换成)?(?:为|到|成)?/, "").trim();
    // Cut at commas or "，" — only take the first part as device name
    device = device.split(/[，,]/)[0].trim();
    // Remove trailing descriptors like "自带" that ASR might add
    device = device.replace(/^(?:电脑\s*)?(?:自带|内置|自带的|内置的)\s*/, "");
    if (device.length > 0 && device.length < 30) {
      const result = await switchAudioOutput(device);
      if (result.handled) return result;
    }
  }

  return { handled: false };
}

// Initialize app cache on startup
export function initCommandRouter(): void {
  ensureCache();
}
