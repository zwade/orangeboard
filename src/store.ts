import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const HOME = process.env.OBOARD_HOME ?? join(homedir(), ".orangeboard");
export const SKETCHES = join(HOME, "sketches");
export const LATEST = join(HOME, "latest.png");

export function saveSketch(png: Buffer): string {
  mkdirSync(SKETCHES, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = join(SKETCHES, `${stamp}.png`);
  writeFileSync(file, png);
  writeFileSync(meta(file), JSON.stringify({ project: projectRoot(process.cwd()) }));
  copyFileSync(file, LATEST);
  return file;
}

export const meta = (png: string) => png.replace(/\.png$/, ".json");

// Git toplevel of dir, or dir itself outside a repo.
export function projectRoot(dir: string): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : resolve(dir);
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
