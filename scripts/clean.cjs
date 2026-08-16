const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
for (const dir of ["dist", "releases"]) {
  const target = path.join(root, dir);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`[clean] removed ${target}`);
  } else {
    console.log(`[clean] skip (not present): ${target}`);
  }
}
