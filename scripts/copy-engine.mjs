import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = resolve(root, "node_modules/@mizarjp/yaneuraou.k-p/lib");
const dst = resolve(root, "public/engine");

const files = [
  "yaneuraou.k-p.js",
  "yaneuraou.k-p.wasm",
  "yaneuraou.k-p.worker.js",
];

mkdirSync(dst, { recursive: true });

let copied = 0;
let skipped = 0;
for (const f of files) {
  const from = resolve(src, f);
  const to = resolve(dst, f);
  if (!existsSync(from)) {
    console.error(`[copy-engine] missing source: ${from}`);
    process.exit(1);
  }
  if (existsSync(to) && statSync(to).mtimeMs >= statSync(from).mtimeMs) {
    skipped++;
    continue;
  }
  copyFileSync(from, to);
  copied++;
}
console.log(`[copy-engine] ${copied} copied, ${skipped} up-to-date → public/engine/`);
