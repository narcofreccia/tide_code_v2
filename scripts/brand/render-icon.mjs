// Renders scripts/brand/icon.svg to icon-1024.png with headless Chromium (transparent corners).
// The SVG is embedded as an <object> so its relative @font-face URL resolves.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const chrome =
  process.env.CHROME ??
  join(homedir(), "Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const out = join(here, "icon-1024.png");
execFileSync(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--screenshot=${out}`,
    "--window-size=1024,1024",
    "--default-background-color=00000000",
    "--allow-file-access-from-files",
    `file://${join(here, "icon.html")}`,
  ],
  { stdio: "inherit" },
);
console.log("wrote", out);
