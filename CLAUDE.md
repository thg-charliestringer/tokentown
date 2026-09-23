# Tokentown

A local page showing every Claude Code session on this Mac as an animated village (Village view) or a kanban
(Board view). See [README.md](README.md) for what it does, the lane rules, what it reads and the security model.
It was called ccboard. The launcher is `tokentown`, the package is `town`, and its files live in
`~/Library/Application Support/tokentown/`.

## Layout

```
tokentown            launcher: start/open, url, serve, stop, check, rotate
town/paths.py        constants, Paths (every folder Claude may use), the read denylist, PR_URL_RE,
                     RELEASE_TAG_RE, ids and ports
town/model.py        dataclasses shared by every module
town/sources.py      Scanner: desktop records, live registry, transcript tails, ps, background work
town/usage.py        TokenLedger: token counts, read incrementally from transcripts
town/prlinks.py      PrLinkIndex: pr-link records from transcripts, read incrementally
town/status.py       tail verdict: what the end of a transcript says a session is doing
town/board.py        lanes, sorting, counts, health -> the /api/board JSON (pure: no I/O, no clock)
town/github.py       PrStateResolver: PR state through gh, read-only
town/reviews.py      ReviewSource and ReviewOpener: PRs waiting on your review, through gh
town/updates.py      UpdateChecker: whether a newer release is out (the clone's .git, two gh reads), and Update now
town/done.py         DoneStore: done.json (Valhalla marks)
town/linkstore.py    LinkStore: links.json (PR links that outlive deleted transcripts)
town/privatejson.py  load and atomic write of Tokentown's own small JSON files
town/security.py     secret, HMAC launch codes and tokens, request guards
town/actions.py      open a session in Claude or its editor (VS Code, Insiders, Cursor), resume command
town/server.py       ThreadingHTTPServer, scan thread, PR, review and update threads, Update now and its restart
town/check.py        `tokentown check` report
web/index.html       page shell, keys overlay and the How it works page
web/app.js           claim, polling, top bar, update banner, What's new, list, Board, card, keys
web/app.css          styles
web/village.js       the Village canvas: places, characters, world of islands, interiors, visitors
tests/fixtures.py    synthetic home builder
tests/test_*.py      unittest suites, one per module (test_status.py also covers board.py and check.py, and
                     test_updates.py covers actions.update_command)
tests/web_harness.mjs headless node checks of village.js and app.js, run by tests/test_web.py
tools/privacy_scan.py  what a clone of this repo would give a stranger: run by hand, never by the server
.github/workflows/tests.yml  for every PR: the suite on GitHub's macOS runner under Python 3.13 and 3.14, and
                     the privacy scan (credentials and the PRIVATE_WORDS secret; a runner has no Claude folder)
```

## Commands

```bash
# All tests (about 40 s). Run from the repo root, with Python 3.13 or later.
python3 -m unittest discover -s tests -t .

# One suite
python3 -m unittest tests.test_status

# The web harness alone: prints one JSON line, {"passed": [...], "failed": [...]}
node tests/web_harness.mjs | tail -1 | python3 -c 'import json,sys; r=json.load(sys.stdin); print(len(r["passed"]), "passed"); [print(f["name"], "->", f["message"]) for f in r["failed"]]'

# Live health report without a browser, including whether a newer release is out
./tokentown check

# What a clone would give a stranger. Run it before publishing a release. --words names a file of your own
# words (employer, team and project names), kept outside the repo.
python3 tools/privacy_scan.py --words ~/.tokentown-private-words

# Publish a release: Charlie's call, never a session's. Merge first, then check the tag names main's commit
gh release create v1.2.0 --target main --generate-notes
git ls-remote origin refs/heads/main refs/tags/v1.2.0
```

**Only one server runs at a time, and a checkout reuses whatever is running.** Every copy shares the secret in
`~/Library/Application Support/tokentown/`, and the launcher reuses any server on `127.0.0.1:47291` that holds it.
Charlie's everyday copy runs from its own clone under `~/tools`. To see changes from this checkout, run
`./tokentown stop` and then `./tokentown` from here. Afterwards, stop it and start the everyday copy again, so no
server is left running from a worktree.

**Trying updates for real.** A published release is tried on the everyday copy itself: `tokentown check` there says
at once whether it is out, and restarting that copy brings the banner without waiting for the hourly check. An
unreleased build is tried from a scratch clone on `main` with its origin set to the GitHub URL, since only the fixed
port is real: stop the everyday server, start the clone's with `./tokentown url`, open the link in the app's own
browser pane (never Safari) with privacy mode on before any screenshot, then stop it and start the everyday copy
again.

## Hard rules

- **Python 3.13 or later, stdlib only.** The launcher runs under the `python3` on PATH, runs itself again under a
  newer one it finds (`find_python`) when that is too old, and starts the server with the same interpreter.
  Everything in `tokentown` above its version check must still parse and run under the 3.9 that macOS ships. The web
  side is vanilla HTML, CSS and JS: no npm, no CDN, no web fonts, no build step. npm and CDNs are blocked on this
  laptop.
- **Read-only on every Claude folder.** The only files written are Tokentown's own, in
  `~/Library/Application Support/tokentown/`: `secret`, the short-lived `launch-*.webloc`, `done.json` and `links.json`.
- **Every session-store read goes through `paths.open_for_read`**, which enforces the denylist (`*.key`,
  `config.json`, Cookies and the rest).
- **Keep structure only.** Never keep, send or log prompts, `lastPrompt`, message text, tool inputs or error text.
  Transcripts contain client data. The one exception is a session's title: the newest `customTitle`, else `aiTitle`,
  in a transcript's tail is kept and shown the way a desktop title is, cut to 200 characters, hidden by privacy mode
  and never logged. Titles are hostile text.
- **Never log titles or session-store paths.** `log_message` is a no-op, and an exception logs its class name only.
- **Fixed subprocesses only**: `/bin/ps`, `/usr/bin/open` (an allowlisted `claude://` URL, a PR URL matching
  `PR_URL_RE`, Safari with the launch file, or for a session in an editor `-b` with that editor's bundle id from
  `paths.EDITORS` and the session's own existing folder, and a session URL matching `EDITOR_OPEN_URL_RE`), the six
  `gh` reads in `github.py`, `reviews.py` and `updates.py`, and for Update now only, the two git commands and the start
  check's Python in `updates.py`. Always an absolute path, an argument list, `shell=False` and a minimal env: the server
  gets only the launcher's `PASS_ENV`, `gh` only `GH_ENV_KEYS`, and git those plus `GIT_ENV`. Never put a launch code in
  argv. No osascript or shell, and git only as those two commands.
- **Update now only on a click.** The fetch, the merge and the restart run from `POST /api/update` alone, never on a
  timer or from a scan: whoever can publish a release on the clone's `origin` decides what runs next.
- **Releases are Charlie's call.** Never create, edit or delete a release or a tag unless he asks: publishing one
  ships code to every colleague's Mac.
- **GitHub is read-only.** Never add another `gh` command (no `pr create`, `merge`, `comment` or `auth`).
- **Never run `open` against a real session, and never launch Safari or a URL** during development or tests. Tests
  mock `subprocess.run`, use a synthetic home, and fail if a real `gh` is launched. The `check` tests stand in for
  `check.load_update_health`, because the real one asks GitHub about this checkout.
- **When inspecting real data, print field names, enum values and counts only.**
- **Hostile text stays text.** The page builds its DOM with `textContent` only, and the CSP allows no inline script
  or style.

## Conventions

- **Comments explain non-obvious gotchas only.** Say why, not what.
- **No em dashes** in UI copy or docs. Use a colon, a comma or two sentences.
- **UI copy is plain and British**: colour, favour. It refers to Charlie as "you".
- **Keep the README true.** When behaviour a user can see changes, update the README and the page's own help (the
  keys overlay and How it works in `web/index.html`) in the same change.
- **Commit messages** are a short plain-English title in the imperative or as a noun phrase ("A How it works page",
  "Keep the top bar on one row"), with a body saying what changed and why.
- **PR titles become release notes.** `gh release create --generate-notes` lists the titles of the PRs merged since
  the last release, and What's new shows them to everyone who updates. Title a PR in the same plain style, for them.
- **Scan before you publish.** GitHub runs the credential and word-list halves on every PR. The full scan,
  including this Mac's own data, is `python3 tools/privacy_scan.py`, which reads every blob, commit message and tag on every
  published ref, including the `refs/pull/*` refs of closed PRs, and fails on anything that looks like a
  credential, on this Mac's own session ids, titles, PR links and folder names, and on your private word list.
  Keep sample data in the tests made up: a real repo, team or person's name in a fixture is published too.
- **Release numbers follow what people get**: PATCH (`v1.0.1`) for fixes, MINOR (`v1.1.0`) for something new, MAJOR
  (`v2.0.0`) when people must do something themselves, such as install a newer Python, which the notes then say.
  Merge first, then publish: a release on an unchanged `main` has nothing to update to. Roll forward, never back:
  Update now only fast-forwards, so a bad release is undone by a revert and a new release, never by moving a tag.

## Things that bite

- **The lane contract spans three files.** `board.py`'s lane order, `app.js` (`LANE_WORD`, `LANE_HELP`,
  `COLUMN_LANES`, `HUD_PILL_KEYS`) and `village.js` (the place and badge for each lane) must agree.
  `tests/test_web.py` reads all three and fails if a lane is missing anywhere. A new lane needs a word, help text,
  an icon, a village place, a badge and exactly one Board column.
- **The page and the village duplicate some logic on purpose**, such as cleaning the visitors array and the world
  constants. The harness compares the two, so change both together.
- **Visitors (review requests) are never sessions.** They have no card, no column, no lane and no count in any lane.
  Several tests enforce this.
- **The harness measures what is painted, not what a layout declares.** It stubs the canvas and records every
  shape, then checks places for overlaps and for staying off the road, in both themes, at crowd sizes up to 30. A
  drawing change that nudges a place into another will fail there, so read the failure's coordinates rather than
  loosening the check.
- **One village, the castle hall and the cottage room are pinned by digests** (`oneVillage` in the harness). Any
  deliberate change to what those scenes draw moves the digest. Confirm that the change is the only thing that moved,
  then update the literal and add a line to the comment above it saying why.
- **Frame pacing is tested.** A scene at rest ticks at the ambient rate (`AMBIENT_FRAME_MS`, about 12 fps). Only
  real movement (`anyMotion`: a character walking or sailing, guests wandering an open interior) earns a faster
  rate. Bobbing, swaying and sweeping belong on the ambient tick.
- **Night means the dusk theme, not the clock** (`env.night`). Night-only art that moves (the lighthouse beam, the
  disco) must hold still under reduced motion.
- **Transcripts are big.** Token counts and PR links are read incrementally with a byte budget per scan. Never
  re-read whole transcripts on each scan.
- **Claude's files are not always where they are on this Mac.** Claude Code uses `CLAUDE_CONFIG_DIR` instead of
  `~/.claude` when it is set, the app keeps its data in `Claude-3p` when set up for a third-party provider, and the app
  itself can be in `~/Applications`. Claude Code also shortens a transcript folder name over 200 characters (adding a
  hash), and writes each UTF-16 unit of an emoji as its own dash. So read every folder in `Paths.claude_dirs` and
  `app_dirs`, and find a transcript through `Scanner._transcript_candidates`, never `transcript_path` alone.
  `tests/fixtures.claude_project_dir_name` is Claude Code's naming, checked against its JavaScript. Health must keep
  saying when nothing was found: an empty town under a green light is the failure it guards against.
- **Nothing on disk says which editor a chat ran in.** The Claude Code extension sets entrypoint `claude-vscode` in
  VS Code, VS Code Insiders and Cursor alike, so only a live session's process tree tells them apart. The scanner
  remembers the editor it saw each session live under, in memory only, and a chat never seen live falls back to the
  first editor installed. A new editor needs a row in `paths.EDITORS` and a name in the page's `EDITOR_NAME`.
- **Updates follow releases, never `main`'s tip.** A check is the newest published releases, then
  `compare/<newest tag>...<commit>`. Merging alone tells nobody, drafts and pre-releases are skipped, and a tag must
  match `paths.RELEASE_TAG_RE` (the page keeps its own copy): it reaches a GitHub path and the copied command. The
  check reads `.git` itself (`HEAD` from the gitdir; the `main` ref, release tags and `config` from the commondir, which
  differ in a worktree) and never runs git. The commit `main` was at when the server started is the code it runs, so
  a later one on disk still needs a restart. The page posts `{}` to `/api/update` or `/api/update-command` and GETs
  `/api/releases` for What's new: the server works from its own folder and the last check's cache.
- **Update now is `fetch --tags --force origin main` then `merge --ff-only <the release's commit>`, never `git pull`.**
  A `pull.rebase` setting (Charlie has one) could otherwise turn it into a rebase. The commit is the one GitHub's
  compare named for the tag. The fetch is HTTPS only, so an SSH origin gets the copy fallback (`canPull` false). Then
  `START_CHECK` has to pass in a fresh Python before the handler shuts the server down after its 202, and `serve()`
  re-execs `server.restart_argv()`. The page reloads once when `health.updates.running` changes.
- **gh says "not signed in" with its exit code, and GitHub says why a call failed on stdout.** `gh` exits 4 with no
  sign-in at all. A refused one exits 1, and `gh api` prints GitHub's error body on stdout even with `--jq` (stderr is
  never read). `github.gh_failure` keeps only which failure it was: `gh not signed in`, `HTTP 401`, `exit 1`. Either
  sign-in failure from any gh source adds `gh not signed in` to `health.problems` (`board.with_source_problems`), so
  the server and `check` both ask for a look.
- **The Claude app stopped writing `prs[]` onto session records around August 2026.** PRs come from `pr-link`
  records in transcripts, and are kept in `links.json` after the CLI deletes old transcripts.
