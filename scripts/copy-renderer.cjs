const fs = require("node:fs");
const path = require("node:path");

const src = path.join(__dirname, "..", "src", "renderer");
const dest = path.join(__dirname, "..", "dist", "renderer");

if (fs.existsSync(dest)) {
  fs.rmSync(dest, { recursive: true, force: true });
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`[copy-renderer] copied ${src} -> ${dest}`);
