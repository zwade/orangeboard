# orangeboard

Terminal whiteboard (`oboard`) for sketching things to Claude. Uses the kitty graphics protocol + SGR pixel mouse reporting, so strokes are drawn at real pixel resolution.

```sh
yarn install
ln -s "$PWD/src/oboard.ts" ~/.local/bin/oboard   # Node ≥ 23.6 runs the .ts directly
```

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
