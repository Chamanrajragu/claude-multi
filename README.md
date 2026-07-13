<div align="center">

<img src="src/renderer/icon.png" width="104" alt="Claude Multi logo" />

# Claude Multi

**Run [Claude Code](https://claude.com/claude-code) with several accounts in one app — and switch automatically the moment one hits its usage limit.**

[![tests](https://img.shields.io/badge/tests-47%20passing-brightgreen)](test)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Free](https://img.shields.io/badge/price-100%25%20free-brightgreen)
![No tracking](https://img.shields.io/badge/telemetry-none-blue)
[![Download](https://img.shields.io/badge/download-Windows%20.exe-d97757)](https://github.com/Chamanrajragu/claude-multi/releases/latest)

**A free, open-source desktop app (GUI) for Claude Code — manage up to 20 Claude accounts, pick an account per project, and auto-switch when you hit a usage limit. Runs entirely on your machine and never stores or sends your credentials.**

<sub>Keywords: Claude Code GUI · Claude Code desktop app · multiple Claude accounts · Claude usage limit / rate limit workaround · Anthropic · multi-account account switcher · Windows · macOS · Linux</sub>

<br/>

<img src="docs/screenshot-main.png" width="820" alt="Claude Multi main window" />

</div>

---

## ⬇️ Download

**[Get the latest Windows build →](https://github.com/Chamanrajragu/claude-multi/releases/latest)**

Grab `Claude-Multi-…-win-x64-portable.zip`, unzip it anywhere, and run **`Claude Multi.exe`** — no installer required. (You'll still need [Node.js](https://nodejs.org) and [Claude Code](https://claude.com/claude-code) installed.) Prefer to run from source? See [Quick start](#quick-start).

## Why?

If you pay for more than one Claude plan, you've felt this: you're deep in a session, you hit the usage limit, and everything stops for hours — even though you have *another* account sitting idle.

**Claude Multi** keeps all of your accounts in one window. When the active account runs out, it detects the limit, carries your conversation over to the next available account, and continues it there — so you barely lose a beat.

No credential hacking, nothing against the rules — each account simply gets its own isolated config directory (the officially supported `CLAUDE_CONFIG_DIR` mechanism). These are **your** paid accounts.

## Features

- 💬 **A real chat interface, not a terminal** — talk to Claude in a clean chat window: streamed markdown replies, collapsible **tool cards** (edits, commands, searches), and inline **Allow / Deny** prompts before Claude touches your files.
- 🔁 **One conversation, any account** — your chat belongs to the **project**, not the account. Switch accounts and the conversation is carried over and continues right where it left off; the full history stays visible when you switch back or reopen the app.
- 🔄 **Auto-switch on usage limit** — the moment an account hits its Claude usage/session limit, Claude Multi rotates to the next available account (or asks first). No more waiting hours for a reset when you have another account idle.
- ⏳ **Cooldown tracking** — remembers when each rate-limited account resets and skips accounts that are still cooling down, picking the one that frees up soonest.
- 🧑‍🤝‍🧑 **Multiple accounts, fully isolated** — every account gets its own login/config directory (`CLAUDE_CONFIG_DIR`). No interference, no logging in and out by hand.
- 🎛️ **Model + effort picker** — choose the model (**Opus / Sonnet / Haiku**) and thinking effort (**Low / Medium / High / Ultrathink**) right in the composer.
- 📁 **A preferred account per project** — each project folder remembers which account it uses.
- 🔐 **Subscription login, no API key** — sign in each account once with your normal Claude subscription (Pro / Max / Team). Nothing is billed per token.
- 🔔 **Desktop notifications** when a limit is hit or an account switches.
- 🌗 **Dark & light themes** with a clean, Claude-style UI.
- 🔒 **100% local** — no telemetry, no analytics, and your logins never leave your machine.

## Why a desktop app instead of the raw terminal?

Claude Code is fantastic, but juggling several accounts by hand is painful: you log out and back in, you lose your place when you hit a limit, and there's no way to say "this project uses that account." Claude Multi gives you a clean chat window where every account is one click away, each project remembers its account, and hitting a limit just rotates to the next account — your conversation comes with you.

## Screenshots

<div align="center">

| Account switcher (Ctrl/Cmd + 1–9) | Auto-switch on limit |
| --- | --- |
| <img src="docs/screenshot-accounts.png" width="410" alt="Account switcher showing multiple Claude accounts with cooldown status" /> | <img src="docs/screenshot-limit.png" width="410" alt="Usage limit reached — switch account dialog" /> |
| Settings | Light theme |
| <img src="docs/screenshot-settings.png" width="410" alt="Settings" /> | <img src="docs/screenshot-light.png" width="410" alt="Light theme" /> |

</div>

## How it works

```
┌─────────────────────────────┐
│  Electron app (main.js)      │
│  • account store + settings  │
│  • usage-limit scanner       │
│  • account switching         │
└──────────────┬──────────────┘
               │ newline-delimited JSON over stdio
┌──────────────▼──────────────┐        each account →
│  pty-host.js (plain Node)    │        its own CLAUDE_CONFIG_DIR
│  • owns the real PTY         │   ~/.claude-accounts/<id>/
│  • runs `claude` per account │
└─────────────────────────────┘
```

Each account launches `claude` with `CLAUDE_CONFIG_DIR` pointed at its own folder, so logins never collide. When the scanner sees a limit message, the current account is stamped with a cooldown (parsed from the reset time) and the switch flow begins.

## Requirements

- [Node.js](https://nodejs.org) 18+ (Node 20+ recommended)
- [Claude Code](https://claude.com/claude-code) installed and on your `PATH` (or point to it in Settings)

## Quick start

```bash
git clone https://github.com/Chamanrajragu/claude-multi.git
cd claude-multi
npm install
npm start
```

Then:

1. **Pick your project folder** (top-left) — the folder Claude Code will work in.
2. Click **+** to add an account (add up to 20), then **Launch** it.
3. Type `/login` in the terminal to sign that account in.
4. Repeat for each account.
5. *(Optional)* Use **Account for this project** to pin a specific account to the current folder. Each project remembers its own account.
6. When one account runs out, you'll be offered a switch — your conversation carries over automatically.

## Building installers

```bash
npm run dist        # build for your current OS into ./dist
npm run dist:win    # Windows (NSIS installer + portable .exe)
npm run dist:mac    # macOS (.dmg)
npm run dist:linux  # Linux (AppImage)
```

> The packaged app keeps `asar` disabled so the PTY host and its prebuilt native binary load cleanly, and it expects Node.js on the user's `PATH`. Running from source (`npm start`) is the most reliable path.

### Optional: GitHub Actions (CI + releases)

Ready-to-use workflows live in [`docs/github-workflows/`](docs/github-workflows/):

- `ci.yml` — runs `npm test` on every push / PR.
- `release.yml` — on a `vX.Y.Z` tag, builds installers for Windows, macOS, and Linux and attaches them to a GitHub Release.

To activate them, copy the files into `.github/workflows/` and push:

```bash
mkdir -p .github/workflows
cp docs/github-workflows/*.yml .github/workflows/
git add .github/workflows && git commit -m "Enable GitHub Actions" && git push
```

(Pushing files under `.github/workflows/` requires a token with the `workflow` scope — run `gh auth refresh -s workflow` once if needed.)

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + P` | Command palette (fuzzy-search all actions) |
| `Ctrl/Cmd + 1…9` | Launch / switch to the Nth account |
| `Enter` / `Shift+Enter` | Send message / new line (in the chat bar) |
| `↑` / `↓` | Reuse recent prompts (in the chat bar) |
| `Win + H` | Windows Voice Typing into the chat bar (offline, no time limit) |
| `Ctrl/Cmd + F` | Search the terminal |
| `Ctrl/Cmd + Shift + C` | Copy selection |
| `Ctrl/Cmd + Shift + V` | Paste |
| `Ctrl/Cmd + =` / `-` | Bigger / smaller text |
| `Ctrl/Cmd + K` | Clear terminal |
| `Ctrl/Cmd + ,` | Open settings |
| `?` | Keyboard shortcuts cheatsheet |

## Tests

```bash
npm test
```

The suite covers the pure logic — usage-limit detection, reset-time parsing, account selection/cooldown, and the persistent store — including thousands of fuzzed cases.

## FAQ

### How do I use multiple Claude accounts at once?
Install Claude Multi, add each account, and sign in once per account. Claude Multi keeps every account in a single window and lets you switch between them with one click — each account stays fully isolated in its own config directory, so there's no logging in and out by hand.

### How do I avoid hitting the Claude Code usage limit?
You can't raise a single account's limit, but if you have more than one Claude plan you can keep working by switching accounts. Claude Multi detects the moment an account hits its usage/session limit and automatically continues your conversation on the next available account, so you don't have to wait hours for a reset.

### Can I run two (or three) Claude accounts on the same computer?
Yes. Claude Multi is built for exactly this — run 2, 3, or more Claude accounts side by side, each isolated, and switch instantly. Your conversation carries over when you switch.

### Is this against Anthropic's terms? Is it a hack?
No credential hacking is involved. Each account simply uses Claude Code's officially supported `CLAUDE_CONFIG_DIR` mechanism to keep its own login separate. These are **your** own paid accounts.

### Do I need an API key?
No. Claude Multi uses your normal Claude **subscription** login (Pro, Max, or Team) — the same one Claude Code uses. Nothing is billed per token.

### Does it work with Claude Pro and Claude Max?
Yes — any plan that works with Claude Code works here, including Pro, Max, Team, and Enterprise subscription logins.

### Is Claude Multi free?
Yes, 100% free and open source (MIT). No telemetry, no accounts on our side, and your logins never leave your machine.

### What platforms are supported?
Windows today (portable build). The app is built with Electron and the codebase targets macOS and Linux as well.

## Free & open source

Claude Multi is **completely free** and **open source (MIT)**. There is no paid tier, no account to create, no ads, and **no monetization of any kind** — the author earns nothing from it. Use it, fork it, and modify it however you like.

## Privacy — we never store your credentials

**Claude Multi does not collect, transmit, or store your Claude credentials — ever.**

- 🔒 **Logins are handled entirely by Claude Code**, inside each account's own local config folder (`~/.claude-accounts/<id>/`) on *your* machine. The app never reads, copies, or uploads your tokens.
- 🖥️ **Everything stays local.** The only data the app itself saves is your account *labels* and preferences, in Electron's `userData` folder on your computer. Nothing leaves your device.
- 📡 **Zero telemetry.** No analytics, no tracking, no phone-home, no external servers. The app talks only to your local `claude` process.
- 🚫 `.gitignore` excludes `accounts.json` and `.claude-accounts/`, so credentials can never be committed by accident.
- ✅ All it does is set the officially supported `CLAUDE_CONFIG_DIR` environment variable per account — exactly as documented by Claude Code.

Don't take our word for it — [the entire source is right here](src/) to read.

## Limitations

- A usage limit is enforced server-side, so a session can't be handed off mid-request. The switch ends the current session and resumes on the next account — near-seamless, not literally invisible.
- Limit-message wording can change over time; detection patterns live in [`src/limits.js`](src/limits.js) and are easy to extend.

## Author

Made by **Chaman Raj** — [github.com/Chamanrajragu](https://github.com/Chamanrajragu)

If this saved you from a mid-session usage wall, a ⭐ on the repo is appreciated!

## License

[MIT](LICENSE) © 2026 Chaman Raj

> Not affiliated with Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.
