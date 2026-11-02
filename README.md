<div align="center">

<img src="docs/icon.png" width="96" alt="Claude Multi — desktop app for multiple Claude accounts" />

# Claude Multi

### Run multiple Claude accounts in one window. Auto-switch when one hits its limit.

[![Latest release](https://img.shields.io/github/v/release/Chamanrajragu/claude-multi?color=d97757&label=Latest+Release)](https://github.com/Chamanrajragu/claude-multi/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Chamanrajragu/claude-multi/total?color=4ec98a&label=Downloads)](https://github.com/Chamanrajragu/claude-multi/releases)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#download)
[![Plans from $5/month](https://img.shields.io/badge/Plans-from%20%245%2Fmonth-d97757)](https://purffle.com/claude-multi/pricing/)

**[🌐 Website](https://purffle.com/claude-multi/)** · **[💳 Pricing](https://purffle.com/claude-multi/pricing/)** · **[⬇ Download](https://github.com/Chamanrajragu/claude-multi/releases/latest)** · **[Quick start](#quick-start)**

<br/>

<img src="docs/screenshot-main.png" width="860" alt="Claude Multi desktop app — multiple Claude accounts, live usage meter, tool cards, parallel chats" />

</div>

---

## What is Claude Multi?

**Claude Multi** is a desktop app for Windows, macOS and Linux that runs
[Claude Code](https://claude.com/claude-code) with **several of your own Claude accounts in one window**.

When an account hits its usage limit, Claude Multi switches to the next free account, carries the conversation
over and **re-issues the interrupted instruction**, so a long task keeps running, even one that takes hours.

This repository holds the **installers and release notes**. Claude Multi is a paid product; its source code is not public.

## Pricing

| Plan | Price | Claude accounts |
|---|---|---|
| **Basic** | $5 / month | Up to 5 |
| **Pro** | $10 / month | Up to 20 |
| **Max** | see [pricing](https://purffle.com/claude-multi/pricing/) | Unlimited |

Every plan includes every feature and all updates. Billing is handled by Gumroad; cancel any time and your plan
stays active until the end of the period you paid for. **[Create an account →](https://purffle.com/claude-multi/sign_up/)**

## Key features

- **🔄 Auto-switch on usage limit**: the next free account picks up your task automatically.
- **🤖 24/7 auto-loop**: send a prompt on every account in rotation, wait for resets, repeat, even overnight.
- **🧵 Parallel chats**: several projects at once, each with its own folder, account and session.
- **⏳ Live cooldown timers**: see exactly when each account resets.
- **📊 Context inspector**: every file, tool and message in the context window, with token counts.
- **🧠 Every Claude model and effort level**, set per chat.
- **🎤 Offline voice-to-text**: a bundled speech model; your voice never leaves your computer.
- **🎨 Familiar UI**: feels like the official Claude desktop app, in dark and light.

## Download

| Platform | File |
|---|---|
| **Windows** | `Claude-Multi-Setup-<version>.exe` (installer) or `Claude-Multi-<version>.exe` (portable) |
| **macOS, Apple Silicon** (M1–M4) | `Claude-Multi-<version>-arm64.dmg` |
| **macOS, Intel** | `Claude-Multi-<version>.dmg` |
| **Linux** | `Claude-Multi-<version>.AppImage` |

All files are on the **[latest release](https://github.com/Chamanrajragu/claude-multi/releases/latest)** under **Assets**.

> **Windows SmartScreen:** the app is not code-signed yet. Click **More info → Run anyway**.
> **macOS:** on first launch, open **System Settings → Privacy & Security → Open Anyway**.

**You also need:** [Node.js 18+](https://nodejs.org) and the [Claude Code CLI](https://claude.com/claude-code) installed.

## Quick start

1. [Create a Claude Multi account](https://purffle.com/claude-multi/sign_up/) and pick a plan.
2. Install the app from the [latest release](https://github.com/Chamanrajragu/claude-multi/releases/latest) and sign in with the same email.
3. Click **New chat** and pick your project folder.
4. Open the **account switcher** (bottom left) → **Add account** → **Log in**, and sign in to Claude in the browser.
5. Repeat step 4 for each Claude account you own.

## Screenshots

<div align="center">

| Main chat | Auto-loop |
|:---:|:---:|
| <img src="docs/screenshot-main.png" width="420" alt="Main chat with diff tool cards and a streaming response" /> | <img src="docs/screenshot-autoloop.png" width="420" alt="Auto-loop rotating a prompt across every Claude account" /> |

| Usage dashboard | Context inspector |
|:---:|:---:|
| <img src="docs/screenshot-dashboard.png" width="420" alt="Account usage dashboard with cooldown timers" /> | <img src="docs/screenshot-context.png" width="420" alt="Context inspector showing what fills the context window" /> |

| Account switcher | Usage limit hand-over |
|:---:|:---:|
| <img src="docs/screenshot-accounts.png" width="420" alt="Account switcher with cooldown countdowns" /> | <img src="docs/screenshot-limit.png" width="420" alt="Usage limit reached, switching account and continuing" /> |

</div>

## Account safety and terms

Claude Multi is built for **one person using their own accounts**: not sharing, pooling or reselling access.
Each account signs in with its own normal subscription login and stays within its own quota.

**Important:** since February 2026, Anthropic's terms restrict using Pro/Max subscription credentials in
third-party tools (including the Agent SDK). Claude Multi does exactly that, and account restrictions can happen
without warning. Use it at your own risk, and read [Anthropic's terms](https://www.anthropic.com/legal/consumer-terms)
before deciding. Claude Multi is an independent product, not made or endorsed by Anthropic.

## Privacy

- Your conversations go only between your local `claude` process and Anthropic's servers.
- Claude account logins are written by Claude Code on your computer; Claude Multi never uploads them.
- The app contacts **purffle.com** only to check your Claude Multi plan, and GitHub to check for updates (can be switched off).
- No telemetry, no analytics, no crash reporting.

## Support

- **Bugs and feature requests:** [open an issue](https://github.com/Chamanrajragu/claude-multi/issues/new/choose).
- **Billing and account questions:** your [account page](https://purffle.com/claude-multi/account/), or the support address in the website footer.

## License

Claude Multi is proprietary software. Use requires a Claude Multi account and an active plan; see the
[terms of service](https://purffle.com/claude-multi/terms/) and [LICENSE](LICENSE).
Versions up to and including v1.30.7 were released under the MIT License.

© 2026 Purffle
