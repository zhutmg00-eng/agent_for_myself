import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { avatar, roleIconSvg, brandMarkSvg, profileFor } from "../web/js/avatars.js";
import { roomSkeletonHTML } from "../web/js/ui.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const EMOJI_RX = /\p{Extended_Pictographic}/u;

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(html|css|js|mjs|svg)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

describe("Zero-Emoji Frontend & Geometric SVG Iconography", () => {
  it("contains zero emojis across all web/ assets and desktop/splash.html", () => {
    const files = [...walk(path.join(ROOT, "web")), path.join(ROOT, "desktop", "splash.html")];
    const violations = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/);
      lines.forEach((line, idx) => {
        const m = line.match(EMOJI_RX);
        if (m) {
          violations.push(`${path.relative(ROOT, file)}:${idx + 1} (${m[0]})`);
        }
      });
    }
    assert.deepEqual(violations, [], `Found unexpected emojis:\n${violations.join("\n")}`);
  });

  it("renders crisp geometric SVG emblems and strips any backend emoji metadata", () => {
    const builtInRoles = ["chief", "boss", "coder", "reviewer", "librarian", "explore", "plan", "writer", "analyst", "general"];
    for (const id of builtInRoles) {
      const bot = { id, name: `Bot ${id}`, emoji: "🤖🔥🧠" };
      const prof = profileFor(id, bot);
      assert.equal(prof.emoji, "", `profileFor(${id}) must not expose emoji`);

      const avHtml = avatar(id, 32, { bot });
      assert.match(avHtml, /<svg\b/i, `avatar(${id}) must render inline SVG`);
      assert.equal(EMOJI_RX.test(avHtml), false, `avatar(${id}) must not contain emojis`);

      const roleSvg = roleIconSvg(id, bot);
      assert.match(roleSvg, /<svg\b/i, `roleIconSvg(${id}) must render inline SVG`);
      assert.equal(EMOJI_RX.test(roleSvg), false, `roleIconSvg(${id}) must not contain emojis`);
    }

    const customHtml = avatar("custom_bot", 32, { bot: { id: "custom_bot", name: "Custom Bot", emoji: "🚀" } });
    assert.match(customHtml, /class="avatar mono/, "custom bot renders clean monogram avatar");
    assert.equal(EMOJI_RX.test(customHtml), false, "custom bot avatar must not contain emojis");

    const mark = brandMarkSvg(28);
    assert.match(mark, /<svg\b/i);
    assert.equal(EMOJI_RX.test(mark), false);
  });

  it("renders staggered room-list skeleton loader rows with reduced-motion CSS support", () => {
    const html = roomSkeletonHTML(4);
    const rows = html.match(/class="room-skeleton-row"/g) || [];
    assert.equal(rows.length, 4);
    assert.match(html, /--skel-i:0/);
    assert.match(html, /--skel-i:3/);
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /class="skel-block skel-avatar"/);
    assert.match(html, /class="skel-block skel-line is-title"/);
    assert.match(html, /class="skel-block skel-line is-sub"/);
    assert.equal(EMOJI_RX.test(html), false);

    const clamped = roomSkeletonHTML(99);
    assert.equal((clamped.match(/class="room-skeleton-row"/g) || []).length, 8);

    const css = fs.readFileSync(path.join(ROOT, "web", "app.css"), "utf8");
    assert.match(css, /\.room-skeleton-row\s*\{/);
    assert.match(css, /@keyframes\s+skel-shimmer/);
    assert.match(css, /@keyframes\s+room-enter/);
    assert.match(css, /\.sidebar\.is-rail\s+\.room-skeleton-row/);
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
  });
});
