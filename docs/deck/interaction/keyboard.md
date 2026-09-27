# Keyboard map

Status: **Proposed**. The canvas used Alt chords everywhere (Decided direction) but had two conflicts that this map resolves. "Fast + keyboard-first" was not one of the owner's picks, so the mouse path must stay complete; every shortcut below duplicates a visible control.

## 1. Why Alt, and the terminal problem

The deck embeds real Claude Code terminals (xterm.js). Ctrl chords belong to the terminal (Ctrl C, Ctrl R, Ctrl K ...). Alt chords are free in the browser but some also mean something to Claude Code's input line:

| Chord | Meaning inside Claude Code (Likely, verify on the pinned version) |
|---|---|
| Alt P | switch model |
| Alt T | toggle extended thinking |
| Alt B / Alt F | word left / word right in the prompt |
| Alt digits, Alt U, Alt Y | readline-style meanings; rarely used |

Rule: when a terminal has focus, the deck intercepts only the **global set** (section 2). Every other key, including Alt P and Alt B, goes to the terminal. When no terminal has focus, screen-scoped keys (section 3) also apply.

Implementation: one `keydown` listener in the capture phase on `window`. For a focused xterm, use `term.attachCustomKeyEventHandler` and return `false` for chords in the global set so xterm does not also send them. Match on `event.code` (layout independent: `Digit1`, `KeyK`), not `event.key`, because Alt changes `key` on some layouts.

## 2. Global set (works everywhere, including inside a terminal)

| Keys | Action |
|---|---|
| Alt K | Open command palette |
| Alt N | Launch a session (new-session form) |
| Alt U | Open the Needs-you drawer |
| Alt 1 ... Alt 9 | Jump to session N in urgency order (same order as the Focus list and the palette) |
| Alt Shift 1 / 2 / 3 / 4 | Go to Sessions / Memory / Meetings / Settings (Rail). Replaces the canvas `Alt+1..3, Alt+,` which clashed with session jumps. |
| Alt Esc | Back to Home (all sessions) |
| Alt I | Show or hide the Focus side panel. Replaces the canvas `Alt B`, which is word-left in Claude Code. |

## 3. Screen-scoped keys (only when no terminal has focus)

| Screen | Keys | Action |
|---|---|---|
| Palette | Up / Down, also Alt J / Alt K while open | Move selection (Alt K moves up only while the palette is open; it opens the palette otherwise) |
| Palette | Enter | Run the highlighted item |
| Palette | Alt Enter | Open the highlighted session in Focus |
| Palette | `?` as first character | Ask the vault |
| Palette | `>` as first character | Run a command (`research <topic>`, `launch <repo>`) |
| Palette | Esc | Close |
| Needs-you drawer | Up / Down | Move between requests |
| Needs-you drawer | Alt A | Allow the focused request once |
| Needs-you drawer | Alt D | Deny the focused request |
| Needs-you drawer | Alt Shift A | Allow all Safe requests once (never includes Caution or Destructive) |
| Needs-you drawer | Esc | Close |
| Focus prompt bar | 1 / 2 / 3 | Same options, same numbers, as the Claude Code prompt in the terminal |
| Research form | Alt Enter | Send scouts (submit) |
| New session form | Alt Enter | Launch a ship (submit; Enter in the Task field adds a new line). Proposed, added for [screens/new-session.md](../screens/new-session.md) |
| Meeting live | Alt P | Pin the current moment (only when no terminal has focus, see section 1) |
| Any dialog | Esc | Cancel |

Destructive requests have no shortcut that approves them. Their confirm checkbox must be ticked with a click or Space, and the approve button is not the default button.

## 4. Display rules

- Write chords with a space: `Alt K`, `Alt Shift A`. Never `Alt+K`. (The canvas Rail used `+`; fix during the port.)
- Show a `kbd` chip only where the action has a shortcut. The palette shows the chip only on rows that have one.
- Home's "Launch a ship" button shows `Alt N` (the canvas showed it only on HomeCalm).
- Tooltips on Rail items: "Memory · Alt Shift 2".

## 5. Open points

- Whether Alt U, Alt I and Alt digits interfere with anything the owner uses in Claude Code. Test on the pinned version in M2 and adjust this table.
- Hyprland binds SUPER, not Alt, on Omarchy by default, so no desktop clash is expected. Verify against the owner's `hyprland.conf`.
