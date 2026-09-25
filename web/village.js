// The Village: every session is a small character and every lane is a place.
// Pure helpers are exported for headless tests. All DOM and canvas use lives inside createVillage.

const TAU = Math.PI * 2;

export const LOGICAL_WIDTH = 1600;
export const LOGICAL_HEIGHT = 900;
const W = LOGICAL_WIDTH;
const H = LOGICAL_HEIGHT;

const FONT = 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
export const NAME_MAX = 28;
export const ESCALATE_MS = 10 * 60 * 1000;
const WAVE_PERIOD = 1.5;
const HAMMER_PERIOD = 0.95;
// Walking and sailing get full frame rate; everything else (hammering, sparks, waving, blinks, palms, sips) is
// timed off the clock, so 12 fps looks the same and costs a fraction of the battery. A blink lasts 140 ms, so it
// can never fall between two 83 ms frames. Particle dt is capped just above one ambient frame.
const MOTION_FRAME_MS = 14;
export const AMBIENT_FRAME_MS = 83;
const MAX_PARTICLE_DT = 0.12;
export const HOVER_MOVE_PX = 2;
export const CLICK_SLOP_PX = 4;
const BADGE_R = 14;
const HAMMER_RAISED = -1.9;
const HAMMER_STRIKE = -0.45;
const LEG = 6;

export const CASTLE_ID = 'castle:hall';
export const COTTAGE_ID = 'cottages:room';
export const FADE_S = 0.6;
export const APPEAR_S = 0.45;
export const RISE_S = 0.7;
export const HOP_S = 0.35;
// A change of size (more tokens counted, or a place that allows less) eases over this long.
export const RESIZE_S = 0.35;
// One size for the moored boat and a boat under way, so a boat leaving its berth does not change size. Boats keep it
// whatever the size of their passenger: the largest still fits inside the gunwale, and bigger hulls would eat the
// BOAT_CLEAR margin that keeps boats apart.
export const BOAT_SCALE = 0.7;
// Two boats at one berth closer together than this would be drawn on top of each other (see planBoats).
// Two boats never use one berth within this long of each other. It has to cover the eased start of a crossing:
// a boat leaves its berth slowly, so on this lane 1.6 s left it only 90 px away, inside BOAT_CLEAR.
export const SAIL_GAP_S = 2.2;
const SIP_PERIOD = 7.5;
const SIP_S = 1.4;

// The hull as drawn (see drawRowboat): local units at BOAT_SCALE, dropped 4 below the boat's point, rocking on the
// bob and the tilt. A boat is never rotated to its heading, so this box is the water a hull needs, and it is what
// the checks sweep along the lane: the margin from the lane centre to the coast is not the margin a hull keeps.
export const HULL = Object.freeze({ l: -60, r: 60, t: -10, b: 17, drop: 4, bob: 1.5, tilt: 0.03 });
// The mast, sail and flag reach local y -96 under sail (see drawRowboat), 86 above the hull's own top, so a box that
// asks what is drawn is not the box that asks what water the hull needs.
export const BOAT_TOP = -96;
// What the locomotive reaches, in the boat's own local units: its back sheet, its nose, its chimney cap, its wheel
// bottoms and the top of its plume. The draw reads these for its extremes, and `theme packs` checks them against
// the hull the boat declares, so a locomotive cannot grow past the footing it stands on.
export const LOCO = Object.freeze({ back: -58, nose: 60, cap: -62, wheels: 16, plume: -92 });
function boatExtent(x, y, top) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const tilt of [HULL.tilt, -HULL.tilt]) {
    for (const bob of [HULL.bob, -HULL.bob]) {
      const cy = y + HULL.drop + bob;
      for (const lx of [HULL.l, HULL.r]) {
        for (const ly of [top, HULL.b]) {
          const sx = lx * BOAT_SCALE;
          const sy = ly * BOAT_SCALE;
          const px = x + sx * Math.cos(tilt) - sy * Math.sin(tilt);
          const py = cy + sx * Math.sin(tilt) + sy * Math.cos(tilt);
          x0 = Math.min(x0, px);
          y0 = Math.min(y0, py);
          x1 = Math.max(x1, px);
          y1 = Math.max(y1, py);
        }
      }
    }
  }
  return [x0, y0, x1 - x0, y1 - y0];
}
// The water a hull needs: what the lane and coast checks sweep, since the margin from the lane centre to the coast
// is not the margin a hull keeps.
export function hullBox(x, y) {
  return boatExtent(x, y, HULL.t);
}
// The boat as drawn, sail and flag included: what a light sweeping over it actually falls on.
export function boatBox(x, y) {
  return boatExtent(x, y, BOAT_TOP);
}

// ---------------------------------------------------------------------------------------------
// State palette (reserved for state) and glyphs
// ---------------------------------------------------------------------------------------------

export const STATE = Object.freeze({
  // White on this orange is 2.57:1, under the 3:1 minimum for graphics, so the glyph is dark (6.3:1).
  needs_you: { color: '#fd7e14', border: '#b85a0c', glyph: 'hand', word: 'Blocked', glyphColor: '#1d2125' },
  errored: { color: '#dc3545', border: '#a71d2a', glyph: 'alert', word: 'Errored' },
  your_turn: { color: '#ffc107', border: '#b38600', glyph: 'dots', word: 'Needs input', lightDisc: true },
  running: { color: '#1565c0', border: '#0d4a91', glyph: 'hammer', word: 'Running' },
  stopped: { color: '#fd7e14', border: '#fd7e14', glyph: 'pause', word: 'Stopped', outline: true },
  idle: { color: '#c4c9ce', border: '#868e96', glyph: 'moon', word: 'Idle', lightDisc: true },
  open_pr: { color: '#28a745', border: '#1b6e2e', glyph: 'merge', word: 'PR open' },
  recent: { color: '#c4c9ce', border: '#868e96', glyph: 'clock', word: 'Recent', lightDisc: true, dim: true },
  valhalla: { color: '#6f42c1', border: '#4b2a86', glyph: 'merge', word: 'Valhalla' },
  castle: { color: '#6f42c1', border: '#4b2a86', glyph: 'merge', word: 'Sand castle' },
  // The jail shares the graveyard's slate and is told apart by its bars glyph. The page's own jail pill is a rose
  // that no body colour could sit beside: every rose near it lands 8.6 CIEDE2000 from the Mauve repo body, and the
  // 20 a state colour has to keep from every body is worth more here than matching the pill.
  jail: { color: '#495057', border: '#2f3438', glyph: 'bars', word: 'Jail' },
  graveyard: { color: '#495057', border: '#2f3438', glyph: 'headstone', word: 'Graveyard' },
});

// A count pill's glyph and number: the badge's own ink where it names one, else dark on a light disc and white
// on a saturated one.
const pillInk = (st) => st.glyphColor || (st.lightDisc ? '#1d2125' : '#ffffff');

const OUTLINE_FILL = '#fff1e6';
const OUTLINE_GLYPH = '#9a4f00';

// The one warm light in the village, as rgb components: cottage and castle windows, and the lighthouse lantern
// and its beam are all this colour at different alphas.
const WARM_LIGHT = '246, 222, 160';
const LIGHT_DISC_GLYPH_EDGE = 'rgba(33, 37, 41, 0.6)';

const rnd2 = (n) => Math.round(n * 100) / 100;
const rnd5 = (n) => Math.round(n * 100000) / 100000;

function circleD(cx, cy, r) {
  return `M${rnd2(cx - r)} ${rnd2(cy)} A${r} ${r} 0 1 0 ${rnd2(cx + r)} ${rnd2(cy)} A${r} ${r} 0 1 0 ${rnd2(cx - r)} ${rnd2(cy)} Z`;
}

function polygonD(points) {
  return 'M' + points.map(([x, y]) => `${rnd2(x)} ${rnd2(y)}`).join(' L') + ' Z';
}

function rotatePoints(points, deg, cx, cy, tx = 0, ty = 0) {
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return points.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * cos - dy * sin + tx, cy + dx * sin + dy * cos + ty];
  });
}

const HAMMER_D = [
  [[4.5, 3], [19.5, 3], [19.5, 9], [4.5, 9]],
  [[10.5, 8], [13.5, 8], [13.5, 21], [12.8, 22], [11.2, 22], [10.5, 21]],
].map((p) => polygonD(rotatePoints(p, 45, 12, 12, -1, 0.8))).join(' ');

// 24 x 24 artboard. `rule` is the fill rule; `stroke` marks line glyphs.
export const GLYPHS = Object.freeze({
  hand: {
    d: 'M6 13 V6.5 A1.5 1.5 0 0 1 9 6.5 V13 Z M9.5 13 V4.5 A1.5 1.5 0 0 1 12.5 4.5 V13 Z '
      + 'M13 13 V5.5 A1.5 1.5 0 0 1 16 5.5 V13 Z M16.5 14 V8.25 A1.25 1.25 0 0 1 19 8.25 V14 Z '
      + 'M6 12 H19 V15 A7 7 0 0 1 12 22 H11.5 A5.5 5.5 0 0 1 6 16.5 Z M7 13.5 L6.5 18 L2 13 A1.4 1.4 0 0 1 3.8 10.9 Z',
    rule: 'nonzero',
  },
  alert: {
    d: 'M12 2.5 L22.5 20.5 H1.5 Z M10.8 8.5 H13.2 V14.3 H10.8 Z M10.8 16 H13.2 V18.4 H10.8 Z',
    rule: 'evenodd',
  },
  dots: {
    d: 'M5 4.5 H19 A3 3 0 0 1 22 7.5 V14 A3 3 0 0 1 19 17 H11 L6.5 21 V17 H5 A3 3 0 0 1 2 14 V7.5 A3 3 0 0 1 5 4.5 Z '
      + [7.3, 12, 16.7].map((x) => circleD(x, 10.75, 1.6)).join(' '),
    rule: 'evenodd',
  },
  hammer: { d: HAMMER_D, rule: 'nonzero' },
  pause: { d: 'M6.5 4.5 H10.5 V19.5 H6.5 Z M13.5 4.5 H17.5 V19.5 H13.5 Z', rule: 'nonzero' },
  moon: { d: 'M14.5 3 A9 9 0 1 0 21 14.5 A7 7 0 0 1 14.5 3 Z', rule: 'nonzero' },
  merge: {
    d: `${circleD(7, 5.5, 2.4)} ${circleD(7, 18.5, 2.4)} ${circleD(17, 12.5, 2.4)} M7 7.9 V16.1 M7 7.9 C7 11.5 10 12.5 14.6 12.5`,
    stroke: 2.4,
  },
  clock: { d: `${circleD(12, 12, 8.6)} M12 7.2 V12 L15.4 14.2`, stroke: 2.4 },
  // A barred window, the same shape as the page's jail icon.
  bars: { d: 'M4.2 4.2 H19.8 V19.8 H4.2 Z M9.4 4.2 V19.8 M14.6 4.2 V19.8', stroke: 2.4 },
  // A passport: what a visitor holds at the desk, and the same shape as the page's own Reviews pill icon.
  passport: { d: 'M6 3h9a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6zM12 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4M9.5 15.5h5', stroke: 2.2 },
  // A round-topped slab on a plinth with the cross cut out.
  headstone: {
    d: 'M6.5 19 V9.5 A5.5 5.5 0 0 1 17.5 9.5 V19 Z M4 19 H20 V22 H4 Z '
      + 'M11 7.5 H13 V10 H15.5 V12 H13 V16.5 H11 V12 H8.5 V10 H11 Z',
    rule: 'evenodd',
  },
});

// ---------------------------------------------------------------------------------------------
// Pure helpers: looks, text, lanes, slots, roads, voyages
// ---------------------------------------------------------------------------------------------

export const SHAPES = Object.freeze(['round', 'square', 'tall']);
export const ACCESSORIES = Object.freeze(['none', 'hat', 'scarf', 'antenna', 'glasses']);

export function lookFeatures(look) {
  let n = Number(look);
  if (!Number.isFinite(n) || n < 0) n = 0;
  n = Math.floor(n);
  // look can reach 2**32 - 1. JS >> works on int32 and would go negative past 2**31, so divide instead.
  return {
    shape: SHAPES[n % 3],
    accessory: ACCESSORIES[Math.floor(n / 4) % 5],
    hue: Math.floor(n / 32) % 360,
  };
}

export const LANE_PLACE = Object.freeze({
  needs_you: 'porch',
  errored: 'porch',
  stopped: 'porch',
  running: 'workshop',
  your_turn: 'porch',
  idle: 'cottages',
  recent: 'cottages',
  open_pr: 'harbour',
  valhalla: 'beach',
  castle: 'castle',
  jail: 'jail',
  graveyard: 'graveyard',
});

// The spot inside a place where a lane stands. The merged Porch has three: the door, the swings and the steps.
// The Cottages and the sand castle have none: their rows are inside, so they are click-into rooms, not slot grids.
export const LANE_SPOT = Object.freeze({
  needs_you: 'porch',
  errored: 'steps',
  stopped: 'steps',
  running: 'workshop',
  your_turn: 'swings',
  open_pr: 'harbour',
  valhalla: 'beach',
  jail: 'jail',
});

const hasOwn = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

export function placeForLane(lane) {
  return hasOwn(LANE_PLACE, lane) ? LANE_PLACE[lane] : null;
}

export function spotForLane(lane) {
  return hasOwn(LANE_SPOT, lane) ? LANE_SPOT[lane] : null;
}

// ----- repo colours -----

// Face ink: near-black on light bodies, cream on dark ones. Each entry names its own, so faces clear 4.5:1 on it.
export const INK_DARK = '#1d2125';
export const INK_LIGHT = '#fffdf6';

// Body colours by repo, bold and spread over both hue and lightness: four dark bodies with cream faces among eight
// light ones. Chosen by search to keep every pair and every reserved state colour far apart by CIEDE2000 in both
// themes; hues stay at least 18 degrees (OKLCH) from orange, red, amber, blue, green and purple. `light` and `dark` are
// the bodies for day and dusk; a dark body keeps its colour at dusk and gets a pale rim there, so it still stands out
// on dark grass. A collision moves a repo to the next free entry, so the order keeps neighbours far apart.
const repoEntry = (name, light, lightEdge, dark, darkEdge, ink) => Object.freeze({ name, light, lightEdge, dark, darkEdge, ink });
export const REPO_PALETTE = Object.freeze([
  repoEntry('Orchid', '#d876d0', '#5e175b', '#c76ebf', '#470444', INK_DARK),
  repoEntry('Pine', '#0e5a4a', '#022b22', '#0e5a4a', '#8dada3', INK_LIGHT),
  repoEntry('Aqua', '#43fee2', '#066357', '#4beed5', '#08483f', INK_DARK),
  repoEntry('Pink', '#ffc0d2', '#6d4350', '#eeb5c5', '#522d39', INK_DARK),
  repoEntry('Sea', '#59a196', '#053e38', '#53948a', '#042b26', INK_DARK),
  repoEntry('Plum', '#851261', '#440230', '#851261', '#ca90b0', INK_LIGHT),
  repoEntry('Olive', '#57531c', '#2a2701', '#57531c', '#acab90', INK_LIGHT),
  repoEntry('Periwinkle', '#8e9cf8', '#2f3574', '#8491e4', '#1f225a', INK_DARK),
  repoEntry('Pistachio', '#d7e6ae', '#515a33', '#cbd8a5', '#3a421f', INK_DARK),
  repoEntry('Mauve', '#86646c', '#472f35', '#86646c', '#d2bec2', INK_LIGHT),
  repoEntry('Sky', '#3ed4ff', '#085165', '#42c6ed', '#013a49', INK_DARK),
  repoEntry('Moss', '#9f9c22', '#3b3a01', '#928f24', '#282702', INK_DARK),
]);
// Rows with no repo: a near-neutral chalk, lighter than the grey reserved for idle and recent.
export const NO_REPO_COLOUR = Object.freeze({
  name: 'No repo', light: '#f3f0e8', lightEdge: '#6f6a60', dark: '#cfcac0', darkEdge: '#4a463f', ink: INK_DARK,
});

// Hats, scarves and antenna tips: dark on light bodies and light on dark ones, each at least 3:1 against the body.
export const ACCENTS_DARK = Object.freeze(['#3b2f4f', '#1f3f38', '#4b2e22', '#3d2a3a', '#403a1c']);
export const ACCENTS_LIGHT = Object.freeze(['#f6ecd2', '#e9ddf3', '#d6efe5', '#f7dccd', '#e8f0c6']);
export function accentFor(colour, hue) {
  const set = colour && colour.ink === INK_LIGHT ? ACCENTS_LIGHT : ACCENTS_DARK;
  return set[Math.floor((Number(hue) || 0) / 72) % set.length];
}

// FNV-1a over UTF-16 code units: stable across page loads and browsers.
export function repoHash(name) {
  let h = 0x811c9dc5;
  const text = String(name);
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

// Map repo -> palette index for every repo in view. Each takes its hash entry unless an earlier name (sorted)
// already has it, then the next free one. Past the palette size entries are reused, still spread out.
export function repoColourIndices(repos) {
  const names = [...new Set(Array.from(repos || []).filter((r) => typeof r === 'string' && r))].sort();
  const n = REPO_PALETTE.length;
  const used = new Set();
  const out = new Map();
  for (const name of names) {
    if (used.size >= n) used.clear();
    let i = repoHash(name) % n;
    while (used.has(i)) i = (i + 1) % n;
    used.add(i);
    out.set(name, i);
  }
  return out;
}

// The repos that wear a colour: every row but the graveyard's headstones.
export function repoNamesInView(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((s) => s && typeof s === 'object' && s.lane !== 'graveyard' && typeof s.repo === 'string' && s.repo)
    .map((s) => s.repo);
}

// The palette entry for a repo, given every repo in view (the repo is counted as in view if missing).
// { name, light, lightEdge, dark, darkEdge }: `light` and `dark` are the body fills for each colour scheme.
export function repoColour(repo, repos) {
  if (typeof repo !== 'string' || !repo) return NO_REPO_COLOUR;
  const list = Array.from(repos && typeof repos[Symbol.iterator] === 'function' && typeof repos !== 'string' ? repos : []);
  if (!list.includes(repo)) list.push(repo);
  return REPO_PALETTE[repoColourIndices(list).get(repo)];
}

// ----- the world of islands -----

// Two modes over one layout engine. 'village' is the village exactly as it is: every session on one map, its repo
// shown by body colour. 'world' adds a schematic world map with one island per repo; clicking an island shows that
// same village filtered to that repo's rows, so every place (Porch, Workshop, Cottages room, Harbour with its
// guard, graveyard, jail, the Valhalla islet) is per island without a second layout to maintain.
export const MODES = Object.freeze(['village', 'world']);
export const MODE_SHARE = 0.7;

// Rows with no repo share one island, so nothing on the board is invisible in world mode. A repo name is always
// non-empty here, so '' can never collide with one.
export const NO_REPO_KEY = '';
export const NO_REPO_LABEL = 'No repo';
export const ISLAND_PREFIX = 'island:';

// Hover ids in the style of 'castle:hall' and 'cottages:room'. The no-repo island is 'island:'.
export function islandHoverId(repo) {
  return ISLAND_PREFIX + (typeof repo === 'string' ? repo : NO_REPO_KEY);
}

export function isIslandId(id) {
  return typeof id === 'string' && id.startsWith(ISLAND_PREFIX);
}

// The repo an island id names, or null for anything else. A repo holding a colon is fine: only the prefix is cut.
export function repoOfIslandId(id) {
  return isIslandId(id) ? id.slice(ISLAND_PREFIX.length) : null;
}

// The island a row belongs to, grouped by `repo` exactly as the legend groups it.
export function repoKeyOf(row) {
  return row && typeof row === 'object' && typeof row.repo === 'string' && row.repo ? row.repo : NO_REPO_KEY;
}

export function worldLabel(repo) {
  return typeof repo === 'string' && repo ? repo : NO_REPO_LABEL;
}

// The lanes an island badges, in this order. A blocked or reviewable session has to be impossible to miss from the
// world map, which is the whole reason for having one.
export const WORLD_BADGE_LANES = Object.freeze(['needs_you', 'your_turn', 'errored', 'open_pr', 'jail']);

// One entry per repo on the board: { repo, count, lanes, reviews }, alphabetical with the no-repo island last. It
// counts only the rows the village would draw, so an island's badge and the crowd inside it always agree.
//
// `visitors` adds each island's reviews-waiting count. It never adds an island: a repo with a review request and
// no sessions has no island at all, which is the page's own rule, and an island the page's tooltip knows nothing
// about would answer a hover with nothing. Those visitors are still in the whole board's count.
export function worldRepos(rows, visitors = null) {
  const seen = new Set();
  const map = new Map();
  for (const s of Array.isArray(rows) ? rows : []) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id || seen.has(s.id)) continue;
    if (!placeForLane(s.lane)) continue;
    seen.add(s.id);
    const key = repoKeyOf(s);
    let entry = map.get(key);
    if (!entry) {
      entry = { repo: key, count: 0, lanes: {}, reviews: 0 };
      map.set(key, entry);
    }
    entry.count += 1;
    entry.lanes[s.lane] = (entry.lanes[s.lane] || 0) + 1;
  }
  if (visitors) for (const [key, n] of visitorsByRepo(visitors)) {
    const entry = map.get(key);
    if (entry) entry.reviews += n;
  }
  const order = [...map.keys()].filter((k) => k !== NO_REPO_KEY).sort();
  if (map.has(NO_REPO_KEY)) order.push(NO_REPO_KEY);
  return order.map((k) => map.get(k));
}

// The rows of one island, for a list that has to agree with what is on screen.
export function worldRowsFor(rows, repo) {
  const list = Array.isArray(rows) ? rows : [];
  if (typeof repo !== 'string') return list.slice();
  return list.filter((s) => s && typeof s === 'object' && repoKeyOf(s) === repo);
}

// Which mode a board starts in when nobody has chosen yet: one repo holding most of the sessions starts in one
// village, an even spread starts in the world.
export function defaultMode(rows) {
  const repos = worldRepos(rows);
  const total = repos.reduce((sum, r) => sum + r.count, 0);
  if (repos.length < 2 || total <= 0) return 'village';
  return Math.max(...repos.map((r) => r.count)) / total >= MODE_SHARE ? 'village' : 'world';
}

// The world map is a grid of cells, one island per cell, so nothing can reach into another island's room: an
// island, its name board and its badges all stay inside their own cell, and the cells tile the canvas inside
// `margin`. Size follows the session count on a log scale between `ryMin` and whatever the cell allows.
export const WORLD = Object.freeze({
  margin: 40, // clear of the canvas edge
  pad: 12, // inside a cell, so two neighbouring islands never touch
  gap: 12, // the island's shallow ring to its name board
  aspect: 1.2, // rx / ry
  ryMin: 26,
  // A crowded map cannot give a one-session repo the full 26 and still make a 246-session one look bigger, so the
  // floor gives way with the ceiling and size keeps carrying its meaning however many repos there are.
  ryMinRatio: 0.55,
  ryMax: 200, // one repo should not fill the whole sea
  halo: 14, // the shallow-water ring, the outermost thing an island draws
  signH: 48,
  signMinH: 30,
  signMax: 260,
  ryFloor: 12, // past about 64 repos the name board gives way rather than the island going to nothing
  badgeR: 9,
  badgeGap: 7,
  digitW: 8, // an upper bound on a 700 12px digit, so the badge row's width is a pure number
});

// The badge row inside an island's name board: a disc and a count per lane that has one, scaled down as one row if
// three-digit counts make it wider than the board or the board is too short for a full-size disc. `dx` and `textX`
// are offsets from the row's left edge. A lane is never dropped to make room: that is the count you must not miss.
//
// The reviews badge comes last and is fitted around the lanes rather than with them, so a review arriving never
// shrinks a Blocked numeral that had room: it takes its count where the row has space beside the lanes, then its
// disc alone (`glyphOnly`, the count is in the island's tooltip), and only on a row the lanes already fill does it
// cost them anything, and then only the width of that bare disc. It is never dropped: the map exists so that
// nothing waiting on you hides.
export function worldBadgeRow(lanes, maxW, maxH = Infinity, reviews = 0) {
  const disc = WORLD.badgeR * 2;
  const wanted = [];
  const cellFor = (lane, raw) => {
    const n = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
    return n > 0 ? { lane, n, w: disc + 3 + String(n).length * WORLD.digitW } : null;
  };
  for (const lane of WORLD_BADGE_LANES) {
    const c = cellFor(lane, lanes && typeof lanes === 'object' ? lanes[lane] : 0);
    if (c) wanted.push(c);
  }
  const review = cellFor(REVIEWS, reviews);
  if ((!wanted.length && !review) || !(maxW > 0) || !(maxH > 0)) return { k: 1, w: 0, cells: [] };
  const span = (list) => list.reduce((sum, c) => sum + c.w, 0) + (list.length - 1) * WORLD.badgeGap;
  const fit = (list) => {
    const full = span(list);
    return Math.min(full > maxW ? maxW / full : 1, disc > maxH ? maxH / disc : 1);
  };
  let row = wanted;
  let k = wanted.length ? fit(wanted) : 1;
  if (review) {
    const bare = { ...review, w: disc, glyphOnly: true };
    const fits = (c) => (span(wanted) + WORLD.badgeGap + c.w) * k <= maxW + 1e-9;
    if (!wanted.length) {
      row = [review];
      k = fit(row);
    } else if (fits(review)) row = [...wanted, review];
    else if (fits(bare)) row = [...wanted, bare];
    else {
      row = [...wanted, bare];
      k = fit(row);
    }
  }
  let x = 0;
  const cells = row.map((c) => {
    const w = c.w * k;
    const cell = { lane: c.lane, n: c.n, dx: x, w, r: WORLD.badgeR * k, textX: x + (disc + 3) * k };
    if (c.glyphOnly) cell.glyphOnly = true;
    x += w + WORLD.badgeGap * k;
    return cell;
  });
  return { k, w: Math.max(0, x - WORLD.badgeGap * k), cells };
}

// Lays out `worldRepos` output. Each island gets `cell` (its own room, which no other island enters), `sign` (the
// name board and badge row) and `box` (everything it draws, sand halo and board together).
export function worldLayout(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === 'object' && typeof e.repo === 'string');
  const n = list.length;
  if (!n) return [];
  const area = { x: WORLD.margin, y: WORLD.margin, w: W - WORLD.margin * 2, h: H - WORLD.margin * 2 };
  const cols = Math.min(n, Math.max(1, Math.ceil(Math.sqrt((n * area.w) / area.h))));
  const rows = Math.ceil(n / cols);
  const cellW = area.w / cols;
  const cellH = area.h / rows;
  const signW = Math.max(0, Math.min(cellW - WORLD.pad * 2, WORLD.signMax));
  let signH = clamp(cellH * 0.3, WORLD.signMinH, WORLD.signH);
  // A short cell cannot hold a full board and a readable island: the board gives way, since an island that has gone
  // to nothing cannot be clicked at all.
  const roomFor = (h) => (cellH - WORLD.pad * 2 - WORLD.gap - h) / 2 - WORLD.halo;
  if (roomFor(signH) < WORLD.ryFloor) signH = Math.max(0, cellH - WORLD.pad * 2 - WORLD.gap - (WORLD.ryFloor + WORLD.halo) * 2);
  const blockH = signH + WORLD.gap;
  const fits = Math.min(WORLD.ryMax, roomFor(signH), (cellW - WORLD.pad * 2) / 2 / WORLD.aspect - WORLD.halo);
  // The floor keeps a small island clickable, but it gives up the cell's padding before it would push an island
  // into its neighbour's cell: two islands touching is a crowded map, two overlapping is a broken one.
  const spare = Math.max(1, Math.min((cellH - WORLD.gap - signH) / 2, cellW / 2 / WORLD.aspect) - WORLD.halo);
  const ryMax = Math.max(Math.min(WORLD.ryFloor, spare), fits);
  const ryMin = Math.min(WORLD.ryMin, ryMax * WORLD.ryMinRatio);
  const span = Math.log1p(Math.max(1, ...list.map((e) => (Number.isFinite(e.count) && e.count > 0 ? e.count : 0))));
  return list.map((entry, i) => {
    const rowIndex = Math.floor(i / cols);
    const inRow = Math.min(cols, n - rowIndex * cols);
    const cellX = area.x + (area.w - inRow * cellW) / 2 + (i - rowIndex * cols) * cellW;
    const cellY = area.y + rowIndex * cellH;
    const count = Number.isFinite(entry.count) && entry.count > 0 ? Math.round(entry.count) : 0;
    const k = span > 0 ? clamp(Math.log1p(count) / span, 0, 1) : 1;
    const ry = ryMin + (ryMax - ryMin) * k;
    const rx = ry * WORLD.aspect;
    const stackH = (ry + WORLD.halo) * 2 + blockH;
    const y0 = cellY + WORLD.pad + (cellH - WORLD.pad * 2 - stackH) / 2;
    const cx = cellX + cellW / 2;
    const signY = y0 + (ry + WORLD.halo) * 2 + WORLD.gap;
    const sign = [cx - signW / 2, signY, signW, signH];
    // A board too short for a name gives the name up rather than the badges, and one with no height at all gives
    // up both: the island itself is the last thing to go, since a board is no use if it cannot be clicked.
    const nameH = signH >= 40 ? 24 : 0;
    const bandTop = Math.min(nameH + 2, Math.max(0, signH - 2));
    const bandH = Math.max(0, signH - bandTop - 2);
    const box = [
      Math.min(cx - rx - WORLD.halo, sign[0]), y0,
      Math.max(rx + WORLD.halo, signW / 2) * 2, signY + signH - y0,
    ];
    return {
      repo: entry.repo, id: islandHoverId(entry.repo), label: worldLabel(entry.repo), count,
      lanes: entry.lanes && typeof entry.lanes === 'object' ? entry.lanes : {},
      reviews: Number.isFinite(entry.reviews) && entry.reviews > 0 ? Math.round(entry.reviews) : 0,
      cx, cy: y0 + ry + WORLD.halo, rx, ry, halo: WORLD.halo,
      cell: [cellX, cellY, cellW, cellH], sign, box,
      nameBox: nameH ? [sign[0] + 8, signY, signW - 16, nameH] : null,
      badges: [sign[0] + 8, signY + bandTop, signW - 16, bandH],
    };
  });
}

// The island under a point: inside its sand and shallow ring, or on its name board. The open sea between islands
// answers nothing, so a click out there does not wander into the nearest island.
//
// Measured against the coastline that is painted, not against the ellipse it is drawn inside. The shallow ring is
// the wobble scaled to (rx + halo, ry + halo) and the wobble dips to about 0.79, so the ellipse is a strict
// superset of the island: a pointer on plain deep water named an island and lit its ring up to 45 px away.
export function worldHit(islands, p) {
  if (!p || !Array.isArray(islands)) return null;
  for (const is of islands) {
    const dx = (p.x - is.cx) / (is.rx + is.halo);
    const dy = (p.y - is.cy) / (is.ry + is.halo);
    const d = Math.hypot(dx, dy);
    // The ellipse first, so the wobble is only looked up for the island the pointer is anywhere near: on a
    // 240-repo map this is one cached lookup a pointer move rather than 240.
    if (d <= 1 && d <= wobbleFactorAt(is, dx, dy, d)) return is;
    const [sx, sy, sw, sh] = is.sign;
    if (p.x >= sx && p.x <= sx + sw && p.y >= sy && p.y <= sy + sh) return is;
  }
  return null;
}

// ----- island art -----

// The shape and furniture of one island on the world map, all of it derived from the repo's own hash so an island
// keeps its coastline between visits, and all of it measured in the island's normalised space so no ring can leave
// the box `worldLayout` budgeted. The repo's colour is an accent (the shoreline rim, the flag and the roofs), never
// the ground: a filled disc of it read as a pie chart beside the hand-drawn village.
export const ISLAND_ART = Object.freeze({
  // Radial harmonics of the coastline. The amplitudes sum to 1, so the sum is normalised before `amp` scales it.
  harmonics: Object.freeze([[2, 0.4], [3, 0.3], [5, 0.19], [7, 0.11]]),
  amp: 0.13,
  // Points around the coast. Scaled with the island, so a 38 px island on a crowded map is not paying for a
  // hundred-point path: at 20 points its chords are about 6 px, which at that size reads as a coastline.
  steps: Object.freeze({ min: 20, max: 112, per: 0.95 }),
  beach: Object.freeze({ ratio: 0.2, min: 3.2, max: 26 }), // sand between the waterline and the grass
  wet: 3,
  foam: 6,
  shade: Object.freeze({ ratio: 0.09, min: 1.2, max: 8 }), // the darker rim inside the grass
  // The coloured tideline. Thin on purpose: at 5.5% of the radius it read as a highlighter traced round the
  // island rather than as a shore, and it was the loudest thing on the map.
  rim: Object.freeze({ ratio: 0.024, min: 1, max: 3.5 }),
  // Two numbers with a failure each behind them. A mast of 0.7 put the banner up where the island is narrow, so
  // the loudest thing on the map flew entirely over open water; a banner 86% of its own mast read as a colour
  // swatch beside the numeral. `notch` is the swallowtail's depth as a share of the width, and it cuts half of it.
  flag: Object.freeze({ mast: 0.5, mastMin: 12, mastMax: 84, band: 0.2, bandMin: 7, bandMax: 34, aspect: 1.6, notch: 0.24 }),
  // What stands on an island, by session count: each number is the count that feature first appears at.
  counts: Object.freeze({ jetty: 2, rock2: 3, hut1: 4, rock3: 10, hut2: 12, hut3: 40, lighthouse: 60 }),
  // And by how big it is drawn: an island with no room for a building shows a bare rock, whatever its count.
  sizes: Object.freeze({ jetty: 20, rock2: 20, rock3: 27, hut1: 26, hut2: 34, hut3: 44, lighthouse: 44 }),
  // Fixed anchors in grass units from the centre, so two features cannot collide by an unlucky seed. The seed only
  // mirrors them and jitters each by `jitter`, which is small enough that the clearance pass stays the exception.
  anchors: Object.freeze({
    flag: Object.freeze([0.46, 0.3]),
    // Clear of hut3's box even when a bay pulls it inwards: at -0.26 the tower failed the coast at pull 1, cleared
    // it at 0.86, landed on hut3 and was dropped, so a 150-session repo lost its lighthouse while a 60-session one
    // kept it. The queue commits to the first coast-passing pull, so a clash there is final.
    lighthouse: Object.freeze([-0.6, -0.34]),
    hut1: Object.freeze([-0.32, -0.5]),
    hut2: Object.freeze([0.34, -0.54]),
    hut3: Object.freeze([-0.56, 0.06]),
    rock1: Object.freeze([-0.3, 0.86]),
    // Not 0.52: that is the jetty's own spot, and the jetty is both placed first and drawn downwards from its
    // anchor, so the second rock clashed with the planks on every island that had a jetty and the third never
    // appeared at all.
    rock2: Object.freeze([0.2, 0.72]),
    rock3: Object.freeze([-0.72, 0.44]),
    jetty: Object.freeze([0.5, 0.66]),
  }),
  jitter: 0.035,
  // A feature outside the coast is pulled towards the middle in these steps before it is given up on, so a big
  // island keeps its village instead of losing it to a deep bay.
  pull: Object.freeze([1, 0.86, 0.72, 0.58]),
});

export function islandBeach(ry) {
  const b = ISLAND_ART.beach;
  return clamp((Number(ry) || 0) * b.ratio, b.min, b.max);
}

export function islandSteps(ry) {
  const s = ISLAND_ART.steps;
  return Math.round(clamp((Number(ry) || 0) * s.per, s.min, s.max));
}

// The coastline's radius factor at `steps` evenly spaced angles. It peaks at exactly 1 and never exceeds it, which
// is what keeps every ring inside the ellipse the layout budgeted while still letting the wobble bite: subtracting
// the sampled maximum rather than biasing the whole curve means no repo is systematically smaller than another, so
// size still follows the session count alone.
const wobbleCache = new Map();

// LRU off a Map's own insertion order: a hit is re-inserted at the end, and an insert past the cap drops the
// oldest key instead of clearing the lot. The wholesale clear these caches had made the page sawtooth, because
// the scene key carries the session count and the island's place, so one repo's count moving mints a new key for
// every island on the board: minutes of polling to the cap, then a 70 MB step down.
const CACHE_CAP = 512;

function cached(map, key, make) {
  const hit = map.get(key);
  if (hit !== undefined) {
    map.delete(key);
    map.set(key, hit);
    return hit;
  }
  const made = make();
  map.set(key, made);
  while (map.size > CACHE_CAP) map.delete(map.keys().next().value);
  return made;
}

export function islandWobble(repo, steps) {
  const n = Math.max(8, Math.round(Number(steps)) || 8);
  const name = typeof repo === 'string' ? repo : '';
  return cached(wobbleCache, `${n}|${name}`, () => buildWobble(name, n));
}

function buildWobble(name, n) {
  const seed = repoHash(name);
  const phases = ISLAND_ART.harmonics.map((_, i) => (((seed >>> (i * 5)) % 1024) / 1024) * TAU);
  const out = new Float64Array(n);
  let top = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    let f = 0;
    for (let j = 0; j < ISLAND_ART.harmonics.length; j++) {
      const [k, amp] = ISLAND_ART.harmonics[j];
      f += amp * Math.cos(k * a + phases[j]);
    }
    out[i] = f;
    if (f > top) top = f;
  }
  for (let i = 0; i < n; i++) out[i] = 1 - ISLAND_ART.amp * (top - out[i]);
  return out;
}

// The coastline's radius factor at one already-normalised offset, which is the lookup `insideCoast` and `worldHit`
// both do. `d` is passed in where the caller has it: at the centre any angle will do, so 1 keeps the centre inside.
export function wobbleFactorAt(is, dx, dy, d = Math.hypot(dx, dy)) {
  if (d === 0) return 1;
  const w = islandWobble(is.repo, islandSteps(is.ry));
  let a = Math.atan2(dy, dx);
  if (a < 0) a += TAU;
  return w[Math.round((a / TAU) * w.length) % w.length];
}

// One ring of an island as [x, y] pairs: the coast grown (or inset) by `inflate`. The wobble is applied in
// normalised space, so a ring is always inside the ellipse (rx + inflate, ry + inflate) whatever the shape does.
export function islandCoast(is, inflate = 0, steps = null) {
  if (!is) return [];
  const n = steps ? Math.max(8, Math.round(steps)) : islandSteps(is.ry);
  const w = islandWobble(is.repo, n);
  const rx = Math.max(0.2, is.rx + inflate);
  const ry = Math.max(0.2, is.ry + inflate);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    pts.push([is.cx + Math.cos(a) * rx * w[i], is.cy + Math.sin(a) * ry * w[i]]);
  }
  return pts;
}

// What an island would show if everything fitted: the count decides, and the drawn size caps it, so a small island
// falls back towards a bare rock however many sessions the repo holds. `islandScene` reports what actually fitted.
export function islandFeatures(count, ry) {
  const n = Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
  const r = Number(ry) || 0;
  const C = ISLAND_ART.counts;
  const S = ISLAND_ART.sizes;
  const byCount = n >= C.hut3 ? 3 : n >= C.hut2 ? 2 : n >= C.hut1 ? 1 : 0;
  const bySize = r >= S.hut3 ? 3 : r >= S.hut2 ? 2 : r >= S.hut1 ? 1 : 0;
  return {
    // Rocks carry a size gate of their own as well as a count: without one, whether a pebble found room on a tiny
    // island came down to that repo's own coastline, so two repos in the same size band differed by session count
    // in the wrong direction.
    rocks: Math.min(n >= C.rock3 ? 3 : n >= C.rock2 ? 2 : 1, r >= S.rock3 ? 3 : r >= S.rock2 ? 2 : 1),
    jetty: n >= C.jetty && r >= S.jetty,
    huts: Math.min(byCount, bySize),
    lighthouse: n >= C.lighthouse && r >= S.lighthouse,
  };
}

// The flag on an island's high ground: the one accent that is there at every size, so a repo with a single session
// is still matchable to its legend swatch. Clamped so the banner stays inside the layout's box, and it flies
// towards the middle of the island so it cannot reach out sideways.
export function islandFlag(is, numeral = null) {
  if (!is) return null;
  const F = ISLAND_ART.flag;
  const seed = repoHash(typeof is.repo === 'string' ? is.repo : '');
  const beach = islandBeach(is.ry);
  const gx = Math.max(1, is.rx - beach);
  const gy = Math.max(1, is.ry - beach);
  const [ax, ay] = ISLAND_ART.anchors.flag;
  const side = seed & 1 ? 1 : -1;
  // The mast stands clear of the numeral and the banner flies outward from it, which is what keeps the one
  // unconditional accent off the one unconditional piece of text at every size, without moving either.
  const clear = numeral ? (numeral.box[2] / 2 + 3) / gx : 0;
  const fx = is.cx + side * clamp(Math.max(ax, clear), 0, 0.94) * gx;
  const fy = is.cy + ay * gy;
  const top = is.cy - is.ry - is.halo;
  let mast = clamp(is.ry * F.mast, F.mastMin, F.mastMax);
  mast = Math.max(2, Math.min(mast, fy - top - 1));
  const bandH = Math.max(2, Math.min(clamp(is.ry * F.band, F.bandMin, F.bandMax), mast * 0.9));
  // Measured to the painted waterline, not to `is.rx`: the coast is the wobble scaled to the ellipse and dips
  // about 21% inside it, so a banner bounded by the radius flew past the water's edge. The factor is never above
  // 1, so this is strictly tighter than the ellipse and the box guarantee is untouched.
  const reach = is.rx * wobbleFactorAt(is, (fx - is.cx) / is.rx, (fy - is.cy) / is.ry);
  const room = side > 0 ? is.cx + reach - (fx + 1) : fx - 1 - (is.cx - reach);
  const bandW = Math.max(2, Math.min(bandH * F.aspect, room));
  // `band` is the drawn banner's own box, mast edge to flying edge, so the area and every clearance check are
  // measured on the polygon that is painted rather than on a rectangle it is not.
  let tail = side > 0 ? fx + 1 + bandW : fx - 1 - bandW;
  let band = [Math.min(fx, tail), fy - mast, Math.abs(tail - fx), bandH];
  // A numeral wider than the island it stands on leaves no room beside it, so there the banner goes above it on a
  // longer mast rather than beside it. Bounded by the box, which is the one thing the banner may never leave.
  if (numeral && boxesOverlap(band, numeral.box)) {
    mast = Math.min(fy - top - 1, Math.max(mast, fy - numeral.box[1] + bandH + 2));
    band = [band[0], fy - mast, band[2], bandH];
  }
  // An island too narrow to hold the numeral and the flag side by side clamps that sideways clearance away and
  // puts the shaft back inside the digits, where a 1 px brown line under a glyph is a 2.65:1 pair. There the
  // shaft is drawn from the numeral's top instead, so the pole reads as standing behind the digits. Only the
  // banner had a fallback before, and the shaft is what crossed the glyphs.
  const top0 = fy - mast;
  let base = fy;
  if (numeral && boxesOverlap([fx - 1, top0, 2, mast], numeral.box)) base = clamp(numeral.box[1] - 1, top0, fy);
  const mastBox = [fx - 1, top0, 2, base - top0];
  return { x: fx, y: fy, base, mast, dir: side, tail, band, mastBox, boxes: [band, mastBox] };
}

// The whole of one island's drawing, geometry only: the rings, the furniture that fitted, the accent and the
// numeral's own box. The draw uses exactly this, so a check that measures it measures what is painted. Cached per
// repo, size and count, because the map redraws every island on every ambient frame.
const sceneCache = new Map();

export function islandScene(is) {
  if (!is) return null;
  const key = `${is.repo}|${rnd3(is.rx)}|${rnd3(is.ry)}|${rnd3(is.cx)}|${rnd3(is.cy)}|${is.count}`;
  const hit = sceneCache.get(key);
  if (hit) {
    sceneCache.delete(key);
    sceneCache.set(key, hit);
    return hit;
  }
  const beach = islandBeach(is.ry);
  const shade = clamp(is.ry * ISLAND_ART.shade.ratio, ISLAND_ART.shade.min, ISLAND_ART.shade.max);
  const rim = clamp(is.ry * ISLAND_ART.rim.ratio, ISLAND_ART.rim.min, ISLAND_ART.rim.max);
  const gx = Math.max(1, is.rx - beach);
  const gy = Math.max(1, is.ry - beach);
  const seed = repoHash(typeof is.repo === 'string' ? is.repo : '');
  const mirror = seed & 1 ? 1 : -1;
  const at = (name, i, pull) => {
    const [ax, ay] = ISLAND_ART.anchors[name];
    const j = ISLAND_ART.jitter;
    const jx = ((((seed >>> (i * 3 + 1)) % 32) / 32) * 2 - 1) * j;
    const jy = ((((seed >>> (i * 3 + 2)) % 32) / 32) * 2 - 1) * j;
    return [is.cx + (ax * mirror + jx) * gx * pull, is.cy + (ay + jy) * gy * pull];
  };
  const font = Math.round(clamp(is.ry * 0.42, 13, 40));
  const numW = String(is.count).length * font * 0.62;
  // Cap height and a margin, not a whole em: digits carry no descender, and an em-tall box on a small island
  // crowds the huts out of space nothing is drawn in. The 13 px floor a crowded map runs on is unchanged.
  const numeral = { font, x: is.cx, y: is.cy + 1, box: [is.cx - numW / 2, is.cy + 1 - font * 0.44, numW, font * 0.88] };
  const want = islandFeatures(is.count, is.ry);

  // Every candidate in the order its session count unlocks it, so a bigger repo only ever adds to a smaller one's
  // island: a later item can be dropped for want of room, an earlier one never is.
  const queue = [];
  const rockR = clamp(is.ry * 0.11, 1.8, 15);
  const hutW = clamp(is.ry * 0.22, 8, 44);
  const hutH = hutW * 0.6;
  const roofH = hutW * 0.42;
  // The rock is the floor of the silhouette, so it is placed whatever else is in the way: a pebble on the beach
  // under a numeral or a mast is invisible, and an island with nothing on it at all reads as a bug.
  queue.push(['rock', 'rock1', 0, true]);
  if (want.jetty) queue.push(['jetty', 'jetty', 1]);
  if (want.rocks >= 2) queue.push(['rock', 'rock2', 2]);
  if (want.huts >= 1) queue.push(['hut', 'hut1', 3]);
  if (want.rocks >= 3) queue.push(['rock', 'rock3', 4]);
  if (want.huts >= 2) queue.push(['hut', 'hut2', 5]);
  if (want.huts >= 3) queue.push(['hut', 'hut3', 6]);
  if (want.lighthouse) queue.push(['light', 'lighthouse', 7]);

  const flag = islandFlag(is, numeral);
  const taken = [numeral.box, ...flag.boxes];
  const huts = [];
  const rocks = [];
  let jetty = null;
  let lighthouse = null;
  for (const [kind, anchor, i, must] of queue) {
    const dims = { rockR, hutW, hutH, roofH, beach, seed, i };
    let item = null;
    for (const pull of ISLAND_ART.pull) {
      const [x, y] = at(anchor, i, pull);
      const made = shapeAt(kind, x, y, is, dims);
      // A building is held to the sand rather than to the grass: a roof overhanging its own beach reads fine, a
      // roof over open water does not. The jetty and the rocks are the two things meant to be at the waterline.
      if (kind === 'jetty' || insideCoast(is, made.box, kind === 'rock' ? 0 : beach * 0.4)) {
        item = made;
        break;
      }
    }
    if (!item && must) {
      const [x, y] = at(anchor, i, ISLAND_ART.pull[ISLAND_ART.pull.length - 1]);
      item = shapeAt(kind, x, y, is, dims);
    }
    // Dropped rather than nudged sideways: a nudge would have to be re-checked against everything else, and an
    // island out of room reads better one feature short than with two things touching.
    if (!item || (!must && taken.some((b) => boxesOverlap(item.box, b)))) continue;
    taken.push(item.box);
    if (kind === 'rock') rocks.push(item);
    else if (kind === 'hut') huts.push(item);
    else if (kind === 'jetty') jetty = item;
    else lighthouse = item;
  }

  const { steps, rings, dots, perimeter } = islandGround(is, beach, shade, rim, seed);
  const out = {
    steps, beach, shade, rim, gx, gy, rings, numeral, flag, huts, rocks, jetty, lighthouse, dots, perimeter,
    features: { rocks: rocks.length, huts: huts.length, jetty: !!jetty, lighthouse: !!lighthouse },
    accent: accentArea(rings.rim, rim, flag, huts),
  };
  sceneCache.set(key, out);
  while (sceneCache.size > CACHE_CAP) sceneCache.delete(sceneCache.keys().next().value);
  return out;
}

// The rings, the beach grit and the perimeter: everything about an island that follows its shape and its place
// but not its session count. Cached apart from the scene for exactly that reason. A ring set is the expensive
// part of a scene (eight paths of up to 112 points), and a poll in which one repo's count moves changes the
// scene key of every island on the board while changing no island's ground at all.
const groundCache = new Map();

function islandGround(is, beach, shade, rim, seed) {
  const steps = islandSteps(is.ry);
  const key = `${is.repo}|${rnd3(is.rx)}|${rnd3(is.ry)}|${rnd3(is.cx)}|${rnd3(is.cy)}|${rnd3(is.halo)}`;
  return cached(groundCache, key, () => {
    const rings = {
      shallow: islandCoast(is, is.halo, steps),
      ring: islandCoast(is, is.halo - 1.5, steps),
      foam: islandCoast(is, ISLAND_ART.foam, steps),
      wet: islandCoast(is, ISLAND_ART.wet, steps),
      sand: islandCoast(is, 0, steps),
      // The coloured tideline is stroked just inside the waterline rather than on it: centred on the sand's own
      // edge, half of a 7 px rim covers the 3 px wet sand and bleeds into the foam, and the beach stops reading.
      rim: islandCoast(is, -rim / 2, steps),
      shade: islandCoast(is, -beach, steps),
      grass: islandCoast(is, -beach - shade, steps),
    };
    // Shell grit along the beach, seeded so it does not crawl between frames. Computed here rather than in the
    // draw because the map repaints every island on every ambient frame and a per-frame generator would allocate.
    const rand = mulberry32(seed ^ 0x9e3779b9);
    const dots = [];
    const dotN = Math.round(clamp(is.ry * 0.28, 3, 26));
    const dotW = islandWobble(is.repo, steps);
    for (let i = 0; i < dotN; i++) {
      const a = rand() * TAU;
      // The inward step is a fraction of the radius at this angle, because the sand band is not a fraction of
      // the radius: it is `beach` px wide everywhere, which is beach/ry of the radius in y and only beach/rx in
      // x. A flat beach/ry step put a fifth of the grit inside the grass boundary, to be painted over by it.
      const k = 1 - (rand() * beach) / Math.max(1, Math.hypot(Math.cos(a) * is.rx, Math.sin(a) * is.ry));
      const j = Math.round((a / TAU) * steps) % steps;
      dots.push([is.cx + Math.cos(a) * is.rx * dotW[j] * k, is.cy + Math.sin(a) * is.ry * dotW[j] * k,
        clamp(is.ry * 0.012, 0.5, 1.9) * (0.7 + rand() * 0.7)]);
    }
    return { steps, rings, dots, perimeter: polyPerimeter(rings.sand) };
  });
}

// Both island caches, for `destroy`: a page that switches away from the world map was holding every ring set and
// every scene it had ever drawn.
export function clearIslandCaches() {
  wobbleCache.clear();
  groundCache.clear();
  sceneCache.clear();
}

const rnd3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

// One piece of furniture at a point, with the box it paints. Split out so the placement loop can try a point,
// measure it against the coast and try again closer in without knowing what kind of thing it is holding.
function shapeAt(kind, x, y, is, d) {
  if (kind === 'rock') {
    const r = d.rockR * (0.7 + (((d.seed >>> (d.i + 9)) % 16) / 16) * 0.6);
    return { x, y, rx: r, ry: r * 0.72, box: [x - r, y - r * 0.72, r * 2, r * 1.44] };
  }
  if (kind === 'hut') {
    return { x, y, w: d.hutW, h: d.hutH, roof: d.roofH, box: [x - d.hutW / 2, y - d.hutH - d.roofH, d.hutW, d.hutH + d.roofH] };
  }
  if (kind === 'jetty') {
    const w = clamp(is.ry * 0.1, 3, 14);
    const len = d.beach * 0.7 + clamp(is.ry * 0.1, 3, 15);
    return { x, y, w, len, box: [x - w / 2, y, w, len] };
  }
  const w = clamp(is.ry * 0.13, 4, 20);
  const h = w * 2.2;
  return { x, y, w, h, box: [x - w / 2, y - h, w, h] };
}

function polyPerimeter(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return sum;
}

// The area the repo's own colour covers, in square logical px: the shoreline rim, the flag's banner and one roof
// per hut. Reported so "you can still match an island to its legend swatch" is a number rather than a hope.
function accentArea(sand, rim, flag, huts) {
  const shore = polyPerimeter(sand) * rim;
  // `sand` here is the ring the rim is stroked on, so the area is its own perimeter times the line width.
  const banner = flag ? flag.band[2] * flag.band[3] * (1 - ISLAND_ART.flag.notch / 2) : 0;
  const roofs = huts.reduce((sum, h) => sum + (h.w * h.roof) / 2, 0);
  return { shore, banner, roofs, total: shore + banner + roofs };
}

// Whether a box sits inside the island's grass, measured against the coast itself rather than its ellipse: a bay
// can cut well inside the ellipse, and a hut standing in one would be painted over open water.
function insideCoast(is, box, beach) {
  const rx = Math.max(0.2, is.rx - beach);
  const ry = Math.max(0.2, is.ry - beach);
  for (const [x, y] of [[box[0], box[1]], [box[0] + box[2], box[1]], [box[0], box[1] + box[3]], [box[0] + box[2], box[1] + box[3]]]) {
    const dx = (x - is.cx) / rx;
    const dy = (y - is.cy) / ry;
    const d = Math.hypot(dx, dy);
    if (d > wobbleFactorAt(is, dx, dy, d)) return false;
  }
  return true;
}

// ----- size by output tokens -----

// A character's size follows its output tokens including subagents, on a log scale: 1k or fewer is the smallest, 30M
// or more the largest. A row without a token block keeps the plain size.
export const TOKEN_SCALE = Object.freeze({ min: 0.85, max: 1.5, floor: 1e3, ceil: 3e7 });

const tokenCount = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function outputTokens(row) {
  const t = row && typeof row === 'object' ? row.tokens : null;
  if (!t || typeof t !== 'object') return null;
  const sub = t.subagents && typeof t.subagents === 'object' ? t.subagents.output : 0;
  return tokenCount(t.output) + tokenCount(sub);
}

export function tokenScale(row) {
  const out = outputTokens(row);
  if (out === null) return 1;
  const lo = Math.log10(TOKEN_SCALE.floor);
  const hi = Math.log10(TOKEN_SCALE.ceil);
  const f = Math.min(1, Math.max(0, (Math.log10(Math.max(out, 1)) - lo) / (hi - lo)));
  return Math.round((TOKEN_SCALE.min + (TOKEN_SCALE.max - TOKEN_SCALE.min) * f) * 1000) / 1000;
}

// Where a place is: the island is reached by boat, everything else by road.
export function areaForPlace(place) {
  return place === 'beach' || place === 'castle' ? 'island' : 'land';
}

// Places whose rows are inside, reached by walking to a door and fading through it: the sand castle on the island
// and the cottages on land. Each has an interior scene of its own (INTERIORS).
export const ROOM_PLACES = Object.freeze(['castle', 'cottages']);
export function isRoomPlace(place) {
  return place === 'castle' || place === 'cottages';
}

const PLATED_LANES = new Set(['needs_you', 'errored', 'your_turn']);
const SITTING_LANES = new Set(['errored', 'your_turn', 'idle', 'recent']);
const SIPPING_LANES = new Set(['valhalla', 'castle']);

export function alwaysShowsPlate(lane) {
  return PLATED_LANES.has(lane);
}

// What a character does once it has arrived. Both porch lanes share the place: only needs_you waves under the
// orange light column, and your_turn rocks calmly on a swing.
const POSES = new Map();
export function poseOf(lane) {
  if (!POSES.has(lane)) {
    POSES.set(lane, Object.freeze({
      waves: lane === 'needs_you',
      lightColumn: lane === 'needs_you',
      swings: lane === 'your_turn',
      sits: SITTING_LANES.has(lane),
    }));
  }
  return POSES.get(lane);
}

const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

export function sanitizeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(INVISIBLE_RE, ' ').replace(/\s+/g, ' ').trim();
}

export function truncateText(value, max = NAME_MAX) {
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  return chars.slice(0, Math.max(1, max - 1)).join('').trimEnd() + '\u2026';
}

export function plateText(session, privacy) {
  const title = sanitizeText(session && session.title);
  if (!privacy && title) return truncateText(title);
  const shortId = sanitizeText(session && session.shortId);
  if (session && session.kind === 'cli') return truncateText(shortId || 'session');
  const repo = sanitizeText(session && session.repo);
  const worktree = sanitizeText(session && session.worktree);
  // Worktree first: nearly every session shares one repo, and a narrow plate keeps only its start.
  const where = repo && worktree ? `${worktree} \u00b7 ${repo}` : worktree || repo;
  return truncateText(where || shortId || 'session');
}

// An older server labels the your_turn lane "Your turn", and the page once called it Unread. Either reads as the
// lane word, so a plate never repeats the lane as an extra label.
const YOUR_TURN_LABELS = new Set(['your turn', 'unread', 'needs input']);
export function plateLabel(session) {
  const label = sanitizeText(session && session.label);
  return YOUR_TURN_LABELS.has(label.toLowerCase()) ? STATE.your_turn.word : label;
}

export function waitClock(since, now) {
  if (!Number.isFinite(since) || since <= 0 || !Number.isFinite(now)) return '';
  const mins = Math.floor(Math.max(0, now - since) / 60000);
  if (mins < 1) return '<1 min';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ${mins % 60} min`;
  return `${Math.floor(hours / 24)} d`;
}

export function isEscalated(session, now) {
  return !!session && session.lane === 'needs_you' && Number.isFinite(session.since) && session.since > 0
    && now - session.since >= ESCALATE_MS;
}

// Places are what the signs name. The castle hall and the graveyard are placed by castleLayout and
// graveyardLayout; the cottage room by castleLayout too, on its own floor.
export const PLACES = Object.freeze({
  porch: {
    name: 'The Porch', lanes: ['needs_you', 'your_turn', 'errored', 'stopped'], sign: [906, 846],
    // Four badges alone would be a puzzle, so this board names its lanes: two to a line, hence a bigger box. It
    // leans against the porch rail rather than standing on a post, since a post that low runs off the canvas.
    words: true, signW: 312, signH: 86, post: false,
  },
  workshop: { name: 'The Workshop', lanes: ['running'], sign: [598, 286] },
  // The board stands on two posts above the cell block, the only band of the plot no badge ever reaches.
  jail: { name: 'The Jail', lanes: ['jail'], sign: [212, 73], signW: 108, post: false },
  cottages: { name: 'The Cottages', lanes: ['idle', 'recent'], sign: [1010, 150] },
  harbour: { name: 'The Harbour', lanes: ['open_pr'], sign: [1382, 80] },
  beach: { name: 'Valhalla beach', lanes: ['valhalla'], sign: [1180, 780] },
});

export const PLACE_KEYS = Object.freeze(Object.keys(PLACES));

// Spots are slot grids inside a place. rect is [x, y, w, h] of feet positions. dx/dy are preferred spacing,
// minDx/minDy the tightest spacing before characters are allowed to overlap. anchor is where the first arrival
// stands; slots fill outwards from it, a whole row before the next. keepRows spots always show plates: their rows
// stay at least minDy apart (a tall hatted character's badge plus a plate, about 132) and crowds narrow the columns
// instead, so a plate never covers the badge of the row below.
// The merged Porch's three spots share its rows, left to right: the steps (errored and stopped), the swings
// (needs input) and the door (blocked, filling from the lantern). Each gap leaves room for a swing post and keeps
// the orange door light away from the seats. The door starts 68 right of the swings, which is the frame's reach
// past its last seat plus the light's clip margin plus half a Blocked body, so the clip cannot cut a Blocked row
// even when both spots have spread to their edges. The anchors are on the front row, so it fills first.
//
// Nothing the Porch paints may rise above PORCH_CEILING, the road's lower edge (painted 38 wide about y 560) plus
// 2 px. The back row is as high as that allows: an escalated Blocked hopping at 1.5x paints its badge 153 above its
// feet. Slots and character boxes hold neither a swing frame (102 px tall as painted) nor the light column, so a
// row too near the road passes every slot check; only the harness's painted checks see it.
export const PORCH_CEILING = 581;
export const PORCH_ROWS = Object.freeze([734, 866]);
const PORCH_SPAN = PORCH_ROWS[PORCH_ROWS.length - 1] - PORCH_ROWS[0];
const PORCH_FRONT = PORCH_ROWS[PORCH_ROWS.length - 1];
export const SPOTS = Object.freeze({
  porch: {
    place: 'porch', lanes: ['needs_you'], rect: [466, PORCH_ROWS[0], 176, PORCH_SPAN], dx: 150, dy: 132,
    minDx: 56, minDy: 132, stagger: false, keepRows: true, anchor: [652, PORCH_FRONT],
  },
  swings: {
    place: 'porch', lanes: ['your_turn'], rect: [212, PORCH_ROWS[0], 186, PORCH_SPAN], dx: 150, dy: 132,
    minDx: 56, minDy: 132, stagger: false, keepRows: true, anchor: [398, PORCH_FRONT],
  },
  // The steps keep their columns 120 apart until they spread: errored and stopped plates are the ones you most need
  // to read.
  steps: {
    place: 'porch', lanes: ['errored', 'stopped'], rect: [30, PORCH_ROWS[0], 120, PORCH_SPAN], dx: 120, dy: 132,
    minDx: 120, minDy: 132, stagger: false, keepRows: true, anchor: [150, PORCH_FRONT],
  },
  workshop: {
    place: 'workshop', lanes: ['running'], rect: [548, 452, 600, 76], dx: 92, dy: 76, minDx: 56, minDy: 46,
    stagger: true, anchor: [860, 452],
  },
  // The jail yard. Its back row is at y 194 because a badge reaches 92 above the feet and the sign board above ends
  // at 100: a row any further back would put badges over the board. `dy` is the rect's whole depth, so the front row
  // stands at the fence whatever the crowd and the near bars always cross somebody; the anchor is below that front
  // row, so it fills before anyone stands at the back.
  jail: {
    place: 'jail', lanes: ['jail'], rect: [112, 194, 180, 52], dx: 60, dy: 52, minDx: 44, minDy: 52,
    stagger: false, anchor: [114, 256],
  },
  harbour: {
    place: 'harbour', lanes: ['open_pr'], rect: [1296, 224, 160, 84], dx: 62, dy: 52, minDx: 40, minDy: 42,
    stagger: true, anchor: [1442, 284],
  },
  // The castle, the palm and the jetty take bites out of the sand, so `allow` drops slots whose lounger would
  // stand on them.
  beach: {
    place: 'beach', lanes: ['valhalla'], rect: [1332, 792, 200, 60], dx: 76, dy: 52, minDx: 48, minDy: 45,
    stagger: true, anchor: [1394, 846], allow: (x, y) => beachAllows(x, y),
  },
});

export const SPOT_KEYS = Object.freeze(Object.keys(SPOTS));

function gridPoints(rx, ry, rw, rh, dx, dy, stagger) {
  const cols = Math.max(1, Math.floor(rw / dx + 1e-6) + 1);
  const rows = Math.max(1, Math.floor(rh / dy + 1e-6) + 1);
  const x0 = rx + (rw - (cols - 1) * dx) / 2;
  const y0 = ry + (rh - (rows - 1) * dy) / 2;
  const pts = [];
  for (let r = 0; r < rows; r++) {
    const shift = stagger && r % 2 === 1 && cols > 1 ? dx / 2 : 0;
    for (let c = 0; c < cols; c++) {
      const x = x0 + shift + c * dx;
      if (x > rx + rw + 1e-6) continue;
      pts.push({ x, y: y0 + r * dy });
    }
  }
  return pts;
}

const ROW_BIAS = 4;
// How narrow a keepRows spot's columns may get before its rows give way. Below a round body's 36, so a spread
// porch spot stands shoulder to shoulder on its two rows rather than squeezing in a third, whose plates would
// cover the badges of the row in front.
const KEEP_ROWS_MIN_DX = 30;

function nearestPoints(points, anchor, n) {
  const [ax, ay] = anchor;
  return points
    .map((p) => ({ p, d: Math.hypot(p.x - ax, (p.y - ay) * ROW_BIAS) }))
    .sort((a, b) => a.d - b.d || a.p.y - b.p.y || a.p.x - b.p.x)
    .slice(0, n)
    .map(({ p }) => ({ x: rnd2(p.x), y: rnd2(p.y) }));
}

function allowedPoints(spec, pts) {
  return typeof spec.allow === 'function' ? pts.filter((p) => spec.allow(p.x, p.y)) : pts;
}

// Slot centres for n characters in a spot. Index i is the i-th nearest slot to the anchor, so
// positions stay put while the spacing is unchanged.
export function slotGrid(spot, n) {
  const spec = typeof spot === 'string' ? (hasOwn(SPOTS, spot) ? SPOTS[spot] : null) : spot;
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (!spec) return { points: [], dx: 0, dy: 0, overflow: false };
  if (count === 0) return { points: [], dx: spec.dx, dy: spec.dy, overflow: false };
  const [rx, ry, rw, rh] = spec.rect;
  const steps = 6;
  for (let k = 0; k <= steps; k++) {
    const f = k / steps;
    const dx = spec.dx + (spec.minDx - spec.dx) * f;
    const dy = spec.dy + (spec.minDy - spec.dy) * f;
    const pts = allowedPoints(spec, gridPoints(rx, ry, rw, rh, dx, dy, spec.stagger));
    if (pts.length >= count) return { points: nearestPoints(pts, spec.anchor, count), dx, dy, overflow: false };
  }
  // Past the tightest spacing: spread evenly over the rect, choosing the column count that keeps the
  // worst gap (relative to the minimum spacing) as large as possible. Neighbours may overlap a little.
  const rowsFor = (cols) => {
    let rows = 0;
    let total = 0;
    while (total < count) {
      total += spec.stagger && rows % 2 === 1 ? cols - 1 : cols;
      rows += 1;
    }
    return rows;
  };
  const spread = (cols, rows) => {
    const dx = rw / (cols - 1);
    const dy = rows > 1 ? rh / (rows - 1) : 0;
    const pts = [];
    for (let r = 0; r < rows; r++) {
      const odd = spec.stagger && r % 2 === 1;
      const y = rows > 1 ? ry + r * dy : ry + rh / 2;
      for (let c = 0; c < (odd ? cols - 1 : cols); c++) pts.push({ x: rx + (odd ? dx / 2 : 0) + c * dx, y });
    }
    return allowedPoints(spec, pts);
  };
  let best = null;
  for (let cols = 2; cols <= count + 1; cols++) {
    let rows = rowsFor(cols);
    let pts = spread(cols, rows);
    // An allow rule drops some points, so add rows until enough remain.
    while (pts.length < count && spec.allow && rows < count * 4) pts = spread(cols, ++rows);
    if (pts.length < count) continue;
    const dx = rw / (cols - 1);
    const dy = rows > 1 ? rh / (rows - 1) : Infinity;
    const balanced = Math.min(dx / spec.minDx, dy / spec.minDy);
    const rowsKept = spec.keepRows && dy >= spec.minDy - 1e-6 && dx >= KEEP_ROWS_MIN_DX;
    const score = spec.keepRows ? (rowsKept ? 10 + dx / spec.minDx : balanced) : balanced;
    if (!best || score > best.score) best = { score, rows, dx, dy, pts };
  }
  if (!best) return slotGrid({ ...spec, allow: null }, count);
  const dy = best.rows > 1 ? best.dy : spec.minDy;
  return { points: nearestPoints(best.pts, spec.anchor, count), dx: best.dx, dy, overflow: true };
}

// Keeps a character's previous slot while it is still valid, then fills free slots in id order.
export function assignSlotIndices(ids, previous) {
  const n = ids.length;
  const taken = new Array(n).fill(false);
  const out = new Map();
  const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const id of sorted) {
    const p = previous ? previous.get(id) : undefined;
    if (Number.isInteger(p) && p >= 0 && p < n && !taken[p]) {
      taken[p] = true;
      out.set(id, p);
    }
  }
  let free = 0;
  for (const id of sorted) {
    if (out.has(id)) continue;
    while (taken[free]) free++;
    taken[free] = true;
    out.set(id, free);
  }
  return out;
}

// sessions: board rows. previous: Map id -> { place, spot, index } (a missing spot means the place's own spot).
// Returns Map id -> { place, spot, index, x, y, dx, dy, lane, cap } for the spots characters stand in, where cap is how
// far that place lets anyone grow (placeScaleCap). The castle and the graveyard are not among them: castleLayout and
// graveyardLayout place those.
export function layoutVillage(sessions, previous = new Map()) {
  const bySpot = new Map(SPOT_KEYS.map((k) => [k, []]));
  const laneOf = new Map();
  for (const s of sessions || []) {
    if (!s || typeof s.id !== 'string' || laneOf.has(s.id)) continue;
    const spot = spotForLane(s.lane);
    if (!spot || !bySpot.has(spot)) continue;
    laneOf.set(s.id, s.lane);
    bySpot.get(spot).push(s.id);
  }
  const out = new Map();
  const byPlace = new Map();
  for (const [spot, ids] of bySpot) {
    if (!ids.length) continue;
    const place = SPOTS[spot].place;
    const prev = new Map();
    for (const id of ids) {
      const p = previous.get(id);
      if (p && p.place === place && (p.spot === undefined ? place : p.spot) === spot) prev.set(id, p.index);
    }
    const indices = assignSlotIndices(ids, prev);
    const grid = slotGrid(spot, ids.length);
    if (!byPlace.has(place)) byPlace.set(place, []);
    for (const id of ids) {
      const index = indices.get(id);
      const pt = grid.points[index];
      const slot = { place, spot, index, x: pt.x, y: pt.y, dx: grid.dx, dy: grid.dy, lane: laneOf.get(id), cap: 1 };
      out.set(id, slot);
      byPlace.get(place).push(slot);
    }
  }
  for (const [place, slots] of byPlace) {
    const cap = placeScaleCap(place, slots);
    for (const slot of slots) slot.cap = cap;
  }
  return out;
}

// ----- the porch house, its lantern and the swings -----

// The house sits at the right of the porch band, a little clear of the shore. The lantern hangs from an arm on
// the post by the door, and the door crowd fills the slots to its left.
const HOUSE_DX = -246;
const LANTERN = { x: 982 + HOUSE_DX, y: 726 };
// What the porch crowd must keep clear of, as [x, y, w, h]: the lantern on its post, and the house with its deck.
export const PORCH_OBSTACLES = Object.freeze([
  [944 + HOUSE_DX, 698, 50, 136], [990 + HOUSE_DX, 604, 262, 243],
].map((r) => Object.freeze(r)));

// ----- porch swings -----

// Porch swings: the beam sits just below the plates of the row above, the seat lifts the sitter, and the "..." bubble
// only shows when the next sitter is far enough away not to be covered by it.
export const SWING_BEAM = 90;
export const SWING_POST = 36;
export const SWING_SEAT_HALF = 25;
export const SWING_LEG_SPREAD = 7;
const SWING_LIFT = 9;
const BUBBLE_MIN_DX = 76;

// The frame over one porch row: A-frame posts at both ends, and between two sitters wide enough apart for one.
export function swingFrame(xs, y) {
  const sorted = [...xs].sort((a, b) => a - b);
  const x0 = sorted[0] - SWING_POST;
  const x1 = sorted[sorted.length - 1] + SWING_POST;
  const posts = [x0, x1];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] >= 2 * (SWING_SEAT_HALF + SWING_LEG_SPREAD) + 36) posts.push((sorted[i] + sorted[i - 1]) / 2);
  }
  return { x0, x1, posts, beamY: y - SWING_BEAM };
}

// The left edge of the orange porch light on a row with swing sitters, clear of the frame's door-side legs (drawn
// 4.5 wide). An escalated ground ring is 140 wide, so a crowded door would otherwise run it under the legs and past
// the nearest seat, and orange on the swings reads as Blocked. Null when nobody sits on that row.
export function porchLightClipX(sitterXs) {
  if (!Array.isArray(sitterXs) || !sitterXs.length) return null;
  return swingFrame(sitterXs, 0).x1 + SWING_LEG_SPREAD + 3;
}

// ----- the jail -----

// The jail: a cell block with barred windows in the top left corner, above the graveyard, and a barred yard in
// front of it where rows whose only PRs were closed stand. `plot` is its ground, and nothing the jail draws leaves
// it: walks in and out go through JAIL.approach so none of it crosses the graveyard.
export const JAIL = Object.freeze({
  plot: Object.freeze([70, 46, 260, 204]),
  // The block: a slate roof over a stone wall, with the yard's back rail along its base.
  block: Object.freeze([84, 108, 236, 72]),
  roofH: 28,
  windows: Object.freeze([Object.freeze([122, 142, 36, 24]), Object.freeze([246, 142, 36, 24])]),
  door: Object.freeze([184, 138, 36, 42]),
  yard: Object.freeze([78, 180, 248, 68]),
  // The cage across the front of the yard: bars from `top` to `foot` on three rails. Everything above `mid` is
  // painted into the background, behind the crowd, and everything below it over the crowd, so a prisoner reads as
  // inside the cage while its face and its badge stay clear of every bar.
  top: 180,
  mid: 226,
  foot: 248,
  barW: 3.4,
  // The x range where the front bars stop for a gateway, and the two posts the sign board stands on.
  gate: Object.freeze([230, 264]),
  posts: Object.freeze([176, 248]),
  // Where a walk to or from the yard joins the roads: outside the cage, at the mouth of the gateway. A straight run
  // from the road to a slot would cross the graveyard's fence and its headstones, since the graveyard lies between.
  approach: Object.freeze({ x: 246, y: 262 }),
});

export function inJailPlot(p) {
  const [x, y, w, h] = JAIL.plot;
  const ax = px(p);
  const ay = py(p);
  return ax >= x && ax <= x + w && ay >= y && ay <= y + h;
}

// The x of every bar across the front of the yard, evenly spaced between its corner posts, skipping the gateway.
export function jailBars() {
  const [x0, , w] = JAIL.yard;
  const steps = Math.max(1, Math.round(w / 17.5));
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const x = x0 + (w * i) / steps;
    if (x > JAIL.gate[0] + 1e-6 && x < JAIL.gate[1] - 1e-6) continue;
    out.push(rnd2(x));
  }
  return out;
}

// The two bars the gateway opens between: its posts.
export function jailGateway() {
  const xs = jailBars();
  return [Math.max(...xs.filter((x) => x < JAIL.gate[0])), Math.min(...xs.filter((x) => x > JAIL.gate[1]))];
}

// The cage's three rails as [x, y, w, h] boxes: along the block's base, and the two drawn over the crowd.
export function jailRails() {
  const [x, , w] = JAIL.yard;
  return [JAIL.top, JAIL.mid, JAIL.foot - 2].map((y) => [x, y - 2.2, w, 4.4]);
}

// Every bar as an [x, y, w, h] box. `near` picks the section drawn over the crowd rather than behind it.
export function jailBarBoxes(near = false) {
  const y0 = near ? JAIL.mid : JAIL.top;
  const y1 = near ? JAIL.foot : JAIL.mid;
  return jailBars().map((x) => [x - JAIL.barW / 2, y0, JAIL.barW, y1 - y0]);
}

// ----- the graveyard -----

export const GRAVEYARD = Object.freeze({
  name: 'Graveyard',
  fence: Object.freeze([26, 348, 400, 190]),
  gateX: 334,
  // Where a character stops on the road before fading through the gate.
  gate: Object.freeze({ x: 334, y: 552 }),
  sign: Object.freeze([334, 486]),
});

// Headstone bases, newest first: the front rows by the gate, then further back. The front two rows leave room
// for the gate sign and the path.
export const GRAVE_SLOTS = Object.freeze((() => {
  const rows = [
    { y: 510, maxX: 232 }, { y: 472, maxX: 232 }, { y: 434, maxX: 410 }, { y: 396, maxX: 410 },
  ];
  const out = [];
  for (const row of rows) {
    const xs = [];
    for (let x = 56; x <= row.maxX; x += 35) if (Math.abs(x - GRAVEYARD.gateX) > 24) xs.push(x);
    xs.sort((a, b) => Math.abs(a - GRAVEYARD.gateX) - Math.abs(b - GRAVEYARD.gateX) || a - b);
    for (const x of xs) out.push(Object.freeze({ x, y: row.y }));
  }
  return out;
})());

export const GRAVE_CAPACITY = GRAVE_SLOTS.length;

// ids in board order (newest first). Returns Map id -> { index, x, y } for those that get a headstone.
export function graveyardLayout(ids) {
  const out = new Map();
  let index = 0;
  for (const id of ids || []) {
    if (typeof id !== 'string' || out.has(id)) continue;
    if (index >= GRAVE_CAPACITY) break;
    const slot = GRAVE_SLOTS[index];
    out.set(id, { index, x: slot.x, y: slot.y });
    index += 1;
  }
  return out;
}

// Friendly ghosts float inside the graveyard's fence, over the headstones and drawn after them, translucent, with
// no hit area of their own, so a headstone under a ghost still hovers and clicks. Their bob and sway are ambient,
// so they never ask for a frame of their own.
//
// Each perch keeps, at every phase, below the back rail's posts (y 376), above the front rails, inside the fence's
// x range and clear of the others. The sign, with its "+N more" line, its badge and the hangers up to the arch,
// takes x 278..391 from y 429 down, so over that side there is only the back band, 53 px deep: perch 1 is small
// because it is the one that has to stand there, the far side of the graveyard from perch 0. The order is the
// order they appear in, so every count from 2 to 12 reads as spread out rather than as a queue. Perches 6-11 fill
// the gaps the first six leave: the back band either side of the sign (6, 7), the two gaps between the back-row
// perches (8, 9), and the gaps either side of the front-row perch nearest the sign (10, 11).
export const GHOSTS = Object.freeze([
  { x: 80, y: 470, rx: 16, ry: 19, bob: 6, sway: 6, period: 5.6, swayPeriod: 8.3, phase: 0 },
  { x: 398, y: 402.5, rx: 11, ry: 12, bob: 4, sway: 4, period: 6.3, swayPeriod: 9.1, phase: 1.7 },
  { x: 248, y: 406, rx: 12, ry: 14, bob: 4.5, sway: 4.5, period: 4.9, swayPeriod: 7.4, phase: 3.1 },
  { x: 150, y: 406, rx: 13, ry: 15, bob: 5, sway: 5, period: 5.9, swayPeriod: 8.8, phase: 0.8 },
  { x: 205, y: 482, rx: 10, ry: 11, bob: 3.5, sway: 3.5, period: 6.7, swayPeriod: 7.9, phase: 2.4 },
  { x: 62, y: 402, rx: 9, ry: 10, bob: 3, sway: 3, period: 5.3, swayPeriod: 9.6, phase: 4.2 },
  { x: 300, y: 402, rx: 8, ry: 9, bob: 2.3, sway: 2.6, period: 6.1, swayPeriod: 5.1, phase: 0.4 },
  { x: 355, y: 402, rx: 6, ry: 7, bob: 1.8, sway: 2, period: 8.2, swayPeriod: 4.6, phase: 4.4 },
  { x: 103, y: 400, rx: 6, ry: 7, bob: 2, sway: 2.2, period: 7.1, swayPeriod: 6.1, phase: 1.1 },
  { x: 200, y: 400, rx: 7, ry: 8, bob: 2.1, sway: 2.4, period: 4.5, swayPeriod: 8.9, phase: 2.9 },
  { x: 147, y: 475, rx: 10, ry: 11, bob: 3, sway: 3.2, period: 5.1, swayPeriod: 7.3, phase: 3.3 },
  { x: 252, y: 475, rx: 6, ry: 7, bob: 2, sway: 2.2, period: 9.4, swayPeriod: 4.1, phase: 6.0 },
].map((g) => Object.freeze(g)));

// The first perch, the biggest, which every graveyard with a grave shows.
export const GHOST = GHOSTS[0];

// A graveyard holding this many or more earns one more ghost, so a two-grave graveyard does not look haunted and a
// full one does. Charlie's holds about 157, which is twelve.
export const GHOST_STEPS = Object.freeze([6, 12, 20, 30, 42, 56, 72, 92, 116, 144]);
export const GHOST_MIN = 2;

// How many ghosts a graveyard of `graves` shows: none when it is empty, then GHOST_MIN rising one step at a time.
export function ghostCount(graves) {
  const n = Number(graves);
  if (!Number.isFinite(n) || n < 1) return 0;
  let out = GHOST_MIN;
  for (const step of GHOST_STEPS) if (n >= step) out += 1;
  return Math.min(out, GHOSTS.length);
}

// The perches in use at that graveyard size.
export function ghostsFor(graves) {
  return GHOSTS.slice(0, ghostCount(graves));
}

// Where a ghost is at time t. Under reduced motion it holds its rest position.
export function ghostAt(t, reduced = false, g = GHOST) {
  if (reduced) return { x: g.x, y: g.y };
  return {
    x: g.x + g.sway * Math.sin((TAU * (t + g.phase)) / g.swayPeriod),
    y: g.y + g.bob * Math.sin((TAU * (t + g.phase)) / g.period),
  };
}

// Everything a ghost paints, as [x, y, w, h]: the body, its hem and arms with their strokes, and the halo behind
// it. The halo's square reaches below the hem on every perch smaller than the first.
export function ghostBox(t, reduced = false, g = GHOST) {
  const { x, y } = ghostAt(t, reduced, g);
  const w = g.rx + 8;
  const top = y - g.ry - 8;
  return [x - w, top, w * 2, y + Math.max(g.ry * 1.3 + 3, g.ry + 8) - top];
}

// ----- the island, the sand castle and the cottages -----

// The island, out at sea in the bottom right corner: small enough to sit inside the canvas with a margin all
// round, and far enough out that the channel between it and the mainland reads as open water.
export const ISLAND = Object.freeze({ cx: 1436, cy: 762, rx: 130, ry: 110 });

// The sand castle on the island, drawn at `s` about its base so it stays a bucket castle on a small beach.
// `rect` is its hit area outside (the castle without its flags) and `footprint` what a lounger must not stand on.
export const CASTLE = Object.freeze({
  x: 1496,
  y: 690,
  s: 0.56,
  rect: Object.freeze([1452, 616, 88, 75]),
  footprint: Object.freeze([1450, 666, 92, 26]),
  door: Object.freeze({ x: 1496, y: 692 }),
  badge: Object.freeze([1496, 638]),
});

// The cottage on the green, north of the workshop: idle and recent rows are inside it, so outside it is one small
// cottage with a sign, a count and a door to click, not a row of houses with a crowd in front.
export const COTTAGE = Object.freeze({
  x: 830,
  y: 214,
  rect: Object.freeze([750, 62, 180, 156]),
  door: Object.freeze({ x: 830, y: 218 }),
  badge: Object.freeze([830, 100]),
});
export const COTTAGE_WINDOWS = Object.freeze([[776, 140, 30, 26], [856, 140, 30, 26]].map((r) => Object.freeze(r)));

// The sand castle's three openings, in logical coordinates: the keep's window and one in each turret. They are dark
// outside the dusk theme and lit warm at dusk, the same language the cottage windows use. The numbers come from the
// unscaled shapes `paintSandCastle` draws inside its scaled block, run through the same scale about the castle's
// base, so they cannot drift from what is painted.
export const CASTLE_WINDOWS = Object.freeze(
  [[CASTLE.x - 5, CASTLE.y - 112, 10, 15], [CASTLE.x - 62, CASTLE.y - 84, 8, 14], [CASTLE.x + 54, CASTLE.y - 84, 8, 14]]
    .map(([x, y, w, h]) => Object.freeze([
      rnd2(CASTLE.x + CASTLE.s * (x - CASTLE.x)), rnd2(CASTLE.y + CASTLE.s * (y - CASTLE.y)),
      rnd2(w * CASTLE.s), rnd2(h * CASTLE.s),
    ])),
);

// The harbour deck [x, y, w, h], the pier that runs south from it into open water, and the island jetty on the
// island's north west shore. The sea between the pier tip and the jetty is what a voyage visibly crosses.
export const HARBOUR_DECK = Object.freeze([1282, 170, 190, 168]);
export const PIER = Object.freeze({ x: 1446, top: 338, tip: 422, half: 18 });
export const JETTY = Object.freeze({ x: 1348, tip: 600, foot: 686, half: 18 });

// The lighthouse on its rocks in the top right corner. At dusk its lantern glows and a beam sweeps the whole circle
// once every `period`, which is an ambient motion: the beam advances on the 12 fps tick and never asks for a frame
// of its own, so a revolution is 60 frames.
//
// `cones` is the beam itself: three nested wedges, drawn one over the other so the edge is soft rather than a hard
// line. Their alphas compose (1 - the product of what each leaves), which is what `beamAlphaAt` returns, and the
// radial fade is `BEAM_PROFILE` interpolated linearly, exactly as the drawn gradient's stops are. Keep the two in
// step or the measured alpha stops describing what is on screen.
export const LIGHTHOUSE = Object.freeze({
  x: 1549,
  y: 74.5,
  lantern: Object.freeze([1536, 66, 26, 17]),
  period: 5,
  reach: 700,
  // Where the beam holds under reduced motion: out over the open channel, away from the harbour crowd.
  rest: 1.86,
  glow: 78,
  // Peak 0.10 where they all three overlap, which is the alpha at the lantern itself. It is set by what the beam
  // passes over rather than by how it looks: the tallest body of the back row of the harbour queue comes within
  // 72.9 px of the lantern, and 0.10 is what keeps that body inside 18 CIEDE2000 of its own repo colour.
  cones: Object.freeze([
    Object.freeze({ half: 0.227, alpha: 0.0282 }),
    Object.freeze({ half: 0.122, alpha: 0.0348 }),
    Object.freeze({ half: 0.056, alpha: 0.0406 }),
  ]),
});

// The radial fade as [fraction of reach, share of the cone's alpha], interpolated linearly. The shape is
// (1 - d / reach) ** 1.5 sampled at the quarters, which is the most a canvas gradient can carry without more stops.
export const BEAM_PROFILE = Object.freeze([[0, 1], [0.25, 0.6495], [0.5, 0.3536], [0.75, 0.125], [1, 0]].map((p) => Object.freeze(p)));

// Where the beam points at time t, in radians. Under reduced motion it holds still.
export function beamAngle(t, reduced = false) {
  if (reduced) return LIGHTHOUSE.rest;
  return LIGHTHOUSE.rest + (TAU * (Number(t) || 0)) / LIGHTHOUSE.period;
}

// The share of the beam's radial fade at distance d from the lantern.
export function beamProfile(d) {
  const f = d / LIGHTHOUSE.reach;
  if (!(f > 0)) return 1;
  if (f >= 1) return 0;
  for (let i = 1; i < BEAM_PROFILE.length; i++) {
    const [f0, a0] = BEAM_PROFILE[i - 1];
    const [f1, a1] = BEAM_PROFILE[i];
    if (f <= f1) return a0 + ((a1 - a0) * (f - f0)) / (f1 - f0);
  }
  return 0;
}

// How much of the beam covers (x, y) at time t: 0 outside it, rising towards the lantern and the beam's centre line.
// This is the alpha the crowd, the harbour and the boats under the beam are seen through.
export function beamAlphaAt(x, y, t, reduced = false) {
  const dx = x - LIGHTHOUSE.x;
  const dy = y - LIGHTHOUSE.y;
  const d = Math.hypot(dx, dy);
  if (!(d < LIGHTHOUSE.reach)) return 0;
  const radial = beamProfile(d);
  if (!(radial > 0)) return 0;
  // At the lantern itself there is no direction to compare against, and all three wedges meet there, so it counts
  // as fully lit rather than as outside the beam.
  let delta = d > 1e-9 ? Math.atan2(dy, dx) - beamAngle(t, reduced) : 0;
  delta = Math.abs((((delta + Math.PI) % TAU) + TAU) % TAU - Math.PI);
  let keep = 1;
  for (const c of LIGHTHOUSE.cones) if (delta <= c.half) keep *= 1 - c.alpha * radial;
  return 1 - keep;
}

// The most of the beam that can ever fall on (x, y), whatever the beam's angle: its radial fade alone.
export function beamPeakAt(x, y) {
  const radial = beamProfile(Math.hypot(x - LIGHTHOUSE.x, y - LIGHTHOUSE.y));
  let keep = 1;
  for (const c of LIGHTHOUSE.cones) keep *= 1 - c.alpha * radial;
  return 1 - keep;
}

// Border patrol at the entrance to the pier: a striped barrier across the pier, pivoting on a post at its right edge,
// and a guard on a small platform beside it with a booth. Open PRs queue behind it on the deck. The platform sits right
// of the pier, below the boardwalk and above where a boat's sail reaches at the berth.
export const PATROL_ID = 'harbour:patrol';
// The ids that name a place rather than a session. Hovering one reports it; clicking a room's goes inside.
const PLACE_IDS = new Set([CASTLE_ID, COTTAGE_ID, PATROL_ID]);
export const BARRIER = Object.freeze({ y: 372, pivotX: PIER.x + PIER.half + 6, tipX: PIER.x - PIER.half - 6 });
// Where a session whose PR merged stands for its passport stamp, on the pier just above the barrier.
export const GATE_POINT = Object.freeze({ x: PIER.x, y: BARRIER.y - 14 });
// Far enough right of the pier that a walker at the largest size (arms 37.5 either side) passes the guard and platform.
export const GUARD = Object.freeze({ x: 1506, y: 398 });
// [x, y, w, h] boxes: the barrier with its post (lowered), the guard, the booth and the platform under both. The booth
// ends short of the boardwalk post at x 1556.
export const BARRIER_BOX = Object.freeze([BARRIER.tipX - 4, BARRIER.y - 22, BARRIER.pivotX - BARRIER.tipX + 8, 32]);
export const GUARD_BOX = Object.freeze([GUARD.x - 18, GUARD.y - 60, 36, 66]);
export const BOOTH_BOX = Object.freeze([1526, 340, 28, 54]);
export const PATROL_PLATFORM = Object.freeze([1486, 394, 70, 20]);
export const PATROL_HIT = Object.freeze([GUARD_BOX[0], GUARD_BOX[1], BOOTH_BOX[0] + BOOTH_BOX[2] - GUARD_BOX[0], GUARD_BOX[3]]);
export const STAMP_S = 1.0;
// The share of STAMP_S at which the stamp comes down on the passport.
export const STAMP_STRIKE = 0.45;
export const LIFT_S = 0.45;
// The barrier is fully up this long before a walker's feet reach it, and starts down this long after they pass.
const BARRIER_LEAD_S = 0.12;
const BARRIER_CLEAR_S = 0.3;
// A second stamp waits until the first walker has left the gate point.
export const GATE_CLEAR_S = 0.7;

// What hovering the guard reports: how many open PRs wait behind the barrier.
export function patrolState(rows) {
  let waiting = 0;
  for (const s of Array.isArray(rows) ? rows : []) if (s && typeof s === 'object' && s.lane === 'open_pr') waiting += 1;
  return { waiting };
}

// ---------------------------------------------------------------------------------------------
// Visitors: open PRs waiting on a review, queueing at the immigration desk
// ---------------------------------------------------------------------------------------------

// A visitor is a PR, never a session. It has no lane, no place, no tokens, no state badge and no session data of
// any kind: everything it is fits in the queue at the border post, so all of this is harbour geometry.

// The pier tip, where the boat that brought a visitor has just left and where it waits for the next one.
export const VISITOR_DOCK = Object.freeze({ x: PIER.x, y: PIER.tip - 4 });
// The way between the dock and the landing, ordered from the dock outwards. Every point of it is south of the
// barrier line, so a visitor never crosses the border it is queueing at and the barrier never lifts for one.
export const VISITOR_WAY = Object.freeze([
  Object.freeze({ x: PIER.x, y: 394 }), Object.freeze({ x: 1408, y: 378 }),
]);
// The planks the over-water half of the queue stands on, from the shore out to just short of the barrier. Drawn
// only while someone is standing on them, so a village with no reviews waiting is the village it always was.
export const VISITOR_LANDING = Object.freeze([1288, 356, 126, 26]);
// One file along the waterline, the head of the queue at the barrier end and the tail trailing west onto the
// shore. A single file rather than rows: the deck above belongs to the harbour queue and the water below to the
// boat lane, and what is left between them is 26 px deep, which is less than one visitor.
export const VISITOR_SPOT = Object.freeze({
  place: 'harbour', lanes: [], rect: [1200, 374, 200, 0], dx: 25, dy: 1, minDx: 25, minDy: 1,
  stagger: false, anchor: [1400, 374],
});
// The slots that fit without touching. Past this the queue writes "+N more" and stops drawing, the way the
// graveyard's sign does: a tighter queue would draw a mush of overlapping coats at the one place in the village
// with no room to spread into.
export const VISITOR_CAPACITY = 9;
// Seconds between two visitors stepping off at the pier tip. Long enough that the one behind is barely there until
// the one ahead has walked clear of it, on the slowest walk, which is the shortest route.
export const VISITOR_STAGGER_S = 0.7;
// Where "+N more" is written when the queue is at its capacity, in the one clear band there is: below where the
// harbour queue's own plates reach at the largest size, and above the visitors' heads.
export const VISITOR_OVERFLOW = Object.freeze({ x: 1204, y: 320 });
// The whole board's count on the world map, in the top margin, which is outside every island's cell.
export const WORLD_REVIEWS_PILL = Object.freeze({ x: W / 2, y: 22 });

// Reviews are not a lane, so they borrow no lane's colour: the page's own visitor teal, with the passport glyph
// its HUD pill already uses. White on this teal is 5.5:1.
export const REVIEWS_KEY = 'reviews';
export const REVIEWS = Object.freeze({ color: '#0f766e', border: '#0a4f49', glyph: 'passport', word: 'Reviews' });

// A visitor's coat, from a hash of its login. Dark travel coats with cream faces, deliberately outside both the
// reserved state palette and the bold repo bodies: a visitor's colour is decor, and what tells it apart at a
// glance is its silhouette, a suitcase at its feet and a passport where a session carries its state badge. Each
// keeps its colour at dusk and takes a pale rim there, exactly as a dark repo body does.
const visitorCoat = (name, fill, lightEdge, darkEdge) => Object.freeze({
  name, light: fill, lightEdge, dark: fill, darkEdge, ink: INK_LIGHT,
});
export const VISITOR_COATS = Object.freeze([
  visitorCoat('Harbour teal', '#3a7888', '#22464f', '#b4cacc'),
  visitorCoat('Rust', '#502c21', '#2e1a13', '#bdaea5'),
  visitorCoat('Indigo', '#2a1e48', '#18112a', '#aea8b4'),
  visitorCoat('Moss', '#356529', '#1f3b18', '#b2c3a8'),
  visitorCoat('Wine', '#b54a80', '#692b4a', '#e3b9c9'),
]);

export function visitorColour(login) {
  return VISITOR_COATS[repoHash(typeof login === 'string' ? login : '') % VISITOR_COATS.length];
}

// How GitHub asked for the review: 'you' by name, or 'team' through a team you are on. Anything else is a team, so
// a missing or garbled field never makes a request look more personal than GitHub said it was.
export const VISITOR_VIA = Object.freeze(['you', 'team']);
export function visitorVia(v) {
  return v && typeof v === 'object' && v.via === 'you' ? 'you' : 'team';
}

// Where the passport is held, as [left, top, right, bottom] around the feet: up beside the head, presented at the
// desk, when you were asked by name; at the hip, below the team sash, when a team you are on was asked.
export const VISITOR_PASSPORT = Object.freeze({
  you: Object.freeze([3.5, -41, 10, -32]), team: Object.freeze([3.5, -22, 10, -13]),
});
export const VISITOR_SASH = '#f5e7c1';
const COAT_H = 28;

// A visitor's parts around its feet, as [left, top, right, bottom] offsets: the coat over its legs, the head, the
// suitcase set down on its left and the passport on its right. Half the width of a session and never as tall,
// since nothing floats above its head. The walk's own bob, the case raised while it is carried and the ground
// shadow are left out, exactly as `avatarBoxes` leaves out what a session does only while it moves.
const VISITOR_PARTS = Object.freeze(Object.fromEntries(VISITOR_VIA.map((via) => [via, Object.freeze([
  Object.freeze([-8, -31, 8, -1]), Object.freeze([-7, -45, 7, -31]), Object.freeze([-10, -14, -2, 1]),
  VISITOR_PASSPORT[via],
])])));

export function visitorBoxes(x, y, via = 'team') {
  return VISITOR_PARTS[via === 'you' ? 'you' : 'team'].map(([l, t, r, b]) => [x + l, y + t, r - l, b - t]);
}

// One box spanning every part of both looks, so who was asked never moves a visitor's hit area or hover point.
export function visitorBox(x, y) {
  const all = VISITOR_VIA.flatMap((via) => VISITOR_PARTS[via]);
  const l = Math.min(...all.map((p) => p[0]));
  const t = Math.min(...all.map((p) => p[1]));
  const r = Math.max(...all.map((p) => p[2]));
  const b = Math.max(...all.map((p) => p[3]));
  return [x + l, y + t, r - l, b - t];
}

// Wider at the hem than at the shoulders, which no session body is at any size.
export function visitorCoatShape(x, bottom) {
  const top = bottom - COAT_H;
  return [[x - 6.5, top], [x + 6.5, top], [x + 8, bottom], [x - 8, bottom]];
}

// The team sash, right shoulder to left hip. Inset from the coat's edges by half the coat's outline, so the
// silhouette is the coat's own and the visitor grows by nothing; the low end stops above the suitcase.
export function visitorSash(x, bottom) {
  const top = bottom - COAT_H;
  const at = (dy, side) => [x + side * (6.5 + (1.5 * dy) / COAT_H - 1), top + dy];
  return [at(1, 1), at(8, 1), at(21, -1), at(14, -1)];
}

// The island a visitor stands on, exactly as the server named it, or null: that one waits at the whole board's desk
// in one village mode and badges no island. Never worked out from the repo name, because anyone can open a repo
// that shares a name with one of yours, and a folder need not be named like its repo. The page reads the same
// field the same way, or a badge would count a visitor the queue does not draw.
export function visitorIsland(v) {
  const key = v && typeof v === 'object' ? v.island : null;
  return typeof key === 'string' && key ? key : null;
}

const visitorNumber = (v) => {
  for (const n of [v.number, v.prNumber]) if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return null;
};
const visitorWaited = (v) => {
  for (const t of [v.waitingSince, v.requestedAt, v.since]) if (Number.isFinite(t) && t > 0) return t;
  return null;
};

// The board's visitors, cleaned and longest wait first. Field aliases, the drop rule and the order are the page's
// own (`visitorsFrom` in app.js), because the map's badges, the HUD pill and this queue all have to be the same
// list. A visitor with no PR number is dropped: the number is the one thing privacy mode still shows. `taken` is
// the session ids on the board, and a session wins an id that is somehow in both, so a visitor can never take a
// session's hover or click. The team names are not kept: they are text GitHub users chose, and nothing here draws
// text for a visitor.
export function visitorRows(list, taken = null) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !v.id || seen.has(v.id)) continue;
    if (taken && taken.has(v.id)) continue;
    const number = visitorNumber(v);
    if (number === null) continue;
    seen.add(v.id);
    out.push({
      // `author` before `login`, the page's own order: the server sends `author`, so a source that ever sends
      // both must not colour a coat from one login while the tooltip reads the other.
      id: v.id, login: (typeof v.author === 'string' && v.author) || (typeof v.login === 'string' ? v.login : ''),
      island: visitorIsland(v), number, waitingSince: visitorWaited(v), via: visitorVia(v),
    });
  }
  const at = (v) => (v.waitingSince === null ? Infinity : v.waitingSince);
  out.sort((a, b) => at(a) - at(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

export function visitorsFor(list, repo) {
  const rows = Array.isArray(list) ? list : [];
  return typeof repo === 'string' ? rows.filter((v) => visitorIsland(v) === repo) : rows.slice();
}

// How many visitors each island holds, keyed the way `repoKeyOf` keys a session's island. A visitor with no island
// is in no entry: it is still in the whole board's count.
export function visitorsByRepo(list) {
  const out = new Map();
  for (const v of Array.isArray(list) ? list : []) {
    const key = visitorIsland(v);
    if (key !== null) out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
}

// The queue as drawn: `VISITOR_CAPACITY` slots, `hidden` for the rest and `total` for the pill. Slot 0 is the one
// nearest the barrier, so the longest wait stands at the desk and is always drawn: the page's Reviews pill points
// there. The other slots go to requests asked of you before any asked of a team, so the urgent kind is never the
// one behind "+N more", and those drawn stand in the list's own order.
export function visitorLayout(list) {
  const rows = Array.isArray(list) ? list : [];
  const rest = rows.slice(1);
  const drawn = new Set([...rows.slice(0, 1), ...rest.filter((v) => visitorVia(v) === 'you'),
    ...rest.filter((v) => visitorVia(v) !== 'you')].slice(0, VISITOR_CAPACITY));
  const shown = rows.filter((v) => drawn.has(v));
  const grid = slotGrid(VISITOR_SPOT, shown.length);
  const slots = new Map();
  shown.forEach((v, i) => {
    const p = grid.points[i];
    slots.set(v.id, { index: i, x: p.x, y: p.y, visitor: v });
  });
  return { slots, shown: shown.length, hidden: Math.max(0, rows.length - shown.length), total: rows.length };
}

// The polyline between the dock and a point on the landing, in whichever direction it is walked.
export function visitorPath(from, to) {
  const out = [{ x: px(from), y: py(from) }];
  const atDock = (p) => py(p) > VISITOR_WAY[0].y;
  const way = VISITOR_WAY.map((p) => ({ x: p.x, y: p.y }));
  if (atDock(from) && !atDock(to)) out.push(...way);
  else if (atDock(to) && !atDock(from)) out.push(...[...way].reverse());
  out.push({ x: px(to), y: py(to) });
  return dedupe(out, out[out.length - 1]);
}

// What a beach slot must keep clear of, as [x, y, w, h]: the sand castle's footprint, the palm's trunk, the jetty
// planks and the beach sign out in the channel. A lounger box is 107 tall against an island 220 deep, so the
// castle's turrets and the palm's fronds are deliberately left out: they would block a whole column of sand for
// the sake of a badge passing in front of them.
export const BEACH_OBSTACLES = Object.freeze([
  CASTLE.footprint, [1408, 666, 24, 14],
  [JETTY.x - JETTY.half, JETTY.tip - 6, 2 * JETTY.half, JETTY.foot - JETTY.tip + 12], [1115, 753, 130, 54],
].map((r) => Object.freeze(r)));

// A lounger's chair, body and badge (tallest look, with a hat), and the umbrella beside it, around its feet.
export function loungerBox(x, y) {
  return [x - 20, y - 100, 40, 107];
}

export function umbrellaBox(x, y) {
  return [x - 5, y - 100, 76, 107];
}

export function boxesOverlap(a, b) {
  return a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
}

function beachAllows(x, y) {
  const box = loungerBox(x, y);
  return onIsland(x, y, -8) && !BEACH_OBSTACLES.some((o) => boxesOverlap(box, o));
}

export function umbrellaFits(x, y, k = 1) {
  const [ux, uy, uw, uh] = umbrellaBox(x, y);
  const box = [x + (ux - x) * k, y + (uy - y) * k, uw * k, uh * k];
  return !BEACH_OBSTACLES.some((o) => boxesOverlap(box, o));
}

// ----- how far each place lets a character grow -----

// A character's parts around its feet at scale 1, as [left, top, right, bottom] offsets (up is negative), covering
// every look: the body (the widest shape, up to the tallest), the arms, the legs, the badge (anywhere from above the
// shortest look to above the tallest with a hat) and what the pose sits or works at. Things held up or floating (a
// waving hand, the hammer, the pause sign, the z, the bubble, a margarita, an umbrella) and the escalated hop are left
// out: they pass over neighbours the same way at any size. Scaling is about the feet, so each edge moves linearly.
const LIFTS = Object.freeze({ errored: 3, idle: 3, recent: 3, your_turn: 9, valhalla: 12 });
function avatarOffsets(lane) {
  const lift = LIFTS[lane] || LEG;
  const arms = lane === 'valhalla' ? 20 : 25;
  const parts = [
    [-19, -(lift + 44), 19, -lift], [-arms, -(lift + 25), arms, -(lift + 4)], [-9, -lift, 9, 2],
    [-14, -(lift + 86), 14, -(lift + 39)],
  ];
  const prop = {
    errored: [-25, -10, 25, 2], running: [11, -36, 52, 1], idle: [-22, -11, 22, 2], recent: [-22, -11, 22, 2],
    your_turn: [-26, -41, 26, -3], valhalla: [-21, -51, 21, 4],
  }[lane];
  if (prop) parts.push(prop);
  return parts;
}

// The parts of a character standing at (x, y) at scale k, as [x, y, w, h] boxes.
export function avatarBoxes(lane, x, y, k = 1) {
  return avatarOffsets(lane).map(([l, t, r, b]) => [x + l * k, y + t * k, (r - l) * k, (b - t) * k]);
}

// One box spanning every part.
export function avatarBox(lane, x, y, k = 1) {
  const boxes = avatarBoxes(lane, x, y, k);
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

const PLATE_H = 27;
// Two parts may touch by this much, as they already do in a crowd at the plain size (a badge brushing the arm of the
// character behind it).
export const CLASH_TOLERANCE = 3;
const SIGN_H = 54;
// A sign board is wide enough for the place name and one badge and count per lane; the four-lane Porch declares a
// wider board (signW) than the 130 the rest need.
export function signBox(place) {
  const p = PLACES[place];
  if (!p) return [0, 0, 0, 0];
  const w = p.signW || 130;
  const h = p.signH || SIGN_H;
  return [p.sign[0] - w / 2, p.sign[1] - h / 2, w, h];
}

// A plate's left edge: centred under its character, held on the canvas, and held off its own place's sign where the
// plate's band meets the sign's. The clash check never tests a plate against the scenery (a plate is fixed-size), so
// without this a lone Blocked's full-width plate on the Porch's front row ran onto the Porch sign.
export function plateLeft(place, px, w, y0, h) {
  let lo = 4;
  let hi = W - w - 4;
  if (place && PLACES[place]) {
    const [sx, sy, sw, sh] = signBox(place);
    if (y0 < sy + sh && sy < y0 + h) {
      if (px <= sx) hi = Math.min(hi, sx - w - 4);
      else if (px >= sx + sw) lo = Math.max(lo, sx + sw + 4);
    }
  }
  return Math.max(lo, Math.min(hi, px - w / 2));
}

// What a place's crowd must keep clear of besides each other: its sign board, and the landmarks beside it.
export function placeScenery(place) {
  const own = PLACES[place] ? [signBox(place)] : [];
  switch (place) {
    case 'porch': return [...PORCH_OBSTACLES, ...own];
    case 'harbour':
      return [...own, [1494, 52, 106, 136], [BOAT_BERTH.x - 44, BOAT_BERTH.y - 6, 88, 28], BARRIER_BOX, GUARD_BOX, BOOTH_BOX,
        PATROL_PLATFORM];
    case 'beach': return [...BEACH_OBSTACLES];
    default: return own;
  }
}

// Linear boxes: each edge is c + d * k. figures: [{ lane, x, y, index, dx }] for one place.
function placeParts(place, figures) {
  const parts = [];
  const lin = (owner, [l, t, r, b], x, y) => parts.push({ owner, c: [x, y, x, y], d: [l, t, r, b] });
  const fixed = (owner, [x, y, w, h]) => parts.push({ owner, c: [x, y, x + w, y + h], d: [0, 0, 0, 0] });
  figures.forEach((f, i) => {
    for (const o of avatarOffsets(f.lane)) lin(i, o, f.x, f.y);
  });
  // Always-shown plates hang below the feet at a fixed size. Every spot that shows them has a row of clear ground
  // under it (the porch rows are 132 apart), so no plate has to hang above the badges.
  const plated = figures.map((f, i) => ({ ...f, i })).filter((f) => PLATED_LANES.has(f.lane));
  for (const f of plated) {
    let gap = Infinity;
    for (const o of plated) if (o !== f && Math.abs(o.y - f.y) < 30) gap = Math.min(gap, Math.abs(o.x - f.x));
    const w = clamp(gap - 10, 56, 260);
    fixed(f.i, [plateLeft(place, f.x, w, f.y + 9, PLATE_H), f.y + 9, w, PLATE_H]);
    parts[parts.length - 1].plate = true;
  }
  const scenery = placeScenery(place).map((b) => ({ owner: -1, c: [b[0], b[1], b[0] + b[2], b[1] + b[3]], d: [0, 0, 0, 0] }));
  if (place === 'porch') {
    for (const y of PORCH_ROWS) {
      const xs = figures.filter((f) => f.lane === 'your_turn' && Math.abs(f.y - y) < 1).map((f) => f.x);
      if (!xs.length) continue;
      const frame = swingFrame(xs, y);
      for (const p of frame.posts) scenery.push({ owner: -1, c: [p - SWING_LEG_SPREAD - 2.25, frame.beamY, p + SWING_LEG_SPREAD + 2.25, y + 3], d: [0, 0, 0, 0] });
    }
  }
  return { parts, scenery };
}

// The scales k >= 1 (as an open interval) at which two linear boxes overlap, or null.
function clashInterval(a, b, kMax) {
  let lo = 1 - 1e-9;
  let hi = kMax + 1e-9;
  // Overlap needs a.x0 < b.x1, b.x0 < a.x1, a.y0 < b.y1 and b.y0 < a.y1 by more than the tolerance, each linear in k.
  for (const [i, j, u, v] of [[a, b, 0, 2], [b, a, 0, 2], [a, b, 1, 3], [b, a, 1, 3]]) {
    const p = i.c[u] - j.c[v] + CLASH_TOLERANCE;
    const q = i.d[u] - j.d[v];
    if (Math.abs(q) < 1e-12) {
      if (p >= 0) return null;
    } else if (q > 0) {
      hi = Math.min(hi, -p / q);
    } else {
      lo = Math.max(lo, -p / q);
    }
    if (lo >= hi) return null;
  }
  return [lo, hi];
}

// A plate below the feet keeps its size and place at any scale, so it can never start a new clash with the scenery.
const fixedPart = (p) => p.d.every((v) => v === 0);

// Every clash in a place at scale k: two characters' parts (a character's own plate never counts against itself),
// or a part against the scenery or the canvas edge. Plates never clash with plates: their widths already share a row.
export function placeClashes(place, figures, k = 1) {
  const { parts, scenery } = placeParts(place, figures);
  const out = [];
  const at = (p) => p.c.map((c, i) => c + p.d[i] * k);
  const tol = CLASH_TOLERANCE;
  const hit = (a, b) => a[0] < b[2] - tol && b[0] < a[2] - tol && a[1] < b[3] - tol && b[1] < a[3] - tol;
  const boxes = parts.map(at);
  for (let i = 0; i < parts.length; i++) {
    const a = boxes[i];
    if (!parts[i].plate && (a[0] < -tol || a[2] > W + tol || a[1] < -tol || a[3] > H + tol)) out.push([parts[i].owner, 'edge']);
    for (const s of scenery) if (!fixedPart(parts[i]) && hit(a, s.c)) out.push([parts[i].owner, 'scenery']);
    for (let j = i + 1; j < parts.length; j++) {
      if (parts[i].owner === parts[j].owner || (parts[i].plate && parts[j].plate)) continue;
      if (hit(a, boxes[j])) out.push([parts[i].owner, parts[j].owner]);
    }
  }
  return out;
}

// The largest scale, up to TOKEN_SCALE.max, at which nothing in the place overlaps anything it did not already
// overlap at 1: a place already touching at 1 keeps everyone at 1, since growing would only make it worse.
export function placeScaleCap(place, figures) {
  const list = (Array.isArray(figures) ? figures : []).filter((f) => f && Number.isFinite(f.x) && Number.isFinite(f.y));
  const kMax = TOKEN_SCALE.max;
  if (!list.length) return kMax;
  const { parts, scenery } = placeParts(place, list);
  let first = kMax;
  const consider = (iv) => {
    if (!iv) return true;
    if (iv[0] <= 1) return false;
    first = Math.min(first, iv[0]);
    return true;
  };
  const edges = [
    { c: [-Infinity, -Infinity, 0, Infinity], d: [0, 0, 0, 0] }, { c: [W, -Infinity, Infinity, Infinity], d: [0, 0, 0, 0] },
    { c: [-Infinity, -Infinity, Infinity, 0], d: [0, 0, 0, 0] }, { c: [-Infinity, H, Infinity, Infinity], d: [0, 0, 0, 0] },
  ];
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i];
    if (!a.plate) for (const e of edges) if (!consider(clashInterval(a, e, kMax))) return 1;
    if (!fixedPart(a)) for (const s of scenery) if (!consider(clashInterval(a, s, kMax))) return 1;
    for (let j = i + 1; j < parts.length; j++) {
      const b = parts[j];
      if (a.owner === b.owner || (a.plate && b.plate)) continue;
      if (!consider(clashInterval(a, b, kMax))) return 1;
    }
  }
  return first >= kMax ? kMax : Math.max(1, Math.floor(first * 100 - 1e-6) / 100);
}

// The two interior scenes: the sand castle hall on the island, and the cottage room on the green. They share every
// rule (crowd scale, spread, wander, personal space); only the floor differs, since a cottage room is smaller than
// a castle hall.
const INTERIOR = {
  // A guest's footprint at scale 1, and the share of the floor a crowd covers at its chosen scale.
  cellW: 96,
  cellH: 124,
  fill: 0.45,
  minScale: 0.28,
  maxScale: 1.3,
  // Soft personal space at scale 1: centre to centre, across and in depth.
  sepX: 42,
  sepY: 44,
};
export const HALL = Object.freeze({
  // Where guests' feet may go, as [x, y, w, h]: the whole floor, clear of the walls.
  floor: Object.freeze([110, 410, 1380, 456]),
  ...INTERIOR,
});
export const ROOM = Object.freeze({
  floor: Object.freeze([210, 452, 1180, 388]),
  ...INTERIOR,
});
export const INTERIORS = Object.freeze({ castle: HALL, cottages: ROOM });
export const HALL_FRAME_MS = 42;

// The crowd scale that fits n guests on the floor, and a spread of starting spots over the whole floor: a jittered grid,
// the same for the same n. Reduced motion leaves guests on these spots. sizes (optional, one per guest) are their token
// sizes: a guest's drawn scale is the crowd scale times its size, so bigger guests take a bigger share of the floor.
export function castleLayout(n, sizes = null, spec = HALL) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (!count) return { scale: 1, points: [] };
  const [fx, fy, fw, fh] = spec.floor;
  let area = count;
  if (Array.isArray(sizes) && sizes.length === count) {
    area = sizes.reduce((sum, v) => sum + (Number.isFinite(v) && v > 0 ? v * v : 1), 0);
  }
  const scale = clamp(Math.sqrt((spec.fill * fw * fh) / (area * spec.cellW * spec.cellH)), spec.minScale, spec.maxScale);
  const cols = Math.max(1, Math.min(count, Math.round(Math.sqrt((count * fw) / fh))));
  const rows = Math.ceil(count / cols);
  const rand = mulberry32(0x5eed + count);
  const ch = fh / rows;
  const points = [];
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(cols, count - r * cols);
    const cw = fw / inRow;
    for (let c = 0; c < inRow; c++) {
      const jx = (rand() - 0.5) * Math.min(cw * 0.4, 120);
      const jy = rows > 1 ? (rand() - 0.5) * ch * 0.4 : 0;
      points.push({ x: rnd2(fx + (c + 0.5) * cw + jx), y: rnd2(fy + (r + 0.5) * ch + jy) });
    }
  }
  return { scale, points };
}

// How far apart two guests are, in units of their personal space (1 = just touching). A guest's size (its token
// size, 1 when unset) widens its personal space: across, a pair uses the mean of the two; in depth, the size of the
// guest in front, since its body rises by its own size over the one behind (the mean let a big guest hide a small one).
const sizeOf = (g) => (Number(g.size) > 0 ? g.size : 1);
const pairSize = (a, b) => (sizeOf(a) + sizeOf(b)) / 2;
const frontSize = (a, b) => sizeOf(a.py >= b.py ? a : b);
export function hallSpacing(a, b, k, spec = HALL) {
  return Math.hypot((a.px - b.px) / (spec.sepX * k * pairSize(a, b)), (a.py - b.py) / (spec.sepY * k * frontSize(a, b)));
}

function pickWanderTarget(g, guests, k, spec) {
  const [fx, fy, fw, fh] = spec.floor;
  const reach = 160 + 200 * k;
  let best = null;
  for (let i = 0; i < 10; i++) {
    const a = g.rng() * TAU;
    const d = reach * (0.3 + 0.7 * g.rng());
    const x = clamp(g.px + Math.cos(a) * d, fx, fx + fw);
    const y = clamp(g.py + Math.sin(a) * d * 0.6, fy, fy + fh);
    let crowd = Infinity;
    for (const o of guests) {
      if (o === g) continue;
      const here = { px: x, py: y, size: g.size };
      crowd = Math.min(crowd, hallSpacing(here, { px: o.tx, py: o.ty, size: o.size }, k, spec), hallSpacing(here, o, k, spec));
    }
    if (!best || crowd > best.crowd) best = { x, y, crowd };
    if (crowd >= 1.4) break;
  }
  g.tx = best.x;
  g.ty = best.y;
  g.stuck = 0;
}

// One step of aimless wandering for every guest, dt in seconds (capped). Each walks to a spot of its own choosing,
// pauses there (and sips on its own clock), then picks another. Guests closer than their personal space are eased
// apart, so a crowd never piles up; a walker that makes no headway picks somewhere else. A guest with held set (hovered
// or pressed) stands still and is never pushed: the other guest of a close pair gives way for both. Every guest needs
// px, py and rng; the rest is set on first use. Positions stay inside HALL.floor.
export function wanderStep(guests, dt, k, spec = HALL) {
  const step = clamp(Number(dt) || 0, 0, 0.1);
  if (!(step > 0) || !guests.length) return;
  const [fx, fy, fw, fh] = spec.floor;
  const speed = 30 + 20 * k;
  for (const g of guests) {
    if (g.tx === undefined) {
      g.tx = g.px;
      g.ty = g.py;
      g.pause = g.rng() * 2.5;
      g.stride = 0;
      g.dir = 0;
      g.stuck = 0;
    }
    g.lastX = g.px;
    g.lastY = g.py;
    if (g.held) {
      g.walking = false;
      continue;
    }
    if (g.pause > 0) {
      g.pause -= step;
      g.walking = false;
      if (g.pause <= 0) pickWanderTarget(g, guests, k, spec);
      continue;
    }
    const dx = g.tx - g.px;
    const dy = g.ty - g.py;
    const d = Math.hypot(dx, dy);
    if (d < 1.5) {
      g.walking = false;
      g.pause = 0.8 + g.rng() * 2.8;
      continue;
    }
    const move = Math.min(d, speed * step);
    g.px += (dx / d) * move;
    g.py += (dy / d) * move;
    g.walking = true;
    g.dir = Math.sign(dx);
  }
  const push = clamp(step * 20, 0, 1);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < guests.length; i++) {
      const a = guests[i];
      for (let j = i + 1; j < guests.length; j++) {
        const b = guests[j];
        const sx = k * pairSize(a, b);
        const sy = k * frontSize(a, b);
        const ux = (b.px - a.px) / (spec.sepX * sx);
        const uy = (b.py - a.py) / (spec.sepY * sy);
        const q = Math.hypot(ux, uy);
        if (q >= 1) continue;
        let nx = ux;
        let ny = uy;
        if (q < 1e-6) {
          const ang = a.rng() * TAU;
          nx = Math.cos(ang);
          ny = Math.sin(ang);
        } else {
          nx /= q;
          ny /= q;
        }
        if (a.held && b.held) continue;
        const amount = ((1 - q) / (a.held || b.held ? 1 : 2)) * push;
        if (!a.held) {
          a.px = clamp(a.px - nx * amount * spec.sepX * sx, fx, fx + fw);
          a.py = clamp(a.py - ny * amount * spec.sepY * sy, fy, fy + fh);
        }
        if (!b.held) {
          b.px = clamp(b.px + nx * amount * spec.sepX * sx, fx, fx + fw);
          b.py = clamp(b.py + ny * amount * spec.sepY * sy, fy, fy + fh);
        }
      }
    }
  }
  for (const g of guests) {
    g.px = clamp(g.px, fx, fx + fw);
    g.py = clamp(g.py, fy, fy + fh);
    const moved = Math.hypot(g.px - g.lastX, g.py - g.lastY);
    if (g.walking) {
      g.stride += moved / 24;
      g.stuck = moved < speed * step * 0.3 ? g.stuck + step : 0;
      if (g.stuck > 1.2) pickWanderTarget(g, guests, k, spec);
    }
  }
}

// ----- roads -----

export const ROAD_NODES = Object.freeze([
  [-40, 560], [460, 560], [1174, 560], [460, 320], [1174, 320], [1500, 320], [1640, 320],
]);
export const ROAD_EDGES = Object.freeze([[0, 1], [1, 2], [1, 3], [3, 4], [4, 2], [4, 5], [5, 6]]);
export const ENTRY_POINT = Object.freeze({ x: -40, y: 560 });
export const EXIT_POINT = Object.freeze({ x: 1640, y: 320 });

const px = (p) => (Array.isArray(p) ? p[0] : p.x);
const py = (p) => (Array.isArray(p) ? p[1] : p.y);
const distance = (a, b) => Math.hypot(px(a) - px(b), py(a) - py(b));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, k) => a + (b - a) * k;

let roadTable = null;

function roads() {
  if (roadTable) return roadTable;
  const n = ROAD_NODES.length;
  const dist = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => (i === j ? 0 : Infinity)));
  const next = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => (i === j ? j : -1)));
  for (const [a, b] of ROAD_EDGES) {
    const d = distance(ROAD_NODES[a], ROAD_NODES[b]);
    dist[a][b] = d;
    dist[b][a] = d;
    next[a][b] = b;
    next[b][a] = a;
  }
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (dist[i][k] + dist[k][j] < dist[i][j]) {
          dist[i][j] = dist[i][k] + dist[k][j];
          next[i][j] = next[i][k];
        }
      }
    }
  }
  roadTable = { dist, next };
  return roadTable;
}

function snapToRoad(p) {
  let best = null;
  ROAD_EDGES.forEach(([a, b], edge) => {
    const A = ROAD_NODES[a];
    const B = ROAD_NODES[b];
    const vx = B[0] - A[0];
    const vy = B[1] - A[1];
    const len2 = vx * vx + vy * vy;
    const t = len2 ? clamp(((px(p) - A[0]) * vx + (py(p) - A[1]) * vy) / len2, 0, 1) : 0;
    const q = { x: A[0] + vx * t, y: A[1] + vy * t };
    const d = distance(p, q);
    if (!best || d < best.d) best = { edge, q, d };
  });
  return best;
}

function dedupe(pts, end) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || distance(last, p) > 0.5) out.push({ x: px(p), y: py(p) });
  }
  if (out.length === 1) out.push({ x: px(end), y: py(end) });
  return out;
}

// Walks from a point to the nearest road, along the roads, then off the road to the target. A walk into or out of
// the jail's yard goes through JAIL.approach, which takes it round the east side of the graveyard.
export function planRoute(from, to) {
  const start = { x: px(from), y: py(from) };
  const end = { x: px(to), y: py(to) };
  const fromJail = inJailPlot(start);
  const toJail = inJailPlot(end);
  if (toJail !== fromJail) {
    const via = JAIL.approach;
    const legs = toJail ? [...planRoute(start, via), end] : [start, via, ...planRoute(via, end)];
    return dedupe(legs, end);
  }
  const s = snapToRoad(start);
  const e = snapToRoad(end);
  const pts = [start, s.q];
  if (s.edge === e.edge) {
    pts.push(e.q);
  } else {
    const { dist, next } = roads();
    let best = null;
    for (const a of ROAD_EDGES[s.edge]) {
      for (const b of ROAD_EDGES[e.edge]) {
        const cost = distance(s.q, ROAD_NODES[a]) + dist[a][b] + distance(ROAD_NODES[b], e.q);
        if (!best || cost < best.cost) best = { cost, a, b };
      }
    }
    let u = best.a;
    pts.push({ x: ROAD_NODES[u][0], y: ROAD_NODES[u][1] });
    let guard = 0;
    while (u !== best.b && next[u][best.b] >= 0 && guard++ < ROAD_NODES.length) {
      u = next[u][best.b];
      pts.push({ x: ROAD_NODES[u][0], y: ROAD_NODES[u][1] });
    }
    pts.push(e.q);
  }
  pts.push(end);
  return dedupe(pts, end);
}

export function routeLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

function makeRoute(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + distance(points[i - 1], points[i]));
  return { pts: points, cum, total: cum[cum.length - 1] };
}

function routeAt(route, fraction) {
  const { pts, cum } = route;
  if (pts.length < 2) return { x: pts[0].x, y: pts[0].y, dir: 0, dist: 0 };
  const d = clamp(fraction, 0, 1) * route.total;
  let i = 1;
  while (i < pts.length - 1 && cum[i] < d) i++;
  const a = pts[i - 1];
  const b = pts[i];
  const seg = cum[i] - cum[i - 1];
  const k = seg > 0 ? clamp((d - cum[i - 1]) / seg, 0, 1) : 1;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return {
    x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, dir: Math.sign(b.x - a.x), dist: d,
    hx: (b.x - a.x) / len, hy: (b.y - a.y) / len,
  };
}

const easeInOut = (p) => -(Math.cos(Math.PI * p) - 1) / 2;

export function walkDuration(length) {
  return 1.5 * clamp(length / 900, 0.8, 1.6);
}

export function sailDuration(length) {
  return clamp(length / 95, 2, 6);
}

// ----- voyages -----

// The walker walks out to the end of the pier and hops down into the boat moored off its tip, the boat sails
// across the open water to the island jetty, and the walker hops up onto the jetty and walks down it to the sand.
// The boat then sails back to the pier empty.
export const HARBOUR_BOARD = Object.freeze({ x: PIER.x, y: PIER.tip - 8 });
export const BOAT_BERTH = Object.freeze({ x: PIER.x, y: PIER.tip + 30 });
// The lane a boat sails: out of the pier, west into the open channel, down it, then in to the jetty on the
// island's north west shore. The long way round is the point: it is what makes the crossing a voyage rather than
// a hop, and the channel is where there is water to sail in.
// The westernmost point stands off the road quay (`ROAD_QUAY`, east edge 1198) by more than half a hull, so a boat
// passing the junction never sails over its planks. Pulling it further west is what would beach it.
export const SAIL_WAYPOINTS = Object.freeze([
  Object.freeze({ x: 1306, y: 472 }), Object.freeze({ x: 1246, y: 538 }), Object.freeze({ x: 1248, y: 638 }),
]);
export const JETTY_BERTH = Object.freeze({ x: JETTY.x, y: JETTY.tip - 30 });
export const JETTY_END = Object.freeze({ x: JETTY.x, y: JETTY.tip + 10 });
export const JETTY_FOOT = Object.freeze({ x: JETTY.x, y: JETTY.foot - 2 });
// Empty boats retrace the same lane. The channel is not wide enough for two lanes a boat's length apart, and
// planBoats already keeps opposite directions off the lane at the same time, so a second lane would only have put
// two boats closer together than one lane does.
export const RETURN_WAYPOINTS = Object.freeze([...SAIL_WAYPOINTS].reverse());
// The frontier's crossing is a rail line, and four straight legs meeting at angles no rail could take is not one.
// Sweeping the corners into arcs would have fixed the kinks but not the shape: the sail waypoints go the long way
// round on purpose, since that is what makes a crossing a voyage rather than a hop. So the line runs straight from
// the berth to the jetty instead, about a third of the voyage's length. Everything downstream is already generic
// over whatever journey it is handed, so the gate windows, the lane keeping and the berths needed no touching.
export const STRAIGHT_LANE = Object.freeze([]);

// Which waypoints a pack crosses by. SAIL_WAYPOINTS is still the default, so every other pack keeps the voyage.
export function sailLane(pack = DEFAULT_THEME) {
  return pack === 'west' ? STRAIGHT_LANE : SAIL_WAYPOINTS;
}
const BERTH_NEAR = 4;
// Hulls are 84 wide; boats are planned to stay at least this far apart, centre to centre.
export const BOAT_CLEAR = 96;

export function islandRoute(from, to) {
  const a = { x: px(from), y: py(from) };
  const b = { x: px(to), y: py(to) };
  const onJetty = (p) => p.y < JETTY_FOOT.y - 4 && Math.abs(p.x - JETTY.x) < JETTY.half;
  const pts = [a];
  if (onJetty(a) && !onJetty(b)) pts.push({ x: JETTY_FOOT.x, y: JETTY_FOOT.y });
  if (onJetty(b) && !onJetty(a)) pts.push({ x: JETTY_FOOT.x, y: JETTY_FOOT.y });
  pts.push(b);
  return dedupe(pts, b);
}

function walkLeg(pts, area, dur) {
  return { kind: 'walk', area, pts, dur: dur || walkDuration(routeLength(pts)) };
}

function sailLeg(pts, board, land, fromArea, toArea) {
  const dur = sailDuration(routeLength(pts)) + (board ? HOP_S : 0) + (land ? HOP_S : 0);
  return { kind: 'sail', area: 'water', pts, board, land, fromArea, toArea, dur };
}

// On the pier below the barrier: a walker there has already passed the guard.
function pastBarrier(p) {
  return Math.abs(p.x - PIER.x) <= PIER.half + 4 && p.y > BARRIER.y;
}

// from/to: { x, y, area } with area 'land', 'island' or 'water' (from only: a boat caught mid-voyage).
// Returns legs [{ kind: 'walk' | 'gate' | 'sail', area, pts, dur, ... }]. Walk legs shorter than a pixel are dropped.
// With stamp (a session whose PR merged, leaving the harbour queue), a voyage from land stops at the barrier: the guard
// stamps its passport, then lifts the barrier (a 'gate' leg). Everyone else is waved through without stopping.
export function planJourney(from, to, { stamp = false, lane = SAIL_WAYPOINTS } = {}) {
  const a = { x: px(from), y: py(from) };
  const b = { x: px(to), y: py(to) };
  const fromArea = from.area === 'island' || from.area === 'water' ? from.area : 'land';
  const toArea = to.area === 'island' ? 'island' : 'land';
  const outward = [BOAT_BERTH, ...lane, JETTY_BERTH].map((p) => ({ x: p.x, y: p.y }));
  const legs = [];
  if (fromArea === 'water') {
    const berth = toArea === 'island' ? JETTY_BERTH : BOAT_BERTH;
    const land = toArea === 'island' ? JETTY_END : HARBOUR_BOARD;
    const sail = sailLeg([a, { ...berth }], null, { ...land }, 'water', toArea);
    // A boat already at its berth only hops out, rather than sitting out the shortest sail.
    if (distance(a, berth) < BERTH_NEAR) sail.dur = HOP_S;
    legs.push(sail);
    legs.push(walkLeg(toArea === 'island' ? islandRoute(land, b) : planRoute(land, b), toArea));
  } else if (fromArea === toArea) {
    legs.push(walkLeg(toArea === 'island' ? islandRoute(a, b) : planRoute(a, b), toArea));
  } else if (fromArea === 'land') {
    if (stamp && !pastBarrier(a)) {
      legs.push(walkLeg(planRoute(a, GATE_POINT), 'land'));
      legs.push({ kind: 'gate', mode: 'stamp', area: 'land', pts: [xy(GATE_POINT)], dur: STAMP_S + LIFT_S });
      legs.push(walkLeg([xy(GATE_POINT), xy(HARBOUR_BOARD)], 'land'));
    } else {
      legs.push(walkLeg(planRoute(a, HARBOUR_BOARD), 'land'));
    }
    legs.push(sailLeg(outward, { ...HARBOUR_BOARD }, { ...JETTY_END }, 'land', 'island'));
    legs.push(walkLeg(islandRoute(JETTY_END, b), 'island'));
  } else {
    legs.push(walkLeg(islandRoute(a, JETTY_END), 'island'));
    legs.push(sailLeg(outward.reverse(), { ...JETTY_END }, { ...HARBOUR_BOARD }, 'island', 'land'));
    legs.push(walkLeg(planRoute(HARBOUR_BOARD, b), 'land'));
  }
  return legs.filter((leg) => leg.kind !== 'walk' || routeLength(leg.pts) >= 1);
}

// Position on a journey at time t (seconds). Legs carry t0 once started.
export function journeyAt(journey, t) {
  const legs = journey.legs;
  let leg = legs[legs.length - 1];
  for (const l of legs) {
    if (t < l.t0 + l.dur) {
      leg = l;
      break;
    }
  }
  const local = clamp(t - leg.t0, 0, leg.dur);
  const p = leg.dur > 0 ? local / leg.dur : 1;
  const out = {
    x: leg.pts[0].x, y: leg.pts[0].y, alpha: 1, walking: false, inBoat: false, boat: null, dir: 0, dist: 0,
    area: leg.area, kind: leg.kind, done: t >= journey.end,
  };
  if (leg.kind === 'walk') {
    const pos = routeAt(leg.route, easeInOut(p));
    // A walk held back (waiting its turn at the barrier) stands still until it starts.
    Object.assign(out, { x: pos.x, y: pos.y, dir: pos.dir, dist: pos.dist, walking: t >= leg.t0 });
    if (leg.fadeOut && p > 0.6) out.alpha = clamp(1 - (p - 0.6) / 0.4, 0, 1);
    if (out.done && leg.fadeOut) out.alpha = 0;
  } else if (leg.kind === 'appear') {
    out.alpha = p;
  } else if (leg.kind === 'wait') {
    out.dir = 0;
  } else if (leg.kind === 'gate') {
    // Facing the guard, passport held out: stamped STAMP_S in, then the barrier lifts.
    out.dir = 1;
    out.gate = { mode: leg.mode, local, stamped: local >= STAMP_STRIKE * STAMP_S };
  } else if (leg.kind === 'fade') {
    out.alpha = 1 - p;
  } else if (leg.kind === 'sail') {
    const hopIn = leg.board ? HOP_S : 0;
    const hopOut = leg.land ? HOP_S : 0;
    const sailFor = Math.max(1e-3, leg.dur - hopIn - hopOut);
    const start = leg.pts[0];
    const end = leg.pts[leg.pts.length - 1];
    if (local < hopIn) {
      const k = local / hopIn;
      out.x = lerp(leg.board.x, start.x, k);
      out.y = lerp(leg.board.y, start.y, k) - Math.sin(Math.PI * k) * 14;
      out.dir = Math.sign(start.x - leg.board.x);
      out.walking = local > 0;
      out.area = leg.fromArea;
      // Waiting on the pier for its turn: the boat ahead is still leaving, so this one is not drawn yet.
      if (t >= leg.t0) out.boat = { x: start.x, y: start.y, dir: Math.sign(leg.pts[1].x - start.x) || 1, sail: false, hx: 0, hy: 0 };
    } else if (local <= hopIn + sailFor || !leg.land) {
      const pos = routeAt(leg.route, easeInOut(clamp((local - hopIn) / sailFor, 0, 1)));
      Object.assign(out, { x: pos.x, y: pos.y, dir: pos.dir, inBoat: true, area: 'water' });
      out.boat = { x: pos.x, y: pos.y, dir: pos.dir || 1, sail: true, hx: pos.hx, hy: pos.hy };
    } else {
      const k = clamp((local - hopIn - sailFor) / hopOut, 0, 1);
      out.x = lerp(end.x, leg.land.x, k);
      out.y = lerp(end.y, leg.land.y, k) - Math.sin(Math.PI * k) * 14;
      out.dir = Math.sign(leg.land.x - end.x);
      out.walking = true;
      out.area = k >= 1 ? leg.toArea : 'water';
      out.boat = { x: end.x, y: end.y, dir: Math.sign(end.x - leg.pts[leg.pts.length - 2].x) || 1, sail: false, hx: 0, hy: 0 };
    }
  }
  return out;
}

const xy = (p) => ({ x: p.x, y: p.y });

// Where a walk leg's route crosses the barrier line on the pier, as the share of the leg's time (its ease undone), or
// null when it does not cross. Cached on the leg, whose points never change.
export function barrierCrossing(leg) {
  if (!leg || leg.kind !== 'walk' || !Array.isArray(leg.pts) || leg.pts.length < 2) return null;
  if (leg.barrierP !== undefined) return leg.barrierP;
  const total = routeLength(leg.pts);
  let along = 0;
  let found = null;
  for (let i = 1; i < leg.pts.length && found === null; i++) {
    const a = leg.pts[i - 1];
    const b = leg.pts[i];
    const seg = distance(a, b);
    if (a.y !== b.y && (a.y - BARRIER.y) * (b.y - BARRIER.y) <= 0 && a.y !== BARRIER.y) {
      const f = (BARRIER.y - a.y) / (b.y - a.y);
      if (Math.abs(a.x + (b.x - a.x) * f - PIER.x) <= PIER.half + 4) found = along + seg * f;
    }
    along += seg;
  }
  const p = found === null || !(total > 0) ? null : Math.acos(clamp(1 - (2 * found) / total, -1, 1)) / Math.PI;
  leg.barrierP = p;
  return p;
}

// When the barrier moves for a journey: [{ up0, up1, down0, down1 }] where it rises from up0 to up1 and falls from
// down0 to down1. A stamp gate leg lifts it once the stamp is done and keeps it up until its walker is through; any
// other walk that crosses the line has it fully up just before the walker's feet reach it.
export function barrierWindows(journey) {
  const out = [];
  const legs = journey && Array.isArray(journey.legs) ? journey.legs : [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.kind === 'gate') {
      const up1 = leg.t0 + leg.dur;
      const next = legs[i + 1];
      const p = barrierCrossing(next);
      const pass = p === null ? up1 : next.t0 + p * next.dur;
      const down0 = Math.max(up1, pass + BARRIER_CLEAR_S);
      out.push({ up0: up1 - LIFT_S, up1, down0, down1: down0 + LIFT_S, stampAt: leg.t0 });
      if (p !== null) i += 1;
      continue;
    }
    const p = barrierCrossing(leg);
    if (p === null) continue;
    const tc = leg.t0 + p * leg.dur;
    out.push({ up0: tc - BARRIER_LEAD_S - LIFT_S, up1: tc - BARRIER_LEAD_S, down0: tc + BARRIER_CLEAR_S, down1: tc + BARRIER_CLEAR_S + LIFT_S });
  }
  return out;
}

// How far up the barrier is at time t, 0 (down) to 1 (up), given every journey's windows.
export function barrierLift(windows, t) {
  let lift = 0;
  for (const w of windows) {
    if (!(t >= w.up0 && t < w.down1)) continue;
    let v = 1;
    if (t < w.up1) v = easeInOut(clamp((t - w.up0) / Math.max(1e-6, w.up1 - w.up0), 0, 1));
    else if (t >= w.down0) v = 1 - easeInOut(clamp((t - w.down0) / Math.max(1e-6, w.down1 - w.down0), 0, 1));
    lift = Math.max(lift, v);
  }
  return lift;
}

// Holds a stamp journey back, whole, until no other stamp still has the gate point: its walker then waits where it
// stands. Returns the delay in seconds.
export function holdForGate(journey, others) {
  const own = journey && journey.legs.find((l) => l.kind === 'gate');
  if (!own) return 0;
  const busy = [];
  for (const o of others || []) {
    if (!o || o === journey || !Array.isArray(o.legs)) continue;
    for (const g of o.legs) if (g.kind === 'gate') busy.push([g.t0, g.t0 + g.dur + GATE_CLEAR_S]);
  }
  let total = 0;
  for (let guard = 0; guard < 100; guard++) {
    const at = own.t0;
    const clash = busy.find(([t0, t1]) => at < t1 && t0 < at + own.dur + GATE_CLEAR_S);
    if (!clash) break;
    const shift = clash[1] - at;
    for (const l of journey.legs) l.t0 += shift;
    journey.t0 += shift;
    journey.end += shift;
    total += shift;
  }
  return total;
}

// The empty boat trips a scheduled journey needs: after a passenger lands on the island the boat sails back to the
// pier, and before a passenger leaves the island a boat sails out to fetch it. A fetch that cannot reach the jetty in
// time (the walk there is shorter than the sail) makes the passenger wait at the jetty end, so the journey is changed
// in place. Returns [{ kind: 'return' | 'fetch', pts, route, t0, dur }].
export function scheduleFerries(journey, now, lane = SAIL_WAYPOINTS) {
  const trips = [];
  const back10 = [...lane].reverse();
  const legs = journey.legs;
  const trip = (kind, pts) => ({ kind, pts, route: makeRoute(pts), t0: 0, dur: sailDuration(routeLength(pts)) });
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.kind !== 'sail') continue;
    if (leg.toArea === 'island') {
      const end = leg.pts[leg.pts.length - 1];
      const back = trip('return', [xy(end), ...back10.map(xy), xy(BOAT_BERTH)]);
      back.t0 = leg.t0 + leg.dur;
      trips.push(back);
    } else if (leg.fromArea === 'island' && leg.board) {
      const fetch = trip('fetch', [xy(BOAT_BERTH), ...lane.map(xy), xy(leg.pts[0])]);
      const late = now - (leg.t0 - fetch.dur);
      if (late > 1e-9) {
        const wait = { kind: 'wait', area: leg.fromArea, pts: [xy(leg.board)], dur: late, t0: leg.t0 };
        wait.route = makeRoute(wait.pts);
        for (let k = i; k < legs.length; k++) legs[k].t0 += late;
        journey.end += late;
        legs.splice(i, 0, wait);
        i += 1;
      }
      fetch.t0 = leg.t0 - fetch.dur;
      trips.push(fetch);
    }
  }
  return trips;
}

// Empty boats either sail the lane ('return' to the pier, 'fetch' to the jetty) or stay at the jetty berth: a boat that
// cannot sail home without crossing another boat fades there ('fade'), and one that cannot come out appears there
// ('appear'). The pier's own moored boat stands in for either, as a fresh boat waiting.
const LANE_OF = Object.freeze({ return: 'in', fetch: 'out' });

export function berthEvents(journey, trips = []) {
  const out = [];
  for (const l of journey ? journey.legs : []) {
    if (l.kind !== 'sail') continue;
    if (l.board) out.push({ berth: l.fromArea === 'island' ? 'jetty' : 'pier', t: l.t0 });
    if (l.land) out.push({ berth: l.toArea === 'island' ? 'jetty' : 'pier', t: l.t0 + l.dur });
  }
  for (const f of trips) {
    if (f.kind === 'fade' || f.kind === 'appear') {
      out.push({ berth: 'jetty', t: f.t0 }, { berth: 'jetty', t: f.t0 + f.dur });
      continue;
    }
    const from = f.kind === 'return' ? 'jetty' : 'pier';
    out.push({ berth: from, t: f.t0 }, { berth: from === 'jetty' ? 'pier' : 'jetty', t: f.t0 + f.dur });
  }
  return out;
}

// When boats are out on the lane, and which way: 'out' to the island, 'in' to the pier.
export function laneWindows(journey, trips = []) {
  const out = [];
  for (const l of journey ? journey.legs : []) {
    if (l.kind === 'sail') out.push({ dir: l.toArea === 'island' ? 'out' : 'in', t0: l.t0, t1: l.t0 + l.dur, trip: null });
  }
  for (const f of trips) if (LANE_OF[f.kind]) out.push({ dir: LANE_OF[f.kind], t0: f.t0, t1: f.t0 + f.dur, trip: f });
  return out;
}

// Turns an empty trip into a boat that stays at the jetty: a return fades where its passenger landed, a fetch
// appears at the jetty berth just before its passenger boards.
export function keepAtJetty(trip) {
  if (trip.kind === 'return') {
    Object.assign(trip, { kind: 'fade', pts: [xy(trip.pts[0])], dur: FADE_S });
  } else if (trip.kind === 'fetch') {
    Object.assign(trip, { kind: 'appear', pts: [xy(trip.pts[trip.pts.length - 1])], t0: trip.t0 + trip.dur - APPEAR_S, dur: APPEAR_S });
  }
  trip.route = makeRoute(trip.pts);
  return trip;
}

// Plans a boarding voyage around the boats already about, so no two boats are ever drawn on top of each other:
// - two boats never use one berth within SAIL_GAP_S of each other, and a voyage never sails against a boat already
//   under way, so the voyage (with its empty trips) is held back and its passenger waits at the pier tip or jetty end;
// - an empty trip that has not started and would cross this voyage stays at the jetty instead (keepAtJetty), and so
//   does this voyage's own empty trip when it would cross another boat.
// others: { journeys: [scheduled journeys], ferries: [trips] }; their trips may be changed. Returns the delay.
export function planBoats(journey, trips, others, now) {
  const i = journey.legs.findIndex((l) => l.kind === 'sail' && l.board);
  if (i < 0) return 0;
  const theirJourneys = (others && others.journeys) || [];
  const theirTrips = (others && others.ferries) || [];
  const crosses = (a, b) => a.dir !== b.dir && a.t0 < b.t1 && b.t0 < a.t1;
  let total = 0;
  for (let guard = 0; guard < 400; guard++) {
    const theirEvents = [...theirJourneys.flatMap((j) => berthEvents(j)), ...berthEvents(null, theirTrips)];
    const theirLanes = [...theirJourneys.flatMap((j) => laneWindows(j)), ...laneWindows(null, theirTrips)];
    let shift = 0;
    for (const e of berthEvents(journey, trips)) {
      for (const o of theirEvents) {
        if (e.berth === o.berth && Math.abs(e.t - o.t) < SAIL_GAP_S - 1e-9) shift = Math.max(shift, o.t + SAIL_GAP_S - e.t);
      }
    }
    let changed = false;
    for (const m of laneWindows(journey)) {
      for (const o of theirLanes) {
        if (!crosses(m, o)) continue;
        if (o.trip && o.trip.t0 > now) {
          keepAtJetty(o.trip);
          changed = true;
        } else {
          shift = Math.max(shift, o.t1 + SAIL_GAP_S - m.t0);
        }
      }
    }
    if (shift > 1e-9) {
      for (let k = i; k < journey.legs.length; k++) journey.legs[k].t0 += shift;
      journey.end += shift;
      for (const f of trips) f.t0 += shift;
      total += shift;
      continue;
    }
    for (const f of trips) {
      const own = laneWindows(null, [f])[0];
      if (own && theirLanes.some((o) => crosses(own, o))) {
        keepAtJetty(f);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return total;
}

// Where an empty boat is at time t, or null outside its trip. A boat kept at the jetty fades out or in there.
export function ferryAt(trip, t) {
  if (t < trip.t0 || t >= trip.t0 + trip.dur) return null;
  const p = clamp((t - trip.t0) / trip.dur, 0, 1);
  if (trip.kind === 'fade' || trip.kind === 'appear') {
    const at = trip.pts[0];
    return { x: at.x, y: at.y, dir: 1, sail: false, hx: 0, hy: 0, alpha: trip.kind === 'fade' ? 1 - p : p };
  }
  const pos = routeAt(trip.route, easeInOut(p));
  return { x: pos.x, y: pos.y, dir: pos.dir || 1, sail: true, hx: pos.hx, hy: pos.hy, alpha: 1 };
}

// Stamps start times on legs (optionally wrapped in an appear and a fade) and returns the journey.
export function scheduleJourney(legs, t0, { appear = null, fade = false, fadeArea = null } = {}) {
  const out = [];
  if (appear) out.push({ kind: 'appear', area: appear.area, pts: [{ x: appear.x, y: appear.y }], dur: APPEAR_S });
  out.push(...legs);
  const last = out.length ? out[out.length - 1] : null;
  if (fade && last) {
    const end = last.kind === 'sail' ? last.land || last.pts[last.pts.length - 1] : last.pts[last.pts.length - 1];
    out.push({ kind: 'fade', area: fadeArea || last.area, pts: [{ x: end.x, y: end.y }], dur: FADE_S });
  }
  let at = t0;
  for (const leg of out) {
    leg.t0 = at;
    leg.route = makeRoute(leg.pts);
    at += leg.dur;
  }
  const final = out.length ? out[out.length - 1] : null;
  const toArea = final ? (final.kind === 'sail' ? final.toArea : final.area) : 'land';
  return { legs: out, t0, end: at, toArea };
}

// Moves where a journey still on its way ends, keeping every leg before its final walk: walking to the pier, waiting
// there and crossing all go on as planned. False when the final walk has started or lies in another area, since only
// a fresh plan can get there. With fade, the journey ends by fading at `to` (a door or gate).
export function retargetJourney(journey, to, t, { fade = false } = {}) {
  if (!journey) return false;
  let k = journey.legs.length - 1;
  while (k >= 0 && journey.legs[k].kind === 'fade') k -= 1;
  const last = journey.legs[k];
  const area = to.area === 'island' ? 'island' : 'land';
  if (!last || last.kind !== 'walk' || last.fadeOut || last.area !== area || t >= last.t0) return false;
  const pts = area === 'island' ? islandRoute(last.pts[0], to) : planRoute(last.pts[0], to);
  const walk = { ...walkLeg(pts, area), t0: last.t0, route: makeRoute(pts) };
  const legs = [...journey.legs.slice(0, k), walk];
  if (fade) {
    const at = [{ x: px(to), y: py(to) }];
    legs.push({ kind: 'fade', area, pts: at, route: makeRoute(at), t0: walk.t0 + walk.dur, dur: FADE_S });
  }
  const end = legs[legs.length - 1];
  Object.assign(journey, { legs, end: end.t0 + end.dur, toArea: area });
  return true;
}

// The trips an owner keeps once its plans change: those under way. A boat already out fetching it still reaches the
// jetty, then fades there. Returns the new list.
export function cancelTrips(ferries, owner, t) {
  const kept = [];
  for (const f of ferries) {
    if (f.owner !== owner) kept.push(f);
    else if (f.t0 <= t) {
      kept.push(f);
      if ((f.kind === 'fetch' || f.kind === 'appear') && !f.homeBound) {
        f.homeBound = true;
        const at = xy(f.route.pts[f.route.pts.length - 1]);
        kept.push({ owner: null, kind: 'fade', pts: [at], route: makeRoute([at]), t0: f.t0 + f.dur, dur: FADE_S });
      }
    }
  }
  return kept;
}

const TURN_HOLDS = Object.freeze([0, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8]);
const CLEAR_STEP_S = 0.02;
const crossing = (a, b) => a.dir !== b.dir && a.t0 < b.t1 && b.t0 < a.t1;

// Whether every boat that can still be re-planned (the listed journeys, and every trip not yet under way) stays
// BOAT_CLEAR from every other boat from t until the last of them is done, sampled every CLEAR_STEP_S.
export function boatsKeepClear(journeys, mine, ferries, t) {
  const afloat = journeys.filter((j) => j.legs.some((l) => l.kind === 'sail'));
  const movable = (f) => f.t0 > t;
  let end = t;
  for (const j of afloat) if (mine.has(j)) end = Math.max(end, j.end);
  for (const f of ferries) if (movable(f)) end = Math.max(end, f.t0 + f.dur);
  for (let s = t; s <= end + 1e-9; s += CLEAR_STEP_S) {
    const ours = [];
    const theirs = [];
    for (const j of afloat) {
      if (s >= j.end) continue;
      const b = journeyAt(j, s).boat;
      if (b) (mine.has(j) ? ours : theirs).push(b);
    }
    for (const f of ferries) {
      const b = ferryAt(f, s);
      if (b && b.alpha >= 0.35) (movable(f) ? ours : theirs).push(b);
    }
    for (let i = 0; i < ours.length; i++) {
      for (let k = i + 1; k < ours.length; k++) if (distance(ours[i], ours[k]) < BOAT_CLEAR) return false;
      for (const b of theirs) if (distance(ours[i], b) < BOAT_CLEAR) return false;
    }
  }
  return true;
}

// A passenger whose destination changes while it is out on the water in its boat (boat: where that boat is now; was:
// its journey). It turns the boat where it is, held there as long as needed, and every voyage that has not boarded yet
// waits for it. When no hold keeps every boat clear (a boat that set off behind it on the same lane is coming its way),
// it finishes its crossing instead: `pending` is where to go once it has landed.
// others: [{ id, journey }] for every other character with a journey; ferries: owner-tagged trips. Other journeys and
// trips may be changed. Returns { journey, pending, ferries }.
export function turnBack({ id, boat, journey: was, to, opts = {}, lane = SAIL_WAYPOINTS }, others, ferries, t) {
  const withOthers = others.filter((o) => o.id !== id && o.journey);
  const boarding = (j) => j.legs.find((l) => l.kind === 'sail' && l.board);
  const waiting = withOthers
    .filter((o) => {
      const sail = boarding(o.journey);
      return sail && sail.t0 > t && !ferries.some((f) => f.owner === o.id && f.t0 <= t && t < f.t0 + f.dur);
    })
    .sort((a, b) => boarding(a.journey).t0 - boarding(b.journey).t0);
  const saved = ferries.map((f) => [f, { ...f }]);
  const timings = waiting.map((o) => [o.journey, o.journey.end, o.journey.legs.map((l) => l.t0)]);
  const restore = () => {
    for (const [f, copy] of saved) {
      for (const key of Object.keys(f)) if (!(key in copy)) delete f[key];
      Object.assign(f, copy);
    }
    for (const [j, end, t0s] of timings) {
      j.end = end;
      j.legs.forEach((l, i) => { l.t0 = t0s[i]; });
    }
    return saved.map(([f]) => f);
  };

  for (const hold of TURN_HOLDS) {
    let fleet = cancelTrips(restore(), id, t);
    const journey = scheduleJourney(planJourney({ x: boat.x, y: boat.y, area: 'water' }, to, { lane }), t + hold, opts);
    const trips = scheduleFerries(journey, t, lane).map((trip) => ({ owner: id, ...trip }));
    const mineLanes = laneWindows(journey);
    for (const f of fleet) {
      const window = f.t0 > t ? laneWindows(null, [f])[0] : null;
      if (window && mineLanes.some((m) => crossing(m, window))) keepAtJetty(f);
    }
    const theirLanes = [...withOthers.flatMap((o) => laneWindows(o.journey)), ...laneWindows(null, fleet)];
    for (const f of trips) {
      const lane = laneWindows(null, [f])[0];
      if (lane && theirLanes.some((o) => crossing(lane, o))) keepAtJetty(f);
    }
    fleet = [...fleet, ...trips];
    const journeys = [journey, ...withOthers.map((o) => o.journey)];
    for (const o of waiting) {
      const own = fleet.filter((f) => f.owner === o.id && f.t0 > t);
      planBoats(o.journey, own, { journeys: journeys.filter((j) => j !== o.journey), ferries: fleet.filter((f) => !own.includes(f)) }, t);
    }
    if (boatsKeepClear(journeys, new Set([journey, ...waiting.map((o) => o.journey)]), fleet, t)) {
      return { journey, pending: null, ferries: fleet };
    }
  }

  const fleet = restore();
  const k = was.legs.findIndex((l) => t < l.t0 + l.dur);
  const legs = k < 0 ? was.legs.slice() : was.legs.slice(0, k + 1);
  const last = legs[legs.length - 1];
  const journey = { ...was, legs, end: last.t0 + last.dur, toArea: last.kind === 'sail' ? last.toArea : last.area };
  return { journey, pending: { to, opts }, ferries: fleet };
}

function hammerPhase(t, phase) {
  return ((t + phase * HAMMER_PERIOD) % HAMMER_PERIOD) / HAMMER_PERIOD;
}

function hammerAngle(p) {
  if (p < 0.72) {
    const k = p / 0.72;
    return HAMMER_STRIKE + (HAMMER_RAISED - HAMMER_STRIKE) * (1 - (1 - k) * (1 - k));
  }
  const k = (p - 0.72) / 0.28;
  return HAMMER_RAISED + (HAMMER_STRIKE - HAMMER_RAISED) * k * k;
}

// 0 at rest, rising to 1 while the glass is at the mouth, on a slow clock of its own per character.
export function sipAmount(t, phase) {
  const cyc = (t + phase * SIP_PERIOD) % SIP_PERIOD;
  if (cyc >= SIP_S) return 0;
  return Math.sin((cyc / SIP_S) * Math.PI) ** 0.6;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Decor themes: muted naturals only
// ---------------------------------------------------------------------------------------------

// The border patrol's uniform, barrier and booth: khaki, navy-black and white, each clear of every reserved state colour.
export const PATROL_COLOURS = Object.freeze({
  day: Object.freeze({ khaki: '#b9a46f', khakiShade: '#8e7b4c', navy: '#1c2433', white: '#fbfaf5' }),
  dusk: Object.freeze({ khaki: '#9c8b5e', khakiShade: '#6f6140', navy: '#161c28', white: '#e6dcc3' }),
});

const THEMES = {
  day: {
    grass: '#b8caa1', grassLight: '#c7d6b1', grassDark: '#a8bc90', tuft: '#98ad82',
    path: '#e7dcc3', pathEdge: '#cfc1a2', pebble: '#d3c5a6',
    sand: '#e6dbbf', water: '#a3c7cc', waterDeep: '#91b9c0', ripple: '#d2e6e8', shallow: '#b9d7d6', foam: 'rgba(255, 255, 255, 0.75)',
    wood: '#a98563', woodDark: '#7a5c42', woodLight: '#cdb08b', plank: '#b39070',
    wall: '#f1e8d8', wallShade: '#dfd2bb', roofs: ['#9a7a6c', '#7e8d95', '#a18f72', '#8b7e92'],
    windowDark: '#8e9aa1', windowLit: '#f6e0a6', door: '#8a6a52', porchWindow: '#8e9aa1',
    stone: '#c9c2b5', stoneDark: '#a39c90', steel: '#8a9096',
    tree: '#8dad85', treeDark: '#789873', treeLight: '#a7c29b', trunk: '#8b6c50',
    flowers: ['#d8c6e2', '#f4eedc', '#e2c8c8', '#c8d5e7'],
    lighthouse: '#ece7db', slate: '#7c8a96', lanternGlass: '#ddd6c3', cat: '#8f8176',
    towerStone: '#ece7db', towerEdge: '#7c8a96', beamLight: '246, 222, 160',
    shadow: 'rgba(45, 50, 38, 0.17)',
    signBoard: '#ebdec4', signBorder: '#86664a', signText: '#3a3027', signMuted: '#65594b',
    plateBg: 'rgba(255, 255, 255, 0.96)', plateBorder: 'rgba(33, 37, 41, 0.2)', plateText: '#212529', plateMuted: '#565e66',
    bubble: '#ffffff', ink: '#3b3a36', smoke: '112, 112, 112',
    selectOuter: 'rgba(33, 37, 41, 0.55)', selectInner: 'rgba(255, 255, 255, 0.95)', halo: 'rgba(255, 255, 255, 0.45)',
    fireflies: false,
    sandLight: '#f0e5c8', sandWet: '#d9c9a3', sandDot: '#dccda9', dune: '#b9c08e',
    castle: '#e6d2a3', castleShade: '#d0ba89', castleDark: '#a88e61', castleDoor: '#6b5540',
    shell: '#f2dcd3', shellEdge: '#c7a296', starfish: '#dca58a',
    stripeBase: '#f6eedc', stripes: ['#8fb4b1', '#d29c84', '#a7a4c4', '#c9b370'],
    palm: '#86a874', palmDark: '#6b8e5d', palmTrunk: '#aa8862', palmRing: '#8c6c4c', coconut: '#7b5b3f',
    thatch: '#cfae6f', thatchDark: '#a98a55', bamboo: '#cbb57f',
    glass: 'rgba(255, 255, 255, 0.85)', glassEdge: 'rgba(96, 110, 110, 0.75)', drink: '#dfe9ad', lime: '#9fc06e',
    flag: '#cf9479', flagAlt: '#efe3c6', sailCloth: '#f7f1e2',
    graveGrass: '#adbf98', graveStone: '#c3bfb5', graveStoneLight: '#d6d2c8', graveEdge: '#8e8a80', moss: '#93a77c',
    graveMound: '#9aae86', fence: '#a18a6c', fenceDark: '#6f5c47', yew: '#6f8c6b', yewDark: '#5a7657', ghost: '236, 241, 248',
    hallWall: '#e8d5aa', hallBrick: '#dcc697', hallBrickEdge: '#c9b180', hallFloor: '#eee0bd', hallFloorLine: '#dccb9f',
    roomWall: '#f0e2c8', roomWallShade: '#ddcba9', roomFloor: '#c79a63', roomFloorLine: '#ab7f4b', rug: '#a8544a',
    hallSky: '#cfe3e4', hallSea: '#9fc4c7', torchIron: '#5f5244', flame: '#f4cf78', flameCore: '#fcf0c8',
    tapestry: '#c7b28a', tapestryEdge: '#8e7a55',
    baize: '#5c8163', baizeEdge: '#3f5c46', coin: '#d8b45c', coinEdge: '#a07f32',
    patrolKhaki: PATROL_COLOURS.day.khaki, patrolKhakiShade: PATROL_COLOURS.day.khakiShade,
    patrolNavy: PATROL_COLOURS.day.navy, patrolWhite: PATROL_COLOURS.day.white,
  },
  dusk: {
    grass: '#2d3b32', grassLight: '#35453a', grassDark: '#27332b', tuft: '#3c4c41',
    path: '#4e4940', pathEdge: '#3e3a33', pebble: '#5a554c',
    sand: '#4b463a', water: '#243a46', waterDeep: '#1d313c', ripple: '#3c5865', shallow: '#2c4650', foam: 'rgba(210, 225, 230, 0.35)',
    wood: '#6f5742', woodDark: '#4b3a2c', woodLight: '#8b7056', plank: '#7b624b',
    wall: '#605a50', wallShade: '#514c43', roofs: ['#5a4648', '#465059', '#5b5141', '#4f4659'],
    windowDark: '#2e3942', windowLit: '#f3d690', door: '#473829', porchWindow: '#e8c985',
    stone: '#625e57', stoneDark: '#4c4842', steel: '#747a80',
    tree: '#36493c', treeDark: '#2d3e32', treeLight: '#41584a', trunk: '#4e3e30',
    flowers: ['#8f7fa1', '#b9b3a2', '#a08989', '#8898ad'],
    lighthouse: '#9a958b', slate: '#56616b', lanternGlass: '#6a665b', cat: '#6f655d',
    towerStone: '#9a958b', towerEdge: '#56616b', beamLight: '246, 222, 160',
    shadow: 'rgba(0, 0, 0, 0.3)',
    signBoard: '#d9caab', signBorder: '#5c4530', signText: '#2e261e', signMuted: '#5c5144',
    plateBg: 'rgba(33, 37, 41, 0.95)', plateBorder: 'rgba(255, 255, 255, 0.2)', plateText: '#f1f3f5', plateMuted: '#b4bcc4',
    bubble: '#f1f3f5', ink: '#1f1d1a', smoke: '205, 205, 205',
    selectOuter: 'rgba(0, 0, 0, 0.55)', selectInner: 'rgba(255, 255, 255, 0.9)', halo: 'rgba(255, 255, 255, 0.18)',
    fireflies: true,
    sandLight: '#595241', sandWet: '#474135', sandDot: '#4f493b', dune: '#3f4a38',
    castle: '#6e6451', castleShade: '#5d5444', castleDark: '#433c30', castleDoor: '#231f19',
    shell: '#8a7a74', shellEdge: '#5e524d', starfish: '#86695a',
    stripeBase: '#77705f', stripes: ['#4b6563', '#7a5b4d', '#5c5a73', '#766a44'],
    palm: '#3d5439', palmDark: '#304530', palmTrunk: '#5d4a36', palmRing: '#45372a', coconut: '#3e3024',
    thatch: '#6f5e3e', thatchDark: '#54472f', bamboo: '#6c5f43',
    glass: 'rgba(225, 230, 235, 0.55)', glassEdge: 'rgba(210, 220, 220, 0.55)', drink: '#8e9a66', lime: '#6c8449',
    flag: '#8a6353', flagAlt: '#a39b87', sailCloth: '#b9b3a3',
    graveGrass: '#29362d', graveStone: '#69665f', graveStoneLight: '#7b7870', graveEdge: '#45433e', moss: '#46583f',
    graveMound: '#26322a', fence: '#5d4e3d', fenceDark: '#3b3128', yew: '#2c3d31', yewDark: '#223128', ghost: '214, 226, 240',
    hallWall: '#5f5646', hallBrick: '#554d3e', hallBrickEdge: '#473f33', hallFloor: '#4f483b', hallFloorLine: '#433d32',
    roomWall: '#544c3d', roomWallShade: '#463f33', roomFloor: '#5a452e', roomFloorLine: '#493626', rug: '#6e3a35',
    hallSky: '#34475a', hallSea: '#233847', torchIron: '#2b2620', flame: '#f1c86c', flameCore: '#fbe7b0',
    tapestry: '#6b5f49', tapestryEdge: '#473d2d',
    baize: '#38503e', baizeEdge: '#26382b', coin: '#9c8144', coinEdge: '#6d5827',
    patrolKhaki: PATROL_COLOURS.dusk.khaki, patrolKhakiShade: PATROL_COLOURS.dusk.khakiShade,
    patrolNavy: PATROL_COLOURS.dusk.navy, patrolWhite: PATROL_COLOURS.dusk.white,
  },
};

// ---------------------------------------------------------------------------------------------
// Theme packs
// ---------------------------------------------------------------------------------------------

// A pack is a name, a set of colours laid over the base day and dusk themes, and the words painted on the place
// boards and over an interior's door. It changes paint and lettering only. Lanes, spots, footings, hit boxes and
// journeys are the same objects in every pack, which is why the Board's columns, the Repos legend and the count
// pills read the same whichever one is picked. A pack that leaves a colour out keeps the base theme's.
//
// Adding a pack: give it a key, a name, the two override maps, and any board names it renames. `themeChecks` in
// tests/web_harness.mjs then holds it to the same contrast and containment rules as the others, so a pack cannot
// ship a board nobody can read or a saguaro hanging off its island.

// The frontier town. Its ground colours point at dry ground and its sea colours at cracked flats, which is what
// repaints the water, the island and both interiors without a line of drawing code. Only what stayed nautical is
// branched on `env.west`: the shells, the starfish, the ripples, the palm and the lighthouse.
const WEST_DAY = {
  grass: '#d9c49a', grassLight: '#e3d1ab', grassDark: '#c6ad80', tuft: '#b49a70',
  path: '#e9ddc0', pathEdge: '#cbb894', pebble: '#cdba96',
  sand: '#e4d2a8', sandLight: '#eee0bb', sandWet: '#d2bc90', sandDot: '#dccaa2', dune: '#c6b083',
  water: '#cbb68d', waterDeep: '#bca57a', ripple: '#dbc99f', shallow: '#d3bf94', foam: 'rgba(255, 249, 233, 0.6)',
  wood: '#a8835f', woodDark: '#77593d', woodLight: '#c9ad86', plank: '#b08c66',
  wall: '#e8d7b6', wallShade: '#d2be98', roofs: ['#9c6f57', '#8c7c6a', '#a8855f', '#7f6b57'],
  windowDark: '#8d8477', porchWindow: '#8d8477', door: '#7c5a3f',
  stone: '#c6b699', stoneDark: '#9d8d72',
  tree: '#7f9a6b', treeDark: '#67805a', treeLight: '#96ae7e', trunk: '#8b6c50',
  flowers: ['#e0b2bf', '#f4eedc', '#dcab79', '#c7b0d4'],
  lighthouse: '#d9c6a4', slate: '#8a7b66', cat: '#8f8176',
  towerStone: '#d9c6a4', towerEdge: '#8a7b66',
  shadow: 'rgba(84, 62, 36, 0.18)',
  signBoard: '#e7d7b4', signBorder: '#7d5a38', signText: '#3a2f22', signMuted: '#6a5a45',
  castle: '#c98f62', castleShade: '#ae7850', castleDark: '#875a3a', castleDoor: '#4a3526',
  shell: '#e0cbb0', shellEdge: '#b89878', starfish: '#cf8f63',
  stripeBase: '#f2e6cd', stripes: ['#a4785a', '#c4a06a', '#8d8d72', '#b5673f'],
  palm: '#7f9a6b', palmDark: '#67805a', palmTrunk: '#8f7450', palmRing: '#74593c', coconut: '#6b512f',
  thatch: '#c9a468', thatchDark: '#a1803f', bamboo: '#c2ac78',
  drink: '#c9923f',
  flag: '#b5673f', flagAlt: '#efe3c6', sailCloth: '#efe0c2',
  graveGrass: '#c3ad84', graveMound: '#b49b72', moss: '#9a8f66',
  graveStone: '#c0b39d', graveStoneLight: '#d3c7b2', graveEdge: '#8b8070',
  fence: '#a8875f', fenceDark: '#735a3c', yew: '#7c8f66', yewDark: '#64764f',
  hallWall: '#c9a577', hallBrick: '#bb9668', hallBrickEdge: '#a17d52', hallFloor: '#b08d63', hallFloorLine: '#977650',
  roomWall: '#e9dcc0', roomWallShade: '#d5c5a1', roomFloor: '#a97d4e', roomFloorLine: '#8b6137', rug: '#8a4a3c',
  hallSky: '#cfe1ea', hallSea: '#cbb68d',
  tapestry: '#bfa377', tapestryEdge: '#8a7047',
  baize: '#5a7f5f', baizeEdge: '#3d5a43',
};

const WEST_DUSK = {
  grass: '#3a3227', grassLight: '#443b2e', grassDark: '#322b21', tuft: '#4a4032',
  path: '#4f4739', pathEdge: '#3f382d', pebble: '#5a5142',
  sand: '#4b4234', sandLight: '#584e3d', sandWet: '#443c30', sandDot: '#4e4536', dune: '#463f31',
  water: '#3a3227', waterDeep: '#2e2820', ripple: '#4a4133', shallow: '#413930', foam: 'rgba(226, 214, 190, 0.28)',
  wood: '#6f5742', woodDark: '#4b3a2c', woodLight: '#8b7056', plank: '#7b624b',
  wall: '#5e5344', wallShade: '#4f4639', roofs: ['#5a4238', '#4c453b', '#5b4b36', '#4a3f33'],
  windowDark: '#332c24', porchWindow: '#e8c985', door: '#40301f',
  stone: '#625849', stoneDark: '#4b4337',
  tree: '#38492f', treeDark: '#2d3b27', treeLight: '#44583a', trunk: '#4e3e30',
  flowers: ['#8e7480', '#b9b3a2', '#93765a', '#7f7391'],
  lighthouse: '#968a76', slate: '#5e5344', cat: '#6f655d',
  towerStone: '#968a76', towerEdge: '#5e5344',
  shadow: 'rgba(0, 0, 0, 0.32)',
  signBoard: '#d9caab', signBorder: '#54402a', signText: '#2e261e', signMuted: '#5c5144',
  castle: '#6d5340', castleShade: '#5b4534', castleDark: '#402f23', castleDoor: '#201913',
  shell: '#857363', shellEdge: '#5a4c3f', starfish: '#84644b',
  stripeBase: '#726752', stripes: ['#5b4436', '#6b573b', '#54513f', '#6a4030'],
  palm: '#3f5033', palmDark: '#32412b', palmTrunk: '#5a4632', palmRing: '#433527', coconut: '#3c2e21',
  thatch: '#6c5a39', thatchDark: '#52442b', bamboo: '#6a5c40',
  drink: '#8a6631',
  flag: '#78452f', flagAlt: '#a39b87', sailCloth: '#b3a68d',
  graveGrass: '#372f24', graveMound: '#322b21', moss: '#4c4630',
  graveStone: '#675e50', graveStoneLight: '#796f60', graveEdge: '#443d33',
  fence: '#5b4836', fenceDark: '#392e22', yew: '#33412c', yewDark: '#273323',
  hallWall: '#5d4c38', hallBrick: '#534331', hallBrickEdge: '#453729', hallFloor: '#4d3f2e', hallFloorLine: '#413526',
  roomWall: '#544736', roomWallShade: '#463a2c', roomFloor: '#584228', roomFloorLine: '#473421', rug: '#6e3a35',
  hallSky: '#34405a', hallSea: '#3a3227',
  tapestry: '#6a5c44', tapestryEdge: '#463c2b',
  baize: '#36503b', baizeEdge: '#243629',
};

// Only the name painted on a board changes: the lane behind it is the same object, so nothing downstream moves.
const WEST_NAMES = Object.freeze({
  workshop: 'The Depot', cottages: 'The Bank', porch: 'The Saloon',
  harbour: 'The Rail Yard', beach: 'Valhalla mesa',
});
const WEST_ROOMS = Object.freeze({ castle: 'Valhalla mine', cottages: 'The Counting Room' });

// The frontier kit. Everyone in the Wild West wears a hat, so the crown stands where the plain village hat's
// does and one lift serves every look: see `headroom`, which the draw and hit testing both read.
export const HAT_LIFT = 9;
// Read off the body box, as fractions of its height. A body here is mostly face: the lowest thing the face paints
// is the mouth, at 0.63 of a round or square body and 0.50 of a tall one, so the waistcoat's collar sits at 0.62
// and clears all three. The lapels meet low, at 0.80. Converging any higher reads as a bib rather than a
// waistcoat, which only shows at magnification.
export const WEST_KIT = Object.freeze({
  collar: 0.62, lapel: 0.80, belt: 0.84, beltH: 4.5, star: 0.71,
  brimRX: 0.62, brimRY: 3.6, crownW: 0.52, seat: 2, seatRound: 5,
});

// Two of the mine's crowd go at it every WEST_FIGHT_PERIOD seconds, for WEST_FIGHT_S of it, brawl and shootout
// turn and turn about. Like the mirror ball and the lighthouse beam, it is night-only art that moves, so reduced
// motion holds it at nothing at all rather than at a frozen punch.
export const WEST_FIGHT_PERIOD = 5;
export const WEST_FIGHT_S = 1.5;
export const WEST_FIGHT_KINDS = Object.freeze(['brawl', 'shootout']);

export function fightAt(t, reduced = false) {
  if (reduced || !(t >= 0)) return null;
  const cycle = Math.floor(t / WEST_FIGHT_PERIOD);
  const local = t - cycle * WEST_FIGHT_PERIOD;
  if (local >= WEST_FIGHT_S) return null;
  return { cycle, local, k: local / WEST_FIGHT_S, kind: WEST_FIGHT_KINDS[cycle % WEST_FIGHT_KINDS.length] };
}

// The two standing nearest each other. With a thin crowd the nearest two can still be half the hall apart, which
// is why the dust ball's width is measured off the pair rather than fixed: a cloud hanging between two figures
// standing clear of it reads as neither of them fighting.
export function fightPair(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      if (d < bestD) {
        bestD = d;
        best = points[i].x <= points[j].x ? [points[i], points[j]] : [points[j], points[i]];
      }
    }
  }
  return best;
}

// The band on its stage, where the green hall hangs its mirror ball. Low enough that the archway still reads above
// the players' heads.
export const MINE_STAGE = Object.freeze({ x: 800, y: 356, w: 200, h: 22 });

// A horse trots the circuit the four roads make, clockwise from the south west corner. It rides the village's own
// ambient tick, like the lighthouse beam: a stray on the road is scenery, not a session going anywhere, and
// nothing that only moves the scenery is allowed to hold the canvas at full rate.
export const HORSE_CIRCUIT = Object.freeze([
  Object.freeze({ x: 460, y: 560 }), Object.freeze({ x: 1174, y: 560 }),
  Object.freeze({ x: 1174, y: 320 }), Object.freeze({ x: 460, y: 320 }),
]);
export const HORSE_SPEED = 55;
// Half of what the horse paints, measured across the leg it is on. The road band is 38 wide, so this has to stay
// under 19 or a hoof lands on the grass, and it is why the horse's head is carried forward rather than up.
export const HORSE_REACH = 15;

// Where anything walking a closed circuit is at t: which way it faces, and which axis it is on, so a check knows
// which way to measure its width. Reduced motion holds it at the node it starts from. `facing` is how it turns:
// 'leg' faces the way the leg it is on runs, which is what a horse does, and 'corner' faces the way the next
// corner will take it, so a walker on an upright leg has already turned rather than sliding along sideways.
// Four things walk a circuit now, and this is the part all four of them had a copy of.
function walkAt(circuit, speed, t, reduced, facing = 'corner') {
  const legs = circuit.map((a, i) => {
    const b = circuit[(i + 1) % circuit.length];
    return { a, b, len: Math.hypot(b.x - a.x, b.y - a.y) };
  });
  const dirs = legs.map((l, i) => {
    if (facing === 'leg') return l.b.x < l.a.x ? -1 : 1;
    for (let k = 0; k < legs.length; k += 1) {
      const m = legs[(i + k) % legs.length];
      if (m.b.x !== m.a.x) return m.b.x < m.a.x ? -1 : 1;
    }
    return 1;
  });
  const loop = legs.reduce((sum, l) => sum + l.len, 0);
  let d = reduced ? 0 : ((t * speed) % loop + loop) % loop;
  for (let i = 0; i < legs.length; i += 1) {
    const l = legs[i];
    if (d > l.len) {
      d -= l.len;
      continue;
    }
    const k = l.len ? d / l.len : 0;
    return {
      x: l.a.x + (l.b.x - l.a.x) * k, y: l.a.y + (l.b.y - l.a.y) * k, dir: dirs[i],
      axis: Math.abs(l.b.x - l.a.x) >= Math.abs(l.b.y - l.a.y) ? 'x' : 'y',
    };
  }
  return { x: circuit[0].x, y: circuit[0].y, dir: dirs[0], axis: 'x' };
}

export function horseAt(t, reduced = false) {
  return walkAt(HORSE_CIRCUIT, HORSE_SPEED, t, reduced, 'leg');
}

// An ent walks the same ring the four roads make round the workshop, which is the circuit the frontier's horse
// trots. It goes at an ent's pace: about a minute and a half to get round, slower than anything else on the map.
export const ENT_WALK_CIRCUIT = HORSE_CIRCUIT;
export const ENT_WALK_SPEED = 22;
// It walks at 25, which is 52 tall and the size of the middling standing ones. That is as big as the road will
// take: its two roots reach 0.72r either side once one has stepped, and the band is only 19 either side of the
// line. At 13 it was a sapling beside the sessions at the benches.
export const ENT_WALK_R = 25;
// One stride, in seconds.
export const ENT_WALK_BEAT = 2.6;
// What has to stay on the road is what it stands on: its two roots. A root is planted at 0.4r, steps 0.12r and
// splays 0.2r, so it reaches 0.72r either side, and its poly rises 0.45r up the bole. The ground shadow and the
// whole tree above them overhang the band, the way a session walking the road does, and the shadow is a soft
// wash at 18 per cent either way.
// Derived from the radius, never written out: as a pair of literals it did not move when the ent grew, so an
// ent too big for the road passed every check it has.
export const ENT_WALK_FOOT = Object.freeze([
  -0.72 * ENT_WALK_R, -0.45 * ENT_WALK_R, 0.72 * ENT_WALK_R, 0,
]);

// The one point its own look is taken from, so it stays the same ent all the way round. It is chosen rather than
// inherited: the two hashes at this point give turn 0.359 and turn2 0.942, which is a bole standing 1.525r and
// only 0.430r thick, with a modest lean and its left bough raised. Seeded on its own starting node it came out
// 1.299r and 0.456r, which is the shortest and near the stoutest an ent can be, and read as a stump.
export const ENT_WALK_SEED = Object.freeze([189, 113]);

export function walkingEntAt(t, reduced = false) {
  return walkAt(ENT_WALK_CIRCUIT, ENT_WALK_SPEED, t, reduced);
}

// Where it is in its stride at t, from -1 to 1. Reduced motion stands it still, roots down.
export function entStride(t, reduced) {
  return reduced ? 0 : Math.sin((TAU * (Number(t) || 0)) / ENT_WALK_BEAT);
}

// Something creeps round the inside of the graveyard fence in Middle-earth, keeping to the wall and never
// leaving. It rides the village's ambient tick, like the beam and the frontier's horse: a creature skulking round
// the barrows is scenery, not a session going anywhere, and nothing that only moves the scenery may hold the
// canvas at full rate.
export const GOLLUM_CIRCUIT = Object.freeze([
  Object.freeze({ x: 56, y: 392 }), Object.freeze({ x: 396, y: 392 }),
  Object.freeze({ x: 396, y: 508 }), Object.freeze({ x: 56, y: 508 }),
]);
export const GOLLUM_SPEED = 18;
// Half of what he paints, in any direction rather than across the leg: the circuit is a rectangle inside a
// rectangle, so a square reach is both simpler than the road maths and stricter at the corners. It is 24 because
// the head has to be half again the body for anyone to know what he is, and the fence is what allows it: the
// circuit is inset far enough that 26 still clears every rail.
export const GOLLUM_REACH = 26;

// Where he is at t and which way he faces. On the two upright legs he already faces the way the next corner
// takes him, so he turns before he walks rather than sliding along sideways.
export function gollumAt(t, reduced = false) {
  return walkAt(GOLLUM_CIRCUIT, GOLLUM_SPEED, t, reduced);
}

// What keeps the lair. It walks the inside of the jail's own plot, on the village's ambient tick like the beam
// and the frontier's horse: something patrolling a web is scenery, not a session going anywhere.
export const SPIDER_CIRCUIT = Object.freeze([
  Object.freeze({ x: 92, y: 68 }), Object.freeze({ x: 308, y: 68 }),
  Object.freeze({ x: 308, y: 230 }), Object.freeze({ x: 92, y: 230 }),
]);
export const SPIDER_SPEED = 26;
// Half of what it paints, in any direction: the legs reach furthest, at 14.7 from the body plus a step and half
// a line, which is 17.2 of the 18 the plot leaves once the circuit is inset.
export const SPIDER_REACH = 18;

export function spiderAt(t, reduced = false) {
  return walkAt(SPIDER_CIRCUIT, SPIDER_SPEED, t, reduced);
}

// The grey pilgrim's fireworks, night only, over the water east of the Grey Havens. Each one rises from the head
// of his staff and bursts. Like the beam, the disco and the mine's band, it rides the village's ambient tick and
// never asks for a frame of its own, and reduced motion holds every burst open rather than taking them away.
export const FIREWORK_PERIOD = 7;
export const FIREWORK_RISE = 1.1;
export const FIREWORK_BURST = 1.6;
// Where a rocket leaves from: the knot at the head of the staff, which `drawGuard` paints at (x - 16, top - 12)
// and `top` is the guard's own 38 tall body 6 above its feet.
export const FIREWORK_FROM = Object.freeze([GUARD.x - 16, GUARD.y - 6 - 38 - 12]);
// Each burst, and the box it is allowed. They hang over open water: east of the pier, below the harbour board,
// clear of the dark tower on the point and inside the canvas.
export const FIREWORKS = Object.freeze([
  Object.freeze({ x: 1462, y: 196, r: 38, phase: 0, rays: 14 }),
  Object.freeze({ x: 1548, y: 268, r: 28, phase: 3.4, rays: 11 }),
]);
// How far the sparks fall as the burst opens. A ring that holds its shape all the way out reads as a star cut
// out of paper: this is what makes it a firework.
export const FIREWORK_DROOP = 9;
export function fireworkBox(f) {
  return [f.x - f.r - 4, f.y - f.r - 4, (f.r + 4) * 2, (f.r + 4) * 2 + FIREWORK_DROOP];
}

// Where a firework is in its cycle at t: how far the rocket has risen, and how far the burst has opened. Null
// between shows. Reduced motion holds them all open, the way the disco holds its ball: still, not gone.
export function fireworkAt(t, reduced, f) {
  if (reduced) return { rise: 1, burst: 0.45 };
  const k = ((((Number(t) || 0) + f.phase) % FIREWORK_PERIOD) + FIREWORK_PERIOD) % FIREWORK_PERIOD;
  if (k < FIREWORK_RISE) return { rise: k / FIREWORK_RISE, burst: 0 };
  if (k < FIREWORK_RISE + FIREWORK_BURST) return { rise: 1, burst: (k - FIREWORK_RISE) / FIREWORK_BURST };
  return null;
}

// A green country: the Shire's own hills and hedgerows, oak and thatch, and a road west to the sea. The sea stays
// a sea here, which is the point of a pack being colours rather than a rewrite: nothing nautical needed branching.
// The trees are mallorns, silver-trunked and gold-crowned, which one palette line does across all eight of them.
const SHIRE_DAY = {
  grass: '#8fae74', grassLight: '#a4c188', grassDark: '#77985e', tuft: '#5f8049',
  path: '#dcc9a5', pathEdge: '#bda87e', pebble: '#c7b493',
  sand: '#e6dcc2', sandLight: '#f0e8d2', sandWet: '#d3c6a6', sandDot: '#dbd0b4', dune: '#aebb8c',
  water: '#8fb9c4', waterDeep: '#79a3b0', ripple: '#c6e0e6', shallow: '#a7ccd3',
  wood: '#9c7b52', woodDark: '#68512f', woodLight: '#c3a678', plank: '#a98b60',
  wall: '#ece4d0', wallShade: '#d6cbb0', roofs: ['#c19a5e', '#6f7a80', '#ad8a52', '#7b6a50'],
  windowDark: '#7e8a90', porchWindow: '#7e8a90', door: '#5f7d4e',
  stone: '#cdc3a6', stoneDark: '#9c9072',
  tree: '#d9c06a', treeDark: '#bda152', treeLight: '#eddf96', trunk: '#8a7358',
  flowers: ['#e6c6dc', '#f6f0e0', '#d6dfa6', '#c6d0ea'],
  lighthouse: '#f0ece0', slate: '#8a93a0', lanternGlass: '#e4dcc4', cat: '#8a7f70',
  towerStone: '#3e3c44', towerEdge: '#221f28', beamLight: '255, 96, 40',
  patrolKhaki: '#8e8c84', patrolKhakiShade: '#6d6b63', patrolNavy: '#33312c',
  shadow: 'rgba(40, 52, 34, 0.18)',
  signBoard: '#eee3c6', signBorder: '#7a6238', signText: '#33301f', signMuted: '#5f5a42',
  castle: '#e9e6dc', castleShade: '#d3cfc0', castleDark: '#a09a88', castleDoor: '#5c5647',
  shell: '#f2dcd3', shellEdge: '#c7a296', starfish: '#dca58a',
  stripeBase: '#f4eedc', stripes: ['#7f9fb4', '#b0894f', '#9aa478', '#c0a86a'],
  palm: '#a8bb7a', palmDark: '#879c5e', palmTrunk: '#cdc7b8', palmRing: '#a49d8c', coconut: '#6f5f42',
  thatch: '#cfae6f', thatchDark: '#a98a55', bamboo: '#c6b17c',
  flag: '#5a7fa8', flagAlt: '#efe8d2', sailCloth: '#eceadf',
  graveGrass: '#8fa87a', graveMound: '#7f9a6c', moss: '#7d9463',
  fence: '#9c8058', fenceDark: '#6b5238', yew: '#5f7d5c', yewDark: '#4a6649',
  hallWall: '#ded8c6', hallBrick: '#d1cab5', hallBrickEdge: '#b9b198', hallFloor: '#e6e0cd', hallFloorLine: '#cfc7ae',
  roomWall: '#ecdfc2', roomWallShade: '#d8c9a6', roomFloor: '#a9814f', roomFloorLine: '#8a6539', rug: '#7a4a52',
  hallSky: '#cfe3ea', hallSea: '#8fb9c4',
  tapestry: '#b9a06a', tapestryEdge: '#8a7448',
};

const SHIRE_DUSK = {
  grass: '#212e23', grassLight: '#2a3a2c', grassDark: '#1a251c', tuft: '#31422f',
  path: '#463f33', pathEdge: '#383227', pebble: '#524a3c',
  sand: '#443f34', sandLight: '#504a3d', sandWet: '#3d382e', sandDot: '#474234', dune: '#333d2e',
  water: '#1f3642', waterDeep: '#182c37', ripple: '#375260', shallow: '#28414c',
  wood: '#65502f', woodDark: '#42351f', woodLight: '#8a7050', plank: '#75603f',
  wall: '#565244', wallShade: '#48453a', roofs: ['#5e4a34', '#454e55', '#544330', '#4b4335'],
  windowDark: '#2b3238', porchWindow: '#e8c985', door: '#33452b',
  stone: '#5e5644', stoneDark: '#453f31',
  tree: '#6b5c2f', treeDark: '#564a26', treeLight: '#877443', trunk: '#4a3d2e',
  flowers: ['#8a6f82', '#b9b3a2', '#7e8558', '#71789a'],
  lighthouse: '#9b968a', slate: '#565e69', lanternGlass: '#6a665b', cat: '#6b6157',
  towerStone: '#2a2830', towerEdge: '#151319', beamLight: '255, 110, 50',
  patrolKhaki: '#9c998e', patrolKhakiShade: '#6a675e', patrolNavy: '#211f1c',
  shadow: 'rgba(0, 0, 0, 0.32)',
  signBoard: '#ded0ad', signBorder: '#54442a', signText: '#2c2718', signMuted: '#5a5340',
  castle: '#6d6a60', castleShade: '#5b584f', castleDark: '#403e37', castleDoor: '#22201a',
  shell: '#8a7a74', shellEdge: '#5e524d', starfish: '#86695a',
  stripeBase: '#74705f', stripes: ['#42586a', '#6a533a', '#5d6350', '#6f6446'],
  palm: '#3d4d33', palmDark: '#303f2a', palmTrunk: '#5e5b52', palmRing: '#45423a', coconut: '#3a3226',
  thatch: '#6f5e3e', thatchDark: '#54472f', bamboo: '#6a5d42',
  flag: '#33506d', flagAlt: '#a39b87', sailCloth: '#b7b5a9',
  graveGrass: '#24302a', graveMound: '#1f2b24', moss: '#3f523a',
  fence: '#5b4a34', fenceDark: '#392e20', yew: '#2b3d2a', yewDark: '#213021',
  hallWall: '#5a5648', hallBrick: '#514d40', hallBrickEdge: '#454236', hallFloor: '#4d4a3d', hallFloorLine: '#413e33',
  roomWall: '#544b38', roomWallShade: '#463e2e', roomFloor: '#584228', roomFloorLine: '#473421', rug: '#5c3339',
  hallSky: '#2c3f52', hallSea: '#1f3642',
  tapestry: '#665a41', tapestryEdge: '#443b2a',
};

// The Jail and the Graveyard keep their names in every pack: a cell is a cell and a grave is a grave.
const SHIRE_NAMES = Object.freeze({
  workshop: 'The Forge', cottages: 'Bag End', porch: 'The Green Dragon',
  harbour: 'The Grey Havens', beach: 'Undying Lands', jail: "Shelob's",
});
const SHIRE_ROOMS = Object.freeze({ castle: 'The White Halls', cottages: 'The Parlour' });

// The hobbit kit. Read off the body box like the frontier one, and held to what a character declares: the body
// box reaches 19 either side of the feet and the widest body is 18, so an ear may tip at 19 and no further, and
// the leg box reaches 9, which is what sizes a foot.
export const SHIRE_KIT = Object.freeze({
  collar: 0.62, lapel: 0.78, earTip: 19, footHalf: 9, hairRows: 6,
});

export const DEFAULT_THEME = 'village';

export const THEME_PACKS = Object.freeze([
  Object.freeze({
    key: 'village', name: 'Village', note: 'The green village',
    day: Object.freeze({}), dusk: Object.freeze({}),
    names: Object.freeze({}), rooms: Object.freeze({}), hatted: false,
  }),
  Object.freeze({
    key: 'west', name: 'Wild West', note: 'A frontier town on the dry flats',
    day: Object.freeze(WEST_DAY), dusk: Object.freeze(WEST_DUSK),
    names: WEST_NAMES, rooms: WEST_ROOMS, hatted: true,
  }),
  Object.freeze({
    key: 'shire', name: 'Middle-earth', note: 'A green country, and a grey ship west',
    day: Object.freeze(SHIRE_DAY), dusk: Object.freeze(SHIRE_DUSK),
    names: SHIRE_NAMES, rooms: SHIRE_ROOMS, hatted: false,
  }),
]);

export const THEME_KEYS = Object.freeze(THEME_PACKS.map((p) => p.key));

export function themePack(key) {
  return THEME_PACKS.find((p) => p.key === key) || THEME_PACKS[0];
}

// Resolved themes are cached: there are only two per pack, and every frame reads one.
const themeCache = new Map();

// The base theme with the pack's colours over it. `pack` and `night` ride on the object itself, so nothing has to
// compare it against THEMES.dusk by identity: a merged theme is a new object and every such test would be false.
export function resolveTheme(key, night) {
  const pack = themePack(key);
  const id = `${pack.key}|${night ? 'dusk' : 'day'}`;
  let out = themeCache.get(id);
  if (out) return out;
  out = Object.freeze({
    ...(night ? THEMES.dusk : THEMES.day),
    ...(night ? pack.dusk : pack.day),
    pack: pack.key, night: !!night,
  });
  themeCache.set(id, out);
  return out;
}

// The word on a place's board, and the one over an interior's door. The place and the scene keep their own keys.
export function placeName(place, pack = DEFAULT_THEME) {
  const spec = hasOwn(PLACES, place) ? PLACES[place] : null;
  if (!spec) return '';
  const named = themePack(pack).names;
  return hasOwn(named, place) ? named[place] : spec.name;
}

export function roomName(scene, pack = DEFAULT_THEME) {
  const spec = hasOwn(SCENE_ART, scene) ? SCENE_ART[scene] : null;
  if (!spec) return '';
  const named = themePack(pack).rooms;
  return hasOwn(named, scene) ? named[scene] : spec.title;
}

const BODY = {
  round: { w: 36, h: 34 },
  square: { w: 32, h: 34 },
  tall: { w: 26, h: 44 },
};

// One palm on the island, by the castle: its sway is the island's ambient motion, with the castle flags.
const PALMS = [[1420, 676, 50, -14]];
const MOORED = { x: BOAT_BERTH.x, y: BOAT_BERTH.y };

// The coast. Two things bind it, both asserted headlessly: it must stay west of the island's 200 px of water, and
// east of the workshop shed's south east corner (1158, 538), which it clears by 0.3 px. It no longer clears the
// road junction at (1174, 560) or the shed's east post: those stand on `ROAD_QUAY`. Moving the shed, the roads or
// the island means re-measuring this.
export function shoreX(y) {
  const t = clamp((y - 380) / 280, 0, 1);
  return 1296 - 236 * t * t * (3 - 2 * t) + 9 * Math.sin(y / 61) + 5 * Math.sin(y / 23 + 1.3);
}

// The deck, the boardwalk, the pier and the moored boat off its tip, where no ripple is drawn.
function nearHarbour(x, y, pad) {
  const [dx, dy, dw, dh] = HARBOUR_DECK;
  if (x > dx - 6 - pad && x < dx + dw + 18 + pad && y > dy - 8 - pad && y < dy + dh + 16 + pad) return true;
  const [bx, by, bw, bh] = PATROL_PLATFORM;
  if (x > bx - pad && x < bx + bw + pad && y > BOOTH_BOX[1] - 4 - pad && y < by + bh + 6 + pad) return true;
  if (y > 292 - pad && y < 350 + pad && x > 1460 - pad) return true;
  return x > PIER.x - 70 - pad && x < PIER.x + 70 + pad && y > dy + dh - pad && y < PIER.tip + 64 + pad;
}

export function onIsland(x, y, inflate = 0) {
  const dx = Math.abs(x - ISLAND.cx) / (ISLAND.rx + inflate);
  const dy = Math.abs(y - ISLAND.cy) / (ISLAND.ry + inflate);
  return dx ** 3 + dy ** 3 <= 1;
}

// The island's drawn shape: the superellipse of `onIsland` with the radial wobble paintIsland uses, as [x, y]
// pairs. Exported because the checks have to measure the shape on screen: the plain superellipse is up to 4.2 px
// inside it, which is most of the island's margin to the canvas edge.
export function islandOutline(inflate = 0) {
  const pts = [];
  for (let i = 0; i < 120; i++) {
    const a = (i / 120) * TAU;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const r = (Math.abs(c) ** 3 + Math.abs(s) ** 3) ** (-1 / 3);
    const wob = 1 + 0.02 * Math.sin(3 * a + 0.7) + 0.012 * Math.sin(7 * a + 2);
    pts.push([ISLAND.cx + c * (ISLAND.rx * r * wob + inflate), ISLAND.cy + s * (ISLAND.ry * r * wob + inflate)]);
  }
  return pts;
}

// ---------------------------------------------------------------------------------------------
// Drawing primitives (take the context explicitly so the background can use them too)
// ---------------------------------------------------------------------------------------------

function rr(g, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  g.moveTo(x + rad, y);
  g.lineTo(x + w - rad, y);
  g.arc(x + w - rad, y + rad, rad, -Math.PI / 2, 0);
  g.lineTo(x + w, y + h - rad);
  g.arc(x + w - rad, y + h - rad, rad, 0, Math.PI / 2);
  g.lineTo(x + rad, y + h);
  g.arc(x + rad, y + h - rad, rad, Math.PI / 2, Math.PI);
  g.lineTo(x, y + rad);
  g.arc(x + rad, y + rad, rad, Math.PI, Math.PI * 1.5);
  g.closePath();
}

function fillRR(g, x, y, w, h, r, fill, stroke, lineWidth = 1.5) {
  g.beginPath();
  rr(g, x, y, w, h, r);
  if (fill) {
    g.fillStyle = fill;
    g.fill();
  }
  if (stroke) {
    g.lineWidth = lineWidth;
    g.strokeStyle = stroke;
    g.stroke();
  }
}

function fillPoly(g, points, fill, stroke, lineWidth = 1.5) {
  g.beginPath();
  points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  if (fill) {
    g.fillStyle = fill;
    g.fill();
  }
  if (stroke) {
    g.lineWidth = lineWidth;
    g.strokeStyle = stroke;
    g.stroke();
  }
}

// Takes a stroke like fillRR and fillPoly do. It did not, and silently dropped one: a fill of null with an outline
// asked for filled the shape in whatever colour was last set instead, which is how the parlour's round window
// painted over its own view.
function fillEllipse(g, x, y, rx, ry, fill, stroke, lineWidth = 1.5) {
  g.beginPath();
  g.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, TAU);
  if (fill) {
    g.fillStyle = fill;
    g.fill();
  }
  if (stroke) {
    g.lineWidth = lineWidth;
    g.strokeStyle = stroke;
    g.stroke();
  }
}

function line(g, x1, y1, x2, y2, stroke, width) {
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.strokeStyle = stroke;
  g.lineWidth = width;
  g.stroke();
}

function strokePolyline(g, pts, stroke, width) {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.strokeStyle = stroke;
  g.lineWidth = width;
  g.stroke();
}

let glyphCache = null;

function glyphPaths() {
  if (glyphCache) return glyphCache;
  if (typeof Path2D === 'undefined') return null;
  glyphCache = {};
  for (const [key, def] of Object.entries(GLYPHS)) glyphCache[key] = new Path2D(def.d);
  return glyphCache;
}

function drawGlyph(g, key, cx, cy, size, color, edge) {
  const paths = glyphPaths();
  const def = GLYPHS[key];
  if (!paths || !def) return;
  const path = paths[key];
  g.save();
  g.translate(cx - size / 2, cy - size / 2);
  g.scale(size / 24, size / 24);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (def.stroke) {
    if (edge) {
      g.strokeStyle = edge;
      g.lineWidth = def.stroke + 2.6;
      g.stroke(path);
    }
    g.strokeStyle = color;
    g.lineWidth = def.stroke;
    g.stroke(path);
  } else {
    if (edge) {
      g.strokeStyle = edge;
      g.lineWidth = 2.6;
      g.stroke(path);
    }
    g.fillStyle = color;
    g.fill(path, def.rule || 'nonzero');
  }
  g.restore();
}

// `lane` is a lane name, or a badge of its own that is not a lane at all (the visitors' Reviews badge).
function drawBadge(g, lane, cx, cy, r) {
  const st = typeof lane === 'string' ? STATE[lane] : lane;
  if (!st) return;
  g.beginPath();
  g.arc(cx, cy, r, 0, TAU);
  if (st.outline) {
    g.fillStyle = OUTLINE_FILL;
    g.fill();
    g.lineWidth = Math.max(2, r * 0.2);
    g.strokeStyle = st.color;
    g.stroke();
    drawGlyph(g, st.glyph, cx, cy, r * 1.15, OUTLINE_GLYPH, null);
  } else {
    g.fillStyle = st.color;
    g.fill();
    g.lineWidth = Math.max(1, r * 0.1);
    g.strokeStyle = st.border;
    g.stroke();
    drawGlyph(g, st.glyph, cx, cy, r * 1.15, st.glyphColor || '#ffffff', st.lightDisc ? LIGHT_DISC_GLYPH_EDGE : null);
  }
}

// Stripes across a quad whose top edge runs a->b and bottom edge d->c.
function stripedQuad(g, a, b, c, d, n, colors) {
  for (let i = 0; i < n; i++) {
    const k0 = i / n;
    const k1 = (i + 1) / n;
    const P = (p, q, k) => [lerp(p[0], q[0], k), lerp(p[1], q[1], k)];
    fillPoly(g, [P(a, b, k0), P(a, b, k1), P(d, c, k1), P(d, c, k0)], colors[i % colors.length]);
  }
}

function drawMargarita(g, T, x, y, tilt = 0, s = 1) {
  g.save();
  g.translate(x, y);
  g.rotate(tilt);
  g.scale(s, s);
  if (T.pack === 'west') {
    fillRR(g, -5, -9, 10, 13, 1.5, T.glass, T.glassEdge, 1.2);
    fillRR(g, -4, -4, 8, 7.5, 1, T.drink);
    line(g, -5, -9, 5, -9, T.glassEdge, 1.4);
    g.restore();
    return;
  }
  if (T.pack === 'shire') {
    // A pipe, with three rings going up. Pipe-weed is the Shire's one contribution to the arts.
    line(g, -7, 2, 3, -1, T.woodDark, 2.4);
    fillRR(g, 2, -8, 6, 9, 2, T.woodDark);
    fillEllipse(g, 5, -8, 3.2, 1.6, T.flame);
    g.globalAlpha = 0.5;
    for (let i = 0; i < 3; i += 1) {
      g.beginPath();
      g.arc(6 + i * 1.5, -14 - i * 5, 2.2 + i * 1.1, 0, TAU);
      g.strokeStyle = `rgb(${T.smoke})`;
      g.lineWidth = 1.2;
      g.stroke();
    }
    g.globalAlpha = 1;
    g.restore();
    return;
  }
  fillPoly(g, [[-7.5, -9], [7.5, -9], [2, -2.5], [-2, -2.5]], T.drink, T.glassEdge, 1);
  line(g, -7.5, -9, 7.5, -9, T.glass, 1.8);
  line(g, 0, -2.5, 0, 4.5, T.glassEdge, 1.4);
  fillEllipse(g, 0, 4.8, 4, 1.3, T.glassEdge);
  g.beginPath();
  g.arc(6.2, -9.5, 3.4, Math.PI, TAU);
  g.closePath();
  g.fillStyle = T.lime;
  g.fill();
  g.restore();
}

// The frontier's crossing runs on rails, so the boat is a locomotive on the boat's own footing: the passenger
// stands on the footplate between the tender behind and the boiler in front, exactly as a passenger sits between a
// boat's two gunwales, and the plume goes up for the long haul where a boat raises its sail. Everything it paints
// stays inside BOAT_TOP and the hull's own length.
function drawLocomotive(g, T, { sail, part }) {
  const wheel = (wx, r) => {
    fillEllipse(g, wx, LOCO.wheels - r, r, r, T.steel, T.woodDark, 2);
    fillEllipse(g, wx, LOCO.wheels - r, r * 0.32, r * 0.32, T.woodDark);
  };
  if (part !== 'front') {
    // The tender: a coal box on two wheels, its back sheet where the boat's stern is.
    fillRR(g, LOCO.back, -36, 42, 48, 3, T.plank, T.woodDark, 2);
    fillRR(g, LOCO.back, -40, 42, 7, 2, T.woodDark);
    wheel(-48, 7.5);
    wheel(-24, 7.5);
    fillRR(g, -20, -30, 8, 42, 2, T.woodDark);
  }
  if (part !== 'back') {
    // The boiler, the smokebox and the chimney, and the frame they all stand on.
    fillRR(g, 6, -34, 46, 42, 18, T.steel, T.woodDark, 2);
    for (const bx of [20, 36]) fillRR(g, bx, -34, 5, 42, 2, T.woodDark);
    fillRR(g, 46, -38, 12, 50, 4, T.woodDark);
    fillRR(g, 34, -58, 15, 24, 2, T.woodDark);
    fillRR(g, 31, LOCO.cap, 21, 7, 3, T.woodDark);
    fillRR(g, 2, -14, 54, 22, 2, T.woodDark);
    wheel(18, 8.5);
    wheel(42, 8.5);
    // The cowcatcher, on the bow's own line.
    fillPoly(g, [[LOCO.nose, -8], [LOCO.nose, LOCO.wheels], [44, LOCO.wheels]], T.steel, T.woodDark, 1.5);
  }
  if (sail && part !== 'front') {
    // The plume, rising to where a sail's flag flies and no higher.
    for (let i = 0; i < 4; i += 1) {
      const r = 9 + i * 3.5;
      const cy = LOCO.cap - 8 - i * 7;
      fillEllipse(g, 40 - i * 5, Math.max(LOCO.plume + r, cy), r, r * 0.8, `rgba(${T.smoke}, ${0.5 - i * 0.08})`);
    }
  }
}

// A grey ship on the boat's own hull: the passenger sits between the same two gunwales, and the swan's neck and
// the sail stand where the rowboat's mast and sail do, inside HULL and BOAT_TOP.
function drawGreyShip(g, T, { sail, part }) {
  const hull = () => {
    g.beginPath();
    g.moveTo(-60, -10);
    g.quadraticCurveTo(-30, -16, 30, -16);
    g.quadraticCurveTo(52, -14, 60, -10);
    g.quadraticCurveTo(52, 14, 32, 17);
    g.lineTo(-36, 17);
    g.quadraticCurveTo(-56, 13, -60, -10);
    g.closePath();
  };
  if (part !== 'front') {
    if (sail) {
      line(g, 4, -10, 4, -86, T.woodDark, 3);
      fillPoly(g, [[6, -82], [6, -18], [46, -22], [40, -74]], T.sailCloth, T.towerEdge, 1.5);
      fillPoly(g, [[2, -82], [2, -24], [-28, -26]], T.sailCloth, T.towerEdge, 1.5);
      // A white star on the sail, which is the one device a grey ship carries.
      const star = [];
      for (let i = 0; i < 10; i += 1) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const d = i % 2 ? 2.4 : 6;
        star.push([24 + Math.cos(a) * d, -50 + Math.sin(a) * d]);
      }
      fillPoly(g, star, T.flagAlt, T.slate, 0.8);
    }
    hull();
    g.fillStyle = T.lighthouse;
    g.fill();
    g.strokeStyle = T.slate;
    g.lineWidth = 2;
    g.stroke();
    fillEllipse(g, 0, -13, 52, 4.5, T.slate);
  }
  if (part !== 'back') {
    g.save();
    g.beginPath();
    g.rect(-70, -8, 140, 33);
    g.clip();
    hull();
    g.fillStyle = T.lighthouse;
    g.fill();
    g.strokeStyle = T.slate;
    g.lineWidth = 2;
    g.stroke();
    g.restore();
    line(g, -54, -6, 54, -6, T.slate, 1.6);
    // The swan's neck at the bow, inside the hull's own length.
    line(g, 52, -14, 57, -34, T.lighthouse, 5);
    line(g, 52, -14, 57, -34, T.slate, 1.4);
    fillEllipse(g, 55, -37, 6, 4.5, T.lighthouse, T.slate, 1.4);
    fillPoly(g, [[59, -37], [66, -35], [59, -33]], T.flag);
  }
}

function drawRowboat(g, T, x, y, { tilt = 0, s = 1, dir = 1, sail = false, part = 'all' } = {}) {
  g.save();
  g.translate(x, y);
  g.rotate(tilt);
  g.scale(s * (dir < 0 ? -1 : 1), s);
  if (T.pack === 'west') {
    drawLocomotive(g, T, { sail, part });
    g.restore();
    return;
  }
  if (T.pack === 'shire') {
    drawGreyShip(g, T, { sail, part });
    g.restore();
    return;
  }
  const hull = () => {
    g.beginPath();
    g.moveTo(-60, -10);
    g.lineTo(60, -10);
    g.quadraticCurveTo(52, 14, 32, 17);
    g.lineTo(-36, 17);
    g.quadraticCurveTo(-56, 13, -60, -10);
    g.closePath();
  };
  if (part !== 'front') {
    if (sail) {
      line(g, 4, -10, 4, -86, T.woodDark, 3);
      fillPoly(g, [[8, -82], [8, -16], [50, -18]], T.sailCloth, T.woodDark, 1.5);
      fillPoly(g, [[0, -82], [0, -22], [-30, -22]], T.sailCloth, T.woodDark, 1.5);
      fillPoly(g, [[4, -86], [4, -96], [20, -91]], T.flag);
    }
    hull();
    g.fillStyle = T.wood;
    g.fill();
    g.strokeStyle = T.woodDark;
    g.lineWidth = 2;
    g.stroke();
    fillEllipse(g, 0, -9, 54, 5.5, T.woodDark);
    fillRR(g, -8, -13, 16, 5, 1.5, T.woodLight);
    if (!sail && part === 'all') line(g, 20, -12, 58, -32, T.woodLight, 3);
  }
  if (part !== 'back') {
    g.save();
    g.beginPath();
    g.rect(-70, -5, 140, 30);
    g.clip();
    hull();
    g.fillStyle = T.wood;
    g.fill();
    g.strokeStyle = T.woodDark;
    g.lineWidth = 2;
    g.stroke();
    g.restore();
    line(g, -57, -4, 57, -4, T.woodDark, 2);
    line(g, -54, 4, 54, 4, T.woodLight, 1.5);
  }
  g.restore();
}

// ---------------------------------------------------------------------------------------------
// Static background, painted once per resize or theme change
// ---------------------------------------------------------------------------------------------

// The world map's sea, with no islands in it: open water, a few lighter shoals and a scatter of ripples. The
// islands are drawn over this per frame, since which repos exist changes with the board.
function paintWorldSea(g, T) {
  const rand = mulberry32(20260918);
  g.fillStyle = T.waterDeep;
  g.fillRect(-3000, -3000, W + 6000, H + 6000);
  g.globalAlpha = 0.5;
  for (let i = 0; i < 40; i++) {
    const rx = 90 + rand() * 220;
    fillEllipse(g, rand() * W, rand() * H, rx, rx * (0.18 + rand() * 0.22), rand() < 0.5 ? T.water : T.shallow);
  }
  g.globalAlpha = 1;
  g.lineCap = 'round';
  g.strokeStyle = T.ripple;
  g.lineWidth = 2;
  for (let i = 0; i < 110; i++) {
    g.globalAlpha = 0.25 + rand() * 0.3;
    g.beginPath();
    g.arc(rand() * W, rand() * H, 8 + rand() * 16, Math.PI * 1.15, Math.PI * 1.85);
    g.stroke();
  }
  g.globalAlpha = 1;
}

function paintBackground(g, T) {
  const rand = mulberry32(20260916);
  g.fillStyle = T.grass;
  g.fillRect(-3000, -3000, W + 6000, H + 6000);

  g.globalAlpha = 0.6;
  for (let i = 0; i < 70; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const rx = 40 + rand() * 110;
    fillEllipse(g, x, y, rx, rx * (0.3 + rand() * 0.3), rand() < 0.5 ? T.grassLight : T.grassDark);
  }
  g.globalAlpha = 1;
  if (T.pack === 'shire') paintShireCountry(g, T);
  if (T.pack === 'west') paintHorizonRange(g, T);
  if (T.pack === 'shire') paintMistyMountains(g, T);

  paintWater(g, T, rand);
  paintIsland(g, T, rand);
  paintRoads(g, T, rand);
  paintRoadQuay(g, T);
  paintTufts(g, T, rand);
  paintJail(g, T);
  paintGraveyard(g, T);
  paintCottage(g, T);
  paintWorkshop(g, T);
  paintPorchHouse(g, T);
  paintHarbour(g, T);
  paintSandCastle(g, T);
  paintTrees(g, T);
  paintFlowers(g, T, rand);
}

// A range along the top of the map with a tunnel driven through it, painted before the sea so the water covers
// its eastern end rather than the range running out over the flats.
function paintHorizonRange(g, T) {
  const peaks = [[-40, 58], [90, 6], [220, 46], [330, 2], [470, 52], [610, 12], [760, 48], [900, 4], [1040, 44],
    [1180, 14], [1320, 50], [1460, 18], [1640, 56]];
  const pts = [[-60, 62], ...peaks, [1660, 62]];
  fillPoly(g, pts, T.castleShade, T.castleDark, 2);
  // The snow, or what passes for it up there: the lit western face of each peak.
  for (const [x, y] of peaks) {
    if (y > 20) continue;
    fillPoly(g, [[x, y], [x - 16, y + 18], [x + 16, y + 18]], T.wallShade);
  }
  // The tunnel, clear of every tree and of the cottage.
  const tx = 300;
  g.beginPath();
  g.moveTo(tx - 20, 62);
  g.lineTo(tx - 20, 40);
  g.arc(tx, 40, 20, Math.PI, TAU);
  g.lineTo(tx + 20, 62);
  g.closePath();
  g.fillStyle = T.castleDoor;
  g.fill();
  g.strokeStyle = T.woodDark;
  g.lineWidth = 4;
  g.stroke();
  for (const dx of [-26, 26]) fillRR(g, tx + dx - 4, 26, 8, 36, 2, T.wood, T.woodDark, 1.5);
}

// The open ground between the places, which is most of the map and which a wash of ellipses leaves saying
// nothing. Hedged fields, a hillside with doors in it and a lane's own verges say where this is. Every patch is
// hand-placed in ground no place declares and no road band crosses, so none of it is any place's to answer for.
// Four of these used to lie below the graveyard, which looked like open ground and is not: the Porch's three
// spots stand there, its swing frames reach 90 px above their rows and a row's badge reaches PORCH_CEILING, so
// everything from y 581 down and x 666 west belongs to it. They were laid over the swings. `PORCH_GROUND` below
// says so once, and a check holds every quad, hole and pony to it.
export const SHIRE_FIELDS = Object.freeze([
  // Top left, under the jail's own ground, which ends at y 250, and above the y 320 road.
  Object.freeze([[10, 266], [210, 262], [222, 298], [16, 302]]),
  Object.freeze([[232, 262], [430, 266], [430, 300], [240, 298]]),
  // West of the jail's ground, which starts at x 70.
  Object.freeze([[10, 120], [50, 112], [54, 178], [14, 182]]),
  // Top middle, west of Bag End.
  Object.freeze([[500, 48], [676, 44], [682, 120], [506, 126]]),
  Object.freeze([[506, 134], [712, 128], [718, 250], [512, 252]]),
  // Top right, east of Bag End and short of the coast.
  Object.freeze([[944, 46], [1084, 50], [1080, 116], [938, 110]]),
  Object.freeze([[938, 186], [1130, 190], [1122, 254], [932, 250]]),
]);

// The ground the Porch takes, which no dressing may touch: from its own ceiling down, and from the west end of
// the steps to the east end of its door spot, with a wide body's half-width either side.
export const PORCH_GROUND = Object.freeze([6, PORCH_CEILING, 660, 900 - PORCH_CEILING]);

// Hillsides with a door in them, in open ground away from every place: Bag End is not the only hole in the hill.
export const SHIRE_HOLES = Object.freeze([
  Object.freeze({ x: 372, y: 236, r: 42 }),
]);

// Where a field's own edges sit on a horizontal line, so a drill row can be drawn across it without reaching the
// hedge. Null when the line misses the field, which is how the top and bottom rows fall away on a sloped edge.
function fieldSpan(field, y) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let e = 0; e < field.length; e += 1) {
    const [ax, ay] = field[e];
    const [bx, by] = field[(e + 1) % field.length];
    if ((ay <= y && by > y) || (by <= y && ay > y)) {
      const x = ax + ((y - ay) / (by - ay)) * (bx - ax);
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
  }
  return hi > lo ? [lo, hi] : null;
}

// A pony with its head down, standing in a pasture. Scenery in the background layer, so it never moves at all:
// the one thing on the roads that does (the frontier's horse) is on the ambient tick and is drawn per frame.
function paintPony(g, T, x, y, dir) {
  g.save();
  g.translate(x, y);
  g.scale(dir < 0 ? -1 : 1, 1);
  fillEllipse(g, 1, 11, 16, 3.5, T.shadow);
  for (const lx of [-10, -5, 5, 10]) line(g, lx, -2, lx, 10, T.woodDark, 2.6);
  fillRR(g, -13, -12, 26, 13, 6, T.cat, T.woodDark, 1.5);
  // Neck and muzzle angled down into the grass, which is what makes a pony read as grazing rather than as a pig.
  fillPoly(g, [[6, -12], [14, -11], [16, 2], [9, 2]], T.cat, T.woodDark, 1.5);
  fillRR(g, 9, 0, 10, 6, 3, T.cat, T.woodDark, 1.5);
  fillPoly(g, [[7, -12], [9, -16], [11, -11]], T.woodDark);
  // Mane down the neck and a tail behind: without them the outline is a loaf on legs.
  line(g, 4, -13, 13, -9, T.woodDark, 3);
  line(g, -13, -11, -18, -1, T.woodDark, 2.6);
  g.restore();
}

// What a pony paints about the point it stands on, as [left, top, right, bottom]: the tail reaches 18 back, the
// muzzle 19 forward, the ear 16 up and the ground shadow 15 down.
export const PONY_BOX = Object.freeze([-20, -17, 20, 16]);

// Ponies grazing, in two of the pastures and well inside their hedges.
export const SHIRE_PONIES = Object.freeze([
  Object.freeze({ x: 1000, y: 94, dir: 1 }), Object.freeze({ x: 1054, y: 72, dir: -1 }),
]);

// What is growing in a field. Fields take it in turn: standing corn, ploughed earth, then pasture, which is the
// green the field already was. Everything is laid on drill rows read off the field's own edges, so a crop cannot
// reach its hedge however the quad is skewed.
function paintFieldCrop(g, T, field, kind) {
  if (kind === 2) return;
  const ys = field.map((pt) => pt[1]);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  for (let y = y0 + 15; y <= y1 - 13; y += 15) {
    const span = fieldSpan(field, y);
    if (!span) continue;
    const [lo, hi] = span;
    const a = lo + 15;
    const b = hi - 15;
    if (b - a < 20) continue;
    if (kind === 1) {
      // Ploughed: the furrow itself, with the ridge beside it.
      line(g, a, y, b, y, T.pathEdge, 3);
      line(g, a, y + 3.5, b, y + 3.5, T.path, 2);
      continue;
    }
    // Standing corn: the drill row, then an ear every few paces along it.
    g.globalAlpha = 0.7;
    line(g, a, y + 5, b, y + 5, T.thatchDark, 2);
    g.globalAlpha = 1;
    for (let x = a; x <= b; x += 14) {
      line(g, x, y + 5, x, y - 3, T.thatchDark, 1.6);
      fillEllipse(g, x, y - 5, 2.6, 4.4, T.thatch);
    }
  }
}

function paintShireCountry(g, T) {
  // Fields: corn, plough or pasture inside a hedge, which is what makes country read as farmed rather than wild.
  SHIRE_FIELDS.forEach((field, i) => {
    const crop = i % 3;
    g.globalAlpha = crop === 1 ? 0.72 : 0.55;
    fillPoly(g, field, crop === 1 ? T.path : i % 2 ? T.grassLight : T.grassDark);
    g.globalAlpha = 1;
    paintFieldCrop(g, T, field, crop);
    // The hedge itself: a run of small dark clumps around the field's edge rather than a drawn line.
    for (let e = 0; e < field.length; e += 1) {
      const [ax, ay] = field[e];
      const [bx, by] = field[(e + 1) % field.length];
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.max(2, Math.round(len / 13));
      for (let k = 0; k <= n; k += 1) {
        const t = k / n;
        const hx = ax + (bx - ax) * t;
        const hy = ay + (by - ay) * t;
        fillEllipse(g, hx, hy + 1.5, 7.5, 4.2, T.yewDark);
        fillEllipse(g, hx, hy, 7, 4, T.yew);
        fillEllipse(g, hx - 1.6, hy - 1.4, 3, 1.8, T.tuft);
      }
    }
  });
  for (const { x, y, dir } of SHIRE_PONIES) paintPony(g, T, x, y, dir);
  // Bag End's garden: a paling fence with a gate on the door's own centre line, and the path up to the step.
  const gateX = COTTAGE.x;
  fillRR(g, gateX - 7, 220, 14, 26, 2, T.path, T.pathEdge, 1.5);
  for (let fx = 754; fx < 908; fx += 13) {
    if (Math.abs(fx - gateX) < 16) continue;
    fillRR(g, fx, 228, 5, 20, 2, T.woodLight, T.woodDark, 1);
  }
  for (const rail of [232, 242]) {
    fillRR(g, 752, rail, 62, 4, 1, T.woodDark);
    fillRR(g, 846, rail, 64, 4, 1, T.woodDark);
  }
  for (const px of [gateX - 18, gateX + 14]) {
    fillRR(g, px, 222, 7, 30, 2, T.wood, T.woodDark, 1.2);
    fillEllipse(g, px + 3.5, 221, 5, 3.5, T.wood, T.woodDark, 1.2);
  }
  // A bench by the gate, which is the one thing everyone knows is outside that door.
  fillRR(g, 928, 236, 34, 5, 1.5, T.wood, T.woodDark, 1.2);
  fillRR(g, 930, 226, 30, 4, 1.5, T.wood, T.woodDark, 1.2);
  for (const bx of [931, 956]) fillRR(g, bx, 240, 4, 9, 1, T.woodDark);

  // Two more holes in the hill, each with its door, its round window and a step.
  for (const { x, y, r } of SHIRE_HOLES) {
    fillEllipse(g, x + 5, y + 3, r * 0.95, 8, T.shadow);
    g.beginPath();
    g.ellipse(x, y, r, r * 0.86, 0, Math.PI, TAU);
    g.closePath();
    g.fillStyle = T.grassDark;
    g.fill();
    g.beginPath();
    g.ellipse(x, y, r - 4, r * 0.86 - 6, 0, Math.PI, TAU);
    g.closePath();
    g.fillStyle = T.grass;
    g.fill();
    g.globalAlpha = 0.5;
    fillEllipse(g, x - r * 0.3, y - r * 0.5, r * 0.34, r * 0.12, T.grassLight);
    g.globalAlpha = 1;
    const dr = r * 0.3;
    fillEllipse(g, x, y - dr * 0.9, dr + 3, dr + 3, T.wood);
    fillEllipse(g, x, y - dr * 0.9, dr, dr, T.door, T.woodDark, 1.4);
    fillEllipse(g, x, y - dr * 0.9, 2.2, 2.2, T.thatch);
    fillRR(g, x + r * 0.46, y - r * 0.5, 15, 13, 6.5, T.wood, T.woodDark, 1.2);
    fillRR(g, x - r * 0.62, y - r * 0.44, 13, 12, 6, T.wood, T.woodDark, 1.2);
    fillRR(g, x - dr - 4, y - 2, (dr + 4) * 2, 6, 2, T.stone, T.stoneDark, 1);
  }
}

// The mountains east of here, along the top of the map, painted before the sea so the water takes their far end.
// The same band the frontier's range uses, so nothing above the buildings has to move.
function paintMistyMountains(g, T) {
  const peaks = [[-40, 64], [110, 10], [250, 52], [400, 4], [540, 46], [690, 14], [830, 50], [980, 2],
    [1120, 44], [1270, 16], [1420, 52], [1560, 20], [1660, 62]];
  fillPoly(g, [[-60, 68], ...peaks, [1680, 68]], T.stoneDark, T.castleDark, 2);
  for (const [x, y] of peaks) {
    if (y > 22) continue;
    fillPoly(g, [[x, y], [x - 17, y + 20], [x - 6, y + 15], [x + 3, y + 21], [x + 17, y + 20]], T.wall);
  }
  // A second, paler line behind the first: distance, which one row of peaks cannot say on its own.
  g.globalAlpha = 0.45;
  fillPoly(g, [[-60, 40], [180, 4], [420, 34], [680, 0], [930, 30], [1180, 2], [1430, 32], [1680, 8], [1680, 44], [-60, 44]], T.stone);
  g.globalAlpha = 1;
}

function paintWater(g, T, rand) {
  const band = (offset, wobble) => {
    const pts = [[W + 3000, -1000]];
    for (let y = -1000; y <= H + 1000; y += 8) pts.push([shoreX(y) + offset + wobble(y), y]);
    pts.push([W + 3000, H + 1000]);
    return pts;
  };
  fillPoly(g, band(-18, () => 0), T.sand);
  fillPoly(g, band(0, () => 0), T.water);
  fillPoly(g, band(95, (y) => 12 * Math.sin(y / 83)), T.waterDeep);
  g.lineCap = 'round';
  if (T.pack === 'west') {
    // A gulch cut down the flats, on the deep band's own wobble so it never wanders onto the island or the deck.
    g.lineWidth = 26;
    g.strokeStyle = T.stoneDark;
    g.beginPath();
    for (let y = -40; y <= H + 40; y += 20) {
      const x = shoreX(y) + 138 + 34 * Math.sin(y / 132);
      if (y <= -40) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    g.lineWidth = 14;
    g.strokeStyle = T.sandWet;
    g.stroke();
    // Cracked mud where the ripples were, on the same seed and the same guards.
    g.strokeStyle = T.ripple;
    g.lineWidth = 1.6;
    for (let i = 0; i < 90; i++) {
      const y = rand() * H;
      const x = shoreX(y) + 24 + rand() * (W - shoreX(y) - 10);
      if (onIsland(x, y, 40) || nearHarbour(x, y, 0)) continue;
      const r = 8 + rand() * 14;
      g.globalAlpha = 0.3 + rand() * 0.3;
      g.beginPath();
      // Three cracks off one point, which is what dried mud does and what an arc plainly does not.
      for (let k = 0; k < 3; k++) {
        const a = rand() * TAU;
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    return;
  }
  g.strokeStyle = T.ripple;
  g.lineWidth = 2;
  for (let i = 0; i < 90; i++) {
    const y = rand() * H;
    const x = shoreX(y) + 24 + rand() * (W - shoreX(y) - 10);
    if (onIsland(x, y, 40) || nearHarbour(x, y, 0)) continue;
    const r = 8 + rand() * 14;
    g.globalAlpha = 0.35 + rand() * 0.35;
    g.beginPath();
    g.arc(x, y, r, Math.PI * 1.15, Math.PI * 1.85);
    g.stroke();
  }
  g.globalAlpha = 1;
}

function paintIsland(g, T, rand) {
  fillPoly(g, islandOutline(30), T.shallow);
  g.globalAlpha = 0.8;
  fillPoly(g, islandOutline(9), T.foam);
  g.globalAlpha = 1;
  fillPoly(g, islandOutline(4), T.sandWet);
  fillPoly(g, islandOutline(0), T.sandLight);
  for (let i = 0; i < 160; i++) {
    const x = ISLAND.cx + (rand() - 0.5) * ISLAND.rx * 2;
    const y = ISLAND.cy + (rand() - 0.5) * ISLAND.ry * 2;
    if (!onIsland(x, y, -10)) continue;
    fillEllipse(g, x, y, 1.2 + rand() * 1.2, 0.8 + rand() * 0.8, T.sandDot);
  }
  // Dune grass along the back of the island.
  g.lineCap = 'round';
  g.strokeStyle = T.dune;
  g.lineWidth = 1.8;
  for (const [x, y] of [[1372, 668], [1540, 700], [1552, 830], [1318, 770], [1462, 862], [1382, 852]]) {
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      g.moveTo(x + i * 3, y);
      g.quadraticCurveTo(x + i * 3 + (i - 2.5) * 2, y - 8, x + i * 3 + (i - 2.5) * 4, y - 14 - (i % 2) * 5);
      g.stroke();
    }
  }
  // Shells and a starfish on the sand.
  for (const [x, y, r] of [[1400, 864, 5], [1520, 842, 4], [1330, 806, 4]]) paintShell(g, T, x, y, r, 0.3);
  paintStarfish(g, T, 1444, 870, 7, 0.4);

  // The jetty.
  const jx = JETTY.x;
  const jt = JETTY.tip;
  for (const y of [jt + 10, jt + 40]) {
    fillRR(g, jx - 21, y + 8, 6, 14, 2, T.woodDark);
    fillRR(g, jx + 15, y + 8, 6, 14, 2, T.woodDark);
  }
  fillRR(g, jx - 18, jt, 36, JETTY.foot - jt, 3, T.woodLight, T.woodDark, 2);
  g.globalAlpha = 0.55;
  for (let y = jt + 10; y < JETTY.foot; y += 10) line(g, jx - 17, y, jx + 17, y, T.plank, 1.2);
  g.globalAlpha = 1;
  for (const [x, y] of [[jx - 16, jt + 4], [jx + 16, jt + 4]]) {
    fillEllipse(g, x, y, 5, 4.5, T.woodDark);
    fillEllipse(g, x, y - 1.5, 3.5, 2.6, T.wood);
  }
}

function paintShell(g, T, x, y, r, rot) {
  if (T.pack === 'west') {
    // A weathered stone where the shell is, on the shell's own footing.
    fillEllipse(g, x, y + r * 0.35, r * 0.95, r * 0.35, T.shadow);
    fillEllipse(g, x, y, r * 0.95, r * 0.7, T.stone);
    fillEllipse(g, x - r * 0.25, y - r * 0.2, r * 0.4, r * 0.28, T.wallShade);
    return;
  }
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.beginPath();
  g.moveTo(0, r * 0.6);
  g.arc(0, 0, r, Math.PI * 1.05, Math.PI * 1.95);
  g.closePath();
  g.fillStyle = T.shell;
  g.fill();
  g.strokeStyle = T.shellEdge;
  g.lineWidth = 1;
  g.stroke();
  for (const a of [-0.55, 0, 0.55]) line(g, 0, r * 0.5, Math.sin(a) * r * 0.85, -Math.cos(a) * r * 0.8, T.shellEdge, 0.8);
  g.restore();
}

function paintStarfish(g, T, x, y, r, rot) {
  if (T.pack === 'west') {
    // A horseshoe, open end down, inside the starfish's own radius.
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.beginPath();
    g.arc(0, 0, r * 0.68, Math.PI * 0.85, Math.PI * 0.15);
    g.strokeStyle = T.steel;
    g.lineWidth = Math.max(1.6, r * 0.34);
    g.lineCap = 'butt';
    g.stroke();
    g.lineCap = 'round';
    g.restore();
    return;
  }
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = rot + (i / 10) * TAU - Math.PI / 2;
    const rad = i % 2 ? r * 0.42 : r;
    pts.push([x + Math.cos(a) * rad, y + Math.sin(a) * rad]);
  }
  fillPoly(g, pts, T.starfish, T.shellEdge, 1);
}

// The road centrelines as drawn, stroked `ROAD_BAND` wide with a round cap, which reaches half that past each end.
// Exported so a check can sweep the band that is painted, not the graph walkers use: the two differ at the ends.
export const ROAD_LINES = Object.freeze([
  [[-3000, 560], [1174, 560]],
  [[460, 320], [1500, 320]],
  [[460, 320], [460, 560]],
  [[1174, 320], [1174, 560]],
].map((l) => Object.freeze(l.map((p) => Object.freeze(p)))));
export const ROAD_BAND = 38;

// The road runs out over the water where the two roads meet: the coast passes west of the junction at y 525, and
// the shed leaves no land to move the corner onto. So the last stretch is a quay, the way the boardwalk carries the
// y 320 road out to the edge. Two boxes, an L along the road's own corner, covering every part of the drawn 38 px
// band that is east of the waterline. A harness check holds that, and the boat lane stands off its east edge.
export const ROAD_QUAY = Object.freeze([
  Object.freeze([1150, 504, 48, 40]),
  Object.freeze([1104, 538, 94, 48]),
].map((b) => Object.freeze(b)));

function paintRoads(g, T, rand) {
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const pts of ROAD_LINES) strokePolyline(g, pts, T.pathEdge, 38);
  strokePolyline(g, [[492, 196], [1090, 196]], T.pathEdge, 16);
  strokePolyline(g, [[GRAVEYARD.gateX, 534], [GRAVEYARD.gateX, 548]], T.pathEdge, 26);
  for (const pts of ROAD_LINES) strokePolyline(g, pts, T.path, 30);
  strokePolyline(g, [[492, 196], [1090, 196]], T.path, 11);
  strokePolyline(g, [[GRAVEYARD.gateX, 534], [GRAVEYARD.gateX, 548]], T.path, 19);
  g.fillStyle = T.pebble;
  for (let i = 0; i < 140; i++) {
    const pts = ROAD_LINES[i % ROAD_LINES.length];
    const k = rand();
    const x0 = Math.max(pts[0][0], 0);
    const x = x0 + (pts[1][0] - x0) * k + (rand() - 0.5) * 22;
    const y = pts[0][1] + (pts[1][1] - pts[0][1]) * k + (rand() - 0.5) * 22;
    if (x > shoreX(y) - 12) continue;
    fillEllipse(g, x, y, 1.5 + rand() * 2, 1 + rand() * 1.4, T.pebble);
  }
}

// The quay under the road's seaward corner, drawn over the road and under the shed, so the road surface ends on
// planks and the shed's east post stands on them.
function paintRoadQuay(g, T) {
  const [north, deck] = ROAD_QUAY;
  const east = deck[0] + deck[2];
  for (const [x, y] of [[deck[0] + 10, deck[1] + deck[3] - 6], [east - 12, deck[1] + deck[3] - 6], [east - 12, north[1] + 6]]) {
    fillRR(g, x - 4, y, 8, 18, 2, T.woodDark);
  }
  g.fillStyle = 'rgba(0, 0, 0, 0.12)';
  g.fillRect(deck[0] + 6, deck[1] + deck[3], deck[2] - 10, 8);
  for (const [x, y, w, h] of ROAD_QUAY) fillRR(g, x, y, w, h, 3, T.woodLight, T.woodDark, 2);
  g.globalAlpha = 0.5;
  for (let x = deck[0] + 12; x < east - 4; x += 13) line(g, x, deck[1] + 5, x, deck[1] + deck[3] - 4, T.plank, 1.2);
  for (let y = north[1] + 8; y < north[1] + north[3] - 4; y += 11) line(g, north[0] + 4, y, east - 4, y, T.plank, 1.2);
  g.globalAlpha = 1;
  fillEllipse(g, east - 13, deck[1] + 14, 7, 6, T.woodDark);
  fillEllipse(g, east - 13, deck[1] + 12, 5, 3.5, T.wood);
}

function paintTufts(g, T, rand) {
  const [fx, fy, fw, fh] = GRAVEYARD.fence;
  g.strokeStyle = T.tuft;
  g.lineWidth = 1.6;
  g.lineCap = 'round';
  for (let i = 0; i < 320; i++) {
    const x = rand() * W;
    const y = rand() * H;
    if (x > shoreX(y) - 26) continue;
    if (Math.abs(y - 560) < 26 || (Math.abs(y - 320) < 24 && x > 440) || (Math.abs(x - 460) < 24 && y > 300 && y < 580)) continue;
    if (x > fx && x < fx + fw && y > fy && y < fy + fh) continue;
    g.beginPath();
    g.moveTo(x - 3, y - 5);
    g.lineTo(x, y);
    g.lineTo(x + 1, y - 7);
    g.moveTo(x, y);
    g.lineTo(x + 4, y - 4);
    g.stroke();
  }
}

// A saguaro on the tree's own footing and inside the same `treeBox`: the trunk tops out at 1.95r against the
// box's 2.08r, and the far arm reaches 0.68r against its 1.07r.
function paintSaguaro(g, T, x, y, r) {
  fillEllipse(g, x + 4, y + 2, r * 0.9, r * 0.3, T.shadow);
  // An arm is the elbow out from the trunk at `joinY` and the limb standing up from it to `topY`.
  const arm = (ax, joinY, topY) => {
    const w = r * 0.24;
    fillRR(g, ax - w / 2, topY, w, joinY - topY + w, w / 2, T.treeDark);
    fillRR(g, Math.min(ax, x) - w / 2, joinY, Math.abs(ax - x) + w, w, w / 2, T.treeDark);
  };
  arm(x - r * 0.55, y - r * 0.95, y - r * 1.5);
  arm(x + r * 0.5, y - r * 1.15, y - r * 1.65);
  fillRR(g, x - r * 0.17, y - r * 1.95, r * 0.34, r * 1.95 + 2, r * 0.17, T.tree);
  line(g, x - r * 0.06, y - r * 1.85, x - r * 0.06, y - r * 0.2, T.treeDark, 1.2);
  line(g, x + r * 0.06, y - r * 1.85, x + r * 0.06, y - r * 0.2, T.treeLight, 1.2);
  fillEllipse(g, x, y - r * 1.95, r * 0.17, r * 0.1, T.treeLight);
}

// How far an ent's dance may move it, as a fraction of r. It is the crown that binds, not the bole: the crown's
// outer lobe sits 0.72r from the lean and the box allows 1.07r, and the lean is already up to 0.22r of that on
// its own, which leaves 0.13r. There is almost nothing to spare above either, the tallest ent already taking
// 2.05r of 2.08r, so the dance is a lean and a wave and never a stretch: at 0.18 a crown went 0.02 px out.
export const ENT_SWAY = 0.12;
export const ENT_BEAT = 3.7;

// Where an ent is in its dance at t, from -1 to 1, with its own phase off its own position so eight of them are
// never in step. Reduced motion holds every one of them at rest.
export function entSway(t, reduced, x, y) {
  if (reduced) return 0;
  const phase = ((Math.sin(x * 3.117 + y * 9.431) * 27644.6) % 1 + 1) % 1;
  return Math.sin((TAU * (Number(t) || 0)) / ENT_BEAT + phase * TAU);
}

// An ent on the tree's own footing, inside the same `treeBox`: a bole with a face in it, two boughs for arms,
// roots for feet and a mallorn's gold crown for hair. Which way it leans and which arm it lifts come off its own
// position, so eight of them are eight different ents rather than one drawn eight times. Unlike every other tree
// they are drawn per frame rather than into the background layer, because they dance: it rides the village's own
// ambient tick, like the beam and the frontier's horse, and holds still under reduced motion.
// `seed` is what the ent's own two hashes are taken from, and it is the footing rather than the position for a
// reason: which way it leans, how tall it stands, how thick its bole is and which bough it has raised all come
// off those hashes, so a walking ent seeded on where it currently is re-rolls all four of them every frame and
// flickers. One that stands still never showed it, because for those two the footing and the position are the
// same point.
function paintEnt(g, T, x, y, r, sway = 0, stride = 0, seed = null) {
  const [sx, sy] = seed || [x, y];
  const turn = ((Math.sin(sx * 12.9898 + sy * 78.233) * 43758.5453) % 1 + 1) % 1;
  const turn2 = ((Math.sin(sx * 4.898 + sy * 21.773) * 19483.1234) % 1 + 1) % 1;
  // The dance is added to the lean it already had: both together reach 0.34r, which puts the far edge of the
  // crown at 1.06r of the 1.07r the box allows.
  const lean = (turn - 0.5) * 0.44 * r + sway * ENT_SWAY * r;
  const tx = x + lean;
  // Eight ents standing the same height in the same stance read as one ent drawn eight times. How tall it stands
  // and how thick its bole is come off its own position, inside the box either way. The tallest bole takes 1.54r
  // and its crown sits 0.18r above that with a half-height of up to 0.33r, which is 2.05r of the 2.08r the box
  // allows. Raising the bole any further is what pushed a crown out of it.
  const stand = 1.28 + turn2 * 0.26;
  const top = y - r * stand;
  const w = r * (0.38 + turn * 0.14);
  fillEllipse(g, x + 4, y + 2, r * 0.85, r * 0.3, T.shadow);
  // Roots: two splayed feet, inside the box's own width. One steps forward as the other steps back, which at
  // 0.12r keeps the far edge of a foot at 0.72r of the 1.07r the box allows.
  for (const side of [-1, 1]) {
    const rx = x + side * r * 0.4 + side * stride * r * 0.12;
    fillPoly(g, [[x + side * w * 0.3, y - r * 0.45], [rx + side * r * 0.2, y], [rx - side * r * 0.16, y]], T.trunk);
  }
  // The bole, leaning the way this one leans.
  fillPoly(g, [
    [x - w * 0.62, y - r * 0.1], [x + w * 0.62, y - r * 0.1], [tx + w * 0.5, top], [tx - w * 0.5, top],
  ], T.trunk, T.treeDark, 1.4);
  // Grain, so the bole reads as bark rather than as a plank.
  g.globalAlpha = 0.45;
  for (const k of [-0.22, 0.2]) {
    line(g, x + w * k, y - r * 0.2, tx + w * k, top + r * 0.12, T.treeDark, Math.max(1, r * 0.045));
  }
  g.globalAlpha = 1;
  // Two boughs for arms, one lifted higher than the other, swapping by which way it leans.
  const high = turn > 0.5 ? 1 : -1;
  for (const side of [-1, 1]) {
    // The boughs rise and fall out of phase with each other, which is what turns a sway into a dance. Only the
    // lift moves: the reach is fixed, because the arms already come within 0.09r of the side of the box.
    const wave = sway * side * ENT_SWAY * r;
    const lift = (side === high ? r * 1.25 : r * 0.85) + wave;
    const reach = side === high ? r * 0.82 : r * 0.7;
    // Bent at an elbow rather than run straight out: a bough that leaves the bole in a line is a broom handle.
    // The ends are where they always were, so nothing about the box changes.
    const ex = x + side * reach;
    const ey = y - lift;
    const sx2 = tx + side * w * 0.4;
    const sy2 = y - r * 0.95;
    strokePolyline(g, [
      [sx2, sy2], [sx2 + (ex - sx2) * 0.55, sy2 - (sy2 - ey) * 0.72], [ex, ey],
    ], T.trunk, Math.max(2, r * 0.13));
    for (const k of [-0.3, 0.3]) {
      line(g, x + side * reach, y - lift, x + side * (reach + r * 0.16), y - lift - r * (0.16 + k * 0.2), T.treeDark, Math.max(1.4, r * 0.07));
    }
  }
  // The face: two eyes under a heavy brow, and a beard of moss.
  const fy = y - r * 1.12;
  // The beard first, so the face is laid over it rather than the other way round. Three hanging strands of moss
  // inside the span a solid wedge took: as one shape it read as a bib rather than as something growing on bark.
  for (const [k, drop] of [[-0.3, 0.46], [0.02, 0.58], [0.3, 0.42]]) {
    const bx = tx + w * k;
    strokePolyline(g, [
      [bx, fy + r * 0.12], [bx + w * 0.08, fy + r * 0.3], [bx - w * 0.05, y - r * drop],
    ], T.moss, Math.max(1.6, r * 0.1));
  }
  for (const side of [-1, 1]) {
    fillEllipse(g, tx + side * w * 0.36, fy, r * 0.1, r * 0.12, T.treeLight);
    fillEllipse(g, tx + side * w * 0.36, fy + r * 0.02, r * 0.05, r * 0.07, T.woodDark);
    // A heavy brow over each eye, which is most of what makes bark read as a face.
    line(g, tx + side * w * 0.14, fy - r * 0.15, tx + side * w * 0.56, fy - r * 0.19, T.treeDark, Math.max(1.6, r * 0.075));
  }
  // Two twigs up into the crown, so it grows out of the bole rather than sitting on it like a hat.
  for (const side of [-1, 1]) {
    line(g, tx, top + r * 0.1, tx + side * r * 0.3, top - r * 0.16, T.trunk, Math.max(1.4, r * 0.07));
  }
  // The crown, which is a mallorn's. The bole already stands 1.55r up, so the crown has 0.53r of headroom left in
  // the box and takes 0.50r of it: centre 0.16r above the bole, half-height 0.34r. Broken into lobes at
  // different heights rather than domed: one smooth ellipse over a bole is a mushroom, whatever colour it is.
  // Narrow. A crown reaching 0.72r either side of a bole 0.43r thick is a cap on a stalk, whatever it is made
  // of: these reach 0.55r, so the canopy is nearer round than wide and the thing reads as a tree.
  for (const [dx, dy, rx2, ry2] of [[-0.3, 0.0, 0.25, 0.19], [0.3, -0.03, 0.24, 0.18], [-0.1, -0.08, 0.26, 0.2], [0.14, -0.1, 0.24, 0.19]]) {
    fillEllipse(g, tx + r * dx, top + r * dy, r * rx2, r * ry2, T.treeDark);
  }
  for (const [dx, dy, rx2, ry2] of [[-0.2, -0.16, 0.26, 0.19], [0.18, -0.19, 0.24, 0.18], [0, -0.28, 0.24, 0.18], [-0.31, -0.08, 0.2, 0.14], [0.31, -0.1, 0.18, 0.13]]) {
    fillEllipse(g, tx + r * dx, top + r * (dy - turn2 * 0.04), r * rx2, r * ry2, T.tree);
  }
  fillEllipse(g, tx - r * 0.12, top - r * (0.33 + turn2 * 0.04), r * 0.16, r * 0.1, T.treeLight);
  fillEllipse(g, tx + r * 0.2, top - r * 0.22, r * 0.11, r * 0.08, T.treeLight);
}

// A mallorn on the tree's own footing: a silver bole and a gold crown, inside the same `treeBox`. The crown tops
// out at 2.04r against the box's 2.08r, and reaches 0.98r wide against its 1.07r.
function paintMallorn(g, T, x, y, r) {
  fillEllipse(g, x + 4, y + 2, r * 0.9, r * 0.3, T.shadow);
  fillRR(g, x - r * 0.13, y - r * 1.5, r * 0.26, r * 1.5 + 2, r * 0.13, T.trunk);
  // Two boughs lifting away from the bole, which is what keeps a tall tree from reading as a lollipop.
  line(g, x, y - r * 1.15, x - r * 0.42, y - r * 1.5, T.trunk, Math.max(1.6, r * 0.09));
  line(g, x, y - r * 1.3, x + r * 0.4, y - r * 1.62, T.trunk, Math.max(1.6, r * 0.09));
  fillEllipse(g, x - r * 0.42, y - r * 1.62, r * 0.46, r * 0.34, T.treeDark);
  fillEllipse(g, x + r * 0.42, y - r * 1.7, r * 0.44, r * 0.32, T.treeDark);
  fillEllipse(g, x, y - r * 1.6, r * 0.62, r * 0.44, T.tree);
  fillEllipse(g, x - r * 0.16, y - r * 1.78, r * 0.3, r * 0.2, T.treeLight);
}

function paintTree(g, T, x, y, r, sway = 0) {
  if (T.pack === 'west') {
    paintSaguaro(g, T, x, y, r);
    return;
  }
  if (T.pack === 'shire') {
    paintEnt(g, T, x, y, r, sway);
    return;
  }
  fillEllipse(g, x + 4, y + 2, r * 0.9, r * 0.3, T.shadow);
  fillRR(g, x - 5, y - r * 0.9, 10, r * 0.9 + 2, 3, T.trunk);
  fillEllipse(g, x - r * 0.45, y - r * 1.05, r * 0.62, r * 0.58, T.treeDark);
  fillEllipse(g, x + r * 0.45, y - r * 1.0, r * 0.62, r * 0.58, T.treeDark);
  fillEllipse(g, x, y - r * 1.4, r * 0.75, r * 0.68, T.tree);
  fillEllipse(g, x - r * 0.18, y - r * 1.62, r * 0.36, r * 0.28, T.treeLight);
}

// Every tree, as [x, y, radius] of its trunk base. The bottom one stands at 712 rather than out at 1112, where the
// coast now is: a tree is drawn after the sea, so one east of the waterline is painted on top of the water.
export const TREES = Object.freeze([
  [452, 104, 26], [1252, 84, 30], [14, 664, 34], [20, 896, 26], [712, 896, 22],
  [22, 250, 30], [700, 34, 18], [1110, 34, 20],
].map((t) => Object.freeze(t)));

// The ground a tree covers as drawn: the canopy, and the ground shadow, which reaches furthest right on a small
// one. Kept beside paintTree, which it has to agree with.
export function treeBox([x, y, r]) {
  const left = x - 1.07 * r;
  const right = Math.max(x + 1.07 * r, x + 0.9 * r + 4);
  return [left, y - 2.08 * r, right - left, 2.08 * r + 2 + 0.3 * r];
}

// Every tree but an ent. An ent dances, so it cannot live in a layer that is painted once: the village draws
// those per frame instead (`drawEnts`), on the ambient tick.
function paintTrees(g, T) {
  if (T.pack === 'shire') return;
  for (const [x, y, r] of TREES) paintTree(g, T, x, y, r);
}

function paintFlowers(g, T, rand) {
  const beds = [[150, 890], [300, 886], [470, 250], [680, 884], [760, 612], [1150, 300]];
  const shire = T.pack === 'shire';
  for (const [bx, by] of beds) {
    for (let i = 0; i < 9; i++) {
      const x = bx + (rand() - 0.5) * 42;
      const y = by + (rand() - 0.5) * 12;
      if (shire) {
        // Mushrooms on the flowers' own beds and the same seed, which the Shire has rather more of than flowers.
        fillEllipse(g, x, y + 3, 2.8, 1.2, T.shadow);
        fillRR(g, x - 1, y - 1, 2, 5, 1, T.wall);
        fillEllipse(g, x, y - 1, 3.4, 2.4, T.flowers[i % T.flowers.length]);
        fillEllipse(g, x - 1, y - 2, 1, 0.7, T.wall);
        continue;
      }
      fillEllipse(g, x, y + 3, 2.6, 1.2, T.treeDark);
      fillEllipse(g, x, y, 2.6, 2.6, T.flowers[i % T.flowers.length]);
    }
  }
}

// The bank, built around the cottage's own rect and door: a stone front with a stepped parapet where the pitch
// was, and a hitching rail where the window box is. The parapet tops out at 74, inside the roof's own apex at 68.
function paintBank(g, T) {
  const bx = COTTAGE.x;
  const by = COTTAGE.y;
  fillEllipse(g, bx + 6, by + 4, 82, 10, T.shadow);
  // The stepped front: three courses rising to the middle, all inside the roof's triangle.
  fillRR(g, bx - 78, 110, 156, 20, 2, T.stoneDark);
  fillRR(g, bx - 52, 92, 104, 22, 2, T.stone, T.stoneDark, 2);
  fillRR(g, bx - 24, 74, 48, 22, 2, T.stone, T.stoneDark, 2);
  fillRR(g, bx - 68, 122, 136, 92, 3, T.stone);
  fillRR(g, bx - 68, 200, 136, 14, 2, T.stoneDark);
  // Two pilasters either side of the door, which is what makes a stone front read as a bank and not a warehouse.
  for (const px of [bx - 46, bx + 34]) fillRR(g, px, 128, 12, 78, 1, T.wallShade, T.stoneDark, 1);
  fillRR(g, bx - 16, 166, 32, 48, 3, T.door);
  fillEllipse(g, bx + 10, 192, 1.8, 1.8, T.steel);
  for (const [x, y, w, h] of COTTAGE_WINDOWS) {
    fillRR(g, x, y, w, h, 2, T.windowDark, T.woodDark, 2);
    // A teller's grille rather than a cottage's glazing bars.
    for (let i = 1; i < 4; i++) line(g, x + (w * i) / 4, y + 2, x + (w * i) / 4, y + h - 2, T.steel, 1.2);
    line(g, x, y + h / 2, x + w, y + h / 2, T.steel, 1.2);
  }
  fillRR(g, bx - 22, by, 44, 8, 2, T.stone, T.stoneDark, 1);
  // The hitching rail, on the window box's footing.
  for (const px of [bx - 62, bx - 30]) fillRR(g, px, 168, 5, 30, 1, T.woodDark);
  fillRR(g, bx - 66, 168, 44, 5, 2, T.wood, T.woodDark, 1);
  fillRR(g, bx + 74, 178, 22, 36, 3, T.wood, T.woodDark, 1.5);
  fillEllipse(g, bx + 85, 178, 11, 4, T.woodLight);
}

// The cottage on the green: one small house with a door to click. Idle and recent rows are inside, not in front.
// Bag End, built around the cottage's own rect, door and windows: a green hill where the walls and the pitch
// were, a round door on the door's own footing, and round panes in the same two openings, so the lit-window
// drawing that follows the crowd inside still fills exactly what is painted.
function paintBagEnd(g, T) {
  const bx = COTTAGE.x;
  const by = COTTAGE.y;
  fillEllipse(g, bx + 6, by + 4, 82, 10, T.shadow);
  // The hill: the upper half of an ellipse, so it stops on the cottage's own base line rather than running down
  // past the ground the place declares.
  const dome = (inset, fill) => {
    g.beginPath();
    g.ellipse(bx, by, 80 - inset, 138 - inset * 1.7, 0, Math.PI, TAU);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  dome(0, T.grassDark);
  dome(5, T.grass);
  g.globalAlpha = 0.5;
  for (const [dx, dy, rx] of [[-46, 46, 22], [30, 30, 26], [-10, 76, 30]]) {
    fillEllipse(g, bx + dx, by - dy, rx, rx * 0.34, T.grassLight);
  }
  g.globalAlpha = 1;
  fillRR(g, bx + 54, 76, 15, 34, 2, T.stoneDark);
  fillEllipse(g, bx + 61.5, 74, 10, 4, T.stone);
  // The round door, on the square door's own centre.
  fillEllipse(g, bx, 190, 27, 27, T.wood);
  fillEllipse(g, bx, 190, 23, 23, T.door, T.woodDark, 1.5);
  line(g, bx, 167, bx, 213, T.woodDark, 1.2);
  fillEllipse(g, bx, 190, 3.2, 3.2, T.thatch, T.woodDark, 1);
  // The same two openings, as round panes: `litWindow` fills each box as a capsule, which is this shape.
  for (const [x, y, w, h] of COTTAGE_WINDOWS) {
    const r = Math.min(w, h) / 2;
    fillRR(g, x - 4, y - 4, w + 8, h + 8, r + 4, T.wood, T.woodDark, 1.5);
    paintLeadedWindow(g, T, x, y, w, h, r);
  }
  fillRR(g, bx - 22, by, 44, 8, 2, T.stone, T.stoneDark, 1);
  fillRR(g, bx + 74, 178, 22, 36, 3, T.wood, T.woodDark, 1.5);
  fillEllipse(g, bx + 85, 178, 11, 4, T.woodLight);
  fillRR(g, bx - 60, 168, 34, 10, 2, T.woodDark);
  for (let i = 0; i < 4; i++) fillEllipse(g, bx - 55 + i * 9, 166, 3, 3, T.flowers[i % T.flowers.length]);
}

function paintCottage(g, T) {
  if (T.pack === 'west') {
    paintBank(g, T);
    return;
  }
  if (T.pack === 'shire') {
    paintBagEnd(g, T);
    return;
  }
  const bx = COTTAGE.x;
  const by = COTTAGE.y;
  fillEllipse(g, bx + 6, by + 4, 82, 10, T.shadow);
  fillRR(g, bx + 54, 76, 15, 34, 2, T.stoneDark);
  fillPoly(g, [[bx - 78, 128], [bx, 68], [bx + 78, 128]], T.roofs[0], 'rgba(0, 0, 0, 0.18)', 2);
  fillRR(g, bx - 68, 122, 136, 92, 3, T.wall);
  fillRR(g, bx - 68, 200, 136, 14, 2, T.wallShade);
  fillRR(g, bx - 16, 166, 32, 48, 3, T.door);
  fillEllipse(g, bx + 10, 192, 1.8, 1.8, T.stone);
  for (const [x, y, w, h] of COTTAGE_WINDOWS) {
    fillRR(g, x, y, w, h, 2, T.windowDark, T.woodDark, 2);
    line(g, x + w / 2, y, x + w / 2, y + h, T.woodDark, 1.5);
    line(g, x, y + h / 2, x + w, y + h / 2, T.woodDark, 1.5);
  }
  fillRR(g, bx - 22, by, 44, 8, 2, T.stone, T.stoneDark, 1);
  fillRR(g, bx + 74, 178, 22, 36, 3, T.wood, T.woodDark, 1.5);
  fillEllipse(g, bx + 85, 178, 11, 4, T.woodLight);
  fillRR(g, bx - 60, 168, 34, 10, 2, T.woodDark);
  for (let i = 0; i < 4; i++) fillEllipse(g, bx - 55 + i * 9, 166, 3, 3, T.flowers[i % T.flowers.length]);
}

function paintWorkshop(g, T) {
  const west = T.pack === 'west';
  fillEllipse(g, 830, 544, 356, 12, T.shadow);
  const shire = T.pack === 'shire';
  fillRR(g, 486, 386, 672, 152, 6, shire ? T.wallShade : T.woodLight, T.woodDark, 2);
  if (shire) {
    // A smithy's back wall: a stone footing, timber posts with braces between them, and a rail across the top.
    fillRR(g, 486, 492, 672, 46, 4, T.stone, T.stoneDark, 2);
    g.globalAlpha = 0.4;
    for (let x = 512; x < 1150; x += 42) line(g, x, 494, x, 536, T.stoneDark, 1.2);
    for (let y = 504; y < 536; y += 14) line(g, 490, y, 1154, y, T.stoneDark, 1.2);
    g.globalAlpha = 1;
    fillRR(g, 486, 386, 672, 9, 1, T.woodDark);
    fillRR(g, 486, 440, 672, 8, 1, T.woodDark);
    for (let x = 500; x < 1150; x += 74) {
      fillRR(g, x, 386, 9, 106, 1, T.woodDark);
      line(g, x + 9, 486, x + 34, 450, T.woodDark, 5);
      line(g, x + 68, 486, x + 44, 450, T.woodDark, 5);
    }
  } else {
    g.globalAlpha = 0.45;
    for (let x = 520; x < 1158; x += 34) line(g, x, 388, x, 536, T.plank, 1.5);
    g.globalAlpha = 1;
  }
  g.fillStyle = 'rgba(0, 0, 0, 0.1)';
  g.fillRect(488, 386, 668, 12);
  fillRR(g, 481, 352, 12, 190, 2, shire ? T.stoneDark : T.woodDark);
  fillRR(g, 1151, 352, 12, 190, 2, shire ? T.stoneDark : T.woodDark);
  fillRR(g, 472, 340, 700, 46, 6, T.roofs[1], 'rgba(0, 0, 0, 0.2)', 2);
  if (shire) {
    // Tiles on the canopy's own slab: three courses, each lapping the one below, and a ridge over the top.
    g.globalAlpha = 0.55;
    for (let row = 0; row < 3; row += 1) {
      const ty = 350 + row * 12;
      for (let x = 476 + (row % 2) * 9; x + 16 <= 1168; x += 18) fillRR(g, x, ty, 16, 11, 3, T.stone, T.stoneDark, 0.8);
    }
    g.globalAlpha = 1;
    fillRR(g, 473, 336, 698, 9, 3, T.stoneDark);
  }
  g.globalAlpha = 0.35;
  g.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  g.lineWidth = 1.5;
  for (let x = 484; x < 1164; x += 26) {
    g.beginPath();
    g.arc(x + 13, 386, 13, Math.PI, TAU);
    g.stroke();
  }
  line(g, 480, 352, 1164, 352, 'rgba(255, 255, 255, 0.5)', 2);
  g.globalAlpha = 1;
  if (T.pack === 'shire') {
    // A smith's shop on the shed's own footing: an anvil where the sawhorse stood and a hearth where the cabinet
    // did, both inside the shed's own numbers, so the Workshop's two road contacts are untouched.
    fillRR(g, 500, 508, 34, 20, 2, T.woodDark);
    fillPoly(g, [[496, 494], [540, 494], [534, 502], [530, 508], [504, 508], [500, 502]], T.steel, T.stoneDark, 1.5);
    fillPoly(g, [[534, 494], [548, 490], [540, 500]], T.steel, T.stoneDark, 1.5);
    fillRR(g, 1104, 486, 48, 42, 3, T.stone, T.stoneDark, 2);
    fillRR(g, 1112, 500, 32, 24, 2, T.castleDoor);
    fillEllipse(g, 1128, 518, 13, 7, T.flame);
    fillEllipse(g, 1128, 520, 7, 4, T.flameCore);
    fillPoly(g, [[1100, 486], [1156, 486], [1146, 466], [1110, 466]], T.stoneDark);
    fillRR(g, 1120, 440, 16, 28, 2, T.stoneDark);
    return;
  }
  if (west) {
    // A depot's valance under the canopy, and the platform edge with the rails beyond it. Both stay inside the
    // shed's own numbers, so the Workshop's two road contacts are untouched.
    for (let x = 484; x + 24 <= 1156; x += 24) fillPoly(g, [[x, 386], [x + 24, 386], [x + 12, 398]], T.woodDark);
    fillRR(g, 486, 524, 672, 6, 1, T.stoneDark);
    line(g, 490, 534, 1154, 534, T.steel, 2);
    for (let x = 496; x < 1154; x += 28) line(g, x, 530, x, 538, T.woodDark, 2.5);
    // A baggage cart on the sawhorse's footing, and a water column where the cabinet stood.
    fillRR(g, 496, 494, 44, 26, 2, T.wood, T.woodDark, 1.5);
    fillEllipse(g, 506, 524, 7, 7, T.woodDark);
    fillEllipse(g, 532, 524, 7, 7, T.woodDark);
    fillRR(g, 1118, 470, 20, 54, 3, T.plank, T.woodDark, 1.5);
    fillRR(g, 1108, 458, 40, 16, 4, T.wood, T.woodDark, 1.5);
    line(g, 1128, 500, 1146, 512, T.woodDark, 3);
    return;
  }
  line(g, 500, 530, 510, 498, T.woodDark, 3);
  line(g, 530, 530, 520, 498, T.woodDark, 3);
  fillRR(g, 496, 494, 40, 7, 2, T.wood, T.woodDark, 1.2);
  fillRR(g, 1110, 498, 34, 30, 2, T.wood, T.woodDark, 1.5);
  fillRR(g, 1116, 472, 24, 26, 2, T.woodLight, T.woodDark, 1.5);
  line(g, 1110, 513, 1144, 513, T.woodDark, 1);
}

function paintPorchHouse(g, T) {
  const west = T.pack === 'west';
  g.save();
  g.translate(HOUSE_DX, 0);
  fillEllipse(g, 1120, 830, 150, 12, T.shadow);
  fillRR(g, 1188, 614, 16, 44, 2, T.stoneDark);
  fillRR(g, 1012, 684, 222, 118, 3, T.wall);
  if (T.pack === 'shire') {
    // Timber framing over the plaster: posts, two rails and a brace each side, all inside the wall's own rect.
    // Half-timbering is most of the difference between a cottage and an inn here.
    fillRR(g, 1012, 684, 222, 7, 1, T.woodDark);
    fillRR(g, 1012, 750, 222, 6, 1, T.woodDark);
    fillRR(g, 1012, 796, 222, 6, 1, T.woodDark);
    for (const px of [1012, 1084, 1156, 1227]) fillRR(g, px, 684, 7, 118, 1, T.woodDark);
    line(g, 1090, 794, 1150, 758, T.woodDark, 5);
    line(g, 1221, 794, 1162, 758, T.woodDark, 5);
  }
  if (T.pack === 'shire') {
    // Thatch on the pitch's own triangle, and the inn's sign hanging under the porch beam.
    fillPoly(g, [[994, 694], [1123, 604], [1252, 694]], T.thatch, T.thatchDark, 2);
    g.globalAlpha = 0.45;
    for (let i = 1; i < 7; i += 1) {
      const k = i / 7;
      line(g, 994 + (1123 - 994) * k, 694 - (694 - 604) * k, 1252 - (1252 - 1123) * k, 694 - (694 - 604) * k, T.thatchDark, 2);
    }
    g.globalAlpha = 1;
    // The sign on the gable, where a dark board reads against thatch. On the wall below it was cream on cream.
    fillRR(g, 1086, 650, 76, 38, 3, T.woodDark, T.signBoard, 2);
    // A dragon: tail, body, a long neck and a snout, with one wing over it. Drawn as a curve rather than a row of
    // points, because straight edges at this size read as a mountain, which is what the first attempt looked like.
    g.beginPath();
    g.moveTo(1092, 682);
    g.quadraticCurveTo(1108, 678, 1120, 679);
    g.quadraticCurveTo(1134, 679, 1137, 668);
    g.quadraticCurveTo(1140, 657, 1150, 657);
    g.lineTo(1157, 661);
    g.lineTo(1148, 663);
    g.quadraticCurveTo(1143, 665, 1141, 673);
    g.quadraticCurveTo(1130, 670, 1119, 672);
    g.quadraticCurveTo(1105, 671, 1092, 682);
    g.closePath();
    g.fillStyle = T.signBoard;
    g.fill();
    fillPoly(g, [[1118, 673], [1127, 654], [1137, 671]], T.signBoard);
  } else if (west) {
    // A false front where the pitch was, inside the same triangle: flat to the roof's own apex at 604, so nothing
    // here rises any nearer the road than the porch house already did.
    fillRR(g, 994, 604, 258, 92, 2, T.wallShade, T.woodDark, 2);
    fillRR(g, 994, 604, 258, 13, 2, T.woodDark);
    fillRR(g, 994, 638, 258, 5, 1, T.woodDark);
    g.globalAlpha = 0.4;
    for (let x = 1012; x < 1250; x += 22) line(g, x, 620, x, 694, T.woodDark, 1.4);
    g.globalAlpha = 1;
    // The two brackets that hold a false front up, which is what says it is a front and not a wall.
    for (const bx of [1006, 1232]) fillPoly(g, [[bx, 696], [bx + 14, 696], [bx, 682]], T.woodDark);
  } else if (T.pack !== 'shire') {
    fillPoly(g, [[994, 694], [1123, 604], [1252, 694]], T.roofs[0], 'rgba(0, 0, 0, 0.2)', 2);
  }
  if (west) {
    // Batwing doors: the opening is dark all the way down, and the two leaves cover its middle only.
    fillRR(g, 1040, 734, 34, 68, 3, T.windowDark);
    fillRR(g, 1040, 748, 16, 38, 2, T.wood, T.woodDark, 1.5);
    fillRR(g, 1058, 748, 16, 38, 2, T.wood, T.woodDark, 1.5);
  } else if (T.pack === 'shire') {
    fillRR(g, 1040, 734, 34, 68, 3, T.door, T.woodDark, 2);
    g.globalAlpha = 0.5;
    for (const dx of [11, 22]) line(g, 1040 + dx, 736, 1040 + dx, 800, T.woodDark, 1.4);
    g.globalAlpha = 1;
    for (const dy of [744, 790]) fillRR(g, 1042, dy, 30, 4, 1, T.woodDark);
    g.beginPath();
    g.arc(1066, 770, 4, 0, TAU);
    g.strokeStyle = T.thatch;
    g.lineWidth = 2;
    g.stroke();
  } else {
    fillRR(g, 1040, 734, 34, 68, 3, T.door);
    fillEllipse(g, 1067, 770, 2, 2, T.stone);
  }
  for (const x of [1104, 1172]) {
    if (T.pack === 'shire') {
      paintLeadedWindow(g, T, x, 712, 42, 34, 2);
      continue;
    }
    fillRR(g, x, 712, 42, 34, 2, T.porchWindow, T.woodDark, 2);
    line(g, x + 21, 712, x + 21, 746, T.woodDark, 1.5);
  }
  fillRR(g, 990, 800, 256, 24, 3, T.woodLight, T.woodDark, 2);
  g.globalAlpha = 0.5;
  for (let x = 1010; x < 1246; x += 20) line(g, x, 802, x, 822, T.plank, 1.2);
  g.globalAlpha = 1;
  line(g, 1100, 778, 1242, 778, T.woodDark, 3);
  for (let x = 1104; x <= 1240; x += 17) line(g, x, 778, x, 800, T.woodDark, 2);
  fillRR(g, 1030, 824, 60, 12, 2, T.stone, T.stoneDark, 1);
  fillRR(g, 1036, 836, 48, 11, 2, T.stone, T.stoneDark, 1);

  fillRR(g, 944, 826, 24, 8, 2, T.stoneDark);
  fillRR(g, 952, 698, 8, 132, 2, T.woodDark);
  line(g, 954, 704, 988, 704, T.woodDark, 3);
  const lx = LANTERN.x - HOUSE_DX;
  line(g, lx, 704, lx, 712, T.woodDark, 1.5);
  fillPoly(g, [[lx - 12, 716], [lx, 708], [lx + 12, 716]], T.woodDark);
  fillRR(g, lx - 9, 715, 18, 24, 3, T.lanternGlass, T.woodDark, 2);
  g.restore();
}

function paintHarbour(g, T) {
  // Deck posts, the deck, the boardwalk out to the edge, and the pier running south into open water.
  const [dx, dy, dw, dh] = HARBOUR_DECK;
  const deckBottom = dy + dh;
  const { x: pierX, tip: pierTip, half: pierHalf } = PIER;
  for (const x of [dx + 18, dx + 98, dx + 178]) fillRR(g, x - 4, deckBottom - 2, 8, 16, 2, T.woodDark);
  fillRR(g, 1560 - 4, 334, 8, 14, 2, T.woodDark);
  for (const y of [deckBottom + 22, pierTip - 16]) {
    fillRR(g, pierX - pierHalf - 3, y, 6, 16, 2, T.woodDark);
    fillRR(g, pierX + pierHalf - 3, y, 6, 16, 2, T.woodDark);
  }
  g.fillStyle = 'rgba(0, 0, 0, 0.12)';
  g.fillRect(dx + 8, deckBottom, dw - 8, 8);
  g.fillRect(pierX - pierHalf + 4, pierTip, 2 * pierHalf - 4, 7);
  fillRR(g, pierX - pierHalf, deckBottom - 6, 2 * pierHalf, pierTip - deckBottom + 6, 3, T.woodLight, T.woodDark, 2);
  g.globalAlpha = 0.5;
  for (let y = deckBottom + 6; y < pierTip - 2; y += 10) line(g, pierX - pierHalf + 1, y, pierX + pierHalf - 1, y, T.plank, 1.2);
  g.globalAlpha = 1;
  fillRR(g, dx, dy, dw, dh, 4, T.woodLight, T.woodDark, 2);
  g.globalAlpha = 0.5;
  for (let y = dy + 18; y < deckBottom; y += 18) line(g, dx + 2, y, dx + dw - 2, y, T.plank, 1.2);
  g.globalAlpha = 1;
  fillRR(g, 1466, 302, 160, 36, 3, T.woodLight, T.woodDark, 2);
  g.globalAlpha = 0.5;
  for (let x = 1478; x < 1620; x += 14) line(g, x, 304, x, 336, T.plank, 1.2);
  g.globalAlpha = 1;
  const bollards = [[dx + 178, dy + 12], [dx + 14, dy + 12], [dx + 14, deckBottom - 12], [1554, 334],
    [pierX - pierHalf + 4, pierTip - 5], [pierX + pierHalf - 4, pierTip - 5]];
  for (const [x, y] of bollards) {
    fillEllipse(g, x, y, 7, 6, T.woodDark);
    fillEllipse(g, x, y - 2, 5, 3.5, T.wood);
  }
  if (T.pack === 'shire') {
    // Two slim arches at the head of the pier, on the deck's own footing: a quay you sail from, not a jetty.
    for (const ax of [dx + 52, dx + 138]) {
      for (const cx2 of [ax - 26, ax + 26]) fillRR(g, cx2 - 5, dy + 6, 10, 82, 3, T.lighthouse, T.slate, 1.5);
      g.beginPath();
      g.moveTo(ax - 31, dy + 30);
      g.quadraticCurveTo(ax - 31, dy - 2, ax, dy - 14);
      g.quadraticCurveTo(ax + 31, dy - 2, ax + 31, dy + 30);
      g.lineTo(ax + 21, dy + 30);
      g.quadraticCurveTo(ax + 21, dy + 8, ax, dy - 2);
      g.quadraticCurveTo(ax - 21, dy + 8, ax - 21, dy + 30);
      g.closePath();
      g.fillStyle = T.lighthouse;
      g.fill();
      g.strokeStyle = T.slate;
      g.lineWidth = 1.5;
      g.stroke();
      fillEllipse(g, ax, dy - 18, 6, 6, T.flagAlt, T.slate, 1.2);
    }
  }
  paintPatrolBooth(g, T);

  // The lighthouse on its rocks, top right.
  for (const [x, y, rx, ry] of [[1548, 178, 34, 14], [1590, 170, 22, 11], [1510, 186, 16, 8]]) {
    fillEllipse(g, x, y, rx, ry, T.stoneDark);
    fillEllipse(g, x - rx * 0.2, y - ry * 0.35, rx * 0.55, ry * 0.45, T.stone);
  }
  const lh = [[1530, 172], [1568, 172], [1561, 82], [1537, 82]];
  fillPoly(g, lh, T.towerStone, T.towerEdge, 1.5);
  g.save();
  g.beginPath();
  lh.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.clip();
  if (T.pack === 'west') {
    // A water tower's iron hoops where the lighthouse has its bands, inside the tower's own outline. The lantern
    // above is left exactly where it is: the night beam is aimed from it, and moving it would move the beam.
    g.fillStyle = T.steel;
    for (const y of [100, 124, 148]) g.fillRect(1520, y, 60, 5);
    g.strokeStyle = T.woodDark;
    g.lineWidth = 1.2;
    for (let x = 1528; x < 1576; x += 8) line(g, x, 82, x, 172, T.woodDark, 1.2);
  } else if (T.pack === 'shire') {
    // A dark tower: buttresses up the shaft instead of painted bands, and no light of its own. What burns at the
    // top is drawn with the night lighting, where the beam is aimed from.
    g.fillStyle = T.towerEdge;
    for (const x of [1528, 1546, 1564]) g.fillRect(x, 82, 5, 90);
    g.fillStyle = T.towerStone;
    for (const y of [96, 122, 148]) g.fillRect(1520, y, 60, 4);
  } else {
    g.fillStyle = T.slate;
    g.fillRect(1520, 108, 60, 12);
    g.fillRect(1520, 142, 60, 12);
  }
  g.restore();
  if (T.pack === 'shire') {
    fillRR(g, 1536, 66, 26, 17, 3, T.towerStone, T.towerEdge, 1.5);
    // Two horns either side of the socket the Eye sits in, on the cap's own footing.
    fillPoly(g, [[1532, 68], [1536, 46], [1541, 68]], T.towerEdge);
    fillPoly(g, [[1557, 68], [1562, 46], [1566, 68]], T.towerEdge);
  } else {
    fillRR(g, 1536, 66, 26, 17, 3, T.lanternGlass, T.slate, 1.5);
    fillPoly(g, [[1532, 68], [1549, 52], [1566, 68]], T.roofs[1]);
  }

  g.lineCap = 'round';
  for (const [x, y] of [[1296, 500], [1300, 146], [1158, 690], [1150, 820]]) {
    for (let i = 0; i < 5; i++) line(g, x + i * 4, y, x + i * 4 + (i - 2) * 2, y - 16 - (i % 2) * 6, T.treeDark, 2);
  }
}

// The guard's platform on its piles beside the pier, and the booth behind where the guard stands.
function paintPatrolBooth(g, T) {
  const [px, py, pw, ph] = PATROL_PLATFORM;
  for (const x of [px + 10, px + pw - 10]) fillRR(g, x - 3, py + 8, 6, ph - 6, 2, T.woodDark);
  fillEllipse(g, px + pw / 2, py + ph - 2, pw / 2 + 4, 4, T.shadow);
  fillRR(g, px, py, pw, 12, 3, T.woodLight, T.woodDark, 1.5);
  g.globalAlpha = 0.5;
  for (let x = px + 12; x < px + pw - 4; x += 12) line(g, x, py + 1, x, py + 11, T.plank, 1.2);
  g.globalAlpha = 1;
  const [bx, by, bw, bh] = BOOTH_BOX;
  fillRR(g, bx + 3, by + 10, bw - 6, bh - 10, 2, T.patrolWhite, T.patrolNavy, 1.5);
  fillRR(g, bx + 7, by + 16, bw - 14, 12, 2, T.windowDark, T.patrolNavy, 1.5);
  line(g, bx + bw / 2, by + 16, bx + bw / 2, by + 28, T.patrolNavy, 1.2);
  fillRR(g, bx + 3, by + 33, bw - 6, 4, 1, T.patrolNavy);
  fillPoly(g, [[bx - 1, by + 12], [bx + 4, by], [bx + bw - 4, by], [bx + bw + 1, by + 12]], T.patrolNavy);
  line(g, bx + 1, by + 11, bx + bw - 1, by + 11, T.patrolWhite, 1.2);
}

function paintSandCastle(g, T) {
  const cx = CASTLE.x;
  const by = CASTLE.y;
  const west = T.pack === 'west';
  const shire = T.pack === 'shire';
  g.save();
  g.translate(cx, by);
  g.scale(CASTLE.s, CASTLE.s);
  g.translate(-cx, -by);
  fillEllipse(g, cx + 6, by + 4, 88, 12, T.shadow);
  fillEllipse(g, cx, by + 3, 82, 9, T.sandWet);
  // In the frontier town the same run of merlons is a broken rock line: same span, same 11 px of headroom, so the
  // mesa stands exactly as tall as the castle did and the openings below it do not move.
  const merlons = (x0, x1, y, w = 10, gap = 6) => {
    const n = Math.max(1, Math.floor((x1 - x0 + gap) / (w + gap)));
    const start = x0 + (x1 - x0 - (n * w + (n - 1) * gap)) / 2;
    // A white tower caps each run once rather than toothing it, so the same merlon numbers raise a spire.
    if (shire) {
      fillPoly(g, [[x0 - 3, y + 2], [(x0 + x1) / 2, y - 24], [x1 + 3, y + 2]], T.castle, T.castleDark, 1.4);
      return;
    }
    for (let i = 0; i < n; i++) {
      const x = start + i * (w + gap);
      if (!west) {
        fillRR(g, x, y - 9, w, 11, 2, T.castle, T.castleDark, 1.2);
        continue;
      }
      const lift = i % 2 ? 4 : 9;
      fillPoly(g, [[x - gap / 2, y + 2], [x + w / 2, y - lift], [x + w + gap / 2, y + 2]], T.castle, T.castleDark, 1.2);
    }
  };
  const ridges = (x0, x1, ys) => {
    g.globalAlpha = 0.7;
    for (const y of ys) line(g, x0 + 2, y, x1 - 2, y, T.castleShade, 2);
    g.globalAlpha = 1;
  };
  // Keep, behind the wall.
  merlons(cx - 24, cx + 24, by - 124, 9, 4);
  fillRR(g, cx - 26, by - 126, 52, 70, 2, T.castle, T.castleDark, 1.5);
  ridges(cx - 26, cx + 26, [by - 100, by - 76]);
  fillRR(g, cx - 5, by - 112, 10, 15, 5, T.castleDoor);
  // Curtain wall.
  merlons(cx - 44, cx + 44, by - 64);
  fillRR(g, cx - 46, by - 66, 92, 66, 2, T.castle, T.castleDark, 1.5);
  ridges(cx - 46, cx + 46, [by - 22]);
  // Turrets: upturned buckets.
  for (const tx of [cx - 58, cx + 58]) {
    fillPoly(g, [[tx - 20, by], [tx + 20, by], [tx + 16, by - 96], [tx - 16, by - 96]], T.castle, T.castleDark, 1.5);
    g.globalAlpha = 0.55;
    fillPoly(g, [[tx + 6, by], [tx + 20, by], [tx + 16, by - 96], [tx + 5, by - 96]], T.castleShade);
    g.globalAlpha = 1;
    ridges(tx - 18, tx + 18, [by - 30, by - 62]);
    merlons(tx - 17, tx + 17, by - 96, 8, 5);
    fillRR(g, tx - 4, by - 84, 8, 14, 4, T.castleDoor);
  }
  if (west) {
    // The mine's timbered portal on the door's own opening: two posts, a lintel, the rails running out of it and
    // an ore cart standing on them. All of it inside the curtain wall's width, so the castle's footprint holds.
    // A square-cut adit, so it is not one of the capsule openings the night lighting fills: those are the keep's
    // and the two turrets', which this branch leaves exactly where they are.
    g.fillStyle = T.castleDoor;
    g.fillRect(cx - 15, by - 40, 30, 40);
    fillRR(g, cx - 20, by - 46, 40, 8, 1, T.woodDark);
    fillRR(g, cx - 20, by - 40, 6, 40, 1, T.wood, T.woodDark, 1.2);
    fillRR(g, cx + 14, by - 40, 6, 40, 1, T.wood, T.woodDark, 1.2);
    for (const rx of [cx - 8, cx + 8]) line(g, rx, by - 34, rx, by, T.steel, 2);
    for (let y = by - 30; y <= by - 4; y += 9) line(g, cx - 12, y, cx + 12, y, T.woodDark, 2);
    fillRR(g, cx - 34, by - 26, 26, 20, 2, T.plank, T.woodDark, 1.5);
    fillEllipse(g, cx - 28, by - 4, 4.5, 4.5, T.steel);
    fillEllipse(g, cx - 14, by - 4, 4.5, 4.5, T.steel);
    fillEllipse(g, cx - 21, by - 28, 10, 4, T.stoneDark);
  } else {
    // Door with a scalloped arch.
    g.beginPath();
    g.moveTo(cx - 13, by);
    g.lineTo(cx - 13, by - 22);
    g.arc(cx, by - 22, 13, Math.PI, TAU);
    g.lineTo(cx + 13, by);
    g.closePath();
    g.fillStyle = T.castleDoor;
    g.fill();
    g.strokeStyle = T.castleDark;
    g.lineWidth = 2;
    g.stroke();
  }
  if (shire) {
    // A banner down the keep's face, which is what a white tower has where a sand castle has shells.
    fillPoly(g, [
      [cx - 9, by - 116], [cx + 9, by - 116], [cx + 9, by - 74], [cx, by - 82], [cx - 9, by - 74],
    ], T.flag, T.castleDark, 1.2);
    for (const tx of [cx - 58, cx + 58]) fillEllipse(g, tx, by - 98, 3.5, 3.5, T.flagAlt);
  } else {
    for (const [x, y, r, rot] of [[cx - 34, by - 34, 5, -0.2], [cx + 32, by - 40, 4.5, 0.3], [cx - 58, by - 46, 4, 0], [cx + 58, by - 14, 4, 0.2]]) {
      paintShell(g, T, x, y, r, rot);
    }
    paintStarfish(g, T, cx + 22, by - 106, 5.5, 0.3);
  }
  g.restore();
  // Flag poles; the flags wave per frame, outside the scaled block, so they follow CASTLE_FLAGS.
  for (const [x, top] of CASTLE_FLAGS) line(g, x, top + 30 * CASTLE.s, x, top, T.woodDark, 2);
}

const CASTLE_FLAGS = [
  [CASTLE.x - 58 * CASTLE.s, CASTLE.y - 128 * CASTLE.s], [CASTLE.x, CASTLE.y - 156 * CASTLE.s],
  [CASTLE.x + 58 * CASTLE.s, CASTLE.y - 128 * CASTLE.s],
];

// A leaded pane on an opening's own box: the glass, a diamond lattice cut to it, and the frame over the top.
// `radius` lets a round opening (Bag End's) take the same lattice as a square one (the inn's). Windows repeat all
// over the map, so one shape here changes the jail, the hill and the inn at once.
function paintLeadedWindow(g, T, x, y, w, h, radius = 2) {
  fillRR(g, x, y, w, h, radius, T.windowDark);
  g.save();
  g.beginPath();
  rr(g, x, y, w, h, radius);
  // The clip rounds the lattice off inside a round opening. Each came is cut to the box in arithmetic as well,
  // because a clip is invisible to the painted checks: a came drawn a window's height past the frame and clipped
  // back is, as far as they can measure, a came painted on the wall.
  g.clip();
  g.globalAlpha = 0.7;
  for (let k = -h; k < w + h; k += 9) {
    const from = Math.max(0, -k);
    const to = Math.min(h, w - k);
    if (to <= from) continue;
    line(g, x + k + from, y + from, x + k + to, y + to, T.stoneDark, 1);
    line(g, x + k + from, y + h - from, x + k + to, y + h - to, T.stoneDark, 1);
  }
  g.globalAlpha = 1;
  g.restore();
  fillRR(g, x, y, w, h, radius, null, T.woodDark, 2);
}

// One iron bar, dark-cored with a light edge so it reads on the yard, on a stone wall and across a body of any
// repo colour.
function paintBar(g, T, x, y0, y1) {
  if (T.pack === 'shire') {
    // Silk on the bar's own line and over its own span, so the cage is the same cage: what holds a session in
    // is a strand rather than an iron bar, and every box that measures the cage measures the same thing. Thin
    // and part see-through, because at the bar's own weight it read as a painted railing.
    g.globalAlpha = 0.5;
    line(g, x, y0, x, y1, T.slate, JAIL.barW * 0.6);
    g.globalAlpha = 0.9;
    line(g, x, y0, x, y1, T.sailCloth, JAIL.barW * 0.3);
    g.globalAlpha = 1;
    return;
  }
  fillRR(g, x - JAIL.barW / 2, y0, JAIL.barW, y1 - y0, JAIL.barW / 2, T.steel, T.stoneDark, 1);
}

function paintRail(g, T, x0, x1, y) {
  if (T.pack === 'shire') {
    g.globalAlpha = 0.5;
    line(g, x0, y, x1, y, T.slate, 3);
    g.globalAlpha = 0.9;
    line(g, x0, y, x1, y, T.sailCloth, 1.6);
    g.globalAlpha = 1;
    return;
  }
  fillRR(g, x0, y - 2.2, x1 - x0, 4.4, 2, T.steel, T.stoneDark, 1);
}

// A web spun into a corner: a few radials from the corner and the spiral hung between them. `dx`/`dy` say which
// way the corner opens, so one routine does all four of them.
function paintWeb(g, T, cx, cy, r, dx, dy) {
  const spokes = 5;
  g.globalAlpha = 0.75;
  for (let i = 0; i <= spokes; i += 1) {
    const a = (i / spokes) * (Math.PI / 2);
    line(g, cx, cy, cx + dx * Math.cos(a) * r, cy + dy * Math.sin(a) * r, T.sailCloth, 1.1);
  }
  for (let ring = 0.34; ring <= 1.001; ring += 0.22) {
    for (let i = 0; i < spokes; i += 1) {
      const a0 = (i / spokes) * (Math.PI / 2);
      const a1 = ((i + 1) / spokes) * (Math.PI / 2);
      line(g, cx + dx * Math.cos(a0) * r * ring, cy + dy * Math.sin(a0) * r * ring,
        cx + dx * Math.cos(a1) * r * ring, cy + dy * Math.sin(a1) * r * ring, T.sailCloth, 1);
    }
  }
  g.globalAlpha = 1;
}

// The jail: the cell block, the yard, and the part of the cage that stands behind the prisoners. The bars below the
// cage's middle rail are drawn per frame instead, over the crowd (drawJailBars).
function paintJail(g, T) {
  const [bx, by, bw, bh] = JAIL.block;
  const [yx, yy, yw, yh] = JAIL.yard;
  const wallY = by + JAIL.roofH;
  // The sign board's posts, painted before the roof so the roof swallows their feet.
  for (const px2 of JAIL.posts) fillRR(g, px2 - 3.5, 94, 7, 30, 2, T.woodDark);
  // The yard: packed earth, a little wider than the block.
  fillRR(g, yx, yy, yw, yh, 5, T.pathEdge);
  g.globalAlpha = 0.5;
  fillRR(g, yx + 6, yy + 6, yw - 12, yh - 12, 4, T.path);
  g.globalAlpha = 1;
  const lair = T.pack === 'shire';
  // The block: stone wall under a slate roof, or in Middle-earth the rock the lair is cut into. The dark stone
  // is the tower's own, which is the one thing in the pack's palette that is nearly black.
  fillEllipse(g, bx + bw / 2 + 6, wallY + bh - JAIL.roofH + 2, bw / 2, 8, T.shadow);
  fillRR(g, bx, wallY, bw, by + bh - wallY, 3, lair ? T.towerStone : T.stone, lair ? T.towerEdge : T.stoneDark, 2);
  if (lair) {
    // Rock takes cracks, not courses: the same wall, split rather than laid.
    g.globalAlpha = 0.6;
    for (const [sx, sy, ex, ey] of [[26, 8, 40, 44], [40, 44, 30, 68], [96, 4, 108, 40], [150, 10, 138, 52],
      [196, 6, 210, 50], [210, 50, 202, 68], [58, 30, 72, 66], [170, 40, 180, 68]]) {
      line(g, bx + sx, wallY + sy, bx + ex, wallY + ey, T.towerEdge, 1.6);
    }
    g.globalAlpha = 1;
  } else {
    // Masonry: courses, with the joints in each one offset from the last, so the wall reads as stone not boards.
    g.globalAlpha = 0.4;
    let course = 0;
    for (let ly = wallY + 11; ly < by + bh - 4; ly += 11) {
      line(g, bx + 3, ly, bx + bw - 3, ly, T.stoneDark, 1);
      for (let jx = bx + 12 + (course % 2) * 14; jx < bx + bw - 8; jx += 28) line(g, jx, ly, jx, ly + 11, T.stoneDark, 1);
      course += 1;
    }
    g.globalAlpha = 1;
  }
  if (lair) {
    // A broken rock brow over the mouth, on the roof's own line: the teeth run down rather than up, so the same
    // band of roof reads as an overhang instead of a battlement.
    fillRR(g, bx - 6, by - 2, bw + 12, wallY - by + 4, 1, T.towerStone, T.towerEdge, 1.5);
    for (let mx = bx - 4; mx < bx + bw + 4; mx += 19) {
      fillPoly(g, [[mx, wallY - 3], [mx + 9.5, wallY + 9], [mx + 19, wallY - 3]], T.towerStone, T.towerEdge, 1.2);
    }
    fillRR(g, bx - 6, by - 4, bw + 12, 6, 1, T.towerEdge);
  } else {
    fillPoly(g, [[bx - 6, wallY + 2], [bx + 28, by], [bx + bw - 28, by], [bx + bw + 6, wallY + 2]], T.slate, T.stoneDark, 2);
    line(g, bx + 28, by + 1.5, bx + bw - 28, by + 1.5, T.stoneDark, 1.5);
  }
  // Barred windows: a dark recess behind three bars, under a stone lintel. In the lair they are holes in the
  // rock with the web grown over them.
  for (const [wx, wy, ww, wh2] of JAIL.windows) {
    fillRR(g, wx - 3, wy - 5, ww + 6, 5, 1, lair ? T.towerEdge : T.stoneDark);
    if (lair) fillRR(g, wx, wy, ww, wh2, 7, T.towerEdge);
    else fillRR(g, wx, wy, ww, wh2, 2, T.windowDark, T.stoneDark, 2);
    for (let i = 1; i <= 3; i++) paintBar(g, T, wx + (ww * i) / 4, wy + 1, wy + wh2 - 1);
    line(g, wx, wy + wh2 / 2, wx + ww, wy + wh2 / 2, lair ? T.sailCloth : T.steel, 1.4);
  }
  const [dx, dy, dw, dh] = JAIL.door;
  if (lair) {
    // The mouth: an opening in the rock on the door's own footing, wider at the floor than at the head, with
    // silk hanging across it. The door is what a session walks through, so the opening keeps its own box.
    fillPoly(g, [
      [dx + 6, dy], [dx + dw - 6, dy], [dx + dw, dy + dh * 0.45], [dx + dw - 2, dy + dh],
      [dx + 2, dy + dh], [dx, dy + dh * 0.45],
    ], T.towerEdge);
    g.globalAlpha = 0.55;
    for (let i = 1; i <= 4; i += 1) {
      const sx = dx + (dw * i) / 5;
      line(g, sx, dy + 2, sx + (i % 2 ? 2.5 : -2.5), dy + dh - 3, T.sailCloth, 1.2);
    }
    for (const hy of [dy + dh * 0.3, dy + dh * 0.62]) line(g, dx + 3, hy, dx + dw - 3, hy + 2, T.sailCloth, 1);
    g.globalAlpha = 1;
  } else {
    // A heavy door with studs and a grille.
    fillRR(g, dx, dy, dw, dh, 2, T.wood, T.woodDark, 2);
    for (let i = 0; i < 3; i++) line(g, dx + 4 + i * ((dw - 8) / 2), dy + 3, dx + 4 + i * ((dw - 8) / 2), dy + dh - 3, T.woodDark, 1.2);
    fillRR(g, dx + dw / 2 - 8, dy + 7, 16, 11, 1, T.windowDark, T.woodDark, 1.5);
    for (let i = 1; i <= 2; i++) paintBar(g, T, dx + dw / 2 - 8 + (16 * i) / 3, dy + 8, dy + 17);
    fillEllipse(g, dx + dw - 8, dy + dh / 2 + 4, 2.4, 2.4, T.steel);
  }
  // The cage: corner posts, the rail along the block's base, and the bars that stand behind the crowd.
  for (const px2 of [yx, yx + yw]) fillRR(g, px2 - 3, JAIL.top - 6, 6, JAIL.foot - JAIL.top + 8, 2, T.steel, T.stoneDark, 1);
  const [topRail] = jailRails();
  paintRail(g, T, topRail[0], topRail[0] + topRail[2], JAIL.top);
  for (const b of jailBarBoxes()) paintBar(g, T, b[0] + b[2] / 2, b[1], b[1] + b[3]);
  // The gateway: a heavier post each side of the gap the bars leave, and a worn patch where feet come through. An
  // open gate leaf was tried here and read as a plank lying in the yard, so the gap itself is the gate.
  const [gateL, gateR] = jailGateway();
  for (const px2 of [gateL, gateR]) fillRR(g, px2 - 3.5, JAIL.top - 8, 7, JAIL.foot - JAIL.top + 12, 2, T.steel, T.stoneDark, 1.2);
  g.globalAlpha = 0.45;
  fillEllipse(g, (gateL + gateR) / 2, JAIL.foot - 6, (gateR - gateL) / 2 - 6, 9, T.pebble);
  g.globalAlpha = 1;
  if (lair) {
    // A web spun into each upper corner of the cage, and egg sacs bunched under the rock. All of it inside the
    // plot the jail already declares, and clear of the gap the gate leaves.
    paintWeb(g, T, yx + 2, JAIL.top - 4, 54, 1, 1);
    paintWeb(g, T, yx + yw - 2, JAIL.top - 4, 54, -1, 1);
    for (const [sx, sy, sr] of [[bx + 26, wallY + 62, 7], [bx + 38, wallY + 58, 5], [bx + bw - 30, wallY + 60, 6]]) {
      fillEllipse(g, sx, sy, sr, sr * 1.2, T.sailCloth, T.slate, 1);
    }
  }
}

function paintGraveyard(g, T) {
  const [x, y, w, h] = GRAVEYARD.fence;
  const gx = GRAVEYARD.gateX;
  fillRR(g, x + 2, y + 4, w - 4, h - 6, 16, T.graveGrass);
  // A worn path from the gate.
  g.globalAlpha = 0.55;
  fillRR(g, gx - 11, y + 70, 22, h - 72, 8, T.pathEdge);
  g.globalAlpha = 1;
  // An old yew in the back corner.
  fillEllipse(g, x + 8, y + 64, 30, 8, T.shadow);
  fillRR(g, x - 2, y + 30, 9, 34, 3, T.trunk);
  fillEllipse(g, x + 2, y + 16, 30, 26, T.yewDark);
  fillEllipse(g, x - 4, y + 2, 20, 20, T.yew);
  // Fence: posts and two rails, open at the gate.
  const posts = [];
  for (let px2 = x; px2 <= x + w + 0.5; px2 += 25) posts.push(px2);
  const rail = (y0) => {
    line(g, x, y0, gx - 26, y0, T.fence, 3);
    line(g, gx + 26, y0, x + w, y0, T.fence, 3);
  };
  // Back and side rails.
  line(g, x, y + 10, x + w, y + 10, T.fence, 3);
  line(g, x, y + 22, x + w, y + 22, T.fence, 3);
  line(g, x, y + 10, x, y + h, T.fence, 3);
  line(g, x + w, y + 10, x + w, y + h, T.fence, 3);
  for (const px2 of posts) fillRR(g, px2 - 3, y + 2, 6, 26, 2, T.fence, T.fenceDark, 1);
  for (let py2 = y + 40; py2 < y + h; py2 += 26) {
    fillRR(g, x - 3, py2 - 10, 6, 22, 2, T.fence, T.fenceDark, 1);
    fillRR(g, x + w - 3, py2 - 10, 6, 22, 2, T.fence, T.fenceDark, 1);
  }
  rail(y + h - 12);
  rail(y + h);
  for (const px2 of posts) {
    if (Math.abs(px2 - gx) < 30) continue;
    fillRR(g, px2 - 3, y + h - 22, 6, 28, 2, T.fence, T.fenceDark, 1);
  }
  // Gate pillars and the open gate leaf.
  for (const side of [-1, 1]) {
    fillRR(g, gx + side * 26 - 6, y + h - 34, 12, 40, 2, T.stone, T.stoneDark, 1.5);
    fillRR(g, gx + side * 26 - 8, y + h - 38, 16, 6, 2, T.stoneDark);
  }
  g.globalAlpha = 0.9;
  fillPoly(g, [[gx + 20, y + h - 26], [gx + 34, y + h - 40], [gx + 34, y + h - 14], [gx + 20, y + h + 2]], null, T.fenceDark, 2);
  g.globalAlpha = 1;
}

// The castle hall, a full-canvas scene of its own.
function paintHall(g, T) {
  const rand = mulberry32(14);
  const west = T.pack === 'west';
  g.fillStyle = T.hallWall;
  g.fillRect(-3000, -3000, W + 6000, 3360);
  const rivendell = T.pack === 'shire';
  if (rivendell) {
    // A blind arcade rather than a bonded wall: four bays of pointed arches on slender columns, placed in the
    // stretches of wall the two windows, the archway and the plaque leave free.
    for (const [x0, x1] of RIVENDELL_BAYS) {
      const mid = (x0 + x1) / 2;
      g.beginPath();
      g.moveTo(x0, 330);
      g.lineTo(x0, 150);
      g.quadraticCurveTo(x0, 74, mid, 46);
      g.quadraticCurveTo(x1, 74, x1, 150);
      g.lineTo(x1, 330);
      g.closePath();
      g.fillStyle = T.hallBrick;
      g.fill();
      g.strokeStyle = T.hallBrickEdge;
      g.lineWidth = 3;
      g.stroke();
      // The column either side, with a capital and a base, which is what turns a recess into an arcade.
      for (const cx of [x0, x1]) {
        fillRR(g, cx - 8, 120, 16, 214, 3, T.hallWall, T.hallBrickEdge, 2);
        fillRR(g, cx - 13, 112, 26, 12, 3, T.hallWall, T.hallBrickEdge, 2);
        fillRR(g, cx - 14, 326, 28, 12, 3, T.hallWall, T.hallBrickEdge, 2);
      }
      // A carved leaf where the arch meets its point.
      fillPoly(g, [[mid, 56], [mid - 11, 74], [mid, 88], [mid + 11, 74]], T.hallWall, T.hallBrickEdge, 1.5);
      line(g, mid, 58, mid, 86, T.hallBrickEdge, 1.2);
    }
  } else {
    for (let row = 0, y = 0; y < 352; row++, y += 34) {
      for (let x = row % 2 ? -36 : 0; x < W; x += 72) {
        g.globalAlpha = 0.5 + rand() * 0.4;
        // Timber shoring on the brick courses' own rows: a mine is boarded, not bonded.
        if (west) fillRR(g, x + 2, y + 4, 68, 26, 2, T.hallBrick, T.hallBrickEdge, 1);
        else fillRR(g, x + 2, y + 2, 68, 30, 8, T.hallBrick, T.hallBrickEdge, 1);
      }
    }
  }
  g.globalAlpha = 1;
  // The pit props between the courses, which is what makes boards read as shoring.
  if (west) for (const x of [66, 442, 800, 1158, 1534]) fillRR(g, x - 11, -10, 22, 366, 2, T.wood, T.woodDark, 1.5);
  // Windows looking out to sea.
  for (const wx of HALL_WINDOWS) {
    // Laid as a closure because it is needed twice: everything drawn into the pane begins a path of its own, so
    // the stroke that frames the window has to be given the pane's outline again or it outlines the last shape
    // drawn inside it. It always did: the green hall's windows have never had their frames.
    const pane = () => {
      if (rivendell) {
        hallLancet(g, wx);
        return;
      }
      g.beginPath();
      g.moveTo(wx - 70, 300);
      g.lineTo(wx - 70, 140);
      g.arc(wx, 140, 70, Math.PI, TAU);
      g.lineTo(wx + 70, 300);
      g.closePath();
    };
    pane();
    g.fillStyle = T.hallSky;
    g.fill();
    g.save();
    g.clip();
    if (rivendell) {
      // The gorge this hall is built over. The gap between the rock had been filled with the sky colour, which
      // read as a white pillar rather than as distance: the depth is carried by the far wall, the near rock in
      // front of it and the fall between them.
      fillPoly(g, [[wx - 80, 250], [wx - 56, 96], [wx - 4, 96], [wx - 24, 250]], T.castleShade);
      fillPoly(g, [[wx + 12, 250], [wx + 46, 96], [wx + 80, 96], [wx + 80, 250]], T.castleShade);
      // Gold trees on the lip of the far wall: behind the near rock, in front of the wall they stand on.
      for (const [tx, ty, tr] of [[wx - 62, 118, 15], [wx + 60, 110, 13], [wx - 40, 100, 10]]) {
        fillRR(g, tx - 2, ty, 4, 26, 2, T.trunk);
        fillEllipse(g, tx, ty, tr, tr * 0.78, T.tree, T.treeDark, 1.2);
      }
      fillPoly(g, [[wx - 80, 250], [wx - 50, 122], [wx - 26, 122], [wx - 42, 250]], T.castleDark);
      fillPoly(g, [[wx + 30, 250], [wx + 52, 122], [wx + 80, 122], [wx + 80, 250]], T.castleDark);
      // The fall keeps its width as it drops, with two grey threads down it for the water's own texture: a
      // ribbon that tapered to a point read as a glass rather than as a fall.
      fillPoly(g, [[wx - 18, 120], [wx + 20, 120], [wx + 15, 248], [wx - 13, 248]], T.sailCloth);
      for (const fx of [wx - 7, wx + 7]) line(g, fx, 124, fx + (fx < wx ? -2 : 2), 246, T.castleShade, 3);
      g.fillStyle = T.hallSea;
      g.fillRect(wx - 80, 246, 160, 60);
      for (const [sx, sy, sr] of [[wx - 20, 248, 18], [wx + 22, 250, 15], [wx + 1, 244, 25]]) {
        fillEllipse(g, sx, sy, sr, sr * 0.38, T.sailCloth);
      }
      g.restore();
      pane();
      g.lineWidth = 8;
      g.strokeStyle = T.castleDark;
      g.stroke();
      // Tracery in the head rather than a mullion: a bar down the full height, as the square windows have, cut
      // the fall in two.
      g.beginPath();
      g.arc(wx, 84, 15, 0, TAU);
      g.strokeStyle = T.castleDark;
      g.lineWidth = 5;
      g.stroke();
      fillRR(g, wx - 84, 298, 168, 14, 4, T.castle, T.castleDark, 2);
      continue;
    }
    g.fillStyle = T.hallSea;
    g.fillRect(wx - 80, 236, 160, 70);
    if (west) {
      // A mesa on the flats where the green hall has a boat: same window, same band of ground.
      fillPoly(g, [[wx - 52, 236], [wx - 40, 198], [wx + 6, 198], [wx + 18, 236]], T.castle, T.castleDark, 1.5);
      fillPoly(g, [[wx + 14, 236], [wx + 24, 214], [wx + 48, 214], [wx + 56, 236]], T.castleShade);
    } else {
      fillPoly(g, [[wx + 10, 226], [wx + 10, 196], [wx + 30, 226]], T.sailCloth);
      fillRR(g, wx - 4, 226, 44, 7, 3, T.wood);
    }
    g.restore();
    pane();
    g.lineWidth = 8;
    g.strokeStyle = T.castleDark;
    g.stroke();
    line(g, wx, 72, wx, 300, T.castleDark, 5);
    fillRR(g, wx - 84, 298, 168, 14, 4, T.castle, T.castleDark, 2);
  }
  // Tapestry for the title and the count, and an open archway to the beach below it.
  const archway = () => {
    g.beginPath();
    g.moveTo(740, 352);
    g.lineTo(740, 250);
    g.arc(800, 250, 60, Math.PI, TAU);
    g.lineTo(860, 352);
    g.closePath();
  };
  archway();
  g.fillStyle = T.hallSky;
  g.fill();
  g.save();
  g.clip();
  if (rivendell) {
    // A terrace over the valley: the far peaks, the woods under them, and the balustrade at the near edge.
    fillPoly(g, [[730, 306], [764, 238], [792, 282], [822, 230], [870, 306]], T.castleShade);
    fillPoly(g, [[730, 306], [758, 262], [788, 306]], T.castleDark);
    for (const tx of [742, 768, 800, 830, 858]) fillEllipse(g, tx, 302, 17, 12, T.tree);
    g.fillStyle = T.hallFloor;
    g.fillRect(730, 306, 140, 50);
    for (let bx = 740; bx <= 856; bx += 16) fillRR(g, bx, 286, 8, 22, 3, T.hallWall, T.hallBrickEdge, 1.2);
    fillRR(g, 732, 280, 136, 8, 3, T.hallWall, T.hallBrickEdge, 1.5);
    fillRR(g, 732, 304, 136, 8, 3, T.hallWall, T.hallBrickEdge, 1.5);
  } else {
    g.fillStyle = T.hallSea;
    g.fillRect(730, 280, 140, 40);
    g.fillStyle = T.sandLight;
    g.fillRect(730, 316, 140, 40);
  }
  g.restore();
  archway();
  g.lineWidth = 8;
  g.strokeStyle = T.castleDark;
  g.stroke();
  fillRR(g, 582, 30, 436, 138, 8, T.tapestry, T.tapestryEdge, 3);
  if (rivendell) {
    // Carved stone takes a moulded lintel and three leaves, where a hanging takes a scalloped fringe.
    fillRR(g, 570, 22, 460, 14, 4, T.hallWall, T.hallBrickEdge, 2);
    fillRR(g, 574, 164, 452, 13, 4, T.hallWall, T.hallBrickEdge, 2);
    for (const lx of [640, 800, 960]) paintCarvedLeaf(g, T, lx, 188, 9, 0);
  } else {
    for (let i = 0; i < 12; i++) fillPoly(g, [[586 + i * 36, 166], [604 + i * 36, 184], [622 + i * 36, 166]], T.tapestry, T.tapestryEdge, 1.5);
    line(g, 570, 30, 1030, 30, T.woodDark, 6);
  }
  // Shells and starfish set into the wall.
  for (const [x, y, r, rot] of [[120, 60, 9, -0.3], [520, 90, 8, 0.2], [1080, 70, 9, -0.1], [1480, 96, 8, 0.4], [180, 250, 7, 0.1], [1420, 240, 7, -0.2]]) {
    if (west) paintCrossedPicks(g, T, x, y, r, rot);
    else if (rivendell) paintCarvedLeaf(g, T, x, y, r, rot);
    else paintShell(g, T, x, y, r, rot);
  }
  for (const [x, y, r, rot] of [[470, 220, 11, 0.2], [1140, 210, 12, -0.2], [60, 170, 9, 0]]) {
    if (rivendell) paintCarvedStar(g, T, x, y, r, rot);
    else paintStarfish(g, T, x, y, r, rot);
  }
  // Torch brackets; the flames flicker per frame.
  for (const [x, y] of HALL_TORCHES) {
    if (rivendell) {
      // A lamp hung on a chain from the arcade, rather than a torch jammed in a bracket.
      line(g, x, y - 60, x, y - 6, T.hallBrickEdge, 1.6);
      fillPoly(g, [[x - 13, y - 6], [x + 13, y - 6], [x + 9, y + 12], [x - 9, y + 12]], T.lanternGlass, T.hallBrickEdge, 1.8);
      fillRR(g, x - 15, y - 10, 30, 6, 2, T.hallWall, T.hallBrickEdge, 1.5);
      continue;
    }
    fillRR(g, x - 9, y + 16, 18, 10, 3, T.torchIron);
    fillPoly(g, [[x - 7, y - 2], [x + 7, y - 2], [x + 3, y + 18], [x - 3, y + 18]], T.woodDark, T.torchIron, 1.5);
  }
  // Floor.
  g.fillStyle = T.hallFloor;
  g.fillRect(-3000, 352, W + 6000, 3000);
  fillRR(g, -20, 344, W + 40, 16, 2, T.castleShade, T.castleDark, 2);
  g.strokeStyle = T.hallFloorLine;
  g.lineWidth = 2;
  g.lineCap = 'round';
  if (rivendell) {
    // Flagstones, jointed in courses that break every other row, where the beach floor has ripples in the sand.
    g.globalAlpha = 0.8;
    for (let row = 0, y = 392; y < 920; row++, y += 58) {
      line(g, -20, y, W + 20, y, T.hallFloorLine, 2);
      for (let x = -20 + (row % 2 ? 46 : 0); x < W + 20; x += 92) line(g, x, y, x, y + 58, T.hallFloorLine, 2);
    }
  } else {
    for (let i = 0; i < 70; i++) {
      const x = rand() * W;
      const y = 380 + rand() * 520;
      g.globalAlpha = 0.5 + rand() * 0.4;
      g.beginPath();
      g.arc(x, y + 30, 36 + rand() * 20, Math.PI * 1.3, Math.PI * 1.7);
      g.stroke();
    }
  }
  g.globalAlpha = 1;
  // Six tables dealt for poker, centred at 386. HALL.floor starts at 410, so the crowd wanders in front of them
  // rather than through them, and none of the six stands in the door arch at 740..860.
  if (west) for (const x of MINE_TABLES) paintPokerTable(g, T, x, 386);
  if (T.pack === 'shire') {
    // A star laid into the floor, and benches on the same six footings the mine puts its tables on.
    g.globalAlpha = 0.85;
    paintCarvedStar(g, T, 800, 660, 120, 0, 5);
    paintCarvedStar(g, T, 800, 660, 52, Math.PI / 6, 4);
    g.globalAlpha = 1;
    for (const x of MINE_TABLES) {
      fillEllipse(g, x + 3, 400, 62, 8, T.shadow);
      fillRR(g, x - 62, 372, 124, 16, 5, T.hallWall, T.hallBrickEdge, 2);
      for (const lx of [x - 48, x + 36]) fillRR(g, lx, 386, 12, 18, 3, T.hallBrick, T.hallBrickEdge, 1.5);
      fillRR(g, x - 62, 350, 124, 8, 3, T.hallBrick, T.hallBrickEdge, 1.5);
    }
  }
}

// Six card tables along the mine's back wall, clear of the arch in the middle of it.
const MINE_TABLES = Object.freeze([190, 400, 610, 990, 1200, 1410]);

// Crossed picks, hung where the green hall sets a shell into the wall and inside the same radius.
function paintCrossedPicks(g, T, x, y, r, rot) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  for (const turn of [0.7, -0.7]) {
    g.save();
    g.rotate(turn);
    line(g, 0, -r * 1.1, 0, r * 1.1, T.woodDark, Math.max(1.8, r * 0.26));
    g.beginPath();
    g.arc(0, -r * 1.05, r * 0.72, Math.PI * 1.15, Math.PI * 1.85);
    g.strokeStyle = T.steel;
    g.lineWidth = Math.max(1.6, r * 0.3);
    g.stroke();
    g.restore();
  }
  g.restore();
}

// A table laid for poker: baize, a hand dealt round it, the pot in the middle and a lamp at the rim.
function paintPokerTable(g, T, x, y) {
  const rx = 78;
  const ry = 26;
  fillEllipse(g, x + 4, y + ry + 8, rx * 0.9, 8, T.shadow);
  for (const side of [-0.6, 0.6]) fillRR(g, x + side * rx - 3, y + 4, 6, ry + 16, 2, T.woodDark);
  fillEllipse(g, x, y + 5, rx, ry, T.woodDark);
  fillEllipse(g, x, y, rx, ry, T.baize, T.baizeEdge, 2);
  // Four hands dealt face down, and the pot between them.
  for (const dx of [-52, -18, 16, 50]) {
    fillRR(g, x + dx - 7, y - 5, 9, 13, 2, T.signBoard, T.woodDark, 1);
    fillRR(g, x + dx - 2, y - 7, 9, 13, 2, T.signBoard, T.woodDark, 1);
  }
  for (let i = 0; i < 3; i++) fillEllipse(g, x - 4 + i * 5, y + 9 - i * 2, 6, 2.6, T.coin, T.coinEdge, 1);
  fillRR(g, x + rx - 18, y - 16, 10, 16, 2, T.lanternGlass, T.woodDark, 1.5);
}

// The stretches of the hall's back wall that the two lancets (230..370, 1230..1370), the archway (740..860) and
// the plaque (582..1018) leave free, which is where an arcade can stand without covering any of them.
const RIVENDELL_BAYS = Object.freeze([
  Object.freeze([40, 200]), Object.freeze([400, 560]), Object.freeze([1040, 1200]), Object.freeze([1400, 1560]),
]);

// A carved leaf, where the green hall sets a shell into the wall and inside the same radius.
function paintCarvedLeaf(g, T, x, y, r, rot) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.beginPath();
  g.moveTo(0, -r * 1.15);
  g.quadraticCurveTo(r * 0.85, -r * 0.2, 0, r * 1.15);
  g.quadraticCurveTo(-r * 0.85, -r * 0.2, 0, -r * 1.15);
  g.closePath();
  g.fillStyle = T.hallWall;
  g.fill();
  g.strokeStyle = T.hallBrickEdge;
  g.lineWidth = 1.4;
  g.stroke();
  line(g, 0, -r * 1.05, 0, r * 1.05, T.hallBrickEdge, 1);
  for (const k of [-0.5, 0, 0.5]) {
    line(g, 0, r * k, r * 0.5, r * (k - 0.32), T.hallBrickEdge, 0.9);
    line(g, 0, r * k, -r * 0.5, r * (k - 0.32), T.hallBrickEdge, 0.9);
  }
  g.restore();
}

// A carved star, on the starfish's own footing and radius.
function paintCarvedStar(g, T, x, y, r, rot, lineWidth = 1.4) {
  const pts = [];
  for (let i = 0; i < 12; i += 1) {
    const a = rot - Math.PI / 2 + (i * Math.PI) / 6;
    const d = i % 2 ? r * 0.42 : r;
    pts.push([x + Math.cos(a) * d, y + Math.sin(a) * d]);
  }
  fillPoly(g, pts, T.hallWall, T.hallBrickEdge, lineWidth);
}

const HALL_TORCHES = [[120, 190], [520, 190], [1080, 190], [1480, 190]];

// The two windows in the hall's back wall, and the box a lancet takes in it. One list, because what is drawn
// through a window has to agree with where the window is.
export const HALL_WINDOWS = Object.freeze([300, 1300]);
export const HALL_LANCET_BOX = Object.freeze([-70, 46, 140, 254]);

// The same fireworks seen from inside the White Halls, through the two lancets over the gorge. Each sits inside
// the pane it is seen through, so it is true with the clip and without it.
export const HALL_FIREWORKS = Object.freeze([
  Object.freeze({ x: HALL_WINDOWS[0], y: 158, r: 48, phase: 0, rays: 13 }),
  Object.freeze({ x: HALL_WINDOWS[1], y: 150, r: 42, phase: 3.4, rays: 11 }),
]);

// A lancet: two curves meeting at a point, which is the one line that says this hall is not that hall. Laid as a
// path and nothing else, so the wall can fill and stroke it and a firework can be clipped to it.
function hallLancet(g, wx) {
  g.beginPath();
  g.moveTo(wx - 70, 300);
  g.lineTo(wx - 70, 156);
  g.quadraticCurveTo(wx - 70, 74, wx, 46);
  g.quadraticCurveTo(wx + 70, 74, wx + 70, 156);
  g.lineTo(wx + 70, 300);
  g.closePath();
}

// The mirror ball hangs on its chain in front of the wall, between the title plaque (618..982, 42..154), which is
// drawn after it and hides the top of the chain, and the door arch below. No guest's badge reaches that high.
const DISCO_BALL = Object.freeze({ x: 800, y: 244, r: 36 });
const DISCO_COLOURS = Object.freeze(['255, 60, 200', '40, 215, 255', '255, 226, 60', '80, 225, 110', '255, 140, 30',
  '170, 110, 255']);
// One beam per colour, each on its own period and phase so the spots cross paths rather than move in lockstep. Every
// third one sweeps the back wall, the rest the floor.
const DISCO_BEAMS = Object.freeze(DISCO_COLOURS.map((rgb, i) => Object.freeze({
  rgb, period: 5.4 + i * 0.9, phase: i * 1.3, wall: i % 3 === 2,
})));
// The ball's reflections: small dots drifting across the walls and the floor as it turns.
const DISCO_DOTS = Object.freeze((() => {
  const rand = mulberry32(77);
  return Array.from({ length: 44 }, () => Object.freeze({
    u: rand(), y: 170 + rand() * 680, r: 2.5 + rand() * 2.5, rgb: DISCO_COLOURS[Math.floor(rand() * DISCO_COLOURS.length)],
  }));
})());

// The cottage room, the other interior: plaster walls over a wainscot, floorboards, two windows onto the night,
// a hearth whose fire flickers per frame, and a rug the guests wander across.
const HEARTH = Object.freeze({ x: 260, y: 392, w: 150 });
const ROOM_WINDOWS = Object.freeze([[620, 166, 180, 120], [980, 166, 180, 120]]);

// Board-game tables: a 4x2 grid over ROOM.floor, each with its own game so the room reads as varied rather than
// repeated. 8 tables of 4 is 32 seats, well above idle + recent's ~25.
export const COTTAGE_GAMES = Object.freeze(['chess', 'ludo', 'snakes', 'cards']);
const COTTAGE_TABLE_COLS = 4;
const COTTAGE_TABLE_ROWS = 2;
export const COTTAGE_TABLE_RX = 64;
export const COTTAGE_TABLE_RY = 38;
export const COTTAGE_TABLES = Object.freeze((() => {
  const [fx, fy, fw, fh] = ROOM.floor;
  const cw = fw / COTTAGE_TABLE_COLS;
  const ch = fh / COTTAGE_TABLE_ROWS;
  const out = [];
  let i = 0;
  for (let r = 0; r < COTTAGE_TABLE_ROWS; r++) {
    for (let c = 0; c < COTTAGE_TABLE_COLS; c++) {
      out.push(Object.freeze({
        x: rnd2(fx + (c + 0.5) * cw), y: rnd2(fy + (r + 0.5) * ch), game: COTTAGE_GAMES[i % COTTAGE_GAMES.length],
      }));
      i += 1;
    }
  }
  return out;
})());

// Feet positions from a table's centre: west and east, facing each other across the board, then the pair standing
// at its far rim. Nobody stands south of a table, where they would cover the game. Seat-major order, so the first
// eight guests take one table each and the next eight make them pairs.
const COTTAGE_SEAT_OFFSETS = [[-98, 14], [98, 14], [-34, -44], [34, -44]];
export const COTTAGE_SEATS = Object.freeze(
  COTTAGE_SEAT_OFFSETS.flatMap(([dx, dy]) => COTTAGE_TABLES.map((t) => Object.freeze({
    x: rnd2(t.x + dx), y: rnd2(t.y + dy),
  }))),
);
export const COTTAGE_SEAT_CAPACITY = COTTAGE_SEATS.length;

// Guests seated round the cottage's tables, one seat each in COTTAGE_SEATS order, up to COTTAGE_SEAT_CAPACITY.
// Past that the room falls back to the free spread-and-wander crowd (castleLayout) it always used: today's
// overflow behaviour, unchanged.
export function cottageSeatLayout(n, sizes = null) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (!count) return { scale: 1, points: [] };
  if (count > COTTAGE_SEAT_CAPACITY) return castleLayout(count, sizes, ROOM);
  return { scale: 1, points: COTTAGE_SEATS.slice(0, count).map((s) => ({ x: s.x, y: s.y })) };
}

// The piece that hops on each table's ambient tick, and the colours it cycles through per table.
const PIECE_HOP_PERIOD = 3.4;
const PIECE_COLOURS = Object.freeze(['#d64545', '#3b6fd6', '#e0b23a', '#3f9d55']);

function paintCottageRoom(g, T) {
  const rand = mulberry32(31);
  const west = T.pack === 'west';
  const floorY = 392;
  g.fillStyle = T.roomWall;
  g.fillRect(-3000, -3000, W + 6000, 3000 + floorY);
  // Wainscot along the bottom of the wall, with a picture rail above it.
  g.fillStyle = T.roomWallShade;
  g.fillRect(-3000, floorY - 96, W + 6000, 96);
  g.globalAlpha = 0.5;
  for (let x = -20; x < W + 20; x += 46) line(g, x, floorY - 96, x, floorY, T.woodDark, 1.2);
  g.globalAlpha = 1;
  fillRR(g, -20, floorY - 104, W + 40, 10, 2, T.wood, T.woodDark, 1.5);
  fillRR(g, -20, 150, W + 40, 8, 2, T.wood, T.woodDark, 1.2);
  // Ceiling beams.
  for (const x of [180, 560, 940, 1320]) fillRR(g, x, -40, 44, 120, 3, T.woodDark);

  for (const [x, y, w, h] of ROOM_WINDOWS) {
    if (T.pack === 'shire') {
      // A round window, as every opening in a hobbit hole is, looking onto the country outside.
      const cx2 = x + w / 2;
      const cy2 = y + h / 2;
      const rr2 = Math.min(w, h) / 2;
      fillEllipse(g, cx2, cy2, rr2 + 10, rr2 + 10, T.wood, T.woodDark, 2);
      fillEllipse(g, cx2, cy2, rr2, rr2, T.hallSky);
      g.save();
      g.beginPath();
      g.arc(cx2, cy2, rr2, 0, TAU);
      g.clip();
      fillEllipse(g, cx2, cy2 + rr2 * 0.55, rr2 * 1.3, rr2 * 0.8, T.grass);
      fillEllipse(g, cx2 - rr2 * 0.5, cy2 + rr2 * 0.3, rr2 * 0.5, rr2 * 0.3, T.grassDark);
      for (let hx = cx2 - rr2; hx < cx2 + rr2; hx += 13) fillEllipse(g, hx, cy2 + rr2 * 0.18, 7, 4, T.yew);
      fillEllipse(g, cx2 + rr2 * 0.42, cy2 - rr2 * 0.42, 11, 11, T.lanternGlass);
      g.globalAlpha = 0.6;
      for (let k = -rr2 * 2; k < rr2 * 2; k += 16) {
        line(g, cx2 + k, cy2 - rr2, cx2 + k + rr2 * 2, cy2 + rr2, T.woodDark, 1.2);
        line(g, cx2 + k, cy2 + rr2, cx2 + k + rr2 * 2, cy2 - rr2, T.woodDark, 1.2);
      }
      g.globalAlpha = 1;
      g.restore();
      fillEllipse(g, cx2, cy2, rr2, rr2, null, T.woodDark, 3);
      fillRR(g, x - 16, y + h + 10, w + 32, 10, 2, T.woodLight, T.woodDark, 1.5);
      continue;
    }
    fillRR(g, x - 10, y - 10, w + 20, h + 20, 4, T.wood, T.woodDark, 2);
    fillRR(g, x, y, w, h, 2, T.hallSky);
    fillEllipse(g, x + w * 0.7, y + h * 0.28, 16, 16, T.lanternGlass);
    if (west) {
      // Desert through the window: the flats, a mesa on them and a saguaro against it.
      g.save();
      g.beginPath();
      g.rect(x, y, w, h);
      g.clip();
      g.fillStyle = T.hallSea;
      g.fillRect(x, y + h * 0.62, w, h * 0.38);
      fillPoly(g, [[x + 22, y + h * 0.62], [x + 36, y + h * 0.3], [x + 82, y + h * 0.3], [x + 96, y + h * 0.62]], T.castle, T.castleDark, 1.5);
      fillRR(g, x + w * 0.74, y + h * 0.4, 7, h * 0.24, 3.5, T.tree);
      fillRR(g, x + w * 0.66, y + h * 0.48, 6, h * 0.12, 3, T.treeDark);
      g.restore();
    } else {
      for (let i = 0; i < 9; i++) fillEllipse(g, x + 14 + rand() * (w - 28), y + 12 + rand() * (h * 0.6), 1.4, 1.4, T.foam);
    }
    line(g, x + w / 2, y, x + w / 2, y + h, T.wood, 5);
    line(g, x, y + h / 2, x + w, y + h / 2, T.wood, 5);
    fillRR(g, x - 16, y + h + 10, w + 32, 10, 2, T.woodLight, T.woodDark, 1.5);
  }

  // Hearth: a stone surround, a mantel with two candles and a pot hanging over the fire.
  const { x: hx, y: hy, w: hw } = HEARTH;
  fillRR(g, hx - hw / 2 - 16, hy - 250, hw + 32, 250, 4, T.stone, T.stoneDark, 2);
  g.globalAlpha = 0.45;
  for (let y = hy - 236; y < hy - 20; y += 26) line(g, hx - hw / 2 - 10, y, hx + hw / 2 + 10, y, T.stoneDark, 1.5);
  g.globalAlpha = 1;
  g.beginPath();
  g.moveTo(hx - hw / 2, hy);
  g.lineTo(hx - hw / 2, hy - 92);
  g.arc(hx, hy - 92, hw / 2, Math.PI, TAU);
  g.lineTo(hx + hw / 2, hy);
  g.closePath();
  g.fillStyle = T.windowDark;
  g.fill();
  g.strokeStyle = T.stoneDark;
  g.lineWidth = 2;
  g.stroke();
  if (west) {
    // The vault, standing open in the hearth's own opening: bars of bullion stacked inside it, and the door swung
    // back against the wall on the near side with its wheel on it.
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 3 - row; i++) {
        fillRR(g, hx - 42 + i * 30 + row * 15, hy - 34 - row * 14, 26, 12, 2, T.coin, T.coinEdge, 1);
      }
    }
    fillRR(g, hx + hw / 2 - 6, hy - 150, 22, 150, 3, T.steel, T.stoneDark, 2);
    g.beginPath();
    g.arc(hx + hw / 2 + 5, hy - 74, 12, 0, TAU);
    g.strokeStyle = T.stoneDark;
    g.lineWidth = 3;
    g.stroke();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 4;
      line(g, hx + hw / 2 + 5 - Math.cos(a) * 15, hy - 74 - Math.sin(a) * 15,
        hx + hw / 2 + 5 + Math.cos(a) * 15, hy - 74 + Math.sin(a) * 15, T.stoneDark, 2.5);
    }
  }
  fillRR(g, hx - hw / 2 - 28, hy - 176, hw + 56, 16, 3, T.wood, T.woodDark, 2);
  for (const dx of [-46, 46]) {
    fillRR(g, hx + dx - 6, hy - 206, 12, 30, 2, T.shell, T.stoneDark, 1);
    fillEllipse(g, hx + dx, hy - 208, 3, 4, T.flame);
  }
  if (!west) {
    // A fire in the grate: a bed of embers, logs across it, flames between them and a pot on a crane over the
    // lot, with the light washing up the back of the opening. It is painted into the room's own layer, so it is
    // still, like the mantel's candles: nothing in here is on a frame.
    // The back of the opening is sooted first: against the window grey the flames had nothing to burn against.
    g.globalAlpha = 0.8;
    g.beginPath();
    g.moveTo(hx - hw / 2, hy);
    g.lineTo(hx - hw / 2, hy - 92);
    g.arc(hx, hy - 92, hw / 2, Math.PI, TAU);
    g.lineTo(hx + hw / 2, hy);
    g.closePath();
    g.fillStyle = T.torchIron;
    g.fill();
    g.globalAlpha = 0.14;
    fillEllipse(g, hx, hy - 26, hw / 2 - 8, 58, T.flame);
    g.globalAlpha = 0.3;
    fillEllipse(g, hx, hy - 12, 56, 28, T.flame);
    g.globalAlpha = 1;
    // Tongues, tallest in the middle, drawn before the logs so they come up between them.
    for (const [dx, h2, w2] of [[-26, 28, 8], [-9, 52, 11], [10, 42, 10], [27, 24, 7]]) {
      g.beginPath();
      g.moveTo(hx + dx - w2, hy - 8);
      g.quadraticCurveTo(hx + dx - w2 * 0.9, hy - 8 - h2 * 0.62, hx + dx + w2 * 0.3, hy - 8 - h2);
      g.quadraticCurveTo(hx + dx + w2 * 0.7, hy - 8 - h2 * 0.5, hx + dx + w2, hy - 8);
      g.closePath();
      g.fillStyle = T.flame;
      g.fill();
      g.globalAlpha = 0.85;
      fillEllipse(g, hx + dx, hy - 14, w2 * 0.3, h2 * 0.22, T.flameCore);
      g.globalAlpha = 1;
    }
    // Logs across the embers, each with its lit end, and the coals glowing under them.
    for (const [dx, dy] of [[-30, -6], [0, -2], [26, -8]]) {
      fillRR(g, hx + dx - 14, hy + dy - 8, 28, 10, 4, T.woodDark, T.torchIron, 1.2);
      fillEllipse(g, hx + dx + 13, hy + dy - 3, 3.5, 4.5, T.flame);
    }
    for (const [dx, dy, r] of [[-38, 0, 5], [-16, 2, 4], [4, 1, 5.5], [24, 2, 4], [40, 0, 4.5]]) {
      fillEllipse(g, hx + dx, hy + dy - 3, r, r * 0.6, T.flame);
      fillEllipse(g, hx + dx, hy + dy - 3, r * 0.45, r * 0.3, T.flameCore);
    }
    // The crane: a bar across the opening, a hook down from it and the pot hanging in the flames.
    fillRR(g, hx - 58, hy - 106, 116, 5, 2, T.torchIron);
    line(g, hx, hy - 104, hx, hy - 62, T.torchIron, 2);
    fillRR(g, hx - 24, hy - 62, 48, 30, 6, T.torchIron);
    fillRR(g, hx - 28, hy - 64, 56, 6, 3, T.torchIron);
  }
  if (west) {
    // The teller's counter and its grille, in the one stretch of wall between the two windows.
    const cx = 880;
    fillRR(g, cx - 78, floorY - 104, 156, 104, 2, T.wood, T.woodDark, 2);
    fillRR(g, cx - 86, floorY - 118, 172, 16, 3, T.woodLight, T.woodDark, 2);
    fillRR(g, cx - 60, floorY - 214, 120, 96, 2, T.windowDark, T.woodDark, 2);
    for (let x = cx - 52; x <= cx + 52; x += 13) line(g, x, floorY - 208, x, floorY - 124, T.steel, 2);
    line(g, cx - 58, floorY - 166, cx + 58, floorY - 166, T.steel, 2);
    // The day's takings against the wainscot, with a hand truck beside them.
    const sx = 1330;
    for (const [dx, dy, r] of [[0, 0, 22], [42, 4, 20], [20, -30, 18]]) {
      fillEllipse(g, sx + dx, floorY + dy - r * 0.5, r, r * 0.72, T.signBoard, T.woodDark, 1.5);
      line(g, sx + dx - 5, floorY + dy - r, sx + dx + 5, floorY + dy - r, T.woodDark, 2);
    }
    fillRR(g, sx + 74, floorY - 108, 6, 104, 2, T.steel);
    fillRR(g, sx + 96, floorY - 108, 6, 104, 2, T.steel);
    fillRR(g, sx + 72, floorY - 16, 32, 8, 2, T.steel);
    fillEllipse(g, sx + 78, floorY - 2, 8, 8, T.woodDark);
  }

  if (T.pack === 'shire') {
    // A dresser of plates on the wainscot, which is what a parlour has where a hall has a tapestry.
    const dx = 440;
    fillRR(g, dx - 62, floorY - 210, 124, 108, 3, T.wood, T.woodDark, 2);
    fillRR(g, dx - 68, floorY - 216, 136, 10, 2, T.woodDark);
    for (const sy of [floorY - 176, floorY - 140]) {
      fillRR(g, dx - 58, sy, 116, 5, 1, T.woodDark);
      for (let px = dx - 46; px < dx + 46; px += 30) {
        fillEllipse(g, px, sy - 12, 12, 12, T.signBoard, T.woodDark, 1.4);
        fillEllipse(g, px, sy - 12, 6, 6, T.flowers[0]);
      }
    }
    fillRR(g, dx - 58, floorY - 128, 116, 26, 2, T.roomWallShade, T.woodDark, 1.5);
    for (const hx of [dx - 30, dx + 30]) fillEllipse(g, hx, floorY - 115, 3, 3, T.thatch);
  }

  // Floor: boards, then a rug in the middle of the room.
  g.fillStyle = T.roomFloor;
  g.fillRect(-3000, floorY, W + 6000, 3000);
  g.strokeStyle = T.roomFloorLine;
  g.lineWidth = 2;
  for (let y = floorY + 34; y < H + 40; y += 34) line(g, -20, y, W + 20, y, T.roomFloorLine, 2);
  for (let i = 0; i < 26; i++) {
    const y = floorY + 20 + Math.floor(rand() * 14) * 34;
    const x = rand() * W;
    line(g, x, y, x, y + 34, T.roomFloorLine, 2);
  }
  if (!west) {
    const [rx, ry, rw, rh] = [300, 560, 1000, 280];
    g.globalAlpha = 0.9;
    fillRR(g, rx, ry, rw, rh, 26, T.rug, T.woodDark, 2);
    g.globalAlpha = 0.35;
    fillRR(g, rx + 26, ry + 24, rw - 52, rh - 48, 18, null, T.signBoard, 3);
    g.globalAlpha = 1;
  }
  for (const t of COTTAGE_TABLES) paintGameTable(g, T, t);
}

// A clerk's desk on the game table's own footing and radius: the seats a session sits on are tied to the table,
// so the table cannot move. A baize cloth, an open ledger, coin in stacks and a sack at the rim.
function paintClerkDesk(g, T, x, y, rx, ry) {
  fillEllipse(g, x + 4, y + ry + 14, rx * 0.92, 11, T.shadow);
  for (const side of [-0.55, 0.55]) fillRR(g, x + side * rx - 4, y + 6, 8, ry + 12, 2, T.woodDark);
  fillEllipse(g, x, y + 6, rx, ry, T.woodDark);
  fillEllipse(g, x, y, rx, ry, T.wood, T.woodDark, 2);
  fillEllipse(g, x, y, rx * 0.82, ry * 0.76, T.baize, T.baizeEdge, 1.5);
  // The ledger, open at the middle, with its two pages ruled.
  fillRR(g, x - 30, y - 13, 28, 24, 2, T.signBoard, T.woodDark, 1.5);
  fillRR(g, x - 2, y - 13, 28, 24, 2, T.signBoard, T.woodDark, 1.5);
  line(g, x - 2, y - 13, x - 2, y + 11, T.woodDark, 1.5);
  for (let i = 1; i < 4; i++) {
    line(g, x - 26, y - 13 + i * 6, x - 6, y - 13 + i * 6, T.signMuted, 1);
    line(g, x + 2, y - 13 + i * 6, x + 22, y - 13 + i * 6, T.signMuted, 1);
  }
  for (let i = 0; i < 3; i++) {
    const h = 4 + i * 3;
    fillRR(g, x + 32 + i * 11, y + 4 - h, 9, h, 1.5, T.coin, T.coinEdge, 1);
  }
  fillEllipse(g, x - rx * 0.78, y + ry * 0.3, 13, 10, T.signBoard, T.woodDark, 1.5);
  line(g, x - rx * 0.78 - 4, y + ry * 0.3 - 9, x - rx * 0.78 + 4, y + ry * 0.3 - 9, T.woodDark, 2);
}

// One table per COTTAGE_TABLES entry, its game drawn large enough to read across the room. Static, like the rug and
// the hearth: the guests are drawn per frame over it, and so is the one piece that hops (drawGamePieces).
function paintGameTable(g, T, t) {
  const { x, y, game } = t;
  const rx = COTTAGE_TABLE_RX;
  const ry = COTTAGE_TABLE_RY;
  if (T.pack === 'west') {
    paintClerkDesk(g, T, x, y, rx, ry);
    return;
  }
  fillEllipse(g, x + 4, y + ry + 14, rx * 0.92, 11, T.shadow);
  for (const side of [-0.55, 0.55]) fillRR(g, x + side * rx - 4, y + 6, 8, ry + 12, 2, T.woodDark);
  fillEllipse(g, x, y + 6, rx, ry, T.woodDark);
  fillEllipse(g, x, y, rx, ry, T.wood, T.woodDark, 2);
  const [bw, bh] = [76, 42];
  const [bx, by] = [x - bw / 2, y - bh / 2];
  const [red, blue, yellow, green] = PIECE_COLOURS;
  g.save();
  if (game === 'chess') {
    fillRR(g, bx - 3, by - 3, bw + 6, bh + 6, 3, T.woodDark);
    const [sw, sh] = [bw / 8, bh / 4];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 8; c++) {
        g.fillStyle = (r + c) % 2 ? T.slate : T.sandLight;
        g.fillRect(bx + c * sw, by + r * sh, sw, sh);
      }
    }
    for (const [c, r, light] of [[1, 0, false], [4, 1, false], [2, 3, true], [6, 2, true], [5, 3, true]]) {
      fillEllipse(g, bx + (c + 0.5) * sw, by + (r + 0.5) * sh, 3.6, 3.6, light ? T.foam : T.torchIron, T.woodDark, 1);
    }
  } else if (game === 'ludo') {
    fillRR(g, bx, by, bw, bh, 3, T.shell, T.woodDark, 1.5);
    const [qw, qh] = [bw * 0.36, bh * 0.4];
    for (const [cx, cy, col] of [[bx, by, red], [bx + bw - qw, by, green], [bx, by + bh - qh, blue],
      [bx + bw - qw, by + bh - qh, yellow]]) {
      fillRR(g, cx + 2, cy + 2, qw - 4, qh - 4, 2, col);
      fillEllipse(g, cx + qw / 2, cy + qh / 2, 4.5, 4, T.shell);
    }
    line(g, bx + qw, y, bx + bw - qw, y, T.woodDark, 1);
    line(g, x, by + qh, x, by + bh - qh, T.woodDark, 1);
    fillEllipse(g, x, y, 6, 5, yellow, T.woodDark, 1);
  } else if (game === 'snakes') {
    fillRR(g, bx, by, bw, bh, 3, T.shell, T.woodDark, 1.5);
    const [sw, sh] = [bw / 8, bh / 4];
    g.globalAlpha = 0.3;
    g.fillStyle = green;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 8; c++) if ((r + c) % 2) g.fillRect(bx + c * sw, by + r * sh, sw, sh);
    g.globalAlpha = 1;
    for (const off of [0, 8]) line(g, bx + 12 + off, by + bh - 5, bx + 24 + off, by + 5, T.woodDark, 2);
    for (let k = 1; k < 5; k++) {
      const f = k / 5;
      line(g, bx + 12 + 12 * f, by + bh - 5 - (bh - 10) * f, bx + 20 + 12 * f, by + bh - 5 - (bh - 10) * f, T.woodDark, 1.5);
    }
    g.beginPath();
    g.moveTo(bx + 46, by + 7);
    g.bezierCurveTo(bx + 74, by + 12, bx + 38, by + 30, bx + 66, by + bh - 6);
    g.strokeStyle = green;
    g.lineWidth = 4.5;
    g.lineCap = 'round';
    g.stroke();
    fillEllipse(g, bx + 46, by + 7, 4.5, 4, green, T.woodDark, 1);
  } else {
    fillRR(g, bx, by, bw, bh, 6, T.tree, T.woodDark, 1.5);
    for (const [dx, rot] of [[-18, -0.32], [-6, -0.11], [6, 0.11], [18, 0.32]]) {
      g.save();
      g.translate(x + dx, y + 9);
      g.rotate(rot);
      fillRR(g, -8, -24, 16, 24, 2, T.shell, T.woodDark, 1);
      fillEllipse(g, 0, -13, 3, 3, dx < 0 ? red : T.torchIron);
      g.restore();
    }
  }
  g.restore();
}

// What an interior scene is: the interior its guests are laid out on, what paints it, the floor colour a frame
// falls back to before that layer is ready, its plaque, and the lanes its count pills show. The scene's name is
// its place's name, so a row's place says which room it is in.
const SCENE_ART = Object.freeze({
  castle: Object.freeze({
    spec: HALL, paint: paintHall, floor: 'hallFloor', title: 'Valhalla sand castle',
    note: 'Merged or done over 14 days ago', lanes: Object.freeze(['castle']),
  }),
  cottages: Object.freeze({
    // The note has to cover both lanes in the room: a recent row is one that is not live and was active in the past
    // week, which is not "quiet for 2 hours or more".
    spec: ROOM, paint: paintCottageRoom, floor: 'roomFloor', title: 'The Cottages',
    note: 'Quiet for 2 hours, or active this week', lanes: Object.freeze(['idle', 'recent']),
  }),
});

// ---------------------------------------------------------------------------------------------
// The village
// ---------------------------------------------------------------------------------------------

function makePool(n) {
  return {
    n,
    next: 0,
    x: new Float32Array(n),
    y: new Float32Array(n),
    vx: new Float32Array(n),
    vy: new Float32Array(n),
    age: new Float32Array(n),
    life: new Float32Array(n),
    size: new Float32Array(n),
  };
}

function emit(pool, x, y, vx, vy, life, size) {
  const i = pool.next;
  pool.next = (i + 1) % pool.n;
  pool.x[i] = x;
  pool.y[i] = y;
  pool.vx[i] = vx;
  pool.vy[i] = vy;
  pool.age[i] = 0;
  pool.life[i] = life;
  pool.size[i] = size;
}

function stepPool(pool, dt, gravity) {
  let alive = false;
  for (let i = 0; i < pool.n; i++) {
    if (pool.life[i] <= 0) continue;
    pool.age[i] += dt;
    if (pool.age[i] >= pool.life[i]) {
      pool.life[i] = 0;
      continue;
    }
    alive = true;
    pool.vy[i] += gravity * dt;
    pool.x[i] += pool.vx[i] * dt;
    pool.y[i] += pool.vy[i] * dt;
  }
  return alive;
}

function clearPool(pool) {
  pool.life.fill(0);
}

const lookPhase = (look) => (Math.floor(Math.abs(Number(look) || 0)) % 997) / 997;

// `onIsland` is taken locally as `islandChanged`: the module already exports an `onIsland(x, y)` for the Valhalla
// islet's shape, and a parameter of that name would shadow it inside every function drawn here.
export function createVillage(canvas, { onSelect, onOpen, onHover, onScene, onIsland: islandChanged, mode: initialMode, island: initialIsland, theme: initialTheme } = {}) {
  const win = typeof window !== 'undefined' ? window : globalThis;
  const doc = typeof document !== 'undefined' ? document : null;
  const ctx = canvas.getContext('2d');
  const chars = new Map(); // characters standing, walking or sailing in the village
  // Visitors queueing at the immigration desk: id -> { id, visitor, px, py, tx, ty, journey, alpha, leaving }.
  // A PR, not a session, so they are kept apart from `chars` and never reach a slot, a lane or a plate.
  const visitors = new Map();
  let stones = new Map(); // headstones: id -> { id, session, index, x, y, riseAt }
  // One guest map per interior scene: the sand castle hall and the cottage room. Only the open one is drawn.
  const guests = { castle: new Map(), cottages: new Map() };
  const crowdScale = { castle: 1, cottages: 1 };
  let ferries = []; // empty boats sailing between the pier and the island: { owner, kind, route, t0, dur }
  let lanes = new Map(); // id -> lane at the last update
  let verified = new Map(); // id -> whether GitHub had confirmed its PR state at the last update
  let queueHold = null; // { until, slots: Map id -> harbour index }: queue slots kept while a stamp walker waits there
  const sparks = makePool(96);
  const smoke = makePool(48);
  const fitCache = new Map();
  const cleanups = [];

  let counts = {};
  let laneCounts = new Map();
  // The whole board's counts, whatever island is open: the edge ring and anything else that must not go quiet just
  // because you stepped onto one island reads these instead.
  let boardCounts = {};
  let boardLaneCounts = new Map();
  let boardSessions = [];
  let boardVisitors = []; // the whole board's visitors, cleaned: what the map's total counts
  let boardReviewsSent = null; // `board.reviews.waiting`, which wins over the list's own length
  let visitorTotal = 0; // at the desk on screen, drawn or not
  let visitorHidden = 0; // waiting past VISITOR_CAPACITY, so counted by the pill and not drawn
  let lastTurnAt = -Infinity; // when the latest arrival steps off the pier tip, in seconds
  let repoIndex = new Map();
  let mode = MODES.includes(initialMode) ? initialMode : 'village';
  let island = null; // the open island's repo key ('' is the no-repo island), or null for the world map
  let lastIsland = typeof initialIsland === 'string' ? initialIsland : null;
  let pendingIsland = lastIsland; // tried once, on the first board: an island remembered between visits
  let worldIslands = [];
  // Filled alongside worldIslands: a repo seen only in the graveyard has no body to take a colour from, so it
  // would otherwise share the no-repo island's chalk. Built once per board rather than per frame.
  let islandColours = new Map();
  let afterApply = null; // { island, scene }: notifications queued from inside an application of the board
  let privacy = false;
  let selectedId = null;
  let hoverId = null;
  let press = null; // { id, x, y, touch, up } from the last primary pointerdown on the canvas
  let hoverDirty = false;
  let lastHoverPoint = null;
  let started = false;
  let destroyed = false;
  let firstUpdate = true;
  let scene = mode === 'world' ? 'world' : 'village';
  let rafId = 0;
  let slowTimer = 0;
  let needsDraw = true;
  let lastDrawMs = -1e9;
  let lastT = 0;
  let frameTimer = 0;
  let frameTimerAt = 0;
  let view = null;
  let bg = null;
  let bgKey = '';
  let sceneBg = null; // the open interior's background: only one is kept, since only one can be open
  let sceneBgKey = '';
  let worldBg = null; // the world map's sea, which does not depend on the islands drawn over it
  let worldBgKey = '';

  const media = (q) => (typeof win.matchMedia === 'function' ? win.matchMedia(q) : null);
  const mqDark = media('(prefers-color-scheme: dark)');
  const mqReduce = media('(prefers-reduced-motion: reduce)');
  let reduced = !!(mqReduce && mqReduce.matches);
  let pack = THEME_KEYS.includes(initialTheme) ? initialTheme : DEFAULT_THEME;
  let theme = resolveTheme(pack, !!(mqDark && mqDark.matches));
  // What every cached layer is keyed by: a pack and a time of day each repaint the lot.
  const themeKey = () => `${theme.pack}|${theme.night ? 'dusk' : 'day'}`;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function listen(target, type, fn) {
    if (!target) return;
    if (typeof target.addEventListener === 'function') {
      target.addEventListener(type, fn);
      cleanups.push(() => target.removeEventListener(type, fn));
    } else if (type === 'change' && typeof target.addListener === 'function') {
      target.addListener(fn);
      cleanups.push(() => target.removeListener(fn));
    }
  }

  const isHidden = () => !!doc && doc.visibilityState === 'hidden';
  // What is on screen: the whole board in one village, or the open island's rows.
  const countOf = (lane) => (Number.isFinite(counts[lane]) ? counts[lane] : laneCounts.get(lane) || 0);
  const boardCountOf = (lane) => (Number.isFinite(boardCounts[lane]) ? boardCounts[lane] : boardLaneCounts.get(lane) || 0);
  const repoColourFor = (repo) => (typeof repo === 'string' && repoIndex.has(repo) ? REPO_PALETTE[repoIndex.get(repo)] : NO_REPO_COLOUR);

  // ----- sizing -----

  function resize() {
    if (destroyed || typeof canvas.getBoundingClientRect !== 'function') return;
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.round(rect.width);
    const cssH = Math.round(rect.height);
    if (!(cssW > 0 && cssH > 0)) return;
    const dpr = clamp(Number(win.devicePixelRatio) || 1, 1, 3);
    const pw = Math.round(cssW * dpr);
    const ph = Math.round(cssH * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    const scale = Math.min(cssW / W, cssH / H);
    view = { cssW, cssH, dpr, scale, offX: (cssW - W * scale) / 2, offY: (cssH - H * scale) / 2 };
    const key = `${pw}x${ph}@${dpr}`;
    if (key === bgKey && bg) return;
    bgKey = key;
    fitCache.clear();
    paintLayers();
    needsDraw = true;
    // Assigning canvas.width clears the bitmap immediately, and ResizeObserver runs after this frame's
    // rAF callbacks, so without a synchronous repaint every window resize flashes one blank frame.
    if (started && !isHidden()) draw(now());
    schedule();
  }

  function paintLayer(layer, painter) {
    if (!view) return null;
    let out = layer;
    if (!out && doc && typeof doc.createElement === 'function') out = doc.createElement('canvas');
    if (!out) return null;
    out.width = canvas.width;
    out.height = canvas.height;
    const g = out.getContext('2d');
    if (!g) return null;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = theme.grass;
    g.fillRect(0, 0, out.width, out.height);
    const k = view.dpr * view.scale;
    g.setTransform(k, 0, 0, k, view.dpr * view.offX, view.dpr * view.offY);
    painter(g, theme);
    g.setTransform(1, 0, 0, 1, 0, 0);
    return out;
  }

  // An interior, and the world map's sea, are painted only once someone goes there, then kept in step with resizes
  // and theme changes.
  function paintLayers() {
    bg = paintLayer(bg, paintBackground);
    sceneBgKey = '';
    worldBgKey = '';
    if (scene === 'world') ensureWorldLayer();
    else if (scene !== 'village') ensureSceneLayer();
  }

  function ensureSceneLayer() {
    const art = SCENE_ART[scene];
    if (!art) return;
    const key = `${scene}|${bgKey}|${themeKey()}`;
    if (sceneBg && sceneBgKey === key) return;
    sceneBg = paintLayer(sceneBg, art.paint);
    sceneBgKey = sceneBg ? key : '';
  }

  // The sea alone, so a board that changes its islands costs no repaint: the islands themselves are drawn per frame.
  function ensureWorldLayer() {
    const key = `world|${bgKey}|${themeKey()}`;
    if (worldBg && worldBgKey === key) return;
    worldBg = paintLayer(worldBg, paintWorldSea);
    worldBgKey = worldBg ? key : '';
  }

  // ----- scheduling -----

  // Guests wander an interior at up to 24 fps, only while it is open; everything else there is ambient.
  function interiorWandering() {
    const inside = guestsOf(scene);
    return !!inside && !reduced && inside.size > 0;
  }

  function frameGap() {
    return interiorWandering() ? HALL_FRAME_MS : AMBIENT_FRAME_MS;
  }

  // The guests of an interior scene, or null in the village.
  function guestsOf(name) {
    return hasOwn(guests, name) ? guests[name] : null;
  }

  // When the barrier rises or falls for the journeys under way. Reduced motion keeps it down.
  function barrierPlan() {
    if (reduced) return [];
    const out = [];
    for (const c of chars.values()) if (c.journey) out.push(...barrierWindows(c.journey));
    return out;
  }

  // Only what can be seen moving in the village earns full frame rate. A passenger standing on the pier tip or at the
  // jetty end for its boat, one held in its boat, and a boat trip or headstone that has not started yet do not.
  function anyMotion(t) {
    if (scene !== 'village') return false;
    for (const w of barrierPlan()) if ((t >= w.up0 && t < w.up1) || (t >= w.down0 && t < w.down1)) return true;
    for (const c of chars.values()) if (c.resize) return true;
    for (const c of chars.values()) {
      if (!c.journey) continue;
      const leg = c.journey.legs.find((l) => t < l.t0 + l.dur);
      // Past its last leg it is still drawn moving until the next frame settles it.
      if (!leg || (t >= leg.t0 && leg.kind !== 'wait')) return true;
    }
    for (const f of ferries) if (t >= f.t0 && t < f.t0 + f.dur) return true;
    for (const s of stones.values()) if (Number.isFinite(s.riseAt) && t >= s.riseAt && t < s.riseAt + RISE_S) return true;
    // A visitor walking up the pier, along the landing or away again. Standing in the queue is not motion, and nor
    // is waiting at the pier tip for its turn to step off.
    for (const v of visitors.values()) if (v.journey && t >= v.journey.t0 && t < v.journey.end) return true;
    return false;
  }

  // When something that is still now starts to move (seconds), or Infinity.
  function nextMotionAt(t) {
    let at = Infinity;
    if (scene !== 'village') return at;
    for (const c of chars.values()) {
      if (!c.journey) continue;
      const leg = c.journey.legs.find((l) => t < l.t0 + l.dur);
      if (leg && t < leg.t0) at = Math.min(at, leg.t0);
      else if (leg && leg.kind === 'wait') at = Math.min(at, leg.t0 + leg.dur);
    }
    for (const f of ferries) if (f.t0 > t) at = Math.min(at, f.t0);
    for (const s of stones.values()) if (Number.isFinite(s.riseAt) && s.riseAt > t) at = Math.min(at, s.riseAt);
    for (const w of barrierPlan()) {
      if (w.up0 > t) at = Math.min(at, w.up0);
      else if (w.down0 > t) at = Math.min(at, w.down0);
    }
    for (const v of visitors.values()) if (v.journey && v.journey.t0 > t) at = Math.min(at, v.journey.t0);
    return at;
  }

  function loop() {
    rafId = 0;
    if (!started || destroyed || isHidden()) return;
    const ms = now();
    const moving = anyMotion(ms / 1000);
    if (needsDraw || ms - lastDrawMs >= (moving ? MOTION_FRAME_MS : frameGap())) draw(ms);
    if (rafId || !started || destroyed) return;
    if (reduced) {
      if (hoverDirty) sleepUntilAmbientFrame();
      return;
    }
    if (anyMotion(now() / 1000)) {
      rafId = win.requestAnimationFrame(loop);
      return;
    }
    sleepUntilAmbientFrame();
  }

  // Sleep until the next ambient frame instead of waking on every display refresh, or until something starts to move
  // if that comes sooner, so a boat still leaves on time.
  function sleepUntilAmbientFrame() {
    const ms = now();
    let wait = Math.max(0, frameGap() - (ms - lastDrawMs));
    const next = nextMotionAt(ms / 1000);
    if (next < Infinity) wait = Math.min(wait, Math.max(0, Math.ceil(next * 1000 - ms) + 1));
    if (frameTimer) {
      if (ms + wait >= frameTimerAt) return;
      clearTimeout(frameTimer);
    }
    frameTimerAt = ms + wait;
    frameTimer = setTimeout(() => {
      frameTimer = 0;
      schedule();
    }, wait);
  }

  function schedule() {
    if (!started || destroyed || isHidden() || rafId) return;
    if (typeof win.requestAnimationFrame !== 'function') return;
    rafId = win.requestAnimationFrame(loop);
  }

  // A hover change only moves a plate, so it rides the next ambient frame. Sweeping the pointer across a
  // crowd changes hover many times a second, and drawing for each would lift the frame rate.
  function requestHoverDraw() {
    hoverDirty = true;
    if (!started || destroyed || isHidden() || rafId || frameTimer) return;
    if (now() - lastDrawMs >= frameGap()) schedule();
    else sleepUntilAmbientFrame();
  }

  function setSlowTimer() {
    if (slowTimer) {
      clearInterval(slowTimer);
      slowTimer = 0;
    }
    // Reduced motion draws on demand, so this keeps wait escalation current without a frame loop.
    if (started && reduced && !destroyed) {
      slowTimer = setInterval(() => {
        needsDraw = true;
        schedule();
      }, 10000);
    }
  }

  // ----- journeys -----

  function settle(c, x, y, area, t) {
    c.journey = null;
    c.pending = null;
    c.boat = null;
    c.inBoat = false;
    c.walkingNow = false;
    c.gate = null;
    c.px = x;
    c.py = y;
    c.area = area;
    c.alpha = 1;
    c.arrivedAt = t;
  }

  // Grows or shrinks a character to `size`, easing unless placed directly.
  function resizeTo(c, size, t, direct) {
    if (direct || !Number.isFinite(c.size)) {
      Object.assign(c, { size, resize: null });
      return;
    }
    const target = c.resize ? c.resize.to : c.size;
    if (Math.abs(target - size) < 1e-6) return;
    c.resize = { from: c.size, to: size, t0: t };
  }

  // Freezes a character where its journey has it now, so a new journey can start from there.
  function syncPosition(c, t) {
    if (!c.journey) return;
    const st = journeyAt(c.journey, t);
    settle(c, st.x, st.y, st.area, c.arrivedAt);
  }

  function travel(c, to, t0, opts = {}) {
    const from = { x: c.px, y: c.py, area: c.area };
    const legs = planJourney(from, to, { stamp: !!opts.stamp, lane: sailLane(pack) });
    const journey = scheduleJourney(legs, t0, opts);
    if (!journey.legs.length && opts.fade) {
      // Already at the door or gate: without a leg to end on, nothing would ever fade it out.
      c.journey = scheduleJourney([{ kind: 'fade', area: to.area, pts: [{ x: to.x, y: to.y }], dur: FADE_S }], t0);
      return;
    }
    if (!journey.legs.length) {
      settle(c, to.x, to.y, to.area, t0);
      return;
    }
    cancelFerries(c.id, t0);
    const journeys = [...chars.values()].filter((o) => o !== c && o.journey).map((o) => o.journey);
    holdForGate(journey, journeys);
    const trips = scheduleFerries(journey, t0, sailLane(pack));
    planBoats(journey, trips, { journeys, ferries }, t0);
    for (const trip of trips) ferries.push({ owner: c.id, ...trip });
    c.journey = journey;
    c.alpha = opts.appear ? 0 : 1;
  }

  function cancelFerries(owner, t) {
    ferries = cancelTrips(ferries, owner, t);
  }

  // Where a character's boat is while it has one (hopping in, sailing or hopping out), else null.
  function boatOf(c, t) {
    if (!c.journey || c.leaving) return null;
    const st = journeyAt(c.journey, t);
    return st.boat ? { x: st.boat.x, y: st.boat.y } : null;
  }

  // A new destination for a character still on its way. One that has only to land first keeps its plan and goes on
  // from there; otherwise only the end of the journey moves when it lies in the same area. False when neither applies.
  function retarget(c, to, t, opts = {}) {
    if (c.leaving) return false;
    if (c.pending) {
      c.pending = { to, opts };
      return true;
    }
    return retargetJourney(c.journey, to, t, opts);
  }

  // Walking a routed leg (along the roads, or off the jetty), where a straight dash to a new slot would cut across the
  // village or the sea.
  function onRoute(c, t) {
    const leg = c.journey && !c.leaving ? c.journey.legs.find((l) => t < l.t0 + l.dur) : null;
    return !!leg && leg.kind === 'walk' && leg.pts.length > 2;
  }

  // Re-plans a character from where it is now: turning its boat if it is out on the water, else walking.
  function replan(c, to, t, opts = {}) {
    const boat = boatOf(c, t);
    const was = c.journey;
    syncPosition(c, t);
    if (!boat) {
      travel(c, to, t, opts);
      return;
    }
    const others = [...chars.values()].filter((o) => o !== c && o.journey).map((o) => ({ id: o.id, journey: o.journey }));
    const plan = turnBack({ id: c.id, boat, journey: was, to, opts, lane: sailLane(pack) }, others, ferries, t);
    ferries = plan.ferries;
    c.journey = plan.journey;
    c.pending = plan.pending;
    c.alpha = 1;
  }

  function walkOff(c, t) {
    cancelFerries(c.id, t);
    c.pending = null;
    const here = { x: c.px, y: c.py };
    let leg;
    if (c.area === 'land') leg = walkLeg(planRoute(here, EXIT_POINT), 'land');
    else if (c.area === 'island') leg = walkLeg([here, { x: here.x + 40, y: here.y + 6 }], 'island', 0.9);
    else leg = { kind: 'fade', area: 'water', pts: [here], dur: FADE_S };
    leg.fadeOut = true;
    c.journey = scheduleJourney([leg], t);
  }

  // ----- visitors at the desk -----

  function settleVisitor(v, x, y) {
    Object.assign(v, { journey: null, px: x, py: y, tx: x, ty: y, alpha: 1, walkingNow: false, stride: 0 });
  }

  // Freezes a visitor where its walk has it now, so a new one can start from there.
  function syncVisitor(v, t) {
    if (!v.journey) return;
    const st = journeyAt(v.journey, t);
    settleVisitor(v, st.x, st.y);
  }

  // Still standing unseen at the pier tip, its staggered turn to step off not yet come.
  const waitingTurn = (v, t) => !!v.journey && t < v.journey.t0;

  function visitorWalk(v, to, t, opts = {}) {
    const legs = [walkLeg(visitorPath({ x: v.px, y: v.py }, to), 'land')];
    v.journey = scheduleJourney(legs, t, opts);
    v.alpha = opts.appear ? 0 : 1;
  }

  // The queue at whatever is on screen: the whole board's visitors, or the open island's. They walk on and off up
  // the pier, so a review request arriving or being answered is never a figure appearing or vanishing mid-frame.
  function applyVisitors(list, instant, t) {
    const layout = visitorLayout(list);
    const stillWaiting = new Set(Array.isArray(list) ? list.map((v) => v.id) : []);
    visitorTotal = layout.total;
    visitorHidden = layout.hidden;
    const arriving = [];
    const appear = { x: VISITOR_DOCK.x, y: VISITOR_DOCK.y, area: 'land' };
    for (const [id, slot] of layout.slots) {
      let v = visitors.get(id);
      if (v && v.leaving) {
        syncVisitor(v, t);
        v.leaving = false;
      }
      if (!v) {
        v = { id, px: slot.x, py: slot.y, tx: slot.x, ty: slot.y, journey: null, alpha: 1, leaving: false, dir: -1, stride: 0 };
        visitors.set(id, v);
        if (!instant) arriving.push({ v, slot });
      } else if (Math.hypot(slot.x - v.tx, slot.y - v.ty) > 0.5) {
        // Somebody ahead was reviewed, so the queue closes up. One still waiting at the pier tip for its turn keeps
        // its turn, unseen, and walks to the new slot when it comes.
        if (instant) settleVisitor(v, slot.x, slot.y);
        else if (waitingTurn(v, t)) visitorWalk(v, slot, v.journey.t0, { appear });
        else {
          syncVisitor(v, t);
          visitorWalk(v, slot, t);
        }
      }
      v.visitor = slot.visitor;
      // The id when GitHub gave no author, so two author-less waits are not the same person in the same coat.
      v.colour = visitorColour(slot.visitor.login || slot.visitor.id);
      v.via = visitorVia(slot.visitor);
      v.phase = (repoHash(id) % 997) / 997;
      v.index = slot.index;
      v.tx = slot.x;
      v.ty = slot.y;
    }
    // One at a time off the pier tip, the back of the queue first: arrivals share one way up the pier, and one
    // walking to the back would otherwise pass through everyone already standing ahead of it.
    // A second batch queues behind the first one's turns rather than stepping off on top of them.
    arriving.sort((a, b) => b.slot.index - a.slot.index);
    const firstTurn = Math.max(t, lastTurnAt + VISITOR_STAGGER_S);
    arriving.forEach(({ v, slot }, i) => {
      Object.assign(v, { px: VISITOR_DOCK.x, py: VISITOR_DOCK.y });
      lastTurnAt = firstTurn + i * VISITOR_STAGGER_S;
      visitorWalk(v, slot, lastTurnAt, { appear });
    });
    for (const v of [...visitors.values()]) {
      if (layout.slots.has(v.id)) continue;
      // Before the leaving test: a change of island or of mode places everyone directly, and one already walking
      // off another island's desk would otherwise go on walking off on this one.
      if (instant) {
        visitors.delete(v.id);
        continue;
      }
      if (v.leaving) continue;
      // Never seen, so there is nothing to walk off.
      if (waitingTurn(v, t)) {
        visitors.delete(v.id);
        continue;
      }
      syncVisitor(v, t);
      v.leaving = true;
      // Still waiting, and only out of the drawn nine because a request asked of you took its place: it steps out
      // of view where it stands. Walking off down the pier is what an answered request does.
      if (stillWaiting.has(v.id)) {
        v.journey = scheduleJourney([{ kind: 'fade', area: 'land', pts: [{ x: v.px, y: v.py }], dur: FADE_S }], t);
      } else visitorWalk(v, VISITOR_DOCK, t, { fade: true });
    }
  }

  function doorOf(place) {
    if (place === 'castle') return { x: CASTLE.door.x, y: CASTLE.door.y, area: 'island' };
    if (place === 'cottages') return { x: COTTAGE.door.x, y: COTTAGE.door.y, area: 'land' };
    return { x: GRAVEYARD.gate.x, y: GRAVEYARD.gate.y, area: 'land' };
  }

  // ----- data -----

  function update(board, options = {}) {
    if (destroyed) return;
    privacy = !!(options && options.privacy);
    boardCounts = board && board.counts && typeof board.counts === 'object' ? board.counts : {};
    boardSessions = board && Array.isArray(board.sessions) ? board.sessions : [];
    // Cleaned here rather than trusted: the village is handed the server's own board, and the queue, the map's
    // badges and the page's pill all have to be counting one list.
    const ids = new Set();
    for (const s of boardSessions) if (s && typeof s.id === 'string') ids.add(s.id);
    boardVisitors = visitorRows(board && board.visitors, ids);
    const counted = board && board[REVIEWS_KEY] && typeof board[REVIEWS_KEY] === 'object' ? board[REVIEWS_KEY].waiting : null;
    boardReviewsSent = Number.isFinite(counted) && counted > 0 ? Math.floor(counted) : null;
    applyBoard(false);
  }

  // The whole board's reviews-waiting count. The server's own number wins when it sends one, so a list it has
  // capped still reports honestly, which is the rule the page's HUD pill follows too.
  function boardReviews() {
    return boardReviewsSent === null ? boardVisitors.length : boardReviewsSent;
  }

  // Every row the village would draw, deduplicated: the population both modes are built from.
  function validRows() {
    const seen = new Set();
    const out = [];
    for (const s of boardSessions) {
      if (!s || typeof s.id !== 'string' || !s.id || PLACE_IDS.has(s.id) || isIslandId(s.id) || seen.has(s.id) || !placeForLane(s.lane)) continue;
      seen.add(s.id);
      out.push(s);
    }
    return out;
  }

  // Lays the board out for whatever is on screen: the whole board, or the open island's rows. `direct` places
  // everyone where they belong with no journeys, which is what a change of mode or of island asks for, since the
  // visible set changes wholesale and nobody walked anywhere.
  function applyBoard(direct) {
    // Every repo that some character wears, which the page's legend passes too, so both give a repo the same colour.
    // Headstones carry no colour, so a repo seen only in the graveyard must not take a palette entry. Taken from the
    // whole board, never the open island, so an island's crowd keeps its colours whichever island is open.
    const viewRepos = repoNamesInView(boardSessions);
    repoIndex = repoColourIndices(viewRepos);
    const colourOf = (s) => repoColourFor(s.repo);
    const t = now() / 1000;
    const valid = validRows();
    boardLaneCounts = new Map();
    for (const s of valid) boardLaneCounts.set(s.lane, (boardLaneCounts.get(s.lane) || 0) + 1);
    worldIslands = mode === 'world' ? worldLayout(worldRepos(valid, boardVisitors)) : [];
    // Through the legend's own helper, which appends a name it has not seen for itself alone, so a graveyard-only
    // repo takes a palette entry instead of the no-repo chalk and no drawn character moves colour.
    islandColours = new Map(worldIslands.map((is) => [is.repo, repoColour(is.repo, viewRepos)]));
    if (island !== null && !worldIslands.some((is) => is.repo === island)) {
      // Its repo has left the board. An empty island says nothing, so fall back to the world map, and stop
      // remembering it: a mode round-trip must not reopen the island the page has just said is gone.
      island = null;
      lastIsland = null;
      afterApply = { island: null, scene: 'world' };
    } else if (mode === 'world' && island === null && pendingIsland !== null) {
      if (worldIslands.some((is) => is.repo === pendingIsland)) {
        island = pendingIsland;
        afterApply = { island, scene: 'village' };
      }
      pendingIsland = null;
    }
    // Computed after the island is settled: nobody is looking at a village while the world map is up, so rows are
    // placed rather than walked, the way a room keeps its guests still while it is closed. It also keeps a merge on
    // the map from planning a voyage, and an island whose repo just left from marching the whole board in.
    const instant = firstUpdate || reduced || direct || (mode === 'world' && island === null);
    const sessions = island === null ? valid : valid.filter((s) => repoKeyOf(s) === island);
    const seen = new Set(sessions.map((s) => s.id));
    // Inside an island every sign counts that island, so the number on a door is the number behind it. The server's
    // own counts cover the whole board, so they are only used when the whole board is on screen.
    counts = island === null ? boardCounts : {};
    laneCounts = new Map();
    for (const s of sessions) laneCounts.set(s.lane, (laneCounts.get(s.lane) || 0) + 1);

    const previous = new Map();
    for (const c of chars.values()) if (!c.leaving && !c.fadingInto) previous.set(c.id, { place: c.place, spot: c.spot, index: c.index });
    let layout = layoutVillage(sessions, previous);
    const graves = graveyardLayout(sessions.filter((s) => s.lane === 'graveyard').map((s) => s.id));
    const nextStones = new Map();

    let arrivals = 0;
    const placeRow = (s) => {
      const place = placeForLane(s.lane);
      const prevLane = lanes.get(s.id);
      const prevPlace = prevLane ? placeForLane(prevLane) : null;
      // Just after the server starts, rows show the app's stale PR states until GitHub answers. A move that only
      // reflects GitHub's first answer (a PR merged weeks ago) is old news, so it is placed rather than sailed.
      const quiet = instant || (!!s.pr && s.pr.verified === true && verified.get(s.id) === false);
      let c = chars.get(s.id);
      if (c && c.leaving) {
        syncPosition(c, t);
        c.leaving = false;
      }

      if (isRoomPlace(place) || place === 'graveyard') {
        if (c && c.fadingInto !== place) {
          if (quiet) {
            cancelFerries(s.id, t);
            chars.delete(s.id);
            c = null;
          } else {
            const door = doorOf(place);
            if (!retarget(c, door, t, { fade: true })) replan(c, door, t, { fade: true, stamp: prevLane === 'open_pr' });
            c.fadingInto = place;
            c.place = null;
            c.index = -1;
          }
        }
        if (c) {
          c.session = s;
          c.feat = lookFeatures(s.look);
          c.phase = lookPhase(s.look);
          c.colour = colourOf(s);
        }
        const slot = place === 'graveyard' ? graves.get(s.id) : null;
        if (slot) {
          const old = stones.get(s.id);
          let riseAt = -Infinity;
          if (old) riseAt = old.riseAt;
          else if (c && c.journey) riseAt = c.pending ? Number.MAX_VALUE : c.journey.end;
          else if (!quiet) riseAt = t;
          nextStones.set(s.id, { id: s.id, session: s, index: slot.index, x: slot.x, y: slot.y, riseAt, px: slot.x, py: slot.y, alpha: 1 });
        }
        return;
      }

      const slot = layout.get(s.id);
      const area = areaForPlace(place);
      if (!c) {
        c = {
          id: s.id, px: slot.x, py: slot.y, tx: slot.x, ty: slot.y, journey: null, alpha: 1, leaving: false,
          fadingInto: null, area, dir: 0, stride: 0, arrivedAt: t - 10, lastHp: null, nextPuff: 0, boat: null,
        };
        chars.set(s.id, c);
        if (!quiet) {
          let appear = null;
          if (prevPlace === 'graveyard' || isRoomPlace(prevPlace)) appear = doorOf(prevPlace);
          const from = appear || { x: ENTRY_POINT.x, y: ENTRY_POINT.y, area: 'land' };
          Object.assign(c, { px: from.x, py: from.y, area: from.area });
          const delay = appear ? 0 : Math.min(arrivals, 10) * 0.2;
          if (!appear) arrivals += 1;
          travel(c, { x: slot.x, y: slot.y, area }, t + delay, { appear });
        }
      } else {
        const moved = Math.hypot(slot.x - c.tx, slot.y - c.ty) > 0.5;
        const changedPlace = c.place !== slot.place || !!c.fadingInto;
        if (moved || changedPlace) {
          const to = { x: slot.x, y: slot.y, area };
          c.fadingInto = null;
          if (reduced || quiet) {
            syncPosition(c, t);
            cancelFerries(c.id, t);
            settle(c, slot.x, slot.y, area, t);
          } else if (retarget(c, to, t)) {
            // Still on its way, so it keeps its route (and its boat) and only arrives somewhere else.
          } else if (changedPlace || boatOf(c, t) || onRoute(c, t)) {
            // A merged PR leaving the harbour queue has its passport stamped at the barrier on the way.
            replan(c, to, t, { stamp: prevLane === 'open_pr' && area === 'island' });
          } else {
            syncPosition(c, t);
            // Across the porch (door to swings) is a stroll timed by its length; a shuffle within a spot is quick.
            const dur = c.spot === slot.spot ? 0.8 : undefined;
            const pts = area === 'island' ? islandRoute({ x: c.px, y: c.py }, to) : [{ x: c.px, y: c.py }, { x: slot.x, y: slot.y }];
            c.journey = scheduleJourney([walkLeg(pts, area, dur)], t);
          }
        }
      }
      c.session = s;
      c.feat = lookFeatures(s.look);
      c.phase = lookPhase(s.look);
      c.colour = colourOf(s);
      // The whole place shrinks into its cap rather than clipping at it, so bigger still means more tokens in a crowd.
      resizeTo(c, (tokenScale(s) * slot.cap) / TOKEN_SCALE.max, t, quiet || reduced);
      c.place = slot.place;
      c.spot = slot.spot;
      c.index = slot.index;
      c.slotDx = slot.dx;
      c.tx = slot.x;
      c.ty = slot.y;
    };

    // A second merge waits for the gate standing in its queue slot, but the layout above already counts it gone, so
    // someone could walk into it. Stamp walkers are planned first; while any of them is held back, every row leaving the
    // queue keeps its slot as a placeholder, so the queue keeps its count and nobody moves, until the last one sets off.
    const leftQueue = (s) => lanes.get(s.id) === 'open_pr' && s.lane !== 'open_pr';
    const stampFirst = instant ? [] : sessions.filter((s) => leftQueue(s) && areaForPlace(placeForLane(s.lane)) === 'island');
    for (const s of stampFirst) placeRow(s);
    const heldAt = [...chars.values()]
      .filter((c) => !c.leaving && c.journey && c.journey.legs.some((l) => l.kind === 'gate') && t < c.journey.legs[0].t0)
      .map((c) => c.journey.legs[0].t0);
    if (heldAt.length) queueHold = { until: Math.max(queueHold ? queueHold.until : 0, ...heldAt), slots: queueHold ? queueHold.slots : new Map() };
    if (queueHold && (reduced || instant || t >= queueHold.until)) queueHold = null;
    if (queueHold) {
      for (const s of sessions) {
        const p = previous.get(s.id);
        if (leftQueue(s) && p && p.place === 'harbour' && !queueHold.slots.has(s.id)) queueHold.slots.set(s.id, p.index);
      }
      const inQueue = new Set(sessions.filter((s) => s.lane === 'open_pr').map((s) => s.id));
      const holders = [];
      for (const [id, index] of queueHold.slots) {
        if (inQueue.has(id)) continue;
        holders.push({ id: `${id}#held`, lane: 'open_pr' });
        previous.set(`${id}#held`, { place: 'harbour', spot: 'harbour', index });
      }
      if (holders.length) layout = layoutVillage([...sessions, ...holders], previous);
    }
    const planned = new Set(stampFirst);
    for (const s of sessions) if (!planned.has(s)) placeRow(s);

    for (const c of [...chars.values()]) {
      if (seen.has(c.id)) continue;
      // Before the leaving test, as for visitors: a session walking off one island must not walk on over the next.
      if (instant) {
        cancelFerries(c.id, t);
        chars.delete(c.id);
        continue;
      }
      if (c.leaving) continue;
      syncPosition(c, t);
      c.leaving = true;
      c.fadingInto = null;
      walkOff(c, t);
    }

    stones = nextStones;
    for (const [name, art] of Object.entries(SCENE_ART)) {
      const rows = sessions.filter((s) => placeForLane(s.lane) === name);
      const spread = name === 'cottages'
        ? cottageSeatLayout(rows.length, rows.map(tokenScale)) : castleLayout(rows.length, rows.map(tokenScale), art.spec);
      const next = new Map();
      rows.forEach((s, i) => {
        const p = spread.points[i];
        // A guest already inside keeps wandering from where it is; a newcomer starts on a spread spot.
        const g = guests[name].get(s.id)
          || { id: s.id, px: p.x, py: p.y, rng: mulberry32(repoHash(s.id)), walking: false, stride: 0, dir: 0 };
        if (reduced) Object.assign(g, { px: p.x, py: p.y, tx: undefined, walking: false });
        Object.assign(g, {
          session: s, feat: lookFeatures(s.look), phase: lookPhase(s.look), colour: colourOf(s), k: spread.scale,
          alpha: 1, journey: null, inside: true, size: tokenScale(s),
        });
        next.set(s.id, g);
      });
      guests[name] = next;
      crowdScale[name] = spread.scale;
    }
    applyVisitors(island === null ? boardVisitors : visitorsFor(boardVisitors, island), instant, t);
    lanes = new Map(sessions.map((s) => [s.id, s.lane]));
    verified = new Map(sessions.map((s) => [s.id, !!s.pr && s.pr.verified === true]));

    if (hoverId && !targetOf(hoverId)) setHover(null);
    firstUpdate = false;
    needsDraw = true;
    schedule();
    // The page's handlers run outside the layout above, so one of them cannot re-enter it half built.
    if (afterApply) {
      const { island: to, scene: next } = afterApply;
      afterApply = null;
      notifyIsland(to);
      setScene(next);
    }
  }

  function advance(t) {
    if (ferries.length) ferries = ferries.filter((f) => t < f.t0 + f.dur);
    for (const c of chars.values()) {
      if (!c.resize) continue;
      const p = clamp((t - c.resize.t0) / RESIZE_S, 0, 1);
      c.size = lerp(c.resize.from, c.resize.to, easeInOut(p));
      if (p >= 1) c.resize = null;
    }
    for (const c of [...chars.values()]) {
      const j = c.journey;
      if (!j) continue;
      const st = journeyAt(j, t);
      if (st.done && c.pending) {
        // Landed from a crossing it had to finish: now it heads where it was sent meanwhile.
        const { to, opts } = c.pending;
        settle(c, st.x, st.y, j.toArea, t);
        travel(c, to, t, opts);
        const stone = stones.get(c.id);
        if (stone && c.journey && c.fadingInto === 'graveyard') stone.riseAt = c.journey.end;
        continue;
      }
      if (st.done) {
        if (c.leaving || c.fadingInto) {
          chars.delete(c.id);
          continue;
        }
        settle(c, st.x, st.y, j.toArea, t);
        continue;
      }
      c.px = st.x;
      c.py = st.y;
      c.alpha = st.alpha;
      c.boat = st.boat;
      c.inBoat = st.inBoat;
      c.gate = st.gate || null;
      c.walkingNow = st.walking;
      if (st.dir) c.dir = st.dir;
      c.stride = st.walking ? (st.dist || (t - j.t0) * 90) / 24 : 0;
    }
    for (const v of [...visitors.values()]) {
      if (!v.journey) continue;
      const st = journeyAt(v.journey, t);
      if (st.done) {
        if (v.leaving) {
          visitors.delete(v.id);
          continue;
        }
        settleVisitor(v, st.x, st.y);
        continue;
      }
      v.px = st.x;
      v.py = st.y;
      v.alpha = st.alpha;
      v.walkingNow = st.walking;
      if (st.dir) v.dir = st.dir;
      v.stride = st.walking ? (st.dist || (t - v.journey.t0) * 90) / 24 : 0;
    }
  }

  function settleForReducedMotion() {
    const t = now() / 1000;
    for (const c of [...chars.values()]) {
      if (!c.journey) continue;
      if (c.leaving || c.fadingInto) {
        chars.delete(c.id);
        continue;
      }
      settle(c, c.tx, c.ty, areaForPlace(c.place), t);
    }
    for (const c of chars.values()) if (c.resize) Object.assign(c, { size: c.resize.to, resize: null });
    for (const v of [...visitors.values()]) {
      if (v.leaving) visitors.delete(v.id);
      else settleVisitor(v, v.tx, v.ty);
    }
    for (const s of stones.values()) s.riseAt = -Infinity;
    for (const [name, art] of Object.entries(SCENE_ART)) {
      const inside = [...guests[name].values()];
      const spread = name === 'cottages'
        ? cottageSeatLayout(inside.length, inside.map((g) => g.size)) : castleLayout(inside.length, inside.map((g) => g.size), art.spec);
      inside.forEach((g, i) => Object.assign(g, { px: spread.points[i].x, py: spread.points[i].y, tx: undefined, walking: false }));
    }
    ferries = [];
    clearPool(sparks);
    clearPool(smoke);
  }

  // ----- particles -----

  function emitParticles(t) {
    for (const c of chars.values()) {
      if (c.journey || c.leaving) continue;
      const lane = c.session.lane;
      const m = BODY[c.feat.shape];
      const k = scaleOf(c);
      if (lane === 'running') {
        const hp = hammerPhase(t, c.phase);
        if (c.lastHp !== null && hp < c.lastHp) {
          const top = c.py - (LEG + m.h) * k;
          const sx = c.px + (m.w / 2 - 1) * k;
          const sy = top + m.h * 0.55 * k;
          const hx = sx + Math.cos(HAMMER_STRIKE) * 24 * k;
          const hy = sy + Math.sin(HAMMER_STRIKE) * 24 * k;
          for (let i = 0; i < 5; i++) {
            emit(sparks, hx, hy, (Math.random() - 0.35) * 170, -70 - Math.random() * 120, 0.3 + Math.random() * 0.25, 1.6);
          }
        }
        c.lastHp = hp;
      } else if (lane === 'errored' && t >= c.nextPuff) {
        const top = c.py - (3 + m.h) * k;
        emit(smoke, c.px + (m.w / 2 + 3) * k, top + 4 * k, 5 + Math.random() * 6, -20 - Math.random() * 8, 1.9, (3.5 + Math.random() * 2) * k);
        c.nextPuff = t + 1.1 + Math.random() * 0.5;
      }
    }
  }

  function drawParticles() {
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < smoke.n; i++) {
      if (smoke.life[i] <= 0) continue;
      const k = smoke.age[i] / smoke.life[i];
      ctx.globalAlpha = 0.42 * (1 - k) * Math.min(1, k * 6);
      fillEllipse(ctx, smoke.x[i], smoke.y[i], smoke.size[i] * (1 + k * 1.8), smoke.size[i] * (1 + k * 1.5), `rgb(${theme.smoke})`);
    }
    ctx.strokeStyle = '#fff6dc';
    for (let i = 0; i < sparks.n; i++) {
      if (sparks.life[i] <= 0) continue;
      ctx.globalAlpha = 1 - sparks.age[i] / sparks.life[i];
      ctx.lineWidth = sparks.size[i];
      ctx.beginPath();
      ctx.moveTo(sparks.x[i], sparks.y[i]);
      ctx.lineTo(sparks.x[i] - sparks.vx[i] * 0.025, sparks.y[i] - sparks.vy[i] * 0.025);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ----- scene layers -----

  // The harbour has one boat in view: while any boat is out, carrying someone or sailing empty, the berth is empty.
  function harbourBoatAway(t) {
    for (const c of chars.values()) if (c.journey && c.boat) return true;
    return ferries.some((f) => LANE_OF[f.kind] && t >= f.t0 && t < f.t0 + f.dur);
  }

  // A warm halo around a window or a lantern, then the pane itself. The cottages, the sand castle and the
  // lighthouse share it, so the village has one language for a light burning inside something.
  function warmHalo(x, y, r, peak, rgb = WARM_LIGHT) {
    const glow = ctx.createRadialGradient(x, y, 2, x, y, r);
    glow.addColorStop(0, `rgba(${rgb}, ${peak})`);
    glow.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Unpaned is the castle's form. Its radius is half the pane's short side because every opening `paintSandCastle`
  // draws is a capsule, and a smaller radius would leave the pane's corners out on the wall. No outline either: the
  // opening is already drawn in castleDoor against castle, and a 1 px stroke centred on a 5.6 px pane eats the light.
  function litWindow(T, box, spread, panes) {
    const [x, y, w, h] = box;
    warmHalo(x + w / 2, y + h / 2, spread, 0.55);
    if (!panes) {
      fillRR(ctx, x, y, w, h, Math.min(w, h) / 2, T.windowLit);
      return;
    }
    fillRR(ctx, x, y, w, h, 2, T.windowLit, T.woodDark, 2);
    line(ctx, x + w / 2, y, x + w / 2, y + h, T.woodDark, 1.5);
    line(ctx, x, y + h / 2, x + w, y + h / 2, T.woodDark, 1.5);
  }

  // The stray on the roads. Everything it paints stays within HORSE_REACH of the line it is on, which is what
  // keeps a hoof off the grass at a corner.
  function drawHorse(env) {
    const T = env.theme;
    const { x, y, dir } = horseAt(env.t, env.reduced);
    const gait = env.reduced ? 0 : Math.sin(env.t * 7);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir < 0 ? -1 : 1, 1);
    fillEllipse(ctx, 1, 12, 14, 3.5, T.shadow);
    // Legs first, so the body covers where they meet it.
    for (const [lx, phase] of [[-8, 0], [-5, 1.6], [7, 3.1], [10, 4.7]]) {
      const swing = gait * Math.sin(phase) * 3;
      line(ctx, lx, -1, lx + swing, 11, T.woodDark, 2.6);
    }
    fillRR(ctx, -11, -10, 22, 11, 5, T.cat, T.woodDark, 1.5);
    // Neck, head and muzzle, carried forward: nothing here is more than HORSE_REACH off the line it runs on.
    fillRR(ctx, 7, -13, 6, 8, 3, T.cat, T.woodDark, 1.5);
    fillRR(ctx, 6, -13, 9, 6, 3, T.cat, T.woodDark, 1.5);
    fillPoly(ctx, [[8, -13], [10, -15], [12, -12]], T.woodDark);
    line(ctx, -11, -9, -14, -3, T.woodDark, 2.4);
    ctx.restore();
  }

  // Creeping the inside of the graveyard fence. Everything he paints stays within GOLLUM_REACH of the point he
  // is at, which is what keeps him off the rails at a corner.
  const GOLLUM_DRAW = 1.15;
  function drawGollum(env) {
    const T = env.theme;
    const { x, y, dir } = gollumAt(env.t, env.reduced);
    const creep = env.reduced ? 0 : Math.sin(env.t * 4.5);
    ctx.save();
    ctx.translate(x, y);
    // Drawn at 1.15, because at 1 he stood a head shorter than the ghosts he is creeping past and read as a bug.
    ctx.scale(dir < 0 ? -GOLLUM_DRAW : GOLLUM_DRAW, GOLLUM_DRAW);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    fillEllipse(ctx, 1, 9, 14, 3.5, T.shadow);
    // The head sits on top of everything else, not beside it. Drawn level with the body, the two ellipses read
    // as a creature with two heads, which is what the first go at him looked like.
    // He skulks upright rather than trotting on all fours: knees bent deep, arms hanging past them, head craned
    // out in front of the body. On all fours he was a grey insect, whatever size the head was.
    // Limbs taper: thigh and upper arm are drawn thick, shin and forearm thin over the top of them, which is
    // most of what stops a stick figure reading as a stick figure.
    for (const [fx, phase] of [[-5, 1.3], [2, 3.8]]) {
      const swing = creep * Math.sin(phase) * 2.4;
      const knee = [1 + swing * 0.5, 1];
      line(ctx, -2, -4, knee[0], knee[1], T.steel, 3.4);
      line(ctx, knee[0], knee[1], fx + swing, 7, T.steel, 2.4);
      // A splayed foot, because a leg that ends in a point is a stick.
      for (const toe of [-2.2, 0, 2.2]) line(ctx, fx + swing, 7, fx + swing + toe, 8.4, T.slate, 1.1);
    }
    for (const [hx, phase] of [[4, 2.6], [9, 0]]) {
      const swing = creep * Math.sin(phase) * 1.8;
      const elbow = [hx * 0.7 + swing, -3];
      line(ctx, 0, -9, elbow[0], elbow[1], T.steel, 3.2);
      line(ctx, elbow[0], elbow[1], hx + swing, 4, T.steel, 2.2);
      for (const f of [-1.6, 0, 1.6]) line(ctx, hx + swing, 4, hx + swing + f * 0.7, 6, T.slate, 1);
    }
    // A narrow hunched body: ribs over the chest, a shaded flank under it, and a neck craned forward.
    fillEllipse(ctx, -1, -6, 4.5, 5.5, T.steel, T.slate, 1.3);
    ctx.globalAlpha = 0.45;
    fillEllipse(ctx, -2.2, -4, 3, 3.4, T.slate);
    ctx.globalAlpha = 1;
    for (const [ry, rw] of [[-8.4, 3.4], [-6.6, 4], [-4.8, 3.6]]) line(ctx, -1 - rw / 2, ry, -1 + rw / 2, ry + 0.4, T.slate, 0.9);
    line(ctx, 0, -9, 3, -11, T.steel, 3.2);
    // The head: a cranium over a smaller jaw rather than one ellipse, with the jaw shaded and the cheek hollow
    // above it. Two circles stacked is the difference between a skull and a ball.
    fillEllipse(ctx, 4.6, -12.4, 5.4, 4.4, T.steel, T.slate, 1.3);
    fillEllipse(ctx, 5, -16, 6.9, 6, T.steel, T.slate, 1.4);
    ctx.globalAlpha = 0.4;
    fillEllipse(ctx, 4.6, -11.6, 4.4, 3, T.slate);
    fillEllipse(ctx, 1.6, -13.6, 2, 1.6, T.slate);
    ctx.globalAlpha = 1;
    // The eyes, with a lid over the top of each: a plain disc is the one shape that reads as a cartoon.
    for (const ex of [2.5, 8.5]) {
      fillEllipse(ctx, ex, -16.4, 3, 2.8, T.flameCore, T.slate, 1);
      fillEllipse(ctx, ex + 0.6, -16.4, 1.3, 1.6, T.slate);
      ctx.beginPath();
      ctx.arc(ex, -16.4, 3, Math.PI * 1.06, Math.PI * 1.94);
      ctx.strokeStyle = T.slate;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // Two nostril slits where a nose would be, and a wide thin mouth across the jaw with a few teeth in it.
    for (const nx of [4.8, 6.4]) line(ctx, nx, -13.9, nx + 0.3, -13.1, T.slate, 1);
    // In the slate the mouth vanished into the shading on the jaw, and three teeth made a skull of him.
    line(ctx, 1.8, -11.6, 8, -11.2, T.ink, 1.4);
    for (const tx of [3.6, 6.4]) line(ctx, tx, -11.5, tx + 0.15, -10.7, T.flameCore, 0.8);
    for (const [hx, hy] of [[2, -20], [5, -20.5], [8, -20]]) line(ctx, hx, hy, hx - 1.5, hy - 2.5, T.slate, 1.3);
    ctx.restore();
  }

  // What keeps the lair, walking the inside of the jail's plot. Everything it paints stays within SPIDER_REACH
  // of the point it is at, which is what keeps a leg off the road at a corner.
  function drawSpider(env) {
    const T = env.theme;
    const { x, y, dir } = spiderAt(env.t, env.reduced);
    const step = env.reduced ? 0 : Math.sin(env.t * 6);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir < 0 ? -1 : 1, 1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    fillEllipse(ctx, 0, 8, 11, 3, T.shadow);
    // Eight legs arched over the body, the near four stepping out of phase with the far four.
    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i += 1) {
        const sp = step * Math.sin(i * 1.7 + (side > 0 ? 0 : 1.9)) * 1.6;
        const reach = 7.5 + i * 1.1;
        const ax = (i - 1.5) * 2.6;
        strokePolyline(ctx, [[ax, -2], [ax + side * reach * 0.6, -8 - i * 0.6 + sp], [ax + side * reach, 6 + sp]], T.towerEdge, 1.8);
      }
    }
    // Abdomen behind, thorax in front, a cluster of eyes on it and two fangs under.
    fillEllipse(ctx, -6, -3, 8, 6.5, T.towerStone, T.towerEdge, 1.3);
    fillEllipse(ctx, -7, -4.5, 3.4, 2.2, T.slate);
    fillEllipse(ctx, 3, -2, 5, 4.2, T.towerStone, T.towerEdge, 1.3);
    for (const [ex, ey, er] of [[6, -4, 1.3], [7.4, -2, 1.1], [5.4, -0.4, 1], [7.8, -4.4, 0.9]]) {
      fillEllipse(ctx, ex, ey, er, er, T.flame);
    }
    for (const side of [-1, 1]) line(ctx, 6.4, 0.6, 7.8 + side * 0.7, 3.6, T.towerEdge, 1.4);
    ctx.restore();
  }

  // The grey pilgrim's fireworks. Night only, and nothing here starts a frame: env.t is the village's own tick.
  function drawFireworks(env) {
    if (!env.night) return;
    const T = env.theme;
    const [fx0, fy0] = FIREWORK_FROM;
    for (const f of FIREWORKS) {
      const s2 = fireworkAt(env.t, env.reduced, f);
      if (!s2) continue;
      paintFirework(ctx, T, f, s2, fx0, fy0);
    }
  }

  // One firework, wherever it is fired from: the rocket on its way up, or the burst opening. Shared, because the
  // hall shows the same fireworks through its own windows and a second copy would drift from this one.
  function paintFirework(g, T, f, s2, fromX, fromY) {
    if (s2.burst === 0) {
      const k = s2.rise;
      const tail = Math.max(0, k - 0.22);
      g.globalAlpha = 0.55;
      line(g, fromX + (f.x - fromX) * tail, fromY + (f.y - fromY) * tail,
        fromX + (f.x - fromX) * k, fromY + (f.y - fromY) * k, T.flame, 2);
      g.globalAlpha = 1;
      fillEllipse(g, fromX + (f.x - fromX) * k, fromY + (f.y - fromY) * k, 2.6, 2.6, T.flameCore);
      return;
    }
    // The burst: rays out from the centre, each with a spark on the end, fading as it opens.
    const k = s2.burst;
    const rr = f.r * (0.3 + 0.7 * Math.min(1, k * 1.7));
    const fall = k * k * FIREWORK_DROOP;
    g.globalAlpha = Math.max(0, 1 - k) * 0.95;
    for (let i = 0; i < f.rays; i += 1) {
      const a = (i / f.rays) * TAU + f.phase;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      line(g, f.x + c * rr * 0.34, f.y + sn * rr * 0.34 + fall * 0.12, f.x + c * rr, f.y + sn * rr + fall, T.flame, 2);
      fillEllipse(g, f.x + c * rr, f.y + sn * rr + fall, 2.2, 2.2, T.flameCore);
    }
    // A second, shorter ring between the first, so the burst has some depth to it.
    g.globalAlpha = Math.max(0, 1 - k) * 0.55;
    for (let i = 0; i < f.rays; i += 1) {
      const a = ((i + 0.5) / f.rays) * TAU + f.phase;
      const c = Math.cos(a) * rr * 0.64;
      const sn = Math.sin(a) * rr * 0.64;
      line(g, f.x + c * 0.4, f.y + sn * 0.4, f.x + c, f.y + sn + fall * 0.6, T.flame, 1.4);
    }
    g.globalAlpha = Math.max(0, 1 - k) * 0.95;
    fillEllipse(g, f.x, f.y, rr * 0.16, rr * 0.16, T.flameCore);
    g.globalAlpha = 1;
  }

  // The same display, seen from inside the hall through its two lancets. Clipped to the pane, so a spark cannot
  // land on the stone, and fired from the sill so a rocket climbs the window before it goes off.
  function drawHallFireworks(env) {
    for (const f of HALL_FIREWORKS) {
      const s2 = fireworkAt(env.t, env.reduced, f);
      if (!s2) continue;
      ctx.save();
      hallLancet(ctx, f.x);
      ctx.clip();
      paintFirework(ctx, env.theme, f, s2, f.x, 296);
      ctx.restore();
    }
  }

  // The ents, which dance and so cannot be painted into a layer that is drawn once. Everything else on the map
  // that moves is a session going somewhere; this is scenery, so it rides the ambient tick and never asks for a
  // frame of its own.
  function drawEnts(env) {
    for (const [x, y, r] of TREES) paintEnt(ctx, env.theme, x, y, r, entSway(env.t, env.reduced, x, y));
  }

  // One ent walking the ring the four roads make round the workshop, where the frontier has its horse. Its
  // footing stays on the road (ENT_WALK_FOOT); the rest of it rises well above the band, the way a session
  // walking the road does. Ambient tick, still under reduced motion, like everything else that is only scenery.
  function drawWalkingEnt(env) {
    const { x, y } = walkingEntAt(env.t, env.reduced);
    const stride = entStride(env.t, env.reduced);
    paintEnt(ctx, env.theme, x, y, ENT_WALK_R, stride * 0.5, stride, ENT_WALK_SEED);
  }

  function drawAmbient(env) {
    const { t, theme: T } = env;
    // Lit by whoever is in the room, idle or recent alike: dark windows with guests inside read as a bug.
    const guests = SCENE_ART.cottages.lanes.reduce((sum, lane) => sum + countOf(lane), 0);
    const lit = Math.min(guests, COTTAGE_WINDOWS.length);
    for (let i = 0; i < lit; i++) litWindow(T, COTTAGE_WINDOWS[i], 40, true);

    // Night, which is the dusk theme rather than the clock: the sand castle's windows and the lighthouse lantern
    // are lit, and the beam sweeps (over the crowd, in drawBeam).
    if (env.night) {
      for (const box of CASTLE_WINDOWS) litWindow(T, box, 26, false);
      const [lx, ly, lw, lh] = LIGHTHOUSE.lantern;
      warmHalo(LIGHTHOUSE.x, LIGHTHOUSE.y, LIGHTHOUSE.glow, 0.5, T.beamLight);
      if (env.pack === 'shire') {
        // The Eye, in the lantern's own opening: a lidded almond with a slit, looking wherever the beam points.
        const cx = lx + lw / 2;
        const cy = ly + lh / 2;
        const look = Math.cos(beamAngle(env.t, env.reduced)) * 3;
        fillPoly(ctx, [[lx, cy], [cx, ly + 1], [lx + lw, cy], [cx, ly + lh - 1]], `rgb(${T.beamLight})`, T.towerEdge, 1.2);
        fillEllipse(ctx, cx + look, cy, 2.6, 5.2, T.towerEdge);
      } else {
        fillRR(ctx, lx + 2, ly + 2, lw - 4, lh - 4, 2, T.windowLit, T.slate, 1.2);
      }
    }

    const needs = countOf('needs_you');
    if (needs > 0) {
      const flicker = env.reduced ? 1 : 0.86 + 0.14 * Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1);
      const glow = ctx.createRadialGradient(LANTERN.x, LANTERN.y, 3, LANTERN.x, LANTERN.y, 96);
      glow.addColorStop(0, `rgba(253, 126, 20, ${0.5 * flicker})`);
      glow.addColorStop(1, 'rgba(253, 126, 20, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(LANTERN.x - 100, LANTERN.y - 100, 200, 200);
      fillRR(ctx, LANTERN.x - 7, 717, 14, 20, 3, '#ffb163');
    }

    drawCat(env, needs > 0);
    if (!harbourBoatAway(t)) drawMooredBoat(env);
    for (const [x, y, h, lean] of PALMS) drawPalm(env, x, y, h, lean);
    drawCastleFlags(env);

    if (!env.reduced) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = T.ripple;
      ctx.lineWidth = 2;
      for (let i = 0; i < 16; i++) {
        const a = Math.sin(t * 1.3 + i * 1.7);
        if (a <= 0) continue;
        const y = 30 + ((i * 131) % 850);
        const x = shoreX(y) + 40 + ((i * 97) % 260);
        if (onIsland(x, y, 44) || nearHarbour(x, y, 6) || x > W - 10) continue;
        ctx.globalAlpha = a * 0.8;
        ctx.beginPath();
        ctx.moveTo(x - 7 - a * 4, y);
        ctx.lineTo(x + 7 + a * 4, y);
        ctx.stroke();
      }
      // Waves lapping the island.
      ctx.strokeStyle = T.foam;
      for (let i = 0; i < 8; i++) {
        const a = Math.sin(t * 0.9 + i * 2.1);
        if (a <= 0.2) continue;
        const ang = (i / 8) * TAU + 0.3;
        const c2 = Math.cos(ang);
        const s2 = Math.sin(ang);
        const r = (Math.abs(c2) ** 3 + Math.abs(s2) ** 3) ** (-1 / 3);
        const x = ISLAND.cx + c2 * (ISLAND.rx * r + 18);
        const y = ISLAND.cy + s2 * (ISLAND.ry * r + 18);
        if (x > W - 6) continue;
        ctx.globalAlpha = (a - 0.2) * 0.9;
        ctx.beginPath();
        ctx.arc(x, y, 9 + a * 5, ang + Math.PI * 0.6, ang + Math.PI * 1.4);
        ctx.stroke();
      }
      if (T.fireflies) {
        for (let i = 0; i < 14; i++) {
          const baseX = [60, 180, 300, 400, 120, 260, 520, 700, 980, 1180, 90, 350, 640, 1120][i];
          const baseY = [620, 700, 880, 770, 520, 440, 600, 880, 610, 870, 300, 150, 260, 260][i];
          const x = baseX + Math.sin(t * 0.45 + i * 2.1) * 26;
          const y = baseY + Math.cos(t * 0.37 + i * 1.3) * 16;
          const a = Math.max(0, Math.sin(t * 1.1 + i * 0.9));
          ctx.globalAlpha = a * 0.45;
          fillEllipse(ctx, x, y, 7, 7, '#e8efb4');
          ctx.globalAlpha = a;
          fillEllipse(ctx, x, y, 1.8, 1.8, '#f4f7d8');
        }
      }
      ctx.restore();
    }
  }

  function drawCat(env, awake) {
    const T = env.theme;
    const x = 1196 + HOUSE_DX;
    const y = 799;
    ctx.save();
    ctx.lineCap = 'round';
    if (awake) {
      fillEllipse(ctx, x, y - 12, 9, 12, T.cat);
      fillEllipse(ctx, x - 3, y - 27, 8, 7, T.cat);
      fillPoly(ctx, [[x - 10, y - 30], [x - 8, y - 39], [x - 3, y - 33]], T.cat);
      fillPoly(ctx, [[x + 4, y - 30], [x + 3, y - 39], [x - 2, y - 33]], T.cat);
      fillEllipse(ctx, x - 6, y - 28, 1.2, 1.4, T.ink);
      fillEllipse(ctx, x + 0.5, y - 28, 1.2, 1.4, T.ink);
      ctx.beginPath();
      ctx.moveTo(x + 7, y - 3);
      ctx.quadraticCurveTo(x + 20, y - 2, x + 16, y - 18);
      ctx.strokeStyle = T.cat;
      ctx.lineWidth = 3.5;
      ctx.stroke();
    } else {
      fillEllipse(ctx, x, y - 6, 15, 7, T.cat);
      fillEllipse(ctx, x - 12, y - 8, 6.5, 5.5, T.cat);
      fillPoly(ctx, [[x - 17, y - 11], [x - 16, y - 17], [x - 12, y - 13]], T.cat);
      fillPoly(ctx, [[x - 11, y - 12], [x - 8, y - 17], [x - 7, y - 11]], T.cat);
      ctx.beginPath();
      ctx.moveTo(x + 13, y - 3);
      ctx.quadraticCurveTo(x + 6, y + 4, x - 6, y);
      ctx.strokeStyle = T.cat;
      ctx.lineWidth = 3.5;
      ctx.stroke();
      line(ctx, x - 15, y - 8, x - 12, y - 8, T.ink, 1);
    }
    ctx.restore();
  }

  function drawMooredBoat(env) {
    const T = env.theme;
    const bob = env.reduced ? 0 : Math.sin(env.t * 1.4) * 2.2;
    const tilt = env.reduced ? 0 : Math.sin(env.t * 1.1 + 0.6) * 0.02;
    const bx = MOORED.x;
    const by = MOORED.y + 4 + bob;
    ctx.save();
    ctx.strokeStyle = T.woodDark;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(PIER.x + PIER.half - 4, PIER.tip - 5);
    ctx.quadraticCurveTo(PIER.x + PIER.half + 6, by - 20, bx + 22, by - 8);
    ctx.stroke();
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.ellipse(bx, by + 13, 46, 5, 0, 0, TAU);
    ctx.strokeStyle = T.ripple;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    drawRowboat(ctx, T, bx, by, { tilt, s: BOAT_SCALE });
  }

  function drawPalm(env, x, y, h, lean) {
    const T = env.theme;
    const sway = env.reduced ? 0 : Math.sin(env.t * 0.8 + x * 0.01) * 1 + Math.sin(env.t * 1.9 + y) * 0.35;
    if (env.pack === 'shire') {
      // A white tree on the palm's footing, keeping the sway that is the island's one bit of ambient motion.
      ctx.save();
      ctx.translate(sway * 0.8, 0);
      fillEllipse(ctx, x + 10, y + 2, 26, 6, T.shadow);
      const w = h * 0.1;
      fillRR(ctx, x - w / 2, y - h, w, h, w / 2, T.palmTrunk);
      for (const [ax, ay] of [[-0.3, 0.72], [0.28, 0.66], [-0.16, 0.86], [0.2, 0.9]]) {
        line(ctx, x, y - h * 0.62, x + h * ax, y - h * ay, T.palmTrunk, w * 0.5);
        fillEllipse(ctx, x + h * ax, y - h * ay, h * 0.16, h * 0.12, T.palm);
      }
      fillEllipse(ctx, x, y - h * 1.02, h * 0.2, h * 0.14, T.palmDark);
      ctx.restore();
      return;
    }
    if (env.west) {
      // A saguaro on the palm's footing: the island's one bit of ambient sway, so it keeps swaying.
      ctx.save();
      ctx.translate(sway * 0.8, 0);
      fillEllipse(ctx, x + 10, y + 2, 26, 6, T.shadow);
      const w = h * 0.13;
      fillRR(ctx, x - w / 2, y - h, w, h, w / 2, T.palm);
      for (const [ax, top, join] of [[x - h * 0.26, y - h * 0.74, y - h * 0.46], [x + h * 0.22, y - h * 0.62, y - h * 0.34]]) {
        const aw = w * 0.72;
        fillRR(ctx, ax - aw / 2, top, aw, join - top + aw, aw / 2, T.palmDark);
        fillRR(ctx, Math.min(ax, x) - aw / 2, join, Math.abs(ax - x) + aw, aw, aw / 2, T.palmDark);
      }
      ctx.restore();
      return;
    }
    const tx = x + lean + sway * 3;
    const ty = y - h;
    ctx.save();
    ctx.lineCap = 'round';
    fillEllipse(ctx, x + 10, y + 2, 30, 6, T.shadow);
    const segs = 9;
    for (let i = 0; i < segs; i++) {
      const k0 = i / segs;
      const k1 = (i + 1) / segs;
      const P = (k) => [x + (tx - x) * k + Math.sin(k * Math.PI) * lean * 0.25, y + (ty - y) * k];
      const [x0, y0] = P(k0);
      const [x1, y1] = P(k1);
      line(ctx, x0, y0, x1, y1, i % 2 ? T.palmTrunk : T.palmRing, 9 - k0 * 3.5);
    }
    const fronds = [-2.75, -2.25, -1.75, -1.2, -0.6, -0.05, -0.45 - Math.PI];
    fronds.forEach((a0, i) => {
      const a = a0 + sway * 0.06 * (i % 2 ? 1 : -1);
      const len = 46 - (i % 3) * 5;
      const pts = [];
      const back = [];
      for (let s = 0; s <= 8; s++) {
        const k = s / 8;
        const cx = tx + Math.cos(a) * len * k;
        const cy = ty + Math.sin(a) * len * k * 0.7 + k * k * 18;
        const wdt = 7 * Math.sin(Math.PI * Math.min(1, k * 1.15));
        const nx = -Math.sin(a);
        const ny = Math.cos(a);
        pts.push([cx + nx * wdt, cy + ny * wdt]);
        back.push([cx - nx * wdt, cy - ny * wdt]);
      }
      fillPoly(ctx, [...pts, ...back.reverse()], i % 2 ? T.palmDark : T.palm);
    });
    for (const [dx, dy] of [[-4, 4], [3, 5], [0, 8]]) fillEllipse(ctx, tx + dx, ty + dy, 3.6, 3.6, T.coconut);
    ctx.restore();
  }

  function drawCastleFlags(env) {
    const T = env.theme;
    CASTLE_FLAGS.forEach(([x, top], i) => {
      const pts = [];
      const lower = [];
      const s0 = CASTLE.s;
      for (let s = 0; s <= 5; s++) {
        const k = s / 5;
        const wave = env.reduced ? 0 : Math.sin(env.t * 3.2 + i * 1.3 - k * 3) * 2.2 * k;
        pts.push([x + s0 + k * 20 * s0, top + s0 + wave]);
        lower.push([x + s0 + k * 20 * s0, top + (11 - k * 5) * s0 + wave]);
      }
      fillPoly(ctx, [...pts, ...lower.reverse()], i === 1 ? T.flagAlt : T.flag, T.castleDark, 1);
    });
  }

  // The count pill outside a room place: how many rows are inside, in the first lane's colour, ringed while hovered.
  // It counts every lane the room holds, so the number on the door is the number behind it; the sign above breaks
  // the same total down lane by lane.
  function drawRoomBadge(env, { id, at, lanes }) {
    const st = STATE[lanes[0]] || STATE.recent;
    const n = lanes.reduce((sum, lane) => sum + countOf(lane), 0);
    const [bx, by] = at;
    const text = String(n);
    const ink = pillInk(st);
    ctx.save();
    ctx.font = `700 15px ${FONT}`;
    const w = Math.ceil(34 + ctx.measureText(text).width);
    const h = 26;
    const x0 = bx - w / 2;
    ctx.globalAlpha = n > 0 ? 1 : 0.6;
    if (hoverId === id && scene === 'village') {
      fillRR(ctx, x0 - 4, by - h / 2 - 4, w + 8, h + 8, 17, env.theme.selectInner, env.theme.selectOuter, 2);
    }
    fillRR(ctx, x0 + 1, by - h / 2 + 2, w, h, 13, 'rgba(0, 0, 0, 0.18)');
    fillRR(ctx, x0, by - h / 2, w, h, 13, st.color, st.border, 1.5);
    drawGlyph(ctx, st.glyph, x0 + 14, by, 16, ink, null);
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x0 + 25, by + 0.5);
    ctx.restore();
  }

  // The fire in the cottage room's hearth, on the ambient clock like the hall's torches.
  // The counting room's lamp, where the cottage has its fire: the same warm pool of light, and no flame.
  function drawCountingRoomLamp() {
    const { x, y } = HEARTH;
    const glow = ctx.createRadialGradient(x, y - 70, 6, x, y - 70, 210);
    glow.addColorStop(0, 'rgba(246, 214, 140, 0.34)');
    glow.addColorStop(1, 'rgba(246, 214, 140, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(x - 220, y - 280, 440, 440);
  }

  function drawHearthFire(env) {
    const T = env.theme;
    const { x, y } = HEARTH;
    const f = env.reduced ? 1 : 0.85 + 0.15 * Math.sin(env.t * 7.7 + 1.1) * Math.sin(env.t * 3.3);
    const glow = ctx.createRadialGradient(x, y - 40, 4, x, y - 40, 190);
    glow.addColorStop(0, `rgba(246, 214, 140, ${0.5 * f})`);
    glow.addColorStop(1, 'rgba(246, 214, 140, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(x - 200, y - 240, 400, 400);
    for (const [dx, k] of [[-18, 0.8], [0, 1], [17, 0.7]]) {
      fillEllipse(ctx, x + dx, y - 22 - f * 6 * k, 9 * k * f, 20 * k * f, T.flame);
      fillEllipse(ctx, x + dx, y - 18, 4 * k, 9 * k, T.flameCore);
    }
  }

  function drawPorchLights(env) {
    const clips = new Map(swingRows().map((row) => [Math.round(row.y), porchLightClipX(row.xs)]));
    for (const c of chars.values()) {
      if (c.leaving || c.journey || !poseOf(c.session.lane).lightColumn) continue;
      const clipX = clips.get(Math.round(c.py));
      ctx.save();
      if (clipX != null) {
        ctx.beginPath();
        ctx.rect(clipX, 0, W - clipX, H);
        ctx.clip();
      }
      drawPorchLight(c, env);
      ctx.restore();
    }
  }

  function drawPorchLight(c, env) {
    const esc = isEscalated(c.session, env.epoch);
    const m = BODY[c.feat.shape];
    const k = scaleOf(c);
    if (env.reduced) {
      ctx.beginPath();
      ctx.arc(c.px, c.py - (LEG + m.h / 2) * k, 36 * k, 0, TAU);
      ctx.lineWidth = esc ? 11 : 7;
      ctx.strokeStyle = 'rgba(253, 126, 20, 0.92)';
      ctx.stroke();
      return;
    }
    const fade = clamp((env.t - c.arrivedAt) / 0.5, 0, 1);
    const pulse = 0.7 + 0.3 * Math.sin(TAU * (env.t / 1.6 + c.phase));
    const a = fade * pulse;
    const bw = (esc ? 74 : 46) * k;
    const topY = Math.max(PORCH_CEILING, c.py - 200 * Math.max(1, k));
    const grad = ctx.createLinearGradient(0, topY, 0, c.py + 4);
    grad.addColorStop(0, 'rgba(253, 126, 20, 0)');
    grad.addColorStop(0.5, `rgba(253, 126, 20, ${0.16 * a})`);
    grad.addColorStop(1, `rgba(253, 126, 20, ${0.42 * a})`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(c.px - bw * 0.3, topY);
    ctx.lineTo(c.px + bw * 0.3, topY);
    ctx.lineTo(c.px + bw / 2, c.py + 3);
    ctx.lineTo(c.px - bw / 2, c.py + 3);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = a;
    fillEllipse(ctx, c.px, c.py, bw * 0.72, 11, 'rgba(253, 126, 20, 0.34)');
    if (esc) {
      ctx.beginPath();
      ctx.ellipse(c.px, c.py, bw * 0.95, 15, 0, 0, TAU);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(253, 126, 20, 0.7)';
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // One swing frame per porch row, spanning whoever sits on it; the seats hang from it one per sitter.
  function swingRows() {
    const rows = new Map();
    for (const c of chars.values()) {
      if (c.journey || c.leaving || c.inside || !poseOf(c.session.lane).swings) continue;
      const key = Math.round(c.py);
      if (!rows.has(key)) rows.set(key, { y: c.py, xs: [] });
      rows.get(key).xs.push(c.px);
    }
    for (const row of rows.values()) row.xs.sort((a, b) => a - b);
    return [...rows.values()];
  }

  function drawSwingFrame(row, env) {
    const T = env.theme;
    const { y } = row;
    const { x0, x1, posts, beamY } = swingFrame(row.xs, y);
    ctx.save();
    ctx.lineCap = 'round';
    fillEllipse(ctx, (x0 + x1) / 2, y + 3, (x1 - x0) / 2 + 10, 6, T.shadow);
    for (const x of posts) {
      line(ctx, x - SWING_LEG_SPREAD, y + 3, x, beamY, T.woodDark, 4.5);
      line(ctx, x + SWING_LEG_SPREAD, y + 3, x, beamY, T.woodDark, 4.5);
      line(ctx, x - 4, y - 24, x + 4, y - 24, T.woodDark, 2.5);
    }
    fillRR(ctx, x0 - 10, beamY - 7, x1 - x0 + 20, 9, 3, T.wood, T.woodDark, 1.5);
    // A climbing vine along the beam, with a few flowers.
    for (let x = x0 - 4, i = 0; x <= x1 + 4; x += 15, i++) {
      fillEllipse(ctx, x, beamY - 8 + (i % 2) * 3, 6.5, 4.2, i % 3 ? T.treeDark : T.tree);
      if (i % 4 === 1) fillEllipse(ctx, x + 3, beamY - 10, 2.4, 2.4, T.flowers[(i >> 2) % T.flowers.length]);
    }
    ctx.restore();
  }

  // A sign's lane row: a badge, the lane's word when the board names them, and the count.
  function laneCell(env, lane, x, y, wordW) {
    ctx.globalAlpha = countOf(lane) > 0 ? 1 : 0.45;
    drawBadge(ctx, lane, x + 10, y, 10);
    ctx.textAlign = 'left';
    ctx.fillStyle = env.theme.signText;
    if (wordW) {
      ctx.font = `600 13px ${FONT}`;
      ctx.fillText(fitText(STATE[lane].word, wordW, ctx.font), x + 24, y + 0.5);
    }
    ctx.font = `700 14px ${FONT}`;
    ctx.fillText(String(countOf(lane)), x + 24 + (wordW ? wordW + 6 : 0), y + 0.5);
    ctx.globalAlpha = 1;
  }

  function swingSway(c, env) {
    return env.reduced ? 0 : Math.sin(env.t * 1.05 + c.phase * TAU) * 1.6;
  }

  // Drawn inside the sitter's scale, so the ropes reach up to where the unscaled beam is.
  function drawSwingSeat(c, env) {
    const T = env.theme;
    const x = c.px + swingSway(c, env);
    const y = c.py;
    const beamY = y - SWING_BEAM / (c.size || 1);
    ctx.save();
    ctx.lineCap = 'round';
    const k = SWING_SEAT_HALF - 4;
    for (const side of [-1, 1]) line(ctx, c.px + side * k, beamY + 1, x + side * k, y - 36, T.steel, 1.6);
    fillRR(ctx, x - k - 2, y - 40, 2 * k + 4, 7, 3, T.wood, T.woodDark, 1.2);
    for (const side of [-1, 1]) line(ctx, x + side * k, y - 34, x + side * k, y - 9, T.woodDark, 2.5);
    fillRR(ctx, x - SWING_SEAT_HALF, y - 12, 2 * SWING_SEAT_HALF, 8, 3, T.woodLight, T.woodDark, 1.5);
    ctx.restore();
  }

  function drawDeckChair(c, T) {
    const x = c.px;
    const y = c.py;
    const colors = [T.stripeBase, T.stripes[Math.floor(c.feat.hue / 90) % T.stripes.length]];
    ctx.save();
    ctx.lineCap = 'round';
    const k = c.size || 1;
    if (c.index % 2 === 0 && (c.slotDx || 0) >= 60 * k && umbrellaFits(x, y, k)) {
      const ux = x + 30;
      const uy = y - 84;
      if (T.pack === 'shire') {
        // A mallorn in place of the parasol, on the parasol's own reach: the same 76 px of shade between
        // ux - 35 and ux + 41, with the bole on the right so the crown shades the lounger without standing in it.
        // The crown is cut to the parasol's own box: dx - r no lower than -38 and dx + r no higher than 38 about
        // the bole, and no blob's top above uy - 16, which is where the dome's point was. The rest of the box's
        // height goes to the bole, so the thing reads as a tree rather than as a canopy on a stick.
        const bole = ux + 3;
        line(ctx, bole, y + 4, bole, uy + 20, T.trunk, 5);
        for (const side of [-1, 1]) line(ctx, bole, y + 4, bole + side * 7, y + 4, T.trunk, 3);
        for (const [bx, by2] of [[-16, 6], [15, 4]]) line(ctx, bole, uy + 22, bole + bx, uy + by2, T.trunk, 2.5);
        for (const [dx, dy, r] of [[-25, 12, 12], [26, 12, 11], [0, 14, 14]]) {
          fillEllipse(ctx, bole + dx, uy + dy, r, r * 0.74, T.treeDark);
        }
        for (const [dx, dy, r] of [[-14, -2, 16], [12, 0, 15], [-1, -4, 15]]) {
          fillEllipse(ctx, bole + dx, uy + dy, r, r * 0.74, T.tree);
        }
        fillEllipse(ctx, bole - 9, uy - 6, 7, 5, T.treeLight);
        for (const [dx, dy] of [[-20, 22], [8, 24], [22, 20]]) fillEllipse(ctx, bole + dx, uy + dy, 3.5, 5, T.treeLight);
      } else if (T.pack === 'west') {
        // A brush ramada in place of the parasol, on the parasol's own reach: the same 76 px of shade between
        // ux - 35 and ux + 41, which is what `umbrellaBox` declares and every beach check is laid out around.
        // Flat rather than domed, and posted on the right so the roof shades the lounger without standing in it.
        const roof = uy - 12;
        for (const px of [ux - 2, ux + 38]) fillRR(ctx, px - 2, roof + 13, 4, y + 4 - roof - 13, 1.5, T.woodDark);
        line(ctx, ux - 2, roof + 20, ux - 30, roof + 13, T.woodDark, 2);
        for (let i = 0; i < 9; i++) {
          fillRR(ctx, ux - 35 + i * 8.4, roof, 6.5, 8, 2, i % 2 ? T.thatch : T.thatchDark);
        }
        fillRR(ctx, ux - 35, roof + 7, 76, 6, 2, T.wood, T.woodDark, 1.2);
      } else {
        line(ctx, ux, y + 4, ux + 3, uy, T.woodDark, 2.5);
        const segs = 6;
        for (let i = 0; i < segs; i++) {
          const a0 = Math.PI + (i / segs) * Math.PI;
          const a1 = Math.PI + ((i + 1) / segs) * Math.PI;
          fillPoly(ctx, [[ux + 3, uy - 16], [ux + 3 + Math.cos(a0) * 38, uy + 3 + Math.sin(a0) * 4], [ux + 3 + Math.cos(a1) * 38, uy + 3 + Math.sin(a1) * 4]],
            i % 2 ? colors[1] : T.stripeBase, T.woodDark, 0.8);
        }
        fillEllipse(ctx, ux + 3, uy - 17, 2.5, 2.5, T.woodDark);
      }
    }
    fillEllipse(ctx, x + 3, y + 3, 24, 4.5, T.shadow);
    line(ctx, x - 16, y - 36, x - 20, y + 3, T.woodDark, 2.5);
    line(ctx, x + 16, y - 36, x + 20, y + 3, T.woodDark, 2.5);
    stripedQuad(ctx, [x - 15, y - 50], [x + 15, y - 50], [x + 17, y - 12], [x - 17, y - 12], 5, colors);
    stripedQuad(ctx, [x - 17, y - 12], [x + 17, y - 12], [x + 20, y + 1], [x - 20, y + 1], 5, colors);
    line(ctx, x - 15, y - 50, x + 15, y - 50, T.woodDark, 2.5);
    line(ctx, x - 20, y + 1, x + 20, y + 1, T.woodDark, 2);
    ctx.restore();
  }

  function drawProp(c, env) {
    const T = env.theme;
    const x = c.px;
    const y = c.py;
    switch (c.session.lane) {
      case 'errored':
        fillRR(ctx, x - 25, y - 10, 50, 12, 6, T.woodDark);
        fillEllipse(ctx, x + 21, y - 4, 5, 5.5, T.woodLight);
        fillEllipse(ctx, x + 21, y - 4, 2, 2.2, T.wood);
        break;
      case 'idle':
      case 'recent':
        // Indoors there is no step to sit on: a guest who stops sits on the cottage floor.
        if (!c.inside) fillRR(ctx, x - 21, y - 10, 42, 11, 3, T.stone, T.stoneDark, 1);
        break;
      case 'running':
        ctx.save();
        ctx.lineCap = 'round';
        fillEllipse(ctx, x + 31, y + 1, 22, 4, T.shadow);
        line(ctx, x + 17, y - 22, x + 17, y, T.woodDark, 3);
        line(ctx, x + 45, y - 22, x + 45, y, T.woodDark, 3);
        fillRR(ctx, x + 11, y - 28, 40, 8, 2, T.wood, T.woodDark, 1.5);
        fillRR(ctx, x + 25, y - 36, 16, 8, 2, T.steel, T.stoneDark, 1);
        ctx.restore();
        break;
      case 'valhalla':
        if (!c.inside) drawDeckChair(c, T);
        break;
      case 'your_turn':
        if (!c.inside) drawSwingSeat(c, env);
        break;
      default:
        break;
    }
  }

  function armTo(x1, y1, x2, y2, tint, stroke) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 4.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x2, y2, 3, 0, TAU);
    ctx.fillStyle = tint;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Body bottom above the feet for each pose, without the walk bob or the hop.
  function baseLift(c) {
    if (c.inBoat) return 2;
    if (c.journey) return LEG;
    const lane = c.session.lane;
    if (lane === 'valhalla' && !c.inside) return 12;
    if (poseOf(lane).swings && !c.inside) return SWING_LIFT;
    return poseOf(lane).sits ? 3 : LEG;
  }

  // How far a hat pushes the badge above the body. Written once: drawCharacter paints the badge there and
  // restingGeometry puts the clickable one in the same place, so a change of hat cannot move only one of them.
  function headroom(feat, pack) {
    if (themePack(pack).hatted) return HAT_LIFT;
    return feat.accessory === 'hat' || feat.accessory === 'antenna' ? HAT_LIFT : 0;
  }

  // The waistcoat, the gun belt and the holster, clipped to whatever silhouette the body has: one set of numbers
  // dresses a round, a square and a tall body without a waistcoat hanging off the side of a circle. The waistcoat
  // takes the body's own edge colour and the hat the look's accent, both of which the palette already holds clear
  // of every body, so the kit adds no colour that would have to be cleared against twelve of them.
  function drawWestKit(x, top, m, shape, tint, edge, T) {
    const K = WEST_KIT;
    const bottom = top + m.h;
    ctx.save();
    ctx.beginPath();
    if (shape === 'round') ctx.ellipse(x, top + m.h / 2, m.w / 2, m.h / 2, 0, 0, TAU);
    else rr(ctx, x - m.w / 2, top, m.w, m.h, shape === 'tall' ? m.w / 2 : 9);
    ctx.clip();
    const collarY = top + m.h * K.collar;
    ctx.fillStyle = edge;
    ctx.fillRect(x - m.w / 2, collarY, m.w, bottom - collarY);
    // The opening down the front, in the body's own colour, meeting at the lapel point.
    fillPoly(ctx, [
      [x - m.w * 0.30, collarY], [x + m.w * 0.30, collarY], [x, top + m.h * K.lapel],
    ], tint);
    const beltY = top + m.h * K.belt;
    ctx.fillStyle = T.woodDark;
    ctx.fillRect(x - m.w / 2, beltY, m.w, K.beltH);
    fillRR(ctx, x - 4, beltY - 0.5, 8, K.beltH + 1, 1.5, T.steel);
    // The holster on the near hip, and the revolver's butt above the belt where nothing trims it.
    const hx = x + m.w * 0.26;
    fillRR(ctx, hx - 3.5, beltY + K.beltH - 0.5, 7, 8, 2, T.woodDark);
    fillRR(ctx, hx - 2.2, beltY - 4.5, 4.4, 5, 1.5, T.steel);
    ctx.restore();
  }

  // Curly hair over the crown, pointed ears at the temples and a waistcoat: clipped to the body's own silhouette,
  // so one set of numbers dresses a round, a square and a tall body. Hair and waistcoat take the body's edge
  // colour and the buttons its accent, both of which the palette already holds clear of every body.
  function drawShireKit(x, top, m, shape, tint, edge, accent, eyeY, waistcoat) {
    const K = SHIRE_KIT;
    const bottom = top + m.h;
    const half = m.w / 2;
    ctx.save();
    ctx.beginPath();
    if (shape === 'round') ctx.ellipse(x, top + m.h / 2, half, m.h / 2, 0, 0, TAU);
    else rr(ctx, x - half, top, m.w, m.h, shape === 'tall' ? half : 9);
    ctx.clip();
    // A row of curls across the crown, and two more tucked behind the ears.
    for (let i = 0; i < K.hairRows; i += 1) {
      const t = i / (K.hairRows - 1);
      fillEllipse(ctx, x - half + 2 + t * (m.w - 4), top + 5 + Math.sin(t * Math.PI) * -2, 6, 5.5, edge);
    }
    fillEllipse(ctx, x - half + 3, top + 13, 5, 6, edge);
    fillEllipse(ctx, x + half - 3, top + 13, 5, 6, edge);
    // The waistcoat, below the lowest mouth of the three shapes, with its two buttons. A deck chair and a boat's
    // gunwale both cut across it, so a lounger and a passenger go without, the way the frontier belt does.
    if (waistcoat) {
      const collarY = top + m.h * K.collar;
      ctx.fillStyle = edge;
      ctx.fillRect(x - half, collarY, m.w, bottom - collarY);
      fillPoly(ctx, [[x - m.w * 0.28, collarY], [x + m.w * 0.28, collarY], [x, top + m.h * K.lapel]], tint);
      fillEllipse(ctx, x - 5, top + m.h * 0.86, 2, 2, accent);
      fillEllipse(ctx, x + 5, top + m.h * 0.86, 2, 2, accent);
    }
    ctx.restore();
    // The ears sit outside the silhouette, so they are drawn after the clip is lifted. They tip at exactly what
    // the character's own box allows either side, and no further.
    for (const side of [-1, 1]) {
      const base = x + side * (half - 1);
      fillPoly(ctx, [
        [base, eyeY + 4], [base, eyeY - 5], [x + side * K.earTip, eyeY - 9],
      ], tint, edge, 1.2);
    }
  }

  // A hobbit's feet, on the legs' own footing and inside the 9 px either side the leg box declares.
  function drawShireFeet(x, y, edge) {
    for (const side of [-1, 1]) {
      fillEllipse(ctx, x + side * 5.5, y - 1.5, 3.5, 3, edge);
      line(ctx, x + side * 4, y - 4.5, x + side * 4.5, y - 6.5, edge, 1.2);
      line(ctx, x + side * 7, y - 4.5, x + side * 7, y - 6.5, edge, 1.2);
    }
  }

  // Pinned on the waistcoat, and painted after the arms: the near arm swings straight through the lapel it sits on.
  // Body colour inside the body's own edge colour, the one pair the palette guarantees reads, whatever the repo.
  function drawSheriffStar(cx, cy, r, tint, edge) {
    const pts = [];
    for (let i = 0; i < 10; i += 1) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const d = i % 2 ? r * 0.44 : r;
      pts.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d]);
    }
    fillPoly(ctx, pts, tint, edge, 1.2);
  }

  function drawCharacter(c, env) {
    const { t, theme: T, reduced } = env;
    const s = c.session;
    const lane = s.lane;
    const st = STATE[lane] || STATE.recent;
    const f = c.feat;
    const m = BODY[f.shape];
    const moving = !!c.journey || (!!c.inside && !!c.walking && !reduced);
    const walking = moving && (!!c.walkingNow || !!c.inside);
    const inBoat = !!c.inBoat;
    const lounging = !moving && lane === 'valhalla' && !c.inside;
    const pose = poseOf(lane);
    const sitting = inBoat || lounging || (!moving && pose.sits);
    // Hall guests carry their margarita as they wander and only sip while standing still.
    const sipping = SIPPING_LANES.has(lane) && (!moving || !!c.inside);
    const x = c.px;
    const y = c.py;

    let lift = 0;
    if (!reduced && walking) lift = -Math.abs(Math.sin(c.stride * Math.PI)) * 3;
    if (!reduced && inBoat) lift = Math.sin(t * 2.2 + c.phase * 6) * 1.2;
    if (!reduced && !moving && lane === 'needs_you' && isEscalated(s, env.epoch)) {
      const cyc = (t + c.phase * WAVE_PERIOD) % WAVE_PERIOD;
      if (cyc >= 0.75 && cyc < 1.35) lift = -Math.abs(Math.sin(((cyc - 0.75) / 0.3) * Math.PI)) * 10;
    }
    const bottom = y - baseLift(c) + lift;
    const top = bottom - m.h;
    const colour = c.colour || NO_REPO_COLOUR;
    const dusk = T.night;
    const tint = dusk ? colour.dark : colour.light;
    const edge = dusk ? colour.darkEdge : colour.lightEdge;
    const ink = colour.ink || T.ink;
    const glint = ink === INK_LIGHT ? tint : '#ffffff';

    ctx.save();
    if (c.alpha < 1) ctx.globalAlpha = clamp(c.alpha, 0, 1);
    if (st.dim && !moving) ctx.globalAlpha *= 0.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (!moving) drawProp(c, env);
    if (!inBoat) fillEllipse(ctx, x, y, m.w * 0.55 + lift * 0.4, 5 + lift * 0.1, T.shadow);
    // The sitter rocks with the swing seat; the badge and plate hold still, as hit testing does.
    if (!moving && pose.swings && !c.inside) ctx.translate(swingSway(c, env), 0);

    const swing = walking && !reduced ? Math.sin(c.stride * TAU) : 0;
    if (lounging) {
      fillEllipse(ctx, x - 8, y - 2, 5.5, 3.4, edge);
      fillEllipse(ctx, x + 8, y - 2, 5.5, 3.4, edge);
    } else if (sitting && !inBoat) {
      fillEllipse(ctx, x - 7, y - 1, 5.5, 3.4, edge);
      fillEllipse(ctx, x + 7, y - 1, 5.5, 3.4, edge);
    } else if (!inBoat) {
      ctx.strokeStyle = edge;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(x - 6, bottom - 3);
      ctx.lineTo(x - 6 + swing * 4, y - 1 + lift);
      ctx.moveTo(x + 6, bottom - 3);
      ctx.lineTo(x + 6 - swing * 4, y - 1 + lift);
      ctx.stroke();
      if (env.pack === 'shire' && !walking) drawShireFeet(x, y - 1 + lift, edge);
    }

    ctx.beginPath();
    if (f.shape === 'round') ctx.ellipse(x, top + m.h / 2, m.w / 2, m.h / 2, 0, 0, TAU);
    else rr(ctx, x - m.w / 2, top, m.w, m.h, f.shape === 'tall' ? m.w / 2 : 9);
    ctx.fillStyle = tint;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = edge;
    ctx.stroke();
    fillEllipse(ctx, x, top + m.h * 0.7, m.w * 0.26, m.h * 0.15, 'rgba(255, 255, 255, 0.3)');
    // Everyone in the frontier town is hatted, which is what `headroom` lifts every badge by: a look left
    // bare-headed here would hang its badge over a gap. The waistcoat and the belt are the part a deck chair or a
    // boat's gunwale cuts through, so those two alone are what a lounger and a passenger go without.
    const westHat = env.west;
    const westKit = westHat && !inBoat && !lounging;
    if (westKit) drawWestKit(x, top, m, f.shape, tint, edge, T);
    // The same rule for the Shire: a waistcoat is what a deck chair or a gunwale cuts across, the hair and the
    // ears are not, so the two are gated apart.
    const shire = env.pack === 'shire';
    const shireKit = shire && !inBoat && !lounging;

    const shY = top + m.h * 0.56;
    const leftX = x - m.w / 2 + 1;
    const rightX = x + m.w / 2 - 1;
    let glass = null;
    let passport = null;
    if ((!sitting || lane === 'errored') && !lounging) {
      const a = Math.PI * 0.64 + swing * 0.45;
      armTo(leftX, shY, leftX + Math.cos(a) * 9, shY + Math.sin(a) * 9, tint, edge);
    } else {
      armTo(leftX, shY, leftX + 3, shY + 9, tint, edge);
    }
    if (c.gate && c.gate.local < STAMP_S) {
      // Holding the passport out to the guard, kept short of the guard however big the holder is. It comes down once
      // stamped, before the barrier lifts, since the rising pole sweeps through where it was held.
      const at = passportPoint(c);
      armTo(rightX, shY, at.local.x - 5, at.local.y + 1, tint, edge);
      passport = { ...at.local, stamped: c.gate.stamped };
    } else if (!moving && pose.waves) {
      const cyc = (t + c.phase * WAVE_PERIOD) % WAVE_PERIOD;
      let a = -1.05;
      if (!reduced && cyc < 0.7) a += Math.sin((cyc / 0.7) * Math.PI * 3) * 0.5;
      armTo(rightX, shY - 2, rightX + Math.cos(a) * 15, shY - 2 + Math.sin(a) * 15, tint, edge);
    } else if (!moving && lane === 'running') {
      const a = reduced ? -0.9 : hammerAngle(hammerPhase(t, c.phase));
      const hx = rightX + Math.cos(a) * 12;
      const hy = shY + Math.sin(a) * 12;
      const ex = hx + Math.cos(a) * 12;
      const ey = hy + Math.sin(a) * 12;
      line(ctx, hx, hy, ex, ey, T.woodDark, 3);
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(a);
      fillRR(ctx, -3.5, -6.5, 8, 13, 2, T.steel, T.stoneDark, 1);
      ctx.restore();
      armTo(rightX, shY, hx, hy, tint, edge);
    } else if (!moving && lane === 'stopped') {
      const sx = x + m.w / 2 + 16;
      line(ctx, sx, bottom - 1, sx, top - 8, T.woodDark, 3);
      fillRR(ctx, sx - 12, top - 28, 24, 21, 4, OUTLINE_FILL, STATE.stopped.color, 2.5);
      fillRR(ctx, sx - 6, top - 23, 4, 11, 1, OUTLINE_GLYPH);
      fillRR(ctx, sx + 2, top - 23, 4, 11, 1, OUTLINE_GLYPH);
      armTo(rightX, shY, sx - 2, top + m.h * 0.3, tint, edge);
    } else if (sipping) {
      const k = reduced || moving ? 0 : sipAmount(t, c.phase);
      const hx = lerp(rightX + 8, x + 5, k);
      const hy = lerp(shY + 5, top + m.h * 0.42, k);
      armTo(rightX, shY, hx, hy, tint, edge);
      glass = { x: hx + 1, y: hy - 2, tilt: -0.55 * k };
    } else if (sitting && lane !== 'errored') {
      armTo(rightX, shY, rightX - 3, shY + 9, tint, edge);
    } else {
      const a = Math.PI * 0.36 - swing * 0.45;
      armTo(rightX, shY, rightX + Math.cos(a) * 9, shY + Math.sin(a) * 9, tint, edge);
    }
    if (westKit && f.accessory === 'antenna') {
      drawSheriffStar(x - m.w * 0.17, top + m.h * WEST_KIT.star, 4.2, tint, edge);
    }

    const eyeY = top + m.h * (f.shape === 'tall' ? 0.3 : 0.4);
    const gap = Math.max(5, m.w * 0.19);
    let look = walking || inBoat || c.gate ? clamp(c.dir, -1, 1) * 2.5 : 0;
    // The harbour queue keeps an eye on the barrier.
    if (!moving && lane === 'open_pr') look = Math.sign(PIER.x - x) * 1.5;
    const blink = lane === 'idle' && !moving && !reduced
      && ((t + c.phase * 9) % (2.8 + (c.phase * 23) % 2.4)) < 0.14;
    const closed = (lane === 'recent' && !moving) || blink;
    fillEllipse(ctx, x - gap - 3, eyeY + 6, 3, 2, 'rgba(214, 140, 132, 0.35)');
    fillEllipse(ctx, x + gap + 3, eyeY + 6, 3, 2, 'rgba(214, 140, 132, 0.35)');
    if (lounging) {
      // Sunglasses on the beach, rimmed in the face ink so they show on a dark body too.
      const rim = ink === INK_LIGHT ? ink : null;
      fillRR(ctx, x - gap - 5.5, eyeY - 3.5, 11, 7, 3, INK_DARK, rim, 1.2);
      fillRR(ctx, x + gap - 5.5, eyeY - 3.5, 11, 7, 3, INK_DARK, rim, 1.2);
      line(ctx, x - gap + 5, eyeY - 1.5, x + gap - 5, eyeY - 1.5, ink, 1.6);
      line(ctx, x - gap - 3, eyeY - 1.5, x - gap - 1, eyeY - 2.5, 'rgba(255, 255, 255, 0.5)', 1.2);
      line(ctx, x + gap - 3, eyeY - 1.5, x + gap - 1, eyeY - 2.5, 'rgba(255, 255, 255, 0.5)', 1.2);
    } else if (closed) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(x - gap + look, eyeY - 1, 2.6, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.moveTo(x + gap + look + 2.5, eyeY);
      ctx.arc(x + gap + look, eyeY - 1, 2.6, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    } else {
      fillEllipse(ctx, x - gap + look, eyeY, 2.4, 2.8, ink);
      fillEllipse(ctx, x + gap + look, eyeY, 2.4, 2.8, ink);
      fillEllipse(ctx, x - gap + look + 0.8, eyeY - 1, 0.8, 0.8, glint);
      fillEllipse(ctx, x + gap + look + 0.8, eyeY - 1, 0.8, 0.8, glint);
    }
    if (f.accessory === 'glasses' && !lounging) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x - gap + look, eyeY, 4.8, 0, TAU);
      ctx.moveTo(x + gap + look + 4.8, eyeY);
      ctx.arc(x + gap + look, eyeY, 4.8, 0, TAU);
      ctx.moveTo(x - gap + look + 4.8, eyeY);
      ctx.lineTo(x + gap + look - 4.8, eyeY);
      ctx.stroke();
    }

    const mouthY = eyeY + (f.shape === 'tall' ? 9 : 8);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    if (!moving && lane === 'needs_you') {
      fillEllipse(ctx, x + look, mouthY + 1, 2.4, 3, ink);
    } else if (!moving && lane === 'running') {
      ctx.moveTo(x - 3 + look, mouthY + 1);
      ctx.lineTo(x + 3 + look, mouthY + 1);
      ctx.stroke();
    } else if (!moving && lane === 'errored') {
      ctx.arc(x + look, mouthY + 4, 3.5, 1.2 * Math.PI, 1.8 * Math.PI);
      ctx.stroke();
    } else if (!moving && lane === 'recent') {
      fillEllipse(ctx, x + look, mouthY + 1, 1.6, 1.4, ink);
    } else {
      const big = (!moving && (lane === 'open_pr' || sipping)) || inBoat ? 4.2 : 3.2;
      ctx.arc(x + look, mouthY - 1, big, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }

    const accent = accentFor(colour, f.hue);
    if (shire) drawShireKit(x, top, m, f.shape, tint, edge, accent, eyeY, shireKit);
    if (westHat) {
      // The five looks tell five sessions of one repo apart as trimmings instead: the star (with the kit, above),
      // a bandana, a feather in the hatband, glasses (drawn with the face), or the hat alone.
      const K = WEST_KIT;
      const seat = top + (f.shape === 'round' ? K.seatRound : K.seat);
      // The crown's top is one HAT_LIFT plus the brim's own thickness above the body, whatever the brim sits on, so
      // every shape lifts its badge by the same amount. A round body is a point at its top edge, which is why the
      // brim sits lower there and the crown grows to meet it rather than hovering over the gap.
      const crownY = top - HAT_LIFT - 2;
      const crownW = m.w * K.crownW;
      fillRR(ctx, x - crownW / 2, crownY, crownW, seat - crownY, 4, accent);
      fillEllipse(ctx, x, seat, m.w * K.brimRX, K.brimRY, accent);
      fillRR(ctx, x - crownW / 2, seat - 5.5, crownW, 4, 1.5, edge);
      if (f.accessory === 'hat') {
        fillPoly(ctx, [[x - crownW / 2 + 1, seat - 4], [x - crownW / 2 - 5, crownY + 1], [x - crownW / 2 + 4, seat - 5]], tint, edge, 1);
      } else if (f.accessory === 'scarf' && westKit) {
        fillRR(ctx, x - m.w / 2 - 1, top + m.h * 0.56, m.w + 2, 5, 2.5, accent);
        fillPoly(ctx, [[x - 7, top + m.h * 0.60], [x + 7, top + m.h * 0.60], [x, top + m.h * 0.74]], accent, edge, 1);
      }
    } else if (f.accessory === 'hat') {
      fillEllipse(ctx, x, top + 2, m.w * 0.56, 3.8, accent);
      fillRR(ctx, x - m.w * 0.3, top - 11, m.w * 0.6, 13, 5, accent);
      line(ctx, x - m.w * 0.3 + 1, top - 1.5, x + m.w * 0.3 - 1, top - 1.5, 'rgba(255, 255, 255, 0.35)', 2);
    } else if (f.accessory === 'scarf') {
      fillRR(ctx, x - m.w / 2 - 1, top + m.h * 0.62, m.w + 2, 6, 3, accent);
      fillRR(ctx, x + m.w * 0.12, top + m.h * 0.62 + 3, 6, 13, 2, accent);
    } else if (f.accessory === 'antenna') {
      line(ctx, x, top + 1, x + 4, top - 10, edge, 2);
      fillEllipse(ctx, x + 4, top - 11, 3.4, 3.4, accent);
    }

    c.badgeY = top - 19 - headroom(f, env.pack);
    if (glass) drawMargarita(ctx, T, glass.x, glass.y, glass.tilt);
    if (passport) drawPassport(passport, T);

    if (!moving && lane === 'your_turn' && (c.inside || (c.slotDx || 0) >= BUBBLE_MIN_DX * (c.size || 1))) {
      const bob = reduced ? 0 : Math.sin((t + c.phase * 3) * 2.2) * 2;
      const bx = x + m.w / 2 + 4;
      const by = top - 2 + bob;
      fillPoly(ctx, [[bx + 5, by - 2], [bx + 1, by + 6], [bx + 13, by - 2]], T.bubble, STATE.your_turn.color, 2);
      fillRR(ctx, bx, by - 20, 36, 19, 9, T.bubble, STATE.your_turn.color, 2);
      for (let i = 0; i < 3; i++) {
        const hop = reduced ? 0 : Math.max(0, Math.sin(t * 4 - i * 0.8)) * 1.6;
        fillEllipse(ctx, bx + 10 + i * 8, by - 10.5 - hop, 2.1, 2.1, '#5c4400');
      }
    } else if (!moving && lane === 'recent') {
      const cyc = reduced ? 0.45 : (t * 0.4 + c.phase) % 1;
      ctx.globalAlpha *= reduced ? 1 : Math.sin(cyc * Math.PI);
      ctx.fillStyle = T.ink;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `700 ${Math.round(11 + cyc * 6)}px ${FONT}`;
      ctx.fillText('z', x + m.w / 2 + 2 + cyc * 7, top + 4 - cyc * 16);
    } else if (!moving && lane === 'errored' && reduced) {
      ctx.globalAlpha *= 0.5;
      const rgb = `rgb(${theme.smoke})`;
      fillEllipse(ctx, x + m.w / 2 + 6, top, 5, 4.5, rgb);
      fillEllipse(ctx, x + m.w / 2 + 12, top - 7, 6.5, 5.5, rgb);
      fillEllipse(ctx, x + m.w / 2 + 19, top - 15, 8, 7, rgb);
    }
    ctx.restore();
  }

  // Where a character at the gate holds its passport out to the guard, in its own unscaled drawing and in the scene.
  // Its far edge (the passport is 14 wide, and grows with the holder) stays short of the guard's cap at any size.
  function passportPoint(c) {
    const m = BODY[c.feat.shape];
    const k = scaleOf(c);
    const x = c.px;
    const y = c.py;
    const shY = y - LEG - m.h + m.h * 0.56;
    const local = { x: Math.min(x + m.w / 2 + 9, x + (GUARD.x - 20 - 7 * k - x) / k), y: shY + 12 };
    return { local, world: { x: x + (local.x - x) * k, y: y + (local.y - y) * k } };
  }

  // A character drawn at its scale about its feet.
  function drawScaled(c, env) {
    const k = scaleOf(c);
    if (Math.abs(k - 1) < 1e-6) {
      drawCharacter(c, env);
      return;
    }
    ctx.save();
    ctx.translate(c.px, c.py);
    ctx.scale(k, k);
    ctx.translate(-c.px, -c.py);
    drawCharacter(c, env);
    ctx.restore();
  }

  // What the guard is doing this frame: stamping a passport (p through STAMP_S), waving while the barrier is up.
  function patrolFrame(t) {
    const lift = barrierLift(barrierPlan(), t);
    let stamp = null;
    if (!reduced) {
      for (const c of chars.values()) {
        const g = c.gate;
        if (!g || g.mode !== 'stamp' || g.local >= STAMP_S) continue;
        stamp = { p: g.local / STAMP_S, target: passportPoint(c).world };
        break;
      }
    }
    return { lift, stamp, wave: lift > 0.02 && !stamp };
  }

  // A small V of foam trailing from the stern, opening away from the way the boat is heading.
  function drawWake(b, env) {
    const len = Math.hypot(b.hx || 0, b.hy || 0);
    if (env.reduced || !b.sail || len < 1e-6) return;
    const hx = b.hx / len;
    const hy = b.hy / len;
    const sx = b.x - hx * 34;
    const sy = b.y + 12 - hy * 8;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = env.theme.foam;
    for (const side of [-1, 1]) {
      const ex = sx - hx * 30 + side * -hy * 12;
      const ey = sy - hy * 14 + side * hx * 5;
      ctx.globalAlpha = 0.7;
      line(ctx, sx, sy, ex, ey, env.theme.foam, 2.2);
      ctx.globalAlpha = 0.4;
      line(ctx, ex, ey, ex - hx * 14 + side * -hy * 6, ey - hy * 7 + side * hx * 3, env.theme.foam, 1.6);
    }
    const pulse = 0.5 + 0.5 * Math.sin(env.t * 6);
    ctx.globalAlpha = 0.35 + 0.25 * pulse;
    fillEllipse(ctx, sx - hx * 8, sy - hy * 4, 7, 2.4, env.theme.foam);
    ctx.restore();
  }

  function drawVoyageBoat(c, env, part) {
    const b = c.boat;
    if (!b) return;
    const bob = env.reduced ? 0 : Math.sin(env.t * 2.2 + c.phase * 6) * 1.5;
    ctx.save();
    if (c.alpha < 1) ctx.globalAlpha = clamp(c.alpha, 0, 1);
    if (part === 'back') drawWake(b, env);
    drawRowboat(ctx, env.theme, b.x, b.y + 4 + bob, { s: BOAT_SCALE, dir: b.dir || 1, sail: b.sail, part, tilt: env.reduced ? 0 : Math.sin(env.t * 1.7) * 0.03 });
    ctx.restore();
  }

  function drawFerry(b, env) {
    ctx.save();
    ctx.globalAlpha = clamp(b.alpha, 0, 1);
    drawWake(b, env);
    const bob = env.reduced ? 0 : Math.sin(env.t * 2.2 + b.x * 0.01) * 1.5;
    drawRowboat(ctx, env.theme, b.x, b.y + 4 + bob, { s: BOAT_SCALE, dir: b.dir || 1, sail: b.sail, tilt: env.reduced ? 0 : Math.sin(env.t * 1.7) * 0.03 });
    ctx.restore();
  }

  // The scale a character is drawn at: its token size, times the crowd scale for a hall guest.
  function scaleOf(c) {
    return (c.inside ? c.k || 1 : 1) * (c.size || 1);
  }

  // A badge grows with its character's token size; in the hall it shrinks with a big crowd but never grows past it.
  function badgeRadius(c) {
    const size = c.size || 1;
    return c.inside ? Math.max(8, BADGE_R * Math.min(1, c.k || 1) * size) : BADGE_R * size;
  }

  function badgeOf(c) {
    if (c.badgeY === undefined) return null;
    return { x: c.px, y: c.py + (c.badgeY - c.py) * scaleOf(c), r: badgeRadius(c) };
  }

  // A small open passport held out at the gate, with the guard's stamp on it once it has come down.
  function drawPassport(p, T) {
    fillRR(ctx, p.x - 7, p.y - 5, 14, 10, 1.5, T.patrolNavy);
    fillRR(ctx, p.x - 6, p.y - 4, 5.5, 8, 1, T.patrolWhite);
    fillRR(ctx, p.x + 0.5, p.y - 4, 5.5, 8, 1, T.patrolWhite);
    if (p.stamped) {
      ctx.beginPath();
      ctx.arc(p.x + 3.25, p.y, 2.2, 0, TAU);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = T.patrolNavy;
      ctx.stroke();
    }
  }

  // The striped barrier across the pier, lifted about its post by `lift` (0 down, 1 straight up).
  function drawBarrier(env, lift) {
    const T = env.theme;
    const { pivotX, tipX, y } = BARRIER;
    ctx.save();
    ctx.lineCap = 'round';
    fillRR(ctx, tipX - 2, y - 4, 4, 14, 1.5, T.patrolNavy);
    fillEllipse(ctx, pivotX, y + 9, 8, 2.5, T.shadow);
    fillRR(ctx, pivotX - 4, y - 18, 8, 28, 2, T.patrolWhite, T.patrolNavy, 1.5);
    fillRR(ctx, pivotX - 5, y - 20, 10, 5, 1.5, T.patrolNavy);
    ctx.translate(pivotX, y - 2);
    ctx.rotate(clamp(lift, 0, 1) * Math.PI / 2);
    const len = pivotX - tipX;
    fillRR(ctx, -len, -3, len + 3, 6, 3, T.patrolWhite, T.patrolNavy, 1.2);
    for (let i = 0; i < len - 4; i += 12) fillRR(ctx, -len + i + 2, -2, 6, 4, 1, T.patrolNavy);
    ctx.restore();
  }

  // The guard: khaki uniform, navy cap and trousers, a white badge. It stamps a passport at the gate, waves walkers
  // through while the barrier is up, and otherwise stands blinking and glancing at the queue on the ambient clock.
  function drawGuard(env, state) {
    const T = env.theme;
    const { x, y } = GUARD;
    const t = env.t;
    const still = env.reduced;
    const breathe = still ? 0 : Math.sin(t * 1.6) * 0.6;
    const w = 30;
    const h = 38;
    const bottom = y - 6;
    const top = bottom - h + breathe;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (hoverId === PATROL_ID && scene === 'village') {
      ctx.beginPath();
      ctx.ellipse(x, y, 30, 12, 0, 0, TAU);
      ctx.lineWidth = 6;
      ctx.strokeStyle = T.selectOuter;
      ctx.stroke();
      ctx.lineWidth = 3;
      ctx.strokeStyle = T.selectInner;
      ctx.stroke();
    }
    fillEllipse(ctx, x, y, 18, 4.5, T.shadow);
    const grey = env.pack === 'shire';
    line(ctx, x - 5, bottom - 2, x - 6, y - 1, T.patrolNavy, 5);
    line(ctx, x + 5, bottom - 2, x + 6, y - 1, T.patrolNavy, 5);
    if (grey) {
      // A robe that widens to the ground, a staff, a hat and a beard, all inside GUARD_BOX: the box reaches 60
      // above the feet and 18 either side, and the hat's point stops at 58 and the staff at 17.
      fillPoly(ctx, [
        [x - w / 2 + 3, top], [x + w / 2 - 3, top], [x + w / 2 + 1, y - 1], [x - w / 2 - 1, y - 1],
      ], T.patrolKhaki, T.patrolKhakiShade, 2);
      // A cord at the waist, not a uniform belt: the navy band read as one more piece of kit.
      line(ctx, x - w / 2 + 2, top + h * 0.74, x + w / 2 - 2, top + h * 0.72, T.patrolKhakiShade, 2.5);
    } else {
      fillRR(ctx, x - w / 2, top, w, h, 10, T.patrolKhaki, T.patrolKhakiShade, 2);
      fillRR(ctx, x - w / 2 + 1, top + h * 0.7, w - 2, 4, 1, T.patrolNavy);
      // The badge: a small white shield on the chest.
      fillPoly(ctx, [[x + 3, top + 12], [x + 10, top + 12], [x + 10, top + 17], [x + 6.5, top + 21], [x + 3, top + 17]], T.patrolWhite, T.patrolNavy, 1);
    }

    const shY = top + h * 0.5;
    const leftX = x - w / 2 + 1;
    const rightX = x + w / 2 - 1;
    const armTone = (x2, y2) => armTo(leftX, shY, x2, y2, T.patrolKhaki, T.patrolKhakiShade);
    let stampHand = null;
    if (state.stamp) {
      const { p, target } = state.stamp;
      const rest = { x: leftX - 1, y: shY + 9 };
      const up = { x: leftX - 6, y: top - 4 };
      const at = target ? { x: Math.min(target.x + 3, leftX - 2), y: target.y - 4 } : { x: leftX - 10, y: shY - 4 };
      let hand = rest;
      const mix = (a, b, k) => ({ x: lerp(a.x, b.x, easeInOut(k)), y: lerp(a.y, b.y, easeInOut(k)) });
      if (p < 0.3) hand = mix(rest, up, p / 0.3);
      else if (p < STAMP_STRIKE) hand = mix(up, at, (p - 0.3) / (STAMP_STRIKE - 0.3));
      else if (p < 0.6) hand = at;
      else hand = mix(at, rest, Math.min(1, (p - 0.6) / 0.4));
      armTone(hand.x, hand.y);
      stampHand = hand;
      if (p >= STAMP_STRIKE && p < STAMP_STRIKE + 0.12) {
        ctx.globalAlpha = 1 - (p - STAMP_STRIKE) / 0.12;
        for (const a of [-2.4, -1.6, -0.8]) line(ctx, at.x - 2 + Math.cos(a) * 7, at.y + Math.sin(a) * 7, at.x - 2 + Math.cos(a) * 11, at.y + Math.sin(a) * 11, T.patrolNavy, 1.4);
        ctx.globalAlpha = 1;
      }
    } else {
      armTone(leftX - 1, shY + 9);
    }
    if (state.wave) {
      const a = -1.2 + (still ? 0 : Math.sin(t * 9) * 0.35);
      armTo(rightX, shY - 2, rightX + Math.cos(a) * 14, shY - 2 + Math.sin(a) * 14, T.patrolKhaki, T.patrolKhakiShade);
    } else {
      armTo(rightX, shY, rightX + 3, shY + 9, T.patrolKhaki, T.patrolKhakiShade);
    }
    if (stampHand) {
      fillRR(ctx, stampHand.x - 3.5, stampHand.y + 2, 7, 4, 1, T.patrolNavy);
      fillRR(ctx, stampHand.x - 1.5, stampHand.y - 4, 3, 6, 1, T.patrolKhakiShade);
    }

    if (grey) {
      // The beard, before the face, so the eyes land above it rather than on it. It is broad and it is most of
      // his height: a narrow wedge under the chin read as a cravat, which is what made him nobody in particular.
      fillPoly(ctx, [
        [x - 11, top + 17], [x + 11, top + 17], [x + 10, top + 27], [x + 6, top + 35],
        [x, top + 38], [x - 6, top + 35], [x - 10, top + 27],
      ], T.patrolWhite, T.patrolKhakiShade, 1.2);
      // Hair falling either side of it, from under where the brim will go.
      for (const hx of [-12, 12]) fillPoly(ctx, [[x + hx, top + 6], [x + hx * 1.15, top + 22], [x + hx * 0.55, top + 20]], T.patrolWhite);
    }
    // Face, looking left at the pier; now and then a glance up the deck at the queue, and a blink.
    const glance = !still && (t % 6.2) > 4.6 ? -1.5 : 0;
    const lookX = state.stamp || state.wave ? -2 : -1.5;
    const eyeY = top + h * 0.38 + glance * 0.5;
    const blink = !still && ((t + 0.4) % 4.3) < 0.14;
    if (blink) {
      line(ctx, x - 7 + lookX, eyeY, x - 3 + lookX, eyeY, INK_DARK, 1.6);
      line(ctx, x + 3 + lookX, eyeY, x + 7 + lookX, eyeY, INK_DARK, 1.6);
    } else {
      fillEllipse(ctx, x - 5 + lookX, eyeY, 2.2, 2.6, INK_DARK);
      fillEllipse(ctx, x + 5 + lookX, eyeY, 2.2, 2.6, INK_DARK);
    }
    line(ctx, x - 3 + lookX, top + h * 0.58, x + 2 + lookX, top + h * 0.58, INK_DARK, 1.6);
    if (grey) {
      // The hat goes on last, over the face, which is the only order that reads: a brim drawn under the eyes is
      // a collar. The peaked cap below used to be drawn over this one, point and all.
      const brows = () => {
        for (const bx of [-6, 4]) line(ctx, x + bx - 2.5, top + 11.5, x + bx + 2.5, top + 10.5, T.patrolWhite, 2.6);
      };
      brows();
      // Crown: a tall cone falling back off the brim, curved rather than straight, which is what makes it floppy.
      ctx.beginPath();
      ctx.moveTo(x - 10, top + 5);
      ctx.quadraticCurveTo(x - 7, top - 9, x + 4, top - 16);
      ctx.quadraticCurveTo(x + 1, top - 5, x + 9, top + 5);
      ctx.closePath();
      ctx.fillStyle = T.patrolKhakiShade;
      ctx.fill();
      ctx.strokeStyle = T.patrolNavy;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      // Brim: wider than his shoulders, and drooping at the front where he is looking.
      fillEllipse(ctx, x - 1, top + 6, 16, 5, T.patrolKhakiShade, T.patrolNavy, 1.4);
      fillEllipse(ctx, x - 9, top + 7.5, 8, 3, T.patrolKhakiShade, T.patrolNavy, 1.2);
      // The staff last of all, in front of the robe and across the brim: behind them it was covered end to end
      // and only its head showed, which read as a lamp post standing beside him.
      strokePolyline(ctx, [[x - 15, y - 1], [x - 16, top + 18], [x - 15, top], [x - 16, top - 10]], T.patrolNavy, 3.5);
      for (const [kx, ky, kr] of [[-16, -12, 3.4], [-12.5, -14, 2.2], [-17, -8, 2.2]]) {
        fillEllipse(ctx, x + kx, top + ky, kr, kr * 0.9, T.patrolNavy);
      }
      fillEllipse(ctx, x - 15.5, top - 11.5, 2, 1.8, T.patrolWhite);
      // The hand that holds it, where the arms put it.
      fillEllipse(ctx, x - 15, top + 27, 3.4, 3.4, T.patrolKhaki, T.patrolKhakiShade, 1.2);
      ctx.restore();
      return;
    }
    // Cap: a navy crown with a white badge, and its peak towards the pier.
    fillRR(ctx, x - 13, top - 9, 26, 12, 5, T.patrolNavy);
    fillEllipse(ctx, x - 7, top + 2, 10, 3, T.patrolNavy);
    fillEllipse(ctx, x - 2, top - 3.5, 2.6, 2.6, T.patrolWhite);
    ctx.restore();
  }

  // The planks the over-water half of the queue stands on. Drawn only while somebody is on them, so a harbour with
  // no reviews waiting is the harbour it has always been, down to the shape.
  function drawVisitorLanding(env) {
    const T = env.theme;
    const [lx, ly, lw, lh] = VISITOR_LANDING;
    ctx.save();
    for (const x of [lx + 16, lx + 96]) fillRR(ctx, x - 3, ly + lh - 4, 6, 14, 2, T.woodDark);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.fillRect(lx + 4, ly + lh, lw - 20, 5);
    fillRR(ctx, lx, ly, lw, lh, 3, T.woodLight, T.woodDark, 2);
    ctx.globalAlpha = 0.5;
    for (let x = lx + 12; x < lx + lw - 4; x += 13) line(ctx, x, ly + 3, x, ly + lh - 3, T.plank, 1.2);
    ctx.globalAlpha = 1;
    fillEllipse(ctx, lx + 8, ly + 5, 5, 4.5, T.woodDark);
    fillEllipse(ctx, lx + 8, ly + 3, 3.5, 2.8, T.wood);
    ctx.restore();
  }

  // The waits past `VISITOR_CAPACITY`, the way the graveyard's sign says how many headstones it could not fit.
  // There is no room for a pill at the desk: the deck above is the harbour queue's at any size and the water
  // below is the boat lane, so this is a line of text in the band between them. The desk's own count reaches the
  // reader through the guard's tooltip and the page's Reviews pill, which is where a number belongs anyway.
  function drawVisitorOverflow(env, n) {
    ctx.save();
    ctx.font = `700 14px ${FONT}`;
    ctx.fillStyle = env.theme.plateText;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${n} more`, VISITOR_OVERFLOW.x, VISITOR_OVERFLOW.y);
    ctx.restore();
  }

  // A visitor at the desk: a dark travel coat, a suitcase and a passport, held up where a session carries its state
  // badge when you were asked by name, and at the hip below a cream sash when a team you are on was. No badge, no
  // plate, no repo colour and no state of any kind, because it is a PR and has none.
  function drawVisitor(v, env) {
    const T = env.theme;
    const dusk = T.night;
    const colour = v.colour || VISITOR_COATS[0];
    const tint = dusk ? colour.dark : colour.light;
    const edge = dusk ? colour.darkEdge : colour.lightEdge;
    const via = v.via === 'you' ? 'you' : 'team';
    const walking = !!v.journey && !!v.walkingNow && !env.reduced;
    const x = v.px;
    const y = v.py;
    const lift = walking ? -Math.abs(Math.sin(v.stride * Math.PI)) * 2.5 : 0;
    const bottom = y - 3 + lift;
    const top = bottom - COAT_H;
    const headY = top - 7;
    ctx.save();
    if (v.alpha < 1) ctx.globalAlpha = clamp(v.alpha, 0, 1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (hoverId === v.id && scene === 'village') {
      // Small enough that the ring under the visitor at the head of the queue still clears the barrier: at 18 it
      // reached 2.5 px past the barrier's own box, which no unhovered frame could see.
      ctx.beginPath();
      ctx.ellipse(x, y, 13, 6, 0, 0, TAU);
      ctx.lineWidth = 5;
      ctx.strokeStyle = T.selectOuter;
      ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = T.selectInner;
      ctx.stroke();
    }
    fillEllipse(ctx, x, y, 11, 4, T.shadow);

    const swing = walking ? Math.sin(v.stride * TAU) : 0;
    ctx.strokeStyle = edge;
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.moveTo(x - 4, bottom - 2);
    ctx.lineTo(x - 4 + swing * 3, y - 1 + lift);
    ctx.moveTo(x + 4, bottom - 2);
    ctx.lineTo(x + 4 - swing * 3, y - 1 + lift);
    ctx.stroke();

    fillPoly(ctx, visitorCoatShape(x, bottom), tint, edge, 2);
    line(ctx, x, top + 3, x, bottom - 2, edge, 1.2);
    if (via === 'team') fillPoly(ctx, visitorSash(x, bottom), VISITOR_SASH);
    ctx.beginPath();
    ctx.arc(x, headY, 7, 0, TAU);
    ctx.fillStyle = tint;
    ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = edge;
    ctx.stroke();
    const face = colour.ink;
    fillEllipse(ctx, x - 2.6, headY - 0.5, 1.3, 1.5, face);
    fillEllipse(ctx, x + 2.6, headY - 0.5, 1.3, 1.5, face);

    // The passport, on the barrier side: the tell that this is a visitor and not a small session.
    const [pl, pt, pr, pb] = VISITOR_PASSPORT[via];
    const pY = y + lift + pt;
    fillRR(ctx, x + pl, pY, pr - pl, pb - pt, 1.5, REVIEWS.color, REVIEWS.border, 1);
    line(ctx, x + pr - 1.6, pY + 1.4, x + pr - 1.6, pY + 7.6, T.sailCloth, 1.4);

    // The case last, because it stands between the viewer and the coat: drawn before it, the hem covered six of
    // its eight pixels and the one prop that says "visitor" at a glance was all but invisible.
    const caseY = walking ? bottom - 17 : y - 11;
    fillRR(ctx, x - 10, caseY, 8, 12, 2, T.woodDark, T.wood, 1.2);
    line(ctx, x - 10, caseY + 5, x - 2, caseY + 5, T.wood, 1);
    ctx.beginPath();
    ctx.arc(x - 6, caseY, 2.6, Math.PI, TAU);
    ctx.strokeStyle = T.wood;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  }

  function drawBadges(ordered) {
    for (const c of ordered) {
      if (!c.session) continue;
      const b = badgeOf(c);
      if (!b) continue;
      ctx.save();
      ctx.globalAlpha = clamp(c.alpha, 0, 1) * (STATE[c.session.lane]?.dim && !c.journey ? 0.5 : 1);
      drawBadge(ctx, c.session.lane, b.x, b.y, b.r);
      ctx.restore();
    }
  }

  // Widest a plate can be without running into a plate beside it on the same row.
  function plateWidths(plates) {
    const widths = new Map();
    for (const c of plates) {
      let gap = Infinity;
      for (const o of plates) if (o !== c && Math.abs(o.py - c.py) < 30) gap = Math.min(gap, Math.abs(o.px - c.px));
      widths.set(c, clamp(gap - 10, 56, 260));
    }
    return widths;
  }

  function drawSelection(c, T) {
    const k = c.stone ? 1 : scaleOf(c);
    let cy;
    let rx;
    if (c.stone) {
      cy = c.py - 16;
      rx = 22;
    } else {
      const m = BODY[c.feat.shape];
      cy = c.py - (LEG + m.h / 2) * k;
      rx = (m.w * 0.8 + 10) * k;
    }
    const R = 54 * k;
    const halo = ctx.createRadialGradient(c.px, cy, 4, c.px, cy, R);
    halo.addColorStop(0, T.halo);
    halo.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(c.px - R - 2, cy - R - 2, 2 * R + 4, 2 * R + 4);
    ctx.beginPath();
    ctx.ellipse(c.px, c.py, rx, 13 * Math.max(0.5, k), 0, 0, TAU);
    ctx.lineWidth = 6;
    ctx.strokeStyle = T.selectOuter;
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = T.selectInner;
    ctx.stroke();
  }

  function fitText(text, maxW, font) {
    const key = `${font}|${maxW}|${text}`;
    const hit = fitCache.get(key);
    if (hit !== undefined) return hit;
    ctx.font = font;
    let out = text;
    if (ctx.measureText(text).width > maxW) {
      const chars2 = Array.from(text.replace(/\u2026$/, ''));
      while (chars2.length > 1 && ctx.measureText(chars2.join('') + '\u2026').width > maxW) chars2.pop();
      out = chars2.join('').trimEnd() + '\u2026';
    }
    if (fitCache.size > 600) fitCache.clear();
    fitCache.set(key, out);
    return out;
  }

  // Keeps both ends of a name, for the island boards alone: repo names in one org share long prefixes, and tail
  // truncation draws two different repos as the same string, which no colour or position reliably tells apart.
  function fitTextMiddle(text, maxW, font) {
    const key = `mid|${font}|${maxW}|${text}`;
    const hit = fitCache.get(key);
    if (hit !== undefined) return hit;
    ctx.font = font;
    let out = String(text);
    if (ctx.measureText(out).width > maxW) {
      const chars = Array.from(out);
      let head = Math.ceil((chars.length - 1) / 2);
      let tail = chars.length - 1 - head;
      const join = () => chars.slice(0, head).join('').trimEnd() + '…' + chars.slice(chars.length - tail).join('').trimStart();
      while (head + tail > 1 && ctx.measureText(join()).width > maxW) {
        if (head > tail) head -= 1;
        else tail -= 1;
      }
      out = join();
    }
    if (fitCache.size > 600) fitCache.clear();
    fitCache.set(key, out);
    return out;
  }

  // `place` is the place whose sign the plate keeps off, and null in the two interior scenes, which have no signs.
  function drawPlate(c, env, emphasis, limit = 260, place = null) {
    const s = c.session;
    const T = env.theme;
    const st = STATE[s.lane] || STATE.recent;
    const size = Math.round(Math.max(15, 12 / env.scale));
    const small = Math.round(Math.max(13, 11 / env.scale));
    const nameFont = `600 ${size}px ${FONT}`;
    const detailFont = `${small}px ${FONT}`;
    const maxW = emphasis ? 300 : limit;
    const name = fitText(plateText(s, env.privacy), maxW - 24, nameFont);
    ctx.font = nameFont;
    let w = ctx.measureText(name).width + 24;
    let detail = '';
    if (emphasis) {
      const label = truncateText(plateLabel(s), 40);
      detail = [label, waitClock(s.since, env.epoch)].filter(Boolean).join(' \u00b7 ');
      if (detail) {
        detail = fitText(detail, 276, detailFont);
        ctx.font = detailFont;
        w = Math.max(w, ctx.measureText(detail).width + 24);
      }
    }
    const h = size + 12 + (detail ? small + 5 : 0);
    const y0 = clamp(c.py + 9, 4, H - h - 3);
    const x0 = plateLeft(place, c.px, w, y0, h);
    ctx.save();
    if (c.alpha < 1) ctx.globalAlpha = clamp(c.alpha, 0, 1);
    fillRR(ctx, x0 + 1, y0 + 2.5, w, h, 7, 'rgba(0, 0, 0, 0.16)');
    fillRR(ctx, x0, y0, w, h, 7, T.plateBg, T.plateBorder, emphasis ? 1.5 : 1);
    fillRR(ctx, x0 + 4, y0 + 4, 4, h - 8, 2, st.color);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = nameFont;
    ctx.fillStyle = T.plateText;
    ctx.fillText(name, x0 + 14, y0 + 6 + size / 2 + 0.5);
    if (detail) {
      ctx.font = detailFont;
      ctx.fillStyle = T.plateMuted;
      ctx.fillText(detail, x0 + 14, y0 + 6 + size + 5 + small / 2);
    }
    ctx.restore();
  }

  // A place's sign: its name, then one cell per lane. `words` lays the cells out two to a line with the lane's word
  // beside its badge, which is what a four-lane board needs to be readable. `box` is the declared extent the crowd
  // was laid out around (signBox), so the drawn board never grows past what the layout allowed for.
  function drawSignBoard(env, { name, lanes, extra, cx, cy, post = true, words = false, box = null }) {
    const T = env.theme;
    ctx.save();
    const titleFont = `700 15px ${FONT}`;
    const countFont = `700 14px ${FONT}`;
    const wordFont = `600 13px ${FONT}`;
    const extraFont = `12px ${FONT}`;
    ctx.font = titleFont;
    const tw = ctx.measureText(name).width;
    ctx.font = countFont;
    const countW = Math.max(...lanes.map((lane) => ctx.measureText(String(countOf(lane))).width));
    let wordW = 0;
    if (words) {
      ctx.font = wordFont;
      wordW = Math.max(...lanes.map((lane) => ctx.measureText(STATE[lane].word).width));
    }
    const perRow = words ? 2 : lanes.length;
    const rows = Math.ceil(lanes.length / perRow);
    let ew = 0;
    if (extra) {
      ctx.font = extraFont;
      ew = ctx.measureText(extra).width;
    }
    let cellW = 24 + (words ? wordW + 6 : 1) + countW;
    const w = box ? box[2] : Math.ceil(Math.max(tw, perRow * cellW + (perRow - 1) * 14, ew) + 28);
    // A three-digit count on a declared board leaves the words less room, so they give way rather than overflow it.
    if (box && words) {
      wordW = Math.max(24, Math.min(wordW, (w - 28 - (perRow - 1) * 14) / perRow - 30 - countW));
      cellW = 24 + wordW + 6 + countW;
    }
    const rowW = perRow * cellW + (perRow - 1) * 14;
    const h = box ? box[3] : (extra ? 70 : 54);
    const x0 = box ? box[0] : clamp(cx - w / 2, 6, W - w - 6);
    const y0 = box ? box[1] : cy - h / 2;
    if (post) fillRR(ctx, cx - 3.5, y0 + h - 4, 7, 26, 2, T.woodDark);
    fillRR(ctx, x0 + 1, y0 + 3, w, h, 7, 'rgba(0, 0, 0, 0.16)');
    fillRR(ctx, x0, y0, w, h, 7, T.signBoard, T.signBorder, 2.5);
    fillEllipse(ctx, x0 + 7, y0 + 7, 1.6, 1.6, T.signBorder);
    fillEllipse(ctx, x0 + w - 7, y0 + 7, 1.6, 1.6, T.signBorder);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.font = titleFont;
    ctx.fillStyle = T.signText;
    ctx.fillText(fitText(name, w - 16, ctx.font), x0 + w / 2, y0 + 16);
    lanes.forEach((lane, i) => {
      const col = i % perRow;
      const rowIndex = Math.floor(i / perRow);
      const ix = x0 + w / 2 - rowW / 2 + col * (cellW + 14);
      const iy = y0 + (rows > 1 ? 40 + rowIndex * 24 : 38);
      laneCell(env, lane, ix, iy, wordW);
    });
    if (extra) {
      ctx.textAlign = 'center';
      ctx.font = extraFont;
      ctx.fillStyle = T.signMuted;
      ctx.fillText(extra, x0 + w / 2, y0 + 58);
    }
    ctx.restore();
    return { x0, y0, w, h };
  }

  function drawSign(key, env) {
    const p = PLACES[key];
    const [cx, cy] = p.sign;
    drawSignBoard(env, {
      name: placeName(key, env.pack), lanes: p.lanes, cx, cy,
      words: !!p.words, post: p.post !== false, box: p.signW ? signBox(key) : null,
    });
  }

  function drawGraveyardSign(env) {
    const T = env.theme;
    const total = countOf('graveyard');
    const more = Math.max(0, total - stones.size);
    const [cx, cy] = GRAVEYARD.sign;
    const extra = more > 0 ? `+${more} more` : '';
    // A wrought arch over the gate, with the sign hanging from it.
    const gx = GRAVEYARD.gateX;
    const [, fy, , fh] = GRAVEYARD.fence;
    const baseY = fy + fh - 34;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(gx - 26, baseY);
    ctx.quadraticCurveTo(gx, baseY - 128, gx + 26, baseY);
    ctx.strokeStyle = T.fenceDark;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
    const board = drawSignBoard(env, { name: GRAVEYARD.name, lanes: ['graveyard'], extra, cx, cy: cy - (extra ? 8 : 0), post: false });
    line(ctx, board.x0 + 18, board.y0, gx - 12, board.y0 - 14, T.fenceDark, 1.5);
    line(ctx, board.x0 + board.w - 18, board.y0, gx + 12, board.y0 - 14, T.fenceDark, 1.5);
  }

  function stoneRise(s, t) {
    if (!Number.isFinite(s.riseAt)) return 1;
    return clamp((t - s.riseAt) / RISE_S, 0, 1);
  }

  function drawHeadstone(s, env) {
    const T = env.theme;
    const k = stoneRise(s, env.t);
    if (k <= 0) return;
    const look = Math.floor(Math.abs(Number(s.session.look) || 0));
    const variant = look % 3;
    const w = 20 + (Math.floor(look / 7) % 3) * 2;
    const h = 26 + (Math.floor(look / 11) % 3) * 3;
    const x = s.px;
    const y = s.py;
    const ease = k >= 1 ? 1 : 1 - (1 - k) ** 3;
    ctx.save();
    ctx.lineJoin = 'round';
    fillEllipse(ctx, x, y + 1, w * 0.72 * Math.max(0.4, ease), 4.5, T.graveMound);
    ctx.beginPath();
    ctx.rect(x - 30, y - 70, 60, 70.5);
    ctx.clip();
    ctx.translate(0, (1 - ease) * (h + 4));
    fillEllipse(ctx, x + 4, y - 1, w * 0.55, 3, T.shadow);
    if (env.pack === 'shire') {
      // A barrow on the headstone's own footing: a turfed mound with a standing stone at its head, inside the
      // same box the stone is clipped to, so the ghosts and the crowd keep the clearances they had.
      ctx.beginPath();
      ctx.ellipse(x, y, w * 0.78, h * 0.62, 0, Math.PI, TAU);
      ctx.closePath();
      ctx.fillStyle = T.graveGrass;
      ctx.fill();
      ctx.strokeStyle = T.graveEdge;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.globalAlpha = 0.5;
      fillEllipse(ctx, x - w * 0.2, y - h * 0.3, w * 0.26, h * 0.1, T.moss);
      ctx.globalAlpha = 1;
      fillPoly(ctx, [
        [x - 4.5, y - h * 0.5], [x - 3, y - h - 2], [x + 3.5, y - h - 1], [x + 5, y - h * 0.5],
      ], T.graveStone, T.graveEdge, 1.5);
      ctx.restore();
      return;
    }
    ctx.beginPath();
    if (variant === 0) {
      ctx.moveTo(x - w / 2, y);
      ctx.lineTo(x - w / 2, y - h + w / 2);
      ctx.arc(x, y - h + w / 2, w / 2, Math.PI, TAU);
      ctx.lineTo(x + w / 2, y);
    } else if (variant === 1) {
      ctx.moveTo(x - 4, y);
      ctx.lineTo(x - 4, y - h + 14);
      ctx.lineTo(x - 11, y - h + 14);
      ctx.lineTo(x - 11, y - h + 7);
      ctx.lineTo(x - 4, y - h + 7);
      ctx.lineTo(x - 4, y - h);
      ctx.lineTo(x + 4, y - h);
      ctx.lineTo(x + 4, y - h + 7);
      ctx.lineTo(x + 11, y - h + 7);
      ctx.lineTo(x + 11, y - h + 14);
      ctx.lineTo(x + 4, y - h + 14);
      ctx.lineTo(x + 4, y);
    } else {
      ctx.moveTo(x - w / 2, y);
      ctx.lineTo(x - w / 2, y - h + 5);
      ctx.lineTo(x, y - h - 2);
      ctx.lineTo(x + w / 2, y - h + 5);
      ctx.lineTo(x + w / 2, y);
    }
    ctx.closePath();
    ctx.fillStyle = T.graveStone;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = T.graveEdge;
    ctx.stroke();
    if (variant !== 1) {
      line(ctx, x - w / 2 + 3, y - h + 8, x - w / 2 + 3, y - 3, T.graveStoneLight, 2);
      line(ctx, x - 5, y - h + 12, x + 5, y - h + 12, T.graveEdge, 1.3);
      line(ctx, x - 4, y - h + 16, x + 4, y - h + 16, T.graveEdge, 1.1);
    }
    if (look % 5 === 2) fillEllipse(ctx, x + w / 2 - 4, y - 3, 4, 2.5, T.moss);
    ctx.restore();
    if (k >= 1 && look % 4 === 1) {
      for (const [dx, i] of [[-6, 0], [-2, 1], [3, 2]]) {
        line(ctx, x + dx, y + 3, x + dx, y - 3, T.treeDark, 1.2);
        fillEllipse(ctx, x + dx, y - 4, 2.2, 2.2, T.flowers[(i + look) % T.flowers.length]);
      }
    }
    s.top = y - h - 2;
  }

  // The near half of the jail's cage, over the prisoners, so the front row reads as being behind bars. It starts at
  // JAIL.mid, which clears the chin of the frontmost row a crowd can reach, so no bar ever crosses a face or a badge.
  function drawJailBars(env) {
    const T = env.theme;
    ctx.save();
    for (const b of jailBarBoxes(true)) paintBar(ctx, T, b[0] + b[2] / 2, b[1], b[1] + b[3]);
    for (const r of jailRails().slice(1)) paintRail(ctx, T, r[0], r[0] + r[2], r[1] + r[3] / 2);
    ctx.restore();
  }

  // The ghosts over the graveyard: a dome with a rippling hem, two eyes and a smile. How many there are follows how
  // full the graveyard is (`ghostCount`), on perches that never overlap. Bob, sway and ripple all run off the
  // ambient clock, so they never ask for a frame; reduced motion leaves them at rest.
  function drawGhosts(env) {
    if (!stones.size) return;
    for (const g of ghostsFor(countOf('graveyard') || stones.size)) drawGhost(env, g);
  }

  // What haunts the barrows in Middle-earth. It stands on the ghost's own perch and inside the same box: ears no
  // wider than the arms reached, nothing above the dome's own top, and the jaw no lower than the skirt hung. The
  // shoulders sway on the ghost's own ripple, so it is the same motion on the same ambient tick.
  function drawOrc(g, T, x, y, rx, ry, k, w) {
    const lean = w * rx * 0.06;
    // Shoulders, hunched and higher on one side.
    fillPoly(g, [
      [x - rx * 1.12, y + ry * 1.24], [x - rx * 0.8, y + ry * 0.1],
      [x + rx * 0.8, y + ry * 0.1], [x + rx * 1.12, y + ry * 1.24],
    ], T.yewDark, T.ink, 1.5 * k);
    // Ears, swept back and pointed, which is the first thing that says this is not a ghost.
    for (const side of [-1, 1]) {
      fillPoly(g, [
        [x + lean + side * rx * 0.66, y - ry * 0.28], [x + lean + side * rx * 1.22, y - ry * 0.86],
        [x + lean + side * rx * 0.78, y + ry * 0.22],
      ], T.yew, T.ink, 1.3 * k);
    }
    // The head: square-jawed, not domed.
    fillRR(g, x + lean - rx * 0.84, y - ry * 0.92, rx * 1.68, ry * 1.42, rx * 0.34, T.yew, T.ink, 1.7 * k);
    // A heavy brow, and small eyes lit under it.
    fillRR(g, x + lean - rx * 0.86, y - ry * 0.46, rx * 1.72, ry * 0.26, 2 * k, T.yewDark);
    for (const side of [-1, 1]) {
      fillEllipse(g, x + lean + side * rx * 0.36, y - ry * 0.12, rx * 0.18, ry * 0.14, T.flame);
      fillEllipse(g, x + lean + side * rx * 0.36, y - ry * 0.12, rx * 0.08, ry * 0.07, T.ink);
    }
    // The jaw, and two tusks coming up out of it.
    fillRR(g, x + lean - rx * 0.58, y + ry * 0.16, rx * 1.16, ry * 0.4, rx * 0.18, T.yewDark, T.ink, 1.3 * k);
    for (const side of [-1, 1]) {
      fillPoly(g, [
        [x + lean + side * rx * 0.2, y + ry * 0.5], [x + lean + side * rx * 0.42, y - ry * 0.06],
        [x + lean + side * rx * 0.44, y + ry * 0.5],
      ], T.sailCloth, T.ink, 0.9 * k);
    }
    line(g, x + lean - rx * 0.4, y + ry * 0.36, x + lean + rx * 0.4, y + ry * 0.36, T.ink, 1.2 * k);
    // An iron cap with a nose guard, sitting on the dome's own top line.
    fillRR(g, x + lean - rx * 0.78, y - ry, rx * 1.56, ry * 0.36, 2 * k, T.steel, T.ink, 1.4 * k);
    fillRR(g, x + lean - rx * 0.1, y - ry * 0.7, rx * 0.2, ry * 0.42, 1.5 * k, T.steel, T.ink, 1.2 * k);
    for (const side of [-1, 1]) fillEllipse(g, x + lean + side * rx * 0.58, y - ry * 0.86, rx * 0.1, ry * 0.08, T.slate);
  }

  function drawGhost(env, g) {
    const T = env.theme;
    const { x, y } = ghostAt(env.t, env.reduced, g);
    const { rx, ry } = g;
    // The face, the arms and the ripple all scale with the perch, so a small ghost is a small ghost and not a
    // big face on a small dome. Arms then reach rx + 7.25k, which keeps every perch inside its own `ghostBox`.
    const k = rx / GHOST.rx;
    const w = env.reduced ? 0 : Math.sin((TAU * (env.t + g.phase)) / 3.1);
    ctx.save();
    if (env.pack === 'shire') {
      drawOrc(ctx, T, x, y, rx, ry, k, w);
      ctx.restore();
      return;
    }
    const halo = ctx.createRadialGradient(x, y, 2, x, y, rx + 8);
    halo.addColorStop(0, `rgba(${T.ghost}, 0.22)`);
    halo.addColorStop(1, `rgba(${T.ghost}, 0)`);
    ctx.fillStyle = halo;
    ctx.fillRect(x - rx - 8, y - ry - 8, (rx + 8) * 2, (ry + 8) * 2);
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, Math.PI, TAU);
    ctx.lineTo(x + rx, y + ry * 0.5);
    ctx.quadraticCurveTo(x + rx * 0.62, y + ry * (1.2 + 0.1 * w), x + rx * 0.3, y + ry * 0.66);
    ctx.quadraticCurveTo(x, y + ry * (1.3 - 0.1 * w), x - rx * 0.3, y + ry * 0.66);
    ctx.quadraticCurveTo(x - rx * 0.62, y + ry * (1.2 + 0.1 * w), x - rx, y + ry * 0.5);
    ctx.closePath();
    ctx.fillStyle = `rgba(${T.ghost}, 0.66)`;
    ctx.fill();
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = T.slate;
    ctx.lineWidth = 1.6 * k;
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Two small arms, and a friendly face.
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x + side * rx * 0.8, y - k);
      ctx.quadraticCurveTo(x + side * (rx + 5 * k), y + 3 * k, x + side * (rx + k), y + 7 * k);
      ctx.strokeStyle = `rgba(${T.ghost}, 0.66)`;
      ctx.lineWidth = 4.5 * k;
      ctx.stroke();
    }
    for (const side of [-1, 1]) fillEllipse(ctx, x + side * 5 * k, y - 4 * k, 2.1 * k, 2.7 * k, T.ink);
    ctx.beginPath();
    ctx.arc(x, y + k, 4.4 * k, 0.24 * Math.PI, 0.76 * Math.PI);
    ctx.strokeStyle = T.ink;
    ctx.lineWidth = 1.5 * k;
    ctx.stroke();
    ctx.restore();
  }

  // The hall's disco, dusk only (the same night flag as the graveyard and the lighthouse). All of it is drawn before
  // the guests, so a guest simply covers whatever light falls under it: bright is safe, and the plates and badges
  // are drawn after the guests anyway. Nothing here starts a frame request of its own; env.t comes off the hall's
  // own tick. Reduced motion holds the ball, the beams and the dots at their t=0 pose, rather than hiding them.
  function discoAngle(t, reduced) {
    return reduced ? 0 : (TAU * t) / 4.2;
  }

  function discoSpot(beam, t) {
    const ang = (TAU * (t + beam.phase)) / beam.period;
    const x = 800 + Math.sin(ang) * 640;
    const y = beam.wall ? 250 + Math.sin(ang * 0.7 + beam.phase) * 90 : 640 + Math.sin(ang * 0.63 + beam.phase) * 190;
    return [x, y];
  }

  function drawDiscoBall(env) {
    const { x, y, r } = DISCO_BALL;
    const a = discoAngle(env.t, env.reduced);
    ctx.save();
    // The chain keeps this exact colour: the harness finds the disco by it.
    line(ctx, x, 0, x, y - r - 5, 'rgba(150, 150, 158, 0.8)', 2.5);
    fillRR(ctx, x - 6, y - r - 7, 12, 9, 2, '#8d939c', '#4d525a', 1);
    fillEllipse(ctx, x, y, r, r, '#4a505c');
    // Mirror facets in latitude bands, turning with the ball: only the front half is drawn, foreshortened, and a
    // facet flashes white as it turns through the light.
    const bands = 9;
    const cols = 18;
    for (let b = 0; b < bands; b++) {
      const lat = -Math.PI / 2 + ((b + 0.5) * Math.PI) / bands;
      const cy = y + r * Math.sin(lat);
      const ring = r * Math.cos(lat);
      const fh = ring * (Math.PI / bands) * 0.84;
      for (let c = 0; c < cols; c++) {
        const lon = a + ((c + (b % 2) * 0.5) * TAU) / cols;
        const depth = Math.cos(lon);
        if (depth <= 0.08) continue;
        const fw = ring * depth * (TAU / cols) * 0.84;
        const glint = Math.max(0, Math.sin(lon * 2 + b * 1.3));
        const v = Math.round(110 + 120 * depth * (0.45 + 0.55 * glint));
        ctx.fillStyle = `rgb(${v}, ${Math.min(255, v + 6)}, ${Math.min(255, v + 16)})`;
        ctx.fillRect(x + ring * Math.sin(lon) - fw / 2, cy - fh / 2, fw, fh);
      }
    }
    fillEllipse(ctx, x - r * 0.35, y - r * 0.42, r * 0.22, r * 0.14, 'rgba(255, 255, 255, 0.55)');
    // Sparkles twinkling round the rim.
    for (let k = 0; k < 5; k++) {
      const tw = env.reduced ? 0.7 : Math.max(0, Math.sin(env.t * 3.3 + k * 1.9));
      if (tw < 0.2) continue;
      const ang = 0.5 + (k * TAU) / 5;
      const sx = x + Math.cos(ang) * r * 0.8;
      const sy = y + Math.sin(ang) * r * 0.8;
      const len = 6 + 10 * tw;
      ctx.globalAlpha = tw;
      line(ctx, sx - len, sy, sx + len, sy, '#ffffff', 2);
      line(ctx, sx, sy - len, sx, sy + len, '#ffffff', 2);
    }
    ctx.restore();
  }

  function drawDiscoLights(env) {
    const t = env.reduced ? 0 : env.t;
    const { x: bx, y: by } = DISCO_BALL;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const beam of DISCO_BEAMS) {
      const [sx, sy] = discoSpot(beam, t);
      const rx = beam.wall ? 60 : 92;
      const ry = beam.wall ? 54 : 34;
      // The beam: a cone from the ball to the spot's edges, brightest at the ball.
      const cone = ctx.createLinearGradient(bx, by, sx, sy);
      cone.addColorStop(0, `rgba(${beam.rgb}, 0.32)`);
      cone.addColorStop(1, `rgba(${beam.rgb}, 0.08)`);
      ctx.fillStyle = cone;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(sx - rx * 0.9, sy);
      ctx.lineTo(sx + rx * 0.9, sy);
      ctx.closePath();
      ctx.fill();
      // The spot where it lands, an ellipse on the floor: a circle's gradient, squashed.
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(1, ry / rx);
      const spot = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      spot.addColorStop(0, `rgba(${beam.rgb}, 0.8)`);
      spot.addColorStop(0.6, `rgba(${beam.rgb}, 0.45)`);
      spot.addColorStop(1, `rgba(${beam.rgb}, 0)`);
      ctx.fillStyle = spot;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    const drift = discoAngle(t, false) / (TAU * 3);
    for (const d of DISCO_DOTS) {
      const x = 110 + ((d.u + drift) % 1) * 1380;
      const floor = d.y > 410;
      fillEllipse(ctx, x, d.y, d.r * (floor ? 1.4 : 1), d.r * (floor ? 0.6 : 1), `rgba(${d.rgb}, 0.85)`);
    }
    ctx.restore();
  }

  function drawDisco(env) {
    if (!env.night) return;
    if (env.west) {
      drawMineBand(env);
      return;
    }
    if (env.pack === 'shire') {
      drawStarlight(env);
      drawHallFireworks(env);
      return;
    }
    drawDiscoLights(env);
    drawDiscoBall(env);
  }

  // Where the green hall hangs its mirror ball, these halls have a light of their own: one star over the archway
  // and a slow drift of others across the wall. It rides the hall's own tick and holds still under reduced
  // motion, the way the ball and the beam do.
  function drawStarlight(env) {
    const T = env.theme;
    const t = env.reduced ? 0 : env.t;
    const { x, y } = DISCO_BALL;
    const glow = ctx.createRadialGradient(x, y, 2, x, y, 150);
    glow.addColorStop(0, `rgba(${WARM_LIGHT}, 0.3)`);
    glow.addColorStop(1, `rgba(${WARM_LIGHT}, 0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(x - 150, y - 150, 300, 300);
    const star = (sx, sy, rad, alpha) => {
      ctx.globalAlpha = alpha;
      const pts = [];
      for (let i = 0; i < 8; i += 1) {
        const a = -Math.PI / 2 + (i * Math.PI) / 4;
        const d = i % 2 ? rad * 0.32 : rad;
        pts.push([sx + Math.cos(a) * d, sy + Math.sin(a) * d]);
      }
      fillPoly(ctx, pts, T.flagAlt);
      ctx.globalAlpha = 1;
    };
    star(x, y, 22 + (env.reduced ? 0 : Math.sin(t * 1.4) * 2), 0.9);
    for (const d of DISCO_DOTS) {
      const sx = 110 + ((d.u + t * 0.006) % 1) * 1380;
      star(sx, d.y, d.r * 1.3, 0.35 + ((d.u * 7) % 1) * 0.3);
    }
  }

  // A fiddle, an upright and a banjo on the stage, swaying on the beat with notes rising off them. All of it rides
  // the hall's own ambient tick, and all of it holds still under reduced motion, as the mirror ball does.
  function drawMineBand(env) {
    const T = env.theme;
    const { x, y, w, h } = MINE_STAGE;
    // A stage lamp behind them: the band stands against the archway, which is the darkest thing in the room, so
    // without it three dark figures on a dark opening read as nothing at all.
    const lamp = ctx.createRadialGradient(x, y - 50, 8, x, y - 50, 150);
    lamp.addColorStop(0, 'rgba(246, 214, 140, 0.30)');
    lamp.addColorStop(1, 'rgba(246, 214, 140, 0)');
    ctx.fillStyle = lamp;
    ctx.fillRect(x - 160, y - 200, 320, 260);
    fillRR(ctx, x - w / 2, y, w, h, 3, T.wood, T.woodDark, 2);
    fillRR(ctx, x - w / 2, y + h, w, 6, 2, T.woodDark);
    const players = [[-62, 'fiddle'], [0, 'bass'], [62, 'banjo']];
    players.forEach(([dx, kind], i) => {
      const sway = env.reduced ? 0 : Math.sin(env.t * 3.2 + i * 1.1) * 3;
      const px = x + dx + sway;
      ctx.save();
      // Pale in both schemes: the hall's own wall colour is dark at dusk, which is exactly when the band plays.
      fillEllipse(ctx, px, y - 44, 13, 15, T.signBoard, T.woodDark, 1.5);
      fillEllipse(ctx, px, y - 62, 9, 9, T.signBoard, T.woodDark, 1.5);
      // Everyone on the stage is hatted too.
      fillEllipse(ctx, px, y - 68, 14, 3, T.woodDark);
      fillRR(ctx, px - 6, y - 78, 12, 11, 3, T.woodDark);
      if (kind === 'bass') {
        fillEllipse(ctx, px + 15, y - 30, 12, 18, T.wood, T.woodDark, 1.5);
        line(ctx, px + 15, y - 48, px + 15, y - 74, T.woodDark, 3);
      } else if (kind === 'fiddle') {
        fillEllipse(ctx, px + 13, y - 50, 8, 6, T.wood, T.woodDark, 1.5);
        line(ctx, px + 18, y - 52, px + 34, y - 58, T.woodDark, 2);
      } else {
        fillEllipse(ctx, px + 14, y - 44, 8, 8, T.signBoard, T.woodDark, 1.5);
        line(ctx, px + 20, y - 48, px + 34, y - 58, T.woodDark, 2.5);
      }
      ctx.restore();
      // Notes rising off each player, on the same beat.
      if (env.reduced) return;
      for (let n = 0; n < 2; n += 1) {
        const rise = ((env.t * 0.5 + i * 0.3 + n * 0.5) % 1);
        ctx.globalAlpha = 0.75 * (1 - rise);
        const nx = px + 22 + Math.sin(rise * 6 + i) * 8;
        const ny = y - 84 - rise * 54;
        fillEllipse(ctx, nx, ny, 4, 3.2, T.signBoard);
        line(ctx, nx + 4, ny, nx + 4, ny - 11, T.signBoard, 1.8);
        ctx.globalAlpha = 1;
      }
    });
  }

  // A brawl or a shootout between the two of the crowd standing nearest each other.
  function drawMineFight(env) {
    if (!env.west || !env.night || scene !== 'castle') return;
    const fight = fightAt(env.t, env.reduced);
    if (!fight) return;
    const inside = guestsOf(scene);
    if (!inside) return;
    const pair = fightPair([...inside.values()].map((c) => ({ x: c.px, y: c.py })));
    if (!pair) return;
    const T = env.theme;
    const [a, b] = pair;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2 - 26;
    const fade = Math.sin(Math.min(1, fight.k) * Math.PI);
    ctx.save();
    ctx.globalAlpha = fade;
    if (fight.kind === 'brawl') {
      // Wide enough to take both of them in, whatever the crowd left between them.
      const half = Math.max(34, Math.abs(a.x - b.x) / 2 + 22);
      for (let i = 0; i < 7; i += 1) {
        const ang = (i / 7) * TAU + fight.k * 2;
        fillEllipse(ctx, midX + Math.cos(ang) * half * 0.6, midY + Math.sin(ang) * 20,
          half * 0.5, 19, `rgba(${T.smoke}, 0.5)`);
      }
      // A fist and a boot coming out of it.
      fillEllipse(ctx, midX + half * 0.7, midY - 16, 8, 7, T.wallShade, T.woodDark, 1.5);
      fillRR(ctx, midX - half * 0.85, midY + 8, 16, 8, 3, T.woodDark);
      shoutText(ctx, T, 'POW!', midX, midY - 46, fade);
    } else {
      const from = a;
      const to = b;
      const dir = Math.sign(to.x - from.x) || 1;
      const gx = from.x + dir * 20;
      const gy = from.y - 30;
      fillPoly(ctx, [[gx, gy - 6], [gx + dir * 26, gy], [gx, gy + 6]], T.flame, T.flameCore, 1.5);
      for (let i = 0; i < 5; i += 1) {
        fillEllipse(ctx, gx + dir * (10 + i * 9), gy - 4 - i * 3, 9 - i, 7 - i, `rgba(${T.smoke}, 0.45)`);
      }
      shoutText(ctx, T, 'BANG!', gx + dir * 30, gy - 40, fade);
    }
    ctx.restore();
  }

  // The shout over a fight: painted, never a title, so privacy mode has nothing to hide here.
  function shoutText(g, T, word, x, y, alpha) {
    g.save();
    g.globalAlpha = alpha;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `800 26px ${FONT}`;
    g.lineWidth = 4;
    g.strokeStyle = T.signText;
    g.strokeText(word, x, y);
    g.fillStyle = T.signBoard;
    g.fillText(word, x, y);
    g.restore();
  }

  // A board-game piece hopping between two squares on each cottage table now and then, on the room's own ambient
  // tick: no extra frame request, and reduced motion holds every piece at its first square.
  function drawGamePieces(env) {
    if (scene !== 'cottages') return;
    const t = env.reduced ? 0 : env.t;
    COTTAGE_TABLES.forEach((tb, i) => {
      const hop = Math.floor(t / PIECE_HOP_PERIOD + i * 0.63) % 2;
      const [dx, dy] = hop ? [14, -8] : [-14, 8];
      fillEllipse(ctx, tb.x + dx, tb.y + dy, 6, 5.2, PIECE_COLOURS[i % PIECE_COLOURS.length], '#2b2b2b', 1.2);
    });
  }

  // The lighthouse beam, over the village and its crowd but under the plates and the badges: a name and a state
  // are the two things that carry meaning, and a light sweeping over them would dim exactly those. Three nested
  // wedges give the edge its softness; the alpha each one carries is `LIGHTHOUSE.cones`, which is also what
  // `beamAlphaAt` reports, so the measured alpha is the drawn alpha.
  function drawBeam(env) {
    if (!env.night) return;
    const a = beamAngle(env.t, env.reduced);
    const { x, y, reach } = LIGHTHOUSE;
    ctx.save();
    for (const cone of LIGHTHOUSE.cones) {
      const grad = ctx.createRadialGradient(x, y, 0, x, y, reach);
      for (const [f, share] of BEAM_PROFILE) grad.addColorStop(f, `rgba(${env.theme.beamLight}, ${rnd5(cone.alpha * share)})`);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, reach, a - cone.half, a + cone.half);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }
    ctx.restore();
  }

  function drawWisps(env) {
    if (env.reduced || !stones.size) return;
    const risen = [...stones.values()].filter((s) => stoneRise(s, env.t) >= 1);
    if (!risen.length) return;
    ctx.save();
    for (let i = 0; i < Math.min(3, risen.length); i++) {
      const cycle = 7 + i * 1.3;
      const u = env.t + i * 2.3;
      const ph = (u % cycle) / cycle;
      const s = risen[(Math.floor(u / cycle) * 7 + i * 3) % risen.length];
      const a = Math.sin(Math.PI * ph) * 0.3;
      const x = s.px + Math.sin(ph * TAU * 1.5 + i) * 7;
      const y = s.py - 38 - ph * 50;
      for (let j = 3; j >= 0; j--) {
        ctx.globalAlpha = a * (1 - j * 0.2);
        fillEllipse(ctx, x - Math.sin(ph * 9 + j) * 2 * j, y + j * 5, 6 - j * 1.2, 7 - j * 1.4, `rgb(${env.theme.ghost})`);
      }
    }
    ctx.restore();
  }

  // One island per repo on a schematic sea, sized by its session count. Ambient only: nothing here ever asks for a
  // full-rate frame, and reduced motion holds the water still.
  function drawWorld(env) {
    const T = env.theme;
    if (!env.reduced) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = T.ripple;
      ctx.lineWidth = 2;
      for (let i = 0; i < 14; i++) {
        const a = Math.sin(env.t * 1.1 + i * 1.7);
        if (a <= 0) continue;
        const y = WORLD.margin + ((i * 197) % (H - WORLD.margin * 2));
        const x = WORLD.margin + ((i * 331) % (W - WORLD.margin * 2));
        ctx.globalAlpha = a * 0.55;
        ctx.beginPath();
        ctx.moveTo(x - 8 - a * 5, y);
        ctx.lineTo(x + 8 + a * 5, y);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (!worldIslands.length) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 22px ${FONT}`;
      ctx.fillStyle = T.foam;
      ctx.fillText('No sessions on the board', W / 2, H / 2);
      ctx.restore();
      drawWorldReviews();
      return;
    }
    for (const is of worldIslands) drawWorldIsland(env, is);
    drawWorldReviews();
  }

  // The whole board's reviews, in the map's top margin, which is outside every island's cell. An island's own
  // badge counts that island; a repo with a review request and no sessions has no island at all, so this total is
  // the only thing that can say one is waiting.
  function drawWorldReviews() {
    const reviews = boardReviews();
    if (reviews <= 0) return;
    const text = `${reviews} ${reviews === 1 ? 'PR waiting on your review' : 'PRs waiting on your review'}`;
    ctx.save();
    ctx.font = `700 15px ${FONT}`;
    const w = Math.ceil(38 + ctx.measureText(text).width);
    const x0 = WORLD_REVIEWS_PILL.x - w / 2;
    const cy = WORLD_REVIEWS_PILL.y;
    fillRR(ctx, x0, cy - 13, w, 26, 13, REVIEWS.color, REVIEWS.border, 1.5);
    drawGlyph(ctx, REVIEWS.glyph, x0 + 15, cy, 16, '#ffffff', null);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x0 + 27, cy + 0.5);
    ctx.restore();
  }

  // One island, in the same illustrated language as the village: a wobbled coastline with sand at its edge and
  // grass inside, a little furniture that grows with the repo's session count, and the repo's own colour as an
  // accent on the shoreline, the flag and the roofs. Geometry comes from `islandScene`, so a check that measures
  // that measures what is painted here.
  function drawWorldIsland(env, is) {
    const T = env.theme;
    const colour = islandColours.get(is.repo) || repoColourFor(is.repo);
    const fill = env.night ? colour.dark : colour.light;
    const edge = env.night ? colour.darkEdge : colour.lightEdge;
    const s = islandScene(is);
    ctx.save();
    fillPoly(ctx, s.rings.shallow, T.shallow);
    if (hoverId === is.id && scene === 'world') {
      // Drawn on the shallow ring's own rim, after it, so the whole 3 px stroke lands inside `box`: the layout
      // budgets the halo and nothing beyond it, and a ring outside that escapes its cell on a crowded map.
      fillPoly(ctx, s.rings.ring, null, T.selectOuter, 3);
      fillPoly(ctx, s.rings.ring, null, T.selectInner, 1.5);
    }
    ctx.globalAlpha = 0.8;
    fillPoly(ctx, s.rings.foam, T.foam);
    ctx.globalAlpha = 1;
    fillPoly(ctx, s.rings.wet, T.sandWet);
    // The shoreline carries the repo's colour, which is the accent that scales with the island: a flag alone is
    // hard to match to a legend swatch on a crowded map, and a filled disc of it read as a pie chart.
    fillPoly(ctx, s.rings.sand, T.sandLight);
    // Rim first, then fill, exactly as the banner and every roof are drawn. The tideline was the one accent with
    // no rim, and three palette entries sit under 12 CIEDE2000 from the sand it is stroked on (8.15 for the No
    // repo chalk by day), which is what "an accent's fill or its rim, against anything it can sit on" promises.
    fillPoly(ctx, s.rings.rim, null, edge, s.rim + 1.5);
    fillPoly(ctx, s.rings.rim, null, fill, s.rim);
    for (const [dx, dy, dr] of s.dots) fillEllipse(ctx, dx, dy, dr, dr * 0.7, T.sandDot);
    fillPoly(ctx, s.rings.shade, T.grassDark);
    fillPoly(ctx, s.rings.grass, T.grass);
    if (s.jetty) drawIslandJetty(T, s.jetty, is.ry);
    for (const r of s.rocks) {
      fillEllipse(ctx, r.x, r.y + r.ry * 0.5, r.rx, r.ry * 0.4, T.shadow);
      fillEllipse(ctx, r.x, r.y, r.rx, r.ry, T.stoneDark);
      fillEllipse(ctx, r.x - r.rx * 0.2, r.y - r.ry * 0.25, r.rx * 0.6, r.ry * 0.5, T.stone);
    }
    for (const h of s.huts) drawIslandHut(T, h, fill, edge, is.ry);
    if (s.lighthouse) drawIslandLighthouse(env, T, s.lighthouse, is.ry);
    drawIslandFlag(T, s.flag, fill, edge, is.ry);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${s.numeral.font}px ${FONT}`;
    // Off the repo colour and onto the grass, which is the same ink on the same ground in both themes: the count
    // is the one number on the island and it no longer depends on which entry the repo drew.
    ctx.fillStyle = env.night ? INK_LIGHT : INK_DARK;
    ctx.fillText(fitText(String(is.count), s.gx * 1.8, ctx.font), s.numeral.x, s.numeral.y);
    ctx.restore();
    drawWorldSign(env, is);
  }

  function drawIslandJetty(T, j, ry) {
    const lw = clamp(ry * 0.02, 0.5, 1.4);
    fillRR(ctx, j.x - j.w / 2, j.y, j.w, j.len, Math.min(1.5, j.w / 4), T.woodLight, T.woodDark, lw);
    ctx.globalAlpha = 0.55;
    for (let y = j.y + j.len / 3; y < j.y + j.len; y += j.len / 3) {
      line(ctx, j.x - j.w / 2 + lw, y, j.x + j.w / 2 - lw, y, T.plank, lw);
    }
    ctx.globalAlpha = 1;
  }

  function drawIslandHut(T, h, fill, edge, ry) {
    const lw = clamp(ry * 0.02, 0.5, 1.4);
    const top = h.y - h.h;
    fillEllipse(ctx, h.x, h.y, h.w * 0.5, h.w * 0.12, T.shadow);
    fillRR(ctx, h.x - h.w / 2, top, h.w, h.h, Math.min(1.5, h.w / 6), T.wall, T.woodDark, lw);
    // The roof's base is exactly `w`, so the accent area `islandScene` reports is the area drawn.
    fillPoly(ctx, [[h.x - h.w / 2, top], [h.x, top - h.roof], [h.x + h.w / 2, top]], fill, edge, lw);
    if (h.w >= 16) fillRR(ctx, h.x - h.w * 0.11, h.y - h.h * 0.55, h.w * 0.22, h.h * 0.55, 0.8, T.door);
  }

  function drawIslandLighthouse(env, T, l, ry) {
    const lw = clamp(ry * 0.02, 0.5, 1.4);
    const capY = l.y - l.h * 0.82;
    fillPoly(ctx, [[l.x - l.w / 2, l.y], [l.x + l.w / 2, l.y], [l.x + l.w * 0.3, capY], [l.x - l.w * 0.3, capY]],
      T.lighthouse, T.stoneDark, lw);
    for (const k of [0.3, 0.62]) {
      const y = l.y - l.h * 0.82 * k;
      const w = l.w * (0.5 - 0.2 * k) * 2;
      fillRR(ctx, l.x - w / 2, y - l.h * 0.09, w, l.h * 0.09, 0, T.slate);
    }
    const pane = [l.x - l.w * 0.26, capY - l.h * 0.14, l.w * 0.52, l.h * 0.14];
    if (env.night) {
      const glow = ctx.createRadialGradient(l.x, capY - l.h * 0.07, 0, l.x, capY - l.h * 0.07, l.w * 1.6);
      glow.addColorStop(0, `rgba(${WARM_LIGHT}, 0.5)`);
      glow.addColorStop(1, `rgba(${WARM_LIGHT}, 0)`);
      fillEllipse(ctx, l.x, capY - l.h * 0.07, l.w * 1.6, l.w * 1.6, glow);
    }
    fillRR(ctx, pane[0], pane[1], pane[2], pane[3], Math.min(1, pane[3] / 2),
      env.night ? `rgba(${WARM_LIGHT}, 0.95)` : T.lanternGlass);
    fillRR(ctx, l.x - l.w * 0.34, capY - l.h * 0.19, l.w * 0.68, l.h * 0.05, 0.6, T.slate);
  }

  function drawIslandFlag(T, f, fill, edge, ry) {
    const lw = clamp(ry * 0.02, 0.5, 1.4);
    line(ctx, f.x, f.base, f.x, f.y - f.mast, T.woodDark, clamp(ry * 0.018, 0.9, 3));
    const [, by, bw, bh] = f.band;
    // A swallowtail cut into the flying edge, so the accent reads as a flag rather than a coloured block.
    const inner = f.tail - Math.sign(f.tail - f.x) * bw * ISLAND_ART.flag.notch;
    fillPoly(ctx, [[f.x, by], [f.tail, by], [inner, by + bh / 2], [f.tail, by + bh], [f.x, by + bh]],
      fill, edge, Math.max(lw, 0.8));
  }

  // The name board under an island, in the language every place in the village already uses: the name, then a badge
  // and a count per lane that has one.
  function drawWorldSign(env, is) {
    const T = env.theme;
    const [sx, sy, sw, sh] = is.sign;
    if (sh < 6) return; // an over-subscribed map: no board left to draw on
    ctx.save();
    // Inset by half its own stroke, and shaded along its inner bottom edge rather than dropping a shadow: a 2.5 px
    // stroke centred on `sign` painted 1.25 px outside the box the layout budgeted, and the drop shadow 3 px
    // below it. Same class of miss as the hover ring's, and on a crowded map it is the cell it escapes.
    const inset = 1.25;
    fillRR(ctx, sx + inset, sy + inset, sw - inset * 2, sh - inset * 2, 7, T.signBoard, T.signBorder, 2.5);
    ctx.globalAlpha = 0.22;
    fillRR(ctx, sx + 5, sy + sh - 5.5, sw - 10, 3, 1.5, T.signBorder);
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    if (is.nameBox) {
      ctx.font = `700 15px ${FONT}`;
      ctx.fillStyle = T.signText;
      ctx.fillText(fitTextMiddle(is.label, is.nameBox[2], ctx.font), is.cx, is.nameBox[1] + 15);
    }
    const row = worldBadgeRow(is.lanes, is.badges[2], is.badges[3], is.reviews);
    const x0 = is.cx - row.w / 2;
    const y = is.badges[1] + is.badges[3] / 2;
    for (const cell of row.cells) {
      drawBadge(ctx, cell.lane, x0 + cell.dx + cell.r, y, cell.r);
      if (cell.glyphOnly) continue;
      ctx.textAlign = 'left';
      ctx.font = `700 ${rnd2(12 * row.k)}px ${FONT}`;
      ctx.fillStyle = T.signText;
      ctx.fillText(String(cell.n), x0 + cell.textX, y + 0.5);
    }
    ctx.restore();
  }

  // The whole board's blocked count, not the open island's: a blocked session on another island must not turn the
  // ring off, which is the promise the village's orange has always made.
  function drawEdgeRing(env) {
    if (boardCountOf('needs_you') <= 0) return;
    const lw = 6 * view.dpr;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = env.reduced ? 0.9 : 0.6 + 0.35 * (0.5 + 0.5 * Math.sin((TAU * env.t) / 1.6));
    ctx.lineWidth = lw;
    ctx.strokeStyle = STATE.needs_you.color;
    ctx.strokeRect(lw / 2, lw / 2, canvas.width - lw, canvas.height - lw);
    ctx.restore();
  }

  function drawVillage(env) {
    const T = env.theme;
    drawAmbient(env);
    if (env.west) drawHorse(env);
    if (env.pack === 'shire') {
      drawEnts(env);
      drawWalkingEnt(env);
      drawSpider(env);
      drawGollum(env);
      drawFireworks(env);
    }
    for (const key of PLACE_KEYS) drawSign(key, env);
    drawGraveyardSign(env);
    drawRoomBadge(env, { id: CASTLE_ID, at: CASTLE.badge, lanes: SCENE_ART.castle.lanes });
    drawRoomBadge(env, { id: COTTAGE_ID, at: COTTAGE.badge, lanes: SCENE_ART.cottages.lanes });
    drawPorchLights(env);
    if (visitors.size) {
      drawVisitorLanding(env);
      if (visitorHidden > 0) drawVisitorOverflow(env, visitorHidden);
    }

    const items = [];
    for (const c of chars.values()) items.push({ y: c.py, x: c.px, c });
    // Drawn among the crowd by their feet, so a visitor at the waterline stands in front of the harbour deck and
    // behind a boat moored off the pier, like everything else in the village.
    for (const v of visitors.values()) if (v.alpha > 0) items.push({ y: v.py, x: v.px, v });
    items.push({ y: BARRIER.y, x: BARRIER.pivotX, barrier: true }, { y: GUARD.y, x: GUARD.x, guard: true });
    for (const row of swingRows()) items.push({ y: row.y - 0.5, x: row.xs[0], row });
    for (const s of stones.values()) items.push({ y: s.py - 0.25, x: s.px, s });
    for (const f of ferries) {
      const b = ferryAt(f, env.t);
      if (b) items.push({ y: b.y, x: b.x, ferry: b });
    }
    items.sort((a, b) => a.y - b.y || a.x - b.x);
    const selected = targetObject(selectedId);
    const hovered = targetObject(hoverId);
    const ordered = [];
    const patrol = patrolFrame(env.t);
    for (const item of items) {
      if (item.row) {
        drawSwingFrame(item.row, env);
        continue;
      }
      if (item.barrier) {
        drawBarrier(env, patrol.lift);
        continue;
      }
      if (item.guard) {
        drawGuard(env, patrol);
        continue;
      }
      if (item.ferry) {
        drawFerry(item.ferry, env);
        continue;
      }
      if (item.v) {
        drawVisitor(item.v, env);
        continue;
      }
      if (item.s) {
        if (item.s === selected && stoneRise(item.s, env.t) > 0) drawSelection({ ...item.s, stone: true }, T);
        drawHeadstone(item.s, env);
        continue;
      }
      if (item.c === selected && !item.c.leaving) drawSelection(item.c, T);
      if (item.c.boat) drawVoyageBoat(item.c, env, 'back');
      drawScaled(item.c, env);
      if (item.c.boat && item.c.inBoat) drawVoyageBoat(item.c, env, 'front');
      ordered.push(item.c);
    }
    // Over the headstones, and under a hovered headstone's badge, which is drawn last.
    drawGhosts(env);
    // Over the crowd, but before the plates: a plate hangs below the feet, right where the near bars are.
    drawJailBars(env);
    drawWisps(env);
    if (!reduced) drawParticles();
    drawBeam(env);

    const plated = ordered.filter((c) => c !== hovered && c !== selected && PLATED_LANES.has(c.session.lane) && !c.journey);
    const widths = plateWidths(plated);
    for (const c of plated) drawPlate(c, env, false, widths.get(c), c.place);
    drawBadges(ordered);
    for (const s of [selected, hovered]) {
      if (s && s.riseAt !== undefined && stoneRise(s, env.t) >= 1 && s.top !== undefined) {
        drawBadge(ctx, 'graveyard', s.px, s.top - 16, BADGE_R);
      }
    }
    if (selected && selected !== hovered && !selected.leaving && selected.session) drawPlate(selected, env, true, 260, selected.place);
    if (hovered && !hovered.leaving && hovered.session) drawPlate(hovered, env, true, 260, hovered.place);
  }

  // One interior scene: the sand castle hall, or the cottage room. Both draw the same way.
  function drawInterior(env) {
    const T = env.theme;
    const art = SCENE_ART[scene];
    ensureSceneLayer();
    if (sceneBg) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(sceneBg, 0, 0);
      const k = view.dpr * view.scale;
      ctx.setTransform(k, 0, 0, k, view.dpr * view.offX, view.dpr * view.offY);
    }
    if (scene === 'castle') {
      for (const [x, y] of HALL_TORCHES) {
        const f = env.reduced ? 1 : 0.85 + 0.15 * Math.sin(env.t * 8.3 + x) * Math.sin(env.t * 3.7 + y);
        const glow = ctx.createRadialGradient(x, y - 16, 2, x, y - 16, 70);
        glow.addColorStop(0, `rgba(246, 214, 140, ${0.45 * f})`);
        glow.addColorStop(1, 'rgba(246, 214, 140, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(x - 72, y - 88, 144, 144);
        fillEllipse(ctx, x, y - 14 - f * 3, 8 * f, 15 * f, T.flame);
        fillEllipse(ctx, x, y - 10, 4, 7, T.flameCore);
      }
      drawDisco(env);
    } else if (env.west) {
      drawCountingRoomLamp();
    } else {
      drawHearthFire(env);
      drawGamePieces(env);
    }

    // Title, note and one count pill per lane on the plaque.
    ctx.save();
    fillRR(ctx, 618, 42, 364, 112, 8, T.signBoard, T.signBorder, 2.5);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 26px ${FONT}`;
    ctx.fillStyle = T.signText;
    ctx.fillText(fitText(roomName(scene, theme.pack), 340, ctx.font), 800, 68);
    ctx.font = `15px ${FONT}`;
    ctx.fillStyle = T.signMuted;
    ctx.fillText(fitText(art.note, 340, ctx.font), 800, 136);
    ctx.font = `700 16px ${FONT}`;
    const pills = art.lanes.map((lane) => ({ lane, text: String(countOf(lane)) }));
    const widths = pills.map((q) => Math.ceil(36 + ctx.measureText(q.text).width));
    const total = widths.reduce((a, b) => a + b, 0) + (pills.length - 1) * 10;
    let px0 = 800 - total / 2;
    pills.forEach((q, i) => {
      const st = STATE[q.lane] || STATE.recent;
      fillRR(ctx, px0, 90, widths[i], 28, 14, st.color, st.border, 1.5);
      drawGlyph(ctx, st.glyph, px0 + 15, 104, 17, pillInk(st), null);
      ctx.fillStyle = pillInk(st);
      ctx.textAlign = 'left';
      ctx.fillText(q.text, px0 + 27, 104.5);
      ctx.textAlign = 'center';
      px0 += widths[i] + 10;
    });
    ctx.restore();

    const selected = targetObject(selectedId);
    const hovered = targetObject(hoverId);
    const ordered = [...(guestsOf(scene) || new Map()).values()].sort((a, b) => a.py - b.py || a.px - b.px);
    for (const c of ordered) {
      if (c === selected) drawSelection(c, T);
      drawScaled(c, env);
    }
    drawMineFight(env);
    drawBadges(ordered);
    if (selected && selected !== hovered && selected.inside) drawPlate(selected, env, true);
    if (hovered && hovered.inside) drawPlate(hovered, env, true);
  }

  function draw(ms = now()) {
    if (!view) resize();
    if (!view || !ctx) return;
    needsDraw = false;
    hoverDirty = false;
    lastDrawMs = ms;
    const t = ms / 1000;
    const dt = lastT ? clamp(t - lastT, 0, MAX_PARTICLE_DT) : 0;
    lastT = t;
    advance(t);
    if (interiorWandering()) {
      // Reading a tooltip takes a second or more, so the guest it names holds still until the pointer leaves or clicks.
      const inside = [...guestsOf(scene).values()];
      for (const g of inside) g.held = g.id === hoverId || (!!press && !press.up && press.id === g.id);
      // Seated cottage guests hold their seats rather than wandering; only the free-crowd overflow case (more
      // guests than seats) still wanders, the same as the hall always has.
      if (scene !== 'cottages' || inside.length > COTTAGE_SEAT_CAPACITY) wanderStep(inside, dt, crowdScale[scene], SCENE_ART[scene].spec);
    }
    if (!reduced && scene === 'village') {
      emitParticles(t);
      stepPool(sparks, dt, 520);
      stepPool(smoke, dt, -4);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    if (scene === 'world') {
      ensureWorldLayer();
      if (worldBg) ctx.drawImage(worldBg, 0, 0);
      else {
        ctx.fillStyle = theme.waterDeep;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    } else if (bg && scene === 'village') ctx.drawImage(bg, 0, 0);
    else {
      ctx.fillStyle = scene === 'village' ? theme.grass : theme[SCENE_ART[scene].floor];
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const k = view.dpr * view.scale;
    ctx.setTransform(k, 0, 0, k, view.dpr * view.offX, view.dpr * view.offY);
    const env = {
      t, epoch: Date.now(), theme, reduced, privacy, scale: view.scale,
      night: theme.night, pack: theme.pack, west: theme.pack === 'west',
    };

    if (scene === 'village') drawVillage(env);
    else if (scene === 'world') drawWorld(env);
    else drawInterior(env);

    drawEdgeRing(env);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    reportHoverMove();
  }

  // ----- input -----

  function toLogical(e) {
    if (!view) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - view.offX) / view.scale,
      y: (e.clientY - rect.top - view.offY) / view.scale,
    };
  }

  // The object an id names in the current scene: a character, a guest inside a room, a headstone or a place. Never
  // a visitor: it is a PR, so it has no session, no plate and no selection, and nothing that walks sessions may
  // pick one up.
  function targetObject(id) {
    if (!id || isIslandId(id) || visitors.has(id)) return null;
    const inside = guestsOf(scene);
    if (inside) return inside.get(id) || null;
    if (PLACE_IDS.has(id)) return null;
    const c = chars.get(id);
    if (c && !c.leaving) return c;
    return stones.get(id) || null;
  }

  function targetOf(id) {
    if (!id) return false;
    if (isIslandId(id)) return scene === 'world' && worldIslands.some((is) => is.id === id);
    if (PLACE_IDS.has(id)) return scene === 'village';
    const v = visitors.get(id);
    if (v) return scene === 'village' && !v.leaving;
    const o = targetObject(id);
    if (!o) return false;
    if (o.riseAt !== undefined) return stoneRise(o, now() / 1000) > 0;
    return true;
  }

  // Body top and badge centre without the walk bob or the hop, so hit testing and the hover point hold still. Both
  // follow the character's scale.
  function restingGeometry(c) {
    const m = BODY[c.feat.shape];
    const k = scaleOf(c);
    const top = c.py - (baseLift(c) + m.h) * k;
    return { m, k, top, badgeY: top - (19 + headroom(c.feat, pack)) * k, badgeR: badgeRadius(c) };
  }

  // The nearest character under p, unless `prefer` (the one the tooltip names) is still under it too: a guest walking
  // in front of it must not take the click.
  function hitTest(p, prefer = null) {
    if (!p) return null;
    if (scene === 'world') {
      const is = worldHit(worldIslands, p);
      return is ? is.id : null;
    }
    let best = null;
    let bestD = Infinity;
    let preferHit = false;
    const people = guestsOf(scene) ? guestsOf(scene).values() : chars.values();
    for (const c of people) {
      if (c.leaving || c.alpha < 0.35) continue;
      const { m, k, top, badgeY, badgeR } = restingGeometry(c);
      const bodyD = Math.hypot(p.x - c.px, p.y - (top + (m.h / 2) * k));
      const bodyR = (Math.max(m.w, m.h) / 2 + 8) * k;
      const badgeD = Math.hypot(p.x - c.px, p.y - badgeY);
      let d = Infinity;
      if (bodyD <= bodyR) d = bodyD;
      if (badgeD <= badgeR + 3) d = Math.min(d, badgeD);
      if (c.id === prefer && d < Infinity) preferHit = true;
      if (d < bestD) {
        bestD = d;
        best = c.id;
      }
    }
    if (preferHit) return prefer;
    if (best || scene !== 'village') return best;
    let stone = null;
    const t = now() / 1000;
    for (const s of stones.values()) {
      if (stoneRise(s, t) <= 0) continue;
      if (p.x >= s.px - 14 && p.x <= s.px + 14 && p.y >= s.py - 36 && p.y <= s.py + 4 && (!stone || s.py > stone.py)) stone = s;
    }
    if (stone) return stone.id;
    // The desk queue, after the sessions and the headstones: a visitor is a PR, and a session always wins.
    let visitor = null;
    for (const v of visitors.values()) {
      if (v.leaving || v.alpha < 0.35) continue;
      const [bx, by, bw, bh] = visitorBox(v.px, v.py);
      if (p.x >= bx && p.x <= bx + bw && p.y >= by && p.y <= by + bh && (!visitor || v.py > visitor.py)) visitor = v;
    }
    if (visitor) return visitor.id;
    const [cx, cy, cw, ch] = CASTLE.rect;
    if (p.x >= cx && p.x <= cx + cw && p.y >= cy && p.y <= cy + ch) return CASTLE_ID;
    const [hx, hy, hw, hh] = COTTAGE.rect;
    if (p.x >= hx && p.x <= hx + hw && p.y >= hy && p.y <= hy + hh) return COTTAGE_ID;
    const [gx, gy, gw, gh] = PATROL_HIT;
    if (p.x >= gx && p.x <= gx + gw && p.y >= gy && p.y <= gy + gh) return PATROL_ID;
    return null;
  }

  // Viewport CSS pixels at the top centre of the badge.
  function hoverPoint(id) {
    if (!view || typeof canvas.getBoundingClientRect !== 'function') return null;
    let lx;
    let ly;
    if (isIslandId(id)) {
      if (scene !== 'world') return null;
      const is = worldIslands.find((i) => i.id === id);
      if (!is) return null;
      lx = is.cx;
      ly = is.cy - is.ry - is.halo;
    } else if (id === CASTLE_ID || id === COTTAGE_ID) {
      if (scene !== 'village') return null;
      [lx, ly] = id === CASTLE_ID ? CASTLE.badge : COTTAGE.badge;
      ly -= 13;
    } else if (id === PATROL_ID) {
      if (scene !== 'village') return null;
      lx = GUARD.x;
      ly = GUARD_BOX[1];
    } else if (visitors.has(id)) {
      if (scene !== 'village') return null;
      const v = visitors.get(id);
      // The top of its head: a visitor carries no badge, so there is nothing above it for a tooltip to clear.
      lx = v.px;
      ly = visitorBox(v.px, v.py)[1];
    } else {
      const o = targetObject(id);
      if (!o) return null;
      if (o.riseAt !== undefined) {
        lx = o.px;
        ly = (o.top !== undefined ? o.top : o.py - 30) - 16 - BADGE_R;
      } else {
        const { badgeY, badgeR } = restingGeometry(o);
        lx = o.px;
        ly = badgeY - badgeR;
      }
    }
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + view.offX + lx * view.scale, y: rect.top + view.offY + ly * view.scale };
  }

  function notifyHover(id, point) {
    if (typeof onHover !== 'function') return;
    try {
      onHover(id, point);
    } catch {
      // The page's handler runs inside draw(); letting it throw would end the frame loop for good.
    }
  }

  function setHover(id) {
    if (id === hoverId) return;
    hoverId = id;
    // The guard only answers hover: nothing happens on a click, so no pointer cursor.
    if (canvas.style) canvas.style.cursor = id && id !== PATROL_ID ? 'pointer' : '';
    lastHoverPoint = id ? hoverPoint(id) : null;
    notifyHover(lastHoverPoint ? id : null, lastHoverPoint);
    requestHoverDraw();
  }

  // Runs at the end of frames that are drawn anyway, never schedules one.
  function reportHoverMove() {
    if (!hoverId) return;
    // A character that faded into the castle or walked off is gone without any pointer event.
    if (!targetOf(hoverId)) {
      setHover(null);
      return;
    }
    if (typeof onHover !== 'function') return;
    const p = hoverPoint(hoverId);
    if (!p) return;
    if (lastHoverPoint && Math.hypot(p.x - lastHoverPoint.x, p.y - lastHoverPoint.y) <= HOVER_MOVE_PX) return;
    lastHoverPoint = p;
    notifyHover(hoverId, p);
  }

  const onPointerMove = (e) => setHover(hitTest(toLogical(e)));
  const onPointerLeave = () => setHover(null);
  const onPointerDown = (e) => {
    const primary = e.isPrimary !== false && (e.button === undefined || e.button === 0);
    press = primary
      ? { id: hitTest(toLogical(e), hoverId), x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch' }
      : null;
  };
  const onPointerCancel = () => {
    press = null;
  };
  // Released anywhere, even off the canvas where no click follows: a pressed hall guest may walk on.
  const onPointerUp = () => {
    if (press) press.up = true;
  };
  // Hover only updates on pointermove, so a character can walk under a still pointer while the tooltip keeps
  // naming the one it followed. A click that lands on anything but the hovered character just re-targets the
  // hover. A touch has no hover (it leaves on release), so there the press alone has to match.
  const onClick = (e) => {
    const down = press;
    press = null;
    const id = hitTest(toLogical(e), hoverId);
    if (id !== hoverId && !(down && down.touch)) {
      setHover(id);
      return;
    }
    if (!id || !down || down.id !== id || e.detail > 1) return; // a drag, or the rest of a double-click
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;
    if (isIslandId(id)) {
      openIsland(repoOfIslandId(id));
      return;
    }
    if (id === CASTLE_ID) {
      setScene('castle');
      return;
    }
    if (id === COTTAGE_ID) {
      setScene('cottages');
      return;
    }
    if (id === PATROL_ID) return;
    // A visitor is a PR: clicking one opens it on GitHub, and the id is all that goes to the page. It is never
    // selected and never opens a session.
    if (visitors.has(id)) {
      if (typeof onOpen === 'function') onOpen(id);
      return;
    }
    const o = targetObject(id);
    if (o && o.session && o.session.canOpen === true && typeof onOpen === 'function') onOpen(id);
    else if (typeof onSelect === 'function') onSelect(id);
  };

  listen(canvas, 'pointermove', onPointerMove);
  listen(canvas, 'pointerleave', onPointerLeave);
  listen(canvas, 'pointerdown', onPointerDown);
  listen(canvas, 'pointercancel', onPointerCancel);
  listen(canvas, 'click', onClick);
  listen(doc, 'pointerup', onPointerUp);
  listen(doc, 'visibilitychange', () => {
    if (!isHidden()) {
      needsDraw = true;
      schedule();
    }
  });
  listen(mqDark, 'change', () => {
    theme = resolveTheme(pack, !!mqDark.matches);
    paintLayers();
    needsDraw = true;
    schedule();
  });
  listen(mqReduce, 'change', () => {
    reduced = !!mqReduce.matches;
    if (reduced) settleForReducedMotion();
    setSlowTimer();
    needsDraw = true;
    schedule();
  });
  if (typeof win.ResizeObserver === 'function') {
    const ro = new win.ResizeObserver(() => resize());
    ro.observe(canvas);
    cleanups.push(() => ro.disconnect());
  }

  function setScene(next) {
    if (destroyed || scene === next) return;
    press = null;
    setHover(null);
    scene = next;
    if (canvas.style) canvas.style.cursor = '';
    if (next === 'world') ensureWorldLayer();
    else if (next !== 'village') ensureSceneLayer();
    needsDraw = true;
    schedule();
    if (typeof onScene === 'function') {
      try {
        onScene(next);
      } catch {
        // Same reasoning as notifyHover: a page error must not break the village.
      }
    }
  }

  function notifyIsland(repo) {
    if (typeof islandChanged !== 'function') return;
    try {
      islandChanged(repo);
    } catch {
      // Same reasoning as notifyHover.
    }
  }

  function enterCastle() {
    setScene('castle');
  }

  function enterCottages() {
    setScene('cottages');
  }

  // One call for Escape and the page's back button, and it goes up one level: an interior closes onto the scene it
  // was opened from (the village, or the open island), an open island closes onto the world map, and the village
  // itself does not move. In one village mode it behaves exactly as it always did.
  function leaveScene() {
    if (destroyed) return;
    if (scene === 'castle' || scene === 'cottages') {
      // An interior entered straight off the world map has no island under it, and closing onto 'village' there
      // would draw every repo as one village while nothing on the page said an island was open.
      setScene(mode === 'world' && island === null ? 'world' : 'village');
      return;
    }
    leaveIsland();
  }

  // ----- modes and islands -----

  function setMode(next) {
    if (destroyed || !MODES.includes(next) || next === mode) return;
    mode = next;
    pendingIsland = null;
    if (mode === 'village') {
      const had = island !== null;
      island = null;
      applyBoard(true);
      if (had) notifyIsland(null);
      setScene('village');
      return;
    }
    // Into the world: the island last open comes back if its repo is still on the board, else the world map. A repo
    // that is not there is forgotten rather than kept, so it cannot reopen itself later if the repo comes back.
    const back = lastIsland !== null && worldRepos(validRows()).some((r) => r.repo === lastIsland) ? lastIsland : null;
    lastIsland = back;
    island = back;
    applyBoard(true);
    if (back !== null) notifyIsland(back);
    setScene(island === null ? 'world' : 'village');
  }

  // Shows one island's village. An unknown repo falls back to the world map rather than an empty island.
  function openIsland(repo) {
    if (destroyed || typeof repo !== 'string') return;
    const next = worldRepos(validRows()).some((r) => r.repo === repo) ? repo : null;
    if (mode === 'world' && island === next) {
      setScene(next === null ? 'world' : 'village');
      return;
    }
    mode = 'world';
    pendingIsland = null;
    island = next;
    if (next !== null) lastIsland = next;
    applyBoard(true);
    notifyIsland(island);
    setScene(next === null ? 'world' : 'village');
  }

  // Back out to the world map. Walking out of an island is how you say you are done with it, so it stops being the
  // island a mode round-trip returns to: the page forgets its own stored choice on the same four exits, and two
  // memories that disagree would put a reader back on an island they had deliberately left.
  function leaveIsland() {
    if (destroyed || mode !== 'world' || island === null) return;
    island = null;
    lastIsland = null;
    applyBoard(true);
    notifyIsland(null);
    setScene('world');
  }

  function setSelected(id) {
    // A visitor is never selectable: there is no session behind it. The selection it was asked to replace stays.
    if (typeof id === 'string' && visitors.has(id)) return;
    const next = typeof id === 'string' && id ? id : null;
    if (next === selectedId) return;
    selectedId = next;
    needsDraw = true;
    schedule();
  }

  // Points at one visitor at the desk, for the page's Reviews pill, and answers whether it did: true only once the
  // hover is set and the page has been told where. An interior closes first, since the desk is outside; the island
  // is the page's to choose, and it enters one before calling this. The pill sends the longest wait on screen,
  // which is slot 0 and so always drawn.
  function showVisitor(id) {
    if (destroyed || typeof id !== 'string') return false;
    if (scene === 'castle' || scene === 'cottages') leaveScene();
    if (scene !== 'village' || !visitors.has(id)) return false;
    setHover(id);
    needsDraw = true;
    schedule();
    return hoverId === id && lastHoverPoint !== null;
  }

  function start() {
    if (destroyed || started) return;
    started = true;
    needsDraw = true;
    lastT = 0;
    if (!view) resize();
    setSlowTimer();
    schedule();
  }

  function stop() {
    started = false;
    setHover(null);
    if (rafId && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(rafId);
    rafId = 0;
    if (frameTimer) {
      clearTimeout(frameTimer);
      frameTimer = 0;
    }
    setSlowTimer();
  }

  function destroy() {
    if (destroyed) return;
    stop();
    destroyed = true;
    for (const fn of cleanups.splice(0)) fn();
    chars.clear();
    visitors.clear();
    stones.clear();
    for (const name of Object.keys(guests)) guests[name] = new Map();
    bg = null;
    sceneBg = null;
    worldBg = null;
    worldIslands = [];
    islandColours = new Map();
    clearIslandCaches();
    if (canvas.style) canvas.style.cursor = '';
  }

  // A pack is paint alone, so nothing is re-laid out: the layers are repainted and the next frame is drawn. The one
  // thing a pack does decide is which line the crossing takes, and a journey already under way keeps the line it
  // was planned on: retargeting a boat mid-channel onto a line it is not on would put it across the water sideways.
  function setTheme(next) {
    if (destroyed || !THEME_KEYS.includes(next) || next === pack) return;
    pack = next;
    theme = resolveTheme(pack, theme.night);
    paintLayers();
    needsDraw = true;
    schedule();
  }

  return {
    update, setSelected, resize, start, stop, destroy, setTheme,
    enterCastle, enterCottages, leaveScene, leaveCastle: leaveScene, leaveCottages: leaveScene,
    setMode, openIsland, leaveIsland, showVisitor,
    // What is queueing at the desk on screen, and the whole board's total behind it.
    visitors: () => ({ shown: visitors.size, waiting: visitorTotal, hidden: visitorHidden, board: boardReviews() }),
    getMode: () => mode,
    getTheme: () => pack,
    getScene: () => scene,
    // The open island's repo, '' for the no-repo island, or null on the world map and in one village mode.
    getIsland: () => island,
    // The islands as drawn, so a tooltip and the map cannot disagree.
    islands: () => worldIslands.map((is) => ({ ...is, lanes: { ...is.lanes } })),
  };
}
