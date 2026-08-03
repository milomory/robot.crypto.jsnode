# Agent Instructions

- Read local `README.md` and relevant files in `docs/` before substantial work.
- Protect secrets: do not print, expose, or commit tokens, credentials, `.env` values, or private config.
- Treat existing modified or untracked files as user work. Do not delete, move, clean, rename, format, or reorganize files unless explicitly requested.

## Shared memory-core

- When available, check shared memory-core before substantial work.
- Search memory context for `project:robot-crypto-jsnode`.
- After meaningful changes, write short decision or event summaries to shared memory-core when available.
- If memory-core is unavailable, say so explicitly in status or handoff notes.
- Local or normal Mac Codex can use `http://127.0.0.1:8765` directly with the token from `MEMORY_CORE_TOKEN`.
- Bridge-driven Codex may receive memory context injected by OpenClaw because the bridge sandbox has no direct network access.
