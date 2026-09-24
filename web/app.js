// Tokentown page: claim, polling, HUD, rail, board, card, tooltip, keys. DOM is built with createElement and
// textContent only: titles are hostile text. Pure helpers are exported for headless tests; init() runs only
// when there is a document.

// The order the server sends rows in (board.LANE_ORDER), so the rows inside a Board column read the same way
// round as the JSON.
const LANE_ORDER = [
  'needs_you', 'errored', 'your_turn', 'running', 'stopped', 'idle', 'open_pr', 'recent', 'valhalla', 'castle',
  'jail', 'graveyard',
];
const RAIL_LANES = ['needs_you', 'errored', 'your_turn'];
// The lanes whose column usually holds more rows than its cap shows, so a row that is no longer rendered hands
// focus to that column's "+N more" rather than to its header (focusFallbackLane).
export const COLLAPSIBLE_LANES = Object.freeze(['valhalla', 'castle', 'graveyard']);
// One HUD pill per key. 'valhalla' counts the beach and the sand castle together.
export const HUD_PILL_KEYS = Object.freeze([
  'needs_you', 'errored', 'your_turn', 'running', 'stopped', 'idle', 'open_pr', 'recent', 'valhalla', 'jail',
  'graveyard',
]);
// Lane ids stay as the server sends them: needs_you reads "Blocked", your_turn reads "Needs input" and jail
// reads "Jail".
export const LANE_WORD = Object.freeze({
  needs_you: 'Blocked', errored: 'Errored', your_turn: 'Needs input', running: 'Running',
  stopped: 'Stopped', idle: 'Idle', open_pr: 'PR open', jail: 'Jail', recent: 'Recent',
  valhalla: 'Valhalla', castle: 'Sand castle', graveyard: 'Graveyard',
});
export const LANE_HELP = Object.freeze({
  needs_you: 'Waiting for you to approve, answer or review a plan',
  errored: 'Rate limited, signed out or an API error',
  your_turn: 'Claude finished its turn in the last 2 hours',
  running: 'Working, or a task it started in the background still runs',
  stopped: 'Ended mid-turn',
  idle: 'Quiet for 2 hours or more',
  open_pr: 'A PR is still open',
  jail: 'A PR was closed without merging',
  recent: 'Active in the last 7 days',
  valhalla: 'A PR merged and none are still open, or marked done',
  castle: 'A PR merged and none are still open, or marked done, over 14 days ago',
  graveyard: 'Archived, or no activity for 30+ days',
});
const MERGED_HELP = 'A PR merged and none are still open';
// The Board's ten columns, left to right in workflow order, and the lanes each one holds. Every lane in
// LANE_ORDER appears exactly once: `stopped` joins Blocked and keeps its own dashed pill, and `castle` folds
// into Valhalla the way it already folds into that HUD pill. `old` is a count only, so it has no column and
// stays in the note under them.
export const COLUMN_LANES = Object.freeze({
  needs_you: ['needs_you', 'stopped'],
  errored: ['errored'],
  your_turn: ['your_turn'],
  running: ['running'],
  open_pr: ['open_pr'],
  jail: ['jail'],
  idle: ['idle'],
  recent: ['recent'],
  valhalla: ['valhalla', 'castle'],
  graveyard: ['graveyard'],
});
export const COLUMN_ORDER = Object.freeze(Object.keys(COLUMN_LANES));
// The hover title of a column header. The two columns that hold more than one lane say so; the rest read LANE_HELP.
const COLUMN_HELP = {
  needs_you: `${LANE_HELP.needs_you}. Sessions that ended mid-turn wait here too`,
  valhalla: `${LANE_HELP.valhalla}. The sand castle pill marks those over 14 days ago`,
};
// Cards a column shows before its "+N more" control. Never a silent cut: the count in the header is the whole lane.
export const COLUMN_CAP = 25;
const LANE_ICON = {
  needs_you: 'hand', errored: 'alert', your_turn: 'dots', running: 'hammer',
  stopped: 'pause', idle: 'moon', open_pr: 'merge', jail: 'bars', recent: 'clock',
  valhalla: 'merge', castle: 'castle', graveyard: 'headstone',
};
const SINCE_WORDING = {
  needs_you: 'Waiting {w}', your_turn: 'Waiting {w}', errored: 'Errored {w} ago', stopped: 'Stopped {w} ago',
  running: 'Running {w}', idle: 'Idle {w}', open_pr: 'Active {w} ago', jail: 'Active {w} ago',
  recent: 'Active {w} ago', valhalla: '{w} ago', castle: '{w} ago', graveyard: 'Active {w} ago',
};
export const CASTLE_HALL_ID = 'castle:hall';
export const COTTAGE_ROOM_ID = 'cottages:room';
export const PATROL_ID = 'harbour:patrol';
// Visitors: open PRs waiting on your review, read from GitHub. A visitor is a PR, not a session, so it is never a
// board row: no lane, no card, no column and no lane count. A hover or a click is a visitor's when the board
// lists that id, or when the id has a visitor's shape: an id whose visitor left between the board and the click
// is still one, and telling the reader its session is gone would be a lie. A session wins either test.
// Same rule as the server's paths.REVIEW_ID_RE.
export const VISITOR_ID_RE = /^pr:[0-9a-f]{16}$/;
export const REVIEWS_KEY = 'reviews';
export const REVIEWS_WORD = 'Reviews';
export const REVIEWS_HELP = 'Open PRs waiting on your review';
export const REVIEW_WORD = 'Review';
export const VISITOR_HINT = 'Click to open it on GitHub.';
export const VISITOR_GONE_TOAST = 'That review request is no longer waiting';
// Who a review request was asked of, when it names you or a team you are on without saying which team.
export const ASKED_OF_YOU = 'Asked of you';
export const ASKED_OF_A_TEAM = 'Asked of a team you are on';
// A team slug as the server may send one (its paths.TEAM_SLUG_RE, at its 40-character cut): ASCII letters, digits,
// "-" and "_". A slug is text somebody else chose, so anything else is dropped rather than shown, and a longer one
// is dropped rather than cut again.
export const TEAM_SLUG_RE = /^[A-Za-z0-9_-]{1,40}$/;
// Teams kept per visitor, and how many the tooltip names before it counts the rest.
export const VISITOR_TEAMS_MAX = 10;
export const TEAM_NAMES = 3;
// Logins a "waiting on" clause names before it counts the rest.
export const WAITING_ON_NAMES = 2;
export const SIZE_LEGEND_TEXT = 'Bigger avatars = more output tokens';
export const RAIL_KEY = 'town.rail';
// sessionStorage: the commit this tab last reloaded for, so a restart reloads it once and never again for that commit.
export const RELOADED_FOR_KEY = 'town.reloadedFor';
// One village (every session on one map, repo by avatar colour) or the World of islands (one island per repo). The
// village module owns which of the two is on screen and which island is open; the page owns the remembered choice.
// Every name below is app.js's own copy of a village.js export, because village.js loads lazily and the page has to
// work before it arrives: MODES, MODE_SHARE, NO_REPO_KEY, NO_REPO_LABEL, ISLAND_PREFIX, WORLD_BADGE_LANES.
// How the village is painted. village.js owns the palettes and every place they rename; the page owns the
// remembered choice, the dropdown's words, and the two room names that appear outside the canvas (an interior's
// crumb, and what a hover calls a room) because village.js loads lazily and the top bar has to offer the choice
// before it arrives. tests/test_web.py holds this copy and village.js's THEME_PACKS in step.
export const THEME_KEY = 'town.theme';
export const DEFAULT_THEME = 'village';
export const THEMES = Object.freeze([
  Object.freeze({ key: 'village', name: 'Village', note: 'The green village' }),
  Object.freeze({ key: 'west', name: 'Wild West', note: 'A frontier town on the dry flats' }),
  Object.freeze({ key: 'shire', name: 'Middle-earth', note: 'A green country, and a grey ship west' }),
]);
export const THEME_KEYS = Object.freeze(THEMES.map((t) => t.key));
// Both rooms, spelled out per theme rather than as overrides, so a reader can see what every theme calls them.
export const THEME_ROOMS = Object.freeze({
  village: Object.freeze({ castle: 'Valhalla sand castle', cottages: 'The Cottages' }),
  west: Object.freeze({ castle: 'Valhalla mine', cottages: 'The Counting Room' }),
  shire: Object.freeze({ castle: 'The White Halls', cottages: 'The Parlour' }),
});

export function themeFrom(key) {
  return THEME_KEYS.includes(key) ? key : DEFAULT_THEME;
}

// What a theme calls one of the two rooms. Unknown scenes have no room and answer ''.
export function roomWord(scene, theme = DEFAULT_THEME) {
  const rooms = THEME_ROOMS[themeFrom(theme)];
  return Object.prototype.hasOwnProperty.call(rooms, scene) ? rooms[scene] : '';
}

export const MODE_KEY = 'town.mode';
export const ISLAND_KEY = 'town.island';
export const MODES = Object.freeze(['village', 'world']);
// First run only: one repo holding this share of the board starts in One village, an even spread starts in the World.
export const MODE_SHARE = 0.7;
// Rows with no repo share one island, so nothing on the board is invisible in world mode. A repo name is never
// empty, so '' can never collide with one.
export const NO_REPO_KEY = '';
export const NO_REPO_LABEL = 'No repo';
// A world-map hover id, in the style of CASTLE_HALL_ID. Everything after the colon is the repo, empty for NO_REPO_KEY.
export const ISLAND_PREFIX = 'island:';
// The lanes an island wears as a badge on the world map, in this order. The world view exists to make a blocked or
// reviewable session impossible to miss, so these are the lanes that cannot wait for someone to sail in. The village
// draws them; the page keeps this copy so the keys overlay's wording can be checked against what is drawn.
export const WORLD_BADGE_LANES = Object.freeze(['needs_you', 'your_turn', 'errored', 'open_pr', 'jail']);
const CANVAS_LABEL = {
  open: 'Village of sessions. The list on the right shows sessions that are blocked, errored or need input.',
  closed: 'Village of sessions. The list is hidden: press s to show it.',
};

const ICONS = {
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5V4a1.5 1.5 0 0 1 3 0v7.5M14 11.5V5.5a1.5 1.5 0 0 1 3 0v7M17 12.5V9a1.5 1.5 0 0 1 3 0v5a7 7 0 0 1-7 7h-1.5a7 7 0 0 1-5.6-2.8l-2.6-3.7a1.6 1.6 0 0 1 2.5-2L8 14.5',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  dots: 'M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12zM8 12h.01M12 12h.01M16 12h.01',
  hammer: 'M15 12l-8.5 8.5a2.1 2.1 0 0 1-3-3L12 9M17.6 15 22 10.6M20.9 11.7l-1.3-1.3c-.6-.6-.9-1.3-.9-2.1V7.1l-2.3-2.3a5.6 5.6 0 0 0-4-1.6H9.9l.9.8a6 6 0 0 1 2 4.4V9l2 2h1.2c.8 0 1.5.3 2.1.9l1.3 1.3',
  pause: 'M8 5h2v14H8zM14 5h2v14h-2z',
  moon: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z',
  merge: 'M21 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM6 21V9a9 9 0 0 0 9 9',
  clock: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0zM12 6v6l4 2',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  paint: 'M12 3a9 9 0 0 0 0 18 2 2 0 0 0 2-2 2 2 0 0 1 2-2h1.5a3.5 3.5 0 0 0 3.5-3.5A10.5 10.5 0 0 0 12 3zM8 9h.01M7.5 13.5h.01M12 7h.01M15.5 8.5h.01',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.8 3.6M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  help: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
  info: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0zM12 16v-5M12 8h.01',
  close: 'M18 6 6 18M6 6l12 12',
  open: 'M14 3h7v7M10 14 21 3M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  headstone: 'M6 21V10a6 6 0 0 1 12 0v11M4 21h16M12 8v7M9.5 10.5h5',
  bars: 'M4 4h16v16H4zM9.3 4v16M14.7 4v16',
  castle: 'M4 21V8h2.5v2H9V8h2v2h2V8h2v2h2.5V8H20v13zM10 21v-4a2 2 0 0 1 4 0v4',
  chevronLeft: 'M15 18l-6-6 6-6',
  chevronRight: 'M9 18l6-6-6-6',
  chevronDown: 'M6 9l6 6 6-6',
  check: 'M20 6 9 17l-5-5',
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  ship: 'M3 16h18l-2.2 3.9a2 2 0 0 1-1.7 1.1H6.9a2 2 0 0 1-1.7-1.1zM12 16V3M12 4.5 18.5 13H12M12 7 6.5 13H12',
  passport: 'M6 3h9a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6zM12 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4M9.5 15.5h5',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
};

const SVG_NS = 'http://www.w3.org/2000/svg'; // XML namespace identifier, never fetched
// Same rule as the server's paths.PR_URL_RE: ASCII only, no "." or ".." segment, 1 to 10 digits.
const PR_URL_RE = /^https:\/\/github\.com\/(?!\.\.?\/)[A-Za-z0-9_.-]+\/(?!\.\.?\/)[A-Za-z0-9_.-]+\/pull\/[0-9]{1,10}$/;
const POLL_VISIBLE_MS = 2000;
const POLL_HIDDEN_MS = 15000;
const STALE_AFTER_S = 30;
const OFFLINE_AFTER_FAILURES = 3;
const POLL_TIMEOUT_MS = 10000;
const BANNER_TEXT = {
  token: 'Run tokentown in Terminal to connect',
  replayed: 'This link was already used. If that was not you, run tokentown rotate',
  offline: 'Tokentown is not responding. Run tokentown in Terminal',
};
const PLAN_STALE_MS = 30 * 60 * 1000;
const OPEN_REPEAT_MS = 1000;
const PLAN_FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const PLAN_WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
// How long a Done or Not done the server accepted outranks a board that has not rescanned yet.
export const DONE_INTENT_MS = 8000;
const UNDO_TOAST_MS = 6000;
// Dragging a card. Pointer events only, so a mouse, a trackpad and a pen all work the same way.
const DRAG_START_PX = 6;
const DRAG_EDGE_PX = 72;
const DRAG_EDGE_STEP = 28;
export const DRAG_READONLY_TOAST = 'Tokentown reads the state and cannot change it';
const DONE_REFUSED_TOAST = 'Only a finished session can go to Valhalla';
export const LEGEND_LIMIT = 12;
export const USAGE_TONES = Object.freeze({
  ok: Object.freeze({ fill: '#1565c0', text: '#ffffff' }),
  warn: Object.freeze({ fill: '#ffc107', text: '#1d2125' }),
  high: Object.freeze({ fill: '#dc3545', text: '#ffffff' }),
});

const state = {
  token: null,
  etag: null,
  board: null,
  rows: [],
  lastCheckedAt: 0,
  lastError: false,
  failures: 0,
  offline: false,
  disconnected: false,
  scanning: false,
  pollTimer: 0,
  inflight: false,
  view: 'village',
  privacy: false,
  theme: DEFAULT_THEME,
  selectedId: null,
  village: null,
  clocks: [],
  faviconKey: '',
  toastTimer: 0,
  overlayReturnFocus: null,
  usageKey: null,
  // The update banner's words when Later was pressed: it stays hidden until they change.
  updateLater: null,
  // Update now, once pressed: { key: the banner's words, phase: 'running', 'restarting' or 'failed', message }.
  updateAttempt: null,
  updateIcon: null,
  // The commit the server ran when this page first heard from it (health.updates.running).
  runningVersion: null,
  lastOpen: { id: null, at: 0, inflight: false },
  // Visitors are kept apart from `rows` on purpose: they are PRs, so nothing that counts sessions can see them.
  visitors: [],
  visitorById: new Map(),
  lastVisitorOpen: { id: null, at: 0, inflight: false },
  rail: 'open',
  scene: 'village',
  // mode: 'village' (One village) or 'world'. island: the open island's repo, or null for the world map.
  // See "the world of islands" below for which of these the page owns and which mirror the village.
  mode: 'village',
  modeChosen: false,
  island: null,
  islandWanted: null,
  islands: [],
  crumbKey: null,
  // Columns the "+N more" control has expanded, and whether a drag held the Board back from re-rendering.
  expandedColumns: new Set(),
  drag: null,
  boardStale: false,
  doneIntent: new Map(),
  doneInflight: new Set(),
  repoColour: null,
  legendKey: null,
  // hoverId: the village's hovered character. dismissedId: hidden with Escape until the hover changes.
  tip: { hoverId: null, shownId: null, anchor: null, pointer: null, dismissedId: null },
};

// ---------- small helpers ----------

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = String(text);
  return node;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'svg-icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] || ICONS.help);
  svg.appendChild(path);
  return svg;
}

// Storage accessors throw in private windows and when site data is blocked.
function storeGet(kind, key) {
  try { return window[kind].getItem(key); } catch { return null; }
}
function storeSet(kind, key, value) {
  try {
    if (value == null) window[kind].removeItem(key);
    else window[kind].setItem(key, value);
  } catch { /* per-viewer convenience only */ }
}

function int(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function waitText(since, now = Date.now()) {
  if (!Number.isFinite(since)) return '';
  const mins = Math.floor(Math.max(0, now - since) / 60000);
  if (mins < 1) return '<1 min';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ${mins % 60} min`;
  return `${Math.floor(hours / 24)} d`;
}

// 950, 1.2k, 845k, 3.4M. Rounding that reaches the next unit moves up to it (999,999 is 1M, not 1000k).
export function compactNumber(value) {
  const n = Number(value);
  const v = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  if (v < 1000) return String(v);
  const units = [['k', 1e3], ['M', 1e6], ['B', 1e9]];
  for (let i = 0; i < units.length; i++) {
    const [suffix, size] = units[i];
    const x = v / size;
    const tenths = Math.round(x * 10) / 10;
    if (tenths < 10) return `${tenths}${suffix}`;
    const whole = Math.round(x);
    if (whole < 1000 || i === units.length - 1) return `${whole}${suffix}`;
  }
  return String(v);
}

function tokenCounts(value) {
  const t = value && typeof value === 'object' ? value : {};
  return { input: int(t.input), output: int(t.output), cacheRead: int(t.cacheRead), cacheWrite: int(t.cacheWrite) };
}

// Input counts every prompt token the model processed: uncached, cache reads and cache writes.
// null: no tokens block. nothing: still counting with nothing counted yet.
function tokenParts(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const main = tokenCounts(tokens);
  const sub = tokenCounts(tokens.subagents);
  const inputOf = (t) => t.input + t.cacheRead + t.cacheWrite;
  const counting = tokens.complete === false;
  const mainAny = inputOf(main) + main.output > 0;
  const subAny = inputOf(sub) + sub.output > 0;
  if (counting && !mainAny && !subAny) return { nothing: true, counting };
  let mainText = `Output ${compactNumber(main.output)} · Input ${compactNumber(inputOf(main))}`;
  if (main.cacheRead > 0) mainText += ` (cache ${compactNumber(main.cacheRead)})`;
  if (Number.isFinite(tokens.context) && tokens.context >= 0) mainText += ` · Context ${compactNumber(tokens.context)}`;
  const subText = subAny ? { output: compactNumber(sub.output), input: compactNumber(inputOf(sub)) } : null;
  return { nothing: false, counting, main: mainText, sub: subText };
}

export function tokenLines(tokens) {
  const p = tokenParts(tokens);
  if (!p) return [];
  if (p.nothing) return ['Tokens counting...'];
  const lines = [p.main];
  if (p.sub) lines.push(`Subagents: output ${p.sub.output} · input ${p.sub.input}`);
  if (p.counting) lines[lines.length - 1] += ' · counting...';
  return lines;
}

// The tooltip's Tokens and Subagents rows, as [key, value] pairs, capitalised alike.
export function tokenRows(tokens) {
  const p = tokenParts(tokens);
  if (!p) return [];
  if (p.nothing) return [['Tokens', 'counting...']];
  const rows = [['Tokens', p.main]];
  if (p.sub) rows.push(['Subagents', `Output ${p.sub.output} · Input ${p.sub.input}`]);
  if (p.counting) rows[rows.length - 1][1] += ' · counting...';
  return rows;
}

export function startedText(s, now = Date.now()) {
  if (!s || typeof s !== 'object') return '';
  const parts = [];
  if (Number.isFinite(s.createdAt) && s.createdAt > 0) {
    const w = waitText(s.createdAt, now);
    parts.push(w === '<1 min' ? 'Started just now' : `Started ${w} ago`);
  }
  if (Number.isInteger(s.turns) && s.turns >= 0) parts.push(`${s.turns} ${s.turns === 1 ? 'turn' : 'turns'}`);
  return parts.join(' · ');
}

function sinceText(s) {
  const w = waitText(s.since);
  if (!w) return '';
  return (SINCE_WORDING[s.lane] || 'Since {w}').replace('{w}', w);
}

// Registers a node whose text depends on the clock; the 1 s tick refreshes it.
function clockNode(tag, cls, since, format) {
  const node = el(tag, cls, format());
  if (Number.isFinite(since)) state.clocks.push({ node, format });
  return node;
}

function repoText(s) {
  const repo = s.repo ? String(s.repo) : NO_REPO_LABEL;
  return s.worktree ? `${repo} / ${s.worktree}` : repo;
}

function titleFor(s, privacy) {
  if (privacy) return s.kind === 'cli' ? String(s.shortId || '') : repoText(s);
  if (s.title) return String(s.title);
  if (s.kind !== 'cli') return `Untitled ${s.shortId || ''}`;
  return `${s.surface === 'vscode' ? editorName(s) : 'Terminal'} session ${s.shortId || ''}`;
}

// Each editor's name, by a board row's `editor` (paths.EDITORS). A row without one, from an older server, is VS Code's.
export const EDITOR_NAME = Object.freeze({
  vscode: 'VS Code', 'vscode-insiders': 'VS Code Insiders', cursor: 'Cursor',
});

export function editorName(s) {
  const key = s && typeof s.editor === 'string' ? s.editor : 'vscode';
  return Object.prototype.hasOwnProperty.call(EDITOR_NAME, key) ? EDITOR_NAME[key] : EDITOR_NAME.vscode;
}

// The app a click opens the session in. A session with no desktop record that runs in an editor opens there.
export function openAppName(s) {
  return s && s.surface === 'vscode' ? editorName(s) : 'Claude';
}

// A failed open names the app it tried: the likeliest cause is that app not being installed, which trying again
// would not change.
export function openFailedText(s) {
  return `Could not open ${openAppName(s)}`;
}

// What opening a session does, in words. A session still open in its editor only has its window brought forward: the
// extension's session link would start a second copy of it rather than find it.
export function openWords(s) {
  if (s && s.surface === 'vscode' && s.live === true) {
    const name = editorName(s);
    return {
      action: `Switch to ${name}`, hint: `Click to bring its ${name} window forward`, toast: `Bringing ${name} forward`,
    };
  }
  const app = openAppName(s);
  return { action: `Open in ${app}`, hint: `Click to open in ${app}`, toast: `Opening in ${app}` };
}

// A terminal session still running has no action: Tokentown cannot bring a terminal tab forward, and its resume
// command would start a second copy of it.
export const IN_A_TERMINAL = 'Running in a terminal: switch to it there';

export function runningInTerminal(s) {
  return Boolean(s) && s.kind === 'cli' && s.live === true && s.canOpen !== true && s.canCopyResume !== true;
}

function titleText(s) {
  return titleFor(s, state.privacy);
}

// In privacy mode the title slot already shows repo / worktree, so the meta slot shows the short id.
function metaFor(s, privacy) {
  return privacy && s.kind !== 'cli' ? `#${s.shortId || ''}` : repoText(s);
}

function metaText(s) {
  return metaFor(s, state.privacy);
}

// The village plate rule, so hovering a character in privacy mode names it the way its plate does.
function plateTitle(s, privacy) {
  if (!privacy) return titleFor(s, false);
  if (s.kind === 'cli') return String(s.shortId || 'session');
  const where = s.repo && s.worktree ? `${s.worktree} · ${s.repo}` : s.worktree || s.repo;
  return String(where || s.shortId || 'session');
}

// An older server labels the your_turn lane "Your turn", and the page once called it Unread. Either is shown as the
// lane word, so it never repeats as an extra label.
const YOUR_TURN_LABELS = new Set(['your turn', 'unread', 'needs input']);

export function displayLabel(s) {
  const label = s && typeof s.label === 'string' ? s.label : '';
  return YOUR_TURN_LABELS.has(label.trim().toLowerCase()) ? LANE_WORD.your_turn : label;
}

// The muted line under a session's status in the tooltip and card: why it is in that place. Only for the lanes
// whose rule is easy to misread; a graveyard row has its Resting line and a done island row its Marked done line.
export function statusNote(s) {
  if (!s || typeof s !== 'object') return '';
  if (s.lane === 'your_turn' || s.lane === 'idle' || s.lane === 'open_pr' || s.lane === 'jail') return LANE_HELP[s.lane];
  if (valhallaReasonOf(s) === 'merged') return MERGED_HELP;
  return '';
}

// A graveyard row's "Laid to rest" line already says what its label would.
function extraLabel(s) {
  if (restText(s)) return '';
  const label = displayLabel(s);
  return label && label.toLowerCase() !== (LANE_WORD[s.lane] || '').toLowerCase() ? label : '';
}

function hintsText(s) {
  return Array.isArray(s.hints) ? s.hints.filter((h) => typeof h === 'string').join(', ') : '';
}

function findSession(id) {
  return state.rows.find((s) => s.id === id) || null;
}

// A session wins an id that is somehow in both, so a visitor can never take a session's click.
function findVisitor(id) {
  if (typeof id !== 'string' || !boardUsable() || findSession(id)) return null;
  return state.visitorById.get(id) || null;
}

// Whether a click or a hover belongs to a visitor at all, which is not the same as one still being on the board.
export function isVisitorId(id, visitors = null) {
  if (typeof id !== 'string' || !id) return false;
  if (VISITOR_ID_RE.test(id)) return true;
  const list = Array.isArray(visitors) ? visitors : state.visitors;
  return list.some((v) => v.id === id);
}

// The visitors on the board, longest wait first. Empty while disconnected or offline, like every other count.
function visitorsOnBoard() {
  return boardUsable() ? state.visitors : [];
}

// The visitors at the desk on screen: this island's while one is open, the whole board's otherwise. Same rule as
// laneCount, since the desk belongs to the island it stands on.
function reviewsHere() {
  const isle = openIslandKey();
  const visitors = visitorsOnBoard();
  return isle === null ? visitors.length : visitors.filter((v) => v.island === isle).length;
}

function validPr(pr) {
  return Boolean(pr) && typeof pr === 'object' && Number.isFinite(pr.number);
}

// "3 days ago". Days stay days, so a castle row merged in spring reads "183 days ago", not "6 months ago".
export function relativeAgo(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const mins = Math.floor(Math.max(0, now - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

const PR_WORD = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };

// "waiting on dom", from the logins GitHub says a review is requested from. Two names, then a count: a PR sent to
// a whole team lists everyone, and the tooltip is not the place to read a team roster.
export function waitingOnText(reviewers) {
  const names = [...new Set((Array.isArray(reviewers) ? reviewers : [])
    .map((r) => (typeof r === 'string' ? r.trim() : '')).filter(Boolean))];
  if (!names.length) return '';
  if (names.length <= WAITING_ON_NAMES) return `waiting on ${names.join(' and ')}`;
  const rest = names.length - WAITING_ON_NAMES;
  return `waiting on ${names.slice(0, WAITING_ON_NAMES).join(', ')} and ${rest} more`;
}

// text: the PR line ("Merged #532 · 3 days ago", "PR #532 open"). note: whether GitHub vouched for it.
// waiting: who an open PR is waiting on, when GitHub says a review is requested. short: the compact pill word for
// rows. A merge the Claude app saw cannot un-merge, so an unconfirmed MERGED carries no note; an unconfirmed OPEN
// or CLOSED can be stale.
export function prLineModel(pr, now = Date.now(), reviewers = null) {
  if (!validPr(pr)) return null;
  const st = String(pr.state || '').toUpperCase();
  const verified = pr.verified === true;
  const n = pr.number;
  const mergedAt = Number.isFinite(pr.mergedAt) && pr.mergedAt > 0 ? pr.mergedAt : null;
  const short = `PR #${n} ${PR_WORD[st] || 'state unknown'}`;
  // Only an open PR: a review request on a merged or closed one is history, not something waiting on anybody.
  const waiting = st === 'OPEN' ? waitingOnText(reviewers) : '';
  if (st === 'MERGED') {
    const ago = mergedAt === null ? '' : relativeAgo(mergedAt, now);
    return {
      state: st, short, verified, mergedAt, waiting,
      text: ago ? `Merged #${n} · ${ago}` : `Merged #${n}`,
      note: verified ? 'confirmed on GitHub' : '',
    };
  }
  if (st === 'OPEN') {
    return { state: st, short, verified, mergedAt, waiting, text: short, note: verified ? '' : 'not confirmed' };
  }
  if (st === 'CLOSED') {
    return { state: st, short, verified, mergedAt, waiting, text: short, note: verified ? 'confirmed on GitHub' : 'not confirmed' };
  }
  // UNKNOWN: a transcript PR link GitHub has not answered for yet, or gh is off.
  return { state: st || 'UNKNOWN', short, verified, mergedAt, waiting, text: short, note: verified ? '' : 'not confirmed' };
}

export function prLineText(pr, now = Date.now(), reviewers = null) {
  const m = prLineModel(pr, now, reviewers);
  if (!m) return '';
  return [m.text, m.waiting, m.note].filter(Boolean).join(' · ');
}

export function restText(s) {
  if (!s || typeof s !== 'object' || s.lane !== 'graveyard') return '';
  if (s.restReason === 'archived') return 'Laid to rest: archived';
  if (s.restReason === 'inactive') return 'Laid to rest: no activity for 30+ days';
  if (s.restReason === 'ended') return 'Laid to rest: the session ended';
  return '';
}

// What hovering the sand castle from outside shows.
export function castleHallModel(count, theme = DEFAULT_THEME) {
  const n = int(count);
  const title = roomWord('castle', theme);
  const line = `${n} ${n === 1 ? 'session' : 'sessions'} merged or marked done over 14 days ago.`;
  const hint = 'Click to go inside.';
  return { title, count: n, line, hint, text: `${title}: ${line} ${hint}` };
}

// What hovering the cottages from outside shows. Both lanes are inside the room, so both are counted: the number a
// hover promises has to be the number behind the door. A Recent row of 0 is left out, so a purely idle cottage
// reads as it always did.
export function cottageRoomModel(idleCount, recentCount, theme = DEFAULT_THEME) {
  const idle = int(idleCount);
  const recent = int(recentCount);
  const sessions = (n) => `${n} ${n === 1 ? 'session' : 'sessions'}`;
  const rows = [{ key: 'Idle', lane: 'idle', text: sessions(idle) }];
  if (recent > 0) rows.push({ key: 'Recent', lane: 'recent', text: sessions(recent) });
  const hint = 'Click to look inside.';
  const said = rows.map((r) => `${r.key}: ${r.text}`).join('. ');
  const title = roomWord('cottages', theme);
  return { title, count: idle + recent, rows, hint, text: `${title}. ${said}. ${hint}` };
}

// counts.open_pr counts sessions, not PRs: a session can have several open PRs and still queue once. `reviews` is
// the visitors queueing at the same desk, which are PRs and never sessions, so the two numbers are kept apart.
export function patrolModel(count, reviews = 0) {
  const n = int(count);
  const key = 'Waiting to merge';
  const waiting = `${n} ${n === 1 ? 'session' : 'sessions'}`;
  const r = int(reviews);
  const reviewsText = r > 0 ? `${r} ${r === 1 ? 'PR' : 'PRs'}` : '';
  const line = 'Each sails to Valhalla once a PR merges and none are still open.';
  const said = reviewsText ? `${key}: ${waiting}. ${REVIEWS_WORD}: ${reviewsText}.` : `${key}: ${waiting}.`;
  return {
    title: 'Border patrol', count: n, key, waiting, reviews: r, reviewsText, line,
    text: `Border patrol. ${said} ${line}`,
  };
}

// Which place tooltip a village hover id asks for: 'castle', 'cottages', 'patrol', 'island' or null (a session, or
// nothing). Every place stands outside, so no place tooltip shows while an interior scene is open.
export function placeTipKind(id, scene) {
  if (scene !== 'village') return null;
  if (id === CASTLE_HALL_ID) return 'castle';
  if (id === COTTAGE_ROOM_ID) return 'cottages';
  if (id === PATROL_ID) return 'patrol';
  if (repoOfIslandId(id) !== null) return 'island';
  return null;
}

// ---------- the world of islands ----------

// Which island a row belongs to, grouped by repo exactly as the legend groups it. Rows with no repo land on the
// NO_REPO_KEY island, or the world would quietly hold fewer sessions than the board.
export function repoKeyOf(s) {
  return s && typeof s === 'object' && typeof s.repo === 'string' && s.repo ? s.repo : NO_REPO_KEY;
}

export function worldLabel(repo) {
  return typeof repo === 'string' && repo ? repo : NO_REPO_LABEL;
}

export function islandHoverId(repo) {
  return ISLAND_PREFIX + (typeof repo === 'string' ? repo : NO_REPO_KEY);
}

// The repo a world-map hover id names, or null for anything else. 'island:' on its own is the no-repo island, so an
// empty string is an answer and null is the only refusal. A repo holding a colon is fine: only the prefix is cut.
export function repoOfIslandId(id) {
  if (typeof id !== 'string' || !id.startsWith(ISLAND_PREFIX)) return null;
  return id.slice(ISLAND_PREFIX.length);
}

// One entry per repo on the board: { repo, count, lanes, reviews }, alphabetical with the no-repo island last. Same
// shape and order as village.js worldRepos, and the village's own islands() answers it too, so the map, the tooltip
// and the list cannot disagree. A row whose lane the page cannot name is dropped here as it is everywhere else.
// `reviews` counts the visitors standing on that island, and only on an island that already has sessions: a review
// request in a repo nothing here works in has no island to stand on, and the HUD pill is what keeps it visible.
export function worldRepos(rows, visitors = null) {
  const seen = new Set();
  const map = new Map();
  for (const s of Array.isArray(rows) ? rows : []) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id || seen.has(s.id)) continue;
    if (!LANE_WORD[s.lane]) continue;
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

// The rows of one island, for a list that has to agree with what is on screen. A repo of null is the whole board,
// which is both One village and the world map.
export function worldRowsFor(rows, repo) {
  const list = Array.isArray(rows) ? rows : [];
  if (typeof repo !== 'string') return list.slice();
  return list.filter((s) => s && typeof s === 'object' && repoKeyOf(s) === repo);
}

// First run only: one repo holding MODE_SHARE or more of the board starts in One village, because a world of one big
// island and a few specks is a worse read of the same thing. An even spread starts in the World.
export function defaultMode(rows) {
  const repos = worldRepos(rows);
  const total = repos.reduce((sum, r) => sum + r.count, 0);
  if (repos.length < 2 || total <= 0) return 'village';
  return Math.max(...repos.map((r) => r.count)) / total >= MODE_SHARE ? 'village' : 'world';
}

// A remembered choice wins; anything else is the heuristic above. The choice is written the first time either is
// applied, so the heuristic runs once per browser rather than following the board around under the reader.
export function modeFrom(stored, rows) {
  return MODES.includes(stored) ? stored : defaultMode(rows);
}

export function nextMode(mode) {
  return mode === 'world' ? 'village' : 'world';
}

// What hovering an island on the world map shows: the repo, a Status-style row per lane that has sessions, the
// total, and how to get in. Takes a worldRepos entry, which is also what the village's islands() hands over.
// `reviews` is the PRs waiting on your review in that repo: below the total rather than inside it, because a
// visitor is a PR and the total counts sessions.
export function islandTipModel(island, reviews = 0) {
  if (!island || typeof island !== 'object' || typeof island.repo !== 'string') return null;
  const lanes = island.lanes && typeof island.lanes === 'object' ? island.lanes : {};
  const sessions = (n) => `${n} ${n === 1 ? 'session' : 'sessions'}`;
  const rows = LANE_ORDER
    .filter((lane) => int(lanes[lane]) > 0)
    .map((lane) => ({ key: LANE_WORD[lane], lane, text: sessions(int(lanes[lane])) }));
  const total = { key: 'Total', text: sessions(int(island.count)) };
  const r = int(reviews);
  const reviewsRow = r > 0 ? { key: REVIEWS_WORD, text: `${r} ${r === 1 ? 'PR waiting' : 'PRs waiting'}` } : null;
  const title = worldLabel(island.repo);
  const hint = 'Click to sail in.';
  const said = rows.map((r2) => `${r2.key}: ${r2.text}`).join('. ');
  const after = reviewsRow ? `${reviewsRow.key}: ${reviewsRow.text}. ` : '';
  return {
    title,
    rows,
    total,
    reviews: reviewsRow,
    hint,
    text: `${title}. ${said ? `${said}. ` : ''}${total.key}: ${total.text}. ${after}${hint}`,
  };
}


// The scene bar's crumbs and back button. `name` is the open island's name, or null. One village reads exactly as it
// did: Village › <scene>. The World gains a level, so an interior inside an island is World › <repo> › <scene>.
// `action` says what clicking a crumb leaves: 'root' the island and any interior, 'island' the interior only.
export function crumbModel(mode, repo, scene, theme = DEFAULT_THEME) {
  const here = SCENES[sceneName(scene)] || null;
  const world = mode === 'world';
  const inside = world && typeof repo === 'string';
  if (!here && !inside) return { open: false, crumbs: [], back: '', tone: 'muted' };
  const crumbs = [{ text: world ? 'World' : 'Village', action: 'root' }];
  if (inside) crumbs.push({ text: worldLabel(repo), action: here ? 'island' : null });
  if (here) crumbs.push({ text: roomWord(sceneName(scene), theme), action: null });
  return {
    open: true,
    crumbs,
    back: here ? 'Back to the village' : 'Back to the world',
    tone: here ? here.tone : 'muted',
  };
}

// The HUD keeps counting the whole board while an island is open, so the page says so rather than leaving two
// numbers to disagree in silence.
export function hudScopeText(repo) {
  return `Pills count every repo. On screen: ${worldLabel(repo)}.`;
}

export function railScopeText(repo) {
  return `Sessions on ${worldLabel(repo)} only.`;
}

// ---------- visitors: PRs waiting on your review ----------

const asText = (value) => (typeof value === 'string' ? value : '');

// The first of these that is a finite number above zero, else null.
function firstNumber(...values) {
  for (const v of values) if (Number.isFinite(v) && v > 0) return v;
  return null;
}

// A visitor's repo name for its tooltip. The name after the last `/`, so a source that sends `owner/repo` does not
// read as `owner/owner/repo` beside its owner.
export function visitorRepoKey(repo) {
  const name = asText(repo);
  if (!name) return NO_REPO_KEY;
  const cut = name.lastIndexOf('/');
  return cut < 0 ? name : name.slice(cut + 1);
}

// The island a visitor stands on, exactly as the server named it, or null: that one waits at the whole board's desk
// in one village mode and badges no island. Never worked out from the repo name, because anyone can open a repo
// that shares a name with one of yours, and a folder need not be named like its repo. village.js reads the same
// field the same way, or a badge would count a visitor the queue does not draw.
export function visitorIsland(v) {
  const key = v && typeof v === 'object' ? v.island : null;
  return typeof key === 'string' && key ? key : null;
}

// How a review request reached you: 'you' only when the server says exactly that (the direct search listed the PR),
// else 'team'. That is the server's own rule, so a malformed row never reads as the more urgent kind. Idempotent,
// so it reads a cleaned visitor too. village.js has to read `via` the same way, or a coat and its tooltip disagree.
export function visitorVia(v) {
  return v && typeof v === 'object' && v.via === 'you' ? 'you' : 'team';
}

// The teams a request was asked of, as GitHub's slugs: distinct, in the server's order, at most VISITOR_TEAMS_MAX.
// Only the first few dozen entries are looked at, so a hostile list costs nothing to read. Idempotent.
export function visitorTeams(v) {
  const raw = v && typeof v === 'object' && Array.isArray(v.teams) ? v.teams : [];
  const out = [];
  for (const t of raw.slice(0, VISITOR_TEAMS_MAX * 4)) {
    if (typeof t === 'string' && TEAM_SLUG_RE.test(t) && !out.includes(t)) out.push(t);
    if (out.length >= VISITOR_TEAMS_MAX) break;
  }
  return out;
}

// "a", "a and b", "a, b and c".
function namesText(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// Who a review request was asked of: "Asked of you", "Asked of team web-platform", "Asked of teams a, b and c",
// "Asked of teams a, b, c and 2 more", or, for a team request whose teams the server has not read yet, "Asked of a
// team you are on" rather than a guess. The word "team" is load-bearing: `you` is a legal slug that other people
// choose, and without it that team's request read exactly as a direct one. A request asked of you names only you,
// even when a team was asked as well: you are the one it is waiting on.
export function visitorAskedText(v) {
  if (visitorVia(v) === 'you') return ASKED_OF_YOU;
  const teams = visitorTeams(v);
  if (!teams.length) return ASKED_OF_A_TEAM;
  if (teams.length === 1) return `Asked of team ${teams[0]}`;
  if (teams.length <= TEAM_NAMES) return `Asked of teams ${namesText(teams)}`;
  return `Asked of teams ${teams.slice(0, TEAM_NAMES).join(', ')} and ${teams.length - TEAM_NAMES} more`;
}

// The board's visitors, cleaned, longest wait first (the order the server queues them in, kept here so the page
// does not depend on it). `author` is the PR author's login; `login` is read too, and `requestedAt` and `since`
// beside `waitingSince`, so a later source naming them either way still draws. A visitor with no PR number is
// dropped: the number is the one thing privacy mode still shows. A session on the same board wins an id that is
// somehow in both, the rule village.js `visitorRows` applies to the queue it draws: without it the HUD pill and an
// island badge would count a visitor the desk never draws, and nothing else compares the two numbers.
export function visitorsFrom(board) {
  const obj = board && typeof board === 'object' ? board : null;
  const list = obj && Array.isArray(obj.visitors) ? obj.visitors : [];
  const taken = new Set();
  for (const s of obj && Array.isArray(obj.sessions) ? obj.sessions : []) {
    if (s && typeof s === 'object' && typeof s.id === 'string' && s.id) taken.add(s.id);
  }
  const seen = new Set();
  const out = [];
  for (const v of list) {
    if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !v.id || seen.has(v.id)) continue;
    if (taken.has(v.id)) continue;
    const number = firstNumber(v.number, v.prNumber);
    if (number === null) continue;
    seen.add(v.id);
    out.push({
      id: v.id,
      login: asText(v.author) || asText(v.login),
      owner: asText(v.owner),
      repo: visitorRepoKey(v.repo),
      island: visitorIsland(v),
      number: Math.floor(number),
      title: asText(v.title),
      waitingSince: firstNumber(v.waitingSince, v.requestedAt, v.since),
      via: visitorVia(v),
      teams: visitorTeams(v),
    });
  }
  const waited = (v) => (v.waitingSince === null ? Infinity : v.waitingSince);
  out.sort((a, b) => waited(a) - waited(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

// Where a visitor is from: owner and repo, since a review request can be on a repo no session here works in.
export function visitorRepoText(v) {
  if (!v || typeof v !== 'object') return NO_REPO_LABEL;
  const repo = asText(v.repo);
  const owner = asText(v.owner);
  if (!repo) return NO_REPO_LABEL;
  return owner ? `${owner}/${repo}` : repo;
}

// The whole board's count, from `board.reviews.waiting`: the number the server publishes, so a source that ever
// sends fewer visitors than it counts still reports honestly. The visitor list is the fallback.
export function reviewsCount(board, visitors = null) {
  const reviews = board && typeof board === 'object' && board.reviews && typeof board.reviews === 'object'
    ? board.reviews : null;
  const sent = reviews ? firstNumber(reviews.waiting) : null;
  if (sent !== null) return Math.floor(sent);
  return (Array.isArray(visitors) ? visitors : visitorsFrom(board)).length;
}

// The whole board's count split by how each request reached you: { total, you, team }, with you + team always equal
// to the total the pill shows. The server's `reviews.viaYou` and `viaTeam` when they add up to that total, else the
// requests asked of you counted off the list, and every other request is a team's, as the server classifies them.
export function reviewsSplit(board, visitors = null) {
  const list = Array.isArray(visitors) ? visitors : visitorsFrom(board);
  const total = reviewsCount(board, list);
  const sent = board && typeof board === 'object' && board.reviews && typeof board.reviews === 'object'
    ? board.reviews : null;
  const count = (n) => Number.isInteger(n) && n >= 0;
  if (sent && count(sent.viaYou) && count(sent.viaTeam) && sent.viaYou + sent.viaTeam === total) {
    return { total, you: sent.viaYou, team: sent.viaTeam };
  }
  const you = Math.min(total, list.filter((v) => visitorVia(v) === 'you').length);
  return { total, you, team: total - you };
}

// "0 asked of you, 11 of your teams". Clamped to the count it describes, so the two parts always add up to it.
function splitText(n, split) {
  const you = Math.min(n, int(split && typeof split === 'object' ? split.you : 0));
  return `${you} asked of you, ${n - you} of your teams`;
}

// How many visitors each island holds, keyed the way repoKeyOf keys a session's island. The page's copy of
// village.js visitorsByRepo, since worldRepos has to count islands the same way the map badges them. A visitor with
// no island is in no entry: it is still in the whole board's count.
export function visitorsByRepo(list) {
  const out = new Map();
  for (const v of Array.isArray(list) ? list : []) {
    const key = visitorIsland(v);
    if (key !== null) out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
}

// The logins a row's own PR is waiting on, keyed by that PR's URL. Only rows the board shows are in the map, so
// a review request on a PR no session here links is a visitor and not a "waiting on" line.
export function waitingOnFor(board, pr) {
  const reviews = board && typeof board === 'object' && board.reviews && typeof board.reviews === 'object'
    ? board.reviews : null;
  const map = reviews && reviews.waitingOn && typeof reviews.waitingOn === 'object' ? reviews.waitingOn : null;
  const url = pr && typeof pr === 'object' ? pr.url : null;
  if (!map || typeof url !== 'string' || !PR_URL_RE.test(url)) return null;
  const logins = map[url];
  return Array.isArray(logins) ? logins : null;
}

// The HUD's Reviews pill. Its own count and its own words: it is not a lane, so it is not in HUD_PILL_KEYS and
// nothing that walks the lanes can pick it up. The count is every request; `split` (reviewsSplit) says in the
// hover and the label how many were asked of you and how many of your teams.
export function reviewsPillModel(count, split = null) {
  const n = int(count);
  const said = `${n} ${n === 1 ? 'PR waiting on your review' : 'PRs waiting on your review'}`;
  const parts = n > 0 ? splitText(n, split) : '';
  return {
    key: REVIEWS_KEY, count: n, word: REVIEWS_WORD,
    help: parts ? `${REVIEWS_HELP}. ${n} waiting: ${parts}` : REVIEWS_HELP,
    label: parts ? `${said}: ${parts}. Show where they are` : `${said}. Show where they are`,
  };
}

// What hovering a visitor shows: how long it has waited and who it was asked of, then who opened the PR, where and
// which one. Privacy mode drops the title exactly as it drops a session's, and the number stays because it is what
// the tooltip is for; the teams stay, like the author and the repo, because a team slug is not a title.
export function visitorTipModel(v, { privacy = false, now = Date.now() } = {}) {
  if (!v || typeof v !== 'object' || !Number.isFinite(v.number)) return null;
  const number = `#${v.number}`;
  const wait = waitText(v.waitingSince, now);
  const title = !privacy && v.title ? String(v.title) : `PR ${number}`;
  const via = visitorVia(v);
  const asked = visitorAskedText(v);
  const rows = [{ key: 'Waiting', kind: 'wait', text: wait ? `${REVIEW_WORD} · ${wait}` : REVIEW_WORD, note: asked }];
  if (v.login) rows.push({ key: 'Author', kind: 'text', text: String(v.login) });
  rows.push({ key: 'Repo', kind: 'text', text: visitorRepoText(v) });
  rows.push({ key: 'PR', kind: 'text', text: number });
  const said = rows.map((r) => (r.note ? `${r.key}: ${r.text}. ${r.note}` : `${r.key}: ${r.text}`)).join('. ');
  return { title, wait, via, asked, rows, hint: VISITOR_HINT, text: `${title}. ${said}. ${VISITOR_HINT}` };
}

// Every refusal the open action can answer with, so a click is never silent. A 404 always means the request has
// gone: a failed search keeps the last answer GitHub gave, so an outage never takes a visitor's URL away, and
// retrying cannot help because the next poll removes the visitor.
export function visitorOpenMessage(status) {
  if (status === 404) return VISITOR_GONE_TOAST;
  if (status === 429) return 'One moment, try again';
  return 'Could not open that PR. Try again';
}

// The notes under the Board's columns. Visitors are not sessions, so a review waiting is a note here and never a
// column, a card or a lane count. The Board is the fast view and has no desk to hover, so its note carries the
// split as well.
export function boardFootNotes(counts, reviews, split = null) {
  const c = counts && typeof counts === 'object' ? counts : {};
  const n = int(reviews);
  const parts = n > 0 ? ` (${splitText(n, split)})` : '';
  return [
    `Older ${int(c.old)}: no activity for 7 to 30 days, count only`,
    `${REVIEWS_WORD} ${n}: ${n === 1 ? 'a PR waiting' : 'PRs waiting'} on your review${parts}, at the immigration desk in the Village`,
  ];
}

// The tooltip's Resting value for graveyard rows.
export function restingText(s) {
  if (!s || typeof s !== 'object' || s.lane !== 'graveyard') return '';
  if (s.restReason === 'archived') return 'Archived';
  if (s.restReason === 'inactive') return 'No activity for 30+ days';
  if (s.restReason === 'ended') return 'The session ended';
  return '';
}

// Why an island row is there. A server from before the Done button sent only merged rows to the island.
export function valhallaReasonOf(s) {
  if (!s || typeof s !== 'object' || (s.lane !== 'valhalla' && s.lane !== 'castle')) return null;
  return s.valhallaReason === 'done' ? 'done' : 'merged';
}

export function doneText(s, now = Date.now()) {
  if (!s || typeof s !== 'object') return '';
  const ago = Number.isFinite(s.doneAt) && s.doneAt > 0 ? relativeAgo(s.doneAt, now) : '';
  return ago ? `Marked done ${ago}` : 'Marked done';
}

// Everything the village tooltip shows, top to bottom. rows: { key, kind, text } where kind says how the page
// draws the value: 'status' (pill, label, wait clock), 'pr' (PR pill and note), 'clock' (text kept current from
// format and since) or 'text'. text is always the plain value; the Status row's note (statusNote) is kept apart.
export function tooltipModel(s, { privacy = false, now = Date.now(), reviewers = null } = {}) {
  if (!s || typeof s !== 'object' || !LANE_WORD[s.lane]) return null;
  const model = [];
  if (s.model) model.push(String(s.model));
  if (s.effort) model.push(String(s.effort));
  let hint = 'Click for details';
  if (s.canOpen === true) hint = openWords(s).hint;
  else if (s.kind === 'cli' && s.canCopyResume === true) hint = 'Click to copy the resume command';
  else if (runningInTerminal(s)) hint = IN_A_TERMINAL;
  const label = extraLabel(s);
  const wait = waitText(s.since, now);
  const pr = validPr(s.pr) ? s.pr : null;
  const reason = valhallaReasonOf(s);

  const note = statusNote(s);
  const rows = [{ key: 'Status', kind: 'status', text: [LANE_WORD[s.lane], label, wait].filter(Boolean).join(' · '), note }];
  // In privacy mode the title already names the repo, so this row carries the short id instead.
  if (privacy && s.kind !== 'cli') rows.push({ key: 'Id', kind: 'text', text: metaFor(s, true) });
  else rows.push({ key: 'Repo', kind: 'text', text: repoText(s) });
  if (s.branch) rows.push({ key: 'Branch', kind: 'text', text: String(s.branch) });
  if (model.length) rows.push({ key: 'Model', kind: 'text', text: model.join(' · ') });
  const started = startedText(s, now);
  if (started) {
    rows.push({ key: 'Session', kind: 'clock', text: started, since: s.createdAt, format: (t) => startedText(s, t) });
  }
  for (const [key, text] of tokenRows(s.tokens)) rows.push({ key, kind: 'text', text });
  // A merged island row's Valhalla line is its PR line, so it is not repeated.
  if (pr && reason !== 'merged') rows.push({ key: 'PR', kind: 'pr', text: prLineText(pr, now, reviewers) });
  const resting = restingText(s);
  if (resting) rows.push({ key: 'Resting', kind: 'text', text: resting });
  if (reason === 'merged') {
    rows.push(pr ? { key: 'Valhalla', kind: 'pr', text: prLineText(pr, now, reviewers) } : { key: 'Valhalla', kind: 'text', text: 'Merged' });
  } else if (reason === 'done') {
    rows.push({ key: 'Valhalla', kind: 'clock', text: doneText(s, now), since: s.doneAt, format: (t) => doneText(s, t) });
  }

  return { title: plateTitle(s, privacy), lane: s.lane, label, wait, note, pr, rows, hint };
}

// The tooltip as [key, value] text pairs, for tests and summaries.
export function tooltipRows(s, options) {
  const m = tooltipModel(s, options);
  return m ? m.rows.map((r) => [r.key, r.text]) : [];
}

// Pill counts for the HUD, in HUD_PILL_KEYS order, plus the muted "Older" count.
export function hudPillModel(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  const n = (key) => (Object.prototype.hasOwnProperty.call(c, key) ? int(c[key]) : 0);
  const pills = HUD_PILL_KEYS.map((key) => ({
    key,
    count: key === 'valhalla' ? n('valhalla') + n('castle') : n(key),
  }));
  return { pills, older: n('old') };
}

export function railStateFrom(stored) {
  return stored === 'closed' ? 'closed' : 'open';
}

// Which Board column a lane is in. Null for a lane with no column, which is only `old` (a count, never a row).
export function columnKeyForLane(lane) {
  return COLUMN_ORDER.find((key) => COLUMN_LANES[key].includes(lane)) || null;
}

// One entry per column, left to right. `rows` is every row the column holds, in the order the server sent them,
// which is lane order inside a column too (LANE_ORDER puts needs_you before stopped, and valhalla before the
// castle). `shown` is the cards rendered: the cap, unless "+N more" has expanded the column. `count` is the whole
// column, so a capped header still reads the real number.
export function boardColumns(rows, expanded = null) {
  const list = Array.isArray(rows) ? rows : [];
  const isOpen = (key) => Boolean(expanded && typeof expanded.has === 'function' && expanded.has(key));
  return COLUMN_ORDER.map((key) => {
    const lanes = COLUMN_LANES[key];
    const own = list.filter((s) => s && typeof s.id === 'string' && lanes.includes(s.lane));
    const open = isOpen(key);
    const shown = open ? own : own.slice(0, COLUMN_CAP);
    return {
      key,
      lanes,
      title: LANE_WORD[key],
      help: COLUMN_HELP[key] || LANE_HELP[key],
      rows: own,
      shown,
      hidden: own.length - shown.length,
      expanded: open,
      count: own.length,
      parts: lanes.map((lane) => ({ lane, count: own.filter((s) => s.lane === lane).length })),
    };
  });
}

// The per-lane split of a column that holds more than one lane, once its second lane has anything in it: the header
// count is the whole column, and `stopped` keeps its own HUD pill, so the Blocked pill and the Blocked column read
// two different numbers for one word unless the split is on screen. Empty for a single-lane column, and for a
// shared one whose other lanes are at 0, where "26 + 0 stopped" would be noise.
export function columnBreakdown(col) {
  const parts = col && Array.isArray(col.parts) ? col.parts : [];
  if (parts.length < 2 || parts.slice(1).every((p) => !p.count)) return [];
  return parts.map((p, i) => ({ lane: p.lane, count: p.count, word: i === 0 ? '' : LANE_WORD[p.lane].toLowerCase() }));
}

export function columnBreakdownText(col) {
  return columnBreakdown(col).map((p) => (p.word ? `${p.count} ${p.word}` : String(p.count))).join(' + ');
}

export function columnLabel(col) {
  const n = col && Number.isFinite(col.count) ? col.count : 0;
  const split = columnBreakdown(col);
  const named = split.length
    ? `, ${split.map((p) => `${p.count} ${p.word || col.title.toLowerCase()}`).join(' and ')}`
    : '';
  return `${col.title}: ${n} ${n === 1 ? 'session' : 'sessions'}${named}. ${col.help}`;
}

// Where an arrow key goes from the card `id`. dy walks the column the card is in and stops at its ends; dx walks
// to the next column that has cards and keeps the card's place in it, as close as that column is long.
export function neighbourCardId(columns, id, dx, dy) {
  const cols = Array.isArray(columns) ? columns.filter((c) => c && Array.isArray(c.shown)) : [];
  if (!cols.length) return null;
  const at = cols.findIndex((c) => c.shown.some((s) => s.id === id));
  if (at < 0) {
    const first = cols.find((c) => c.shown.length);
    return first ? first.shown[0].id : null;
  }
  const here = cols[at];
  const row = here.shown.findIndex((s) => s.id === id);
  if (dy) {
    const next = Math.min(here.shown.length - 1, Math.max(0, row + dy));
    return here.shown[next].id;
  }
  if (!dx) return id;
  for (let i = at + dx; i >= 0 && i < cols.length; i += dx) {
    if (!cols[i].shown.length) continue;
    return cols[i].shown[Math.min(row, cols[i].shown.length - 1)].id;
  }
  return id;
}

// What dropping a card on a column does. 'mark' posts a done mark, 'unmark' takes one back, 'none' is a drop
// back where the card came from, and 'refuse' snaps it back with a message: Tokentown reads state, it cannot set
// it. Only the Valhalla column is a real move, because Done is the only state the page owns.
export function dropOutcome(row, targetKey, intent = null, now = Date.now()) {
  if (!row || typeof row !== 'object' || typeof targetKey !== 'string' || !targetKey) {
    return { action: 'none', message: '' };
  }
  const from = columnKeyForLane(row.lane);
  if (targetKey === 'valhalla') {
    if (from === 'valhalla') return { action: 'none', message: '' };
    const action = doneActionFor(row, intent, now);
    if (action === 'mark') return { action: 'mark', message: '' };
    // 'unmark' on a row not yet on the island: the mark is already sent and the board has not caught up.
    if (action === 'unmark') return { action: 'none', message: '' };
    return { action: 'refuse', message: DONE_REFUSED_TOAST };
  }
  if (from === 'valhalla') {
    if (valhallaReasonOf(row) === 'done') return { action: 'unmark', message: '' };
    return { action: 'refuse', message: `Its PR merged. ${DRAG_READONLY_TOAST}` };
  }
  if (targetKey === from) return { action: 'none', message: '' };
  return { action: 'refuse', message: DRAG_READONLY_TOAST };
}

// [name, value, warn] rows for the health panel. github is health.github from the board, or absent on an
// older server.
export function githubHealthRows(github, now = Date.now()) {
  if (!github || typeof github !== 'object') return [['Status', 'not reported', false]];
  const enabled = github.enabled === true;
  const failed = int(github.failed);
  const error = typeof github.lastError === 'string' && github.lastError ? github.lastError.slice(0, 60) : '';
  const checked = Number.isFinite(github.lastCheckedAt) && github.lastCheckedAt > 0
    ? `${waitText(github.lastCheckedAt, now)} ago` : 'not yet';
  const rows = [
    ['Status', enabled ? 'On, read-only through gh' : 'Off: gh not found, states come from the Claude app', !enabled],
    ['PRs', `${int(github.known)} known, ${failed} failed`, failed > 0],
    ['Last check', checked, false],
  ];
  // With gh missing the server's last error is "gh not found" too, and the Status row already says so.
  const repeatsStatus = !enabled && /gh not found/i.test(error);
  if (!repeatsStatus) rows.push(['Last error', error || 'none', Boolean(error)]);
  return rows;
}

export function githubHealthSummary(github) {
  if (!github || typeof github !== 'object') return 'GitHub PR states not reported';
  if (github.enabled !== true) return 'GitHub PR states off (gh not found)';
  return `GitHub PR states ${int(github.known)} known, ${int(github.failed)} failed`;
}

// The review source, in the same shape. Its own words for the off case: a PR state falls back to the Claude app's
// own copy, and a review request has nothing to fall back to, so the desk is simply empty.
export function reviewsHealthRows(reviews, now = Date.now()) {
  if (!reviews || typeof reviews !== 'object') return [['Status', 'not reported', false]];
  const enabled = reviews.enabled === true;
  const failed = int(reviews.failed);
  const error = typeof reviews.lastError === 'string' && reviews.lastError ? reviews.lastError.slice(0, 60) : '';
  const checked = Number.isFinite(reviews.lastCheckedAt) && reviews.lastCheckedAt > 0
    ? `${waitText(reviews.lastCheckedAt, now)} ago` : 'not yet';
  const rows = [
    ['Status', enabled ? 'On, read-only through gh' : 'Off: gh not found, so no visitors arrive', !enabled],
    ['Requests', `${int(reviews.known)} known, ${failed} failed`, failed > 0],
    ['Last check', checked, false],
  ];
  const repeatsStatus = !enabled && /gh not found/i.test(error);
  if (!repeatsStatus) rows.push(['Last error', error || 'none', Boolean(error)]);
  return rows;
}

export function reviewsHealthSummary(reviews) {
  if (!reviews || typeof reviews !== 'object') return 'Review requests not reported';
  if (reviews.enabled !== true) return 'Review requests off (gh not found)';
  return `Review requests ${int(reviews.known)} known, ${int(reviews.failed)} failed`;
}

// health.updates: whether this copy of Tokentown is behind GitHub (the server's updates.UpdateChecker), keyed by
// its reason words when it is not checked at all.
export const UPDATE_REASONS = Object.freeze({
  'gh not found': 'Off: gh not found, so Tokentown cannot ask GitHub',
  'not a git clone': 'Off: this copy is not a git clone',
  'not on main': 'Off: this copy is not on its main branch',
  'no GitHub origin': 'Off: its origin is not on GitHub',
  'git files unreadable': 'Off: its git files could not be read',
});

// The same shape as the server's paths.RELEASE_TAG_RE: v1.2.0 and its like, and nothing a tag could hide text in.
const RELEASE_TAG_RE = /^v?[0-9]{1,6}(?:\.[0-9]{1,6}){0,3}$/;

function releaseTag(value) {
  return typeof value === 'string' && RELEASE_TAG_RE.test(value) ? value : null;
}

function latestTag(updates) {
  return updates && updates.latest && typeof updates.latest === 'object' ? releaseTag(updates.latest.tag) : null;
}

// The banner only offers something to do: changes to pull, or a pull that needs a restart before it runs. A pull
// comes first, since it restarts Tokentown too. Update now needs git and an https origin (canPull): without them
// the banner hands over the command for Terminal instead, as it does after Update now fails.
export function updateNoticeModel(updates) {
  if (!updates || typeof updates !== 'object' || updates.enabled !== true) return null;
  const tag = latestTag(updates);
  if (updates.state === 'behind' && tag) {
    const yours = releaseTag(updates.version);
    return {
      kind: 'pull',
      text: `Tokentown ${tag} is out.${yours ? ` You have ${yours}.` : ''}`,
      canRun: updates.canPull === true,
      button: 'Update now',
      busy: 'Updating\u2026',
      how: `Fetches ${tag} with git, fast-forwards your Tokentown folder to it and restarts Tokentown`,
      copyButton: 'Copy the update command',
      copyHow: `A command for Terminal that fast-forwards your Tokentown folder to ${tag}, then restarts Tokentown`,
      copied: `Update command copied. Paste it into Terminal: it updates to ${tag} and restarts Tokentown`,
    };
  }
  if (updates.restart === true) {
    return {
      kind: 'restart',
      text: 'Tokentown has changed on disk since it started, as after a git pull. Restart it to run the new version.',
      canRun: true,
      button: 'Restart now',
      busy: 'Restarting…',
      how: 'Restarts Tokentown to run the version on disk',
      copyButton: 'Copy the restart command',
      copyHow: 'A command for Terminal that runs tokentown stop and then tokentown in your Tokentown folder',
      copied: 'Restart command copied. Paste it into Terminal',
    };
  }
  return null;
}

export const UPDATE_RESTARTING_TEXT = 'Updated. Tokentown is restarting, and this page reloads once it is back.';

// Why Update now did not finish, from the server's step and its exit code or exception class. Only a start check
// that failed has changed anything: the pulled code is on disk, and the old server still runs.
export function updateFailureText(step, error) {
  const why = typeof error === 'string' && error ? ` (${error.slice(0, 40)})` : '';
  if (step === 'fetch') return `Could not fetch the changes from GitHub${why}. Nothing changed.`;
  if (step === 'merge' && error === 'exit 1') {
    return 'A local edit in your Tokentown folder is in the way, so git left it as it was. Nothing changed.';
  }
  if (step === 'merge') return `git would not fast-forward your Tokentown folder${why}. Nothing changed.`;
  if (step === 'start') {
    return `The changes are on disk, but the new version would not start${why}, so Tokentown kept running the old `
      + 'one. Run tokentown stop, then tokentown serve, in Terminal to see why.';
  }
  return `Could not update${why}.`;
}

// The page reloads when the server runs a new commit, once per commit, so two servers taking turns cannot loop it.
export function shouldReloadFor(seen, running, reloadedFor) {
  return typeof seen === 'string' && typeof running === 'string' && running !== '' && running !== seen
    && running !== reloadedFor;
}

function updateStateText(updates) {
  const tag = latestTag(updates);
  if (updates.state === 'behind' && tag) return `Older than ${tag}, the newest release`;
  if (updates.restart === true) return 'Changed on disk: restart Tokentown to run it';
  if (updates.state === 'current' && tag) return `Up to date: ${tag}`;
  if (updates.state === 'ahead' && tag) return `Newer than ${tag}: changes not released yet`;
  if (updates.state === 'diverged' && tag) return `Differs from ${tag}`;
  const checked = Number.isFinite(updates.lastCheckedAt) && updates.lastCheckedAt > 0;
  if (!tag && checked && !updates.lastError) return 'No release published yet';
  return 'Not checked yet';
}

// The version this copy runs: its release tag when it has one, and its commit either way.
function versionText(updates) {
  const running = typeof updates.running === 'string' && /^[0-9a-f]{40}$/.test(updates.running)
    ? updates.running.slice(0, 7) : null;
  const tag = releaseTag(updates.version);
  if (tag) return running ? `${tag} (${running})` : tag;
  return running ? `${running}, not a release` : 'unknown';
}

export function updateHealthRows(updates, now = Date.now()) {
  if (!updates || typeof updates !== 'object') return [['Status', 'not reported', false]];
  if (updates.enabled !== true) {
    const reason = typeof updates.reason === 'string' ? updates.reason : '';
    const known = Object.hasOwn(UPDATE_REASONS, reason);
    return [['Status', known ? UPDATE_REASONS[reason] : 'Off', reason === 'gh not found']];
  }
  const error = typeof updates.lastError === 'string' && updates.lastError ? updates.lastError.slice(0, 60) : '';
  const checked = Number.isFinite(updates.lastCheckedAt) && updates.lastCheckedAt > 0
    ? `${waitText(updates.lastCheckedAt, now)} ago` : 'not yet';
  const tag = latestTag(updates);
  const published = tag && Number.isFinite(updates.latest.published) ? `, ${releaseDate(updates.latest.published)}` : '';
  return [
    ['Status', 'On, asks GitHub about once an hour through gh', false],
    ['Version', versionText(updates), false],
    ['Newest release', tag ? `${tag}${published}` : 'none yet', false],
    ['This copy', updateStateText(updates), false],
    ['Update now', updates.canPull === true ? 'Updates with git when you press it'
      : 'Copies the command instead: it needs git and an https origin', false],
    ['Last check', checked, false],
    ['Last error', error || 'none', Boolean(error)],
  ];
}

export function releaseDate(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

// Release notes are Markdown on GitHub. Here they stay text: a heading, a bullet or a paragraph a line, with the
// emphasis marks dropped, and never a link, an image or any markup.
export function releaseNoteBlocks(notes) {
  if (typeof notes !== 'string') return [];
  const blocks = [];
  for (const raw of notes.split('\n').slice(0, 200)) {
    const line = raw.replace(/\*\*|__|`/g, '').trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    const bullet = /^[*+-]\s+(.+)$/.exec(line);
    if (heading) blocks.push({ kind: 'h', text: heading[1].slice(0, 200) });
    else if (bullet) blocks.push({ kind: 'li', text: bullet[1].slice(0, 400) });
    else blocks.push({ kind: 'p', text: line.slice(0, 800) });
  }
  return blocks;
}

// What's new, newest first: the newest marked, the one this copy runs marked as yours, and every release after
// yours marked new. With no version of its own, only the newest counts as new, and only while this copy is older.
export function releaseListModel(releases, updates = null) {
  const list = (Array.isArray(releases) ? releases : [])
    .filter((r) => r && typeof r === 'object' && releaseTag(r.tag))
    .slice(0, 10);
  const yours = updates ? releaseTag(updates.version) : null;
  const yoursAt = yours ? list.findIndex((r) => r.tag === yours) : -1;
  const older = Boolean(updates && updates.state === 'behind');
  return list.map((r, i) => ({
    tag: r.tag,
    name: typeof r.name === 'string' && r.name && r.name !== r.tag ? r.name.slice(0, 200) : '',
    date: releaseDate(r.published),
    blocks: releaseNoteBlocks(r.notes),
    newest: i === 0,
    yours: i === yoursAt,
    fresh: yoursAt >= 0 ? i < yoursAt : older && i === 0,
  }));
}

export function updateHealthSummary(updates) {
  if (!updates || typeof updates !== 'object') return 'Updates not reported';
  if (updates.enabled !== true) return `Updates off (${String(updates.reason || 'unknown').slice(0, 40)})`;
  return `Updates: ${updateStateText(updates)}`;
}

// What a Done control does for a row: 'mark' (send to Valhalla), 'unmark' (bring back) or null (no control).
// intent is the last change the server accepted for this row, { done, at }. The board only changes on the next
// scan, so for DONE_INTENT_MS a fresh intent the board does not show yet decides, and the control flips at once.
export function doneActionFor(row, intent = null, now = Date.now()) {
  if (!row || typeof row !== 'object') return null;
  const isDone = row.valhallaReason === 'done';
  const fresh = intent && typeof intent === 'object' && Number.isFinite(intent.at) && now - intent.at < DONE_INTENT_MS;
  if (fresh && intent.done === true && !isDone && row.canMarkDone === true) return 'unmark';
  if (fresh && intent.done === false && isDone) return 'mark';
  if (isDone) return 'unmark';
  return row.canMarkDone === true ? 'mark' : null;
}

// True once the board shows what the intent asked for, or the intent is too old to trust.
export function doneIntentSettled(row, intent, now = Date.now()) {
  if (!row || !intent || !Number.isFinite(intent.at) || now - intent.at >= DONE_INTENT_MS) return true;
  return (row.valhallaReason === 'done') === (intent.done === true);
}

const COLOUR_RE = /^(#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s/+-]{1,60}\))$/;

// village.js repoColour may answer a CSS colour string, or { light, dark } / { fill }. Anything else: no swatch.
export function legendColour(value, dark = false) {
  let v = value;
  if (v && typeof v === 'object') v = (dark && v.dark) || v.light || v.fill || v.body || null;
  return typeof v === 'string' && COLOUR_RE.test(v.trim()) ? v.trim() : null;
}

// The repo legend: each repo with a character in the village, its colour and how many. colourFor is village.js
// repoColour(repo, repos), called with every repo a character wears, sorted, which is what the village uses too.
// Headstones carry no colour, so graveyard rows are left out of the repos, the entries and the counts: a repo seen
// only in the graveyard would otherwise take a palette entry and could push two visible repos onto one colour.
export function repoLegendModel(rows, colourFor, { limit = LEGEND_LIMIT, dark = false } = {}) {
  const list = Array.isArray(rows) ? rows.filter((s) => s && typeof s === 'object') : [];
  const nameOf = (s) => (typeof s.repo === 'string' && s.repo ? s.repo : null);
  const repos = [...new Set(list.filter((s) => s.lane !== 'graveyard').map(nameOf).filter(Boolean))].sort();
  const counts = new Map();
  for (const s of list) {
    if (s.lane === 'graveyard') continue;
    const name = nameOf(s);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const entries = [...counts].map(([repo, count]) => {
    let colour = null;
    if (typeof colourFor === 'function') {
      try { colour = legendColour(colourFor(repo, repos), dark); } catch { colour = null; }
    }
    return { repo, label: worldLabel(repo), count, colour };
  });
  entries.sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const cap = Math.max(1, int(limit));
  return { entries: entries.slice(0, cap), more: Math.max(0, entries.length - cap) };
}

export function usageTone(pct) {
  return pct >= 90 ? 'high' : pct >= 70 ? 'warn' : 'ok';
}

// null hides the bars. A value past its window reads as "no recent reading" even if the board still carries it.
export function usageBarModel(planUsage, now = Date.now()) {
  if (!planUsage || typeof planUsage !== 'object') return null;
  const sampledAt = Number.isFinite(planUsage.sampledAt) && planUsage.sampledAt > 0 ? planUsage.sampledAt : null;
  const age = sampledAt === null ? Infinity : now - sampledAt;
  const stale = planUsage.stale === true || age > PLAN_STALE_MS;
  const bar = (key, label, value, maxAge) => {
    if (!Number.isFinite(value) || age > maxAge) return { key, label, pct: null, tone: null, fill: null, text: null };
    const pct = Math.min(100, Math.max(0, Math.round(value)));
    const tone = usageTone(pct);
    return { key, label, pct, tone, fill: USAGE_TONES[tone].fill, text: USAGE_TONES[tone].text };
  };
  return {
    stale,
    asOf: stale && sampledAt !== null ? `as of ${sampleTime(sampledAt, now)}` : '',
    bars: [
      bar('fiveHour', '5-hour', planUsage.fiveHourPct, PLAN_FIVE_HOUR_MS),
      bar('weekly', 'Weekly', planUsage.weeklyPct, PLAN_WEEKLY_MS),
    ],
  };
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.right) - Math.max(a.x, b.left);
  const h = Math.min(a.y + a.h, b.bottom) - Math.max(a.y, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

export const TIP_MIN_HEIGHT = 56;

// anchor: top centre of the hovered badge. pointer: last pointer position. size: {w, h}. bounds: a DOMRect-like
// box to stay inside. Tries above the badge, then right, left and below the pointer. Takes the first that clears
// both the cursor (the arrow hangs down and right of its hotspot) and the character, else the first that clears
// the cursor. In a stage too small for either, it sits wholly above or below the cursor, on the roomier side, with
// maxHeight cutting it to fit; null when neither side has TIP_MIN_HEIGHT. Returns { x, y, maxHeight } or null.
export function placeTooltip(anchor, pointer, size, bounds, margin = 8) {
  const w = Math.max(0, size.w);
  const h = Math.max(0, size.h);
  const minX = bounds.left + margin;
  const minY = bounds.top + margin;
  const maxX = Math.max(minX, bounds.right - margin - w);
  const maxY = Math.max(minY, bounds.bottom - margin - h);
  const p = pointer || { x: anchor.x, y: anchor.y + 24 };
  const cursor = { left: p.x - 6, right: p.x + 22, top: p.y - 6, bottom: p.y + 28 };
  const figure = { left: anchor.x - 24, right: anchor.x + 24, top: anchor.y, bottom: Math.max(anchor.y, p.y) + 30 };
  const candidates = [
    { x: anchor.x - w / 2, y: anchor.y - 10 - h },
    { x: p.x + 28, y: p.y - h / 2 },
    { x: p.x - 18 - w, y: p.y - h / 2 },
    { x: anchor.x - w / 2, y: p.y + 36 },
  ];
  let clearOfCursor = null;
  for (const c of candidates) {
    const box = { x: Math.min(maxX, Math.max(minX, c.x)), y: Math.min(maxY, Math.max(minY, c.y)), w, h };
    if (overlapArea(box, cursor) > 0) continue;
    if (overlapArea(box, figure) === 0) return { x: box.x, y: box.y, maxHeight: null };
    if (!clearOfCursor) clearOfCursor = box;
  }
  if (clearOfCursor) return { x: clearOfCursor.x, y: clearOfCursor.y, maxHeight: null };
  const roomAbove = cursor.top - minY;
  const roomBelow = bounds.bottom - margin - cursor.bottom;
  const room = Math.max(roomAbove, roomBelow);
  if (room < Math.min(h, TIP_MIN_HEIGHT)) return null;
  const fit = Math.min(h, room);
  return {
    x: Math.min(maxX, Math.max(minX, anchor.x - w / 2)),
    y: roomAbove >= roomBelow ? cursor.top - fit : cursor.bottom,
    maxHeight: fit < h ? fit : null,
  };
}

// action: { label, run } adds one button, such as Undo, and keeps the toast up for at least UNDO_TOAST_MS.
function toast(message, ms = 2600, action = null) {
  const node = $('toast');
  node.replaceChildren(el('span', 'toast-text', message));
  if (action) {
    const btn = el('button', 'toast-action', action.label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      hideToast();
      action.run();
    });
    node.append(btn);
  }
  node.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(hideToast, action ? Math.max(ms, UNDO_TOAST_MS) : ms);
}

function hideToast() {
  const node = $('toast');
  clearTimeout(state.toastTimer);
  if (node.hidden) return;
  // A keyboard user on the Undo button would otherwise be left focused on nothing. The card may be one the cap
  // holds back, which is why this goes through focusSession rather than rowElement.
  const hadFocus = node.contains(document.activeElement);
  node.hidden = true;
  node.replaceChildren();
  if (hadFocus) focusSession(state.selectedId);
}

// ---------- shared pieces ----------

function statusPill(lane, word = LANE_WORD[lane]) {
  const pill = el('span', `pill st-${lane}`);
  pill.append(icon(LANE_ICON[lane]), el('span', null, word));
  return pill;
}

// A visitor's pill. Its own teal and a passport glyph: not a lane, so it borrows no lane's colour.
function visitorPill(word = REVIEW_WORD) {
  const pill = el('span', 'pill st-visitor');
  pill.append(icon('passport'), el('span', null, word));
  return pill;
}

// full: the PR line with the merge age (tooltip, card). Otherwise the compact word that fits a row.
function prPill(pr, { link: asLink = false, full = false } = {}) {
  const m = prLineModel(pr);
  if (!m) return null;
  const link = asLink && typeof pr.url === 'string' && PR_URL_RE.test(pr.url);
  const tone = m.state === 'OPEN' ? 'st-open_pr' : m.state === 'MERGED' ? 'st-valhalla' : 'st-muted';
  const node = el(link ? 'a' : 'span', `pill pr-pill ${tone}`);
  if (m.note === 'not confirmed') node.classList.add('unverified');
  node.title = m.verified ? 'State confirmed on GitHub' : 'State from the Claude app, not confirmed on GitHub';
  const text = full && m.mergedAt !== null
    ? clockNode('span', null, m.mergedAt, () => (prLineModel(pr) || m).text)
    : el('span', null, full ? m.text : m.short);
  node.append(icon('merge'), text);
  if (link) {
    node.href = pr.url;
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
  }
  return node;
}

// The full PR line: pill, who it waits on, then the muted confirmation note.
function prLineNodes(pr, link) {
  const pill = prPill(pr, { link, full: true });
  if (!pill) return [];
  const m = prLineModel(pr, Date.now(), waitingOnFor(state.board, pr));
  const nodes = [pill];
  if (m.waiting) nodes.push(el('span', 'pr-note pr-waiting', m.waiting));
  if (m.note) nodes.push(el('span', 'pr-note', m.note));
  return nodes;
}

function emptyBox(heading, detail) {
  const box = el('div', 'empty');
  box.append(el('strong', null, heading));
  if (detail) box.append(el('span', null, detail));
  return box;
}

function unavailableBox() {
  if (state.disconnected) return emptyBox('Not connected', 'Run tokentown in Terminal');
  if (state.offline) return emptyBox('Tokentown is not responding', 'Sessions show again when it answers');
  return emptyBox(state.scanning ? 'Scanning sessions' : 'Waiting for the server', null);
}

// Re-renders replace every row, so remember which control inside which row had focus. Without this, focus
// falls to the body and Enter opens the selected session instead of the focused one.
function focusedRowId(container) {
  const active = document.activeElement;
  if (!active || !container.contains(active)) return null;
  const row = active.closest('[data-id]');
  if (!row) return null;
  const kind = active.closest('.kcard-actions') ? 'action' : active.classList.contains('kcard-main') ? 'main' : 'row';
  return { id: row.dataset.id, kind, action: active.dataset ? active.dataset.action || null : null };
}

// Where keyboard focus goes when its row is no longer rendered and its column's cap holds it back: that column's
// "+N more" (Done sends a row to Valhalla, where the cap usually bites). Null when the row left the board, or is
// in a column that shows all of its cards, where the column header takes focus instead.
export function focusFallbackLane(focus, rows, isOpen) {
  if (!focus || typeof focus.id !== 'string' || !Array.isArray(rows)) return null;
  const row = rows.find((s) => s && s.id === focus.id);
  if (!row || !COLLAPSIBLE_LANES.includes(row.lane)) return null;
  return typeof isOpen === 'function' && isOpen(row.lane) ? null : row.lane;
}

// True when focus went back onto a control of the same row.
function restoreFocus(container, focus) {
  if (!focus) return false;
  const row = container.querySelector(`[data-id="${CSS.escape(focus.id)}"]`);
  if (!row) return false;
  const candidates = [];
  if (focus.kind === 'action' && focus.action) {
    candidates.push(row.querySelector(`.kcard-actions button[data-action="${CSS.escape(focus.action)}"]`));
  }
  if (focus.kind === 'action') candidates.push(row.querySelector('.kcard-actions button'));
  if (focus.kind !== 'row') candidates.push(row.querySelector('.kcard-main'));
  candidates.push(row.tabIndex >= 0 ? row : null);
  const target = candidates.find(Boolean);
  if (target) target.focus({ preventScroll: true });
  return Boolean(target);
}

// Rows and counts are only shown while the server is answering: a stale Blocked must not keep signalling.
function boardUsable() {
  return Boolean(state.board) && !state.disconnected && !state.offline;
}

function setBanner(reason) {
  const banner = $('connect-banner');
  if (!reason) {
    banner.hidden = true;
    return;
  }
  $('connect-text').textContent = BANNER_TEXT[reason] || BANNER_TEXT.token;
  banner.hidden = false;
}

// ---------- claim and polling ----------

// Resolves to 'none' (no code in the address), 'ok', 'replayed' (the server saw this code claimed
// already) or 'failed'.
async function claimFromHash() {
  const hash = location.hash;
  if (!hash.startsWith('#c=')) return 'none';
  let code = hash.slice(3);
  // Strip the code from the address bar and history before anything else can read it.
  history.replaceState(null, '', location.pathname + location.search);
  try { code = decodeURIComponent(code); } catch { return 'failed'; }
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(code)) return 'failed';
  try {
    const res = await fetch('/api/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      cache: 'no-store',
      credentials: 'omit',
    });
    if (res.status === 409) return 'replayed';
    if (!res.ok) return 'failed';
    const data = await res.json();
    if (typeof data.token !== 'string' || !/^[A-Za-z0-9._-]{16,256}$/.test(data.token)) return 'failed';
    state.token = data.token;
    storeSet('sessionStorage', 'town.token', data.token);
    return 'ok';
  } catch {
    return 'failed';
  }
}

const REPLAYED_TOAST = 'This link was already used. If that was not you, run tokentown rotate';

async function connect() {
  const claim = await claimFromHash();
  if (claim !== 'ok') state.token = storeGet('sessionStorage', 'town.token');
  if (!state.token) {
    setDisconnected(claim === 'replayed' ? 'replayed' : 'token');
    return;
  }
  if (claim === 'replayed') toast(REPLAYED_TOAST, 12000);
  setConnected();
  poll();
}

function setConnected() {
  state.disconnected = false;
  state.offline = false;
  state.failures = 0;
  state.etag = null;
  setBanner(null);
  document.body.classList.remove('disconnected');
  renderAll();
  updateChecked();
}

function setDisconnected(reason = 'token') {
  state.disconnected = true;
  state.offline = false;
  state.token = null;
  state.etag = null;
  state.board = null;
  state.rows = [];
  state.islands = [];
  state.visitors = [];
  state.visitorById = new Map();
  state.selectedId = null;
  state.expandedColumns.clear();
  endDrag();
  storeSet('sessionStorage', 'town.token', null);
  clearTimeout(state.pollTimer);
  setBanner(reason);
  document.body.classList.add('disconnected');
  // islandWanted is left alone, so reconnecting sails back to the island rather than to the world map.
  setIslandNow(null);
  renderAll();
  withVillage((v) => {
    v.update({ counts: {}, sessions: [], visitors: [] }, villageOptions());
    v.setSelected(null);
  });
  leaveScene();
  updateChecked();
}

function enterOffline() {
  if (state.offline || state.disconnected) return;
  state.offline = true;
  setBanner('offline');
  document.body.classList.add('disconnected');
  setIslandNow(null);
  renderAll();
  withVillage((v) => v.update({ counts: {}, sessions: [], visitors: [] }, villageOptions()));
  leaveScene();
}

function leaveOffline() {
  if (!state.offline) return;
  state.offline = false;
  setBanner(null);
  document.body.classList.remove('disconnected');
  renderAll();
  if (state.board) {
    withVillage((v) => {
      v.update(state.board, villageOptions());
      v.setSelected(state.selectedId);
    });
  }
  // After the village has the board back, never before: on the 304 path it still holds the blank board the outage
  // left it, and openIsland would fall straight back to the map for a repo that is not in it yet.
  reconcileIsland();
}

function noteFailure() {
  state.lastError = true;
  state.failures += 1;
  const staleMs = state.lastCheckedAt ? Date.now() - state.lastCheckedAt : 0;
  if (state.failures >= OFFLINE_AFTER_FAILURES || staleMs > STALE_AFTER_S * 1000) enterOffline();
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (state.disconnected || !state.token) return;
  state.pollTimer = setTimeout(poll, document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
}

async function poll() {
  clearTimeout(state.pollTimer);
  if (state.inflight || state.disconnected || !state.token) return;
  state.inflight = true;
  // A server that accepts the connection and never answers would otherwise leave this poll pending forever.
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const abortTimer = controller ? setTimeout(() => controller.abort(), POLL_TIMEOUT_MS) : 0;
  try {
    const headers = { 'X-Town-Token': state.token };
    if (state.etag) headers['If-None-Match'] = state.etag;
    const res = await fetch('/api/board', {
      headers, cache: 'no-store', credentials: 'omit', signal: controller ? controller.signal : undefined,
    });
    if (res.status === 401) {
      setDisconnected('token');
    } else if (res.status === 304) {
      markChecked();
      leaveOffline();
    } else if (res.status === 503) {
      state.scanning = true;
      markChecked();
      if (state.offline) {
        // The server restarted while we were offline: the board we kept is from before the outage.
        state.board = null;
        state.rows = [];
        state.islands = [];
        state.etag = null;
      }
      leaveOffline();
      if (!state.board) renderViews();
    } else if (res.ok) {
      const board = await res.json();
      if (!board || typeof board !== 'object' || !Array.isArray(board.sessions)) throw new TypeError('board shape');
      state.etag = res.headers.get('ETag');
      state.scanning = false;
      markChecked();
      state.offline = false;
      setBanner(null);
      document.body.classList.remove('disconnected');
      acceptBoard(board);
    } else {
      noteFailure();
    }
  } catch {
    noteFailure();
  } finally {
    clearTimeout(abortTimer);
    state.inflight = false;
    updateChecked();
    schedulePoll();
  }
}

function markChecked() {
  state.lastCheckedAt = Date.now();
  state.lastError = false;
  state.failures = 0;
}

function updateChecked() {
  const node = $('checked');
  if (state.disconnected) {
    node.textContent = 'Not connected';
    node.classList.add('stale');
    return;
  }
  if (state.offline) {
    const secs = state.lastCheckedAt ? Math.floor(Math.max(0, Date.now() - state.lastCheckedAt) / 1000) : 0;
    node.textContent = !state.lastCheckedAt ? 'Not responding'
      : secs < 60 ? `Not responding. Last answer ${secs} s ago` : `Not responding. Last answer ${Math.floor(secs / 60)} min ago`;
    node.classList.add('stale');
    return;
  }
  if (!state.lastCheckedAt) {
    node.textContent = state.lastError ? 'Server not responding' : 'Connecting';
    node.classList.toggle('stale', state.lastError);
    return;
  }
  const secs = Math.floor(Math.max(0, Date.now() - state.lastCheckedAt) / 1000);
  let text = secs < 60 ? `Checked ${secs} s ago` : `Checked ${Math.floor(secs / 60)} min ago`;
  if (state.lastError) text = `Server not responding. ${text}`;
  node.textContent = text;
  node.classList.toggle('stale', state.lastError || secs > STALE_AFTER_S);
}

function acceptBoard(board) {
  state.board = board;
  noteRunningVersion(board);
  state.rows = board.sessions.filter((s) => s && typeof s.id === 'string' && LANE_WORD[s.lane]);
  // Visitors never reach `rows`: a PR waiting on a review is not a session and must not become one. They reach
  // `islands` only as their own count, which is what the map badges and the island tooltip read.
  state.visitors = visitorsFrom(board);
  state.visitorById = new Map(state.visitors.map((v) => [v.id, v]));
  state.islands = worldRepos(state.rows, state.visitors);
  if (state.selectedId && !findSession(state.selectedId)) state.selectedId = null;
  const now = Date.now();
  for (const [id, intent] of state.doneIntent) {
    if (doneIntentSettled(findSession(id), intent, now)) state.doneIntent.delete(id);
  }
  renderAll();
  withVillage((v) => {
    v.update(board, villageOptions());
    v.setSelected(state.selectedId);
  });
  // Both of these come after the update, never before. The village lays the world out from the board it holds, so a
  // mode set before its first board would have it build a world of no islands; and it resolves a remembered island
  // on that first board, which is the answer reconcileIsland reads.
  if (!state.modeChosen && state.rows.length) setMode(defaultMode(state.rows), true);
  reconcileIsland();
  refreshTip();
}

// ---------- peripheral signals ----------

function alertCount() {
  return boardUsable() ? int(state.board.alert) : 0;
}

function renderSignals() {
  const alert = alertCount();
  document.title = alert > 0 ? `(${alert}) Tokentown` : 'Tokentown';
  $('edge-band').hidden = alert === 0;
  drawFavicon(state.disconnected || state.offline ? 'warn' : alert > 0 ? 'alert' : 'calm', alert);
}

function drawFavicon(mode, count) {
  const key = `${mode}:${count}`;
  if (key === state.faviconKey) return;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  if (!g) return;
  state.faviconKey = key;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (mode === 'warn') {
    g.fillStyle = '#dc3545';
    g.beginPath();
    g.moveTo(32, 3);
    g.lineTo(62, 59);
    g.lineTo(2, 59);
    g.closePath();
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = 'bold 36px system-ui, -apple-system, sans-serif';
    g.fillText('!', 32, 40);
  } else if (mode === 'alert') {
    g.fillStyle = '#fd7e14';
    g.beginPath();
    g.arc(32, 32, 31, 0, Math.PI * 2);
    g.fill();
    const text = count > 99 ? '99+' : String(count);
    g.fillStyle = '#1d2125';
    g.font = `bold ${text.length > 2 ? 24 : text.length > 1 ? 32 : 40}px system-ui, -apple-system, sans-serif`;
    g.fillText(text, 32, 35);
  } else {
    g.fillStyle = '#5c636a';
    g.beginPath();
    g.arc(32, 32, 31, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#ffffff';
    g.lineWidth = 7;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(19, 33);
    g.lineTo(28, 42);
    g.lineTo(45, 23);
    g.stroke();
  }
  // Safari ignores an href change on an existing icon link, so swap the element.
  const old = $('favicon');
  const link = document.createElement('link');
  link.id = 'favicon';
  link.rel = 'icon';
  link.type = 'image/png';
  link.href = canvas.toDataURL('image/png');
  if (old) old.replaceWith(link);
  else document.head.append(link);
}

// ---------- HUD ----------

function createPills() {
  const nav = $('pills');
  for (const key of HUD_PILL_KEYS) {
    const btn = el('button', `pill st-${key} zero`);
    btn.type = 'button';
    btn.dataset.lane = key;
    btn.append(icon(LANE_ICON[key]), el('span', 'pill-count', '0'), el('span', null, LANE_WORD[key]));
    btn.title = LANE_HELP[key];
    btn.addEventListener('click', () => jumpToLane(key));
    nav.append(btn);
  }
  // Not a lane pill: its own key and words, and a click that goes to the desk rather than to the Board.
  const reviews = el('button', 'pill st-visitor zero');
  reviews.type = 'button';
  reviews.dataset.lane = REVIEWS_KEY;
  reviews.append(icon('passport'), el('span', 'pill-count', '0'), el('span', null, REVIEWS_WORD));
  reviews.title = REVIEWS_HELP;
  reviews.addEventListener('click', () => jumpToReviews());
  nav.append(reviews);
  const muted = el('span', 'pills-muted', 'Older 0');
  muted.id = 'pills-muted';
  muted.title = 'No activity for 7 to 30 days. Count only';
  nav.append(muted);
}

function renderPills() {
  const model = hudPillModel(boardUsable() ? state.board.counts : null);
  const byKey = new Map(model.pills.map((p) => [p.key, p.count]));
  const split = boardUsable() ? reviewsSplit(state.board, state.visitors) : null;
  const reviews = reviewsPillModel(split ? split.total : 0, split);
  byKey.set(reviews.key, reviews.count);
  for (const btn of $('pills').querySelectorAll('button.pill')) {
    const key = btn.dataset.lane;
    const n = byKey.get(key) || 0;
    btn.querySelector('.pill-count').textContent = String(n);
    btn.classList.toggle('zero', n === 0);
    btn.setAttribute('aria-label', key === reviews.key ? reviews.label : `${n} ${LANE_WORD[key]}. Show on the Board`);
    if (key === reviews.key) btn.title = reviews.help;
  }
  $('pills-muted').textContent = `Older ${model.older}`;
  renderRailToggle();
}

const LIMIT_NAMES = {
  five_hour: '5-hour limit', seven_day: 'Weekly limit', seven_day_opus: 'Weekly Opus limit',
  seven_day_sonnet: 'Weekly Sonnet limit',
};

function clockTime(ms, now = Date.now()) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

// A past reading can be up to 7 days old, and "Thu 10:00" read on a Thursday looks like later today.
export function sampleTime(ms, now = Date.now()) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

function renderRateLimit() {
  const rl = boardUsable() && state.board.rateLimit;
  const banner = $('ratelimit-banner');
  if (!rl || !Number.isFinite(rl.resetsAt) || rl.resetsAt <= Date.now()) {
    banner.hidden = true;
    return;
  }
  const name = LIMIT_NAMES[rl.limitType] || 'Usage limit';
  $('ratelimit-text').textContent = `${name} hit, resets ${clockTime(rl.resetsAt)}`;
  banner.hidden = false;
}

function renderUsage() {
  const group = $('usage');
  const model = boardUsable() ? usageBarModel(state.board.planUsage) : null;
  const key = model ? JSON.stringify(model) : '';
  if (key === state.usageKey) return;
  state.usageKey = key;
  group.replaceChildren();
  group.hidden = !model;
  if (!model) return;
  group.classList.toggle('stale', model.stale);
  for (const bar of model.bars) {
    const item = el('div', 'usage-item');
    item.append(el('span', 'usage-label', bar.label));
    if (bar.pct === null) {
      item.append(el('span', 'usage-none', 'no recent reading'));
    } else {
      const track = el('span', 'usage-track');
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-valuenow', String(bar.pct));
      track.setAttribute('aria-valuetext', `${bar.pct}% used`);
      track.setAttribute('aria-label', `${bar.label} limit`);
      const fill = el('span', `usage-fill tone-${bar.tone}`);
      fill.style.width = `${bar.pct}%`;
      track.append(fill);
      const pct = el('span', `usage-pct tone-${bar.tone}`, `${bar.pct}%`);
      pct.setAttribute('aria-hidden', 'true');
      item.append(track, pct);
    }
    group.append(item);
  }
  if (model.asOf) group.append(el('span', 'usage-asof', model.asOf));
}

function prefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
}

// The repo colour legend sits in the rail footer, and in the HUD while the rail is folded away.
function renderLegend() {
  const railSlot = $('rail-legend');
  const hudSlot = $('hud-legend');
  const model = boardUsable() ? repoLegendModel(state.rows, state.repoColour, { dark: prefersDark() }) : null;
  const shown = Boolean(model && model.entries.length);
  const key = shown ? JSON.stringify(model) : '';
  if (key !== state.legendKey) {
    state.legendKey = key;
    for (const slot of [railSlot, hudSlot]) {
      slot.replaceChildren();
      if (shown) slot.append(legendNodes(model));
    }
  }
  railSlot.hidden = !shown;
  hudSlot.hidden = !shown || state.view !== 'village' || state.rail !== 'closed';
}

function legendNodes(model) {
  const frag = document.createDocumentFragment();
  frag.append(el('span', 'legend-title', 'Repos'));
  const ul = el('ul', 'legend-list');
  for (const entry of model.entries) {
    const li = el('li', 'legend-item');
    const swatch = el('span', entry.colour ? 'legend-swatch' : 'legend-swatch none');
    swatch.setAttribute('aria-hidden', 'true');
    // CSSOM, not a style attribute, so the CSP allows it. The colour comes from village.js's fixed palette.
    if (entry.colour) swatch.style.backgroundColor = entry.colour;
    const name = el('span', 'legend-name', entry.label);
    name.title = entry.label;
    li.append(swatch, name, el('span', 'legend-count', String(entry.count)));
    ul.append(li);
  }
  if (model.more > 0) ul.append(el('li', 'legend-item legend-more', `+${model.more} more`));
  frag.append(ul, sizeLegendNode());
  return frag;
}

// A character outline: domed body and two eyes, in the text colour so it never reads as a state or repo colour.
function avatarGlyph(size) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `avatar-glyph avatar-glyph-${size}`);
  const body = document.createElementNS(SVG_NS, 'path');
  body.setAttribute('d', 'M5 22.5V12a7 7 0 0 1 14 0v10.5z');
  svg.appendChild(body);
  for (const cx of ['9.5', '14.5']) {
    const eye = document.createElementNS(SVG_NS, 'circle');
    eye.setAttribute('cx', cx);
    eye.setAttribute('cy', '12');
    eye.setAttribute('r', '1.6');
    svg.appendChild(eye);
  }
  return svg;
}

function sizeLegendNode() {
  const line = el('div', 'legend-size');
  const glyphs = el('span', 'legend-size-glyphs');
  glyphs.setAttribute('aria-hidden', 'true');
  glyphs.append(avatarGlyph('small'), avatarGlyph('large'));
  line.append(glyphs, el('span', 'legend-size-text', SIZE_LEGEND_TEXT));
  return line;
}

function listText(values) {
  if (!Array.isArray(values) || values.length === 0) return 'none';
  return values.map((v) => String(v).slice(0, 60)).join(', ');
}

// health.problems that mean Tokentown may be looking in the wrong place for Claude's files (board.health_problems).
export const WHERE_PROBLEMS = new Set([
  'no Claude Code folder', 'no folder at CLAUDE_CONFIG_DIR', 'no sessions found', 'no transcripts found',
]);
const WHERE_HELP = 'Tokentown looks in ~/.claude, in the folder CLAUDE_CONFIG_DIR names, and in the Claude app\'s '
  + 'folder. If Claude keeps its files somewhere else, set CLAUDE_CONFIG_DIR to that folder in your terminal, then '
  + 'run tokentown stop and tokentown.';
// health.problems that mean gh has no sign-in GitHub accepts (board.GH_SIGN_IN_PROBLEM).
export const GH_PROBLEMS = new Set(['gh not signed in']);
const GH_HELP = 'gh is not signed in, or GitHub refused its sign-in, so PR states, review requests and update checks '
  + 'have stopped. Run gh auth login in Terminal, then tokentown stop and tokentown to try again straight away.';

function healthProblems(h) {
  return Array.isArray(h.problems) ? h.problems.slice(0, 10).map((p) => String(p).slice(0, 80)) : [];
}

// Labels only, never paths: ~/.claude, CLAUDE_CONFIG_DIR, Claude or Claude-3p.
export function folderText(folders, kind) {
  const shown = (Array.isArray(folders) ? folders : [])
    .filter((f) => f && f.kind === kind)
    .map((f) => `${String(f.label).slice(0, 40)}${f.found ? '' : ' (not found)'}`);
  return shown.length ? shown.join(', ') : 'not checked';
}

function healthSummary(h) {
  const d = h.desktop || {};
  const r = h.registry || {};
  const t = h.transcripts || {};
  const problems = healthProblems(h);
  return [
    ...(problems.length ? [`Needs a look: ${problems.join(', ')}`] : []),
    `Claude Code folders ${folderText(h.folders, 'code')}`,
    `App ${h.appVersion || 'unknown'}, CLI ${listText(h.cliVersions)}`,
    `Desktop records ${int(d.records)}, parse errors ${int(d.parseErrors)}`,
    `Registry files ${int(r.files)}, live ${int(r.live)}, joined ${int(r.joined)}`,
    `Transcripts tailed ${int(t.tailed)}, missing ${int(t.missing)}`,
    githubHealthSummary(h.github),
    reviewsHealthSummary(h.reviews),
    updateHealthSummary(h.updates),
    `Warnings ${Array.isArray(h.warnings) ? h.warnings.length : 0}`,
  ].join('\n');
}

function renderHealth() {
  const btn = $('health-btn');
  const word = $('health-word');
  const h = boardUsable() && state.board.health;
  btn.classList.remove('ok', 'bad');
  if (!h) {
    word.textContent = 'Health';
    btn.title = state.disconnected ? 'Not connected' : state.offline ? 'Not responding' : 'No data yet';
  } else if (h.ok) {
    btn.classList.add('ok');
    word.textContent = 'Health OK';
    btn.title = healthSummary(h);
  } else {
    btn.classList.add('bad');
    word.textContent = 'Health: check';
    btn.title = healthSummary(h);
  }
  if (!$('health-panel').hidden) fillHealthPanel();
}

function fillHealthPanel() {
  const panel = $('health-panel');
  panel.replaceChildren();
  const h = boardUsable() && state.board.health;
  if (!h) {
    const why = state.disconnected ? 'Not connected.' : state.offline ? 'Tokentown is not responding.' : 'No data yet.';
    panel.append(el('h2', null, 'Health'), el('p', null, why));
    return;
  }
  panel.append(el('h2', h.ok ? null : 'warn', h.ok ? 'Health: OK' : 'Health: needs a look'));
  const problems = healthProblems(h);
  if (problems.length) {
    const ul = el('ul', 'warn');
    for (const p of problems) ul.append(el('li', null, p));
    panel.append(ul);
    if (problems.some((p) => WHERE_PROBLEMS.has(p))) panel.append(el('p', null, WHERE_HELP));
    if (problems.some((p) => GH_PROBLEMS.has(p))) panel.append(el('p', null, GH_HELP));
  }
  const d = h.desktop || {};
  const r = h.registry || {};
  const t = h.transcripts || {};
  const code = Array.isArray(h.folders) ? h.folders.filter((f) => f && f.kind === 'code') : [];
  const codeWarn = code.length > 0
    && (!code.some((f) => f.found) || code.some((f) => f.label === 'CLAUDE_CONFIG_DIR' && !f.found));
  const rows = [
    ['Claude Code folders', folderText(h.folders, 'code'), codeWarn],
    ['Claude app folders', folderText(h.folders, 'app')],
    ['App version', h.appVersion || 'unknown'],
    ['CLI versions', listText(h.cliVersions)],
    ['Desktop records', `${int(d.records)} (parse errors ${int(d.parseErrors)})`, int(d.parseErrors) > 5],
    ['Registry', `${int(r.files)} files, ${int(r.live)} live, ${int(r.joined)} joined`],
    ['Unknown statuses', listText(r.unknownStatuses), Array.isArray(r.unknownStatuses) && r.unknownStatuses.length > 0],
    ['Transcripts', `${int(t.tailed)} tailed, ${int(t.missing)} missing`, int(t.tailed) === 0 && int(t.missing) > 0],
    ['Unknown record types', listText(t.unknownTypes)],
    ['Waiting right now', String(int(h.waitingSeenNow))],
    ['Scan time', `${int(h.scanMs)} ms`],
  ];
  const definitionList = (pairs) => {
    const dl = el('dl');
    for (const [name, value, warn] of pairs) dl.append(el('dt', null, name), el('dd', warn ? 'warn' : null, value));
    return dl;
  };
  panel.append(definitionList(rows));
  panel.append(el('h2', 'health-sub', 'GitHub PR states'), definitionList(githubHealthRows(h.github)));
  panel.append(el('h2', 'health-sub', 'Reviews waiting'), definitionList(reviewsHealthRows(h.reviews)));
  panel.append(el('h2', 'health-sub', 'Updates'), definitionList(updateHealthRows(h.updates)));
  if (h.updates && typeof h.updates === 'object' && h.updates.enabled === true) {
    const notes = el('button', 'btn health-news', "What's new");
    notes.type = 'button';
    notes.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleHealthPanel(false);
      openNews();
    });
    panel.append(notes);
  }
  if (Array.isArray(h.warnings) && h.warnings.length) {
    panel.append(el('h2', 'warn', 'Warnings'));
    const ul = el('ul');
    for (const w of h.warnings.slice(0, 20)) ul.append(el('li', null, String(w).slice(0, 120)));
    panel.append(ul);
  }
}

function toggleHealthPanel(force) {
  const panel = $('health-panel');
  const open = force == null ? panel.hidden : force;
  panel.hidden = !open;
  $('health-btn').setAttribute('aria-expanded', String(open));
  if (open) fillHealthPanel();
}

// ---------- updates ----------

function updateModel() {
  return boardUsable() ? updateNoticeModel(state.board.health && state.board.health.updates) : null;
}

function renderUpdate() {
  const banner = $('update-banner');
  if (state.updateAttempt && state.updateAttempt.phase === 'restarting') {
    // The server is on its way down and back up: this holds while its polls fail, until the page reloads.
    $('update-text').textContent = UPDATE_RESTARTING_TEXT;
    $('update-actions').hidden = true;
    banner.hidden = false;
    return;
  }
  const model = updateModel();
  // Later holds for these words only: another push changes the count, and a pull turns it into a restart.
  if (!model || state.updateLater === model.text) {
    banner.hidden = true;
    return;
  }
  if (state.updateAttempt && state.updateAttempt.key !== model.text) state.updateAttempt = null;
  const attempt = state.updateAttempt;
  const running = Boolean(attempt && attempt.phase === 'running');
  const copy = updateCopies(model);
  $('update-text').textContent = attempt && attempt.phase === 'failed' ? attempt.message : model.text;
  $('update-go-word').textContent = running ? model.busy : copy ? model.copyButton : model.button;
  $('update-go').title = copy ? model.copyHow : model.how;
  $('update-go').disabled = running;
  $('update-later').disabled = running;
  const iconName = copy ? 'copy' : 'download';
  if (state.updateIcon !== iconName) {
    $('update-go-icon').replaceChildren(icon(iconName));
    state.updateIcon = iconName;
  }
  $('update-actions').hidden = false;
  banner.hidden = false;
}

// Update now runs where it can. Once it has failed, the banner hands over the command for Terminal instead, where
// git says in its own words what is in the way.
function updateCopies(model) {
  const attempt = state.updateAttempt;
  return !model.canRun || Boolean(attempt && attempt.key === model.text && attempt.phase === 'failed');
}

// What's new: the releases the server's last check brought back, read when it opens, so they are never stale by more
// than the check itself.
async function openNews() {
  toggleOverlay('news', true);
  const body = $('news-body');
  body.replaceChildren(el('p', 'news-note', 'Loading the release notes\u2026'));
  let releases = null;
  try {
    const res = await fetch('/api/releases', {
      headers: { 'X-Town-Token': state.token || '' }, cache: 'no-store', credentials: 'omit',
    });
    if (res.status === 401) {
      toggleOverlay('news', false);
      setDisconnected();
      return;
    }
    const data = res.ok ? await res.json() : null;
    releases = data && Array.isArray(data.releases) ? data.releases : null;
  } catch { /* shown below */ }
  if ($('news').hidden) return;
  if (releases === null) body.replaceChildren(el('p', 'news-note', 'Could not load the release notes. Try again in a moment.'));
  else renderNews(releases);
}

function renderNews(releases) {
  const body = $('news-body');
  const updates = boardUsable() && state.board.health ? state.board.health.updates : null;
  const items = releaseListModel(releases, updates);
  body.replaceChildren();
  const model = updateModel();
  if (model && model.kind === 'pull' && model.canRun) {
    const go = el('button', 'btn btn-primary news-go');
    go.type = 'button';
    go.append(icon('download'), el('span', null, `Update to ${latestTag(updates)} now`));
    go.addEventListener('click', () => {
      toggleOverlay('news', false);
      updateGo();
    });
    body.append(go);
  }
  if (!items.length) {
    body.append(el('p', 'news-note', 'No release has been published yet.'));
    return;
  }
  for (const item of items) {
    const section = el('section', 'release');
    const head = el('h3', 'release-head');
    head.append(el('span', null, item.tag));
    for (const [on, word] of [[item.newest, 'Newest'], [item.fresh, 'New to you'], [item.yours, 'Yours']]) {
      if (on) head.append(el('span', 'release-badge', word));
    }
    section.append(head);
    const when = [item.date, item.name].filter(Boolean).join(' \u00b7 ');
    if (when) section.append(el('p', 'release-when', when));
    let list = null;
    for (const block of item.blocks) {
      if (block.kind === 'li') {
        if (!list) section.append(list = el('ul', 'release-list'));
        list.append(el('li', null, block.text));
        continue;
      }
      list = null;
      section.append(el(block.kind === 'h' ? 'h4' : 'p', block.kind === 'h' ? 'release-sub' : null, block.text));
    }
    if (!item.blocks.length) section.append(el('p', 'news-note', 'No notes for this release.'));
    body.append(section);
  }
}

function updateLater() {
  const model = updateModel();
  state.updateLater = model ? model.text : null;
  renderUpdate();
}

function updateGo() {
  const model = updateModel();
  if (!model || (state.updateAttempt && state.updateAttempt.phase !== 'failed')) return;
  // Still inside the click: Safari only lets a page write to the clipboard there.
  if (updateCopies(model)) copyUpdate();
  else updateNow(model);
}

// The body is {} and nothing else: the server pulls into the folder it runs from, and restarts into it after a 202.
async function updateNow(model) {
  const key = model.text;
  state.updateAttempt = { key, phase: 'running' };
  renderUpdate();
  let next = null;
  try {
    const res = await postJson('/api/update', {});
    if (res.status === 401) {
      state.updateAttempt = null;
      setDisconnected();
      return;
    }
    if (res.status === 202) {
      next = { key, phase: 'restarting' };
    } else if (res.status === 409) {
      // Another tab, or a pull in Terminal, got there first: the next board says what is left.
      toast('Nothing to update right now');
      poll();
    } else if (res.status === 429) {
      toast('An update is already running');
    } else {
      let data = null;
      try { data = await res.json(); } catch { /* a 500 with no body */ }
      const step = data && typeof data.step === 'string' ? data.step : null;
      const error = data && typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
      next = { key, phase: 'failed', message: updateFailureText(step, error) };
    }
  } catch {
    next = { key, phase: 'failed', message: 'Tokentown did not answer, so the update may not have run. Try again.' };
  }
  state.updateAttempt = next;
  renderUpdate();
}

// A server running another commit than the one this page first heard from has restarted into new code, and this
// page is still the old one's.
function noteRunningVersion(board) {
  const updates = board.health && board.health.updates;
  const running = updates && typeof updates.running === 'string' ? updates.running : null;
  if (!running) return;
  if (state.runningVersion === null) {
    state.runningVersion = running;
    return;
  }
  if (!shouldReloadFor(state.runningVersion, running, storeGet('sessionStorage', RELOADED_FOR_KEY))) {
    state.runningVersion = running;
    return;
  }
  storeSet('sessionStorage', RELOADED_FOR_KEY, running);
  state.runningVersion = running;
  state.updateAttempt = null;
  if (typeof location.reload === 'function') location.reload();
}

// ---------- rail and card ----------

function renderRail() {
  const body = $('rail-body');
  const focus = focusedRowId(body);
  body.replaceChildren();
  if (!boardUsable()) {
    body.append(unavailableBox());
    return;
  }
  // The list agrees with what is on screen: an open island's rows, else the whole board.
  const rows = visibleRows();
  let shown = 0;
  for (const lane of RAIL_LANES) {
    const list = rows.filter((s) => s.lane === lane);
    if (!list.length) continue;
    shown += list.length;
    const section = el('section', 'rail-section');
    const head = el('h2', `section-head st-${lane}`);
    head.append(statusPill(lane), el('span', 'count', String(list.length)));
    const ul = el('ul', 'rail-list');
    for (const s of list) ul.append(railRow(s));
    section.append(head, ul);
    body.append(section);
  }
  if (!shown) {
    body.append(emptyBox('Nothing blocked or needing input',
      `${laneCount('running')} running · ${laneCount('idle')} idle`));
  }
  restoreFocus(body, focus);
}

function railRow(s) {
  const li = el('li', `rail-row st-${s.lane}`);
  li.dataset.id = s.id;
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  li.setAttribute('aria-pressed', String(s.id === state.selectedId));
  if (s.id === state.selectedId) li.classList.add('selected');

  const top = el('div', 'row-top');
  const right = el('span', 'row-meta');
  const label = extraLabel(s);
  if (label) right.append(el('span', 'row-label', label));
  right.append(clockNode('span', 'clock', s.since, () => waitText(s.since)));
  top.append(statusPill(s.lane), right);

  const meta = el('div', 'row-meta');
  meta.append(el('span', 'repo', metaText(s)));
  const pr = prPill(s.pr);
  if (pr) meta.append(pr);
  const hints = hintsText(s);
  if (hints) meta.append(el('span', 'row-hints', hints));

  li.append(top, el('div', 'row-title', titleText(s)), meta);
  li.addEventListener('click', () => select(s.id));
  li.addEventListener('dblclick', () => openSession(s.id));
  return li;
}

// The list beside the village folds away. It stays rendered while hidden so it is current when shown again.
function setRail(mode, persist) {
  const closed = mode === 'closed';
  const rail = $('rail');
  const focusWasInRail = rail.contains(document.activeElement);
  state.rail = closed ? 'closed' : 'open';
  $('village-view').classList.toggle('rail-closed', closed);
  rail.hidden = closed;
  $('rail-show').hidden = !closed;
  $('rail-hide').setAttribute('aria-expanded', String(!closed));
  $('village').setAttribute('aria-label', CANVAS_LABEL[state.rail]);
  if (persist) storeSet('localStorage', RAIL_KEY, state.rail);
  renderRailToggle();
  renderLegend();
  if (closed && focusWasInRail) $('rail-show').focus({ preventScroll: true });
  if (state.view === 'village') withVillage((v) => v.resize());
  positionTip();
}

// The badge follows the list the tab opens, so an open island's tab counts that island.
function renderRailToggle() {
  const n = boardUsable() ? laneCount('needs_you') : 0;
  const badge = $('rail-show-count');
  badge.textContent = String(n);
  badge.hidden = n === 0;
  $('rail-show').setAttribute('aria-label', n > 0 ? `Show list. ${n} blocked` : 'Show list');
}

function cardFocus(slot) {
  const active = document.activeElement;
  const card = slot.firstElementChild;
  if (!card || !active || !slot.contains(active)) return null;
  const kind = active.closest('.card-actions') ? 'action' : active.classList.contains('pr-pill') ? 'pr' : 'close';
  return { id: card.dataset.cardId, kind, action: active.dataset ? active.dataset.action || null : null };
}

function restoreCardFocus(card, focus, id) {
  if (!focus || focus.id !== id) return;
  const sameAction = focus.kind === 'action' && focus.action
    ? card.querySelector(`.card-actions button[data-action="${CSS.escape(focus.action)}"]`) : null;
  const target = sameAction
    || (focus.kind === 'action' && card.querySelector('.card-actions button'))
    || (focus.kind === 'pr' && card.querySelector('a.pr-pill'))
    || card.querySelector('.card-head .icon-btn');
  if (target) target.focus({ preventScroll: true });
}

function renderCard() {
  const slot = $('card-slot');
  const focus = cardFocus(slot);
  slot.replaceChildren();
  const s = boardUsable() && state.selectedId ? findSession(state.selectedId) : null;
  if (!s) return;
  const card = el('article', `card st-${s.lane}`);
  // Not data-id: that attribute marks rows for selection and the Enter key.
  card.dataset.cardId = s.id;
  card.setAttribute('aria-label', 'Picked session');

  const head = el('div', 'card-head');
  const close = el('button', 'icon-btn');
  close.type = 'button';
  close.setAttribute('aria-label', 'Clear the pick');
  close.append(icon('close'));
  close.addEventListener('click', () => select(null));
  head.append(statusPill(s.lane), close);

  card.append(head, el('h2', 'card-title', titleText(s)));

  const where = [metaText(s)];
  if (s.branch) where.push(String(s.branch));
  card.append(el('p', 'card-line', where.join(' / ')));

  const status = el('p', 'card-line');
  status.append(el('strong', null, displayLabel(s) || LANE_WORD[s.lane]));
  if (Number.isFinite(s.since)) {
    status.append(document.createTextNode(' · '), clockNode('span', 'clock', s.since, () => sinceText(s)));
  }
  card.append(status);
  const note = statusNote(s);
  if (note) card.append(el('p', 'card-line', note));

  const model = [];
  if (s.model) model.push(`Model ${s.model}`);
  if (s.effort) model.push(`Effort ${s.effort}`);
  if (model.length) card.append(el('p', 'card-line', model.join(' · ')));
  const hints = hintsText(s);
  if (hints) card.append(el('p', 'card-line', hints));
  const rest = restText(s);
  if (rest) card.append(el('p', 'card-line', rest));
  if (valhallaReasonOf(s) === 'done') card.append(clockNode('p', 'card-line', s.doneAt, () => doneText(s)));
  if (startedText(s)) card.append(clockNode('p', 'card-line', s.createdAt, () => startedText(s)));
  for (const text of tokenLines(s.tokens)) card.append(el('p', 'card-line card-tokens', text));

  const prNodes = prLineNodes(s.pr, true);
  if (prNodes.length) {
    const line = el('p', 'card-line pr-line');
    line.append(...prNodes);
    card.append(line);
  }

  const actions = el('div', 'card-actions');
  const act = actionButton(s, true);
  const done = doneButton(s);
  if (act) actions.append(act);
  else if (runningInTerminal(s)) actions.append(el('span', 'card-line', IN_A_TERMINAL));
  if (done) actions.append(done);
  if (!act && !done && !runningInTerminal(s)) actions.append(el('span', 'card-line', 'No open action for this session'));
  card.append(actions);
  slot.append(card);
  restoreCardFocus(card, focus, s.id);
}

function actionButton(s, long) {
  if (s.canOpen) {
    const btn = el('button', 'btn btn-primary');
    btn.type = 'button';
    btn.dataset.action = 'open';
    btn.append(icon('open'), el('span', null, long ? openWords(s).action : 'Open'));
    btn.addEventListener('click', (e) => { e.stopPropagation(); openSession(s.id); });
    btn.addEventListener('dblclick', (e) => e.stopPropagation());
    return btn;
  }
  if (s.canCopyResume) {
    const btn = el('button', 'btn');
    btn.type = 'button';
    btn.dataset.action = 'copy';
    btn.append(icon('copy'), el('span', null, long ? 'Copy resume command' : 'Copy resume'));
    btn.addEventListener('click', (e) => { e.stopPropagation(); copyResume(s.id); });
    btn.addEventListener('dblclick', (e) => e.stopPropagation());
    return btn;
  }
  return null;
}

// Send to Valhalla marks a session done; Bring back takes the mark away. Same words on the card, the Board and the
// drag ghost.
function doneButton(s) {
  const action = doneActionFor(s, state.doneIntent.get(s.id));
  if (!action) return null;
  const mark = action === 'mark';
  const btn = el('button', 'btn btn-done');
  btn.type = 'button';
  btn.dataset.action = 'done';
  btn.title = mark ? 'Send to Valhalla (d)' : 'Bring back from Valhalla (d)';
  btn.append(icon(mark ? 'ship' : 'undo'), el('span', null, mark ? 'Send to Valhalla' : 'Bring back'));
  btn.addEventListener('click', (e) => { e.stopPropagation(); setDone(s.id, mark); });
  btn.addEventListener('dblclick', (e) => e.stopPropagation());
  return btn;
}

// ---------- board view: ten kanban columns ----------

function renderBoard() {
  const body = $('board-body');
  const foot = $('board-foot');
  // A drag must not have the cards move under it; the drop re-renders whatever the polls asked for meanwhile. The
  // armed drag, not the press: `state.drag` is set on pointerdown, before the 6 px that makes it a drag, so a press
  // whose pointerup never arrives (a secondary click with the button still down, a lost capture) would otherwise
  // freeze the Board for good, with the HUD counting on and the columns not.
  if (state.drag && state.drag.active) {
    state.boardStale = true;
    return;
  }
  state.boardStale = false;
  const focus = focusedRowId(body);
  const active = document.activeElement;
  const moreFocus = active && body.contains(active) && active.dataset ? active.dataset.more || null : null;
  body.replaceChildren();
  foot.replaceChildren();
  if (!boardUsable()) {
    body.append(unavailableBox());
    return;
  }
  const columns = boardColumns(state.rows, state.expandedColumns);
  for (const col of columns) body.append(columnNode(col));
  const c = state.board.counts || {};
  const split = reviewsSplit(state.board, state.visitors);
  for (const note of boardFootNotes(c, split.total, split)) {
    foot.append(el('p', 'board-note', note));
  }
  if (!restoreFocus(body, focus)) restoreBoardFocus(body, focus, columns);
  if (moreFocus) {
    const again = body.querySelector(`[data-more="${CSS.escape(moreFocus)}"]`);
    if (again) again.focus({ preventScroll: true });
  }
}

// A row that is no longer rendered: the "+N more" of the capped column it moved into, else that column's header.
// Without this, focus falls to the page body and Enter opens the picked session instead of the focused one.
function restoreBoardFocus(body, focus, columns) {
  if (!focus || typeof focus.id !== 'string') return false;
  const row = state.rows.find((s) => s.id === focus.id);
  if (!row) return false;
  const showsAll = (lane) => {
    const col = columns.find((k) => k.key === columnKeyForLane(lane));
    return !col || col.hidden === 0;
  };
  const capped = focusFallbackLane(focus, state.rows, showsAll);
  const key = columnKeyForLane(capped || row.lane);
  if (!key) return false;
  const target = (capped && body.querySelector(`[data-more="${CSS.escape(key)}"]`))
    || body.querySelector(`[data-column-head="${CSS.escape(key)}"]`);
  if (target) target.focus({ preventScroll: true });
  return Boolean(target);
}

// Focus for a session, wherever it is: its own card, and on the Board the column it belongs to when the cap holds
// that card back. Shared with the toast, because hiding the Undo button has the same problem a re-render does and
// `rowElement` alone answers null for a row past its column's cap.
function focusSession(id) {
  const target = id ? rowElement(id) : null;
  if (target) {
    target.focus({ preventScroll: true });
    return true;
  }
  if (!id || state.view !== 'board') return false;
  return restoreBoardFocus($('board-body'), { id, kind: 'row' }, boardColumns(state.rows, state.expandedColumns));
}

function columnNode(col) {
  const section = el('section', `kcolumn st-${col.key}`);
  section.id = `col-${col.key}`;
  section.dataset.column = col.key;
  section.setAttribute('role', 'region');
  section.setAttribute('aria-label', columnLabel(col));

  const head = el('div', 'kcolumn-head');
  head.title = col.help;
  head.dataset.columnHead = col.key;
  // Focusable from script only: where focus lands when the card that held it is no longer rendered.
  head.tabIndex = -1;
  const title = el('h2', 'kcolumn-title');
  title.append(statusPill(col.key, col.title), el('span', 'count', String(col.count)));
  head.append(title);
  // The whole column's count, then where it came from: nothing on screen otherwise reconciles the Blocked pill's
  // 26 with the Blocked column's 28.
  const split = columnBreakdownText(col);
  if (split) head.append(el('p', 'kcolumn-split', split));
  section.append(head);

  const list = el('ul', 'kcolumn-list');
  list.id = `col-list-${col.key}`;
  for (const s of col.shown) list.append(cardNode(s));
  if (!col.count) list.append(el('li', 'kcolumn-empty', 'Nothing here'));
  section.append(list);
  if (col.count > COLUMN_CAP) section.append(moreNode(col));
  return section;
}

// Never a silent cut: a column over the cap says how many it is holding back, and shows them on a click.
function moreNode(col) {
  const wrap = el('div', 'kcolumn-more');
  const btn = el('button', 'btn kmore-btn');
  btn.type = 'button';
  btn.dataset.more = col.key;
  btn.setAttribute('aria-expanded', String(col.expanded));
  btn.setAttribute('aria-controls', `col-list-${col.key}`);
  btn.textContent = col.expanded ? `Show first ${COLUMN_CAP}` : `+${col.hidden} more`;
  btn.setAttribute('aria-label', col.expanded
    ? `Show only the first ${COLUMN_CAP} of ${col.count} sessions in ${col.title}`
    : `Show all ${col.count} sessions in ${col.title}`);
  btn.addEventListener('click', () => toggleColumn(col.key));
  wrap.append(btn);
  return wrap;
}

function toggleColumn(key) {
  if (state.expandedColumns.has(key)) state.expandedColumns.delete(key);
  else state.expandedColumns.add(key);
  // A pick the cap now holds back cannot be reached with the keys, or seen.
  if (state.selectedId && !shownIds().has(state.selectedId)) select(null);
  if (state.view === 'board') renderBoard();
}

function shownIds() {
  const ids = new Set();
  for (const col of boardColumns(state.rows, state.expandedColumns)) for (const s of col.shown) ids.add(s.id);
  return ids;
}

// What a click on the card will do. The hover title, not an aria-label: a label on a role="button" would become
// the whole card's accessible name and hide the state, the repo and the token lines from a screen reader.
function cardHint(s) {
  if (s.canOpen === true) return openWords(s).action;
  if (s.canCopyResume === true) return 'Copy the resume command';
  if (runningInTerminal(s)) return IN_A_TERMINAL;
  return 'This session cannot be opened from here';
}

// One card. It carries what a Board row carried, with the detail the row could expand folded in, so a click is
// free to do what a click on a character does: open the session.
function cardNode(s) {
  const li = el('li', `kcard st-${s.lane}`);
  li.dataset.id = s.id;
  if (s.id === state.selectedId) li.classList.add('selected');

  const main = el('div', 'kcard-main');
  main.tabIndex = 0;
  main.setAttribute('role', 'button');
  main.title = cardHint(s);

  const top = el('div', 'kcard-top');
  top.append(statusPill(s.lane), clockNode('span', 'clock', s.since, () => waitText(s.since)));
  if (s.lane === 'recent' && s.unread) {
    const fresh = el('span', 'unread');
    fresh.title = 'New activity since you last looked';
    fresh.append(el('span', 'unread-dot'), el('span', null, 'New'));
    top.append(fresh);
  }
  main.append(top, el('div', 'row-title', titleText(s)), el('div', 'kcard-meta', metaText(s)));

  const sub = [extraLabel(s), hintsText(s), restText(s)].filter(Boolean).join(' · ');
  if (sub) main.append(el('div', 'lane-sub', sub));

  // The full line, the way the card panel and the tooltip carry it: the card folded in the row's expansion, and the
  // merge age and the confirmation note were in it. `link` false, because the whole card is already a button.
  const pr = prLineNodes(s.pr, false);
  if (pr.length) {
    const line = el('div', 'kcard-pr');
    line.append(...pr);
    main.append(line);
  }

  const facts = [['Branch', s.branch], ['Model', s.model], ['Effort', s.effort], ['Id', s.shortId]];
  const detail = el('div', 'kcard-detail');
  for (const [name, value] of facts) {
    if (!value) continue;
    const item = el('span');
    item.append(el('strong', null, `${name} `), document.createTextNode(String(value)));
    detail.append(item);
  }
  if (detail.childElementCount) main.append(detail);

  const lines = el('div', 'kcard-lines');
  if (valhallaReasonOf(s) === 'done') lines.append(clockNode('span', null, s.doneAt, () => doneText(s)));
  if (startedText(s)) lines.append(clockNode('span', null, s.createdAt, () => startedText(s)));
  for (const text of tokenLines(s.tokens)) lines.append(el('span', 'detail-tokens', text));
  if (lines.childElementCount) main.append(lines);
  li.append(main);

  const act = actionButton(s, false);
  const done = doneButton(s);
  if (act || done) {
    const actions = el('div', 'kcard-actions');
    if (act) actions.append(act);
    if (done) actions.append(done);
    li.append(actions);
  }
  li.addEventListener('pointerdown', (e) => onCardPointerDown(e, s, li));
  return li;
}

// ---------- dragging a card ----------

// A press on a card is a drag only once the pointer has moved DRAG_START_PX; until then it is still a click.
// Pointer events rather than HTML5 drag and drop: no drag image to fight, and the same code on a trackpad.
function onCardPointerDown(e, s, card) {
  if (e.button !== 0 || e.isPrimary === false) return;
  if (!(e.target instanceof Element) || e.target.closest('button, a')) return;
  if (state.drag) {
    if (state.drag.active) return; // a second pointer while a drag runs
    endDrag();
    // endDrag may have run the render a poll asked for, which replaces every card.
    if (!card.isConnected) return;
  }
  select(s.id);
  state.drag = {
    id: s.id, pointerId: e.pointerId, x: e.clientX, y: e.clientY, at: { x: e.clientX, y: e.clientY },
    card, ghost: null, active: false, target: null, edgeTimer: null,
  };
  // Capture keeps the move and up events coming while the pointer is over another column; the listeners are on
  // the document anyway, because a poll can replace this card at any moment.
  try { card.setPointerCapture(e.pointerId); } catch { /* not supported: the document listeners still fire */ }
}

function onDragMove(e) {
  const d = state.drag;
  if (!d || (d.pointerId != null && e.pointerId !== d.pointerId)) return;
  if (!d.active) {
    if (Math.abs(e.clientX - d.x) < DRAG_START_PX && Math.abs(e.clientY - d.y) < DRAG_START_PX) return;
    startDrag(d);
  }
  e.preventDefault();
  d.at = { x: e.clientX, y: e.clientY };
  moveGhost(d, e.clientX, e.clientY);
  setDropTarget(d, columnAtPoint(e.clientX, e.clientY));
  armEdgeScroll(d);
}

function startDrag(d) {
  const s = findSession(d.id);
  d.active = true;
  document.body.classList.add('dragging');
  d.card.classList.add('dragging-card');
  const ghost = el('div', `drag-ghost st-${s ? s.lane : 'muted'}`);
  ghost.setAttribute('aria-hidden', 'true');
  if (s) ghost.append(statusPill(s.lane), el('span', 'drag-ghost-title', titleText(s)));
  ghost.append(el('span', 'drag-ghost-hint', 'Drag to Valhalla'));
  document.body.append(ghost);
  d.ghost = ghost;
  hideTip();
}

function moveGhost(d, x, y) {
  if (d.ghost) d.ghost.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 14)}px)`;
}

// The word on the ghost, so the drop is readable without relying on the column's colour.
const DROP_WORD = { mark: 'Send to Valhalla', unmark: 'Bring back', none: 'Back where it was', refuse: 'Cannot move' };

function setDropTarget(d, key) {
  if (key === d.target) return;
  d.target = key;
  const body = $('board-body');
  for (const node of body.querySelectorAll('[data-column]')) node.classList.remove('drop-ok', 'drop-no', 'drop-home');
  const out = dropOutcome(findSession(d.id), key, state.doneIntent.get(d.id));
  const action = key ? out.action : 'none';
  if (d.ghost) {
    const hint = d.ghost.querySelector('.drag-ghost-hint');
    if (hint) hint.textContent = key ? DROP_WORD[action] : 'Drag to Valhalla';
    d.ghost.classList.toggle('refusing', action === 'refuse');
  }
  const column = key ? body.querySelector(`[data-column="${CSS.escape(key)}"]`) : null;
  if (!column) return;
  column.classList.add(action === 'mark' || action === 'unmark' ? 'drop-ok' : action === 'none' ? 'drop-home' : 'drop-no');
}

function columnAtPoint(x, y) {
  const body = $('board-body');
  const area = body.getBoundingClientRect();
  if (y < area.top - DRAG_EDGE_PX || y > area.bottom + DRAG_EDGE_PX) return null;
  for (const node of body.querySelectorAll('[data-column]')) {
    const r = node.getBoundingClientRect();
    if (x >= r.left && x <= r.right) return node.dataset.column;
  }
  return null;
}

// Which way the board scrolls with the pointer at x: -1 left, 1 right, 0 away from either edge.
export function edgeScrollWay(x, left, right, band = DRAG_EDGE_PX) {
  if (!Number.isFinite(x) || !(right > left)) return 0;
  if (x < left + band) return -1;
  if (x > right - band) return 1;
  return 0;
}

// Dragging into the band at either edge scrolls the board, on a timer rather than on the pointer move: ten columns
// are 1508 px wider than a 1600 px window, so a step per move meant 54 moves to cross the board and nothing at all
// for a pointer held still at the edge, waiting for the board to come to it. A timer is not an animation frame, so
// this still asks for no frame; it re-arms itself while the pointer stays in the band and stops with the drag.
const DRAG_EDGE_MS = 83; // the village's own ambient tick (village.js AMBIENT_FRAME_MS), so the two read alike
function armEdgeScroll(d) {
  const body = $('board-body');
  const r = body.getBoundingClientRect();
  const way = d.active ? edgeScrollWay(d.at.x, r.left, r.right) : 0;
  if (!way) {
    stopEdgeScroll(d);
    return;
  }
  if (d.edgeTimer != null) return;
  const step = () => {
    d.edgeTimer = null;
    // A hidden page does nothing on a tick, here as anywhere else; coming back clears the press outright.
    if (state.drag !== d || !d.active || document.hidden) return;
    const box = body.getBoundingClientRect();
    const again = edgeScrollWay(d.at.x, box.left, box.right);
    if (!again) return;
    const before = body.scrollLeft;
    body.scrollLeft += again * DRAG_EDGE_STEP;
    // The columns have moved under a pointer that has not, so the outlined column has to be worked out again.
    setDropTarget(d, columnAtPoint(d.at.x, d.at.y));
    if (body.scrollLeft === before) return; // at the end of the board: nothing more to scroll to
    d.edgeTimer = setTimeout(step, DRAG_EDGE_MS);
  };
  step();
}

function stopEdgeScroll(d) {
  if (d && d.edgeTimer != null) {
    clearTimeout(d.edgeTimer);
    d.edgeTimer = null;
  }
}

function onDragUp(e) {
  const d = state.drag;
  if (!d || (d.pointerId != null && e.pointerId !== d.pointerId)) return;
  const dragged = d.active;
  const key = dragged ? columnAtPoint(e.clientX, e.clientY) : null;
  const rect = d.card.getBoundingClientRect();
  const onCard = !dragged && e.clientX >= rect.left && e.clientX <= rect.right
    && e.clientY >= rect.top && e.clientY <= rect.bottom;
  endDrag();
  if (dragged) dropOn(d.id, key);
  else if (onCard) openSession(d.id);
}

// Only a done mark moves: the board is read from the session stores and GitHub, so every other drop snaps back.
function dropOn(id, key) {
  const s = findSession(id);
  if (!s) {
    toast('That session is no longer on the board');
    return;
  }
  const out = dropOutcome(s, key, state.doneIntent.get(id));
  if (out.action === 'mark') setDone(id, true);
  else if (out.action === 'unmark') setDone(id, false);
  else if (out.action === 'refuse') toast(out.message);
}

function endDrag() {
  const d = state.drag;
  state.drag = null;
  if (!d) return;
  stopEdgeScroll(d);
  try { d.card.releasePointerCapture(d.pointerId); } catch { /* already released with the pointer */ }
  d.card.classList.remove('dragging-card');
  if (d.ghost) d.ghost.remove();
  document.body.classList.remove('dragging');
  for (const node of $('board-body').querySelectorAll('[data-column]')) {
    node.classList.remove('drop-ok', 'drop-no', 'drop-home');
  }
  if (state.boardStale && state.view === 'board') renderBoard();
}

// ---------- selection, views, privacy ----------

function renderViews() {
  if (state.view === 'board') renderBoard();
  else {
    renderRail();
    renderCard();
  }
}

function renderAll() {
  state.clocks = state.clocks.filter((c) => c.node.isConnected);
  renderSignals();
  renderPills();
  renderRateLimit();
  renderUsage();
  renderHealth();
  renderUpdate();
  renderHudScope();
  renderRailScope();
  renderSceneBar();
  renderViews();
  renderLegend();
  if (!boardUsable()) hideTip();
}

function afterSelect() {
  withVillage((v) => v.setSelected(state.selectedId));
  for (const node of document.querySelectorAll('[data-id]')) {
    const on = node.dataset.id === state.selectedId;
    node.classList.toggle('selected', on);
    if (node.classList.contains('rail-row')) node.setAttribute('aria-pressed', String(on));
  }
  if (state.view === 'village') renderCard();
}

function select(id) {
  state.selectedId = typeof id === 'string' && findSession(id) ? id : null;
  afterSelect();
}

function rowElement(id) {
  const container = state.view === 'board' ? $('board-body') : $('rail-body');
  const row = container.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!row) return null;
  return row.querySelector('.kcard-main') || row;
}

function revealSelected() {
  if (!state.selectedId) return;
  const target = rowElement(state.selectedId);
  if (target) {
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    target.focus({ preventScroll: true });
  }
}

// j and k walk what the view shows: on the Board every card that is rendered, column by column and then down
// each one, so the keys and the screen agree even when the server reorders a lane. Array sort is stable, so each
// lane keeps the server's order inside it.
function navigableIds() {
  if (state.view === 'board') {
    return boardColumns(state.rows, state.expandedColumns).flatMap((col) => col.shown.map((s) => s.id));
  }
  const rows = visibleRows().filter((s) => RAIL_LANES.includes(s.lane));
  rows.sort((a, b) => RAIL_LANES.indexOf(a.lane) - RAIL_LANES.indexOf(b.lane));
  return rows.map((s) => s.id);
}

// Arrow keys: dy walks the column, dx crosses to the next one. Only while the Board has a card to move from,
// so the arrows still scroll the page when nothing is picked.
function moveByArrow(dx, dy, fromId) {
  if (state.view !== 'board' || !boardUsable()) return false;
  const from = fromId || state.selectedId;
  if (!from) return false;
  const next = neighbourCardId(boardColumns(state.rows, state.expandedColumns), from, dx, dy);
  if (!next) return false;
  select(next);
  revealSelected();
  return true;
}

function moveSelection(step) {
  if (!boardUsable()) return;
  const ids = navigableIds();
  if (!ids.length) return;
  const at = ids.indexOf(state.selectedId);
  const next = at < 0 ? (step > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, at + step));
  select(ids[next]);
  revealSelected();
}

function pickLongestWaiting() {
  if (!boardUsable()) {
    toast(state.disconnected ? 'Not connected' : 'Tokentown is not responding');
    return;
  }
  const first = state.rows.find((s) => s.lane === 'needs_you');
  if (!first) {
    toast('Nothing is blocked');
    return;
  }
  // The key promises the whole board, so it sails to the island that holds the row rather than picking something
  // off screen. From the world map too, where no character is drawn at all: this is the one keyboard way in.
  const isle = repoKeyOf(first);
  if (state.mode === 'world' && openIslandKey() !== isle) enterIsland(isle);
  select(first.id);
  revealSelected();
}

function setView(view, persist) {
  state.view = view === 'board' ? 'board' : 'village';
  document.body.dataset.view = state.view;
  $('village-view').hidden = state.view !== 'village';
  $('board-view').hidden = state.view !== 'board';
  $('view-village').setAttribute('aria-pressed', String(state.view === 'village'));
  $('view-board').setAttribute('aria-pressed', String(state.view === 'board'));
  if (persist) storeSet('localStorage', 'town.view', state.view);
  hideTip();
  renderViews();
  renderHudScope();
  renderLegend();
  syncVillageRunning();
  if (state.view === 'village') requestAnimationFrame(() => withVillage((v) => v.resize()));
}

// key is a HUD pill key. Its column is scrolled into view, and then the first row of that lane inside it: the
// Blocked column holds `stopped` too, and Valhalla holds the sand castle.
function jumpToLane(key) {
  if (state.view !== 'board') setView('board', true);
  const colKey = columnKeyForLane(key);
  const lanes = key === 'valhalla' ? ['valhalla', 'castle'] : [key];
  const first = boardUsable() ? state.rows.find((s) => lanes.includes(s.lane)) : null;
  // A lane that shares a column can start past the cap: 25 blocked rows before the first stopped one.
  if (first && colKey && !rowElement(first.id) && !state.expandedColumns.has(colKey)) {
    state.expandedColumns.add(colKey);
    renderBoard();
  }
  const column = colKey ? $(`col-${colKey}`) : null;
  if (column) column.scrollIntoView({ block: 'nearest', inline: 'start' });
  if (!first) {
    toast(`Nothing in ${LANE_WORD[key]} right now`);
    return;
  }
  const card = rowElement(first.id);
  if (card) card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// The Reviews pill: visitors stand at the immigration desk, which is in the Village and has no Board column, so
// this goes there rather than to a column. In the World it sails to the island holding the longest wait that has
// an island at all: a request with none stands at no desk on the map, and pointing at it would do nothing.
function jumpToReviews() {
  if (!boardUsable()) {
    toast(state.disconnected ? 'Not connected' : 'Tokentown is not responding');
    return;
  }
  const visitors = visitorsOnBoard();
  if (!visitors.length) {
    toast('No reviews waiting right now');
    return;
  }
  if (state.view !== 'village') setView('village', true);
  const n = visitors.length;
  const waits = `${n} ${n === 1 ? 'PR waits' : 'PRs wait'}`;
  if (state.mode === 'world') {
    const target = visitors.find((v) => v.island !== null && islandByKey(v.island)) || null;
    if (!target) {
      // Only One village has a desk for them, so the toast offers the way there rather than just saying so.
      toast(`${waits} on ${n === 1 ? 'a repo' : 'repos'} with no island here`, 2600, {
        label: 'Show in One village',
        run: () => {
          setMode('village', true);
          pointAtVisitor(visitors[0], waits);
        },
      });
      return;
    }
    if (openIslandKey() !== target.island) enterIsland(target.island);
    pointAtVisitor(target, waits, ` on ${worldLabel(target.island)}`);
    return;
  }
  pointAtVisitor(visitors[0], waits);
}

// A village that did not point at the visitor (none, or one that could not) leaves the click looking like nothing
// happened, so it is said in words.
function pointAtVisitor(v, waits, where = '') {
  if (askVillage('showVisitor', v.id) !== true) toast(`${waits} at the immigration desk${where}`);
}

// ---------- interior scenes: the sand castle hall and the cottage room ----------

// One entry per scene you can be inside: the state pill its bar borrows, and the village calls that leave it.
// The village names its exit per scene, so the scene's own name is tried before a generic one. What the crumb
// calls the room is the theme's, in THEME_ROOMS.
const SCENES = Object.freeze({
  castle: Object.freeze({ tone: 'castle', exits: ['leaveCastle', 'leaveScene'] }),
  cottages: Object.freeze({ tone: 'idle', exits: ['leaveCottages', 'leaveCottage', 'leaveScene'] }),
});

// 'cottage' as well as 'cottages', so a village that names that scene either way is understood.
export function sceneName(name) {
  if (name === 'cottage') return 'cottages';
  return Object.prototype.hasOwnProperty.call(SCENES, name) ? name : 'village';
}

function setScene(name) {
  const scene = sceneName(name);
  if (scene === state.scene) return;
  state.scene = scene;
  document.body.dataset.scene = scene;
  // The hovered character belongs to the scene just left; the village reports the new hover on the next move.
  state.tip.hoverId = null;
  state.tip.anchor = null;
  state.tip.dismissedId = null;
  hideTip();
  renderSceneBar();
}

function leaveScene() {
  const here = SCENES[state.scene];
  if (!here) return;
  withVillage((v) => {
    for (const exit of here.exits) {
      if (typeof v[exit] === 'function') {
        v[exit]();
        return;
      }
    }
  });
  // Also set here, so the chrome goes even if the village never answers with onScene.
  setScene('village');
}

// ---------- the world of islands: mode, the open island and what follows it ----------

// village.js owns which mode is on screen and which island is open, since only it can draw either. state.island is
// the page's mirror of that, written by islandFromVillage alone, and state.islandWanted is the remembered choice:
// it outlives an outage and a reload, and is handed to createVillage so the village reopens it on its first board.
// A repo key of '' is the no-repo island, which is falsy: compare against null, never for truth.

// The island that is actually open. Null in One village and on the world map, so every reader of it is one test.
function openIslandKey() {
  return state.mode === 'world' && state.island !== null ? state.island : null;
}

// The rows on screen: an open island's, else the whole board.
function visibleRows() {
  return worldRowsFor(state.rows, openIslandKey());
}

function islandByKey(repo) {
  return state.islands.find((isle) => isle.repo === repo) || null;
}

function villageOptions() {
  return { privacy: state.privacy };
}

// Calls one village method, if it has it. Answers whether it ran, so the page can keep itself consistent when the
// canvas never started.
function tellVillage(name, ...args) {
  let ran = false;
  withVillage((v) => {
    if (typeof v[name] !== 'function') return;
    v[name](...args);
    ran = true;
  });
  return ran;
}

// Calls one village method, if it has it, and hands back its answer (undefined when there is no such method).
function askVillage(name, ...args) {
  let answer;
  withVillage((v) => {
    if (typeof v[name] === 'function') answer = v[name](...args);
  });
  return answer;
}

// Everything that follows which island is open: the bar, the HUD note, the list note, the pills' rail badge and the
// list itself. Never the canvas: the village is where the change came from.
function refreshScope() {
  // Written here rather than only on a change, so the attribute is never simply absent: a rule matching "none"
  // would otherwise miss until the first island had been opened and closed again.
  document.body.dataset.island = openIslandKey() === null ? 'none' : 'open';
  renderSceneBar();
  renderHudScope();
  renderRailScope();
  renderPills();
  renderViews();
  positionTip();
}

function setIslandNow(repo) {
  const next = repo === null ? null : String(repo);
  if (state.island === next) return false;
  state.island = next;
  // Written here as well as in refreshScope, which renderAll does not call: the two disconnect paths clear the
  // island and then renderAll, so without this the attribute still read "open" with no island on screen.
  document.body.dataset.island = openIslandKey() === null ? 'none' : 'open';
  // The hovered island belongs to the map just left; the village reports the new hover on the next move.
  state.tip.hoverId = null;
  state.tip.anchor = null;
  state.tip.dismissedId = null;
  hideTip();
  return true;
}

function rememberIsland(repo) {
  state.islandWanted = repo;
  storeSet('localStorage', ISLAND_KEY, repo);
}

// Sails in. The village answers through onIsland, which is what moves the page's mirror.
function enterIsland(repo) {
  if (state.mode !== 'world') setMode('world', true);
  rememberIsland(repo);
  if (!tellVillage('openIsland', repo)) {
    setIslandNow(repo);
    refreshScope();
  }
}

function leaveIsland() {
  rememberIsland(null);
  if (!tellVillage('leaveIsland')) {
    setIslandNow(null);
    refreshScope();
  }
}

// The village reports which island is open: a click on a silhouette, a remembered island it reopened on its first
// board, or one it closed. The page follows rather than driving it back, so nothing re-enters the village mid-change.
// It remembers an island, never the lack of one: leaving One village closes the island too, and taking that as the
// new memory would lose the island a reader is coming back to. The deliberate exits forget it, and so does a repo
// that has left the board.
function islandFromVillage(repo) {
  const next = repo === null || repo === undefined ? null : String(repo);
  if (next !== null) rememberIsland(next);
  if (setIslandNow(next)) refreshScope();
}

// The village falls back to the world map for a repo the board no longer has, and says nothing. The page says it,
// because otherwise the island someone left is simply not there when they come back.
function reconcileIsland() {
  if (state.mode !== 'world' || !boardUsable()) return;
  const want = state.islandWanted;
  if (want === null || state.island !== null) return;
  // Still on the board, so nothing has gone: sail back to it. An outage blanks the village, which drops the island
  // village-side, so without this the page comes back on the world map while storage still names the island.
  if (islandByKey(want)) {
    tellVillage('openIsland', want);
    return;
  }
  rememberIsland(null);
  toast(`${worldLabel(want)} is no longer on the board`);
}

function setMode(mode, persist) {
  const next = mode === 'world' ? 'world' : 'village';
  state.mode = next;
  document.body.dataset.mode = next;
  $('mode-village').setAttribute('aria-pressed', String(next === 'village'));
  $('mode-world').setAttribute('aria-pressed', String(next === 'world'));
  if (persist) {
    state.modeChosen = true;
    storeSet('localStorage', MODE_KEY, next);
  }
  // The village answers with the island it opens or closes, which lands in islandFromVillage.
  tellVillage('setMode', next);
  if (next !== 'world') setIslandNow(null);
  refreshScope();
  // The pick must stay on screen, so a selected session decides which island the World opens.
  const picked = next === 'world' && state.selectedId ? findSession(state.selectedId) : null;
  if (picked && openIslandKey() !== repoKeyOf(picked)) enterIsland(repoKeyOf(picked));
}

// What the toggle and the w key do. The mode only shows in the Village, so it brings that view with it rather than
// changing something off screen.
function switchMode(mode) {
  if (state.view !== 'village') setView('village', true);
  setMode(mode, true);
}

// The Board always shows every repo, so the note about what is on screen belongs to the Village view alone.
function renderHudScope() {
  const key = state.view === 'village' ? openIslandKey() : null;
  const node = $('hud-scope');
  node.hidden = key === null || !boardUsable();
  node.textContent = key === null ? '' : hudScopeText(key);
}

function renderRailScope() {
  const key = openIslandKey();
  const box = $('rail-scope');
  box.hidden = key === null || !boardUsable();
  $('rail-scope-text').textContent = key === null ? '' : railScopeText(key);
}

// Rebuilt only when it changes: a crumb can hold keyboard focus, and the board arrives every two seconds.
function renderSceneBar() {
  const key = openIslandKey();
  const model = crumbModel(state.mode, key, state.scene, state.theme);
  const signature = JSON.stringify(model);
  if (signature === state.crumbKey) return;
  state.crumbKey = signature;
  const bar = $('scene-bar');
  const focusWasInBar = bar.contains(document.activeElement);
  // A crumb activated from the keyboard is about to be replaced, and only a bar that closes altogether restores
  // focus below, so the middle levels left it on a detached node and the browser dropped it to <body>.
  const wasCrumb = focusWasInBar && document.activeElement.classList.contains('crumb-link')
    ? document.activeElement.textContent : null;
  bar.className = `scene-bar st-${model.tone}`;
  bar.hidden = !model.open;
  $('scene-back-word').textContent = model.back;
  const crumbs = $('crumbs');
  crumbs.replaceChildren();
  model.crumbs.forEach((crumb, i) => {
    if (i > 0) {
      const sep = el('span', 'crumb-sep', '›');
      sep.setAttribute('aria-hidden', 'true');
      crumbs.append(sep);
    }
    if (!crumb.action) {
      const here = el('span', 'crumb-here', crumb.text);
      here.setAttribute('aria-current', 'location');
      crumbs.append(here);
      return;
    }
    const btn = el('button', 'crumb-link', crumb.text);
    btn.type = 'button';
    btn.addEventListener('click', () => (crumb.action === 'root' ? leaveToRoot() : leaveScene()));
    crumbs.append(btn);
  });
  if (focusWasInBar && !model.open) {
    $('view-village').focus({ preventScroll: true });
  } else if (wasCrumb !== null) {
    // The same crumb where it survives; the back button where that level has become the current one.
    const again = [...crumbs.children].find((n) => n.classList.contains('crumb-link') && n.textContent === wasCrumb);
    (again || $('scene-back')).focus({ preventScroll: true });
  }
}

// The root crumb leaves everything: the interior first, then the island.
function leaveToRoot() {
  if (state.scene !== 'village') leaveScene();
  if (openIslandKey() !== null) leaveIsland();
}

// The back button leaves one level: the interior when one is open, else the island.
function leaveOneLevel() {
  if (state.scene !== 'village') leaveScene();
  else if (openIslandKey() !== null) leaveIsland();
}

// The theme picker's options, built once: a theme is paint, so the list never changes with the board.
function fillThemePick() {
  const pick = $('theme-select');
  pick.replaceChildren(...THEMES.map((t) => {
    const opt = el('option', null, t.name);
    opt.value = t.key;
    opt.title = t.note;
    return opt;
  }));
}

// Paint alone: the village repaints, the crumb and the hovers take the theme's words, and nothing is re-laid out.
function setTheme(next, persist) {
  state.theme = themeFrom(next);
  if (persist) storeSet('localStorage', THEME_KEY, state.theme);
  const pick = $('theme-select');
  if (pick.value !== state.theme) pick.value = state.theme;
  // A village from an older build has no setTheme, and a picker that breaks the canvas would be worse than one
  // that only renames the rooms, so it is asked for rather than assumed.
  withVillage((v) => {
    if (typeof v.setTheme === 'function') v.setTheme(state.theme);
  });
  renderSceneBar();
  refreshTip();
}

function setPrivacy(on, persist) {
  state.privacy = Boolean(on);
  if (persist) storeSet('localStorage', 'town.privacy', state.privacy ? '1' : '0');
  const btn = $('privacy-btn');
  // Shown only while titles are hidden, so the top bar stays one row; p turns privacy on.
  btn.hidden = !state.privacy;
  btn.setAttribute('aria-pressed', String(state.privacy));
  const iconSlot = btn.querySelector('.chip-icon');
  iconSlot.replaceChildren(icon(state.privacy ? 'eyeOff' : 'eye'));
  $('privacy-word').textContent = state.privacy ? 'Privacy on' : 'Titles shown';
  renderViews();
  if (boardUsable()) withVillage((v) => v.update(state.board, villageOptions()));
  refreshTip();
}

// ---------- actions ----------

function postJson(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Town-Token': state.token || '' },
    body: JSON.stringify(body),
    cache: 'no-store',
    credentials: 'omit',
  });
}

// A double-click, or Enter pressed twice, repeats the same open. It is dropped quietly rather than letting the
// server's rate limit answer with a toast. A request that never answers stops blocking after POLL_TIMEOUT_MS.
export function isRepeatOpen(last, id, now) {
  if (!last || last.id !== id || !Number.isFinite(last.at)) return false;
  return now - last.at < (last.inflight ? POLL_TIMEOUT_MS : OPEN_REPEAT_MS);
}

async function openSession(id) {
  const s = findSession(id);
  if (!s) {
    toast('That session is no longer on the board');
    return;
  }
  if (!s.canOpen) {
    // Still inside the click: Safari only lets a page write to the clipboard there.
    if (s.canCopyResume) copyResume(id);
    else toast(runningInTerminal(s) ? IN_A_TERMINAL : 'This session cannot be opened from here');
    return;
  }
  const t = Date.now();
  if (isRepeatOpen(state.lastOpen, id, t)) return;
  const attempt = { id, at: t, inflight: true };
  state.lastOpen = attempt;
  try {
    const res = await postJson('/api/open', { id });
    if (res.status === 401) setDisconnected();
    else if (res.ok) toast(openWords(s).toast);
    else if (res.status === 404 && s.surface === 'vscode' && findSession(id)) toast('This folder cannot be opened safely');
    else if (res.status === 404) toast('That session is no longer on the board');
    else if (res.status === 429) toast('One moment, still opening');
    else toast(openFailedText(s));
  } catch {
    toast('Server not responding');
  } finally {
    attempt.inflight = false;
  }
}

// Opens a visitor's PR in the browser. The id and nothing else goes over the wire: the server keeps the list, and
// it re-checks the URL it stored before it runs open, so no URL the page holds could reach a command.
async function openVisitor(id) {
  if (!boardUsable()) {
    toast(state.disconnected ? 'Not connected' : 'Tokentown is not responding');
    return;
  }
  const v = findVisitor(id);
  if (!v) {
    toast(VISITOR_GONE_TOAST);
    return;
  }
  const t = Date.now();
  // Its own repeat guard, so a double click on a visitor cannot swallow a session open and the other way round.
  if (isRepeatOpen(state.lastVisitorOpen, id, t)) return;
  const attempt = { id, at: t, inflight: true };
  state.lastVisitorOpen = attempt;
  try {
    const res = await postJson('/api/open-review', { id });
    if (res.status === 401) setDisconnected();
    else if (res.ok) toast(`Opening PR #${v.number} on GitHub`);
    else toast(visitorOpenMessage(res.status));
  } catch {
    toast('Server not responding');
  } finally {
    attempt.inflight = false;
  }
}

// done: true sends the session to Valhalla, false brings it back. Repeats for a session still in flight are dropped.
async function setDone(id, done) {
  const s = findSession(id);
  if (!s) {
    toast('That session is no longer on the board');
    return;
  }
  if (state.doneInflight.has(id)) return;
  state.doneInflight.add(id);
  try {
    const res = await postJson('/api/done', { id, done });
    if (res.status === 401) {
      setDisconnected();
      return;
    }
    if (res.ok) {
      state.doneIntent.set(id, { done, at: Date.now() });
      renderViews();
      if (done) toast('Sent to Valhalla', UNDO_TOAST_MS, { label: 'Undo', run: () => setDone(id, false) });
      else toast('Brought back');
    } else if (res.status === 404) {
      toast('That session is no longer on the board');
    } else if (res.status === 409) {
      toast('Only a finished session can go to Valhalla');
    } else if (res.status === 429) {
      toast('One moment, try again');
    } else {
      toast('Could not update. Try again');
    }
    poll();
  } catch {
    toast('Server not responding');
  } finally {
    state.doneInflight.delete(id);
  }
}

// The d key: the focused row, else the picked session.
function toggleDone(id) {
  if (!boardUsable()) {
    toast(state.disconnected ? 'Not connected' : 'Tokentown is not responding');
    return;
  }
  const s = id ? findSession(id) : null;
  if (!s) {
    toast('Pick a session first');
    return;
  }
  const action = doneActionFor(s, state.doneIntent.get(s.id));
  if (action) setDone(s.id, action === 'mark');
  else if (valhallaReasonOf(s) === 'merged') toast('Already in Valhalla: its PR merged');
  else toast('Only a finished session can go to Valhalla');
}

class RequestFailed extends Error {
  constructor(status) {
    super('request failed');
    this.status = status;
  }
}

async function fetchResumeCommand(id) {
  const res = await postJson('/api/resume-command', { id });
  if (!res.ok) throw new RequestFailed(res.status);
  const data = await res.json();
  if (typeof data.command !== 'string' || !data.command) throw new RequestFailed(0);
  return data.command;
}

function copyWithTextarea(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

async function copyFallback(commandPromise, copied, failed, ms) {
  let command;
  try {
    command = await commandPromise;
  } catch (err) {
    if (err && err.status === 401) setDisconnected();
    else failed(err);
    return;
  }
  try {
    await navigator.clipboard.writeText(command);
    toast(copied, ms);
    return;
  } catch { /* fall through to the textarea copy */ }
  if (copyWithTextarea(command)) toast(copied, ms);
  else toast('Could not copy. Try again');
}

// Safari only allows a clipboard write inside the click handler, so the fetch is handed to
// ClipboardItem as a promise rather than awaited first.
function copyCommand(commandPromise, copied, failed, ms) {
  commandPromise.catch(() => {});
  if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
    try {
      const blob = commandPromise.then((c) => new Blob([c], { type: 'text/plain' }));
      blob.catch(() => {});
      navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })])
        .then(() => toast(copied, ms))
        .catch(() => copyFallback(commandPromise, copied, failed, ms));
      return;
    } catch { /* older ClipboardItem without promise support */ }
  }
  copyFallback(commandPromise, copied, failed, ms);
}

function copyResume(id) {
  copyCommand(fetchResumeCommand(id), 'Resume command copied', (err) => {
    // The server answers 404 both for a row that has gone and for a folder name it refuses to quote.
    if (err && err.status === 404 && findSession(id)) toast('This folder cannot be resumed safely');
    else if (err && err.status === 404) toast('That session is no longer on the board');
    else toast('Could not get the resume command');
  });
}

async function fetchUpdateCommand() {
  const res = await postJson('/api/update-command', {});
  if (!res.ok) throw new RequestFailed(res.status);
  const data = await res.json();
  if (typeof data.command !== 'string' || !data.command) throw new RequestFailed(0);
  return data.command;
}

// The server builds the command from the folder it runs from, so the page never holds or sends a path.
function copyUpdate() {
  const model = updateModel();
  if (!model) return;
  copyCommand(fetchUpdateCommand(), model.copied, (err) => {
    // 404: nothing to do any more (the next board hides the banner), or a folder name it refuses to quote.
    toast(err && err.status === 404 ? 'No update to copy right now' : 'Could not get the command. Try again');
  }, 6000);
}

// ---------- village tooltip ----------

// While an island is open every place on screen is that island's, so its tooltips count that island's rows. The
// board's own counts are the whole board, which is what the HUD pills keep showing.
function laneCount(lane) {
  if (openIslandKey() !== null) return visibleRows().filter((s) => s.lane === lane).length;
  const counts = state.board && state.board.counts;
  if (counts && Number.isFinite(counts[lane])) return int(counts[lane]);
  return state.rows.filter((s) => s.lane === lane).length;
}

function buildCastleTip() {
  const node = $('village-tip');
  const m = castleHallModel(laneCount('castle'), state.theme);
  node.replaceChildren();
  node.className = 'village-tip st-castle';
  node.setAttribute('aria-label', m.text);
  const status = el('div', 'tip-status');
  status.append(statusPill('castle', m.title));
  node.append(status, el('div', 'tip-line tip-strong', m.line), el('div', 'tip-hint', m.hint));
  return true;
}

function buildPatrolTip() {
  const node = $('village-tip');
  const m = patrolModel(laneCount('open_pr'), reviewsHere());
  node.replaceChildren();
  node.className = 'village-tip st-open_pr';
  node.setAttribute('aria-label', m.text);
  const grid = el('div', 'tip-grid');
  const value = el('div', 'tip-status tip-value');
  value.append(statusPill('open_pr', m.waiting));
  grid.append(el('div', 'tip-key', m.key), value);
  // The desk is also where visitors queue, so it says how many are waiting on a review of yours.
  if (m.reviewsText) {
    const reviews = el('div', 'tip-status tip-value');
    reviews.append(visitorPill(m.reviewsText));
    grid.append(el('div', 'tip-key', REVIEWS_WORD), reviews);
  }
  node.append(el('div', 'tip-title', m.title), grid, el('div', 'tip-line tip-note', m.line));
  return true;
}

function buildCottageTip() {
  const node = $('village-tip');
  const m = cottageRoomModel(laneCount('idle'), laneCount('recent'), state.theme);
  node.replaceChildren();
  node.className = 'village-tip st-idle';
  node.setAttribute('aria-label', m.text);
  const grid = el('div', 'tip-grid');
  for (const r of m.rows) {
    const value = el('div', 'tip-status tip-value');
    value.append(statusPill(r.lane, r.text));
    grid.append(el('div', 'tip-key', r.key), value);
  }
  node.append(el('div', 'tip-title', m.title), grid, el('div', 'tip-hint', m.hint));
  return true;
}

function buildIslandTip(id) {
  const repo = repoOfIslandId(id);
  const isle = islandByKey(repo);
  const m = islandTipModel(isle, isle ? isle.reviews : 0);
  if (!m) return false;
  const node = $('village-tip');
  node.replaceChildren();
  // No state colour: an island is a repo, and the palette is reserved for state.
  node.className = 'village-tip st-muted';
  node.setAttribute('aria-label', m.text);
  const grid = el('div', 'tip-grid');
  for (const r of m.rows) {
    const value = el('div', 'tip-status tip-value');
    value.append(statusPill(r.lane, r.text));
    grid.append(el('div', 'tip-key', r.key), value);
  }
  grid.append(el('div', 'tip-key tip-total', m.total.key), el('div', 'tip-value tip-total', m.total.text));
  // Below the total, because a visitor is a PR and the total counts sessions.
  if (m.reviews) {
    const reviews = el('div', 'tip-status tip-value');
    reviews.append(visitorPill(m.reviews.text));
    grid.append(el('div', 'tip-key', m.reviews.key), reviews);
  }
  node.append(el('div', 'tip-title', m.title), grid, el('div', 'tip-hint', m.hint));
  return true;
}

// What hovering a visitor at the desk shows. No session data reaches it, because a visitor has none: it is a PR.
function buildVisitorTip(id) {
  const v = findVisitor(id);
  const m = v ? visitorTipModel(v, { privacy: state.privacy }) : null;
  if (!m) return false;
  const node = $('village-tip');
  node.replaceChildren();
  node.className = 'village-tip st-visitor';
  node.setAttribute('aria-label', m.text);
  const grid = el('div', 'tip-grid');
  for (const row of m.rows) {
    let value;
    if (row.kind === 'wait') {
      value = el('div', 'tip-status');
      value.append(visitorPill());
      if (m.wait) value.append(clockNode('span', 'clock', v.waitingSince, () => waitText(v.waitingSince)));
      if (row.note) value.append(el('span', m.via === 'you' ? 'tip-asked tip-asked-you' : 'tip-asked', row.note));
    } else {
      value = el('div', null, row.text);
    }
    value.classList.add('tip-value');
    grid.append(el('div', 'tip-key', row.key), value);
  }
  node.append(el('div', 'tip-title', m.title), grid, el('div', 'tip-hint', m.hint));
  return true;
}

const PLACE_TIPS = {
  castle: buildCastleTip, cottages: buildCottageTip, patrol: buildPatrolTip, island: buildIslandTip,
};

function buildTip(s) {
  const node = $('village-tip');
  const m = tooltipModel(s, { privacy: state.privacy, reviewers: waitingOnFor(state.board, s.pr) });
  node.replaceChildren();
  node.removeAttribute('aria-label');
  if (!m) return false;
  node.className = `village-tip st-${m.lane}`;
  node.append(el('div', 'tip-title', m.title));

  // Two columns: a bold section title, then its muted value.
  const grid = el('div', 'tip-grid');
  for (const row of m.rows) {
    let value;
    if (row.kind === 'status') {
      value = el('div', 'tip-status');
      value.append(statusPill(m.lane));
      if (m.label) value.append(el('span', 'tip-label', m.label));
      if (m.wait) value.append(clockNode('span', 'clock', s.since, () => waitText(s.since)));
      if (row.note) value.append(el('span', 'tip-lane-note', row.note));
    } else if (row.kind === 'pr') {
      value = el('div', 'pr-line');
      value.append(...prLineNodes(m.pr, false));
    } else if (row.kind === 'clock') {
      value = clockNode('div', null, row.since, row.format);
    } else {
      value = el('div', null, row.text);
    }
    value.classList.add('tip-value');
    grid.append(el('div', 'tip-key', row.key), value);
  }
  node.append(grid);
  node.append(el('div', 'tip-hint', m.hint));
  return true;
}

function positionTip() {
  const node = $('village-tip');
  if (node.hidden || !state.tip.anchor) return;
  const stage = $('village-stage').getBoundingClientRect();
  node.style.maxHeight = ''; // measure the full height, not the last cut
  const size = { w: node.offsetWidth, h: node.offsetHeight };
  const at = placeTooltip(state.tip.anchor, state.tip.pointer, size, stage);
  // Visibility rather than hidden, so the next pointer move or clock tick can bring it back.
  node.style.visibility = at ? '' : 'hidden';
  if (!at) return;
  if (at.maxHeight !== null) node.style.maxHeight = `${Math.floor(at.maxHeight)}px`;
  node.style.transform = `translate(${Math.round(at.x - stage.left)}px, ${Math.round(at.y - stage.top)}px)`;
}

function hideTip() {
  const node = $('village-tip');
  if (!node.hidden) node.hidden = true;
  state.tip.shownId = null;
}

function showTip() {
  const tip = state.tip;
  const live = tip.hoverId && tip.anchor && tip.dismissedId !== tip.hoverId && state.view === 'village' && boardUsable();
  const place = live ? placeTipKind(tip.hoverId, state.scene) : null;
  const s = live && !place ? findSession(tip.hoverId) : null;
  // The desk stands outside, like every other place, so a visitor is never hovered inside an interior scene.
  const visitor = live && !place && !s && state.scene === 'village' ? findVisitor(tip.hoverId) : null;
  if (!s && !place && !visitor) {
    hideTip();
    return;
  }
  const node = $('village-tip');
  const id = place ? tip.hoverId : (s ? s.id : visitor.id);
  if (tip.shownId !== id || node.hidden) {
    const built = place ? PLACE_TIPS[place](tip.hoverId) : (s ? buildTip(s) : buildVisitorTip(visitor.id));
    if (!built) {
      hideTip();
      return;
    }
    tip.shownId = id;
  }
  // Measured while shown and placed before the next paint, so it never flashes at the old spot.
  node.hidden = false;
  positionTip();
}

// Rebuilds the visible tooltip after new board data or a privacy change.
function refreshTip() {
  if ($('village-tip').hidden) return;
  state.tip.shownId = null;
  showTip();
}

function onVillageHover(id, point) {
  const tip = state.tip;
  if (typeof id !== 'string' || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    tip.hoverId = null;
    tip.anchor = null;
    tip.dismissedId = null;
    hideTip();
    return;
  }
  if (id !== tip.hoverId) {
    tip.hoverId = id;
    tip.dismissedId = null;
  }
  tip.anchor = { x: point.x, y: point.y };
  showTip();
}

// ---------- village ----------

function withVillage(fn) {
  if (!state.village) return;
  try {
    fn(state.village);
  } catch (err) {
    villageFailed(err);
  }
}

function villageFailed(err) {
  const village = state.village;
  state.village = null;
  if (village) {
    try { village.stop(); } catch { /* already broken */ }
    try { village.destroy(); } catch { /* already broken */ }
  }
  hideTip();
  $('village').hidden = true;
  $('village-fallback').hidden = false;
  console.warn('village unavailable:', err && err.name ? err.name : 'Error');
}

function syncVillageRunning() {
  const run = state.view === 'village' && !document.hidden;
  if (!run) hideTip();
  withVillage((v) => {
    if (run) v.start();
    else v.stop();
  });
}

async function initVillage() {
  try {
    const mod = await import('./village.js');
    // Taken before createVillage, so the legend keeps its colours even if the canvas cannot start.
    if (typeof mod.repoColour === 'function') {
      state.repoColour = mod.repoColour;
      state.legendKey = null;
      renderLegend();
    }
    if (typeof mod.createVillage !== 'function') throw new TypeError('createVillage missing');
    state.village = mod.createVillage($('village'), {
      onSelect: (id) => {
        // A village that reports an island click through onSelect or onOpen rather than onIsland is understood too.
        const isle = repoOfIslandId(id);
        if (isle !== null) {
          enterIsland(isle);
          return;
        }
        // A visitor has no card and cannot be picked: clicking one opens its PR, whichever callback reports it.
        // The repeat guard makes a village that fires both harmless.
        if (!findSession(id) && isVisitorId(id)) {
          openVisitor(id);
          return;
        }
        select(id);
        // A terminal session has nothing to open. An ended one hands over its resume command, and a running one says
        // where it is, so the click is never silent: its card alone can sit out of view in a scrolled list.
        const picked = findSession(id);
        if (picked && picked.canOpen !== true && picked.canCopyResume === true) copyResume(id);
        else if (runningInTerminal(picked)) toast(IN_A_TERMINAL);
        // The card lives in the list, and a terminal session's card is what its click is for.
        if (state.selectedId && state.rail === 'closed' && state.view === 'village') setRail('open', false);
      },
      onOpen: (id) => {
        const isle = repoOfIslandId(id);
        if (isle !== null) enterIsland(isle);
        else if (!findSession(id) && isVisitorId(id)) openVisitor(id);
        else if (typeof id === 'string') openSession(id);
      },
      onHover: onVillageHover,
      onScene: (name) => {
        // 'world' is the map, not an interior, and no interior is open while it shows. An 'island:<repo>' scene
        // name means the same thing the other way round, for a village that reports the island as its scene.
        if (name === 'world') {
          setScene('village');
          islandFromVillage(null);
          return;
        }
        const isle = repoOfIslandId(name);
        if (isle !== null) {
          setScene('village');
          islandFromVillage(isle);
          return;
        }
        setScene(name);
      },
      onIsland: (repo) => islandFromVillage(repo),
      mode: state.mode,
      theme: state.theme,
      // The remembered island. The village tries it once, on its first board, and answers through onIsland.
      island: state.islandWanted,
    });
  } catch (err) {
    villageFailed(err);
    return;
  }
  withVillage((v) => {
    v.resize();
    if (boardUsable()) v.update(state.board, villageOptions());
    v.setSelected(state.selectedId);
  });
  syncVillageRunning();
}

// ---------- help overlay and keys ----------

// Keys (?) and How it works (i): one open at a time, focus on its close button while open, and back after.
const OVERLAYS = ['help', 'info', 'news'];

function toggleOverlay(id, force) {
  const overlay = $(id);
  const open = force == null ? overlay.hidden : force;
  if (open === !overlay.hidden) return;
  if (open) {
    for (const other of OVERLAYS) if (other !== id && !$(other).hidden) toggleOverlay(other, false);
    state.overlayReturnFocus = document.activeElement;
    overlay.hidden = false;
    $(`${id}-close`).focus();
  } else {
    overlay.hidden = true;
    if (state.overlayReturnFocus && state.overlayReturnFocus.isConnected) state.overlayReturnFocus.focus();
  }
}

function toggleHelp(force) {
  toggleOverlay('help', force);
}

function overlayOpen() {
  return OVERLAYS.some((id) => !$(id).hidden);
}

// Keys that flip something. A held key auto-repeats, which would flip it back and forth: d would send Done, then undo
// it, with a 429 toast replacing the Undo one in between. Moving keys (j, k, n) still repeat.
const TOGGLE_KEYS = new Set(['v', 'p', 's', 'd', 'w', 'i']);

export function isRepeatedToggle(e) {
  return !!(e && e.repeat === true && TOGGLE_KEYS.has(e.key));
}

function onKeyDown(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  if (isRepeatedToggle(e)) {
    e.preventDefault();
    return;
  }
  const target = e.target instanceof Element ? e.target : null;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;

  if (e.key === 'Escape') {
    if (state.drag) {
      endDrag();
      e.preventDefault();
      return;
    }
    if (!$('village-tip').hidden) {
      state.tip.dismissedId = state.tip.hoverId;
      hideTip();
    }
    const shown = OVERLAYS.find((id) => !$(id).hidden);
    if (shown) toggleOverlay(shown, false);
    else if (!$('health-panel').hidden) toggleHealthPanel(false);
    // One level at a time: the interior first, then the island, then the pick.
    else if (state.view === 'village' && (state.scene !== 'village' || openIslandKey() !== null)) leaveOneLevel();
    else select(null);
    e.preventDefault();
    return;
  }
  if (e.key === '?' || e.key === 'i') {
    toggleOverlay(e.key === '?' ? 'help' : 'info');
    e.preventDefault();
    return;
  }
  if (overlayOpen()) return;

  switch (e.key) {
    case 'v': setView(state.view === 'village' ? 'board' : 'village', true); break;
    case 'w': switchMode(nextMode(state.mode)); break;
    case 'p': setPrivacy(!state.privacy, true); break;
    case 's': {
      if (state.view !== 'village') return;
      setRail(state.rail === 'closed' ? 'open' : 'closed', true);
      break;
    }
    case 'n': pickLongestWaiting(); break;
    case 'd': {
      const row = target ? target.closest('[data-id]') : null;
      toggleDone(row ? row.dataset.id : state.selectedId);
      break;
    }
    case 'j': moveSelection(1); break;
    case 'k': moveSelection(-1); break;
    case 'ArrowDown': case 'ArrowUp': case 'ArrowLeft': case 'ArrowRight': {
      const card = target ? target.closest('.kcard') : null;
      // With no card to move from, the arrows belong to the scroll containers.
      if (!moveByArrow(
        e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0,
        e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0,
        card ? card.dataset.id : null,
      )) return;
      break;
    }
    case 'Enter': {
      if (target && target.closest('button, a')) return;
      const row = target ? target.closest('[data-id]') : null;
      const id = row ? row.dataset.id : state.selectedId;
      if (!id) return;
      openSession(id);
      break;
    }
    case ' ': {
      if (!target) return;
      if (target.matches('.rail-row')) {
        target.click();
        break;
      }
      if (!target.matches('.kcard-main')) return;
      const row = target.closest('[data-id]');
      if (!row) return;
      openSession(row.dataset.id);
      break;
    }
    default:
      return;
  }
  e.preventDefault();
}

// ---------- start ----------

function tick() {
  updateChecked();
  renderRateLimit();
  renderUsage();
  state.clocks = state.clocks.filter((c) => c.node.isConnected);
  for (const c of state.clocks) {
    const text = c.format();
    if (c.node.textContent !== text) c.node.textContent = text;
  }
  // A clock that gains a digit widens the tooltip.
  positionTip();
}

function wire() {
  $('view-village').addEventListener('click', () => setView('village', true));
  $('view-board').addEventListener('click', () => setView('board', true));
  $('privacy-btn').addEventListener('click', () => setPrivacy(!state.privacy, true));
  $('theme-select').addEventListener('change', (e) => setTheme(e.target.value, true));
  $('help-btn').addEventListener('click', () => toggleHelp(true));
  $('help-close').addEventListener('click', () => toggleHelp(false));
  $('help').addEventListener('click', (e) => { if (e.target === $('help')) toggleHelp(false); });
  $('info-btn').addEventListener('click', () => toggleOverlay('info', true));
  $('brand-btn').addEventListener('click', () => toggleOverlay('info', true));
  $('info-close').addEventListener('click', () => toggleOverlay('info', false));
  $('news-close').addEventListener('click', () => toggleOverlay('news', false));
  $('news').addEventListener('click', (e) => { if (e.target === $('news')) toggleOverlay('news', false); });
  $('update-news').addEventListener('click', () => openNews());
  $('info').addEventListener('click', (e) => { if (e.target === $('info')) toggleOverlay('info', false); });
  $('health-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleHealthPanel(); });
  $('update-go').addEventListener('click', () => updateGo());
  $('update-later').addEventListener('click', () => updateLater());
  $('rail-hide').addEventListener('click', () => {
    setRail('closed', true);
    $('rail-show').focus({ preventScroll: true });
  });
  $('rail-show').addEventListener('click', () => {
    setRail('open', true);
    $('rail-hide').focus({ preventScroll: true });
  });
  $('mode-village').addEventListener('click', () => switchMode('village'));
  $('mode-world').addEventListener('click', () => switchMode('world'));
  $('rail-scope-btn').addEventListener('click', () => leaveIsland());
  $('scene-back').addEventListener('click', () => leaveOneLevel());
  document.addEventListener('click', (e) => {
    const panel = $('health-panel');
    if (!panel.hidden && e.target instanceof Node && !panel.contains(e.target)) toggleHealthPanel(false);
  });
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragUp);
  document.addEventListener('pointercancel', () => endDrag());
  // Repo swatches have a light and a dark fill; a scheme change arrives without a new board.
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      state.legendKey = null;
      renderLegend();
    });
  } catch { /* no matchMedia: the light fills stay */ }
  // Registered before the village's own listener, so a hover change places the tooltip against this event.
  $('village').addEventListener('pointermove', (e) => {
    state.tip.pointer = { x: e.clientX, y: e.clientY };
    // The village only reports hover changes and character moves; the pointer can still slide under the tooltip.
    positionTip();
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    syncVillageRunning();
    if (document.hidden) {
      schedulePoll();
      return;
    }
    // The belt for a press whose pointerup never arrived: coming back to the tab always clears a stranded one.
    endDrag();
    poll();
  });
  let resizeQueued = false;
  window.addEventListener('resize', () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      if (state.view === 'village') withVillage((v) => v.resize());
    });
  });
  window.addEventListener('hashchange', async () => {
    if (!location.hash.startsWith('#c=')) return;
    const claim = await claimFromHash();
    if (claim === 'ok') {
      setConnected();
      poll();
    } else if (claim === 'replayed') {
      if (state.disconnected) setBanner('replayed');
      else toast(REPLAYED_TOAST, 12000);
    }
  });
}

function init() {
  for (const slot of document.querySelectorAll('[data-icon]')) slot.append(icon(slot.dataset.icon));
  createPills();
  wire();
  fillThemePick();
  setTheme(storeGet('localStorage', THEME_KEY), false);
  state.privacy = storeGet('localStorage', 'town.privacy') === '1';
  setPrivacy(state.privacy, false);
  setRail(railStateFrom(storeGet('localStorage', RAIL_KEY)), false);
  // No board yet, so the heuristic cannot run here: a first run starts in One village and acceptBoard decides.
  const storedMode = storeGet('localStorage', MODE_KEY);
  state.modeChosen = MODES.includes(storedMode);
  state.islandWanted = storeGet('localStorage', ISLAND_KEY);
  setMode(modeFrom(storedMode, []), false);
  setView(storeGet('localStorage', 'town.view') === 'board' ? 'board' : 'village', false);
  renderAll();
  setInterval(tick, 1000);
  initVillage();
  connect();
}

if (typeof document !== 'undefined') init();
