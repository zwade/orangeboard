import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOME, LATEST, SKETCHES } from "./store.ts";

const SEEN = join(HOME, "seen");
const WINDOW_MS = 30 * 60e3;

// UserPromptSubmit hook: tell Claude about sketches saved since this session's last prompt.
export function hook() {
  let sid = "default";
  try {
    sid = JSON.parse(readFileSync(0, "utf8")).session_id ?? sid;
  } catch {}
  mkdirSync(SEEN, { recursive: true });
  const seenFile = join(SEEN, sid.replace(/[^\w-]/g, "_"));
  const last = existsSync(seenFile) ? Number(readFileSync(seenFile, "utf8")) || 0 : 0;
  const now = Date.now();
  const since = Math.max(last, now - WINDOW_MS);
  writeFileSync(seenFile, String(now));

  for (const f of readdirSync(SEEN)) {
    const p = join(SEEN, f);
    if (now - statSync(p).mtimeMs > 7 * 864e5) unlinkSync(p);
  }

  const fresh = existsSync(SKETCHES)
    ? readdirSync(SKETCHES)
        .filter((f) => f.endsWith(".png"))
        .map((f) => join(SKETCHES, f))
        .filter((p) => statSync(p).mtimeMs > since)
        .sort()
    : [];
  if (fresh.length)
    console.log(
      `The user drew ${fresh.length} new orangeboard sketch${fresh.length > 1 ? "es" : ""} for you (newest last). ` +
        `View with the Read tool before responding:\n${fresh.map((p) => `- ${p}`).join("\n")}`,
    );
}

// Installs the hook into ~/.claude/settings.json and a /sketch skill.
export function install(self: string) {
  const claude = join(homedir(), ".claude");
  const settingsPath = join(claude, "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  const command = `"${process.execPath}" "${self}" hook`;
  const hooks = (settings.hooks ??= {});
  const ups: { hooks: { command?: string }[] }[] = (hooks.UserPromptSubmit ??= []);
  if (!ups.some((m) => m.hooks?.some((h) => h.command?.includes("oboard")))) {
    ups.push({ hooks: [{ type: "command", command } as { command: string }] });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log(`hook added to ${settingsPath}`);
  } else console.log(`hook already in ${settingsPath}`);

  const skillDir = join(claude, "skills", "sketch");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---
name: sketch
description: View the user's latest orangeboard (oboard) whiteboard sketch. Use when the user refers to their sketch, drawing, diagram or whiteboard.
---

Read \`${LATEST}\` with the Read tool (it is a PNG) and use it as context for the user's request.
Older sketches are in \`${SKETCHES}/\`, named by UTC timestamp.
`,
  );
  console.log(`skill written to ${skillDir}/SKILL.md`);
}
