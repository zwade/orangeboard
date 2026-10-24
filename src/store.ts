import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.OBOARD_HOME ?? join(homedir(), ".orangeboard");
export const SKETCHES = join(HOME, "sketches");
export const LATEST = join(HOME, "latest.png");

export function saveSketch(png: Buffer): string {
  mkdirSync(SKETCHES, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = join(SKETCHES, `${stamp}.png`);
  writeFileSync(file, png);
  copyFileSync(file, LATEST);
  return file;
}

export function copyToClipboard(file: string): boolean {
  const run = (cmd: string, args: string[], input?: Buffer) =>
    spawnSync(cmd, args, { input, stdio: [input ? "pipe" : "ignore", "ignore", "ignore"] }).status === 0;
  if (process.platform === "darwin")
    return run("osascript", [
      "-e", "on run argv",
      "-e", "set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)",
      "-e", "end run",
      file,
    ]);
  return run("wl-copy", ["-t", "image/png"], readFileSync(file)) || run("xclip", ["-selection", "clipboard", "-t", "image/png", "-i", file]);
}
