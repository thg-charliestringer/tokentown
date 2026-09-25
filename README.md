# Tokentown

A local page showing every Claude Code session on this Mac: which ones need you, which errored, which are running,
and one click back into each. It also shows the GitHub PRs waiting on your review.

There are two views of the same sessions:

- **Village** (the default): an animated village where each session is a character and each place is a status.
- **Board**: a kanban with one column per lane, in workflow order.

Python 3.13 or later (stdlib only) and vanilla JS: no npm, no CDN, no web fonts, no build step. The server listens on
`127.0.0.1` only. The one outside service is GitHub, read-only, through your own `gh` sign-in. Nothing is sent or
published, and your teammates install nothing.

## Run it

Clone it into a folder you keep, and start it from there:

```bash
git clone https://github.com/thg-charliestringer/tokentown.git ~/tools/tokentown
cd ~/tools/tokentown && ./tokentown
```

To run it as plain `tokentown` from any folder, put its folder on your PATH once, then open a new Terminal window:

```bash
echo 'export PATH="$HOME/tools/tokentown:$PATH"' >> ~/.zshrc
```

Stay on `main`, and sign `gh` in (`gh auth login`): that is how new releases reach you (see [Updates](#updates)), as
well as PR states and review requests.

`./tokentown` starts the server if it is not already running, then opens the board in Safari with a one-time link.
The link reaches Safari inside a private file, never on the command line, where other users could read it with `ps`.

If the page says **Tokentown is not responding**, the server has stopped: run `tokentown` again. Until the server
answers, the page shows no counts or alerts, so a stale "Blocked" never lingers.

| Command | What it does |
|---|---|
| `tokentown` | Start the server if needed, then open the board in Safari |
| `tokentown url` | The same, but print the one-time link instead of opening Safari. The link works once, within 30 s |
| `tokentown serve` | Run the server in the foreground (Ctrl-C to stop) |
| `tokentown stop` | Check that the running server holds the secret, then stop it |
| `tokentown check` | Print a health report of counts and versions, and whether an update is waiting. Exits 1 if health is not OK |
| `tokentown rotate` | Replace the secret. Open tabs disconnect; run `tokentown` again to reconnect |

It needs macOS, Python 3.13 or later, and Safari. `tokentown` runs under the `python3` on your PATH. If that one is
older, such as the 3.9 that comes with macOS, it looks where python.org, Homebrew, uv and pyenv put a newer one and
runs itself with that, or tells you how to install one. `gh`, signed in, is optional: without it PR states fall back
to the Claude app's own copy, marked "not confirmed", nobody queues for review, and you hear of no updates. Terminal
and VS Code sessions have no app copy to fall back on, so they need it more: see below. If `gh` is installed but not
signed in, or GitHub refuses its sign-in, **Health** asks for a look and `tokentown check` exits 1: run
`gh auth login`, then `tokentown stop` and `tokentown`.

### Updates

Tokentown updates by release. When you publish a new release on GitHub, everyone whose clone is on `main` sees a
banner under the top bar within the hour: "Tokentown v1.2.0 is out. You have v1.1.0." **What's new** shows the
release notes, newest first, marking the ones you do not have yet. **Update now** updates to the release and restarts
Tokentown, and the page reloads onto it. It never updates without that click, and **Later** hides the banner until
the next release. Merging to `main` alone tells nobody: only a published release does, and drafts and pre-releases
are skipped.

Update now runs two git commands in your Tokentown folder: `git fetch --tags --force origin main`, over HTTPS only and
never stopping to ask for a password, then `git merge --ff-only` to the release's commit. So git never makes a merge or
a rebase, whatever your git settings say: if a local edit is in the way, it refuses and nothing changes. Before the
restart, a fresh Python has to import the new code, and if it cannot, Tokentown keeps running the old version and says
so. When Update now cannot run (no git, or an `origin` over SSH) or has failed, the banner copies the command for
Terminal instead (`git fetch --tags origin`, `git merge --ff-only v1.2.0`, then `tokentown stop` and `tokentown`),
where git says in its own words what is wrong. If you update by hand, the banner offers **Restart now**.

Tokentown asks GitHub through `gh` about once an hour, and straight away after a pull. It learns your clone's commit
and version from its own `.git` files. A clone on another branch, one whose `origin` is not on github.com, and a copy
that is not a git clone are never checked, and the **Updates** part of **Health** says why. **Health** also names the
version you run and the newest release, and has its own **What's new** button.

#### Publishing a release

Merge first, then publish what is on `main` as a release tagged like `v1.2.0`:

```bash
gh release create v1.2.0 --target main --generate-notes
```

- **Merge, then publish.** A release on a `main` that has not moved names the commit everyone already has, so there
  is nothing to update to and no banner appears.
- **Pick the number by what people get.** PATCH (`v1.2.1`) for fixes, MINOR (`v1.3.0`) for something new, and MAJOR
  (`v2.0.0`) when people must do something themselves, such as install a newer Python. Say what in the notes, since
  Update now cannot do it for them. Tags must be `vMAJOR.MINOR.PATCH` on `main`: a release tagged any other way is
  ignored, and one tagged off `main` cannot be fast-forwarded to, so the banner would say it failed.
- **PR titles become the notes.** `--generate-notes` lists the titles of the PRs merged since the last release, so
  title a PR for the people who will update. Edit the notes on GitHub if you like: What's new shows whatever the
  release says at the next check.
- **Check it arrived.** The tag and `main` should name the same commit, and `tokentown check` in your own copy should
  say the release is out straight away:

  ```bash
  git ls-remote origin refs/heads/main refs/tags/v1.2.0
  ./tokentown check
  ```

  The banner itself comes at the next hourly check. To see it sooner, restart your own copy with `tokentown stop`
  and `tokentown`: the first check runs as it starts.
- **Roll forward, never back.** Update now only ever fast-forwards, so moving or deleting a tag takes nobody back to
  an older version. To undo a release, merge a revert and publish a new release. A release published by mistake can
  be deleted before anyone updates to it: `gh release delete v1.2.0 --cleanup-tag --yes`.

### Wherever Claude keeps its files

Tokentown looks everywhere Claude may keep its files, so it needs no setup on a Mac laid out differently from yours:

- **Claude Code's folder**: `~/.claude`, and the folder `CLAUDE_CONFIG_DIR` names if you set it, since Claude Code
  uses that folder instead. A `~/.claude` that is a link to another folder works too. The server takes
  `CLAUDE_CONFIG_DIR` from the terminal you first start it from, so after changing it, run `tokentown stop` and then
  `tokentown`. If you moved the folder in the Claude app's settings only, set `CLAUDE_CONFIG_DIR` to the same folder
  in your terminal as well.
- **The Claude app's folder**: `~/Library/Application Support/Claude`, or `Claude-3p` beside it when the app is set
  up for a third-party provider. Both are read.
- **The Claude app**: in `/Applications`, or in `~/Applications` if it was installed without admin rights. Only its
  version is read.
- **Long folder names**: when a session's folder path is over 200 characters, Claude Code shortens the name of the
  folder its transcript goes in, so Tokentown finds that transcript by the session's id instead.
- **`gh`**: from Homebrew, GitHub's own installer, MacPorts, Nix or `~/.local/bin`. It is handed your
  `GH_CONFIG_DIR`, `XDG_CONFIG_HOME` and `GH_TOKEN` when you set them, so it finds the sign-in your terminal uses.
- **`git`**, for Update now: from Homebrew, MacPorts or Nix, else the one Xcode or the Command Line Tools provide. It
  gets the same settings as `gh`, so a `gh` credential helper works, and it signs in however your git already does.

If Tokentown finds no Claude Code folder, no folder at `CLAUDE_CONFIG_DIR`, no sessions, or none of the transcripts
it looks for, **Health** says so on the page and `tokentown check` names the problem and exits 1, rather than
showing you an empty town. Both name the folders they read by label (`~/.claude`, `CLAUDE_CONFIG_DIR`, `Claude`,
`Claude-3p`), never by path.

Click the **Tokentown** name in the top bar, or press `i`, for the page's own **How it works** guide. Press `?` for
every key.

## Using the terminal or VS Code

Tokentown shows every Claude Code session on this Mac, wherever you started it: the Claude app, `claude` in a
terminal, or VS Code (the Claude Code extension's chat, or `claude` in VS Code's own terminal). Lanes, token counts,
PR links, Valhalla and review visitors work the same for all of them, and so do titles: a terminal or VS Code
session shows the title Claude gave it, or your rename. What differs comes from the Claude app keeping a record of
each of its sessions, which a terminal and VS Code do not.

**VS Code Insiders and Cursor** count as VS Code everywhere in this README. Tokentown tells which of the three a
session runs in from its process, names it on the page ("Cursor session", "Switch to Cursor") and opens it there. The
Claude Code extension records nothing that says which editor a chat ran in, so one that has closed opens in the
editor Tokentown last saw it running in, or, if it never saw it running, the first of VS Code, VS Code Insiders and
Cursor you have installed.

| | Claude app | Terminal | VS Code |
|---|---|---|---|
| **Click** | Opens the session in the app | Running: says to switch to its terminal. Ended: copies its resume command | Brings forward the VS Code window with its folder. A chat you have closed then resumes in a new tab |
| **Once ended** | Recent for a week, then Older | The Graveyard, straight away | The Graveyard, straight away |
| **Blocked** | Reported by the session | Reported by the session | In VS Code's terminal, reported. In the chat, worked out (see below) |
| **After about a month** | Stays on the board | Leaves the board when the CLI deletes its transcript | The same as a terminal |

- **A terminal has no archive**, so ending a session is how you put it away. It goes to the Graveyard unless it
  stopped mid-turn, errored, or has an open or merged PR or a Valhalla mark.
- **VS Code's chat never says it is waiting for your approval.** Tokentown works it out: a command that has not
  started, or an edit not yet made, 15 seconds after Claude asked is Blocked. A wait on any other tool shows as
  Running. `claude` in VS Code's own terminal counts as a VS Code session while it runs, and as a terminal session
  once it has ended.
- **A click cannot reach a terminal tab or a VS Code chat that is already open.** VS Code gives other apps no way to
  pick one, and Tokentown does not script Terminal or iTerm. It never offers a running session's resume command
  either: that would start a second copy of it.
- **Only the Claude app gives** the 5-hour and Weekly usage bars (they read the app's usage history), a session's
  branch, model, effort, turn count and start time, and the **New** dot on Recent cards.
- **`gh` matters more.** A terminal or VS Code session's PR states come only from GitHub, so without `gh` its PRs
  never move it to the Harbour, Valhalla or the Jail.
- **Claude has to give a title.** A session that opens with "hello" or the like may get none, and a VS Code chat in
  a git worktree keeps its title inside VS Code only: those show their id until you rename them.
- **Scripts count too.** A `claude -p` run or an Agent SDK session that saves a transcript shows as a terminal
  session.
- **For the app's extras on a terminal session**, type `/desktop` in it. The session moves into the Claude app
  (signed in with a Claude subscription) and is a desktop session from then on.

## The Village

### Places

| Place | Who is there |
|---|---|
| **The Porch** | **Blocked** by the door, waving under an orange light. **Needs input** on the swings (finished a turn in the last 2 hours). **Errored** (a puff of smoke) and **Stopped** (a pause sign) on the steps. One sign names all four, and orange on the Porch always means blocked |
| **The Workshop** | **Running**: busy, or idle while a task it started in the background still runs (`background task · N min`) |
| **The Cottages** | **Idle** (live, quiet for 2 hours or more) and **Recent** (active in the last 7 days). One cottage with lit windows and a count on its sign. Click it to go inside, where the sessions wander and sit down to chess, ludo, snakes and ladders or cards. In the Wild West it is **The Bank**, and the room behind it is the counting room |
| **The Harbour** | **PR open**. Sessions queue behind the border patrol. When a PR merges, the guard stamps that character's passport, the barrier lifts, and it walks down the pier to a boat |
| **Valhalla island** | A PR merged with none still open, or you sent it there. For 14 days they lounge on the beach with margaritas, then move into the **sand castle**. Click the castle to go inside. In the Wild West the island is a mesa, the castle is a mine, and they lounge under a brush ramada with whiskey |
| **The Jail** | Every PR was closed without merging. They stand in a barred yard. A merge always beats a closure |
| **The Graveyard** | Archived, a terminal or VS Code session that has ended, or no activity for 30+ days. One headstone per session, newest first, with friendly ghosts floating over them: two from the first grave, up to twelve in a full graveyard |
| **The immigration desk** | Not sessions: PRs waiting on your review, as visitors (see below) |

Desktop sessions quiet for 7 to 30 days are **Older**. They are counted but not drawn.

### Characters

- **Colour** is the repo the session works in. There are 12 bold colours, each clearly apart from the others and
  from every status colour. The **Repos** legend names them.
- **Size** follows output tokens, subagents included, on a log scale: 0.85x at 1k tokens or fewer, up to 1.5x at
  about 30M. A crowded place shrinks everyone in it by the same share, so nobody overlaps.
- **The badge** is the session's state, in the same colours as the count pills.
- **Hover** for the title, status, repo, branch, model, session, tokens, subagents and PR.
- **Click** to open the session in Claude. A click only acts on the character the tooltip names, so one that has
  just walked under your pointer is not opened by mistake.
- **A terminal session** has nothing Tokentown can open. Once it has ended, a click copies its resume command. While
  it runs, its card says to switch to its terminal: Tokentown cannot bring a terminal tab forward, and resuming it
  elsewhere would start a second copy of it. Its repo is the folder it works in now, which can differ from the one
  it started in.
- **A VS Code session** (in the Claude Code extension's chat, or `claude` running in VS Code's own terminal) opens
  in VS Code instead, and one in VS Code Insiders or Cursor opens in that editor. A click brings forward the VS Code window with its folder, and if you have closed a chat
  session there, resumes it in a new Claude Code tab. A session still open in VS Code is only brought forward,
  because VS Code's session link would start a second copy of it rather than find the one you have. If VS Code has to
  open a new window for the folder, the session can land in the wrong one: click again once the window is up. A
  session in VS Code's terminal counts as one only while it runs: once closed, it is a terminal session.

### Two maps

Switch between the maps in the top bar or with `w`. Your choice is remembered.

- **One village**: every session on one map.
- **World of islands**: one island per repo, sized by its session count. Each island carries badges for Blocked,
  Needs input, Errored, PR open, Jail and reviews waiting, so anything that needs you shows without sailing
  anywhere. Click an island to sail in and you get the same village, for that repo only. `Esc` takes you back out.

On your first visit the page picks a map for you: One village if one repo holds 70% or more of your sessions,
otherwise the World.

The **count pills** in the top bar always count the whole board, every repo, even while an island is open. The list
beside the village follows what is on screen. Both say which they are showing.

### Themes

The **Theme** dropdown in the top bar picks how the village is painted. Your choice is remembered.

- **Village**: the green village, as it has always been.
- **Wild West**: a frontier town. Its sessions wear cowboy kit, its village is desert, its two rooms are a bank's
  counting room and a mine, and a locomotive hauls merged PRs across the flats.
- **Middle-earth**: a green country. Its sessions are hobbits, its trees are ents, the cottage is a hobbit hole,
  the guard at the border is a grey pilgrim, and a dark tower watches the coast with a burning eye.

A theme is paint and lettering only. Every building stands on the footing it replaces, so nothing moves: the
Board's columns, the Repos legend, the count pills and every clickable door read the same whichever theme you
pick. Only the name painted on a board changes.

| Place | Village | Wild West |
|---|---|---|
| The Workshop | Workbenches under an awning | **The Depot**: a platform under the canopy, with a baggage cart and a water column |
| The Cottages | A cottage on the green | **The Bank**: a stone front, a stepped parapet, a hitching rail |
| The Porch | A porch house with a lantern | **The Saloon**: a false front and batwing doors |
| The Harbour | A deck and a pier | **The Rail Yard**, under a water tower |
| Valhalla island | Sand, dune grass, shells | **Valhalla mesa**: a mine driven into the rock |
| The sand castle | A sand castle | The mine's timbered portal, with rails and an ore cart |
| The sea | Water, ripples, foam | Dry flats, a gulch cut through them, cracked mud |
| The trees | Eight trees | Eight saguaros |
| The Jail, the Graveyard | Unchanged | Unchanged |

| Place | Village | Middle-earth |
|---|---|---|
| The open ground | A wash of grass | **Hedged fields**, a hillside with two more holes in it, and the Misty Mountains on the horizon |
| The Workshop | Workbenches under an awning | **The Forge**: a timber-framed smithy on a stone footing, under a tiled roof, with an anvil and a lit hearth |
| The Cottages | A cottage on the green | **Bag End**: a green hill with a round door, leaded round windows, a paling fence and a bench by the gate |
| The Porch | A porch house with a lantern | **The Green Dragon**: a half-timbered inn under thatch, with a sign on the gable |
| The Harbour | A deck and a pier | **The Grey Havens** |
| Valhalla island | Sand, dune grass, a sand castle | **The Undying Lands**, under a white tower |
| The sea | Water, ripples, foam | Unchanged: this pack keeps its sea |
| The trees | Eight trees | Eight ents, each leaning its own way |
| The lighthouse | A lighthouse sweeping its beam | A dark tower, and at night an Eye that sweeps it instead |
| The border patrol | A guard in uniform | A grey pilgrim with a staff, who decides what passes |
| The Jail | A stone block under a slate roof | The same block, battlemented: an older keep |
| The windows | Glass with a glazing bar | Leaded diamond panes, on every opening in the pack |
| The Graveyard | Headstones | Barrows, each with a standing stone at its head |
| The Cottages room | A parlour with square windows | **The Parlour**: round windows onto the country, and a dresser of plates |
| The castle hall | A sand castle hall | **The White Halls**: an arcade of pointed arches, lancets over a gorge and its fall, a terrace archway onto the valley, a flagstone floor with a star laid in it, and stone benches |


In Middle-earth a session is a hobbit: curly hair, pointed ears, a waistcoat with brass buttons and big bare
feet. It keeps the green village's five looks. Merged sessions cross to the Undying Lands in a grey ship with a
star on its sail, the flower beds are mushrooms, and a lounger smokes a pipe under a mallorn rather than drinking
under a parasol.

In the Wild West a session wears a hat, a waistcoat, a gun belt and a holstered revolver, with a sheriff's star,
a bandana, a feather in the hatband, glasses or the hat alone to tell five sessions of one repo apart. Its
colour, size, badge and lane are untouched. A horse trots the circuit the roads make, a range on the horizon has
a tunnel driven through it, and the crossing runs straight from the berth to the jetty rather than taking the
voyage's long way round.

### At night

Night means dark mode, not the clock: the scene follows your Mac's appearance setting. At night the sand castle's
windows glow, the lighthouse sweeps its beam round, and the sand castle hall has a disco with a mirror ball and
coloured spotlights. In the Wild West the mine has a band instead, and every five seconds two of the crowd go at
it: a brawl with a **POW!**, then a shootout with a **BANG!**. In Middle-earth the hall has starlight, and the
dark tower's Eye sweeps where the lighthouse beam did. The beam, the disco, the band, the fights, the starlight,
the horse and the ghosts all hold still when your Mac is set to reduce motion.

### Visitors: PRs waiting on your review

Each open PR that asks for your review, by name or through a team you are on, walks up the Harbour pier and queues
at the immigration desk. In the World it queues on the island of that PR's repo.

- A visitor is plainly not a session: half the width, a travel coat, a suitcase and a passport. There is no photo
  and nothing is fetched.
- **Asked of you** by name: it holds its passport up beside its head. **Asked of a team** you are on: it wears a
  cream sash and holds its passport low.
- Nine fit at the desk; the rest show as "+N more". The longest wait always stands at the front, and requests asked
  of you come before team ones.
- **Hover** for the author, repo, PR number and title, how long it has waited, and who was asked. **Click** to open
  the PR on GitHub.
- The **Reviews** pill in the top bar counts them and takes you to the desk.
- A visitor leaves when GitHub stops listing the request: you reviewed it, or it merged, closed or was reassigned.

Visitors are never sessions: they get no card, no column and no lane count.

## The Board

There are ten columns: **Blocked, Errored, Needs input, Running, PR open, Jail, Idle, Recent, Valhalla, Graveyard**.
The board scrolls sideways and each column scrolls on its own.

- Stopped shares the Blocked column, with its own dashed pill. The sand castle shares the Valhalla column. A shared
  column shows the split under its count ("26 + 2 stopped").
- Older sessions and review requests are counts in a note under the columns, not cards.
- A card shows everything without expanding: title, repo and worktree, wait time, state, the PR line (with whether
  GitHub confirmed it), branch, model, effort, id and tokens. **Click a card** to open that session.
- A column shows 25 cards, then a "+N more" button. The count in its header is always the whole column.
- **Drag a card onto Valhalla** to send it there. Anything else snaps back, because Tokentown reads state and cannot
  change it. Hold the pointer near an edge to scroll the board while dragging.
- Everything works from the keyboard: arrow keys move within and between columns, and `d` does what a drag does.

## Sending a session to Valhalla

Claude never says when work is finished, so you tell Tokentown. Any of these sends a session to Valhalla, even with a
PR still open:

- Press **Send to Valhalla** on its card, or pick it and press `d`.
- Drag its card onto the Valhalla column.
- Type **go to valhalla** as the whole message in the session. It sails once Claude has replied.

An **Undo** button shows for 6 s afterwards, and **Bring back** (or `d` again) undoes it later. A session also comes
back by itself as soon as it does anything new. Sessions that are live and blocked, errored or running cannot be sent,
and merged sessions are already there.

## Top bar

- **Count pills**: one per lane, for the whole board.
- **Reviews pill**: the PRs waiting on your review. Hover it for how many were asked of you and how many of your teams.
- **5-hour and Weekly bars**: your Claude plan usage as a percent used, from the Claude app's own usage history. They
  are blue under 70, amber from 70 and red from 90. The app only updates this about every 15 minutes while it is in
  use, so a reading can be hours old: over 30 minutes old the bars turn grey and show "as of HH:MM".
- **Health**: scan, GitHub, review-source and update-check status, with details on click. It also asks for a look
  when Tokentown finds no Claude folder or no sessions (see
  [Wherever Claude keeps its files](#wherever-claude-keeps-its-files)), and when `gh` is not signed in.
- **The update banner**, under the top bar: a new release of Tokentown is out, with **What's new** and **Update
  now**. See [Updates](#updates).
- **Theme**: how the village is painted, Village, Wild West or Middle-earth. See [Themes](#themes).
- **Privacy** (`p`): hides titles and shows `repo / worktree` instead, for screen sharing.

## Keys

| Key | Does |
|---|---|
| `v` | Switch between Village and Board |
| `w` | Switch between One village and World of islands |
| `p` | Privacy: hide titles |
| `s` | Show or hide the list beside the village |
| `n` | Pick the blocked session that has waited longest, sailing to its island first |
| `Enter` | Open the picked session |
| `d` | Send the focused card or picked session to Valhalla, or bring it back |
| `j` / `k` | Move through the Board a card at a time |
| Arrows | Move within a Board column (up, down) or between columns (left, right) |
| `Esc` | Step back one level: cancel a drag, hide the tooltip, close a panel, leave an interior, leave the island, clear the pick |
| `?` | Keys |
| `i` | How it works |

## Lanes

| Lane | Means |
|---|---|
| Blocked | Waiting on a permission prompt, a question or a plan review (lane id `needs_you`) |
| Errored | Rate limited, signed out or an API error |
| Needs input | Claude finished its turn in the last 2 hours (lane id `your_turn`) |
| Running | Busy; or idle while a background task it started still runs (a background shell, agent or workflow with no report back yet, a monitor until its first event, or a scheduled wake-up) |
| Stopped | Ended mid-turn (running only local commands such as `/context` does not count) |
| Idle | Live, not archived, and quiet for 2 hours or more |
| PR open | Any PR is still open, live or not |
| Recent | A desktop session active in the last 7 days |
| Valhalla beach | A PR merged with none still open, or sent there, in the last 14 days |
| Valhalla sand castle | The same, more than 14 days ago |
| Jail | Every PR was closed without merging: none open, none merged, none still unknown. Live sessions stay as long as they are live; desktop sessions for 30 days after the closure or the last activity, whichever is later |
| Graveyard | Archived, live or not, with no open or merged PR and no done mark, a terminal or VS Code session that has ended (a terminal has no archive: ending a session is how you put it away), or no activity for 30+ days with no open or merged PR |
| Older | No activity for 7 to 30 days and nothing else applies. Count only |

The first matching rule wins:

| Session | Order |
|---|---|
| Live, archived | Open PR > a merge that sails > a done mark > the Graveyard |
| Live, not archived | Blocked > errored > running > open PR > a merge that sails > a done mark > needs input > jail > idle |
| Not live | Errored (recent, not archived, not done) > open PR > a merge that sails > a done mark > archived > stopped > ended (a terminal or VS Code session) > jail > recent > inactive over 30 days > older |

**Archiving puts a chat away at once**, whatever its session is still doing. It goes straight to the place it would
rest in once its session had gone, so it walks there once and stays: the Graveyard, unless a PR of its own is still
open (the Harbour) or one merged, or you marked it done (Valhalla).

**Every PR counts, not just the newest.** An open PR anywhere keeps a session in the Harbour. A merge sails only when
nothing is open and nothing is still unresolved, so a merged PR beats a closed one. The jail takes a session only
when every PR is closed.

`tokentown check` does not ask GitHub about PRs, so its lanes use the Claude app's PR states. Those rarely record a
closure, so its `jail` count reads low; the running server uses GitHub's. Its only calls to GitHub are the update
check's two, which also show whether `gh` is signed in.

## Where the data comes from

**Sessions** come from the Claude app's session records, the live session registry and the transcripts. A
transcript is read from its tail for the session's state, and in full once (then only new lines) for token counts
and PR links. After the server starts, totals show "counting..." for about 20 s and PR links take about a minute to
catch up.

**VS Code sessions** register while they are open, but with no status, so their lane comes from the transcript. A
permission prompt leaves no record there, so Tokentown infers it: a Bash command that has not started after 15 s
(no shell under the session's process), or an edit still pending after 15 s, is Blocked with `Approve`. A wait on any
other tool shows as Running, with `tool running N min`. A question or a plan to review shows as Blocked as usual.

**PRs come from transcripts too.** The Claude app stopped writing PRs onto its session records around August 2026,
but every transcript still records each PR a session opens. The Claude CLI deletes transcripts after about a month,
so Tokentown keeps the links it has read in `links.json`, and a merged session stays in the sand castle after its
transcript is gone.

**PR state comes from GitHub**, read-only, because the Claude app's copy goes stale once a session is idle.
Tooltips and cards say "confirmed on GitHub" or "not confirmed". With about 220 PRs in play, a cold start resolves
them in about 5 minutes, most recently active first. Merged and closed PRs are never asked again.

**Review requests come from GitHub too**, every 5 minutes, through two searches: one for the PRs that ask you by
name, and one that also includes those asking a team you are on. The visitors change only when both searches succeed
in the same cycle, so a failure never adds, drops or reclassifies anyone. Your own open PRs are also asked who they
are waiting on, which puts "waiting on ana and sam" in a Harbour session's tooltip.

| Source | Path or call | Kept |
|---|---|---|
| Desktop session records | `~/Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json`, and the same under `Claude-3p` | Ids, cwd, title, model, effort, branch, timestamps, PRs |
| Live session registry | `~/.claude/sessions/<pid>.json`, and the same under `CLAUDE_CONFIG_DIR` | pid, status, timestamps, version, and which app runs the session |
| Transcripts | `~/.claude/projects/*/<uuid>.jsonl`, and the same under `CLAUDE_CONFIG_DIR` (the tail, 256 KB up to 4 MB) | Record types, tool names and ids, stop reasons, error kinds, background-task flags, whether a user message is nothing but a request to sail to Valhalla, the folder and the app (the Claude app, a terminal or VS Code) named by the first record, the folder the newest record names (the repo shown), and the newest title Claude recorded: your rename, else its own summary, cut to 200 characters. Never any other text |
| Token usage | The same transcripts plus `<uuid>/subagents/**/*.jsonl`, 48 MB a scan | Message ids and their usage integers |
| PR links | Transcripts of sessions active in the last 60 days, 32 MB a scan, only lines containing `"pr-link"` | PR number, URL and `owner/repo` (each only when it passes a strict pattern), the time and the session id |
| Plan usage | `~/Library/Application Support/Claude/plan-usage-history.json`, and the same under `Claude-3p` | The newest sample's time and two percentages |
| App version | `/Applications/Claude.app/Contents/Info.plist`, else the same under `~/Applications` | Version string |
| Process check | `/bin/ps -o lstart= -p <pid>` | Start time, to reject a recycled pid |
| Background shells and editors | `/bin/ps -A -o pid=,ppid=,etime=,args=`, at most every 5 s while a session is live | pid, parent pid, elapsed time, and whether the args mark a Claude shell or a VS Code, VS Code Insiders or Cursor process, and which, so a live session with an editor among its ancestors is known to run there. The args themselves are dropped at once |
| Installed editors | `Visual Studio Code.app`, `Visual Studio Code - Insiders.app` and `Cursor.app` in `/Applications` and `~/Applications` | Whether each is there, so a chat that closed before Tokentown saw it opens in an editor you have |
| PR state | `gh api repos/<owner>/<repo>/pulls/<number>`, at most 120 calls a minute-long cycle | State, and the merge and close times. In memory only |
| Review requests | `gh search prs user-review-requested:@me` and `gh search prs review-requested:@me`, both `--state open --limit 100` | Per PR: URL, title, author login, when it opened, and whether it asked you or a team. At most 50. In memory only |
| Requested reviewers | `gh api repos/<owner>/<repo>/pulls/<number>/requested_reviewers`, at most 20 calls a cycle | Up to 10 reviewer logins and team slugs per PR. In memory only |
| This copy of Tokentown | Its own `.git`: `HEAD`, `refs/heads/main`, `refs/tags` or `packed-refs`, and `config` (for a worktree, all but `HEAD` in the main clone's `.git`) | Whether it is on `main`, the commit `main` is at, the release tags naming it, and the owner and repo `origin` names when that is on github.com |
| Releases | `gh api repos/<owner>/<repo>/releases?per_page=10`, at most hourly, and once after a pull | Up to 10 published releases, drafts and pre-releases left out: tag, name, date and notes (4,000 characters). In memory only, and shown as plain text |
| Updates | `gh api repos/<owner>/<repo>/compare/<newest tag>...<commit>`, straight after | Whether this copy is the newest release, older or newer, and the commit the tag names. In memory only |
| Update now | On your click only: `git -C <folder> fetch --tags --force origin main` (HTTPS only), `git -C <folder> merge --ff-only <that commit>`, then `<its Python> -B -c ...` in the folder, which compiles the launcher and imports the server | Exit codes only. Nothing git or Python prints is read |

**Never read:** `*.key`, `config.json`, `buddy-tokens.json`, `bridge-state.json`, `Cookies`, `Local Storage`,
`IndexedDB`. Every session-store read goes through one function that enforces this list.

**Never kept or sent:** prompts, message text, tool inputs, error text, or anything `gh` prints beyond the fields
above. A failure is kept as its exception class, its exit code or the HTTP status GitHub answered with, and nothing
else: `gh` exiting 4 means it has no sign-in, and is kept as `gh not signed in`. A terminal or VS Code session's title
is kept the way a desktop one is: shown on the page, hidden by privacy mode (`p`) and never logged.

**Never logged:** titles or session-store paths. Errors log their exception class name only.

**Writes**, all in `~/Library/Application Support/tokentown/` (folder 0700, files 0600), and nothing inside any Claude
folder:

- `secret`, and a short-lived `launch-<random>.webloc` each time Safari is opened. Launch files are deleted once their
  30 s code has expired, and all of them on `tokentown rotate`.
- `done.json`: row ids and the times you sent them to Valhalla. A mark is deleted once its session is active again.
- `links.json`: up to 16 PR links per session (number, URL, time), so PRs outlive the transcripts the CLI deletes.

Both JSON files are written to a temp file and renamed into place, never through a symlink, and a file that is not a
plain file owned by you is ignored.

## Security model

- **Loopback only.** It binds `127.0.0.1:47291`, and the `Host` header must be exactly that, which blocks DNS
  rebinding and `localhost` tricks. OPTIONS is refused and there are no CORS headers.
- **Secret, launch code, token.** The launcher mints a single-use launch code from a local secret, valid for 30 s.
  The page swaps it for a session token held in `sessionStorage`, and every `/api/*` call needs that token.
- **The launch code is never in argv.** Safari gets the link in a 0600 `.webloc` file, so `ps` shows only a file
  path. If a code is claimed twice anyway, the server answers 409 and turns health red with "launch link used
  twice". If that was not you, run `tokentown rotate`.
- **Strict POSTs.** Every POST needs the exact `Origin`, `application/json`, a body of at most 1 KB, and exactly the
  expected keys and types. `/api/done` and `/api/open-review` also need an id on the current board, and are rate
  limited.
- **The client sends ids, never URLs.** Clicking a visitor posts its id alone. The server looks up the URL in its own
  list and checks it against the PR URL pattern again right before opening it. Copying the update command posts an
  empty object: the folder in the command is the one the server runs from, quoted for the shell, and refused if it
  holds a control or format character.
- **Hostile text stays text.** A strict CSP allows no inline script or style. The page builds its DOM with
  `textContent` only, the village draws with `fillText`, and JSON escapes `<`, `>` and `&`.
- **Fixed subprocesses, no shell.** The server runs only `/bin/ps` (the two shapes above), `/usr/bin/open` with an
  allowlisted `claude://` session URL or a GitHub PR URL it holds, the six `gh` reads above, and on Update now the
  two `git` commands and the start check above. The update check reads the clone's `.git` files, never `git`. For a
  session in an editor, `open` also runs as `-b <bundle id> <folder>` and with a
  `<scheme>://anthropic.claude-code/open?session=<id>` URL, both from a fixed table: `com.microsoft.VSCode` and
  `vscode` for VS Code, `com.microsoft.VSCodeInsiders` and `vscode-insiders` for VS Code Insiders,
  `com.todesktop.230313mzl4w4u92` and `cursor` for Cursor. Session URLs are built from the session's id alone, after
  it matches the id pattern. The folder is only the one the session's own transcript records: an existing, absolute,
  normalised path, passed as its own argument. It goes to the editor as a macOS open-file request because VS Code asks
  before following a `vscode://file` link from another app. Each has an absolute path, an argument list, a minimal
  env and a timeout. `gh`'s env adds only your `GH_CONFIG_DIR`, `XDG_CONFIG_HOME` and `GH_TOKEN`, when set. No
  endpoint takes a path, URL or command.
- **The server keeps little of your environment.** The launcher starts it with the Python it runs under, and hands
  it only `HOME`, a fixed `PATH`, your `CLAUDE_CONFIG_DIR` and those three `gh` settings. `git` gets the same, plus
  `GIT_TERMINAL_PROMPT=0` and `GIT_MERGE_AUTOEDIT=no`, so it never waits on a terminal nobody is watching.
- **Update now runs only on your click, and only as far as a fast-forward.** `/api/update` takes an empty object and
  the usual token, Origin and content-type checks, so no other web page can press it. The fetch is limited to HTTPS
  (`-c protocol.allow=never -c protocol.https.allow=always`), the merge is `--ff-only`, and nothing the page sends
  reaches an argv. After a 202 the server stops cleanly and starts the launcher's `serve` again with the same Python
  (`os.execv`). The secret is unchanged, so the open tab's token still works, and the page reloads when the server
  reports a new commit. Whoever can publish a release on your `origin` decides what you run, as with any `git pull`:
  that is why Update now never runs by itself, and why What's new shows the notes before you press it.
- **GitHub is read-only.** There are six fixed call shapes and no others. Every element of both searches is a
  constant, and GitHub resolves `@me` itself, so Tokentown never learns your login. Owner, repo and number reach an
  argv only from a plain-ASCII URL matching `https://github.com/<owner>/<repo>/pull/<number>`, rebuilt from those
  three parts. The update check's owner and repo come only from your clone's `origin`, in GitHub's own ASCII
  characters, and its commit is 40 hex digits read from `.git`. A release tag reaches the compare, and the command the
  page copies, only when it is shaped like `v1.2.0`, and the commit Update now fast-forwards to is the 40 hex digits
  GitHub's compare named. No title, login or team slug ever reaches an argv. Answers over their size cap are
  rejected whole. If GitHub, the proxy or `gh`'s sign-in is down, PR state lookups pause for 15 minutes after 3
  failures in a row, doubling up to 2 hours, and the update check waits 15 minutes.

## Development

See [CLAUDE.md](CLAUDE.md) for the code layout, the hard rules and the conventions.

Run the tests from the repo root, with Python 3.13 or later:

```bash
python3 -m unittest discover -s tests -t .
```

The Python tests use a synthetic home, bind port 0 and mock every subprocess, so they never open Safari, the Claude
app or a PR page, and never run `gh` or `ps`. The update check's tests build their git clones in a temp folder.
`tests/test_web.py` also runs `tests/web_harness.mjs` under `node`, which drives the village and page headlessly (no
DOM, no network, no browser). That half is skipped when `node` is not installed.

GitHub runs the same tests on a Mac for every PR and every push to `main`, under Python 3.13 and 3.14, with `node`
installed so the web half always runs (`.github/workflows/tests.yml`).

`tools/privacy_scan.py` says what a clone of the repo would give a stranger: credentials, anything of your own
Mac's (session ids, titles, PR links, folder names) and any word you list in a file of your own. It reads every
version of every file on every published ref, not just the current ones. Run it before publishing a release, or with `--range origin/main..HEAD` for only what a push would add.
GitHub runs the same scan on every PR, for credentials and for a word list kept in a repository secret. A runner has
no Claude folder, so only your own Mac can check the rest.

For a quick live check without a browser, run `./tokentown check`.
