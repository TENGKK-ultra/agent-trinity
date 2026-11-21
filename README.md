# Agent Trinity

A local desktop workbench for running several coding agents side by side.

> The desktop window and the executable are still called **Trinity** — the
> repository name just makes it easier to find among the other projects with
> that name.

Trinity is not another agent. It is the room the agents sit in: one place to
start Claude Code, Codex and DeepSeek Harness, give each of them a workspace,
watch what they are doing, and decide who gets to do what.

Everything runs on your machine. There is no account, no server, no telemetry.

---

## What it actually does

- **Threads with real state.** Each chat remembers which agent was running,
  which directory it worked in, which conversation on the agent's side it
  belongs to, and which permission mode was approved.
- **A whiteboard, not a task queue.** Cards are created by you (or by an agent),
  and agents **claim** them. Core hands out a lease, counts the rounds, and
  takes the card back when the lease expires. Core never decides who should do
  what — that is the whole point.
- **Cross-check rounds.** Claude runs, DeepSeek Harness checks, Codex sums up.
  The platform counts the rounds mechanically and stops at the limit. It does
  not judge whether the work was good.
- **Per-chat permissions.** Manual approval, accept edits, plan, or full access
  — one setting per conversation, applied to the actual CLI invocation.
- **An event timeline.** Whatever Core itself observed — a task starting, a
  process failing to launch, a timeout, a process that would not exit — lands
  in one list you can filter.
- **Global search.** Titles and everything that was actually said, across every
  conversation.

## What it deliberately does not do

- It does not understand your goal, split it into tasks, or pick an executor.
- It does not judge whether an answer is correct.
- It does not call any model itself. Your agents call their own providers with
  their own logins.

This is a design position, not a missing feature. See [Why](#why) below.

---

## Requirements

| Thing | Version |
| --- | --- |
| Node.js | 24+ (uses native TypeScript type stripping and `node:sqlite`) |
| Rust + Tauri CLI | only if you want to build the desktop binary |
| At least one agent CLI | Claude Code, Codex, or DeepSeek Harness, installed and logged in |

The agents are separate products. Trinity drives them through their own CLIs
and inherits whatever plan or subscription you already have.

## Run it

```bash
# Core (the bridge)
cd trinity-core
npm install
npm start            # listens on 127.0.0.1:3210

# Desktop (dev mode, in another terminal)
cd trinity-desktop
npm install
npm run dev

# Desktop (packaged)
npm run tauri build -- --no-bundle
```

The Core only ever binds to loopback. There is a guard that refuses to start on
`0.0.0.0` — a local bridge should not be reachable from the network.

## Layout

```
trinity-core/        Node + SQLite. The bridge: threads, cards, rounds, events.
  src/api/           HTTP surface, one file per resource
  src/harnesses/     One adapter per agent CLI
  src/board/         Cards, leases, expiry
  src/events/        What Core observed
  src/search/        Titles and messages
  tests/             node --test, no network, no real agents

trinity-desktop/     Tauri 2 + React 19 + Vite
  src/features/      One folder per page
  src/i18n/          Message table and the language store
  src-tauri/         The Rust shell (tray, splash window, single instance)
```

## Why

Most multi-agent tools try to be the manager: they take your goal, break it
down, hand pieces to whoever looks best, and declare victory.

That works right up until it does not, and when it fails you cannot see where.

Trinity went the other way. Core keeps the books — who is here, what is open,
who holds which card, how many rounds are left — and stops there. The agents
read the board and decide for themselves. Order comes from visibility, not from
commands.

The same instinct shows up in the smaller choices: permissions belong to the
conversation, background context is stitched from exactly the chats you ticked,
and nothing is injected that you did not choose.

## How to use it

1. **Open a chat and give it a workspace.** Every chat runs in a directory; the
   sidebar picks one per agent and remembers it. No workspace, no turn — that
   is on purpose, so nothing runs in a directory you did not choose.
2. **Send a message.** The lit agents answer according to the send mode: Team
   (only Codex dispatches), Everyone (each lit agent answers), or Codex runs
   (Codex does the work itself). An `@mention` always wins over the mode.
3. **Put work on the board.** Create a card with a goal and acceptance criteria
   on the Board page. Send one message in the same chat (or press Start
   cross-check) and the agents finally see it — the card is invisible until a
   turn is running.
4. **Watch the rounds.** Claude runs, DSH checks, Codex sums up. The platform
   counts rounds mechanically and stops at the limit you set in Settings. It
   never decides that a card is good — you do.
5. **Check the receipts.** Events shows what Core itself observed; search finds
   anything you or the agents said; usage shows tokens and cost per agent.

## Feature status

Everything in this table exists in the code. "Partial" means it works but has a
known gap.

| Feature | State | Notes |
| --- | --- | --- |
| Three agent adapters (Claude Code / Codex / DSH) | Done | Drives their CLIs; inherits their own logins |
| Chats with resume, rename, auto titles | Done | |
| Per-agent workspaces | Done | Required before a turn can run |
| Board: create / claim / renew / release / complete / fail / post | Done | Card events are append-only |
| Cross-check rounds with a global limit | Done | Colour-coded 1–10, snapshotted per card |
| Per-chat permissions | Done | Manual / accept edits / plan / full access |
| Projects and cross-chat background | Done | Background is stitched from the chats you tick |
| Usage per agent (tokens, cost) | Done | |
| Event timeline with filters | Done | Only what Core itself wrote |
| Global search (titles + messages) | Done | Ctrl+K |
| Theme (system / light / dark) | Done | |
| Tray, single instance, close-to-tray, splash | Done | Windows |
| English interface | **Partial** | Shell, settings and inspector are translated; page bodies are still Chinese |
| Board as MCP tools | **Not yet** | Agents currently claim cards by writing a one-line action at the end of a reply |
| Scheduled wake-ups / observation loop | **Not yet** | |
| Central-scheduler mode | **Not yet** | Deliberately demoted; the board is the default |
| Remote or mobile access | **Not yet** | Local only, by design |

Tests: `npm test` in `trinity-core` (449) and in `trinity-desktop` (103).
Expect rough edges — this is an early project, not a finished product.

## License

MIT. See [LICENSE](LICENSE).
