#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { hook, install } from "./claude.ts";
import { ADVANCE, glyph, LINE } from "./font.ts";
import { decodePng, encodePng, fit, type Image } from "./png.ts";
import { copyToClipboard, LATEST, saveSketch } from "./store.ts";

type RGB = [number, number, number];

const COLORS: [string, string, RGB][] = [
  ["w", "white", [255, 255, 255]],
  ["k", "black", [24, 24, 27]],
  ["r", "red", [229, 72, 77]],
  ["g", "green", [48, 164, 108]],
  ["b", "blue", [62, 99, 221]],
];
const SIZES = [1.5, 4, 10]; // radius in points
const TEXT_UNITS = [2, 3, 5]; // font pixel size in points
const LIGHT_BG: RGB = [255, 255, 255];
const DARK_BG: RGB = [40, 40, 44];
const ORANGE: RGB = [255, 122, 26];
const HEADER_ROWS = 3;
const TILE_C = 8, TILE_R = 4; // tile size in cells
const HEADER_ID = 7698;
const BASE_ID = 7699;
const TILE_ID = 7700;

type Stroke = { kind: "stroke"; color: RGB | "bg"; r: number; pts: number[] };
type Text = { kind: "text"; color: RGB; u: number; x: number; y: number; text: string };
type Op = Stroke | Text | { kind: "clear" };

const out = (s: string) => process.stdout.write(s);
const ESC = "\x1b";
const ST = `${ESC}\\`;
const TMUX = !!process.env.TMUX;

// --- state ---
let cols = 0, rows = 0;
let top = 0, canvasRows = 0; // header rows above the canvas, canvas height in rows
let cw = 0, ch = 0; // cell size as the terminal reports it (points on iTerm2/macOS)
let S = 1; // buffer pixels per reported pixel
let W = 0, H = 0;
let buf = new Uint8Array(0);
let tilesX = 0, tilesY = 0, tileCount = 0;
let dirty = new Uint8Array(0);
let live = new Set<number>(); // tile overlays currently placed
let full = false; // next flush sends one consolidated image
let hidden = false;
let base: Image | undefined;
const ops: Op[] = [];
let current: Stroke | undefined;
let mode: "pen" | "erase" | "text" = "pen";
let typing: Text | undefined;
let dark = false;
let color = 1;
let size = 1;
let pixelMouse = false;
let kitty = false;
let paneTop = 0, paneLeft = 0;
let status = "draw with mouse · right-drag erases";
let flushTimer: NodeJS.Timeout | undefined;

const bg = () => (dark ? DARK_BG : LIGHT_BG);

function tmux(...args: string[]): string {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

// Sends straight to the outer terminal when inside tmux.
const passthrough = (s: string) => (TMUX ? `${ESC}Ptmux;${s.replaceAll(ESC, ESC + ESC)}${ST}` : s);

// --- raster ---
function stamp(cx: number, cy: number, r: number, [cr, cg, cb]: RGB) {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
  if (x0 > x1 || y0 > y1) return;
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      if (dx * dx + dy * dy > r2) continue;
      const i = (y * W + x) * 3;
      buf[i] = cr;
      buf[i + 1] = cg;
      buf[i + 2] = cb;
    }
  }
  markDirty(x0, y0, x1, y1);
}

function markDirty(x0: number, y0: number, x1: number, y1: number) {
  const tw = TILE_C * cw * S, th = TILE_R * ch * S;
  for (let ty = Math.floor(y0 / th); ty <= Math.floor(y1 / th); ty++)
    for (let tx = Math.floor(x0 / tw); tx <= Math.floor(x1 / tw); tx++) dirty[ty * tilesX + tx] = 1;
}

function rect(rx: number, ry: number, rw: number, rh: number, [cr, cg, cb]: RGB) {
  const x0 = Math.max(0, Math.round(rx)), x1 = Math.min(W, Math.round(rx + rw)) - 1;
  const y0 = Math.max(0, Math.round(ry)), y1 = Math.min(H, Math.round(ry + rh)) - 1;
  if (x0 > x1 || y0 > y1) return;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = (y * W + x) * 3;
      buf[i] = cr;
      buf[i + 1] = cg;
      buf[i + 2] = cb;
    }
  markDirty(x0, y0, x1, y1);
}

// Draws characters from index `from` on.
function drawText(op: Text, from = 0) {
  let line = 0, col = 0;
  [...op.text].forEach((c, i) => {
    if (c === "\n") return void (line++, (col = 0));
    if (i >= from) glyph(c, (gx, gy) => rect(op.x + (col * ADVANCE + gx) * op.u, op.y + (line * LINE + gy) * op.u, op.u, op.u, op.color));
    col++;
  });
}

// Quadratic curve a→b with control c, stamped at sub-radius spacing.
function curve(ax: number, ay: number, cx: number, cy: number, bx: number, by: number, r: number, col: RGB) {
  const len = Math.hypot(cx - ax, cy - ay) + Math.hypot(bx - cx, by - cy);
  const steps = Math.max(1, Math.ceil(len / Math.max(0.5, r / 2)));
  for (let s = 1; s <= steps; s++) {
    const t = s / steps, u = 1 - t;
    stamp(u * u * ax + 2 * u * t * cx + t * t * bx, u * u * ay + 2 * u * t * cy + t * t * by, r, col);
  }
}

// Draws the part of a stroke that point k adds (smoothed through midpoints); end=true caps the tail.
function drawPoint(op: Stroke, k: number, end = false) {
  const c = op.color === "bg" ? bg() : op.color;
  const P = (i: number): [number, number] => [op.pts[i * 2], op.pts[i * 2 + 1]];
  const M = (i: number): [number, number] => [(op.pts[i * 2] + op.pts[i * 2 + 2]) / 2, (op.pts[i * 2 + 1] + op.pts[i * 2 + 3]) / 2];
  if (end) {
    if (k < 1) return;
    const [mx, my] = M(k - 1), [px, py] = P(k);
    return curve(mx, my, mx, my, px, py, op.r, c);
  }
  if (k === 0) return stamp(...P(0), op.r, c);
  if (k === 1) {
    const [ax, ay] = P(0), [mx, my] = M(0);
    return curve(ax, ay, ax, ay, mx, my, op.r, c);
  }
  curve(...M(k - 2), ...P(k - 1), ...M(k - 1), op.r, c);
}

function drawStroke(op: Stroke) {
  const n = op.pts.length / 2;
  for (let k = 0; k < n; k++) drawPoint(op, k);
  if (op !== current) drawPoint(op, n - 1, true);
}

function replay() {
  const [r, g, b] = bg();
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
  }
  const start = ops.findLastIndex((o) => o.kind === "clear") + 1;
  if (start === 0 && base) {
    const w = Math.min(base.w, W);
    for (let y = 0; y < Math.min(base.h, H); y++) buf.set(base.data.subarray(y * base.w * 3, (y * base.w + w) * 3), y * W * 3);
  }
  for (const op of ops.slice(start)) if (op.kind === "stroke") drawStroke(op);
    else if (op.kind === "text") drawText(op);
  full = true;
}

// --- output ---
const del = (id: number) => `${ESC}_Ga=d,d=I,i=${id},q=2${ST}`;

// Places the buffer region at cells (c0, r0)+(nc×nr). c/r make the terminal scale it to exactly those cells.
function image(id: number, c0: number, r0: number, nc: number, nr: number, z: number): string {
  const CW = cw * S, CH = ch * S;
  const x0 = c0 * CW, y0 = r0 * CH, w = nc * CW, h = nr * CH;
  const px = w === W ? buf.subarray(y0 * W * 3, (y0 + h) * W * 3) : new Uint8Array(w * h * 3);
  if (w !== W) for (let y = 0; y < h; y++) px.set(buf.subarray(((y0 + y) * W + x0) * 3, ((y0 + y) * W + x0 + w) * 3), y * w * 3);
  return place(id, px, w, h, c0, r0 + top, nc, nr, z);
}

// Transmits RGB pixels and places them over screen cells (c0, row)+(nc×nr).
function place(id: number, px: Uint8Array, w: number, h: number, c0: number, row: number, nc: number, nr: number, z: number): string {
  const b64 = deflateSync(px, { level: 1 }).toString("base64");
  let s = `${ESC}7${del(id)}${ESC}[${row + 1 + paneTop};${c0 + 1 + paneLeft}H`;
  for (let i = 0; i < b64.length; i += 4096) {
    const m = i + 4096 < b64.length ? 1 : 0;
    const ctrl = i === 0 ? `a=T,f=24,o=z,s=${w},v=${h},c=${nc},r=${nr},i=${id},q=2,C=1,z=${z},m=${m}` : `m=${m}`;
    s += `${ESC}_G${ctrl};${b64.slice(i, i + 4096)}${ST}`;
  }
  return passthrough(s + `${ESC}8`);
}

function flush() {
  flushTimer = undefined;
  if (hidden) return;
  let s = "";
  if (full) {
    // One image while idle; overlays only exist mid-stroke.
    full = false;
    dirty.fill(0);
    s = header() + image(BASE_ID, 0, 0, cols, canvasRows, -2) + passthrough([...live].map(del).join(""));
    live.clear();
  } else
    for (let i = 0; i < tileCount; i++) {
      if (!dirty[i]) continue;
      dirty[i] = 0;
      const tx = i % tilesX, ty = Math.floor(i / tilesX);
      const c0 = tx * TILE_C, r0 = ty * TILE_R;
      s += image(TILE_ID + i, c0, r0, Math.min(TILE_C, cols - c0), Math.min(TILE_R, canvasRows - r0), -1);
      live.add(TILE_ID + i);
    }
  if (s) out(s);
}

const invalidate = () => (flushTimer ??= setTimeout(flush, 33));

// Orange bar with "orangeboard" in the pixel font, scaled to fit.
function header(): string {
  if (!top) return "";
  const w = cols * cw * S, h = top * ch * S;
  const px = new Uint8Array(w * h * 3);
  for (let i = 0; i < px.length; i += 3) px.set(ORANGE, i);
  const u = Math.max(1, Math.floor((h * 0.72) / 9)); // 9 = ascender-to-descender rows
  const x0 = cw * S, y0 = Math.round((h - 9 * u) / 2);
  [..."orangeboard"].forEach((c, i) =>
    glyph(c, (gx, gy) => {
      const gx0 = x0 + (i * ADVANCE + gx) * u;
      if (gx0 + u > w) return;
      for (let y = 0; y < u; y++) px.fill(255, ((y0 + gy * u + y) * w + gx0) * 3, ((y0 + gy * u + y) * w + gx0 + u) * 3);
    }),
  );
  return place(HEADER_ID, px, w, h, 0, 0, cols, top, -2);
}

function deleteAll() {
  out(passthrough(del(HEADER_ID) + del(BASE_ID) + [...live].map(del).join("")));
  live.clear();
}

type Hit = [number, number, () => void];
let hits: Hit[] = [];

function toolbar() {
  hits = [];
  let s = `${ESC}[${rows};1H${ESC}[0m${ESC}[2K`;
  let col = 0;
  const add = (text: string, sgr = "", action?: () => void) => {
    if (col + text.length > cols - 1) return;
    if (action) hits.push([col, col + text.length, action]);
    s += `${sgr}${text}${ESC}[0m`;
    col += text.length;
  };
  COLORS.forEach(([key, , [r, g, b]], i) => {
    const sel = i === color;
    add(sel ? "[" : " ", "", () => (color = i));
    add("██", `${ESC}[38;2;${r};${g};${b}m`, () => (color = i));
    add(sel ? "]" : " ", "", () => (color = i));
    add(key, `${ESC}[2m`, () => (color = i));
  });
  add(" │ ", `${ESC}[2m`);
  ["S", "M", "L"].forEach((label, i) => add(i === size ? `[${label}]` : ` ${label} `, i === size ? `${ESC}[1m` : "", () => (size = i)));
  add(" │ ", `${ESC}[2m`);
  const modeBtn = (m: typeof mode, label: string, key: string) => {
    const act = () => setMode(mode === m && m !== "pen" ? "pen" : m);
    add(mode === m ? `[${label}]` : ` ${label} `, mode === m ? `${ESC}[1m` : "", act);
    add(key, `${ESC}[2m`, act);
  };
  modeBtn("pen", "pen", "");
  modeBtn("erase", "erase", "⌫~");
  modeBtn("text", "text", "t");
  add(" │ ", `${ESC}[2m`);
  add("u", `${ESC}[1m`, undo);
  add("ndo ", "", undo);
  add("c", `${ESC}[1m`, clear);
  add("lear ", "", clear);
  add("d", `${ESC}[1m`, toggleTheme);
  add("ark ", "", toggleTheme);
  add("s", `${ESC}[1m`, save);
  add("ave ", "", save);
  add("⏎", `${ESC}[1m`, saveAndQuit);
  add("save+quit ", "", saveAndQuit);
  add("q", `${ESC}[1m`, quit);
  add("uit", "", quit);
  add("  " + status, `${ESC}[2m`);
  out(s);
}

function layout() {
  if (TMUX) [paneTop, paneLeft] = tmux("display", "-p", "#{pane_top} #{pane_left}").split(" ").map((n) => +n || 0);
  deleteAll();
  cols = process.stdout.columns;
  rows = process.stdout.rows;
  top = rows >= 12 ? HEADER_ROWS : 0;
  canvasRows = Math.max(1, rows - 1 - top);
  W = Math.max(1, cols * cw * S);
  H = Math.max(1, canvasRows * ch * S);
  buf = new Uint8Array(W * H * 3);
  tilesX = Math.ceil(cols / TILE_C);
  tilesY = Math.ceil(canvasRows / TILE_R);
  tileCount = tilesX * tilesY;
  dirty = new Uint8Array(tileCount);
  replay();
  out(`${ESC}[2J`);
  toolbar();
  invalidate();
}

// --- actions ---
function setMode(m: typeof mode) {
  if (typing) finishText();
  mode = m;
  status = m === "text" ? "click where the text goes" : "";
}

function finishText() {
  const t = typing!;
  typing = undefined;
  mode = "pen";
  if (!t.text.trim()) {
    ops.splice(ops.indexOf(t), 1);
    replay();
  }
  full = true;
  invalidate();
}

function undo() {
  if (!ops.length) return;
  ops.pop();
  replay();
  invalidate();
}

function clear() {
  ops.push({ kind: "clear" });
  replay();
  invalidate();
}

function toggleTheme() {
  dark = !dark;
  replay();
  invalidate();
}

function save(): boolean {
  // Crop to drawn content plus padding.
  const [br, bgc, bb] = bg();
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (buf[i] === br && buf[i + 1] === bgc && buf[i + 2] === bb) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  if (x1 < 0) {
    status = "nothing to save";
    toolbar();
    return false;
  }
  const pad = 16 * S;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(W - 1, x1 + pad);
  y1 = Math.min(H - 1, y1 + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) data.set(buf.subarray(((y0 + y) * W + x0) * 3, ((y0 + y) * W + x1 + 1) * 3), y * w * 3);
  const file = saveSketch(encodePng({ w, h, data }));
  status = `saved ${w}×${h}${copyToClipboard(file) ? " · copied to clipboard" : ""}`;
  toolbar();
  return true;
}

function saveAndQuit() {
  if (save()) quit();
}

function quit() {
  deleteAll();
  out(`${ESC}[?1004l${ESC}[?1016l${ESC}[?1006l${ESC}[?1002l${ESC}[?1000l${ESC}[?25h${ESC}[?1049l`);
  process.stdin.setRawMode(false);
  if (status.startsWith("saved")) console.log(`orangeboard: ${status} → ${LATEST}`);
  process.exit(0);
}

// tmux: pane focus changes keep the image; leaving the window hides it.
function onFocus(focused: boolean) {
  if (focused) {
    if (!hidden) return;
    hidden = false;
    [paneTop, paneLeft] = tmux("display", "-p", "#{pane_top} #{pane_left}").split(" ").map((n) => +n || 0);
    full = true;
    invalidate();
  } else if (tmux("display", "-p", "-t", process.env.TMUX_PANE ?? "", "#{window_active}") !== "1") {
    hidden = true;
    deleteAll();
  }
}

// --- input ---
function onMouse(b: number, x: number, y: number, release: boolean) {
  if (b & 64) return; // wheel
  // Position in reported pixels.
  const [px, sy] = pixelMouse ? [x - 1, y - 1] : [(x - 0.5) * cw, (y - 0.5) * ch];
  const row = Math.floor(sy / ch), col = Math.floor(px / cw);
  const py = Math.max(0, sy - top * ch); // canvas-relative
  if (!(b & 32) && !release && row < top) return; // header
  if (release) {
    if (current) {
      drawPoint(current, current.pts.length / 2 - 1, true);
      current = undefined;
      full = true;
      invalidate();
    }
    return;
  }
  if (!(b & 32)) {
    if (row >= rows - 1) {
      status = "";
      if (typing) finishText();
      hits.find(([a, z]) => col >= a && col < z)?.[2]();
      toolbar();
      return;
    }
    if (typing) {
      // Clicking out ends text entry.
      finishText();
      status = "";
      return toolbar();
    }
    const btn = b & 3;
    if (btn === 1) return;
    if (mode === "text") {
      const u = TEXT_UNITS[size] * S;
      typing = { kind: "text", color: COLORS[color][2], u, x: px * S, y: py * S - 3.5 * u, text: "" };
      ops.push(typing);
      status = "typing · click or esc to finish";
      return toolbar();
    }
    const erase = btn === 2 || mode === "erase";
    const r = SIZES[size] * S * (erase ? 2.5 : 1);
    current = { kind: "stroke", color: erase ? "bg" : COLORS[color][2], r, pts: [] };
    ops.push(current);
  }
  if (!current) return;
  current.pts.push(px * S, Math.min(py * S, H - 1));
  drawPoint(current, current.pts.length / 2 - 1);
  invalidate();
}

function onKey(k: string) {
  if (k === "\x03") return quit();
  if (typing) return typeKey(k);
  const ci = COLORS.findIndex(([key]) => key === k);
  if (ci >= 0) {
    color = ci;
    if (mode === "erase") mode = "pen";
  } else if (k >= "1" && k <= "3") size = Number(k) - 1;
  else if (k === "\x7f" || k === "\b" || k === "~" || k === "`") return setMode(mode === "erase" ? "pen" : "erase"), toolbar();
  else if (k === "t") return setMode(mode === "text" ? "pen" : "text"), toolbar();
  else if (k === "\x1b" && mode !== "pen") mode = "pen";
  else if (k === "u" || k === "\x1a") undo();
  else if (k === "c") clear();
  else if (k === "d") toggleTheme();
  else if (k === "s") return void save();
  else if (k === "\r") return saveAndQuit();
  else if (k === "q") quit();
  else return;
  status = "";
  toolbar();
}

function typeKey(k: string) {
  const t = typing!;
  if (k === "\x1b") {
    finishText();
    status = "";
    return toolbar();
  }
  if (k === "\x7f" || k === "\b") {
    if (!t.text) return;
    t.text = t.text.slice(0, -1);
    replay();
  } else if (k === "\r") t.text += "\n";
  else if (k >= " " && k <= "~") {
    t.text += k;
    drawText(t, t.text.length - 1);
  } else return;
  invalidate();
}

const SEQ =
  /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[6;(\d+);(\d+)t|\x1b\[\?1016;(\d+)\$y|\x1b_G([^\x1b]*)\x1b\\|\x1b\[([IO])|\x1b\[\?[\d;]*c|\x1b\[[\d;?]*[ -/]*[@-~]|\x1b.?|[^]/gy;
let pending = "";
let onDA: (() => void) | undefined;

function onData(d: Buffer) {
  let s = pending + d.toString("latin1");
  pending = "";
  const tail = /\x1b(?:\[[\d;<?$]*|_G[^\x1b]*|_G[^\x1b]*\x1b)?$/.exec(s);
  if (tail && tail.index + tail[0].length === s.length && tail[0].length > 1) {
    pending = s.slice(tail.index);
    s = s.slice(0, tail.index);
  }
  SEQ.lastIndex = 0;
  for (let m; (m = SEQ.exec(s)); ) {
    if (m[1]) onMouse(+m[1], +m[2], +m[3], m[4] === "m");
    else if (m[5]) {
      const [nch, ncw] = [+m[5], +m[6]];
      if (nch && ncw && (nch !== ch || ncw !== cw)) {
        [ch, cw] = [nch, ncw];
        if (W) layout();
      }
    } else if (m[7]) pixelMouse = m[7] === "1" || m[7] === "2";
    else if (m[8] !== undefined) kitty ||= m[8].includes("OK");
    else if (m[9]) onFocus(m[9] === "I");
    else if (/^\x1b\[\?[\d;]*c$/.test(m[0])) onDA?.();
    else if (m[0].length === 1) onKey(m[0]);
  }
}

// --- main ---
async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "hook") return hook();
  if (cmd === "install-claude") return install(realpathSync(process.argv[1]));
  if (cmd === "-h" || cmd === "--help") {
    console.log(`usage: oboard [image.png | --resume]   whiteboard in the terminal (kitty graphics)
       oboard install-claude           add Claude Code hook + /sketch skill
       oboard hook                     UserPromptSubmit hook (used by Claude Code)
env:   OBOARD_SCALE=n                  buffer pixels per terminal-reported pixel (default 2 on macOS)`);
    return;
  }
  if (!process.stdin.isTTY) throw new Error("oboard needs an interactive terminal");
  const force = cmd === "--force" || arg === "--force";
  const src = cmd === "--resume" ? LATEST : cmd === "--force" ? undefined : cmd;
  const img = src ? decodePng(readFileSync(src)) : undefined;

  if (TMUX) tmux("set", "-p", "allow-passthrough", "on");
  process.stdin.setRawMode(true);
  process.stdin.on("data", onData);
  const handshake = new Promise<void>((res) => {
    onDA = res;
    setTimeout(res, 1000);
  });
  out(`${ESC}[16t${ESC}[?1016$p` + passthrough(`${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ST}`) + `${ESC}[c`);
  await handshake;
  if (TMUX) await new Promise((r) => setTimeout(r, 150)); // passthrough replies can trail tmux's own DA
  onDA = undefined;

  if (TMUX && !(cw && ch)) {
    const [w, h] = tmux("display", "-p", "#{client_cell_width} #{client_cell_height}").split(" ").map(Number);
    if (w && h) [cw, ch] = [w, h];
  }
  if (!(cw && ch)) [cw, ch] = [8, 17];
  S = Number(process.env.OBOARD_SCALE) || (process.platform === "darwin" && ch < 24 ? 2 : 1);

  if (!kitty && !TMUX && !force) {
    process.stdin.setRawMode(false);
    console.error("orangeboard: terminal doesn't answer kitty graphics queries (try iTerm2, Ghostty, WezTerm; --force to try anyway)");
    process.exit(1);
  }

  out(`${ESC}[?1049h${ESC}[?25l${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h${pixelMouse ? `${ESC}[?1016h` : ""}${TMUX ? `${ESC}[?1004h` : ""}`);
  cols = process.stdout.columns;
  rows = process.stdout.rows;
  if (img) base = fit(img, cols * cw * S, (rows - 1 - (rows >= 12 ? HEADER_ROWS : 0)) * ch * S);
  layout();
  process.stdout.on("resize", () => {
    out(`${ESC}[16t`);
    layout();
  });
  process.on("SIGTERM", quit);
}

main().catch((e) => {
  console.error(`orangeboard: ${e.message}`);
  process.exit(1);
});
