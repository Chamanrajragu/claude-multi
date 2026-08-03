<div align="center">

<img src="src/renderer/icon.png" width="96" alt="Claude Multi" />

# Claude Multi

### The free desktop app that runs all your Claude accounts in one window

[![Latest release](https://img.shields.io/github/v/release/Chamanrajragu/claude-multi?color=d97757&label=Latest)](https://github.com/Chamanrajragu/claude-multi/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Chamanrajragu/claude-multi/total?color=4ec98a&label=Downloads)](https://github.com/Chamanrajragu/claude-multi/releases)
[![Stars](https://img.shields.io/github/stars/Chamanrajragu/claude-multi?style=flat&color=f5c518&label=Stars)](https://github.com/Chamanrajragu/claude-multi/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

**[⬇ Download for Windows](https://github.com/Chamanrajragu/claude-multi/releases/latest) · [All Releases](https://github.com/Chamanrajragu/claude-multi/releases) · [Quick Start](#quick-start)**

</div>

---

## What is Claude Multi?

**Claude Multi** is a free, open-source desktop app that lets you run [Claude Code](https://claude.com/claude-code) with **multiple Claude accounts** in one window — and automatically switches accounts the moment one hits its usage limit.

If you have ever hit Claude's 5-hour usage limit mid-task and watched everything stop, this fixes that. Claude Multi detects the limit, switches to your next available account, carries your conversation over, and **continues the task automatically** — without you doing anything.

> **No API key required.** Works with your normal Claude Pro / Max / Team subscription. 100% local — no telemetry, no servers, your data never leaves your machine.

---

## Key Features

<table>
<tr>
<td width="50%">

**🔄 Auto-switch on usage limit**  
Hits a limit? Automatically switches to your next account and re-issues the interrupted instruction — task continues without a pause.

**🤖 24/7 Auto-loop**  
Set a prompt once. Claude Multi rotates through all your accounts, sends the prompt, waits for the 5-hour reset, and repeats — forever, even while you sleep.

**🧵 Parallel chats**  
Run multiple chats simultaneously, each on its own folder and account. A live spinner shows which are busy.

**⏳ Live cooldown timers**  
See which accounts are ready and exactly how long until a cooling one resets — updated every second.

</td>
<td width="50%">

**📊 Context inspector**  
See exactly what is filling your context window — every file, tool, and memory item with a token count.

**🔎 @file autocomplete**  
Type `@` in the composer to pick any file from your project. Tab to insert, arrows to navigate.

**🎨 Beautiful, familiar UI**  
Looks like the Claude desktop app. Dark/light themes, accent colors, syntax-highlighted code blocks with language labels.

**🔒 100% private**  
No telemetry, no analytics, no servers. Logins, chats, and settings live only on your computer.

</td>
</tr>
</table>

---

## Download

<div align="center">

| Platform | File |
|----------|------|
| **Windows — Installer** (recommended) | [Claude-Multi-Setup-1.26.0.exe](https://github.com/Chamanrajragu/claude-multi/releases/latest) |
| **Windows — Portable** (no install) | [Claude-Multi-1.26.0.exe](https://github.com/Chamanrajragu/claude-multi/releases/latest) |
| **macOS** | [Claude-Multi-1.26.0-arm64.dmg](https://github.com/Chamanrajragu/claude-multi/releases/latest) |
| **Linux** | [Claude-Multi-1.26.0.AppImage](https://github.com/Chamanrajragu/claude-multi/releases/latest) |

</div>

> **Windows SmartScreen warning:** The app is not code-signed yet. Click **More info → Run anyway**. The source is fully open — [read it yourself](src/).

**Requirements:** [Node.js 18+](https://nodejs.org) and [Claude Code](https://claude.com/claude-code) installed on your machine.

---

## Quick Start

**Option A — Download installer** (easiest)

1. Grab the installer from [Releases](https://github.com/Chamanrajragu/claude-multi/releases/latest)
2. Run it and follow the steps
3. Open Claude Multi

**Option B — Run from source**

```bash
git clone https://github.com/Chamanrajragu/claude-multi.git
cd claude-multi
npm install
npm start
```

**First-time setup:**

1. Click **New chat** and pick your project folder
2. Open the **account switcher** (bottom-left) → **Add account**
3. Click **Log in** and sign in when your browser opens
4. Repeat for each Claude account you have
5. Choose an account and start chatting — Claude Multi handles the rest ✓

---

## Full Feature List

### Multi-Account Management
- Add up to 20 Claude accounts, each fully isolated via `CLAUDE_CONFIG_DIR`
- **Auto-switch on usage limit** — switches and re-issues the interrupted instruction automatically
- **One-click switching** with `Ctrl/Cmd + 1…9`
- Conversation **carried over** to the new account — no copy-pasting ever
- Per-project account memory — each folder remembers which account to use
- Activity dashboard showing every account's status, cooldown, and token usage since last reset
- Clear cooldown manually if needed

### 24/7 Auto-Loop
- Set a prompt once — runs on all accounts in rotation, indefinitely
- Creates a **fresh chat per account per round** to keep context minimal and cheap
- Live status table: each account's round status and cooldown countdown
- Round counter, total sends, wait-reason display
- Auto-loop status visible in the **system tray** — stop it without opening the app

### Chat Experience
- Run **multiple parallel chats**, each with its own folder and session
- Real-time streamed markdown rendering
- **Syntax-highlighted code blocks** with language labels and one-click copy
- **Red/green diff view** for every file Claude edits
- Collapsible **tool cards** (📖 Read · ✏️ Edit · ⌨️ Bash · 🔍 Search · 🌐 Web)
- Inline **Allow / Deny** permission cards before Claude touches files
- **Thinking blocks** in collapsible details panels
- **Edit & resend** any previous message
- **Retry** to regenerate the last response
- `/compact` in the composer to compact instantly

### Composer
- **@file autocomplete** — type `@` to search and insert any project file
- **Voice to text** — mic button for hands-free dictation
- **Prompt templates** — save and reuse your best prompts
- **Paste images** directly — screenshots, browser images, any format
- **Drag and drop files** onto the window
- **Character counter** at 200+ chars, red warning at 8K
- **Prompt history** — Up/Down to recall previous messages
- **Per-chat draft saving** — unsent text kept when switching chats

### Token & Quota Management
- **Context inspector** (`Ctrl/Cmd + Shift + K`) — item-by-item breakdown with token counts
- **Live token meter** — % used and tokens remaining, always visible
- **Auto-compact** — summarizes before context overflows
- **Long-chat warning** — suggests compact or new chat at your threshold
- **Budget caps** — stop a turn after N steps or $X spend (catches runaway loops)
- **Turn off unused tools** — drop subagents, web search, fetch, todos, notebooks
- **Per-chat model and effort** — Opus for hard work, Haiku for quick edits
- **Least-used account switching** — always start on the account with the most quota

### Navigation & UI
- **Command palette** (`Ctrl/Cmd + K`) — every action, chat, and account in one place
- **Full-text search** across all chats (`Ctrl/Cmd + F`)
- **Find in chat** (`Ctrl/Cmd + Shift + F`)
- **Drag-to-reorder** chats in the sidebar
- **Pin chats** to keep important ones at the top
- `Alt + ↑/↓` to cycle between chats
- **Recent projects** — right-click New Chat to jump to a recent folder instantly
- Resizable sidebar with drag handle
- **Zoom** the whole UI (`Ctrl/Cmd + = / − / 0`)

### Reliability & Privacy
- **Session auto-restart** — stale sessions detected and restarted transparently with a toast
- **Background chat saving** — off-screen chats save correctly even when you are not looking
- **Desktop notifications** when a chat finishes or needs approval
- **Export to Markdown** — single chat or all chats at once
- **Backup and restore** — export/import accounts and settings (no credentials)
- Zero telemetry · Zero analytics · Zero outbound requests

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + K` | Command palette |
| `Ctrl/Cmd + N` | New chat (same folder) |
| `Ctrl/Cmd + F` | Search all chats |
| `Ctrl/Cmd + Shift + F` | Find in this chat |
| `Ctrl/Cmd + Shift + K` | Context inspector |
| `Ctrl/Cmd + B` | Toggle sidebar |
| `Ctrl/Cmd + /` | Keyboard shortcuts sheet |
| `Ctrl/Cmd + 1…9` | Switch to Nth account |
| `Alt + ↑ / ↓` | Previous / next chat |
| `Ctrl/Cmd + = / − / 0` | Zoom in / out / reset |
| `↑ / ↓` (empty composer) | Recall previous prompts |
| `Enter` | Send message |
| `Shift + Enter` | New line |
| `Esc` | Stop generation / close dialog |
| `/compact` in composer | Compact this chat |

---

## How It Works

Each account gets its own `~/.claude-accounts/<id>/` directory — the officially documented `CLAUDE_CONFIG_DIR` mechanism — so logins never collide.

Chats run through the **official Claude Agent SDK** using your **subscription login**. Signing in runs `claude /login` once per account in a small terminal (OAuth needs an interactive session). After that: clean chat window.

**When a usage limit hits:**
1. Account stamped with cooldown (reset time parsed from the server response)
2. If another account is free → transcript copied, session resumed with `--resume`
3. Interrupted instruction **re-issued automatically** on the new account
4. Work continues — you barely notice

---

## Making Your Quota Last

Every turn re-sends the full context: conversation history + CLAUDE.md + all tool descriptions. Claude Multi gives you precise control:

| Action | Where | Effect |
|--------|--------|--------|
| `/compact` in composer | Composer | Summarizes the chat, drops reasoning |
| **Low effort** | Effort slider | Disables extended thinking entirely |
| **Turn off Subagents** | Settings → Tokens | Single biggest token saver |
| **Budget cap** | Settings → Tokens | Stops runaway agent loops |
| **Context inspector** | `Ctrl + Shift + K` | Shows exactly what is costing you |
| **Haiku for quick tasks** | Model picker | Fraction of Opus cost |

---

## Account Safety & Anthropic Terms

Claude Multi is for **one person, their own accounts** — not account sharing, pooling, or reselling. Each account uses its normal subscription login via `CLAUDE_CONFIG_DIR` and stays within its own quota.

Since February 2026, Anthropic's terms restrict using a Pro/Max subscription login in third-party tools (including the Agent SDK). This tool does that. Enforcement can happen without notice.

**Honest summary:** use at your own risk. Zero risk = use Claude Code/claude.ai directly. Read [Anthropic's terms](https://www.anthropic.com/legal/consumer-terms) yourself before proceeding.

---

## Privacy

Claude Multi is **100% local** — verify everything in the [source code](src/):

- No telemetry, no analytics, no crash reporting, no update beacons
- No outbound network requests from the app itself
- Your conversations travel only between your local `claude` process and Anthropic
- OAuth tokens are written by Claude Code locally — Claude Multi never reads or transmits them
- Settings and chat history stay in Electron's local `userData` folder

---

## Build from Source

```bash
npm run dist          # current platform
npm run dist:win      # Windows installer + portable .exe
npm run dist:mac      # macOS .dmg
npm run dist:linux    # Linux AppImage
```

Tag a release and GitHub Actions builds and uploads automatically:

```bash
git tag v1.X.0 && git push --follow-tags
```

---

## Tests

```bash
npm test
```

Covers usage-limit detection, reset-time parsing, account selection, cooldown logic, and the store — including thousands of fuzzed inputs.

---

## FAQ

**Do I need an API key?**  
No. Works with your Claude Pro / Max / Team subscription — same as Claude Code.

**Is it free?**  
Yes — 100% free and open source (MIT). No paid tier, no account, no ads, no monetization.

**What platforms?**  
Windows, macOS, and Linux.

**Is it against Anthropic's terms?**  
Not account-sharing. But Anthropic's Feb 2026 terms restrict subscription logins in third-party tools. Use at your own risk. See [Account Safety](#account-safety--anthropic-terms).

**How many accounts can I add?**  
Up to 20.

**Why is Claude burning through my tokens so fast?**  
Usually the context, not your prompts. Open the **Context Inspector** (`Ctrl/Cmd + Shift + K`) — it shows exactly what is using your quota. See [Making Your Quota Last](#making-your-quota-last).

**Can it run while I sleep?**  
Yes — the **Auto-loop** feature sends your prompt on all accounts in rotation, waits for resets, and repeats indefinitely.

**Can I run multiple Claude accounts on the same computer?**  
Yes — that is exactly what Claude Multi is for. Each account is fully isolated; switching is one click.

---

## Author

Built by **Chaman Raj** — [github.com/Chamanrajragu](https://github.com/Chamanrajragu)

If Claude Multi saved you from a usage wall, a ⭐ on this repo helps others find it!

---

## License

[MIT](LICENSE) © 2026 Chaman Raj

> Not affiliated with Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

<!-- SEO keywords: Claude Multi · Claude Code GUI · Claude Code desktop app · multiple Claude accounts · Claude usage limit workaround · Claude rate limit fix · Claude Code multi-account · auto-switch Claude accounts · Claude Pro multi-account · Claude Max multiple accounts · Claude Code token saver · reduce Claude token usage · Claude context window inspector · Anthropic Claude desktop app · Claude Code Windows · Claude Code Mac · Claude 5-hour reset · Claude usage limit bypass · Claude account switcher · open source Claude client · claudemulti · claude-multi · Claude Code interface · Claude parallel chats · Claude Code electron app -->
