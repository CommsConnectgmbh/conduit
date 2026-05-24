import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

let sharp;
try { sharp = (await import("sharp")).default; } catch {
  console.log("[icons] sharp not installed — skipping (icons remain SVG-only)");
  process.exit(0);
}

const out = (n) => join(import.meta.dirname, "..", "public", n);

async function make(size, file, opts = {}) {
  const bg = opts.maskable ? "#050507" : "#050507";
  const pad = opts.maskable ? Math.round(size * 0.18) : Math.round(size * 0.16);
  const fontSize = Math.round(size * 0.52);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" fill="${bg}" ${opts.maskable ? "" : `rx="${Math.round(size * 0.22)}"`} />
    <text x="50%" y="58%" font-family="ui-monospace,Menlo,monospace" font-weight="600" font-size="${fontSize}" fill="#f97316" text-anchor="middle">⌘</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(out(file));
  console.log("[icons] wrote", file);
}

await make(192, "icon-192.png");
await make(512, "icon-512.png");
await make(512, "icon-maskable-512.png", { maskable: true });
await make(180, "apple-icon.png");
