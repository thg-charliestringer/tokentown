from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from town import board as bd
from town import updates
from town.github import GH_NOT_FOUND
from town.model import RawSnapshot, SourceFolder, Tail
from town.paths import EDITORS, RELEASE_TAG_RE

WEB = Path(__file__).resolve().parent.parent / "web"
HARNESS = Path(__file__).resolve().parent / "web_harness.mjs"


def _node() -> str | None:
    found = shutil.which("node")
    if found:
        return found
    for candidate in ("/opt/homebrew/bin/node", "/usr/local/bin/node"):
        if os.access(candidate, os.X_OK):
            return candidate
    return None


NODE = _node()


def _body(text: str, name: str) -> tuple[str, str]:
    """The literal of a `const NAME = ...` in a web module, brace-matched, with its opening bracket.

    Brace-matched rather than regexed to its first close: a nested entry (STATE's per-lane objects) or a comment
    holding a bracket would otherwise cut the literal short and the keys would read as a much shorter list.
    """
    open_at = re.search(rf"(?:^|\n)(?:export )?const {name} = (?:Object\.freeze\()?\s*([\[{{])", text)
    if not open_at:
        raise AssertionError(f"{name} not found")
    i, depth = open_at.end() - 1, 0
    while i < len(text):
        depth += text[i] in "[{"
        depth -= text[i] in "]}"
        if depth == 0:
            break
        i += 1
    return open_at.group(1), text[open_at.end():i]


def _keys(text: str, name: str) -> list[str]:
    """The keys of an object literal, or the strings of an array literal, at its top level only."""
    bracket, inner = _body(text, name)
    if bracket == "[":
        return [m.group(1) for m in re.finditer(r"['\"]([a-z_]+)['\"]", _strip(inner))]
    out, depth = [], 0
    for m in re.finditer(r"[\[{}\]]|(?:^|[{,])\s*([a-z_]+)\s*:", _strip(inner), re.M):
        if m.group(1) is not None:
            if depth == 0:
                out.append(m.group(1))
            continue
        depth += m.group(0) in "[{"
        depth -= m.group(0) in "]}"
    return out


def _strip(js: str) -> str:
    """Line comments blanked, so prose naming a lane is never read as a key."""
    return re.sub(r"//[^\n]*", "", js)


def _fn(text: str, name: str) -> str:
    """The body of a `function NAME(...) { ... }`, brace-matched, comments blanked. `export` too, since the same
    rule can be a module-level export in one file and an inner function in another."""
    open_at = re.search(rf"(?:^|\n)\s*(?:export )?function {name}\([^)]*\)\s*\{{", text)
    if not open_at:
        raise AssertionError(f"{name} not found")
    i, depth = open_at.end() - 1, 0
    while i < len(text):
        depth += text[i] in "{"
        depth -= text[i] in "}"
        if depth == 0:
            break
        i += 1
    return _strip(text[open_at.end():i])


class EditorContractTests(unittest.TestCase):
    """The page names every editor the server can put on a row. A key it lacked would read as VS Code."""

    def test_the_page_names_exactly_the_servers_editors(self):
        app = (WEB / "app.js").read_text(encoding="utf-8")
        literal = re.search(r"EDITOR_NAME = Object\.freeze\(\{(.*?)\}\)", app, re.S)
        self.assertIsNotNone(literal)
        self.assertEqual(re.findall(r"['\"]?([a-z][a-z-]*)['\"]?\s*:", literal.group(1)), [e.key for e in EDITORS])


class HealthContractTests(unittest.TestCase):
    """The health panel's where-to-look help follows board.health_problems' words. Nothing at runtime notices a
    renamed problem: the page would just stop helping with it. Text-matched rather than executed."""

    def test_the_page_helps_with_exactly_the_boards_folder_problems(self):
        app = (WEB / "app.js").read_text(encoding="utf-8")
        literal = re.search(r"WHERE_PROBLEMS = new Set\(\[(.*?)\]\)", app, re.S)
        self.assertIsNotNone(literal)
        nowhere = (SourceFolder("CLAUDE_CONFIG_DIR", "code", False), SourceFolder("~/.claude", "code", False))
        raw = RawSnapshot(scanned_at=0, desktop=(), registry_files=0, registry_live=(), cli_only=(),
                          tails={"x": Tail(found=False, records=(), newest_mtime=None)}, app_version=None,
                          cli_versions=(), desktop_parse_errors=0, scan_ms=0, folders=nowhere)
        self.assertEqual(set(re.findall(r"'([^']+)'", literal.group(1))),
                         set(bd.health_problems(raw, [], sessions=0)))

    def test_the_page_helps_with_exactly_the_gh_sign_in_problem(self):
        app = (WEB / "app.js").read_text(encoding="utf-8")
        literal = re.search(r"GH_PROBLEMS = new Set\(\[(.*?)\]\)", app, re.S)
        self.assertIsNotNone(literal)
        self.assertEqual(set(re.findall(r"'([^']+)'", literal.group(1))), {bd.GH_SIGN_IN_PROBLEM})
        signed_out = bd.with_source_problems({"ok": True, "problems": []}, [{"lastError": "gh not signed in"}])
        self.assertEqual(signed_out["problems"], [bd.GH_SIGN_IN_PROBLEM])

    def test_the_page_and_the_server_agree_on_what_a_release_tag_is(self):
        # The page names releases from the server's answers, and the server's pattern is what keeps a tag out of an
        # argv, a GitHub path and the copied command: a looser page would show a tag the server never acts on.
        app = (WEB / "app.js").read_text(encoding="utf-8")
        literal = re.search(r"const RELEASE_TAG_RE = /\^(.*?)\$/;", app)
        self.assertIsNotNone(literal)
        self.assertEqual(literal.group(1), RELEASE_TAG_RE.pattern.removesuffix(r"\Z"))

    def test_the_page_has_words_for_every_reason_an_update_check_is_off(self):
        app = (WEB / "app.js").read_text(encoding="utf-8")
        literal = re.search(r"UPDATE_REASONS = Object\.freeze\(\{(.*?)\}\)", app, re.S)
        self.assertIsNotNone(literal)
        reasons = {updates.NOT_A_CLONE, updates.NOT_ON_MAIN, updates.NO_GITHUB_ORIGIN, updates.UNREADABLE, GH_NOT_FOUND}
        self.assertEqual(set(re.findall(r"^\s*'([^']+)':", literal.group(1), re.M)), reasons)


class ThemeContractTests(unittest.TestCase):
    """village.js paints the themes; app.js offers them and names the two rooms outside the canvas.

    The page has to work before village.js arrives, so it keeps its own copy of the list and of the words a crumb
    and a hover use. A theme added to one file and not the other would give a picker that paints nothing, or a
    village nobody can reach.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.app = (WEB / "app.js").read_text(encoding="utf-8")
        cls.village = (WEB / "village.js").read_text(encoding="utf-8")

    def _packs(self) -> list[str]:
        return [m.group(1) for m in re.finditer(r"key: '([a-z]+)'", _strip(_body(self.village, "THEME_PACKS")[1]))]

    def test_the_page_offers_exactly_the_villages_themes(self):
        page = [m.group(1) for m in re.finditer(r"key: '([a-z]+)'", _strip(_body(self.app, "THEMES")[1]))]
        self.assertEqual(page, self._packs())

    def test_the_default_theme_is_the_same_in_both_files(self):
        for name, text in (("village.js", self.village), ("app.js", self.app)):
            found = re.search(r"const DEFAULT_THEME = '([a-z]+)'", text)
            self.assertIsNotNone(found, f"{name} has no DEFAULT_THEME")
            self.assertEqual(found.group(1), "village", name)
        self.assertEqual(self._packs()[0], "village", "and it is the first one offered")

    def test_every_theme_names_both_rooms_on_the_page(self):
        rooms = _keys(self.app, "THEME_ROOMS")
        self.assertEqual(sorted(rooms), sorted(self._packs()), "one row per theme")
        body = _strip(_body(self.app, "THEME_ROOMS")[1])
        for pack in self._packs():
            named = re.search(pack + r": Object\.freeze\(\{([^}]*)\}", body)
            self.assertIsNotNone(named, f"{pack} names its rooms")
            self.assertEqual(sorted(re.findall(r"([a-z]+):", named.group(1))), ["castle", "cottages"], pack)

    def test_the_page_never_hard_codes_a_room_name_the_theme_owns(self):
        # A literal left behind outside THEME_ROOMS is a crumb or a tooltip that stays green in the frontier town.
        for word in ("'Valhalla sand castle'", "'The Cottages'"):
            found = [m.start() for m in re.finditer(re.escape(word), self.app)]
            rooms = _body(self.app, "THEME_ROOMS")[1]
            at = self.app.index(rooms)
            inside = [i for i in found if at <= i < at + len(rooms)]
            self.assertEqual(len(found), len(inside), f"{word} is named outside THEME_ROOMS")

    def test_a_theme_renames_places_and_rooms_and_never_a_lane(self):
        # A theme repaints and renames. Touching a lane would move the Board's columns and the count pills with it.
        places = _keys(self.village, "PLACES")
        for key in _keys(self.village, "WEST_NAMES"):
            self.assertIn(key, places, f"WEST_NAMES renames {key}, which is not a place")
        # The two rooms are scenes. 'castle' is a lane's name as well, which is why these are kept apart from the
        # board names above rather than checked against LANE_ORDER with them.
        self.assertEqual(sorted(_keys(self.village, "WEST_ROOMS")), ["castle", "cottages"])
        self.assertEqual(sorted(_keys(self.village, "SCENE_ART")), ["castle", "cottages"])


class LaneContractTests(unittest.TestCase):
    """The lane contract the three files share. Nothing at runtime notices a drift: the page drops a row whose lane
    has no word, and the village silently gives it no place, so a renamed or reordered lane would just make sessions
    vanish. Text-matched rather than executed, so this runs without node."""

    @classmethod
    def setUpClass(cls):
        cls.app = (WEB / "app.js").read_text(encoding="utf-8")
        cls.village = (WEB / "village.js").read_text(encoding="utf-8")

    def test_the_page_sends_rows_in_the_servers_lane_order(self):
        self.assertEqual(_keys(self.app, "LANE_ORDER"), list(bd.LANE_ORDER))

    def test_every_lane_has_a_word_help_and_icon_on_the_page(self):
        for name in ("LANE_WORD", "LANE_HELP", "LANE_ICON"):
            self.assertEqual(sorted(_keys(self.app, name)), sorted(bd.LANE_ORDER), name)

    def test_every_lane_count_reaches_a_hud_pill(self):
        # hudPillModel shows a count only for a key in HUD_PILL_KEYS, with no fallback, so a lane added the way
        # `jail` was would get rows, a place and a board section while its count silently had no pill. `castle` is
        # the one lane with no pill of its own: hudPillModel folds it into valhalla's.
        pills = _keys(self.app, "HUD_PILL_KEYS")
        self.assertEqual(sorted(set(bd.LANE_ORDER) - set(pills)), ["castle"])
        self.assertEqual(sorted(set(pills) - set(bd.LANE_ORDER)), [])

    def test_the_world_map_never_reaches_the_motion_planner(self):
        # The world map is ambient at most, and its only motion (the water) rides the ambient clock. If either of
        # the two functions that decide the frame rate ever read an island, the map would hold the canvas at full
        # rate for as long as it is open, which the harness can only catch in a case somebody remembered to write.
        for name in ("anyMotion", "nextMotionAt"):
            body = _fn(self.village, name)
            for banned in ("world", "World", "island", "Island", "WORLD"):
                self.assertNotIn(banned, body, f"{name} reads {banned}")
        # `anyMotion` answering false for anything but the village is what makes the map and both interiors ambient
        # without either being named in it. Asserted here because nothing else holds that shape.
        self.assertIn("if (scene !== 'village') return false;", _fn(self.village, "anyMotion"))

    def test_the_two_modes_share_one_layout_engine(self):
        # The whole point of world mode: an island is the village filtered to one repo's rows, not a second layout.
        # A `layoutVillage` call anywhere but `applyBoard` would be that second layout starting to grow.
        whole = self.village[self.village.index("function applyBoard("):]
        body = _strip(whole[:whole.index("\n  function advance(")])
        self.assertIn("island === null ? valid : valid.filter((s) => repoKeyOf(s) === island)", body)
        self.assertEqual(len(re.findall(r"\blayoutVillage\(", _strip(self.village))) - 1,  # the export itself
                         len(re.findall(r"\blayoutVillage\(", body)), "layoutVillage is called from applyBoard alone")
        # Colours come from the whole board, so a repo's crowd looks the same whichever island is open.
        self.assertIn("const viewRepos = repoNamesInView(boardSessions);", body)
        self.assertIn("repoIndex = repoColourIndices(viewRepos);", body)
        # And the island list is built from the rows the village would draw, so a badge cannot outrun its crowd.
        self.assertIn("worldLayout(worldRepos(valid, boardVisitors))", body)
        # And the desk queue is laid out from the same application, filtered the same way, so a visitor
        # cannot be on screen for an island whose rows are not.
        self.assertIn("applyVisitors(island === null ? boardVisitors : visitorsFor(boardVisitors, island)", body)
        # An island's colour comes off that same list through the legend's own helper, once per board rather than
        # per frame. Read straight from `repoIndex` it took the no-repo chalk for a repo seen only in the graveyard,
        # which is a real state and collided with the No repo island's own colour.
        self.assertIn("islandColours = new Map(worldIslands.map((is) => [is.repo, repoColour(is.repo, viewRepos)]))",
                      body)
        self.assertIn("islandColours.get(is.repo) || repoColourFor(is.repo)", _fn(self.village, "drawWorldIsland"))

    def test_the_edge_ring_counts_the_whole_board_in_every_scene(self):
        # "Blocked is impossible to miss" predates the world: a blocked session on another island must not turn the
        # canvas ring off. `countOf` answers for what is on screen, `boardCountOf` for the whole board.
        self.assertIn("if (boardCountOf('needs_you') <= 0) return;", _fn(self.village, "drawEdgeRing"))
        self.assertRegex(self.village, r"const boardCountOf = \(lane\) => \(Number\.isFinite\(boardCounts\[lane\]\)")

    def test_every_lane_the_world_map_badges_is_a_real_lane(self):
        # An island's badges are the reason the map exists. A lane renamed on the server would leave a badge that
        # silently counts nothing, and neither the page nor the village would say a word.
        badges = _keys(self.village, "WORLD_BADGE_LANES")
        self.assertEqual(sorted(set(badges) - set(bd.LANE_ORDER)), [], "every badge lane is a lane")
        for lane in ("needs_you", "your_turn", "open_pr", "jail"):
            self.assertIn(lane, badges, f"{lane} has to be visible from the map")

    def test_reviews_are_not_a_lane_in_either_file(self):
        # Reviews are a count of PRs waiting on Charlie, not a session state. In WORLD_BADGE_LANES they would be
        # looked up in STATE, which has no entry for them, and every loop over the lanes would quietly pick them
        # up. Both files keep the same key for it, since the page's pill and the map's badge count one thing.
        self.assertNotIn("reviews", _keys(self.village, "WORLD_BADGE_LANES"))
        self.assertNotIn("reviews", _keys(self.village, "STATE"))
        self.assertNotIn("reviews", list(bd.LANE_ORDER))
        for name, text in (("village.js", self.village), ("app.js", self.app)):
            self.assertRegex(text, r"REVIEWS_KEY = 'reviews'", name)

    def test_the_reviews_badge_is_the_pages_own_visitor_pill(self):
        # The badge on an island's name board and the HUD pill are the same thing counted twice, so they share a
        # colour and a glyph. Nothing at runtime notices them drifting apart: they are drawn by different files.
        css = (WEB / "app.css").read_text(encoding="utf-8")
        border = re.search(r"--visitor-border:\s*(#[0-9a-f]{6})", css)
        self.assertIsNotNone(border, "app.css has no visitor pill colour")
        village = re.search(r"export const REVIEWS = Object\.freeze\(\{ color: '(#[0-9a-f]{6})'", self.village)
        self.assertIsNotNone(village, "village.js has no REVIEWS badge")
        self.assertEqual(village.group(1), border.group(1))
        page_glyph = re.search(r"\n  passport: '([^']+)'", self.app)
        village_glyph = re.search(r"\n  passport: \{ d: '([^']+)'", self.village)
        self.assertIsNotNone(page_glyph, "app.js has no passport icon")
        self.assertIsNotNone(village_glyph, "village.js has no passport glyph")
        self.assertEqual(village_glyph.group(1), page_glyph.group(1))

    def test_the_two_files_key_a_visitors_island_the_same_way(self):
        # The island is the one the server named, never one worked out from the repo name: anyone can open a repo
        # that shares a name with one of Charlie's. The page counts each island's badge from its own list and the
        # village draws the queue from the board, so a rule that drifted would show a badge with nobody behind it
        # and nothing would fail.
        rule = ("const key = v && typeof v === 'object' ? v.island : null;\n"
                "  return typeof key === 'string' && key ? key : null;")
        for name, text in (("village.js", self.village), ("app.js", self.app)):
            self.assertIn(rule, _fn(text, "visitorIsland"), name)
            self.assertIn("const key = visitorIsland(v);", _fn(text, "visitorsByRepo"), name)
            self.assertNotIn("repo", _fn(text, "visitorsByRepo"), f"{name}: an island is never a repo name")
        self.assertIn("rows.filter((v) => visitorIsland(v) === repo)", _fn(self.village, "visitorsFor"))
        self.assertIn("visitors.filter((v) => v.island === isle)", _fn(self.app, "reviewsHere"))

    def test_a_walking_visitor_is_motion_but_standing_in_the_queue_is_not(self):
        # The one place a visitor may touch the frame rate. Unbounded ("if (v.journey)") it would hold the canvas
        # at full rate for as long as one stood at the desk, since a finished journey is only cleared on the next
        # frame, and the harness can only catch that in a case somebody remembered to write.
        # A visitor waiting at the pier tip for its turn to step off is not moving either: arrivals are staggered,
        # so without the lower bound nine of them would hold full rate for the whole procession, not just its walks.
        self.assertIn("for (const v of visitors.values()) if (v.journey && t >= v.journey.t0 && t < v.journey.end) return true;",
                      _fn(self.village, "anyMotion"))
        self.assertIn("for (const v of visitors.values()) if (v.journey && v.journey.t0 > t) at = Math.min(at, v.journey.t0);",
                      _fn(self.village, "nextMotionAt"))

    def test_a_visitor_is_a_pr_and_never_a_session(self):
        # Four ways a visitor could start behaving like a session, each of which would put session machinery on a
        # row that has no session: a plate or a selection ring through targetObject, a title or a login drawn on
        # the canvas, onSelect on a click, and a lane count.
        self.assertIn("if (!id || isIslandId(id) || visitors.has(id)) return null;", _fn(self.village, "targetObject"))
        drawn = _fn(self.village, "drawVisitor")
        for banned in ("fillText", "session", "plate", "STATE["):
            self.assertNotIn(banned, drawn, f"drawVisitor reads {banned}")
        click = _strip(re.search(r"const onClick = \(e\) => \{(.*?)\n  \};", self.village, re.S).group(1))
        self.assertIn("if (visitors.has(id)) {", click)
        self.assertIn("if (typeof onOpen === 'function') onOpen(id);", click)
        # And the lane counts are built from the sessions alone.
        self.assertNotIn("visitor", _fn(self.village, "validRows"))

    def test_the_two_files_read_who_was_asked_the_same_way(self):
        # The page's tooltip says "Asked of you" and the village draws the direct look from the same field, so it
        # has to be one rule: only 'you' is personal, and anything else, a missing field included, is a team. A
        # drift would put a team sash on a PR the tooltip calls yours, and nothing at runtime would notice.
        rule = "return v && typeof v === 'object' && v.via === 'you' ? 'you' : 'team';"
        for name, text in (("village.js", self.village), ("app.js", self.app)):
            self.assertIn(rule, _fn(text, "visitorVia"), name)
        self.assertIn("via: visitorVia(v)", _fn(self.village, "visitorRows"))
        self.assertIn("via: visitorVia(v)", _fn(self.app, "visitorsFrom"))

    def test_who_was_asked_is_paint_and_never_motion_or_text(self):
        # The two looks change what is painted and nothing else. Named in the motion planner, a team visitor
        # standing at the desk would hold the canvas at full rate; and a team slug is text GitHub users chose,
        # which the village never keeps and never draws.
        for name in ("anyMotion", "nextMotionAt"):
            body = _fn(self.village, name)
            for banned in (r"\bvia\b", r"[Ss]ash", r"\bteams?\b", "VISITOR_PASSPORT"):
                self.assertNotRegex(body, banned, f"{name} reads {banned}")
        self.assertNotRegex(_fn(self.village, "visitorRows"), r"\bteams\b", "the village keeps no team names")
        drawn = _fn(self.village, "drawVisitor")
        self.assertNotRegex(drawn, r"\bteams\b", "drawVisitor reads the team names")
        self.assertIn("if (via === 'team') fillPoly(ctx, visitorSash(x, bottom), VISITOR_SASH);", drawn)
        self.assertIn("const [pl, pt, pr, pb] = VISITOR_PASSPORT[via];", drawn)

    def test_the_scenery_never_reaches_the_motion_planner(self):
        # The two functions that decide the frame rate. A beam, a ghost, the frontier's horse or its fights named in
        # either would hold the canvas at full rate for as long as the page is open, which is the one thing the whole
        # village is paced around, and the harness can only catch it by counting frames in a case somebody remembered
        # to write. All of them are scenery: they move, but nothing is going anywhere.
        for name in ("anyMotion", "nextMotionAt"):
            body = _fn(self.village, name)
            for banned in ("beam", "Beam", "ghost", "Ghost", "GHOST", "LIGHTHOUSE", "night",
                           "horse", "Horse", "HORSE", "fight", "Fight", "west", "West",
                           "gollum", "Gollum", "GOLLUM", "pony", "Pony", "ent", "Ent", "ENT",
                           "spider", "Spider", "SPIDER", "orc", "Orc", "stride", "Stride", "walk", "Walk"):
                self.assertNotIn(banned, body, f"{name} reads {banned}")

    def test_the_lit_castle_pane_takes_the_shape_of_the_opening_it_fills(self):
        # The harness reads the radius the pane is drawn at off the canvas; this ties that radius to the painting.
        # Every opening paintSandCastle draws is a capsule (radius = half the short side), so a pane drawn squarer
        # puts its four corners out on the castle wall, which no box check can see.
        openings = re.findall(
            r"fillRR\(g, \w+ [-+] [\d.]+, \w+ - [\d.]+, ([\d.]+), ([\d.]+), ([\d.]+), T\.castleDoor\)",
            _fn(self.village, "paintSandCastle"))
        self.assertEqual(len(openings), 2, "the keep's opening and the turrets'")
        for w, h, r in openings:
            self.assertEqual(float(r), min(float(w), float(h)) / 2, f"the {w}x{h} opening is a capsule")
        # And the windows the night lighting lights are those same openings, at the same sizes.
        windows = re.findall(r"CASTLE\.y - [\d.]+, ([\d.]+), ([\d.]+)\]", _body(self.village, "CASTLE_WINDOWS")[1])
        keep, turret = (openings[0][0], openings[0][1]), (openings[1][0], openings[1][1])
        self.assertEqual(sorted(windows), sorted([keep, turret, turret]))
        lit = _fn(self.village, "litWindow")
        self.assertIn("fillRR(ctx, x, y, w, h, Math.min(w, h) / 2, T.windowLit);", lit,
                      "the unpaned pane takes the capsule radius and no outline")

    def test_every_lane_has_a_village_place_and_state_badge(self):
        self.assertEqual(sorted(_keys(self.village, "LANE_PLACE")), sorted(bd.LANE_ORDER))
        self.assertEqual(sorted(_keys(self.village, "STATE")), sorted(bd.LANE_ORDER))

    def test_every_lane_reaches_a_board_column(self):
        # The Board groups lanes into ten columns, which is a second place a lane can go missing without a word
        # from anything: boardColumns reads COLUMN_LANES alone, so a lane left out of it would still have a HUD
        # pill, a village place and a count, and no cards anywhere.
        self.assertEqual(_keys(self.app, "COLUMN_LANES"),
                         ["needs_you", "errored", "your_turn", "running", "open_pr", "jail", "idle", "recent",
                          "valhalla", "graveyard"])
        body = _strip(_body(self.app, "COLUMN_LANES")[1])
        lanes = re.findall(r"'([a-z_]+)'", body)
        self.assertEqual(sorted(lanes), sorted(bd.LANE_ORDER))
        self.assertEqual(len(lanes), len(set(lanes)), "a lane is in two columns")

        def column(key):
            found = re.search(rf"\n  {key}: \[([^\]]*)\]", body)
            self.assertIsNotNone(found, f"{key} has no lane list")
            return re.findall(r"'([a-z_]+)'", found.group(1))

        # The two columns that hold more than one lane: `stopped` waits with Blocked, the sand castle with Valhalla.
        self.assertEqual(column("needs_you"), ["needs_you", "stopped"])
        self.assertEqual(column("valhalla"), ["valhalla", "castle"])

    def test_the_page_and_the_village_use_the_same_lane_words(self):
        page = dict(re.findall(r"([a-z_]+): '([^']+)'", _body(self.app, "LANE_WORD")[1]))
        for lane in bd.LANE_ORDER:
            village = re.search(rf"\n  {lane}: {{[^\n]*word: '([^']+)'", self.village)
            self.assertIsNotNone(village, f"{lane} has no village word")
            self.assertEqual(village.group(1), page[lane], lane)

    def test_the_jail_is_wired_end_to_end(self):
        self.assertIn("jail", bd.LANE_ORDER)
        self.assertEqual(bd.build_board(  # counts carry every lane, so the HUD pill and the sign have a number
            bd.RawSnapshot(scanned_at=0, desktop=(), registry_files=0, registry_live=(), cli_only=(), tails={},
                           app_version="x", cli_versions=(), desktop_parse_errors=0, scan_ms=0, warnings=()),
            0, None, None)["counts"]["jail"], 0)
        self.assertRegex(self.app, r"jail: 'Jail'")
        self.assertRegex(self.village, r"\n  jail: {[^\n]*word: 'Jail'")

    def test_no_retired_lane_copy_is_left_in_the_web_files(self):
        for name, text in (("app.js", self.app), ("village.js", self.village),
                           ("app.css", (WEB / "app.css").read_text(encoding="utf-8")),
                           ("index.html", (WEB / "index.html").read_text(encoding="utf-8"))):
            # The matcher that maps an older server's label onto "Needs input" is the one place these words belong.
            lines = [ln for ln in text.splitlines()
                     if re.search(r"Unread|Your turn|Needs you|\bTent\b", ln)
                     and "YOUR_TURN_LABELS" not in ln and not ln.lstrip().startswith("//")]
            self.assertEqual(lines, [], f"{name} still shows retired copy")
            self.assertNotIn(chr(0x2014), text, f"{name} has an em dash")  # escaped so this file holds none either


class BoardWiringTests(unittest.TestCase):
    """Rules of the Board and of the page's scope that live in DOM code, where the harness has no DOM to exercise
    them in: what suppresses a re-render, what a card's PR line is built from, where focus goes when the toast
    closes, what drives the edge scroll, and the two places the world of islands reaches into the page's own DOM.
    Each one failed silently rather than loudly before, so they are text-matched here."""

    @classmethod
    def setUpClass(cls):
        cls.app = (WEB / "app.js").read_text(encoding="utf-8")

    def test_n_reaches_the_island_holding_the_row_from_the_world_map_too(self):
        # The key promises the whole board and that the pick lands on screen. Guarded on an island already being
        # open, it picked a character the world map does not draw at all, and it was also the only keyboard way
        # onto an island. `setMode` already sails in from the map on a mode switch; these two must read alike.
        body = _fn(self.app, "pickLongestWaiting")
        self.assertIn("if (state.mode === 'world' && openIslandKey() !== isle) enterIsland(isle);", body)
        self.assertNotIn("openIslandKey() !== null &&", body)
        self.assertIn("if (picked && openIslandKey() !== repoKeyOf(picked)) enterIsland(repoKeyOf(picked));",
                      _fn(self.app, "setMode"))

    def test_the_island_body_attribute_is_written_wherever_the_island_changes(self):
        # It takes both writes, and each covers the other's hole. In refreshScope alone it is never simply absent,
        # since that runs on the first setMode: a rule matching "none" fires on a fresh page. In setIslandNow alone
        # it would go stale on the two disconnect paths, which clear the island and then call renderAll, and
        # renderAll does not call refreshScope: the attribute read "open" with no island on screen.
        write = "document.body.dataset.island = openIslandKey() === null ? 'none' : 'open';"
        self.assertIn(write, _fn(self.app, "refreshScope"))
        self.assertIn(write, _fn(self.app, "setIslandNow"))

    def test_only_an_armed_drag_suppresses_the_board(self):
        # `state.drag` is set on pointerdown, before the 6 px that makes the press a drag, so suppressing on the
        # press alone froze the Board for good whenever a pointerup went missing: the HUD counted on, the columns
        # did not, and only another press cleared it.
        body = _fn(self.app, "renderBoard")
        self.assertIn("if (state.drag && state.drag.active)", body)
        self.assertNotRegex(body, r"if \(state\.drag\)\s")
        # And the belt: returning to the tab clears a press that was stranded while it was hidden.
        listener = re.search(r"visibilitychange', \(\) => \{(.*?)\n  \}\);", self.app, re.S)
        self.assertIsNotNone(listener, "no visibilitychange listener")
        self.assertIn("endDrag();", _strip(listener.group(1)))

    def test_a_board_card_carries_the_whole_pr_line(self):
        # The card folded in the expansion the old Board row had, and the merge age and the confirmation note were
        # in it. prPill alone drops both, and "not confirmed" then reaches the Board as a dashed border only.
        body = _fn(self.app, "cardNode")
        self.assertIn("prLineNodes(s.pr, false)", body)
        self.assertNotIn("prPill(s.pr)", body)

    def test_the_toast_hands_focus_back_through_the_board_fallback(self):
        # rowElement answers null for a row the column's cap holds back, and focus then stays on the button the
        # toast has just removed, which in a browser means the page body.
        body = _fn(self.app, "hideToast")
        self.assertIn("focusSession(state.selectedId)", body)
        self.assertNotIn("rowElement(", body)
        shared = _fn(self.app, "focusSession")
        self.assertIn("rowElement(id)", shared)
        self.assertIn("restoreBoardFocus(", shared)

    def test_the_edge_scroll_runs_off_a_timer_and_stops_with_the_drag(self):
        # One step per pointermove meant 54 moves to cross the board and nothing at all for a pointer held at the
        # edge. A timer is not an animation frame, so the frame rule is untouched.
        body = _fn(self.app, "armEdgeScroll")
        self.assertIn("setTimeout(step, DRAG_EDGE_MS)", body)
        self.assertIn("setDropTarget(d, columnAtPoint(d.at.x, d.at.y))", body)
        self.assertNotIn("requestAnimationFrame", body)
        self.assertIn("stopEdgeScroll(d);", _fn(self.app, "endDrag"))


@unittest.skipUnless(NODE, "node is not installed; the web checks need it")
class WebHarnessTests(unittest.TestCase):
    """Village click rules, the merged Porch (blocked by the door, needs input on the swings, errored and stopped on
    the steps, one sign naming all four, and no plate painted over it, a lone Blocked's selected or hovered
    included), repo colours (bold palette distances from each other and the state colours,
    face and accessory contrast), size by output tokens (log scale, per-place caps with no overlaps, crowds drawn in
    token order within their cap, hit tests and hover points at size, an interior's crowd scale times size and its
    spacing in depth), the border patrol (booth, barrier and guard clear of the harbour and of walkers at any size,
    hover with no click, the passport stamp kept clear of the guard and put away before the barrier lifts, merges at
    once keeping the queue slots of those waiting, and walkers waved through), the smaller island out at sea (its
    drawn outline inside the canvas, 200 px of water all round, a 5 s crossing over open water, a drawn hull clear of
    both shores the whole way), the ground the village is drawn on (no road band over open water, the quay under the
    junction, every tree over land), Valhalla voyages (the pier, the lane to
    the island, boats sailing home empty, turning back afloat), the two interiors (the sand castle hall and the
    cottage room: guests wandering, hit-tested where they stand, holding still while hovered, 24 fps only while
    open, and the cottage door counting the whole room), the jail (its plot held to itself, a crowd behind bars with faces and badges clear of every bar, hover,
    click and hover points at size, a walk into the yard), the graveyard and its ghosts (two at one grave rising to
    six at a full one, every perch inside the fence over the headstones and clear of the painted sign, the jail and
    each other at every phase, painted over the headstones with no hit area so a headstone under a ghost still
    hovers and clicks, ambient frames only, static under reduced motion), what a place paints read off the canvas
    rather than its slots (every place at 0 to 30 rows at 1.5x in both themes, in one village and inside an island,
    clear of every other place and off the road but for the contacts it already had, pinned; every Porch lane mix
    from 0 to 30 below the road; and Charlie's own board, 5 Needs input and 123 graves, by name), the night lighting (the sand castle's
    windows and the lighthouse lantern lit at dusk and dark in the day theme, and a beam sweeping once every 5 s on
    the ambient tick alone, dim enough over an avatar, the harbour, the patrol and a boat that a body keeps its
    repo colour), every badge glyph
    parsed as a path (node has no Path2D, so nothing else here ever draws one), frame pacing, the repeat-open guard,
    tooltip placement and the usage "as of" date, the world of islands (one island per repo from 1 to 24 repos and
    beyond with no overlaps and every label inside its own island, size following the session count, hover and
    click on the map, an island drawing exactly its own repo's rows with every sign counting that island, the
    graveyard, ghosts, interiors and beam all per island, the map ambient at rest and still under reduced motion, a
    repo leaving the board falling back to the map, the mode toggle keeping the selection, an interior opened from the
    map closing back onto it with no three-step order of the exits leaving an inconsistent scene, nothing painted
    leaving an island's own box including the hover ring's line width, two repos sharing a long prefix drawing as
    different names, a graveyard-only repo keeping its own colour, and one village mode
    digested shape for shape and word for word against the scene before any of this), and the page booted on a small
    DOM parsed out of index.html for the three things text matching cannot reach (a poll outage giving the open
    island back on reconnect, a breadcrumb keeping keyboard focus in the page, and the Reviews pill carrying the
    board's own number while a click on the visitor at the desk posts exactly one key, `id`, with nothing
    path-shaped in the body and no eleventh Board column), the visitors at the immigration desk
    (0, 1, 3, 8 and 40 of them slotted in one file with nothing touching the guard, the booth, the barrier, the
    platform, the boats, the pier, the boardwalk, the harbour queue at 1.5 or any session slot, part by part; the
    list cleaned to the same rows the page cleans it to, field for field, on every shape either of them has a
    rule for; hovered by their own id with the point at the top of the head, a click
    opening the PR and never selecting; walking up the pier and away again at full rate only while they move; drawn
    in both themes and nowhere else in the frame; placed directly under reduced motion; coats clear of every state
    colour and every repo body; and a Reviews badge on the right island with the board's total on the map), the two
    looks at the desk (a request asked of you presenting its passport exactly as every visitor did before, one asked
    of a team in a sash with its passport lowered, drawn as measured at 0, 1, 3, 9 and 40 of mixed kinds in both
    themes with no clearance lost, one hit box and one frame rate for both, the direct kind drawn before the team
    kind and a displaced team visitor fading where it stands), the page's words for who was asked (a team's line
    always saying "team", so a team whose slug is "you" never reads as a request asked of you), run
    headless."""

    @classmethod
    def setUpClass(cls):
        proc = subprocess.run([NODE, str(HARNESS)], capture_output=True, text=True, timeout=120, shell=False,
                              stdin=subprocess.DEVNULL, env={"PATH": "/usr/bin:/bin", "HOME": os.environ.get("HOME", "")})
        lines = [ln for ln in proc.stdout.splitlines() if ln.startswith("{")]
        if not lines:
            raise AssertionError(f"harness printed no result (exit {proc.returncode}): {proc.stderr[-2000:]}")
        cls.results = json.loads(lines[-1])

    def test_harness_ran_every_check(self):
        self.assertGreaterEqual(len(self.results["passed"]) + len(self.results["failed"]), 100)

    def test_no_failures(self):
        failures = "\n".join(f"{f['name']}: {f['message']}" for f in self.results["failed"])
        self.assertEqual(self.results["failed"], [], failures)


if __name__ == "__main__":
    unittest.main()
