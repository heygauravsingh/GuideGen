# CLAUDE.md — GuideGen (pointer)

**The full product brief is not in this repo.** It lives at
`~/Desktop/backpocket/private/GuideGen/BRIEF.md` — two levels up, in the private folder:

```
../../private/GuideGen/BRIEF.md     the deep brief: every rule, and why it exists
../../private/GuideGen/PLAN.md      the backlog, and what was deliberately not built
../../private/GuideGen/store/       RUNBOOK.md (release steps) + LISTING.md (store copy)
```

**Why it's split:** this repo is **public**, because the code ships to every user's browser
anyway and because a public release hosts the narration voice files. The *thinking* —
competitor analysis, the backlog, what was rejected and why, the release procedure — is not
something to publish, so it sits in a private repo beside this one. Nothing in this repo is
secret; the keys it contains (Firebase web API key, OAuth client id, Cloudinary cloud name
and unsigned preset) are public by design and enforced by `firebase/firestore.rules`.

Read, in this order:

1. `../../AGENTS.md` — how to work here, who the work is for, and the documentation contract
2. `../../STATUS.md` — what is live, pending, blocked, waiting on a human
3. `../../private/GuideGen/BRIEF.md` — this product in depth. Read it in full before changing
   anything: most of its rules exist because a reasonable-looking simplification broke
   something, and each one says what went wrong.

Before saying a change is done:

```bash
node tools/recorder-test.mjs && node tools/buffer-test.mjs && node tools/net-test.mjs \
&& node tools/context-test.mjs && node tools/note-test.mjs && node tools/origin-test.mjs \
&& node tools/og-test.mjs && node tools/sync-web-assets.mjs --check \
&& node tools/make-icons.mjs --check && node tools/set-extension-key.mjs --check
```

**Do not touch the Chrome Web Store item while a review is pending** — uploading a package
restarts the queue.
