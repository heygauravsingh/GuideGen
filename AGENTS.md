# GuideGen — read CLAUDE.md in this folder

The full brief for this product is [`CLAUDE.md`](./CLAUDE.md), in this directory. It is long
and it is worth reading in full before changing anything: most of its rules exist because a
reasonable-looking simplification broke something in production, and each one says what went
wrong.

Also read, in the house root two levels up (`../../`):

1. `AGENTS.md` — how to work here, and the documentation contract you must follow
2. `STATUS.md` — where this product stands right now, including what is mid-review
3. `WORKLOG.md` — what has already been done and why

Before you say a change is done, run the checks:

```bash
node tools/recorder-test.mjs && node tools/buffer-test.mjs && node tools/net-test.mjs \
&& node tools/context-test.mjs && node tools/note-test.mjs && node tools/origin-test.mjs \
&& node tools/og-test.mjs && node tools/sync-web-assets.mjs --check \
&& node tools/make-icons.mjs --check && node tools/set-extension-key.mjs --check
```

Release procedure, including the build commands and every step that needs Gaurav's hands:
`store/RUNBOOK.md`. **Do not touch the Chrome Web Store item while a review is pending** —
uploading a package restarts the queue.
