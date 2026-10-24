# `orangeboard ✳`

Terminal whiteboard (`oboard`) for sketching things to Claude. Uses the kitty graphics protocol + SGR pixel mouse reporting, so strokes are drawn at real pixel resolution.

| Prompt | Result |
| --- | --- |
| <img width="2048" height="1287" alt="df3e6080-12e1-45a3-8046-7e533753abbc" src="https://github.com/user-attachments/assets/6a846edf-5d7b-4fca-b7f2-58dadb30f265" /> | <img width="984" height="960" alt="Screenshot 2026-10-24 at 9 21 48 AM" src="https://github.com/user-attachments/assets/1349974c-ac8e-4150-8604-3ef8b054e23c" /> |

## Install

To install and get started, run 

```sh
npm i -g orangeboard

# Optional
oboard install-claude

# From the same directory as your claude project
oboard
```

## Install for development

```sh
yarn install
yarn build        # also runs automatically on pack/publish (prepack)
npm install -g .  # links `oboard` (dist/oboard.js) onto your PATH
```

## Usage

| input | action |
| --- | --- |
| left drag / right drag | draw / erase |
| `⌫` or `~` | toggle eraser (left drag erases) |
| `t` | text mode: click to place, type (`⌫` deletes, `⏎` new line), click or `esc` to finish |
| `w` `k` `r` `g` `b` | white, black, red, green, blue |
| `1` `2` `3` | pen / text size |
| `u` / `c` / `d` | undo / clear (undoable) / light-dark |
| `s` / `⏎` | save / save + quit |
| `q` | quit |

The toolbar is clickable too. Saving crops to the drawing, writes `~/.orangeboard/sketches/<timestamp>.png` + `~/.orangeboard/latest.png`, and copies the PNG to the clipboard (paste into Claude Code with ctrl+v).

`oboard file.png` opens an image to annotate; `oboard --resume` reopens the latest sketch.

## Claude Code integration

```sh
oboard install-claude
```

Adds a `UserPromptSubmit` hook to `~/.claude/settings.json` that tells Claude about sketches saved since your last message (so it reads them automatically), and a `/sketch` skill that reads `latest.png`.

## Terminal Support

Supports iTerm2, Ghostty, WezTerm, and kitty all via the kitty graphics protocol.

> [!WARNING]
> Works inside tmux via passthrough (enabled automatically), though tmux only reports mouse position per cell; strokes are smoothed to compensate.

Use `OBOARD_SCALE=n` to override the canvas pixel density (default 2× on macOS).

## Contributions and Maintenance

This code is 100% slop! I through this together because I needed it to sketch out something for a design project. If you end up using this in any kind of way please let me know so I can actually deslopify it (and put some real time and thought into it!)
