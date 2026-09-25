// Headless checks for web/app.js helpers and the village: click rules, voyages, the castle hall, the graveyard and
// frame pacing. Run by tests/test_web.py under node, with no network and no browser: the canvas is a stub, every
// event is synthetic and time is simulated where it matters. A few checks boot the page itself on a small DOM
// parsed out of index.html, for the behaviour text matching cannot reach. Prints one JSON line.

import { readFileSync } from 'node:fs';

const results = { passed: [], failed: [] };

function check(name, fn) {
  try {
    fn();
    results.passed.push(name);
  } catch (err) {
    results.failed.push({ name, message: String(err && err.message ? err.message : err) });
  }
}

// For the checks that boot the page: importing app.js and driving its polls are both asynchronous. Awaited at the
// call site so one boot's globals are always restored before the next check installs its own.
async function checkAsync(name, fn) {
  try {
    await fn();
    results.passed.push(name);
  } catch (err) {
    results.failed.push({ name, message: String(err && err.message ? err.message : err) });
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
}

// ---------- a canvas that accepts every drawing call ----------

const stub = new Proxy(function () {}, {
  get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : key === 'width' ? 10 : stub),
  set: () => true,
  apply: () => stub,
});

// Records the text the village draws; everything else is accepted and ignored.
function recorder(texts) {
  return new Proxy(function () {}, {
    get: (_t, key) => (key === 'fillText' ? (text) => texts.push(String(text)) : key === Symbol.toPrimitive ? () => 0 : key === 'width' ? 10 : stub),
    set: () => true,
    apply: () => stub,
  });
}

// Like recorder, but measureText is proportional to length, so plates truncate the way a real canvas does.
function measuringRecorder(texts, perChar = 8.5) {
  return new Proxy(function () {}, {
    get: (_t, key) => (key === 'fillText' ? (text) => texts.push(String(text))
      : key === 'measureText' ? (text) => ({ width: Array.from(String(text)).length * perChar })
        : key === Symbol.toPrimitive ? () => 0 : key === 'width' ? 10 : stub),
    set: () => true,
    apply: () => stub,
  });
}

// Records the calls and fill colours a check asks about: hands (arc radius 3), light columns (linear gradients), and
// every fillStyle, which is how a body's colour reaches the canvas.
function spyContext({ calls = null, fills = null } = {}) {
  return new Proxy(function () {}, {
    get: (_t, key) => {
      if (calls && (key === 'arc' || key === 'createLinearGradient' || key === 'clip' || key === 'rect')) {
        return (...args) => {
          calls.push([key, ...args]);
          return stub;
        };
      }
      return key === Symbol.toPrimitive ? () => 0 : key === 'width' ? 10 : stub;
    },
    set: (_t, key, value) => {
      if (fills && key === 'fillStyle') fills.push(value);
      return true;
    },
    apply: () => stub,
  });
}

// Records where rowboats are drawn: every hull is drawn after translate(x, y), rotate(tilt) and scale(0.7), mirrored for a
// boat heading left. A passenger's boat is drawn twice in one frame (behind and in front of it), at the same point.
function boatSpy(boats) {
  let at = null;
  let rotated = false;
  return new Proxy(function () {}, {
    get: (_t, key) => {
      if (key === 'translate') return (x, y) => { at = { x, y }; rotated = false; return stub; };
      if (key === 'rotate') return () => { rotated = !!at; return stub; };
      if (key === 'scale') {
        return (sx, sy) => {
          if (at && rotated && Math.abs(Math.abs(sx) - 0.7) < 1e-9 && Math.abs(sy - 0.7) < 1e-9) boats.push(at);
          at = null;
          rotated = false;
          return stub;
        };
      }
      return key === Symbol.toPrimitive ? () => 0 : key === 'width' ? 10 : stub;
    },
    set: () => true,
    apply: () => stub,
  });
}

let reduceMotion = true; // reduced motion by default: characters are placed at once, so positions are exact
// The day theme by default. The night checks set this before creating a village: the village reads the query once,
// at creation, so flipping it afterwards changes nothing.
let darkMode = false;
globalThis.devicePixelRatio = 1;
globalThis.matchMedia = (query) => ({
  matches: query.includes('reduce') ? reduceMotion : darkMode,
  addEventListener() {},
  removeEventListener() {},
});

// A clock the motion checks can drive. Left alone it follows real time.
const clock = { ms: null };
const realPerformance = globalThis.performance;
Object.defineProperty(globalThis, 'performance', {
  value: { now: () => (clock.ms === null ? realPerformance.now() : clock.ms) },
  configurable: true,
  writable: true,
});

let app = null;
let appError = null;
try {
  app = await import(new URL('../web/app.js', import.meta.url));
} catch (err) {
  appError = err;
}
const villageMod = await import(new URL('../web/village.js', import.meta.url));

// Fake frame and timer queues, so a check can count what the village asks for while simulated time passes.
function withFrameLoop(fn) {
  const saved = ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
    .map((k) => [k, globalThis[k]]);
  const loop = { rafs: [], timers: [] };
  globalThis.requestAnimationFrame = (f) => loop.rafs.push(f);
  globalThis.cancelAnimationFrame = () => {};
  globalThis.setTimeout = (f, ms) => loop.timers.push({ f, at: clock.ms + Math.max(0, Number(ms) || 0) });
  globalThis.clearTimeout = () => {};
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  clock.ms = 5_000_000;
  // Runs queued frames (16 ms apart) and timers until `seconds` of simulated time pass, and counts them.
  loop.pump = (seconds, onStep) => {
    const end = clock.ms + seconds * 1000;
    const out = { frames: 0, timers: 0 };
    let guard = 0;
    while (clock.ms < end && guard++ < 100000) {
      if (onStep) onStep(clock.ms);
      if (loop.rafs.length) {
        clock.ms += 16;
        for (const f of loop.rafs.splice(0)) {
          out.frames += 1;
          f(clock.ms);
        }
        continue;
      }
      if (loop.timers.length) {
        loop.timers.sort((a, b) => a.at - b.at);
        const next = loop.timers.shift();
        clock.ms = Math.max(clock.ms, next.at);
        out.timers += 1;
        next.f();
        continue;
      }
      clock.ms = end;
    }
    clock.ms = Math.max(clock.ms, end);
    return out;
  };
  try {
    fn(loop);
  } finally {
    for (const [k, v] of saved) globalThis[k] = v;
    clock.ms = null;
  }
}

function makeVillage({ reduce = true, texts = null, measure = false, perChar = 8.5, spy = null, boats = null, mode, island, theme } = {}) {
  reduceMotion = reduce;
  const listeners = new Map();
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getContext: () => (boats ? boatSpy(boats) : spy ? spyContext(spy) : texts ? (measure ? measuringRecorder(texts, perChar) : recorder(texts)) : stub),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
  };
  const log = { opened: [], selected: [], hovers: [], scenes: [], islands: [] };
  const village = villageMod.createVillage(canvas, {
    onOpen: (id) => log.opened.push(id),
    onSelect: (id) => log.selected.push(id),
    onHover: (id, point) => log.hovers.push({ id, point }),
    onScene: (name) => log.scenes.push(name),
    onIsland: (repo) => log.islands.push(repo),
    mode,
    island,
    theme,
  });
  village.resize();
  const fire = (type, x, y, extra = {}) => {
    const e = { clientX: x, clientY: y, button: 0, isPrimary: true, pointerType: 'mouse', detail: 1, ...extra };
    for (const fn of listeners.get(type) || []) fn(e);
  };
  const hoveredId = () => (log.hovers.length ? log.hovers[log.hovers.length - 1].id : null);
  // Sweeps upwards from the character's feet until the village reports it hovered, then settles on the badge
  // centre, which only that character can win.
  const aim = (rows, id) => {
    const slot = villageMod.layoutVillage(rows).get(id);
    for (let k = 0; k <= 160; k += 2) {
      fire('pointermove', slot.x, slot.y - k);
      if (hoveredId() === id) {
        const p = log.hovers[log.hovers.length - 1].point;
        const at = { x: p.x, y: p.y + 14 };
        fire('pointermove', at.x, at.y);
        assert(hoveredId() === id, `badge centre of ${id} should keep the hover`);
        return at;
      }
    }
    throw new Error(`could not hover ${id}`);
  };
  // The ids hovered while sweeping upwards from a point, first one first.
  const sweep = (x, y, span = 90) => {
    const seen = [];
    for (let k = 0; k <= span; k += 2) {
      fire('pointermove', x, y - k);
      const id = hoveredId();
      if (id && !seen.includes(id)) seen.push(id);
    }
    fire('pointerleave', 0, 0);
    return seen;
  };
  const click = (x, y, extra = {}, downAt = null) => {
    const d = downAt || { x, y };
    fire('pointerdown', d.x, d.y, extra);
    fire('click', x, y, extra);
  };
  // Sweeps upwards from a point until `id` is hovered and leaves the pointer there.
  const aimPoint = (x, y, id, span = 120) => {
    for (let k = 0; k <= span; k += 2) {
      fire('pointermove', x, y - k);
      if (hoveredId() === id) return { x, y: y - k };
    }
    throw new Error(`could not hover ${id} from ${Math.round(x)},${Math.round(y)}`);
  };
  return { village, fire, log, aim, aimPoint, sweep, click, hoveredId };
}

const A = 'local_aaaaaaaa-0000-4000-8000-000000000001';
const B = 'local_bbbbbbbb-0000-4000-8000-000000000002';
const row = (id, lane, extra = {}) => ({ id, lane, look: 7, kind: 'desktop', canOpen: true, ...extra });

// ---------- village clicks ----------

check('click on the hovered character opens it once', () => {
  const v = makeVillage();
  const rows = [row(A, 'running'), row(B, 'running')];
  v.village.update({ sessions: rows, counts: {} }, { privacy: false });
  const at = v.aim(rows, A);
  v.click(at.x, at.y);
  eq(v.log.opened, [A], 'opened');
});

check('a character that walks under a still pointer is not opened by the next click', () => {
  const v = makeVillage();
  const before = [row(A, 'running'), row(B, 'running')];
  v.village.update({ sessions: before, counts: {} }, { privacy: false });
  const at = v.aim(before, A);

  const after = [row(A, 'your_turn'), row(B, 'running')];
  const prev = new Map([...villageMod.layoutVillage(before)].map(([id, s]) => [id, { place: s.place, index: s.index }]));
  const aOld = villageMod.layoutVillage(before).get(A);
  const bNew = villageMod.layoutVillage(after, prev).get(B);
  eq({ x: bNew.x, y: bNew.y }, { x: aOld.x, y: aOld.y }, 'precondition: B takes the slot A left');
  v.village.update({ sessions: after, counts: {} }, { privacy: false });
  assert(v.hoveredId() === A, 'hover stays on A until the pointer moves');

  v.click(at.x, at.y);
  eq(v.log.opened, [], 'the first click only re-targets');
  eq(v.hoveredId(), B, 'the tooltip now names B');
  v.click(at.x, at.y);
  eq(v.log.opened, [B], 'a second click acts on what the tooltip shows');
});

check('a click where nothing is left under the pointer clears the hover and does nothing', () => {
  const v = makeVillage();
  const before = [row(A, 'running')];
  v.village.update({ sessions: before, counts: {} }, { privacy: false });
  const at = v.aim(before, A);
  v.village.update({ sessions: [row(A, 'open_pr')], counts: {} }, { privacy: false });
  v.click(at.x, at.y);
  eq(v.log.opened, [], 'opened');
  eq(v.log.selected, [], 'selected');
  eq(v.hoveredId(), null, 'hover');
});

check('the second click of a double-click does not open again', () => {
  const v = makeVillage();
  const rows = [row(A, 'running')];
  v.village.update({ sessions: rows, counts: {} }, { privacy: false });
  const at = v.aim(rows, A);
  v.click(at.x, at.y, { detail: 1 });
  v.click(at.x, at.y, { detail: 2 });
  v.click(at.x, at.y, { detail: 3 });
  eq(v.log.opened, [A], 'opened');
});

check('a drag released on a character does not open it', () => {
  const v = makeVillage();
  const rows = [row(A, 'running')];
  v.village.update({ sessions: rows, counts: {} }, { privacy: false });
  const at = v.aim(rows, A);
  v.fire('pointermove', 20, 20);
  v.fire('pointerdown', 20, 20);
  v.fire('pointermove', at.x, at.y);
  v.fire('click', at.x, at.y);
  eq(v.log.opened, [], 'from the grass');

  v.fire('pointerdown', at.x, at.y);
  v.fire('pointermove', at.x + 6, at.y);
  v.fire('click', at.x + 6, at.y);
  eq(v.hoveredId(), A, 'still over A after the small drag');
  eq(v.log.opened, [], 'moved more than the slop on the same character');
});

check('only a primary press counts', () => {
  const v = makeVillage();
  const rows = [row(A, 'running')];
  v.village.update({ sessions: rows, counts: {} }, { privacy: false });
  const at = v.aim(rows, A);
  v.fire('pointerdown', at.x, at.y, { button: 2 });
  v.fire('click', at.x, at.y);
  v.fire('pointerdown', at.x, at.y);
  v.fire('pointercancel', at.x, at.y);
  v.fire('click', at.x, at.y);
  eq(v.log.opened, [], 'opened');
});

check('a row that cannot open selects instead', () => {
  const v = makeVillage();
  const rows = [row(A, 'running', { kind: 'cli', canOpen: false, canCopyResume: true })];
  v.village.update({ sessions: rows, counts: {} }, { privacy: false });
  const at = v.aim(rows, A);
  v.click(at.x, at.y);
  eq([v.log.opened, v.log.selected], [[], [A]], 'open and select');
});

check('a touch tap has no hover and still opens what was pressed', () => {
  const v = makeVillage();
  const rows = [row(A, 'running')];
  v.village.update({ sessions: rows, counts: {} }, { privacy: false });
  const at = v.aim(rows, A);
  v.fire('pointerleave', at.x, at.y);
  eq(v.hoveredId(), null, 'hover after leave');
  v.click(at.x, at.y, { pointerType: 'touch' });
  eq(v.log.opened, [A], 'opened');
});

// ---------- Valhalla, the sand castle and the graveyard ----------

const V = villageMod;
const C = 'local_cccccccc-0000-4000-8000-000000000003';
const D = 'local_dddddddd-0000-4000-8000-000000000004';
const board = (rows, visitors = null) => {
  const counts = {};
  for (const r of rows) counts[r.lane] = (counts[r.lane] || 0) + 1;
  const out = { sessions: rows, counts };
  // Only when a check asks for them, so every board written before visitors existed is byte for byte the board
  // it was: the village must draw the same scene from one with no `visitors` key at all.
  if (visitors) out.visitors = visitors;
  return out;
};
const xy = (p) => ({ x: p.x, y: p.y });
const near = (a, b, tol, message) => assert(Math.abs(a - b) <= tol, `${message}: ${a} vs ${b}`);
const inWater = (p) => p.x > V.shoreX(p.y) + 4 && !V.onIsland(p.x, p.y);
// How far two [x, y, w, h] boxes overlap: the smaller of the two axes, negative when they are apart.
const overlapBy = (a, b) => Math.min(Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]), Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));

check('lanes map to places; room and graveyard rows are not village characters', () => {
  const expected = {
    needs_you: 'porch', errored: 'porch', stopped: 'porch', running: 'workshop', your_turn: 'porch', idle: 'cottages',
    recent: 'cottages', open_pr: 'harbour', valhalla: 'beach', castle: 'castle', jail: 'jail',
    graveyard: 'graveyard',
  };
  for (const [lane, place] of Object.entries(expected)) eq(V.placeForLane(lane), place, lane);
  eq([V.placeForLane('done'), V.placeForLane('archived'), V.placeForLane('old')], [null, null, null], 'retired lanes');
  eq(['beach', 'castle', 'harbour', 'graveyard', 'cottages'].map(V.areaForPlace), ['island', 'island', 'land', 'land', 'land'], 'areas');
  // The merged Porch: one place, one sign, four lanes, three spots.
  eq(V.PLACES.porch.lanes, ['needs_you', 'your_turn', 'errored', 'stopped'], 'the Porch holds four lanes');
  eq(['needs_you', 'your_turn', 'errored', 'stopped'].map(V.spotForLane), ['porch', 'swings', 'steps', 'steps'], 'its three spots');
  eq(Object.keys(V.PLACES).includes('tent'), false, 'the Tent is gone');
  eq([V.spotForLane('idle'), V.spotForLane('recent'), V.spotForLane('castle')], [null, null, null], 'room lanes have no slot grid');
  eq([V.isRoomPlace('cottages'), V.isRoomPlace('castle'), V.isRoomPlace('porch')], [true, true, false], 'the room places');
  const rows = [row(A, 'valhalla'), row(B, 'castle'), row(C, 'graveyard'), row(D, 'idle')];
  const layout = V.layoutVillage(rows);
  eq([...layout.keys()], [A], 'only the beach row gets a village slot');
  eq(layout.get(A).place, 'beach', 'place');
  for (const n of [1, 8, 17, 40, 120]) {
    for (const p of V.slotGrid('beach', n).points) assert(V.onIsland(p.x, p.y, -8), `beach slot ${JSON.stringify(p)} of ${n} is on the sand`);
  }
});

check('a voyage walks to the harbour, sails to the island jetty and walks to a deck chair', () => {
  const from = { x: 860, y: 452, area: 'land' };
  const slot = V.slotGrid('beach', 1).points[0];
  const legs = V.planJourney(from, { ...slot, area: 'island' });
  eq(legs.map((l) => l.kind), ['walk', 'sail', 'walk'], 'legs');
  const [walk1, sail, walk2] = legs;
  eq([walk1.area, sail.area, walk2.area], ['land', 'water', 'island'], 'areas');
  eq(walk1.pts[0], xy(from), 'sets off from where it stood');
  eq(walk1.pts.at(-1), xy(V.HARBOUR_BOARD), 'walks to the harbour boardwalk');
  eq([sail.board, sail.pts[0], sail.pts.at(-1), sail.land], [xy(V.HARBOUR_BOARD), xy(V.BOAT_BERTH), xy(V.JETTY_BERTH), xy(V.JETTY_END)], 'boards, sails, lands');
  eq(walk2.pts.at(-1), xy(slot), 'ends at the chair');
  near(walk1.dur, V.walkDuration(V.routeLength(walk1.pts)), 1e-9, 'walk timing');
  near(sail.dur, V.sailDuration(V.routeLength(sail.pts)) + 2 * V.HOP_S, 1e-9, 'sail timing');
  assert(sail.dur >= 4.5 + 2 * V.HOP_S && sail.dur <= 5.5 + 2 * V.HOP_S, `the crossing takes about 5 s plus the hops (${sail.dur})`);
  for (let i = 1; i < sail.pts.length; i++) {
    for (let k = 0; k <= 20; k++) {
      const a = sail.pts[i - 1];
      const b = sail.pts[i];
      const p = { x: a.x + (b.x - a.x) * (k / 20), y: a.y + (b.y - a.y) * (k / 20) };
      assert(inWater(p), `the boat stays in the water at ${JSON.stringify(p)}`);
    }
  }
  for (const p of walk2.pts.slice(1)) assert(V.onIsland(p.x, p.y), `island walk on the sand at ${JSON.stringify(p)}`);

  const j = V.scheduleJourney(V.planJourney(from, { ...slot, area: 'island' }), 100);
  const [l0, l1, l2] = j.legs;
  near(j.end - 100, walk1.dur + sail.dur + walk2.dur, 1e-9, 'total');
  const walking = V.journeyAt(j, l0.t0 + l0.dur / 2);
  assert(walking.walking && !walking.inBoat && walking.area === 'land', 'walking on land first');
  const hop = V.journeyAt(j, l1.t0 + V.HOP_S / 2);
  assert(hop.boat && !hop.inBoat && !hop.boat.sail, 'hops into a waiting boat');
  const sailing = V.journeyAt(j, l1.t0 + l1.dur / 2);
  assert(sailing.inBoat && sailing.area === 'water' && sailing.boat.sail && inWater(sailing), 'sails in the boat');
  const landing = V.journeyAt(j, l2.t0 + l2.dur / 2);
  assert(landing.walking && landing.area === 'island', 'walks on the island');
  const done = V.journeyAt(j, j.end + 0.01);
  assert(done.done, 'done');
  eq(xy(done), xy(slot), 'arrives at the chair');
  eq(j.toArea, 'island', 'ends on the island');

  const back = V.planJourney({ ...slot, area: 'island' }, from);
  eq(back.map((l) => l.kind), ['walk', 'sail', 'walk'], 'the way back');
  eq([back[1].pts[0], back[1].pts.at(-1), back[2].pts.at(-1)], [xy(V.JETTY_BERTH), xy(V.BOAT_BERTH), xy(from)], 'sails back to the harbour');
  eq(V.planJourney(from, { x: 246, y: 716, area: 'land' }).map((l) => l.kind), ['walk'], 'land to land is one walk');
});

check('reduced motion places lane changes directly, and first load never walks', () => {
  const v = makeVillage();
  const start = [row(A, 'running'), row(B, 'running'), row(C, 'running')];
  v.village.update(board(start), { privacy: false });
  const after = [row(A, 'valhalla'), row(B, 'castle'), row(C, 'graveyard')];
  v.village.update(board(after), { privacy: false });
  v.aim(after, A);
  const stone = V.GRAVE_SLOTS[0];
  assert(v.sweep(stone.x, stone.y, 40).includes(C), 'the headstone is up at once');
  const bSlot = V.layoutVillage(start).get(B);
  assert(!v.sweep(bSlot.x, bSlot.y).includes(B), 'B left the workshop at once');
  v.village.enterCastle();
  const seat = V.castleLayout(1).points[0];
  assert(v.sweep(seat.x, seat.y, 160).includes(B), 'B already sits in the hall');

  withFrameLoop((loop) => {
    const w = makeVillage({ reduce: false });
    w.village.start();
    w.village.update(board(after), { privacy: false });
    const out = loop.pump(1);
    assert(out.frames <= 13, `first load stays at the ambient rate (${out.frames} frames in 1 s)`);
    w.aim(after, A);
    assert(w.sweep(stone.x, stone.y, 40).includes(C), 'headstone up on first load');
    w.village.destroy();
  });
});

check('a merged session sails to Valhalla at full frame rate, then the village drops back to ambient', () => {
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false });
    v.village.start();
    const before = [row(A, 'your_turn'), row(B, 'running')];
    v.village.update(board(before), { privacy: false });
    const idle = loop.pump(2);
    assert(idle.frames <= 26, `ambient before (${idle.frames} frames in 2 s)`);
    const after = [row(A, 'valhalla'), row(B, 'running')];
    v.village.update(board(after), { privacy: false });
    const from = V.layoutVillage(before).get(A);
    const slot = V.layoutVillage(after).get(A);
    const j = V.scheduleJourney(V.planJourney({ ...from, area: 'land' }, { ...slot, area: 'island' }), 0);
    const moving = loop.pump(1);
    assert(moving.frames >= 45, `full rate while walking (${moving.frames} frames in 1 s)`);
    const sail = j.legs[1];
    loop.pump(sail.t0 + sail.dur / 2 - 1);
    const boat = V.journeyAt(j, sail.t0 + sail.dur / 2);
    assert(v.sweep(boat.x, boat.y + 4, 80).includes(A), 'hoverable in its boat');
    const sailing = loop.pump(0.5);
    assert(sailing.frames >= 20, `full rate while sailing (${sailing.frames} frames in 0.5 s)`);
    // The boat sails back to the pier empty once its passenger has landed, and that still counts as motion.
    const home = V.scheduleFerries(V.scheduleJourney(V.planJourney({ ...from, area: 'land' }, { ...slot, area: 'island' }), 0), 0);
    eq(home.map((f) => f.kind), ['return'], 'one empty trip home');
    const settleAt = Math.max(j.end, home[0].t0 + home[0].dur);
    loop.pump(settleAt - (sail.t0 + sail.dur / 2) - 0.5 + 0.3);
    v.aim(after, A);
    const settled = loop.pump(2);
    assert(settled.frames <= 26 && settled.timers >= 18, `ambient after the voyage (${settled.frames} frames, ${settled.timers} timer sleeps in 2 s)`);
    v.village.destroy();
  });
});

check('a session merged long ago walks into the sand castle, fades, and joins the hall', () => {
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false });
    v.village.start();
    const before = [row(A, 'valhalla')];
    v.village.update(board(before), { privacy: false });
    loop.pump(0.5);
    const slot = V.layoutVillage(before).get(A);
    v.village.update(board([row(A, 'castle')]), { privacy: false });
    const j = V.scheduleJourney(V.planJourney({ ...slot, area: 'island' }, { ...V.CASTLE.door, area: 'island' }), 0, { fade: true });
    eq(j.legs.map((l) => l.kind), ['walk', 'fade'], 'walks to the door, then fades');
    eq(j.legs[1].pts[0], xy(V.CASTLE.door), 'fades at the door');
    near(j.legs[1].dur, V.FADE_S, 1e-9, 'fade time');
    near(V.journeyAt(j, j.end - V.FADE_S / 2).alpha, 0.5, 1e-9, 'half faded');
    loop.pump(0.05);
    assert(v.sweep(slot.x, slot.y).includes(A), 'still hoverable as it sets off');
    const walking = loop.pump(0.5);
    assert(walking.frames >= 20, `full rate on the way (${walking.frames})`);
    loop.pump(j.end);
    assert(!v.sweep(slot.x, slot.y).includes(A), 'gone from the beach');
    const atDoor = v.sweep(V.CASTLE.door.x, V.CASTLE.door.y, 60);
    assert(!atDoor.includes(A) && atDoor.includes(V.CASTLE_ID), `the door is the castle now (${atDoor})`);
    const quiet = loop.pump(1);
    assert(quiet.frames <= 13, `ambient again (${quiet.frames})`);
    v.village.enterCastle();
    const seat = V.castleLayout(1).points[0];
    assert(v.sweep(seat.x, seat.y, 160).includes(A), 'a guest in the hall');
    v.village.destroy();
  });
});

check('a session sent back to the castle while it stands at the door still fades inside', () => {
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false });
    v.village.start();
    const before = [row(A, 'valhalla')];
    v.village.update(board(before), { privacy: false });
    loop.pump(0.5);
    const slot = V.layoutVillage(before).get(A);
    v.village.update(board([row(A, 'castle')]), { privacy: false });
    const walk = V.planJourney({ ...slot, area: 'island' }, { ...V.CASTLE.door, area: 'island' })[0];
    loop.pump(walk.dur + 0.05);
    // Back to the beach and straight back into the castle, before it has taken a step from the door.
    v.village.update(board(before), { privacy: false });
    v.village.update(board([row(A, 'castle')]), { privacy: false });
    loop.pump(V.FADE_S + 0.5);
    const atDoor = v.sweep(V.CASTLE.door.x, V.CASTLE.door.y, 60);
    assert(!atDoor.includes(A), `faded into the castle, not left standing at its door (${atDoor})`);
    v.village.enterCastle();
    assert(v.sweep(V.castleLayout(1).points[0].x, V.castleLayout(1).points[0].y, 160).includes(A), 'a guest in the hall');
    v.village.destroy();
  });
});

check('an archived session walks to the graveyard gate, fades, and its headstone rises in the front row', () => {
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false });
    v.village.start();
    const others = Array.from({ length: 5 }, (_, i) => row(`local_eeeeeeee-0000-4000-8000-00000000001${i}`, 'graveyard'));
    const before = [row(A, 'running'), ...others];
    v.village.update(board(before), { privacy: false });
    loop.pump(0.5);
    const front = V.GRAVE_SLOTS[0];
    assert(v.sweep(front.x, front.y, 40).includes(others[0].id), 'newest headstone in front');
    const from = V.layoutVillage(before).get(A);
    v.village.update(board([row(A, 'graveyard'), ...others]), { privacy: false });
    const j = V.scheduleJourney(V.planJourney({ ...from, area: 'land' }, { ...V.GRAVEYARD.gate, area: 'land' }), 0, { fade: true });
    eq(j.legs.map((l) => l.kind), ['walk', 'fade'], 'walks to the gate, then fades');
    eq(j.legs[1].pts[0], xy(V.GRAVEYARD.gate), 'fades at the gate');
    loop.pump(0.1);
    assert(!v.sweep(front.x, front.y, 40).includes(A), 'no headstone while it walks');
    loop.pump(j.end - 0.1 + 0.05);
    const rising = loop.pump(V.RISE_S / 2);
    assert(rising.frames >= 15, `full rate while the headstone rises (${rising.frames})`);
    loop.pump(V.RISE_S);
    const at = v.aimPoint(front.x, front.y, A, 40);
    v.click(at.x, at.y);
    eq(v.log.opened, [A], 'a headstone opens like a character');
    const second = V.GRAVE_SLOTS[1];
    assert(v.sweep(second.x, second.y, 40).includes(others[0].id), 'older headstones move back a slot');
    const quiet = loop.pump(1);
    assert(quiet.frames <= 13, `ambient again (${quiet.frames})`);
    v.village.destroy();
  });
});

check('the graveyard shows as many headstones as fit, newest first, and its sign counts the rest', () => {
  const ids = Array.from({ length: V.GRAVE_CAPACITY + 7 }, (_, i) => `local_ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const layout = V.graveyardLayout(ids);
  eq(layout.size, V.GRAVE_CAPACITY, 'capped');
  eq(layout.get(ids[0]).index, 0, 'newest takes the first slot');
  assert(!layout.has(ids.at(-1)), 'the oldest are left out');
  assert(V.GRAVE_CAPACITY >= 24, `room for a crowd (${V.GRAVE_CAPACITY})`);
  const [fx, fy, fw, fh] = V.GRAVEYARD.fence;
  V.GRAVE_SLOTS.forEach((s, i) => {
    assert(s.x - 14 > fx && s.x + 14 < fx + fw && s.y - 40 > fy && s.y + 4 < fy + fh, `slot ${i} inside the fence`);
    assert(Math.abs(s.x - V.GRAVEYARD.gateX) > 20, `slot ${i} clear of the path`);
    V.GRAVE_SLOTS.forEach((o, k) => assert(k <= i || Math.hypot(s.x - o.x, s.y - o.y) >= 30, `slots ${i} and ${k} apart`));
  });
  const draw = (rows) => {
    const texts = [];
    withFrameLoop((loop) => {
      const v = makeVillage({ texts });
      v.village.start();
      v.village.update(board(rows), { privacy: false });
      loop.pump(0.2);
      v.village.destroy();
    });
    return texts;
  };
  const texts = draw(ids.map((id) => row(id, 'graveyard')));
  assert(texts.includes('+7 more'), `the sign says +7 more (${texts.filter((t) => /more/.test(t))})`);
  assert(texts.includes(String(ids.length)), 'the sign shows the total');
  assert(!draw(ids.slice(0, 3).map((id) => row(id, 'graveyard'))).some((t) => /more/.test(t)), 'no +N when all fit');
});

check('the castle: hovering names it, a click goes inside, and the hall hit-tests its guests', () => {
  const v = makeVillage();
  const rows = [row(A, 'castle'), row(B, 'castle', { kind: 'cli', canOpen: false, canCopyResume: true }), row(C, 'running')];
  v.village.update(board(rows), { privacy: false });
  const [bx, by] = V.CASTLE.badge;
  v.fire('pointermove', bx, by);
  eq(v.hoveredId(), V.CASTLE_ID, 'hover id');
  const point = v.log.hovers.at(-1).point;
  assert(Math.abs(point.x - bx) < 1 && point.y < by, `point at the top of the count badge (${JSON.stringify(point)})`);
  v.click(bx, by);
  eq(v.log.scenes, ['castle'], 'went inside');
  eq(v.hoveredId(), null, 'hover cleared on the way in');
  v.village.enterCastle();
  eq(v.log.scenes, ['castle'], 'entering again reports nothing');
  const cSlot = V.layoutVillage(rows).get(C);
  assert(!v.sweep(cSlot.x, cSlot.y).includes(C), 'village characters are not in the hall');
  v.fire('pointermove', bx, by);
  assert(v.hoveredId() !== V.CASTLE_ID, 'no castle to hover from inside it');
  const seats = V.castleLayout(2).points;
  const at = v.aimPoint(seats[0].x, seats[0].y, A, 160);
  v.click(at.x, at.y);
  eq(v.log.opened, [A], 'a guest that can open opens');
  const bt = v.aimPoint(seats[1].x, seats[1].y, B, 160);
  v.click(bt.x, bt.y, { detail: 2 });
  eq(v.log.selected, [], 'the double-click guard holds inside');
  v.click(bt.x, bt.y);
  eq(v.log.selected, [B], 'a terminal guest selects');
  v.village.leaveCastle();
  v.village.leaveCastle();
  eq(v.log.scenes, ['castle', 'village'], 'left once');
  eq(v.hoveredId(), null, 'hover cleared on the way out');
  v.fire('pointermove', bx, by);
  eq(v.hoveredId(), V.CASTLE_ID, 'the castle is back');
});

check('the hall spreads a crowd over the whole floor, and scales guests to fit it', () => {
  const [fx, fy, fw, fh] = V.HALL.floor;
  let last = Infinity;
  for (const n of [1, 2, 5, 12, 22, 80, 150, 300]) {
    const g = V.castleLayout(n);
    eq(g.points.length, n, `${n} spots`);
    assert(g.scale <= last + 1e-9 && g.scale >= V.HALL.minScale && g.scale <= V.HALL.maxScale, `scale ${g.scale} for ${n}`);
    last = g.scale;
    for (const p of g.points) assert(p.x >= fx && p.x <= fx + fw && p.y >= fy && p.y <= fy + fh, `${n}: spot ${JSON.stringify(p)} on the floor`);
    const guests = g.points.map((p) => ({ px: p.x, py: p.y }));
    guests.forEach((a, i) => guests.forEach((b, k) => {
      if (k > i) assert(V.hallSpacing(a, b, g.scale) >= 1, `${n}: spots ${i} and ${k} start ${V.hallSpacing(a, b, g.scale).toFixed(2)} apart`);
    }));
    if (n >= 22) {
      const xs = g.points.map((p) => p.x);
      const ys = g.points.map((p) => p.y);
      assert(Math.max(...xs) - Math.min(...xs) >= fw * 0.8 && Math.max(...ys) - Math.min(...ys) >= fh * 0.6, `${n}: the crowd fills the floor`);
    }
  }
  eq(V.castleLayout(7), V.castleLayout(7), 'the same crowd starts on the same spots');
  assert(V.castleLayout(1).scale === V.HALL.maxScale && V.castleLayout(150).scale < 0.5, 'few guests are big, a crowd is small');
});

const seeded = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

check('hall guests wander aimlessly inside the hall, pause, and keep their distance once settled', () => {
  const [fx, fy, fw, fh] = V.HALL.floor;
  for (const n of [1, 2, 5, 20, 60, 150]) {
    const layout = V.castleLayout(n);
    const k = layout.scale;
    const guests = layout.points.map((p, i) => ({ px: p.x, py: p.y, rng: seeded(1000 + i) }));
    const travelled = new Array(n).fill(0);
    const paused = new Array(n).fill(false);
    let worst = Infinity;
    const dt = 1 / 24;
    for (let f = 0; f < 24 * 40; f++) {
      const before = guests.map((g) => [g.px, g.py]);
      V.wanderStep(guests, dt, k);
      guests.forEach((g, i) => {
        assert(g.px >= fx - 1e-9 && g.px <= fx + fw + 1e-9 && g.py >= fy - 1e-9 && g.py <= fy + fh + 1e-9, `${n}: guest ${i} left the floor`);
        travelled[i] += Math.hypot(g.px - before[i][0], g.py - before[i][1]);
        if (!g.walking && g.pause > 0) paused[i] = true;
      });
      if (f >= 24 * 5) {
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) worst = Math.min(worst, V.hallSpacing(guests[i], guests[j], k));
      }
    }
    if (n > 1) assert(worst >= 0.8, `${n}: two guests overlap once settled (spacing ${worst.toFixed(2)})`);
    assert(travelled.every((d) => d > 150), `${n}: everyone wanders (least ${Math.min(...travelled).toFixed(0)} px in 40 s)`);
    assert(paused.every(Boolean), `${n}: everyone pauses now and then`);
  }
  const lone = [{ px: 800, py: 600, rng: seeded(7) }];
  V.wanderStep(lone, 0, 1);
  eq([lone[0].px, lone[0].py], [800, 600], 'no time, no step');
});

check('a hall guest holds still while hovered or pressed, so hover, read, then click opens it', () => {
  // A tooltip takes a second or more to read, and a wandering guest would be gone from under the pointer by then.
  const fakeDoc = { visibilityState: 'visible', listeners: new Map() };
  fakeDoc.addEventListener = (type, fn) => fakeDoc.listeners.set(type, [...(fakeDoc.listeners.get(type) || []), fn]);
  fakeDoc.removeEventListener = () => {};
  globalThis.document = fakeDoc;
  try {
    withFrameLoop((loop) => {
      const v = makeVillage({ reduce: false });
      v.village.start();
      const n = 17;
      const ids = Array.from({ length: n }, (_, i) => `local_abababab-0000-4000-8000-${String(i).padStart(12, '0')}`);
      v.village.update(board(ids.map((id) => row(id, 'castle'))), { privacy: false });
      v.village.enterCastle();
      loop.pump(4);
      const k = V.castleLayout(n).scale;
      // Hit-tests the floor until `id` is hovered, then settles on its badge centre, which only it can win.
      const find = (id) => {
        for (let y = 300; y <= 880; y += 12) {
          for (let x = 90; x <= 1510; x += 12) {
            v.fire('pointermove', x, y);
            if (v.hoveredId() !== id) continue;
            const p = v.log.hovers.at(-1).point;
            const at = { x: p.x, y: p.y + 14 * Math.min(1, k) };
            v.fire('pointermove', at.x, at.y);
            assert(v.hoveredId() === id, `badge centre of ${id} keeps the hover`);
            return at;
          }
        }
        return null;
      };
      const held = new Map();
      let reports = 0;
      for (const id of ids.slice(0, 8)) {
        const at = find(id);
        assert(at, `guest ${id} is somewhere on the floor`);
        const before = v.log.hovers.length;
        loop.pump(1.5);
        const moves = v.log.hovers.slice(before);
        reports += moves.length;
        assert(moves.every((h) => h.id === id), 'a still pointer keeps naming the guest');
        v.click(at.x, at.y);
        assert(v.log.opened.at(-1) === id, `hovered, read for 1.5 s, then clicked: opens (${JSON.stringify(v.log.opened.slice(-2))})`);
        held.set(id, at);
        v.fire('pointerleave', 0, 0);
        loop.pump(0.3);
      }
      eq(reports, 0, 'a held guest never moves its tooltip');
      loop.pump(8);
      let moved = 0;
      for (const [id, at] of held) {
        const now = find(id);
        v.fire('pointerleave', 0, 0);
        if (now && Math.hypot(now.x - at.x, now.y - at.y) > 30) moved += 1;
      }
      assert(moved >= 6, `once the pointer leaves, guests wander on (${moved} of ${held.size} moved)`);

      // A press holds a guest too, so a touch tap (no hover) opens what was pressed; a release anywhere lets it go.
      const tapId = ids[9];
      const tap = find(tapId);
      v.fire('pointerleave', 0, 0);
      v.fire('pointerdown', tap.x, tap.y, { pointerType: 'touch' });
      loop.pump(1.5);
      v.fire('click', tap.x, tap.y, { pointerType: 'touch' });
      eq(v.log.opened.at(-1), tapId, 'a long touch press still opens its guest');
      const dragId = ids[10];
      const drag = find(dragId);
      v.fire('pointerleave', 0, 0);
      v.fire('pointerdown', drag.x, drag.y);
      for (const fn of fakeDoc.listeners.get('pointerup') || []) fn({});
      loop.pump(8);
      const after = find(dragId);
      assert(after && Math.hypot(after.x - drag.x, after.y - drag.y) > 30, 'released off the canvas, the pressed guest walks on');
      v.village.destroy();
    });
  } finally {
    delete globalThis.document;
  }

  // A guest stepping in front of the one the tooltip names, nearer the pointer, does not take the click while the named
  // one is still under it. A newcomer starts on its spread spot, next to the first guest's.
  withFrameLoop(() => {
    const v = makeVillage({ reduce: false });
    v.village.start();
    const ids = [0, 1, 2].map((i) => `local_efefefef-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const first = V.castleLayout(1);
    const k = first.scale;
    eq(V.castleLayout(3).scale, k, 'precondition: one scale for one and three guests');
    v.village.update(board([row(ids[0], 'castle')]), { privacy: false });
    v.village.enterCastle();
    // Look 7: a square body 34 tall with a hat, standing on its legs; the pointer rests 10 px right of its middle.
    const at = { x: first.points[0].x + 10, y: first.points[0].y - (6 + 34) * k + 17 * k };
    v.fire('pointermove', at.x, at.y);
    eq(v.hoveredId(), ids[0], 'the first guest is hovered');
    v.village.update(board(ids.map((id) => row(id, 'castle'))), { privacy: false });
    const spot = V.castleLayout(3).points[1];
    assert(Math.hypot(spot.x - at.x, spot.y - (6 + 34) * k + 17 * k - at.y) < 10, 'precondition: the newcomer stands nearer the pointer');
    v.click(at.x, at.y);
    eq(v.log.opened, [ids[0]], 'the click opens the guest the tooltip names');
    v.village.destroy();
  });

  const layout = V.castleLayout(40);
  const guests = layout.points.map((p, i) => ({ px: p.x, py: p.y, rng: seeded(500 + i) }));
  const still = guests[7];
  still.held = true;
  const start = [still.px, still.py];
  let worst = Infinity;
  const travelled = new Array(guests.length).fill(0);
  for (let f = 0; f < 24 * 30; f++) {
    const before = guests.map((g) => [g.px, g.py]);
    V.wanderStep(guests, 1 / 24, layout.scale);
    guests.forEach((g, i) => { travelled[i] += Math.hypot(g.px - before[i][0], g.py - before[i][1]); });
    if (f >= 24 * 5) for (const g of guests) if (g !== still) worst = Math.min(worst, V.hallSpacing(g, still, layout.scale));
  }
  eq([still.px, still.py, still.walking], [...start, false], 'a held guest stands exactly where it was');
  assert(worst >= 0.8, `the others give way around it (closest ${worst.toFixed(2)})`);
  assert(travelled.filter((d, i) => i !== 7).every((d) => d > 100), 'everyone else wanders on');
  const pair = [{ px: 800, py: 600, rng: seeded(1), held: true }, { px: 805, py: 600, rng: seeded(2), held: true }];
  V.wanderStep(pair, 0.05, 1);
  eq(pair.map((g) => [g.px, g.py]), [[800, 600], [805, 600]], 'two held guests push neither');
});

check('the hall wanders at up to 24 fps only while open; leaving stops it and the village is ambient again', () => {
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false });
    v.village.start();
    const ids = Array.from({ length: 20 }, (_, i) => `local_cdcdcdcd-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const rows = [...ids.map((id) => row(id, 'castle')), row(A, 'running')];
    v.village.update(board(rows), { privacy: false });
    loop.pump(0.5);
    const outside = loop.pump(2);
    assert(outside.frames <= 26, `ambient in the village (${outside.frames} frames in 2 s)`);
    v.village.enterCastle();
    loop.pump(0.2);
    const inside = loop.pump(2);
    assert(inside.frames <= 48, `at most 24 fps in the hall (${inside.frames} frames in 2 s)`);
    assert(inside.frames > 26, `faster than ambient while guests wander (${inside.frames} frames in 2 s)`);
    const spot = V.castleLayout(20).points[3];
    v.aimPoint(spot.x, spot.y, ids[3], 200);
    loop.pump(4);
    const at = v.log.hovers.filter((h) => h.id === ids[3]).at(-1).point;
    v.fire('pointerleave', 0, 0);
    v.village.leaveCastle();
    loop.pump(0.2);
    const after = loop.pump(2);
    assert(after.frames <= 26, `back to ambient after leaving (${after.frames} frames in 2 s)`);
    loop.pump(6);
    v.village.enterCastle();
    v.fire('pointermove', at.x, at.y + 14 * Math.min(1, V.castleLayout(20).scale));
    eq(v.hoveredId(), ids[3], 'nobody wandered while the hall was closed');
    v.village.stop();
    const stopped = loop.pump(2);
    // The fake cancelAnimationFrame cannot unqueue a frame, so the one already queued still runs (and returns at once).
    assert(stopped.frames <= 1 && stopped.timers === 0, `nothing scheduled once stopped (${stopped.frames} frames, ${stopped.timers} timers)`);
    v.village.destroy();

    const w = makeVillage({ reduce: true });
    w.village.start();
    w.village.update(board(rows), { privacy: false });
    w.village.enterCastle();
    const still = loop.pump(3);
    assert(still.frames <= 3, `reduced motion draws the hall on demand (${still.frames} frames in 3 s)`);
    for (const i of [0, 7, 19]) {
      const p = V.castleLayout(20).points[i];
      assert(w.sweep(p.x, p.y, 200).includes(ids[i]), `reduced motion: guest ${i} stands still on its spread spot`);
    }
    w.village.destroy();
  });
});

check('the cottage: hovering names it, a click looks inside, and the room hit-tests its guests', () => {
  const v = makeVillage();
  const rows = [row(A, 'idle'), row(B, 'recent', { kind: 'cli', canOpen: false, canCopyResume: true }), row(C, 'running')];
  v.village.update(board(rows), { privacy: false });
  const [bx, by] = V.COTTAGE.badge;
  v.fire('pointermove', bx, by);
  eq(v.hoveredId(), V.COTTAGE_ID, 'hover id');
  eq(V.COTTAGE_ID, 'cottages:room', 'the id the page knows it by');
  const point = v.log.hovers.at(-1).point;
  assert(Math.abs(point.x - bx) < 1 && point.y < by, `point at the top of the count badge (${JSON.stringify(point)})`);
  v.click(bx, by);
  eq(v.log.scenes, ['cottages'], 'went inside');
  eq(v.hoveredId(), null, 'hover cleared on the way in');
  v.village.enterCottages();
  eq(v.log.scenes, ['cottages'], 'entering again reports nothing');
  const cSlot = V.layoutVillage(rows).get(C);
  assert(!v.sweep(cSlot.x, cSlot.y).includes(C), 'village characters are not in the room');
  v.fire('pointermove', bx, by);
  assert(v.hoveredId() !== V.COTTAGE_ID, 'no cottage to hover from inside it');
  // Both cottage lanes are inside, seated at the room's own tables.
  const seats = V.cottageSeatLayout(2).points;
  const at = v.aimPoint(seats[0].x, seats[0].y, A, 200);
  v.click(at.x, at.y);
  eq(v.log.opened, [A], 'a guest that can open opens');
  const bt = v.aimPoint(seats[1].x, seats[1].y, B, 200);
  v.click(bt.x, bt.y, { detail: 2 });
  eq(v.log.selected, [], 'the double-click guard holds inside');
  v.click(bt.x, bt.y);
  eq(v.log.selected, [B], 'a terminal guest selects');
  // The page leaves an interior by name or by the generic exit (Escape and its back button use whichever it finds).
  v.village.leaveCottages();
  v.village.leaveCottages();
  eq(v.log.scenes, ['cottages', 'village'], 'left once');
  v.village.enterCottages();
  v.village.leaveScene();
  eq(v.log.scenes, ['cottages', 'village', 'cottages', 'village'], 'leaveScene works from the room too');
  v.village.enterCastle();
  v.village.leaveCottages();
  eq(v.log.scenes.at(-1), 'village', 'and either exit leaves the hall');
  v.fire('pointermove', bx, by);
  eq(v.hoveredId(), V.COTTAGE_ID, 'the cottage is back');
});

// The number the door promises has to be the number behind it: the badge, the lit windows and the page's tooltip all
// count every lane the room holds, not the idle lane alone.
check('the cottage door counts the room, not one of its two lanes', () => {
  const guests = [
    ...Array.from({ length: 2 }, (_, i) => row(`local_dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`, 'idle')),
    ...Array.from({ length: 6 }, (_, i) => row(`local_eeeeeeee-0000-4000-8000-${String(i).padStart(12, '0')}`, 'recent')),
  ];
  const texts = [];
  withFrameLoop((loop) => {
    const v = makeVillage({ texts });
    v.village.start();
    v.village.update(board(guests), { privacy: false });
    loop.pump(0.2);
    v.village.destroy();
  });
  assert(texts.includes('The Cottages'), `the sign names the place (${texts.slice(0, 12)})`);
  eq(texts.filter((s) => s === '8').length, 1, `the door badge counts all 8 in the room (${texts.filter((s) => /^\d+$/.test(s))})`);
  for (const n of ['2', '6']) assert(texts.includes(n), `the sign still breaks the room down by lane (${n})`);

  // Every one of them is in the room, and hit-tested there.
  const v = makeVillage();
  v.village.update(board(guests), { privacy: false });
  v.village.enterCottages();
  const seats = V.cottageSeatLayout(guests.length).points;
  eq(seats.length, guests.length, 'a spread spot per guest');
  const found = new Set();
  for (const s of seats) for (const id of v.sweep(s.x, s.y, 200)) found.add(id);
  eq(found.size, guests.length, `the room hit-tests all ${guests.length} guests (${found.size})`);

  // Inside, the plaque names both lanes in one line and is not truncated (the note is fitted to 340 px, and this
  // recorder measures a wide 8.5 px a character, so a note that fits here fits on a real canvas).
  const inside = [];
  withFrameLoop((loop) => {
    const w = makeVillage({ texts: inside, measure: true });
    w.village.start();
    w.village.update(board(guests), { privacy: false });
    w.village.enterCottages();
    loop.pump(0.2);
    w.village.destroy();
  });
  const note = inside.find((s) => s.startsWith('Quiet'));
  eq(note, 'Quiet for 2 hours, or active this week', `the room's note covers both of its lanes (${JSON.stringify(inside.slice(0, 8))})`);
  for (const n of ['2', '6']) assert(inside.includes(n), `a count pill per lane on the plaque (${n})`);

  // The page's tooltip names both lanes and totals the same number.
  if (app) {
    const m = app.cottageRoomModel(2, 6);
    eq([m.title, m.count, m.rows.map((r) => [r.key, r.lane, r.text])],
      ['The Cottages', 8, [['Idle', 'idle', '2 sessions'], ['Recent', 'recent', '6 sessions']]], 'both lanes');
    assert(m.text.includes('Idle: 2 sessions') && m.text.includes('Recent: 6 sessions'), `aria text: ${m.text}`);
    // A purely idle cottage reads as it always did: no Recent row at 0.
    eq(app.cottageRoomModel(1, 0).rows.map((r) => r.text), ['1 session'], 'one idle session');
  }
});

check('the cottage room spreads and wanders its guests the way the hall does', () => {
  const [fx, fy, fw, fh] = V.ROOM.floor;
  assert(fw > 600 && fh > 300, `the room has a floor to wander (${JSON.stringify(V.ROOM.floor)})`);
  eq([V.ROOM.sepX, V.ROOM.sepY, V.ROOM.fill, V.ROOM.minScale, V.ROOM.maxScale],
    [V.HALL.sepX, V.HALL.sepY, V.HALL.fill, V.HALL.minScale, V.HALL.maxScale], 'the same crowd rules as the hall');
  let last = Infinity;
  for (const n of [1, 2, 5, 12, 22, 80, 150, 300]) {
    const g = V.castleLayout(n, null, V.ROOM);
    eq(g.points.length, n, `${n} spots`);
    assert(g.scale <= last + 1e-9 && g.scale >= V.ROOM.minScale && g.scale <= V.ROOM.maxScale, `scale ${g.scale} for ${n}`);
    last = g.scale;
    for (const p of g.points) assert(p.x >= fx && p.x <= fx + fw && p.y >= fy && p.y <= fy + fh, `${n}: spot ${JSON.stringify(p)} on the floor`);
    const crowded = g.points.map((p) => ({ px: p.x, py: p.y }));
    crowded.forEach((a, i) => crowded.forEach((b, k) => {
      if (k > i) assert(V.hallSpacing(a, b, g.scale, V.ROOM) >= 1, `${n}: spots ${i} and ${k} start ${V.hallSpacing(a, b, g.scale, V.ROOM).toFixed(2)} apart`);
    }));
  }
  eq(V.castleLayout(7, null, V.ROOM), V.castleLayout(7, null, V.ROOM), 'the same crowd starts on the same spots');
  // Token sizes multiply the crowd scale here too.
  const sizes = Array.from({ length: 40 }, (_, i) => (i % 2 ? 1.5 : 1.2));
  const mixed = V.castleLayout(40, sizes, V.ROOM);
  assert(mixed.scale < V.castleLayout(40, null, V.ROOM).scale, 'big guests shrink the crowd scale');
  for (const n of [1, 2, 5, 20, 60, 150]) {
    const layout = V.castleLayout(n, null, V.ROOM);
    const k = layout.scale;
    const guests = layout.points.map((p, i) => ({ px: p.x, py: p.y, rng: seeded(2000 + i) }));
    const travelled = new Array(n).fill(0);
    const paused = new Array(n).fill(false);
    let worst = Infinity;
    const dt = 1 / 24;
    for (let f = 0; f < 24 * 40; f++) {
      const before = guests.map((g) => [g.px, g.py]);
      V.wanderStep(guests, dt, k, V.ROOM);
      guests.forEach((g, i) => {
        assert(g.px >= fx - 1e-9 && g.px <= fx + fw + 1e-9 && g.py >= fy - 1e-9 && g.py <= fy + fh + 1e-9, `${n}: guest ${i} left the room`);
        travelled[i] += Math.hypot(g.px - before[i][0], g.py - before[i][1]);
        if (!g.walking && g.pause > 0) paused[i] = true;
      });
      if (f >= 24 * 5) {
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) worst = Math.min(worst, V.hallSpacing(guests[i], guests[j], k, V.ROOM));
      }
    }
    if (n > 1) assert(worst >= 0.8, `${n}: two guests overlap once settled (spacing ${worst.toFixed(2)})`);
    assert(travelled.every((d) => d > 150), `${n}: everyone wanders (least ${Math.min(...travelled).toFixed(0)} px in 40 s)`);
    assert(paused.every(Boolean), `${n}: everyone pauses now and then`);
  }
});

check('the cottage room wanders at up to 24 fps only while open, and holds a hovered guest still', () => {
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false });
    v.village.start();
    const ids = Array.from({ length: 20 }, (_, i) => `local_fefefefe-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const rows = [...ids.map((id) => row(id, 'idle')), row(A, 'running')];
    v.village.update(board(rows), { privacy: false });
    loop.pump(0.5);
    const outside = loop.pump(2);
    assert(outside.frames <= 26, `ambient in the village while they are indoors (${outside.frames} frames in 2 s)`);
    v.village.enterCottages();
    loop.pump(0.2);
    const inside = loop.pump(2);
    assert(inside.frames <= 48, `at most 24 fps in the room (${inside.frames} frames in 2 s)`);
    assert(inside.frames > 26, `faster than ambient while the room is open (${inside.frames} frames in 2 s)`);
    const scale = V.cottageSeatLayout(20).scale;
    const spot = V.cottageSeatLayout(20).points[3];
    v.aimPoint(spot.x, spot.y, ids[3], 240);
    const held = v.log.hovers.filter((h) => h.id === ids[3]).at(-1).point;
    loop.pump(3);
    const now = v.log.hovers.filter((h) => h.id === ids[3]).at(-1).point;
    assert(Math.hypot(now.x - held.x, now.y - held.y) <= 2, `the hovered guest holds still while its tooltip is read (${JSON.stringify(now)})`);
    v.fire('pointerleave', 0, 0);
    v.village.leaveScene();
    loop.pump(0.2);
    const after = loop.pump(2);
    assert(after.frames <= 26, `back to ambient after leaving (${after.frames} frames in 2 s)`);
    loop.pump(6);
    v.village.enterCottages();
    v.fire('pointermove', now.x, now.y + 14 * Math.min(1, scale));
    eq(v.hoveredId(), ids[3], 'nobody wandered while the room was closed');
    v.village.destroy();

    const w = makeVillage({ reduce: true });
    w.village.start();
    w.village.update(board(rows), { privacy: false });
    w.village.enterCottages();
    const still = loop.pump(3);
    assert(still.frames <= 3, `reduced motion draws the room on demand (${still.frames} frames in 3 s)`);
    for (const i of [0, 7, 19]) {
      const p = V.cottageSeatLayout(20).points[i];
      assert(w.sweep(p.x, p.y, 240).includes(ids[i]), `reduced motion: guest ${i} stands still on its spread spot`);
    }
    w.village.destroy();
  });
});

check('a session going idle walks to the cottage door and fades inside; one coming back walks out of it', () => {
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false });
    v.village.start();
    const before = [row(A, 'running')];
    v.village.update(board(before), { privacy: false });
    loop.pump(0.5);
    const from = V.layoutVillage(before).get(A);
    v.village.update(board([row(A, 'idle')]), { privacy: false });
    // It walks off the workshop bench towards the cottage door, then fades.
    const route = V.planRoute({ x: from.x, y: from.y }, V.COTTAGE.door);
    assert(V.routeLength(route) > 100, 'there is a walk to the door');
    loop.pump(V.walkDuration(V.routeLength(route)) + V.FADE_S + 0.4);
    assert(!v.sweep(from.x, from.y).includes(A), 'gone from the workshop');
    assert(!v.sweep(V.COTTAGE.door.x, V.COTTAGE.door.y, 120).includes(A), 'and gone from the door');
    v.village.enterCottages();
    loop.pump(0.2);
    const seat = V.cottageSeatLayout(1).points[0];
    assert(v.sweep(seat.x, seat.y, 240).includes(A), 'seated in the room');
    v.village.leaveScene();
    // Back to work: it appears at the cottage door and walks to the bench.
    v.village.update(board([row(A, 'running')]), { privacy: false });
    loop.pump(0.3);
    const near = v.sweep(V.COTTAGE.door.x, V.COTTAGE.door.y, 140);
    assert(near.includes(A), `steps out of the cottage door (${JSON.stringify(near)})`);
    loop.pump(4);
    const back = V.layoutVillage([row(A, 'running')]).get(A);
    assert(v.sweep(back.x, back.y).includes(A), 'and is back at its bench');
    v.village.destroy();
  });
});

check('privacy names hall guests and headstones by place, never by title', () => {
  const texts = [];
  withFrameLoop((loop) => {
    const v = makeVillage({ texts });
    v.village.start();
    const rows = [
      row(A, 'castle', { title: 'Secret client project', repo: 'repo-x', worktree: 'tree-a' }),
      row(B, 'graveyard', { title: 'Another secret', repo: 'repo-x', worktree: 'tree-b' }),
    ];
    v.village.update(board(rows), { privacy: true });
    v.aimPoint(V.GRAVE_SLOTS[0].x, V.GRAVE_SLOTS[0].y, B, 40);
    loop.pump(0.3);
    v.village.enterCastle();
    const seat = V.castleLayout(1).points[0];
    v.aimPoint(seat.x, seat.y, A, 160);
    loop.pump(0.3);
    v.village.destroy();
  });
  assert(!texts.some((t) => /secret/i.test(t)), 'no title drawn');
  assert(texts.includes('tree-b \u00b7 repo-x'), 'headstone plate');
  assert(texts.includes('tree-a \u00b7 repo-x'), 'hall plate');
});

check('an onScene or onHover handler that throws cannot break the village', () => {
  const listeners = new Map();
  const canvas = {
    width: 0, height: 0, style: {}, getContext: () => stub,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }),
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener() {},
  };
  const village = V.createVillage(canvas, { onScene() { throw new Error('page'); }, onHover() { throw new Error('page'); } });
  village.resize();
  village.update(board([row(A, 'castle')]), { privacy: false });
  village.enterCastle();
  village.leaveCastle();
  village.enterCastle();
  village.destroy();
});

check('the harbour deck seats a full open-PR crowd without piling up', () => {
  const deck = V.HARBOUR_DECK;
  for (const n of [8, 12, 14]) {
    const g = V.slotGrid('harbour', n);
    eq(g.overflow, false, `${n} rows fit at the tightest spacing or better`);
    assert(g.dx >= 40 - 1e-9 && g.dy >= 42 - 1e-9, `${n}: spacing ${g.dx} x ${g.dy}`);
    for (const p of g.points) {
      assert(p.x >= deck[0] + 12 && p.x <= deck[0] + deck[2] - 12 && p.y > deck[1] + 50 && p.y <= deck[1] + deck[3] - 6,
        `${n}: slot ${JSON.stringify(p)} stands on the deck`);
    }
  }
  const [, sy] = V.PLACES.harbour.sign;
  const topBadge = V.slotGrid('harbour', 12).points.reduce((m, p) => Math.min(m, p.y), Infinity) - 6 - 44 - 28 - 14;
  assert(sy - 27 + 54 - 4 + 26 <= topBadge, `the sign post ends above the top row's badges (${topBadge})`);
});

check('errored rows on the porch steps keep readable plates', () => {
  const title = 'Fix the loyalty points expiry calculation';
  // The steps hold 4 at 120 px apart, two to each of the Porch's two rows, so each plate keeps about a dozen
  // characters. Past that the spot spreads and plates narrow, as everywhere else in the village.
  for (const [n, least, prefix] of [[1, 20, 'Fix'], [2, 10, 'Fix'], [4, 10, 'Fix'], [6, 2, 'F'], [8, 2, 'F']]) {
    const texts = [];
    withFrameLoop((loop) => {
      const v = makeVillage({ texts, measure: true });
      v.village.start();
      const rows = Array.from({ length: n }, (_, i) => row(`local_dddddddd-0000-4000-8000-00000000000${i}`, 'errored', { title }));
      v.village.update(board(rows), { privacy: false });
      loop.pump(0.2);
      v.village.destroy();
    });
    const plates = texts.filter((t) => t.startsWith(prefix));
    assert(plates.length >= n, `${n}: every errored row has a plate (${plates.length})`);
    for (const t of plates) assert(Array.from(t).length >= least, `${n} rows: plate "${t}" keeps at least ${least} characters`);
  }
});

check('the smaller beach still seats a crowd, clear of the sand castle, the palm and the jetty', () => {
  let umbrellas = 0;
  let capacity = 0;
  for (let n = 1; n <= 17; n++) {
    const g = V.slotGrid('beach', n);
    eq(g.points.length, n, `${n} slots`);
    if (!g.overflow) capacity = n;
    g.points.forEach((p, i) => {
      assert(V.onIsland(p.x, p.y, -8), `${n}: slot ${i} on the sand`);
      for (const o of V.BEACH_OBSTACLES) {
        assert(!V.boxesOverlap(V.loungerBox(p.x, p.y), o), `${n}: lounger ${i} at ${JSON.stringify(p)} covers ${JSON.stringify(o)}`);
      }
      if (i % 2 === 0 && g.dx >= 60 && V.umbrellaFits(p.x, p.y)) {
        umbrellas += 1;
        assert(!V.boxesOverlap(V.umbrellaBox(p.x, p.y), V.CASTLE.footprint), `${n}: umbrella ${i} covers the castle`);
      }
    });
  }
  assert(capacity >= 8, `the beach seats at least 8 without spreading (${capacity})`);
  assert(V.slotGrid('beach', capacity + 1).overflow, 'past that it spreads, and the sign still counts everyone');
  assert(umbrellas >= 4, `umbrellas still go up where there is room (${umbrellas})`);
  assert(!V.umbrellaFits(V.CASTLE.footprint[0] - 10, V.CASTLE.footprint[1] + 20), 'an umbrella by the castle door stays folded');
});

check('a tooltip on a character that fades into the castle clears when it is gone', () => {
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false });
    v.village.start();
    const before = [row(A, 'valhalla')];
    v.village.update(board(before), { privacy: false });
    loop.pump(0.3);
    v.aim(before, A);
    eq(v.hoveredId(), A, 'hovering the lounger');
    v.village.update(board([row(A, 'castle')]), { privacy: false });
    loop.pump(6);
    eq(v.log.hovers.at(-1), { id: null, point: null }, 'onHover(null, null) after the fade');
    const quiet = loop.pump(1);
    assert(quiet.frames <= 13, `clearing it does not raise the frame rate (${quiet.frames})`);
    v.village.destroy();
  });
});

check('the pier ends in open water, and a wide stretch of sea lies between its tip and the island jetty', () => {
  const pierTip = { x: V.PIER.x, y: V.PIER.tip };
  const jettyTip = { x: V.JETTY.x, y: V.JETTY.tip };
  const gap = Math.hypot(jettyTip.x - pierTip.x, jettyTip.y - pierTip.y);
  assert(gap >= 140 && jettyTip.y - pierTip.y >= 140, `pier tip to jetty tip ${gap.toFixed(0)} (${jettyTip.y - pierTip.y} down)`);
  assert(pierTip.x > V.shoreX(pierTip.y) + 100, 'the pier reaches well out from the shore');
  for (let i = 0; i <= 40; i++) {
    const p = { x: pierTip.x + (jettyTip.x - pierTip.x) * (i / 40), y: pierTip.y + 2 + (jettyTip.y - 2 - pierTip.y) * (i / 40) };
    assert(inWater(p), `open water between the tips at ${JSON.stringify(p)}`);
  }
  let nearestSand = Infinity;
  for (let x = 1150; x <= 1600; x += 3) {
    for (let y = pierTip.y; y <= 900; y += 3) if (V.onIsland(x, y)) nearestSand = Math.min(nearestSand, Math.hypot(x - pierTip.x, y - pierTip.y));
  }
  assert(nearestSand >= 140, `the island's sand is ${nearestSand.toFixed(0)} from the pier tip`);
  for (let y = 600; y <= 900; y += 6) {
    let left = null;
    for (let x = 1150; x <= 1600 && left === null; x += 2) if (V.onIsland(x, y)) left = x;
    if (left !== null) assert(left >= V.shoreX(y) + 60, `a channel of sea between the land and the island at y ${y}`);
  }

  const from = V.slotGrid('harbour', 3).points[1];
  const slot = V.slotGrid('beach', 4).points[2];
  const [walk1, sail, walk2] = V.planJourney({ ...from, area: 'land' }, { ...slot, area: 'island' });
  const end = walk1.pts.at(-1);
  const onPier = (p) => Math.abs(p.x - V.PIER.x) <= V.PIER.half && p.y > V.PIER.top && p.y <= V.PIER.tip;
  assert(onPier(end), `walks to the end of the pier (${JSON.stringify(end)})`);
  near(end.y, V.PIER.tip, 12, 'right to its tip');
  const before = walk1.pts.at(-2);
  assert(Math.abs(before.x - V.PIER.x) < 1 && before.y <= V.PIER.top, 'down the length of the pier');
  const berth = sail.pts[0];
  assert(berth.y > V.PIER.tip && Math.abs(berth.x - V.PIER.x) < 1 && inWater(berth), 'boards a boat moored off the tip');
  const dock = sail.pts.at(-1);
  assert(dock.y < V.JETTY.tip && Math.abs(dock.x - V.JETTY.x) < 1 && inWater(dock), 'docks off the jetty tip');
  assert(Math.abs(sail.land.x - V.JETTY.x) <= V.JETTY.half && sail.land.y >= V.JETTY.tip && sail.land.y < V.JETTY.foot, 'steps onto the jetty');
  assert(V.routeLength(sail.pts) >= 140, `the sail crosses the gap (${V.routeLength(sail.pts).toFixed(0)})`);
  eq(walk2.pts.at(-1), xy(slot), 'and walks to a lounger');
});

check('boat and passenger cross together, the boat sails home empty, and a boat comes out first to fetch a passenger', () => {
  const from = V.slotGrid('harbour', 1).points[0];
  const slot = V.slotGrid('beach', 1).points[0];
  const j = V.scheduleJourney(V.planJourney({ ...from, area: 'land' }, { ...slot, area: 'island' }), 50);
  const sail = j.legs[1];
  let inGap = 0;
  for (let i = 1; i < 60; i++) {
    const t = sail.t0 + V.HOP_S + (sail.dur - 2 * V.HOP_S) * (i / 60);
    const st = V.journeyAt(j, t);
    assert(st.inBoat && st.boat && st.boat.sail, `in the boat under sail at ${t.toFixed(2)}`);
    eq([st.boat.x, st.boat.y], [st.x, st.y], 'boat and passenger share one position');
    assert(inWater(st), `on the water at ${JSON.stringify(xy(st))}`);
    near(Math.hypot(st.boat.hx, st.boat.hy), 1, 1e-6, 'a heading for the wake');
    if (st.y > V.PIER.tip + 30 && st.y < V.JETTY.tip - 30) inGap += 1;
  }
  assert(inGap >= 30, `most of the sail is out in the open water (${inGap} of 59 samples)`);

  const trips = V.scheduleFerries(j, 50);
  eq(trips.map((f) => f.kind), ['return'], 'one empty trip home');
  const [home] = trips;
  near(home.t0, sail.t0 + sail.dur, 1e-9, 'sets off as the passenger steps onto the jetty');
  eq([home.pts[0], home.pts.at(-1)], [xy(V.JETTY_BERTH), xy(V.BOAT_BERTH)], 'from the jetty back to the pier');
  eq(xy(V.journeyAt(j, sail.t0 + sail.dur - 1e-6).boat), xy(V.ferryAt(home, home.t0)), 'the same boat, where the passenger left it');
  eq([V.ferryAt(home, home.t0 - 0.01), V.ferryAt(home, home.t0 + home.dur)], [null, null], 'drawn only during its trip');
  for (let i = 0; i < 20; i++) {
    const b = V.ferryAt(home, home.t0 + (home.dur * i) / 20);
    assert(b && b.sail && inWater(b), `the empty boat sails on the water (${JSON.stringify(b && xy(b))})`);
  }

  const back = V.scheduleJourney(V.planJourney({ ...slot, area: 'island' }, { ...from, area: 'land' }), 80);
  const fetch = V.scheduleFerries(back, 80);
  eq(fetch.map((f) => f.kind), ['fetch'], 'a boat comes out for a passenger leaving the island');
  const out = back.legs.find((l) => l.kind === 'sail');
  near(fetch[0].t0 + fetch[0].dur, out.t0, 1e-9, 'it reaches the jetty as the passenger boards');
  assert(fetch[0].t0 >= 80 - 1e-9, 'never before the plan was made');
  eq([fetch[0].pts[0], fetch[0].pts.at(-1)], [xy(V.BOAT_BERTH), xy(V.JETTY_BERTH)], 'from the pier to the jetty');
  const wait = back.legs.find((l) => l.kind === 'wait');
  assert(wait, 'the walk to the jetty is shorter than the sail out, so the passenger waits');
  eq(wait.pts[0], xy(V.JETTY_END), 'at the end of the jetty');
  const waiting = V.journeyAt(back, wait.t0 + wait.dur / 2);
  assert(!waiting.boat && !waiting.walking && waiting.area === 'island', 'standing, with no boat of its own yet');
  eq(xy(V.journeyAt(back, back.end + 0.01)), xy(from), 'and still arrives');
  let sum = 0;
  for (const l of back.legs) sum += l.dur;
  near(back.end - 80, sum, 1e-9, 'legs and end agree');

  const queued = { legs: [{ ...sail, t0: 10 }], t0: 10, end: 10 + sail.dur };
  eq(V.journeyAt(queued, 9.5).boat, null, 'a voyager waiting its turn on the pier has no boat yet');
});

check('in a burst of voyages both ways no two boats are ever drawn on top of each other', () => {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const harbour = V.slotGrid('harbour', 8).points;
  const beach = V.slotGrid('beach', 8).points;
  const kinds = new Set();
  let closest = Infinity;
  for (let run = 0; run < 120; run++) {
    const journeys = [];
    const ferries = [];
    let now = 0;
    const n = 1 + Math.floor(rand() * 7);
    for (let k = 0; k < n; k++) {
      now += rand() < 0.4 ? 0 : rand() * 6;
      const inbound = rand() < 0.25;
      const a = inbound ? { ...beach[k % 8], area: 'island' } : { ...harbour[k % 8], area: 'land' };
      const b = inbound ? { ...harbour[(k + 3) % 8], area: 'land' } : { ...beach[(k + 2) % 8], area: 'island' };
      const j = V.scheduleJourney(V.planJourney(a, b), now + (rand() < 0.5 ? 0 : 0.2 * k));
      const trips = V.scheduleFerries(j, now);
      V.planBoats(j, trips, { journeys: journeys.filter((x) => x.end > now), ferries: ferries.filter((f) => f.t0 + f.dur > now) }, now);
      journeys.push(j);
      ferries.push(...trips);
    }
    for (const f of ferries) kinds.add(f.kind);
    const end = Math.max(...journeys.map((j) => j.end), ...ferries.map((f) => f.t0 + f.dur));
    for (let t = 0; t < end; t += 0.04) {
      const boats = [];
      for (const j of journeys) if (t >= j.t0 && t < j.end && V.journeyAt(j, t).boat) boats.push(V.journeyAt(j, t).boat);
      for (const f of ferries) {
        const b = V.ferryAt(f, t);
        if (b && b.alpha >= 0.35) boats.push(b);
      }
      for (let i = 0; i < boats.length; i++) {
        for (let k = i + 1; k < boats.length; k++) closest = Math.min(closest, Math.hypot(boats[i].x - boats[k].x, boats[i].y - boats[k].y));
      }
    }
    for (const j of journeys) {
      for (const leg of j.legs) if (leg.kind === 'sail') for (const p of leg.pts) assert(inWater(p), 'sails stay on the water');
    }
  }
  assert(closest >= 96, `two boats came within ${closest.toFixed(0)} px (a hull is 84 wide)`);
  for (const kind of ['return', 'fetch', 'fade', 'appear']) assert(kinds.has(kind), `a burst exercises ${kind} boats`);

  const one = V.scheduleJourney(V.planJourney({ ...harbour[0], area: 'land' }, { ...beach[0], area: 'island' }), 0);
  const trip = V.keepAtJetty({ ...V.scheduleFerries(one, 0)[0] });
  eq([trip.kind, trip.pts, trip.dur], ['fade', [xy(V.JETTY_BERTH)], V.FADE_S], 'a return kept at the jetty fades where its passenger landed');
  near(V.ferryAt(trip, trip.t0 + V.FADE_S / 2).alpha, 0.5, 1e-9, 'half faded');
});

// The boats one frame drew, one per hull: a passenger's boat drawn behind and in front of it counts once.
const hullsOf = (drawn) => {
  const groups = new Map();
  for (const b of drawn) {
    const key = `${b.x.toFixed(2)},${b.y.toFixed(2)}`;
    groups.set(key, { ...b, n: (groups.get(key) || { n: 0 }).n + 1 });
  }
  return [...groups.values()].flatMap((g) => Array.from({ length: Math.ceil(g.n / 2) }, () => g));
};
const closestHulls = (hulls) => {
  let closest = Infinity;
  for (let i = 0; i < hulls.length; i++) for (let k = i + 1; k < hulls.length; k++) closest = Math.min(closest, Math.hypot(hulls[i].x - hulls[k].x, hulls[i].y - hulls[k].y));
  return closest;
};
// Dry footing over the sea: the roads where they reach the water, the harbour deck, the pier and the jetty.
const onDryPath = (p) => {
  const road = V.ROAD_EDGES.some(([a, b]) => {
    const [ax, ay] = V.ROAD_NODES[a];
    const [bx, by] = V.ROAD_NODES[b];
    const k = Math.max(0, Math.min(1, ((p.x - ax) * (bx - ax) + (p.y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    return Math.hypot(p.x - (ax + (bx - ax) * k), p.y - (ay + (by - ay) * k)) <= 20;
  });
  const [dx, dy, dw, dh] = V.HARBOUR_DECK;
  const deck = p.x >= dx - 2 && p.x <= dx + dw + 2 && p.y >= dy - 2 && p.y <= dy + dh + 2;
  const pier = Math.abs(p.x - V.PIER.x) <= V.PIER.half + 2 && p.y >= V.PIER.top - 2 && p.y <= V.PIER.tip + 2;
  const jetty = Math.abs(p.x - V.JETTY.x) <= V.JETTY.half + 2 && p.y >= V.JETTY.tip - 2 && p.y <= V.JETTY.foot + 2;
  return road || deck || pier || jetty;
};
// Follows one character through the hover reports of a still pointer, frame by frame, with the boats each frame drew.
// Reports carry the top of the badge; `offset` turns that into the feet.
const followFrames = (v, loop, drawn, id, seconds, onFrame) => {
  drawn.splice(0);
  let seen = v.log.hovers.length;
  loop.pump(seconds, () => {
    if (!drawn.length && v.log.hovers.length === seen) return;
    const reports = v.log.hovers.slice(seen).filter((h) => h.id === id);
    seen = v.log.hovers.length;
    onFrame(reports.at(-1) || null, hullsOf(drawn.splice(0)));
  });
};

check('a voyager whose beach slot changes on its way keeps its route and its boat, and never walks on the water', () => {
  const plan = () => V.scheduleJourney(V.planJourney({ ...V.slotGrid('harbour', 2).points[0], area: 'land' }, { ...V.slotGrid('beach', 2).points[1], area: 'island' }), 10);
  const newSlot = { ...V.slotGrid('beach', 1).points[0], area: 'island' };
  const j = plan();
  const before = j.legs.slice(0, -1).map((l) => [l.kind, l.t0, l.dur, l.pts]);
  const sail = j.legs[1];
  for (const t of [10.5, sail.t0 - 0.1, sail.t0 + sail.dur / 2]) {
    const k = plan();
    assert(V.retargetJourney(k, newSlot, t), `retargets at ${t}`);
    eq(k.legs.slice(0, -1).map((l) => [l.kind, l.t0, l.dur, l.pts]), before, 'the walk to the pier and the crossing are unchanged');
    const last = k.legs.at(-1);
    eq([last.kind, last.area, xy(last.pts[0]), xy(last.pts.at(-1))], ['walk', 'island', xy(V.JETTY_END), xy(newSlot)], 'walks from the jetty to the new chair');
    near(k.end, last.t0 + last.dur, 1e-9, 'ends when the new walk does');
  }
  assert(!V.retargetJourney(plan(), newSlot, j.legs[2].t0 + 0.1), 'not once the last walk has started');
  assert(!V.retargetJourney(plan(), { x: 700, y: 560, area: 'land' }, 10.5), 'not to another area');
  const door = plan();
  assert(V.retargetJourney(door, { ...V.CASTLE.door, area: 'island' }, 10.5, { fade: true }), 'into the castle');
  eq(door.legs.map((l) => l.kind), ['walk', 'sail', 'walk', 'fade'], 'walks to the castle door and fades');

  withFrameLoop((loop) => {
    const later = 'local_11111111-0000-4000-8000-000000000001';
    const first = 'local_22222222-0000-4000-8000-000000000002';
    const drawn = [];
    const v = makeVillage({ reduce: false, boats: drawn });
    v.village.start();
    const swings = [row(first, 'your_turn'), row(later, 'your_turn')];
    v.village.update(board(swings), { privacy: false });
    loop.pump(1);
    v.aim(swings, later);
    const seat = V.layoutVillage(swings).get(later);
    v.village.update(board([row(first, 'valhalla'), row(later, 'your_turn')]), { privacy: false });
    loop.pump(0.4);
    v.village.update(board([row(first, 'valhalla'), row(later, 'valhalla')]), { privacy: false });
    let offset = null;
    let afloat = 0;
    const onFrame = (report, hulls) => {
      if (!report) return;
      if (offset === null) offset = seat.y - report.point.y;
      const feet = { x: report.point.x, y: report.point.y + offset };
      if (!inWater(feet) || onDryPath(feet)) return;
      afloat += 1;
      assert(hulls.some((b) => Math.hypot(b.x - feet.x, b.y - feet.y) < 40), `on the water with no boat at ${JSON.stringify(xy(feet))}`);
    };
    followFrames(v, loop, drawn, later, 1.2, onFrame);
    // Undo on the first voyager moves the later one to the first chair while it is still walking to the pier.
    const after = [row(first, 'your_turn'), row(later, 'valhalla')];
    v.village.update(board(after), { privacy: false });
    followFrames(v, loop, drawn, later, 26, onFrame);
    assert(afloat >= 60, `crossed in its boat (${afloat} frames on the water)`);
    const last = v.log.hovers.filter((h) => h.id === later).at(-1).point;
    near(last.x, V.layoutVillage(after).get(later).x, 1, 'and reaches the first chair');
    v.village.destroy();
  });
});

check('Not done on a voyager afloat turns its boat back, and no two boats are ever drawn on top of each other', () => {
  const firstListed = 'local_22222222-0000-4000-8000-000000000002';
  const second = 'local_11111111-0000-4000-8000-000000000001';
  let closest = Infinity;
  for (let undo = 1.6; undo <= 7.01; undo += 0.3) {
    withFrameLoop((loop) => {
      const drawn = [];
      const v = makeVillage({ reduce: false, boats: drawn });
      v.village.start();
      const swings = [row(firstListed, 'your_turn'), row(second, 'your_turn')];
      v.village.update(board(swings), { privacy: false });
      loop.pump(1);
      v.aim(swings, firstListed);
      v.village.update(board([row(firstListed, 'valhalla'), row(second, 'valhalla')]), { privacy: false });
      followFrames(v, loop, drawn, firstListed, undo, (_r, hulls) => { closest = Math.min(closest, closestHulls(hulls)); });
      const after = [row(firstListed, 'your_turn'), row(second, 'valhalla')];
      v.village.update(board(after), { privacy: false });
      followFrames(v, loop, drawn, firstListed, 26, (_r, hulls) => { closest = Math.min(closest, closestHulls(hulls)); });
      const last = v.log.hovers.filter((h) => h.id === firstListed).at(-1).point;
      near(last.x, V.layoutVillage(after).get(firstListed).x, 1, `undo at ${undo.toFixed(1)} s: back on its swing`);
      v.village.destroy();
    });
  }
  assert(closest >= 90, `two boats drawn ${closest.toFixed(0)} apart (a hull is 84 wide)`);

  // The planner itself: a boat at its berth hops straight out; a queued voyage waits for a boat turning back; a boat with
  // another setting off behind it on the same lane finishes its crossing first.
  const harbour = V.slotGrid('harbour', 2).points;
  const beach = V.slotGrid('beach', 2).points;
  const voyage = (from, to, t, others = []) => {
    const j = V.scheduleJourney(V.planJourney({ ...from, area: 'land' }, { ...to, area: 'island' }), t);
    const trips = V.scheduleFerries(j, t);
    V.planBoats(j, trips, { journeys: others.map((o) => o.journey), ferries: others.flatMap((o) => o.trips) }, t);
    return { journey: j, trips };
  };
  const home = { ...harbour[0], area: 'land' };
  const tag = (id, v) => v.trips.map((f) => ({ owner: id, ...f }));
  {
    const a = voyage(harbour[0], beach[0], 0);
    const sail = a.journey.legs[1];
    const t = sail.t0 + 0.1;
    const boat = V.journeyAt(a.journey, t).boat;
    const out = V.turnBack({ id: 'a', boat, journey: a.journey, to: home }, [], tag('a', a), t);
    eq([out.pending, out.journey.legs[0].kind, out.journey.legs[0].dur], [null, 'sail', V.HOP_S], 'at its berth it hops straight back out');
  }
  {
    const a = voyage(harbour[0], beach[0], 0);
    const b = voyage(harbour[1], beach[1], 0, [a]);
    const sailA = a.journey.legs[1];
    const t = sailA.t0 + 1.2;
    assert(b.journey.legs[1].t0 > t, 'the second voyager is still waiting');
    const fleet = [...tag('a', a), ...tag('b', b)];
    const boat = V.journeyAt(a.journey, t).boat;
    const out = V.turnBack({ id: 'a', boat, journey: a.journey, to: home }, [{ id: 'b', journey: b.journey }], fleet, t);
    eq(out.pending, null, 'turns back at once');
    const landed = out.journey.legs[0].t0 + out.journey.legs[0].dur;
    assert(b.journey.legs[1].t0 >= landed + V.SAIL_GAP_S - 1e-9, 'the waiting voyager boards only after it has landed');
    assert(V.boatsKeepClear([out.journey, b.journey], new Set([out.journey, b.journey]), out.ferries, t), 'every boat stays clear');
  }
  {
    const a = voyage(harbour[0], beach[0], 0);
    const sailA = a.journey.legs[1];
    // A second boat sets off SAIL_GAP_S behind it, on the same lane.
    const lead = sailA.t0 + V.SAIL_GAP_S - voyage(harbour[1], beach[1], 0).journey.legs[1].t0;
    const b = voyage(harbour[1], beach[1], lead);
    // Two thirds of the way over: there is no hold that keeps them clear, since B is coming up the same lane.
    const t = sailA.t0 + V.HOP_S + (sailA.dur - 2 * V.HOP_S) * 0.66;
    assert(t > b.journey.legs[1].t0 + V.HOP_S, 'both are out on the water');
    const legsA = a.journey.legs.map((l) => [l.kind, l.t0]);
    const fleet = [...tag('a', a), ...tag('b', b)];
    const boat = V.journeyAt(a.journey, t).boat;
    const out = V.turnBack({ id: 'a', boat, journey: a.journey, to: home }, [{ id: 'b', journey: b.journey }], fleet, t);
    assert(out.pending && out.pending.to === home, 'finishes its crossing, then heads home');
    eq(out.journey.legs.map((l) => [l.kind, l.t0]), legsA.slice(0, 2), 'on the voyage it was already making');
    eq(out.journey.end, sailA.t0 + sailA.dur, 'until it lands');
    eq(out.ferries.map((f) => f.kind).sort(), fleet.map((f) => f.kind).sort(), 'with every boat trip as it was');
  }
});

check('a voyager waiting on the pier for its turn draws at most 12 fps, and full rate resumes as its boat leaves', () => {
  withFrameLoop((loop) => {
    const turned = 'local_11111111-0000-4000-8000-000000000001';
    const queued = 'local_33333333-0000-4000-8000-000000000003';
    const v = makeVillage({ reduce: false });
    v.village.start();
    // Running, not an open PR: a merged PR would first stop at the barrier for its stamp, which is motion of its own.
    const rows = [row(turned, 'your_turn'), row(queued, 'running')];
    v.village.update(board(rows), { privacy: false });
    loop.pump(1);
    v.aim(rows, queued);
    // Both leave in one scan, so the second is planned to board after the first; the first then turns straight back.
    v.village.update(board([row(turned, 'valhalla'), row(queued, 'valhalla')]), { privacy: false });
    loop.pump(0.1);
    v.village.update(board([row(turned, 'your_turn'), row(queued, 'valhalla')]), { privacy: false });
    const start = clock.ms;
    const frames = [];
    const moves = [];
    let seen = v.log.hovers.length;
    loop.pump(12, (ms) => {
      if (loop.rafs.length) frames.push(ms + 16);
      for (const h of v.log.hovers.slice(seen)) if (h.id === queued) moves.push({ ms, y: h.point.y });
      seen = v.log.hovers.length;
    });
    // The wait that counts is the one at the pier tip. Look 7 has a hat, so its badge top is 82 above its feet.
    const tipY = V.HARBOUR_BOARD.y - 82;
    let gap = { from: 0, to: 0 };
    for (let i = 1; i < moves.length; i++) {
      if (Math.abs(moves[i - 1].y - tipY) > 6) continue;
      if (moves[i].ms - moves[i - 1].ms > gap.to - gap.from) gap = { from: moves[i - 1].ms, to: moves[i].ms };
    }
    assert(gap.to - gap.from >= 1500 && gap.from - start < 3000, `waits on the pier for its turn (${gap.to - gap.from} ms)`);
    // From 900 ms on: the barrier it walked under settles back down just after it arrives, and that is motion.
    const still = frames.filter((ms) => ms >= gap.from + 900 && ms < gap.to - 100).length;
    const stillS = (gap.to - gap.from - 1000) / 1000;
    assert(still <= Math.ceil(stillS * 12) + 1, `ambient while it waits (${still} frames in ${stillS.toFixed(1)} s)`);
    const leaving = frames.filter((ms) => ms >= gap.to && ms < gap.to + 600).length;
    assert(leaving >= 30, `full rate as soon as it boards (${leaving} frames in 0.6 s)`);
    v.village.destroy();
  });
});

check('nothing overlaps on the right of the village with 0, 1, 5, 9 or 20 on the beach', () => {
  const post = ([cx, cy]) => [cx - 3.5, cy + 23, 7, 26];
  const half = V.PIER.half;
  const scenery = {
    deck: V.HARBOUR_DECK,
    pier: [V.PIER.x - half, V.PIER.top, 2 * half, V.PIER.tip - V.PIER.top],
    mooredBoat: [V.BOAT_BERTH.x - 44, V.BOAT_BERTH.y - 6, 88, 28],
    jetty: [V.JETTY.x - half, V.JETTY.tip, 2 * half, V.JETTY.foot - V.JETTY.tip],
    dockedBoat: [V.JETTY_BERTH.x - 44, V.JETTY_BERTH.y - 64, 88, 84],
    castle: V.CASTLE.rect,
    cottage: V.COTTAGE.rect,
    lighthouse: [1494, 52, 106, 136],
    harbourSign: V.signBox('harbour'),
    harbourPost: post(V.PLACES.harbour.sign),
    beachSign: V.signBox('beach'),
    beachPost: post(V.PLACES.beach.sign),
    porchSign: V.signBox('porch'),
    cottagesSign: V.signBox('cottages'),
    workshopSign: V.signBox('workshop'),
    house: V.PORCH_OBSTACLES[1],
    graveFence: V.GRAVEYARD.fence,
  };
  // Pairs that are meant to touch: a board and its post, the deck and its pier, a sign leaning on its building.
  const attached = new Set(['deck|pier', 'harbourSign|harbourPost', 'beachSign|beachPost', 'porchSign|house',
    'cottagesSign|cottage']);
  const names = Object.keys(scenery);
  names.forEach((a, i) => names.forEach((b, k) => {
    if (k <= i || attached.has(`${a}|${b}`) || attached.has(`${b}|${a}`)) return;
    assert(!V.boxesOverlap(scenery[a], scenery[b]), `${a} ${JSON.stringify(scenery[a])} overlaps ${b} ${JSON.stringify(scenery[b])}`);
  }));
  for (const [name, b] of Object.entries(scenery)) {
    assert(b[0] >= 0 && b[1] >= 0 && b[0] + b[2] <= V.LOGICAL_WIDTH && b[1] + b[3] <= V.LOGICAL_HEIGHT, `${name} is inside the canvas`);
  }
  // Every building and sign on the land is on the land, now that the coast has moved west.
  for (const name of ['porchSign', 'cottagesSign', 'workshopSign', 'house', 'cottage']) {
    const b = scenery[name];
    assert(b[0] + b[2] <= V.shoreX(b[1] + b[3] / 2), `${name} keeps its feet dry (coast ${V.shoreX(b[1] + b[3] / 2).toFixed(0)})`);
  }
  for (const p of V.slotGrid('harbour', 14).points) {
    const figure = [p.x - 22, p.y - 92, 44, 97];
    for (const k of ['harbourSign', 'harbourPost', 'lighthouse', 'mooredBoat']) assert(!V.boxesOverlap(figure, scenery[k]), `harbour crowd at ${JSON.stringify(p)} covers ${k}`);
  }
  for (const n of [0, 1, 5, 9, 20]) {
    const g = V.slotGrid('beach', n);
    eq(g.points.length, n, `${n} loungers`);
    if (n <= 9) eq(g.overflow, false, `${n}: the beach seats them at the planned spacing or tighter`);
    for (const p of g.points) {
      const box = V.loungerBox(p.x, p.y);
      assert(V.onIsland(p.x, p.y, -8), `${n}: lounger at ${JSON.stringify(p)} on the sand`);
      assert(box[0] >= 0 && box[0] + box[2] <= V.LOGICAL_WIDTH && box[1] + box[3] <= V.LOGICAL_HEIGHT, `${n}: lounger at ${JSON.stringify(p)} inside the canvas`);
      for (const [name, o] of Object.entries(scenery)) {
        if (name === 'dockedBoat' || name === 'beachSign' || name === 'beachPost') continue;
        assert(!V.boxesOverlap(box, o), `${n}: lounger at ${JSON.stringify(p)} covers ${name}`);
      }
    }
  }
});

// The island's outline, from the function that draws it: never a copy of the wobble, which would drift silently
// and would measure a shape nobody sees. The plain superellipse (`onIsland`) is up to 4.2 px inside it.
const islandRing = (inflate = 0) => V.islandOutline(inflate).map(([x, y]) => ({ x, y }));

check('the smaller island sits inside the canvas, out at sea, with a long crossing to it', () => {
  const sand = islandRing();
  const bx0 = Math.min(...sand.map((p) => p.x));
  const bx1 = Math.max(...sand.map((p) => p.x));
  const by0 = Math.min(...sand.map((p) => p.y));
  const by1 = Math.max(...sand.map((p) => p.y));
  const margin = Math.min(bx0, V.LOGICAL_WIDTH - bx1, by0, V.LOGICAL_HEIGHT - by1);
  assert(margin >= 16, `the whole island is inside the canvas with a margin (${margin.toFixed(0)}: ${bx0.toFixed(0)}..${bx1.toFixed(0)} x ${by0.toFixed(0)}..${by1.toFixed(0)})`);
  // The rings the island is drawn with: the sand, the wet sand (+4) and the foam (+9) are all inside the canvas, so
  // the shore never runs off the edge. The shallow-water halo (+30) is the one ring deliberately allowed off it: it
  // is a lighter water tone over water, so it meets the frame edge as the sea does, and is only held to a few px.
  for (const inflate of [0, 4, 9]) {
    for (const p of islandRing(inflate)) {
      assert(p.x <= V.LOGICAL_WIDTH && p.y <= V.LOGICAL_HEIGHT, `the +${inflate} ring at ${JSON.stringify(xy(p))} is inside the canvas`);
    }
  }
  const past = Math.max(...islandRing(30).map((p) => Math.max(p.x - V.LOGICAL_WIDTH, p.y - V.LOGICAL_HEIGHT)));
  assert(past <= 6, `the shallow halo meets the frame edge rather than swamping it (${past.toFixed(1)} px past)`);
  assert(V.ISLAND.rx <= 150 && V.ISLAND.ry <= 130, `the island is small (${V.ISLAND.rx} x ${V.ISLAND.ry})`);

  // Water all the way round: the nearest point of the mainland coast to the island's sand.
  let gap = Infinity;
  let at = null;
  for (let y = -40; y <= V.LOGICAL_HEIGHT + 40; y += 2) {
    const cx = V.shoreX(y);
    for (const p of sand) {
      const d = Math.hypot(p.x - cx, p.y - y);
      if (d < gap) {
        gap = d;
        at = { y, coast: Math.round(cx), sand: xy(p) };
      }
    }
  }
  assert(gap >= 200, `at least 200 px of water between the island and the mainland all round (${gap.toFixed(0)} at ${JSON.stringify(at)})`);

  // The boat route: from the berth off the pier tip to the island shore, all of it over open water.
  const route = [xy(V.BOAT_BERTH), ...V.SAIL_WAYPOINTS.map(xy), xy(V.JETTY_BERTH)];
  const sail = V.routeLength(route);
  assert(sail >= 400, `at least 400 px of open water along the route (${sail.toFixed(0)})`);
  let shore = null;
  for (let y = V.JETTY.tip; y <= V.JETTY.foot; y += 0.5) if (V.onIsland(V.JETTY.x, y) && shore === null) shore = y;
  assert(shore !== null && shore > V.JETTY_BERTH.y, 'the jetty crosses water before it reaches the sand');
  const toShore = sail + (shore - V.JETTY_BERTH.y);
  assert(toShore >= 400, `berth to the island shore over water (${toShore.toFixed(0)})`);
  const crossing = V.sailDuration(sail);
  assert(crossing >= 4.5 && crossing <= 5.5, `the crossing takes about 5 s (${crossing.toFixed(2)})`);

  // No boat ever crosses land: every point of the lane, and of the empty boats' lane, is in open water and a hull
  // clear of both shores.
  const lanes = [route, [xy(V.JETTY_BERTH), ...V.RETURN_WAYPOINTS.map(xy), xy(V.BOAT_BERTH)]];
  let minCoast = Infinity;
  let minSand = Infinity;
  for (const lane of lanes) {
    for (let i = 1; i < lane.length; i++) {
      for (let k = 0; k <= 120; k++) {
        const p = { x: lane[i - 1].x + (lane[i].x - lane[i - 1].x) * (k / 120), y: lane[i - 1].y + (lane[i].y - lane[i - 1].y) * (k / 120) };
        assert(inWater(p), `the lane stays on the water at ${JSON.stringify(p)}`);
        minCoast = Math.min(minCoast, p.x - V.shoreX(p.y));
        for (const q of sand) minSand = Math.min(minSand, Math.hypot(q.x - p.x, q.y - p.y));
      }
    }
  }
  assert(minCoast >= 44 && minSand >= 44, `a hull's width of water either side of the lane (coast ${minCoast.toFixed(0)}, sand ${minSand.toFixed(0)})`);

  // The hull itself, swept along both lanes at every phase of its bob and tilt: the lane centre's margin is not the
  // hull's, since the boat is drawn as an 84 px box and never turned to its heading. onIsland is inflated past the
  // wobble (up to 4.2 px) so being outside it means being off the drawn sand.
  let minHull = Infinity;
  let hullAt = null;
  for (const lane of lanes) {
    for (let i = 1; i < lane.length; i++) {
      for (let k = 0; k <= 600; k++) {
        const p = { x: lane[i - 1].x + (lane[i].x - lane[i - 1].x) * (k / 600), y: lane[i - 1].y + (lane[i].y - lane[i - 1].y) * (k / 600) };
        const box = V.hullBox(p.x, p.y);
        for (let y = box[1]; y <= box[1] + box[3] + 1e-9; y += 0.5) {
          const gap = box[0] - V.shoreX(y);
          if (gap < minHull) {
            minHull = gap;
            hullAt = { lane: xy(p), edge: Math.round(box[0]), y: Math.round(y), shore: Math.round(V.shoreX(y)) };
          }
        }
        for (const cx of [box[0], box[0] + box[2] / 2, box[0] + box[2]]) {
          for (const cy of [box[1], box[1] + box[3] / 2, box[1] + box[3]]) {
            assert(!V.onIsland(cx, cy, 6), `a hull at ${JSON.stringify(xy(p))} covers the island at ${cx.toFixed(0)},${cy.toFixed(0)}`);
          }
        }
      }
    }
  }
  assert(minHull > 0, `no hull ever crosses the waterline (${minHull.toFixed(1)} px of water at ${JSON.stringify(hullAt)})`);

  // The jetty tip is far enough out for the channel to read as sea, and the sand is well clear of the pier.
  let nearestSand = Infinity;
  for (const p of sand) nearestSand = Math.min(nearestSand, Math.hypot(p.x - V.PIER.x, p.y - V.PIER.tip));
  assert(nearestSand >= 200, `the island's sand is ${nearestSand.toFixed(0)} from the pier tip`);
  for (let y = 600; y <= 900; y += 4) {
    let left = null;
    for (let x = 1000; x <= 1600 && left === null; x += 2) if (V.onIsland(x, y)) left = x;
    if (left !== null) assert(left >= V.shoreX(y) + 200, `a channel of open sea at y ${y} (${(left - V.shoreX(y)).toFixed(0)})`);
  }
});

// The ground the village is allowed to draw a road on: the land, and the structures the harbour puts over the
// water. The 2 px tolerance is the road band against the deck it lies on, which is 2 px narrower than the band.
const SUPPORTED_GROUND = () => {
  const [dx, dy, dw, dh] = V.HARBOUR_DECK;
  return [
    ['the harbour deck', [dx, dy, dw, dh]],
    ['the boardwalk', [1466, 302, 160, 36]],
    ['the pier', [V.PIER.x - V.PIER.half, dy + dh - 6, 2 * V.PIER.half, V.PIER.tip - (dy + dh) + 6]],
    ...V.ROAD_QUAY.map((q, i) => [`the road quay ${i}`, q]),
  ];
};

check('no road is drawn on open water: the coast, or a deck, carries every part of the band', () => {
  const held = SUPPORTED_GROUND();
  const onSomething = (x, y) => held.some(([, [bx, by, bw, bh]]) => x >= bx - 2 && x <= bx + bw + 2 && y >= by - 2 && y <= by + bh + 2);
  const half = V.ROAD_BAND / 2;
  let worst = null;
  for (const [a, b] of V.ROAD_LINES) {
    for (let i = 0; i <= 2000; i++) {
      const cx = a[0] + (b[0] - a[0]) * (i / 2000);
      const cy = a[1] + (b[1] - a[1]) * (i / 2000);
      // The band, and the round cap that reaches half of it past each end.
      for (let k = 0; k < 48; k++) {
        const th = (k / 48) * Math.PI * 2;
        for (const r of [half, half * 0.6, 0]) {
          const x = cx + Math.cos(th) * r;
          const y = cy + Math.sin(th) * r;
          if (x <= V.shoreX(y) || onSomething(x, y)) continue;
          const d = x - V.shoreX(y);
          if (!worst || d > worst.d) worst = { d, x, y };
        }
      }
    }
  }
  assert(worst === null, worst && `road drawn ${worst.d.toFixed(0)} px out to sea at ${worst.x.toFixed(0)},${worst.y.toFixed(0)}`);
  // The quay is the piece that holds the junction up, and it earns its keep: without it the corner is at sea.
  const bare = held.filter(([name]) => !name.startsWith('the road quay'));
  const bareOn = (x, y) => bare.some(([, [bx, by, bw, bh]]) => x >= bx - 2 && x <= bx + bw + 2 && y >= by - 2 && y <= by + bh + 2);
  assert(!bareOn(1174, 560) && 1174 > V.shoreX(560), 'the junction at 1174,560 is over water');
  // And a boat passing it keeps half a hull from its planks, as it does from the coast.
  for (const [, q] of V.ROAD_QUAY.map((q, i) => [i, q])) {
    for (const lane of [[xy(V.BOAT_BERTH), ...V.SAIL_WAYPOINTS.map(xy), xy(V.JETTY_BERTH)]]) {
      for (let i = 1; i < lane.length; i++) {
        for (let k = 0; k <= 400; k++) {
          const p = { x: lane[i - 1].x + (lane[i].x - lane[i - 1].x) * (k / 400), y: lane[i - 1].y + (lane[i].y - lane[i - 1].y) * (k / 400) };
          if (p.y < q[1] - 21 || p.y > q[1] + q[3] + 21) continue;
          assert(p.x - (q[0] + q[2]) >= 44, `the lane at ${JSON.stringify(xy(p))} keeps half a hull from the quay (${(p.x - q[0] - q[2]).toFixed(0)})`);
        }
      }
    }
  }
  // The shed stands at the water's edge, and the quay is what its east post's foot rests on.
  const shedBody = [486, 386, 672, 152];
  assert(shedBody[0] + shedBody[2] <= V.shoreX(shedBody[1] + shedBody[3]), 'the shed body keeps to the land');
  const postFoot = [1151, 528, 12, 14];
  assert(postFoot[0] + postFoot[2] > V.shoreX(postFoot[1] + postFoot[3]), "the shed's east post reaches past the waterline");
  assert(V.ROAD_QUAY.some(([bx, by, bw, bh]) => postFoot[0] >= bx && postFoot[0] + postFoot[2] <= bx + bw
    && postFoot[1] + postFoot[3] <= by + bh && postFoot[1] + postFoot[3] >= by), 'so it stands on the quay');
});

check('what a tree paints stays inside the box it declares, in every theme pack', () => {
  // treeBox is what every other check reasons about: the signs keep clear of it, the ghosts keep out of it and the
  // world map lays out around it. A saguaro drawn on the tree's footing has to live inside the same box, or all of
  // that reasoning is about a shape that is no longer there.
  for (const pack of V.THEME_KEYS) {
    for (const dark of [false, true]) {
      const label = `${pack} ${dark ? 'dusk' : 'day'}`;
      const T = V.resolveTheme(pack, dark);
      const inks = new Set([T.tree, T.treeDark, T.treeLight, T.trunk]);
      const bg = [];
      // Long enough to cover a whole ent beat, because an ent dances and is drawn per frame rather than into the
      // background layer: every pose it takes has to stay inside the box, not just the one at rest. The frame and
      // the layer are read together, so a tree is found wherever its pack paints it.
      // Two passes, because the two are read differently: with `bg` the village blits its background layer and
      // the frames come back empty, and without it there is no document to make a layer at all. An ent dances and
      // is drawn per frame, so it is only in the second; every other tree is only in the first.
      paintFrames([], { dark, bg, seconds: 0.1, pack });
      const frames = paintFrames([], { dark, seconds: V.ENT_BEAT + 0.4, pack });
      const foliage = [...bg, ...frames.flat()].filter((sh) => inks.has(sh.style));
      assert(foliage.length >= V.TREES.length, `${label}: the trees are painted at all (${foliage.length} shapes)`);
      for (const tree of V.TREES) {
        const [bx, by, bw, bh] = V.treeBox(tree);
        // Attributed by its centre, so the flower beds and the harbour's scrub, which share these colours, are
        // only ever judged against the box they actually sit in.
        const mine = foliage.filter((sh) => {
          const cx = (sh.box[0] + sh.box[2]) / 2;
          const cy = (sh.box[1] + sh.box[3]) / 2;
          return cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh;
        });
        assert(mine.length >= 3, `${label}: the tree at ${JSON.stringify(tree)} paints something (${mine.length})`);
        for (const sh of mine) {
          const pad = sh.kind === 'stroke' ? sh.lw / 2 : 0;
          const out = Math.max(bx - (sh.box[0] - pad), (sh.box[2] + pad) - (bx + bw),
            by - (sh.box[1] - pad), (sh.box[3] + pad) - (by + bh));
          assert(out <= 0.01,
            `${label}: the tree at ${JSON.stringify(tree)} paints ${sh.kind} ${String(sh.style)} ${out.toFixed(2)} px outside its box`);
        }
      }
    }
  }
});

check('the ents dance, each to its own phase, and stand still when asked', () => {
  const beat = V.ENT_BEAT;
  for (const [x, y] of V.TREES) {
    const still = new Set();
    for (let t = 0; t <= beat; t += beat / 40) still.add(V.entSway(t, true, x, y));
    eq([...still], [0], `reduced motion holds the ent at ${x},${y} at rest`);
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t <= beat; t += beat / 90) {
      const k = V.entSway(t, false, x, y);
      assert(k >= -1 && k <= 1, `the ent at ${x},${y} sways within its own range (${k})`);
      lo = Math.min(lo, k);
      hi = Math.max(hi, k);
    }
    assert(hi - lo > 1.9, `the ent at ${x},${y} gets through a whole beat (${(hi - lo).toFixed(2)})`);
  }
  // Eight ents in step would read as one ent drawn eight times, which is the thing the whole draw is built to
  // avoid: their phases come off their own positions, so no two are at the same point of the beat.
  const at0 = V.TREES.map(([x, y]) => V.entSway(0, false, x, y).toFixed(3));
  eq(new Set(at0).size, V.TREES.length, 'no two ents are in step');
});

check("the Shire's own dressing stays on ground nothing else has claimed", () => {
  // Fields, hillsides and ponies are laid by hand into open ground, which is the one thing on the map with no
  // box of its own to keep them honest. Four field quads and a hillside were laid over the Porch's swings: the
  // spots are at y 734, so the ground looked free, but a swing frame reaches 90 px above its row and a row's
  // badge reaches PORCH_CEILING, and none of that is in any rect the layout checks reason about.
  const box = (pts) => {
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  };
  const dressing = [
    ...V.SHIRE_FIELDS.map((f, i) => [`field ${i}`, box(f)]),
    // A hillside is drawn as the top half of an ellipse, with its ground shadow 5 right and 3 down of it.
    ...V.SHIRE_HOLES.map((h, i) => [`hillside ${i}`, [h.x - h.r, h.y - h.r * 0.86, h.r * 2 + 5, h.r * 0.86 + 11]]),
    ...V.SHIRE_PONIES.map((q, i) => [`pony ${i}`,
      [q.x + V.PONY_BOX[0], q.y + V.PONY_BOX[1], V.PONY_BOX[2] - V.PONY_BOX[0], V.PONY_BOX[3] - V.PONY_BOX[1]]]),
  ];
  const taken = { porch: V.PORCH_GROUND, jail: V.JAIL.plot, graveyard: V.GRAVEYARD.fence, cottage: V.COTTAGE.rect };
  for (const [name, o] of Object.entries(V.SPOTS)) taken[`the ${name} spot`] = o.rect;
  for (const [i, o] of V.PORCH_OBSTACLES.entries()) taken[`the porch house ${i}`] = o;
  for (const place of V.PLACE_KEYS) taken[`the ${place} sign`] = V.signBox(place);
  taken['the graveyard sign'] = [V.GRAVEYARD.sign[0] - 60, V.GRAVEYARD.sign[1] - 30, 120, 60];
  V.TREES.forEach((tree, i) => { taken[`tree ${i}`] = V.treeBox(tree); });
  const roadBands = V.ROAD_LINES.map(([[x0, y0], [x1, y1]]) => {
    const half = V.ROAD_BAND / 2;
    return y0 === y1
      ? [Math.min(x0, x1), y0 - half, Math.abs(x1 - x0), V.ROAD_BAND]
      : [x0 - half, Math.min(y0, y1), V.ROAD_BAND, Math.abs(y1 - y0)];
  });
  roadBands.forEach((b, i) => { taken[`road ${i}`] = b; });

  assert(dressing.length >= 8, `there is dressing to check (${dressing.length} pieces)`);
  for (const [name, b] of dressing) {
    assert(b[0] >= 0 && b[1] >= 0 && b[0] + b[2] <= 1600 && b[1] + b[3] <= 900, `${name} is on the canvas`);
    assert(b[0] + b[2] < V.shoreX(b[1] + b[3] / 2), `${name} reaches the sea`);
    for (const [what, t] of Object.entries(taken)) {
      assert(!V.boxesOverlap(b, t), `${name} ${JSON.stringify(b)} is laid over ${what} ${JSON.stringify(t)}`);
    }
  }
});

check('every tree stands on the land, clear of the signs', () => {
  eq(V.TREES.length, 8, 'the trees');
  for (const tree of V.TREES) {
    const box = V.treeBox(tree);
    const east = box[0] + box[2];
    for (let y = box[1]; y <= box[1] + box[3]; y += 1) {
      assert(east <= V.shoreX(y) - 10, `a tree at ${JSON.stringify(tree)} reaches the sea at y ${y.toFixed(0)} (${(east - V.shoreX(y)).toFixed(0)} px past it)`);
    }
    for (const place of V.PLACE_KEYS) {
      assert(!V.boxesOverlap(box, V.signBox(place)), `a tree at ${JSON.stringify(tree)} covers the ${place} sign`);
    }
    assert(!V.boxesOverlap(box, V.COTTAGE.rect), `a tree at ${JSON.stringify(tree)} covers the cottage`);
  }
});

// The jail's rows, at the plain size unless a token block is given. Its cap is set by geometry alone, so a check
// that holds at the cap holds for a 1.5x token size too: that is the size drawn exactly at the cap.
const jailRows = (n, extra = {}) => Array.from({ length: n }, (_, i) => row(`local_11111111-0000-4000-8000-${String(i).padStart(12, '0')}`, 'jail', extra));
const jailSlots = (n, extra = {}) => [...V.layoutVillage(jailRows(n, extra)).values()];

// The ground one ghost perch can ever cover, over every phase of its bob and sway. The periods are irrational
// against each other, so the sweep is long enough to reach both extremes of each.
const spanOfGhost = (g) => {
  let u = [Infinity, Infinity, -Infinity, -Infinity];
  for (let t = 0; t < 240; t += 0.01) {
    const b = V.ghostBox(t, false, g);
    u = [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[0] + b[2]), Math.max(u[3], b[1] + b[3])];
  }
  return [u[0], u[1], u[2] - u[0], u[3] - u[1]];
};
const ghostSpans = V.GHOSTS.map(spanOfGhost);
// The ground every ghost together can cover: what the rest of the village has to stay out of.
const ghostSpan = (() => {
  const u = ghostSpans.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]),
    Math.max(a[2], b[0] + b[2]), Math.max(a[3], b[1] + b[3])], [Infinity, Infinity, -Infinity, -Infinity]);
  return [u[0], u[1], u[2] - u[0], u[3] - u[1]];
})();

check('the jail keeps to its own corner, and nothing else reaches it', () => {
  // The ground the layout left free: 260 x 204 of green in the top left, room for the sign included.
  const plot = V.JAIL.plot;
  eq(plot, [70, 46, 260, 204], "the jail's plot");
  const r1 = (b) => b.map((v) => Math.round(v * 10) / 10);
  const inside = (b, what) => assert(b[0] >= plot[0] - 1e-6 && b[1] >= plot[1] - 1e-6
    && b[0] + b[2] <= plot[0] + plot[2] + 1e-6 && b[1] + b[3] <= plot[1] + plot[3] + 1e-6,
  `${what} ${JSON.stringify(r1(b))} is inside the jail's plot ${JSON.stringify(plot)}`);
  inside(V.JAIL.block, 'the cell block');
  inside(V.JAIL.yard, 'the yard');
  inside(V.JAIL.door, 'the door');
  inside(V.signBox('jail'), 'the sign board');
  for (const w of V.JAIL.windows) inside(w, 'a barred window');
  for (const b of [...V.jailBarBoxes(), ...V.jailBarBoxes(true)]) inside(b, 'a bar');
  for (const r of V.jailRails()) inside(r, 'a rail');
  for (const x of V.JAIL.posts) inside([x - 3.5, 94, 7, 30], 'a sign post');
  for (const n of [1, 5, 9, 20]) {
    for (const s of jailSlots(n)) {
      for (const part of V.avatarBoxes('jail', s.x, s.y, s.cap)) inside(part, `a prisoner at ${s.x},${s.y} with ${n} in the jail`);
    }
  }

  // Nothing else in the village reaches into it, including the two trees that stand either side.
  const taken = {
    graveFence: V.GRAVEYARD.fence, graveSign: [269, 459, 130, 54],
    workshopSign: V.signBox('workshop'), cottage: V.COTTAGE.rect, cottagesSign: V.signBox('cottages'),
    porchSign: V.signBox('porch'), house: V.PORCH_OBSTACLES[1], lantern: V.PORCH_OBSTACLES[0],
    workshopShed: [472, 340, 700, 198],
    ghost: ghostSpan,
  };
  // The trees either side of the plot, from the list that is drawn rather than boxes copied out of it.
  V.TREES.forEach((tree, i) => { taken[`tree${i}`] = V.treeBox(tree); });
  for (const [name, box] of Object.entries(taken)) assert(!V.boxesOverlap(plot, box), `${name} ${JSON.stringify(box)} is in the jail's ground`);
  for (const spot of V.SPOT_KEYS) {
    if (V.SPOTS[spot].place === 'jail') continue;
    for (const p of V.slotGrid(spot, 20).points) {
      const box = [p.x - 26, p.y - 102, 52, 107];
      assert(!V.boxesOverlap(plot, box), `a ${spot} slot at ${JSON.stringify(p)} reaches into the jail's ground`);
    }
  }
  for (const s of V.GRAVE_SLOTS) assert(!V.boxesOverlap(plot, [s.x - 16, s.y - 40, 32, 44]), `a headstone at ${JSON.stringify(s)} is in the jail's ground`);
});

check('the jail yard holds a crowd behind bars, and no bar crosses a face or a badge', () => {
  const tol = V.CLASH_TOLERANCE;
  const plate = V.signBox('jail');
  // The cage in two sections: `far` is painted into the background, behind the crowd, and `bars` over it.
  const bars = [...V.jailBarBoxes(true), ...V.jailRails().slice(1)];
  const far = [...V.jailBarBoxes(), V.jailRails()[0]];
  assert(bars.length >= 10, `the near cage has bars to stand behind (${bars.length})`);
  for (const b of far) assert(b[1] + b[3] <= V.JAIL.mid + 1e-6, `a far bar ${JSON.stringify(b)} ends where the near section starts`);
  for (const b of V.jailBarBoxes(true)) eq(b[1], V.JAIL.mid, 'the near bars carry on from the far ones, so the cage reads as one');
  const gateway = V.jailGateway();
  assert(gateway[1] - gateway[0] >= 40, `the yard has a gateway to walk in through (${JSON.stringify(gateway)})`);
  for (const b of V.jailBarBoxes()) {
    const at = b[0] + b[2] / 2;
    assert(at <= gateway[0] + 1e-6 || at >= gateway[1] - 1e-6, `no bar stands in the gateway (${at})`);
  }

  eq(V.placeScaleCap('jail', []), V.TOKEN_SCALE.max, 'an empty jail caps nothing');
  eq(V.slotGrid('jail', 0).points.length, 0, 'an empty jail places nobody');
  let capacity = 0;
  for (let n = 1; n <= 24; n++) if (!V.slotGrid('jail', n).overflow) capacity = n;
  assert(capacity >= 8, `the yard holds at least 8 before the spacing tightens past its minimum (${capacity})`);

  for (const n of [1, 5, 9, 20]) {
    const slots = jailSlots(n);
    eq(slots.length, n, `${n}: everyone placed`);
    const [cap] = new Set(slots.map((s) => s.cap));
    const label = `jail ${n} at ${cap}`;
    // The scale the place allows, which is also what a 1.5x token size is drawn at.
    for (const s of slots) {
      const parts = V.avatarBoxes('jail', s.x, s.y, cap);
      const [body] = parts;
      const badge = parts[3];
      const face = [body[0], body[1], body[2], body[3] * 0.55];
      for (const b of bars) {
        assert(overlapBy(b, face) <= 0, `${label}: a bar ${JSON.stringify(b)} crosses the face at ${s.x},${s.y}`);
        assert(overlapBy(b, badge) <= 0, `${label}: a bar ${JSON.stringify(b)} crosses the badge at ${s.x},${s.y}`);
      }
      for (const part of parts) assert(overlapBy(part, plate) <= tol, `${label}: a prisoner at ${s.x},${s.y} covers the sign board`);
      // The front row stands behind the near bars: something of it is below the middle rail.
      if (s.y >= 240) assert(Math.max(...bars.map((b) => overlapBy(b, body))) > 0, `${label}: the front row at ${s.x},${s.y} is behind the near bars`);
    }
    // Bodies never touch while the yard is inside its capacity; past it the crowd spreads tighter, as the beach does.
    if (n <= capacity) {
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          const a = V.avatarBoxes('jail', slots[i].x, slots[i].y, cap)[0];
          const b = V.avatarBoxes('jail', slots[j].x, slots[j].y, cap)[0];
          assert(overlapBy(a, b) <= tol, `${label}: two bodies overlap by ${overlapBy(a, b).toFixed(1)}`);
        }
      }
    }
  }
  // A lone prisoner grows the whole way, and the count on the sign is the board's, so it counts an overflowing yard.
  eq(jailSlots(1)[0].cap, V.TOKEN_SCALE.max, 'a lone prisoner reaches the largest size');
  const texts = [];
  withFrameLoop((loop) => {
    const v = makeVillage({ texts });
    v.village.start();
    v.village.update({ counts: { jail: 37 }, sessions: jailRows(20) }, { privacy: false });
    loop.pump(0.2);
    v.village.destroy();
  });
  assert(texts.includes('The Jail'), `the sign names the place (${texts.slice(0, 12)})`);
  assert(texts.includes('37'), `the sign counts every jailed row, drawn or spread (${texts.filter((t) => /^\d+$/.test(t))})`);
});

check('rows GitHub confirms for the first time are placed, not sailed; later merges still sail', () => {
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false });
    v.village.start();
    const ids = Array.from({ length: 12 }, (_, i) => `local_99999999-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`);
    const unverified = { number: 1, state: 'OPEN', verified: false, mergedAt: null };
    v.village.update(board(ids.map((id) => row(id, 'open_pr', { pr: unverified }))), { privacy: false });
    loop.pump(1);
    const merged = { number: 1, state: 'MERGED', verified: true, mergedAt: 1 };
    const rows = ids.map((id, i) => row(id, i < 8 ? 'castle' : 'valhalla', { pr: merged }));
    v.village.update(board(rows), { privacy: false });
    const out = loop.pump(2);
    assert(out.frames <= 26, `no boat parade on GitHub's first answer (${out.frames} frames in 2 s)`);
    v.village.enterCastle();
    const seats = V.castleLayout(8).points;
    assert(v.sweep(seats[0].x, seats[0].y, 160).length > 0, 'already in the hall');
    v.village.leaveCastle();

    const w = makeVillage({ reduce: false });
    w.village.start();
    const openVerified = { number: 2, state: 'OPEN', verified: true, mergedAt: null };
    w.village.update(board([row(B, 'open_pr', { pr: openVerified })]), { privacy: false });
    loop.pump(1);
    w.village.update(board([row(B, 'valhalla', { pr: { ...openVerified, state: 'MERGED', mergedAt: 2 } })]), { privacy: false });
    const sailing = loop.pump(1);
    assert(sailing.frames >= 45, `a merge seen after GitHub answered still sails (${sailing.frames} frames in 1 s)`);
    v.village.destroy();
    w.village.destroy();
  });
});


// ---------- the porch ----------

const idsFor = (hex8, n) => Array.from({ length: n }, (_, i) => `local_${hex8}-0000-4000-8000-${String(i).padStart(12, '0')}`);
// An always-shown plate hangs below the feet, as wide as its row leaves room for, and on the Porch's front row it
// stops 4 short of the Porch sign (village.js placeParts and plateLeft).
const plateBox = (p, placed) => {
  const plated = placed.filter((q) => ['needs_you', 'errored', 'your_turn'].includes(q.lane));
  let gap = Infinity;
  for (const q of plated) if (q !== p && Math.abs(q.y - p.y) < 30) gap = Math.min(gap, Math.abs(q.x - p.x));
  const w = Math.min(260, Math.max(56, gap - 10));
  let right = V.LOGICAL_WIDTH - 4;
  const [sx, sy, , sh] = V.signBox('porch');
  if (p.place === 'porch' && p.y + 9 < sy + sh && sy < p.y + 9 + 44 && p.x <= sx) right = Math.min(right, sx - 4);
  return [Math.max(4, Math.min(p.x - w / 2, right - w)), p.y + 9, w, 44];
};

const porchRows = (needs, turns, extra = {}, errs = 0, stops = 0) => [
  ...idsFor('aaaaaaaa', needs).map((id) => row(id, 'needs_you', extra)),
  ...idsFor('bbbbbbbb', turns).map((id) => row(id, 'your_turn', extra)),
  ...idsFor('eeeeeeee', errs).map((id) => row(id, 'errored', extra)),
  ...idsFor('55555555', stops).map((id) => row(id, 'stopped', extra)),
];

check('the merged Porch seats blocked, needs input, errored and stopped rows, with nothing overlapping', () => {
  eq([V.placeForLane('needs_you'), V.placeForLane('your_turn'), V.placeForLane('errored'), V.placeForLane('stopped')],
    ['porch', 'porch', 'porch', 'porch'], 'one place');
  eq([V.spotForLane('needs_you'), V.spotForLane('your_turn'), V.spotForLane('errored'), V.spotForLane('stopped')],
    ['porch', 'swings', 'steps', 'steps'], 'three spots');
  eq(V.PLACES.porch.lanes, ['needs_you', 'your_turn', 'errored', 'stopped'], 'one sign counting all four lanes');
  assert(!('bench' in V.PLACES) && !('tent' in V.PLACES) && !('tent' in V.SPOTS)
    && !Object.values(V.LANE_PLACE).includes('tent'), 'the bench and the tent are gone');
  // Capacity: two rows under the road, so the door and the swings seat 8 each without spreading and the steps 4,
  // which is 20 for the whole Porch, over the 12 it must hold.
  const seats = {};
  for (const [spot, least] of [['porch', 8], ['swings', 8], ['steps', 4]]) {
    eq(V.slotGrid(spot, least).overflow, false, `${spot} seats ${least} without overflow`);
    assert(V.slotGrid(spot, least).points.length === least, `${spot} places all ${least}`);
    eq(V.slotGrid(spot, least + 1).overflow, true, `${spot} spreads past ${least}`);
    seats[spot] = least;
  }
  assert(seats.porch + seats.swings + seats.steps >= 12, `the merged Porch seats at least 12 (${JSON.stringify(seats)})`);
  eq(V.PORCH_ROWS.length, 2, 'two rows, both below the road');
  // Past its seats everyone is still drawn, spread, and the sign counts every row of every lane.
  {
    const texts = [];
    withFrameLoop((loop) => {
      const v = makeVillage({ texts, measure: true });
      v.village.start();
      v.village.update(board(porchRows(11, 13, { title: 'x' }, 5, 7)), { privacy: false });
      loop.pump(0.2);
      v.village.destroy();
    });
    for (const n of ['11', '13', '5', '7']) eq(texts.filter((t) => t === n).length, 1, `an overflowing Porch's sign shows ${n}`);
    eq(V.layoutVillage(porchRows(11, 13, {}, 5, 7)).size, 36, 'and all 36 are placed');
  }
  // Feet-relative extents: a waving needs_you (badge with a hat, the escalated hop, the waving hand), a swing sitter
  // (its seat, and its badge lifted by the seat) and a sitter on the steps.
  const extent = (p) => (p.lane === 'needs_you' ? [p.x - 22, p.y - 102, 55, 107]
    : p.lane === 'your_turn' ? [p.x - V.SWING_SEAT_HALF, p.y - 95, 2 * V.SWING_SEAT_HALF, 100]
      : [p.x - 25, p.y - 92, 50, 95]);
  const PLATE_MIN = 56;
  for (const [nNeeds, nTurns, nErr, nStop] of [[0, 0, 0, 0], [1, 1, 1, 0], [5, 5, 2, 1], [8, 8, 2, 2], [1, 0, 0, 1], [0, 8, 4, 0]]) {
    {
      const label = `${nNeeds} blocked + ${nTurns} needs input + ${nErr} errored + ${nStop} stopped`;
      const rows = porchRows(nNeeds, nTurns, {}, nErr, nStop);
      // Row order must not matter to where anyone sits.
      const layout = V.layoutVillage([...rows].reverse());
      eq(layout.size, rows.length, `${label}: everyone has a slot`);
      const placed = rows.map((r) => ({ id: r.id, lane: r.lane, ...layout.get(r.id) }));
      for (const p of placed) {
        eq([p.place, p.spot], ['porch', V.spotForLane(p.lane)], `${label}: place and spot`);
        assert(V.PORCH_ROWS.includes(p.y), `${label}: ${p.lane} at ${p.y} stands on a porch row`);
        const box = extent(p);
        assert(box[0] >= 0 && box[0] + box[2] <= V.LOGICAL_WIDTH && box[1] + box[3] <= V.LOGICAL_HEIGHT, `${label}: inside the canvas`);
        for (const o of V.PORCH_OBSTACLES) assert(!V.boxesOverlap(box, o), `${label}: ${p.lane} at ${p.x} covers ${JSON.stringify(o)}`);
        assert(!V.boxesOverlap(box, V.signBox('porch')), `${label}: ${p.lane} at ${p.x} covers the Porch sign`);
      }
      placed.forEach((p, i) => placed.forEach((q, k) => {
        if (k <= i) return;
        if (p.y === q.y) assert(Math.abs(p.x - q.x) >= PLATE_MIN - 1e-6, `${label}: ${p.lane} and ${q.lane} on one row ${Math.abs(p.x - q.x)} apart`);
        else assert(Math.abs(p.y - q.y) >= 132 - 1e-6, `${label}: rows ${p.y} and ${q.y} too close for plates`);
      }));
      const needs = placed.filter((p) => p.lane === 'needs_you');
      const turns = placed.filter((p) => p.lane === 'your_turn');
      const steps = placed.filter((p) => p.lane === 'errored' || p.lane === 'stopped');
      if (needs.length && turns.length) {
        const doorward = Math.min(...needs.map((p) => p.x));
        assert(turns.every((p) => p.x < doorward), `${label}: blocked rows stand nearer the door than any swing`);
      }
      if (turns.length && steps.length) {
        const swingward = Math.min(...turns.map((p) => p.x));
        assert(steps.every((p) => p.x < swingward), `${label}: the steps are past the swings, away from the door light`);
      }
      if (needs.length) {
        const first = needs.find((p) => p.index === 0);
        assert(first.y === V.PORCH_ROWS[V.PORCH_ROWS.length - 1], `${label}: the door crowd fills the front row first`);
        const sameRow = needs.filter((p) => p.y === first.y);
        assert(sameRow.every((p) => p.x <= first.x), `${label}: the first blocked row stands by the lantern`);
      }
      for (const y of V.PORCH_ROWS) {
        const sitters = turns.filter((p) => p.y === y).map((p) => p.x);
        if (!sitters.length) continue;
        const frame = V.swingFrame(sitters, y);
        for (const post of frame.posts) {
          for (const x of sitters) assert(Math.abs(post - x) >= V.SWING_SEAT_HALF + V.SWING_LEG_SPREAD, `${label}: a swing post at ${post} hits the seat at ${x}`);
          for (const p of needs.filter((q) => q.y === y)) {
            assert(Math.abs(post - p.x) >= 22 + V.SWING_LEG_SPREAD, `${label}: a swing post at ${post} hits the needs_you at ${p.x}`);
          }
        }
        assert(frame.beamY + 9 <= y - 9 - 44 && frame.beamY >= y - 132 + 36, `${label}: the beam clears the tallest sitter and the plates of the row above`);
      }
    }
  }
});

check('the orange porch light never reaches the swings or the steps, and never cuts the blocked row it lights', () => {
  for (const nNeeds of [1, 5, 12]) {
    for (const nTurns of [0, 1, 5, 11, 12]) {
      const label = `${nNeeds} needs_you + ${nTurns} your_turn`;
      const rows = porchRows(nNeeds, nTurns);
      const layout = V.layoutVillage(rows);
      const placed = rows.map((r) => ({ lane: r.lane, ...layout.get(r.id) }));
      for (const y of V.PORCH_ROWS) {
        const sitters = placed.filter((p) => p.lane === 'your_turn' && p.y === y).map((p) => p.x);
        const needs = placed.filter((p) => p.lane === 'needs_you' && p.y === y).map((p) => p.x);
        const clip = V.porchLightClipX(sitters);
        if (!sitters.length) {
          eq(clip, null, `${label}: no clip on a row without sitters`);
          continue;
        }
        const frame = V.swingFrame(sitters, y);
        for (const post of frame.posts) assert(post + V.SWING_LEG_SPREAD + 2.25 <= clip, `${label}: a leg at ${post} is right of the clip ${clip}`);
        for (const x of sitters) assert(x + V.SWING_SEAT_HALF + 2 <= clip, `${label}: the seat at ${x} reaches the clip ${clip}`);
        for (const x of needs) assert(x - 22 >= clip, `${label}: the clip ${clip} cuts the needs_you body at ${x}`);
      }
    }
  }
  const calls = [];
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false, spy: { calls } });
    v.village.start();
    v.village.update(board(porchRows(12, 12, { since: Date.now() - 20 * 60_000 })), { privacy: false });
    loop.pump(0.3);
    v.village.destroy();
  });
  const clipAt = V.porchLightClipX(V.slotGrid('swings', 12).points.filter((p) => p.y === V.PORCH_ROWS[1]).map((p) => p.x));
  const clipRects = calls.filter((c) => c[0] === 'rect' && Math.abs(c[1] - clipAt) < 1 && c[2] === 0);
  assert(calls.some((c) => c[0] === 'clip') && clipRects.length > 0, `a crowded, escalated porch clips its lights at ${clipAt} (${clipRects.length} clip rects)`);
  const quiet = [];
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false, spy: { calls: quiet } });
    v.village.start();
    v.village.update(board(porchRows(3, 0)), { privacy: false });
    loop.pump(0.3);
    v.village.destroy();
  });
  assert(!quiet.some((c) => c[0] === 'rect' && c[2] === 0 && Math.abs(c[1] - clipAt) < 1), 'no clip when nobody sits on the swings');
});

check('the porch door and the swings keep their plates, readable when the porch is quiet', () => {
  const title = 'Fix the loyalty points expiry calculation';
  // Two rows under the road put a third sitter on a row from 3 in a spot, so 5 + 5 keeps fewer characters than
  // the three rows did (4 against 6): the price of nothing on the porch reaching across the road.
  for (const [n, least] of [[1, 20], [2, 7], [5, 4], [12, 2]]) {
    const texts = [];
    withFrameLoop((loop) => {
      const v = makeVillage({ texts, measure: true });
      v.village.start();
      v.village.update(board(porchRows(n, n, { title })), { privacy: false });
      loop.pump(0.2);
      v.village.destroy();
    });
    const plates = texts.filter((t) => t.startsWith('Fi'));
    assert(plates.length >= 2 * n, `${n} + ${n}: every porch row has a plate (${plates.length})`);
    for (const t of plates) assert(Array.from(t).length >= least, `${n} + ${n}: plate "${t}" keeps at least ${least} characters`);
  }
});

check('the one Porch sign names its four lanes in full, and nothing on the porch covers it', () => {
  const box = V.signBox('porch');
  assert(box[2] >= 240 && box[3] >= 80, `the declared board is big enough for two lines of lanes (${JSON.stringify(box)})`);
  assert(box[0] >= 0 && box[1] >= 0 && box[0] + box[2] <= V.LOGICAL_WIDTH && box[1] + box[3] <= V.LOGICAL_HEIGHT,
    `the board is inside the canvas (${JSON.stringify(box)})`);
  // The crowd and its plates keep off it, at every size, on every row.
  // A lone Blocked and three of them first: the door's anchor is beside the sign, and with nobody else on its row
  // a plate is at its widest.
  for (const [nNeeds, nTurns, nErr] of [[1, 0, 0], [3, 0, 0], [1, 1, 1], [5, 5, 2], [12, 12, 6]]) {
    const rows = porchRows(nNeeds, nTurns, {}, nErr, 0);
    const layout = V.layoutVillage(rows);
    const placed = rows.map((r) => ({ lane: r.lane, ...layout.get(r.id) }));
    for (const p of placed) {
      for (const part of V.avatarBoxes(p.lane, p.x, p.y, p.cap)) {
        assert(!V.boxesOverlap(part, box), `${nNeeds}+${nTurns}+${nErr}: a ${p.lane} at ${p.x},${p.y} covers the Porch sign`);
      }
      assert(!V.boxesOverlap(plateBox(p, placed), box), `${nNeeds}+${nTurns}+${nErr}: a ${p.lane} plate covers the Porch sign`);
    }
  }
  // Drawn: the place name, every lane word in full, and a count for each.
  const texts = [];
  withFrameLoop((loop) => {
    const v = makeVillage({ texts, measure: true });
    v.village.start();
    v.village.update(board(porchRows(3, 5, {}, 2, 1)), { privacy: false });
    loop.pump(0.2);
    v.village.destroy();
  });
  for (const word of ['The Porch', 'Blocked', 'Needs input', 'Errored', 'Stopped']) {
    eq(texts.filter((s) => s === word).length, 1, `the sign says "${word}" once, in full (${JSON.stringify(texts.filter((s) => s.startsWith(word.slice(0, 4))))})`);
  }
  assert(!texts.some((s) => /^(Needs inp|Bloc|Error|Stopp|The Por)[A-Za-z ]*\u2026$/.test(s)), `no sign text is truncated (${texts.filter((s) => s.includes('\u2026'))})`);
  // Three-digit counts: the board keeps its declared width and the words give way instead of spilling over it.
  const big = [];
  withFrameLoop((loop) => {
    const v = makeVillage({ texts: big, measure: true });
    v.village.start();
    v.village.update({ sessions: porchRows(1, 1, {}, 1, 1), counts: { needs_you: 140, your_turn: 260, errored: 999, stopped: 120 } }, { privacy: false });
    loop.pump(0.2);
    v.village.destroy();
  });
  for (const n of ['140', '260', '999', '120']) eq(big.filter((s) => s === n).length, 1, `the sign shows ${n}`);
  // Every other place keeps the compact board: a badge and a count per lane, no words.
  for (const key of ['workshop', 'cottages', 'harbour', 'beach']) {
    assert(!V.PLACES[key].words, `${key} keeps the compact sign`);
  }
});

check('a Needs input plate reads Needs input, never Your turn or Unread, when selected or hovered', () => {
  eq([V.STATE.your_turn.word, V.STATE.needs_you.word], ['Needs input', 'Blocked'], 'the renamed lane words');
  eq(V.plateLabel({ label: 'Needs input' }), 'Needs input', 'the label the server sends');
  eq(V.plateLabel({ label: 'Your turn' }), 'Needs input', 'an older server label');
  eq(V.plateLabel({ label: '  UNREAD ' }), 'Needs input', 'the name the page once used, any case and spacing');
  eq([V.plateLabel({ label: 'Approve' }), V.plateLabel({ label: 7 }), V.plateLabel(null)], ['Approve', '', ''], 'other labels');
  for (const how of ['selected', 'hovered']) {
    const texts = [];
    withFrameLoop((loop) => {
      const v = makeVillage({ texts });
      v.village.start();
      const rows = [row(A, 'your_turn', { label: 'Your turn', since: Date.now() - 10 * 60_000, title: 'Tidy the loaders' }),
        row(B, 'needs_you', { label: 'Approve', since: Date.now() - 60_000, title: 'Fix the build' })];
      v.village.update(board(rows), { privacy: false });
      if (how === 'selected') v.village.setSelected(A);
      else v.aim(rows, A);
      loop.pump(0.3);
      v.village.destroy();
    });
    assert(texts.some((t) => /^Needs input \u00b7 /.test(t)), `${how}: the plate detail says Needs input (${texts.filter((t) => /Needs input|Unread|turn/i.test(t))})`);
    assert(!texts.some((t) => /your turn|unread/i.test(t)), `${how}: no plate says Your turn or Unread`);
  }
});

check('only needs_you waves under a light column; your_turn sits still on its swing', () => {
  eq([V.poseOf('needs_you').waves, V.poseOf('needs_you').lightColumn, V.poseOf('needs_you').swings], [true, true, false], 'needs_you pose');
  eq([V.poseOf('your_turn').waves, V.poseOf('your_turn').lightColumn, V.poseOf('your_turn').swings], [false, false, true], 'your_turn pose');
  for (const lane of ['running', 'idle', 'errored', 'valhalla']) assert(!V.poseOf(lane).waves && !V.poseOf(lane).lightColumn, `${lane} neither waves nor glows`);
  // Each hand is a full circle of radius 3 (rounded corners are quarter arcs): a waving hand moves between frames, a
  // sitter's hands stay where they are while the swing rocks it by a transform.
  const watch = (lane) => {
    const calls = [];
    withFrameLoop((loop) => {
      const v = makeVillage({ reduce: false, spy: { calls } });
      v.village.start();
      v.village.update(board([row(A, lane)]), { privacy: false });
      loop.pump(3);
      v.village.destroy();
    });
    // The border patrol guard at the harbour breathes on the ambient clock; only the porch's hands count here.
    const isHand = (c) => c[0] === 'arc' && c[3] === 3 && c[4] === 0 && Math.abs(c[5] - Math.PI * 2) < 1e-9 && c[1] < 1200;
    const hands = new Set(calls.filter(isHand).map((c) => `${c[1].toFixed(1)},${c[2].toFixed(1)}`));
    const columns = calls.filter((c) => c[0] === 'createLinearGradient').length;
    return { hands: hands.size, columns };
  };
  const needs = watch('needs_you');
  const turn = watch('your_turn');
  assert(needs.hands > 4, `the needs_you hand waves (${needs.hands} hand positions)`);
  assert(needs.columns > 0, 'needs_you stands in a light column');
  eq(turn.hands, 2, 'your_turn hands stay put');
  eq(turn.columns, 0, 'no light column on the swings');
});

check('a session that stops needing you strolls from the door to a swing, on the porch, and the porch goes quiet', () => {
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false });
    v.village.start();
    const before = [row(A, 'needs_you'), row(B, 'your_turn')];
    v.village.update(board(before), { privacy: false });
    loop.pump(0.5);
    const calm = loop.pump(2);
    assert(calm.frames <= 26 && calm.timers >= 18, `a waving, swinging porch stays ambient (${calm.frames} frames, ${calm.timers} sleeps in 2 s)`);
    const from = V.layoutVillage(before).get(A);
    const after = [row(A, 'your_turn'), row(B, 'your_turn')];
    const prev = new Map([...V.layoutVillage(before)].map(([id, p]) => [id, { place: p.place, spot: p.spot, index: p.index }]));
    const to = V.layoutVillage(after, prev).get(A);
    eq(V.layoutVillage(after, prev).get(B).index, V.layoutVillage(before).get(B).index, 'the sitter already there keeps its swing');
    assert(to.spot === 'swings' && to.x < from.x, 'heads for a swing');
    v.village.update(board(after), { privacy: false });
    const walking = loop.pump(0.6);
    assert(walking.frames >= 30, `full rate while strolling (${walking.frames} frames in 0.6 s)`);
    const along = (y, span) => {
      const seen = new Set();
      for (let x = to.x + 20; x < from.x - 20; x += 12) for (const id of v.sweep(x, y, span)) seen.add(id);
      return seen;
    };
    assert(along(from.y, 90).has(A) && !along(from.y - 110, 60).has(A), 'strolls along the porch row, not up to the road');
    loop.pump(2);
    v.aimPoint(to.x, to.y, A, 120);
    const quiet = loop.pump(2);
    assert(quiet.frames <= 26, `ambient once seated (${quiet.frames} frames in 2 s)`);
    v.village.destroy();
  });
});

check('sweeping the pointer across the porch never raises the frame rate', () => {
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false });
    v.village.start();
    const rows = porchRows(3, 4);
    v.village.update(board(rows), { privacy: false });
    loop.pump(0.5);
    const a = v.aim(rows, rows[0].id);
    const b = v.aim(rows, rows[4].id);
    let flip = false;
    const out = loop.pump(2, () => {
      flip = !flip;
      const p = flip ? a : b;
      v.fire('pointermove', p.x, p.y);
    });
    assert(out.frames <= 26, `hover sweeps ride the ambient frames (${out.frames} frames in 2 s)`);
    assert(new Set(v.log.hovers.map((h) => h.id)).size >= 2, 'the hover did change');
    v.village.destroy();
  });
});

// ---------- repo colours ----------

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function toLab(hex) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexRgb(hex).map(lin);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
// CIEDE2000 on Lab triples (Sharma, Wu and Dalal 2005), which weights hue and chroma the way people see them.
function ciede2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + 25 ** 7)));
  const p1 = [(1 + G) * a1, b1];
  const p2 = [(1 + G) * a2, b2];
  const Cp1 = Math.hypot(...p1);
  const Cp2 = Math.hypot(...p2);
  const hue = ([a, b]) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const h1 = hue(p1);
  const h2 = hue(p2);
  let dh = Cp1 * Cp2 === 0 ? 0 : h2 - h1;
  if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad);
  const Lb = (L1 + L2) / 2;
  const Cpb = (Cp1 + Cp2) / 2;
  let hb = h1 + h2;
  if (Cp1 * Cp2 !== 0) hb = (Math.abs(h1 - h2) > 180 ? hb + (hb < 360 ? 360 : -360) : hb) / 2;
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad)
    - 0.2 * Math.cos((4 * hb - 63) * rad);
  const Rc = 2 * Math.sqrt(Cpb ** 7 / (Cpb ** 7 + 25 ** 7));
  const Rt = -Math.sin(2 * 30 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad) * Rc;
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const Sc = 1 + 0.045 * Cpb;
  const Sh = 1 + 0.015 * Cpb * T;
  const x = (L2 - L1) / Sl;
  const y = (Cp2 - Cp1) / Sc;
  const z = dH / Sh;
  return Math.sqrt(x * x + y * y + z * z + Rt * y * z);
}
const fnv1a = (text) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
};

const RESERVED = { orange: '#fd7e14', red: '#dc3545', amber: '#ffc107', blue: '#1565c0', green: '#28a745', grey: '#c4c9ce', purple: '#6f42c1', slate: '#495057' };
const relLum = (hex) => {
  const [r, g, b] = hexRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const de00 = (a, b) => ciede2000(toLab(a), toLab(b));
// The measured palette, reported in the results so a change shows its numbers.
results.palette = {};

check('repo colours are bold, far apart, clear of every state colour, and faces and accessories read on each', () => {
  const P = V.REPO_PALETTE;
  assert(P.length >= 10, `at least 10 colours (${P.length})`);
  const HEX = /^#[0-9a-f]{6}$/;
  for (const e of P) for (const k of ['light', 'lightEdge', 'dark', 'darkEdge', 'ink']) assert(HEX.test(e[k]), `${e.name}.${k} is a hex colour`);
  eq(new Set(P.map((e) => e.name)).size, P.length, 'names are distinct');
  for (const hex of Object.values(RESERVED)) assert(Object.values(V.STATE).some((st) => st.color === hex), `${hex} is a state colour of the village`);
  for (const scheme of ['light', 'dark']) {
    // (a) every pair of palette colours, by CIEDE2000.
    let pair = { d: Infinity };
    P.forEach((a, i) => P.forEach((b, k) => {
      if (k > i && de00(a[scheme], b[scheme]) < pair.d) pair = { d: de00(a[scheme], b[scheme]), a: a.name, b: b.name };
    }));
    assert(pair.d >= 21, `${pair.a} and ${pair.b} (${scheme}) are only ${pair.d.toFixed(1)} apart`);
    // (b) every palette colour against every reserved state colour.
    let res = { d: Infinity };
    for (const e of P) for (const [name, hex] of Object.entries(RESERVED)) if (de00(e[scheme], hex) < res.d) res = { d: de00(e[scheme], hex), e: e.name, name };
    assert(res.d >= 20, `${res.e} (${scheme}) is only ${res.d.toFixed(1)} from ${res.name}`);
    // (c) the face ink the village draws on each body.
    let ink = { c: Infinity };
    for (const e of P) if (contrast(e.ink, e[scheme]) < ink.c) ink = { c: contrast(e.ink, e[scheme]), e: e.name };
    assert(ink.c >= 4.5, `face ink on ${ink.e} (${scheme}) is ${ink.c.toFixed(2)}:1`);
    // Accessories: every accent a body can be given clears 3:1 against it.
    let acc = { c: Infinity };
    for (const e of P) {
      for (let hue = 0; hue < 360; hue += 72) {
        const a = V.accentFor(e, hue);
        if (contrast(a, e[scheme]) < acc.c) acc = { c: contrast(a, e[scheme]), e: e.name, a };
      }
    }
    assert(acc.c >= 3, `accessory ${acc.a} on ${acc.e} (${scheme}) is ${acc.c.toFixed(2)}:1`);
    // Lightness is spread: some bodies are dark (cream faces), most are light.
    const darkBodies = P.filter((e) => e.ink === V.INK_LIGHT).length;
    assert(darkBodies >= 3 && darkBodies <= P.length - 3, `${darkBodies} dark bodies`);
    results.palette[scheme] = { minPair: +pair.d.toFixed(2), closestPair: [pair.a, pair.b], minReserved: +res.d.toFixed(2),
      closestReserved: [res.e, res.name], minInk: +ink.c.toFixed(2), minAccessory: +acc.c.toFixed(2) };
  }
  const none = V.NO_REPO_COLOUR;
  assert(!P.includes(none) && P.every((e) => e.light !== none.light), 'rows with no repo have their own colour');
  assert(contrast(none.ink, none.light) >= 4.5 && contrast(none.ink, none.dark) >= 4.5, 'faces read on the no-repo chalk');
  assert(P.every((e) => de00(e.light, none.light) >= 12 && de00(e.dark, none.dark) >= 12), 'the no-repo chalk is clear of every entry');
});

// The visitors' coats and the Reviews badge, checked the same way, since a visitor stands in the same village
// as every one of those bodies and must not be read as any of them or as a state.

check('visitor coats are decor, clear of every state colour and of every repo body, with faces that read', () => {
  const C = V.VISITOR_COATS;
  const HEX = /^#[0-9a-f]{6}$/;
  assert(C.length >= 4, `at least four coats (${C.length})`);
  eq(new Set(C.map((e) => e.name)).size, C.length, 'names are distinct');
  for (const e of C) for (const k of ['light', 'lightEdge', 'dark', 'darkEdge', 'ink']) assert(HEX.test(e[k]), `${e.name}.${k} is a hex colour`);
  eq(C.map((e) => e.ink === V.INK_LIGHT), C.map(() => true), 'every coat is dark enough for a cream face');
  // The colour is a hash of the login and nothing else, so nobody's colour depends on the board around them.
  eq(V.visitorColour('octocat'), V.visitorColour('octocat'), 'one login, one coat');
  assert(C.includes(V.visitorColour('')), 'and a missing login still gets one');
  const backdrops = {
    light: ['#b8caa1', '#cdb08b', '#b39070', '#a3c7cc'], // day: grass, the landing's planks, plank lines, water
    dark: ['#2d3b32', '#8b7056', '#7b624b', '#243a46'],
  };
  for (const scheme of ['light', 'dark']) {
    const edge = scheme === 'light' ? 'lightEdge' : 'darkEdge';
    let pair = { d: Infinity };
    C.forEach((a, i) => C.forEach((b, k) => {
      if (k > i && de00(a[scheme], b[scheme]) < pair.d) pair = { d: de00(a[scheme], b[scheme]), a: a.name, b: b.name };
    }));
    assert(pair.d >= 17, `${pair.a} and ${pair.b} (${scheme}) are only ${pair.d.toFixed(1)} apart`);
    let res = { d: Infinity };
    for (const e of C) for (const [name, hex] of Object.entries(RESERVED)) if (de00(e[scheme], hex) < res.d) res = { d: de00(e[scheme], hex), e: e.name, name };
    assert(res.d >= 15, `${res.e} (${scheme}) is only ${res.d.toFixed(1)} from ${res.name}`);
    // Against every body a session can wear, so a visitor is never read as one repo's crowd.
    let repo = { d: Infinity };
    for (const e of C) for (const b of [...V.REPO_PALETTE, V.NO_REPO_COLOUR]) {
      if (de00(e[scheme], b[scheme]) < repo.d) repo = { d: de00(e[scheme], b[scheme]), e: e.name, b: b.name };
    }
    assert(repo.d >= 12, `${repo.e} (${scheme}) is only ${repo.d.toFixed(1)} from the ${repo.b} body`);
    let ink = { c: Infinity };
    for (const e of C) if (contrast(e.ink, e[scheme]) < ink.c) ink = { c: contrast(e.ink, e[scheme]), e: e.name };
    assert(ink.c >= 4.5, `face ink on ${ink.e} (${scheme}) is ${ink.c.toFixed(2)}:1`);
    // The coat against what it stands on, fill alone and then fill-or-rim, which is the promise a dark body on
    // dark grass rests on: it keeps its colour at dusk and takes a pale rim there.
    let back = { d: Infinity };
    let rim = { d: Infinity };
    for (const e of C) for (const hex of backdrops[scheme]) {
      if (de00(e[scheme], hex) < back.d) back = { d: de00(e[scheme], hex), e: e.name, hex };
      const best = Math.max(de00(e[scheme], hex), de00(e[edge], hex));
      if (best < rim.d) rim = { d: best, e: e.name, hex };
    }
    assert(back.d >= 13, `${back.e} (${scheme}) is only ${back.d.toFixed(1)} from ${back.hex}, which it stands on`);
    assert(rim.d >= 20, `${rim.e} (${scheme}) fill or rim is only ${rim.d.toFixed(1)} from ${rim.hex}`);
  }
  // The Reviews badge: not a lane, so it is checked against the lanes rather than counted among them.
  const R = V.REVIEWS;
  assert(!Object.values(V.STATE).some((st) => st.color === R.color), 'the Reviews badge is no lane\'s colour');
  let badge = { d: Infinity };
  for (const [name, hex] of Object.entries(RESERVED)) if (de00(R.color, hex) < badge.d) badge = { d: de00(R.color, hex), name };
  assert(badge.d >= 15, `the Reviews badge is only ${badge.d.toFixed(1)} from ${badge.name}`);
  assert(contrast('#ffffff', R.color) >= 4.5, `its white glyph is ${contrast('#ffffff', R.color).toFixed(2)}:1`);
  const boards = { day: '#ebdec4', dusk: '#d9caab' };
  for (const [theme, hex] of Object.entries(boards)) {
    assert(de00(R.color, hex) >= 20, `the badge is only ${de00(R.color, hex).toFixed(1)} from the ${theme} name board`);
  }
  assert(Object.prototype.hasOwnProperty.call(V.GLYPHS, R.glyph), 'and its glyph is a glyph the village has');
});

check('a collision moves a repo to a clearly different colour: neighbouring palette entries are far apart', () => {
  // Reference pairs from Sharma, Wu and Dalal's CIEDE2000 test data, so the formula itself is checked.
  for (const [a, b, want] of [[[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425], [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082]]) {
    assert(Math.abs(ciede2000(a, b) - want) < 1e-3, `CIEDE2000 reference ${want}: got ${ciede2000(a, b).toFixed(4)}`);
  }
  const P = V.REPO_PALETTE;
  for (const scheme of ['light', 'dark']) {
    P.forEach((e, i) => {
      const next = P[(i + 1) % P.length];
      const d = ciede2000(toLab(e[scheme]), toLab(next[scheme]));
      assert(d >= 40, `${e.name} then ${next.name} (${scheme}) are only ${d.toFixed(1)} apart`);
    });
  }
});

check('a repo keeps its colour, and a collision moves the later repo to the next free entry', () => {
  const P = V.REPO_PALETTE;
  const N = P.length;
  const repos = ['wonderful-things-core', 'tokentown', 'plotgen'];
  const mine = V.repoColour('tokentown', repos);
  assert(P.includes(mine), 'an entry of the palette');
  eq(V.repoColour('tokentown', [...repos].reverse()), mine, 'order of the repos in view');
  eq(V.repoColour('tokentown', [...repos, 'tokentown', 'plotgen']), mine, 'duplicates');
  eq(V.repoColour('tokentown', new Set(repos)), mine, 'a Set');
  eq(V.repoColour('tokentown', []), P[fnv1a('tokentown') % N], 'alone, the entry its FNV-1a hash picks');
  eq(V.repoHash('tokentown'), fnv1a('tokentown'), 'the hash is FNV-1a');

  // Three names sharing one entry, found by search so the check does not depend on the palette size.
  const byEntry = new Map();
  let trio = null;
  for (let i = 0; i < 5000 && !trio; i++) {
    const name = `repo-${String(i).padStart(4, '0')}`;
    const k = fnv1a(name) % N;
    if (!byEntry.has(k)) byEntry.set(k, []);
    byEntry.get(k).push(name);
    if (byEntry.get(k).length === 3) trio = byEntry.get(k);
  }
  assert(trio, 'found three colliding names');
  const [first, second, third] = [...trio].sort();
  const h = fnv1a(first) % N;
  const idx = V.repoColourIndices([third, first, second]);
  eq([idx.get(first), idx.get(second), idx.get(third)], [h, (h + 1) % N, (h + 2) % N], 'earliest name keeps the entry, later ones take the next free');
  eq(V.repoColour(second, [first]), P[(h + 1) % N], 'a repo missing from the list counts as in view');
  eq(V.repoColour(first, [second, third]), P[h], 'adding later names never recolours an earlier one');
  eq(V.repoColour(second, [third]), P[h], 'without the first, the second takes the hash entry');

  const many = Array.from({ length: N }, (_, i) => `repo-many-${i}`);
  eq(new Set(V.repoColourIndices(many).values()).size, N, 'as many repos as entries: all distinct');
  const more = Array.from({ length: N + 3 }, (_, i) => `repo-more-${i}`);
  eq(V.repoColourIndices(more).size, N + 3, 'more repos than entries still all get one');
  for (const bad of [null, undefined, '', 42]) eq(V.repoColour(bad, repos), V.NO_REPO_COLOUR, `no repo: ${String(bad)}`);
  eq(V.repoColour('tokentown', null), P[fnv1a('tokentown') % N], 'no list');
  eq(V.repoColour('tokentown', 'tokentown'), P[fnv1a('tokentown') % N], 'a string is not a list');
});

check('repos seen only in the graveyard take no colour, so visible repos keep distinct ones', () => {
  const N = V.REPO_PALETTE.length;
  // Two visible names whose entries collide once a crowd of graveyard-only repos has used a whole round.
  const graves = Array.from({ length: N - 1 }, (_, i) => `grave-${String(i).padStart(2, '0')}`);
  let pair = null;
  for (let i = 0; i < 4000 && !pair; i++) {
    const late = `z-live-${i}`;
    const all = V.repoColourIndices(['a-live', late, ...graves]);
    if (all.get('a-live') === all.get(late)) pair = late;
  }
  assert(pair, 'found a repo that collides after a full round');
  const rows = [row(A, 'running', { repo: 'a-live' }), row(B, 'your_turn', { repo: pair }),
    ...graves.map((repo, i) => row(`local_eeeeeeee-0000-4000-8000-${String(i).padStart(12, '0')}`, 'graveyard', { repo }))];
  eq(V.repoNamesInView(rows).sort(), ['a-live', pair].sort(), 'only rows that wear a colour');
  const visible = V.repoColourIndices(V.repoNamesInView(rows));
  assert(visible.get('a-live') !== visible.get(pair), 'the two visible repos get different entries');
  const fills = [];
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false, spy: { fills } });
    v.village.start();
    v.village.update(board(rows), { privacy: false });
    loop.pump(0.3);
    v.village.destroy();
  });
  const inView = ['a-live', pair];
  assert(fills.includes(V.repoColour('a-live', inView).light) && fills.includes(V.repoColour(pair, inView).light),
    'the village paints both with the colours the legend would show');
  if (app) {
    const legend = app.repoLegendModel(rows, V.repoColour);
    eq(legend.entries.map((e) => e.repo).sort(), inView.sort(), 'the legend lists only the visible repos');
    const byRepo = new Map(legend.entries.map((e) => [e.repo, e.colour]));
    assert(byRepo.get('a-live') !== byRepo.get(pair), 'and gives them different swatches');
    eq(byRepo.get(pair), V.repoColour(pair, inView).light, 'the swatch matches the character');
  }
});

check('characters wear their repo colour in the village and the hall; identity stays shape and accessory', () => {
  const N = V.REPO_PALETTE.length;
  const names = [];
  for (let i = 0; names.length < 2; i++) {
    const name = `team-${i}`;
    if (!names.length || fnv1a(name) % N === fnv1a(names[0]) % N) names.push(name);
  }
  const [a, b] = names;
  const all = [a, b, 'zz-hall'];
  const fills = [];
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false, spy: { fills } });
    v.village.start();
    const rows = [row(A, 'running', { repo: a }), row(B, 'your_turn', { repo: b }), row(C, 'castle', { repo: 'zz-hall' }),
      row('local_dddddddd-0000-4000-8000-000000000004', 'errored', {})];
    v.village.update(board(rows), { privacy: false });
    loop.pump(0.3);
    const ca = V.repoColour(a, all);
    const cb = V.repoColour(b, all);
    assert(ca !== cb, 'colliding repos get different entries');
    assert(fills.includes(ca.light) && fills.includes(cb.light), 'both bodies are painted in their repo colour');
    assert(fills.includes(V.NO_REPO_COLOUR.light), 'a row with no repo gets the no-repo colour');
    assert(!fills.includes(V.repoColour('zz-hall', all).light) || V.repoColour('zz-hall', all) === ca || V.repoColour('zz-hall', all) === cb,
      'hall guests are not drawn in the village');
    fills.length = 0;
    v.village.enterCastle();
    loop.pump(0.3);
    assert(fills.includes(V.repoColour('zz-hall', all).light), 'the hall guest wears its repo colour');
    v.village.destroy();
  });
  eq(V.lookFeatures(7), V.lookFeatures(7), 'looks are still deterministic');
  assert(!('hue' in V.REPO_PALETTE[0]), 'palette entries are colours only');
});

// ---------- size by output tokens ----------

const tok = (output, sub = 0) => ({ output, input: 0, cacheRead: 0, cacheWrite: 0, context: null, subagents: { output: sub, input: 0, cacheRead: 0, cacheWrite: 0 }, complete: true });
const MAX_TOKENS = tok(4e7, 2e7);

check('size follows output tokens including subagents, on a log scale, monotonic and clamped', () => {
  const S = V.TOKEN_SCALE;
  eq([S.min, S.max, S.floor, S.ceil], [0.85, 1.5, 1e3, 3e7], 'the agreed range');
  for (const r of [null, undefined, 7, 'x', {}, { tokens: null }, { tokens: 'lots' }]) eq(V.tokenScale(r), 1, `no token block: ${JSON.stringify(r)}`);
  eq(V.outputTokens({ tokens: null }), null, 'no count without a block');
  eq(V.tokenScale({ tokens: {} }), S.min, 'a block with nothing counted yet is the smallest');
  eq([V.tokenScale({ tokens: tok(0) }), V.tokenScale({ tokens: tok(1000) })], [S.min, S.min], '1k or fewer');
  eq([V.tokenScale({ tokens: tok(3e7) }), V.tokenScale({ tokens: tok(9e9) })], [S.max, S.max], '30M or more');
  eq(V.outputTokens({ tokens: tok(5e5, 7e5) }), 1.2e6, 'subagent output counts');
  eq(V.tokenScale({ tokens: tok(5e5, 5e5) }), V.tokenScale({ tokens: tok(1e6) }), 'main and subagent output add up');
  for (const bad of [NaN, Infinity, -5, '900000', null]) eq(V.tokenScale({ tokens: { output: bad, subagents: { output: bad } } }), S.min, `hostile count ${String(bad)}`);
  const mid = V.tokenScale({ tokens: tok(1e5) });
  near(mid, S.min + (S.max - S.min) * (2 / (Math.log10(S.ceil) - 3)), 1e-3, '100k sits where the log scale puts it');
  let last = 0;
  for (let e = 0; e <= 10; e += 0.05) {
    const k = V.tokenScale({ tokens: tok(10 ** e) });
    assert(k >= S.min && k <= S.max, `${(10 ** e).toFixed(0)} tokens: ${k} inside the range`);
    assert(k >= last, `grows with tokens (${k} after ${last} at 1e${e.toFixed(2)})`);
    if (e > 3.05 && e < Math.log10(S.ceil) - 0.05) assert(k > last, `strictly between the ends at 1e${e.toFixed(2)}`);
    last = k;
  }
});

// Where a check expects characters of each place.
// The lanes that stand in each place's slot grids. The Cottages and the sand castle are rooms, so their rows are
// inside and take no slot.
const PLACE_LANES = { porch: ['needs_you', 'your_turn', 'errored', 'stopped'], workshop: ['running'], harbour: ['open_pr'], beach: ['valhalla'], jail: ['jail'] };
const crowd = (place, n, extra = {}) => Array.from({ length: n }, (_, i) => row(`local_${place.slice(0, 1).repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`, PLACE_LANES[place][i % PLACE_LANES[place].length], extra));
// Landmarks a crowd must never cover, set out here rather than taken from the village: sign boards, the porch lantern
// and house, the lighthouse, the moored boat, the border patrol, the castle, palms, tiki bar, jetty and the beach sign.
const LANDMARKS = [
  ...Object.keys(V.PLACES).map((place) => V.signBox(place)),
  ...V.PORCH_OBSTACLES, [1494, 52, 106, 136], [V.BOAT_BERTH.x - 44, V.BOAT_BERTH.y - 6, 88, 28],
  V.BARRIER_BOX, V.GUARD_BOX, V.BOOTH_BOX, V.PATROL_PLATFORM, ...V.BEACH_OBSTACLES, V.CASTLE.rect, V.COTTAGE.rect,
];

check('crowded places cap the growth: at the largest size nothing overlaps in any place at 0, 1, 5, 13 or 20 rows', () => {
  const tol = V.CLASH_TOLERANCE;
  assert(tol <= 3, `a touch of at most 3 px (${tol})`);
  const grown = new Set();
  for (const place of Object.keys(PLACE_LANES)) {
    for (const n of [0, 1, 5, 13, 20]) {
      const rows = crowd(place, n, { tokens: MAX_TOKENS });
      const layout = V.layoutVillage(rows);
      eq(layout.size, n, `${place} ${n}: everyone placed`);
      if (!n) {
        eq(V.placeScaleCap(place, []), V.TOKEN_SCALE.max, `${place}: an empty place caps nothing`);
        continue;
      }
      const slots = [...layout.values()];
      const caps = new Set(slots.map((s) => s.cap));
      eq(caps.size, 1, `${place} ${n}: one cap for the whole place`);
      const [cap] = caps;
      assert(cap >= 1 && cap <= V.TOKEN_SCALE.max, `${place} ${n}: cap ${cap} in range`);
      const label = `${place} ${n} at ${cap}`;
      if (cap > 1) {
        grown.add(`${place}:${n}`);
        for (let k = 1; k <= cap + 1e-9; k += 0.01) {
          const clashes = V.placeClashes(place, slots, k);
          assert(!clashes.length, `${label}: clash at ${k.toFixed(2)} ${JSON.stringify(clashes.slice(0, 3))}`);
        }
        // Checked again against landmarks listed here, part by part, and the canvas edge.
        for (const s of slots) {
          for (const part of V.avatarBoxes(s.lane, s.x, s.y, cap)) {
            assert(part[0] >= -tol && part[0] + part[2] <= V.LOGICAL_WIDTH + tol && part[1] >= -tol && part[1] + part[3] <= V.LOGICAL_HEIGHT + tol, `${label}: ${s.lane} inside the canvas`);
            for (const o of LANDMARKS) {
              const before = Math.max(0, ...V.avatarBoxes(s.lane, s.x, s.y, 1).map((p) => overlapBy(p, o)));
              assert(overlapBy(part, o) <= Math.max(tol, before), `${label}: ${s.lane} at ${s.x},${s.y} covers ${JSON.stringify(o)} by ${overlapBy(part, o).toFixed(1)}`);
            }
          }
        }
      } else {
        const touching = V.placeClashes(place, slots, 1).length > 0 || V.placeClashes(place, slots, 1.01).length > 0;
        assert(touching, `${label}: held at 1 although nothing would overlap`);
      }
    }
  }
  for (const place of ['harbour', 'workshop', 'beach', 'porch']) assert(grown.has(`${place}:1`), `a lone character in the ${place} grows (${[...grown]})`);
  assert(grown.has('porch:5') && grown.has('workshop:5') && grown.has('porch:13'), `a small crowd still grows (${[...grown]})`);

  // Every place at once: growing never makes two places touch that did not at the plain size.
  for (const n of [1, 5, 13, 20]) {
    const rows = Object.keys(PLACE_LANES).flatMap((place) => crowd(place, n, { tokens: MAX_TOKENS }));
    const slots = [...V.layoutVillage(rows).values()];
    for (const a of slots) {
      for (const b of slots) {
        if (a.place >= b.place) continue;
        const at = (s, k) => V.avatarBoxes(s.lane, s.x, s.y, k);
        const worst = (k1, k2) => Math.max(0, ...at(a, k1).flatMap((p) => at(b, k2).map((q) => overlapBy(p, q))));
        assert(worst(a.cap, b.cap) <= Math.max(V.CLASH_TOLERANCE, worst(1, 1)), `${n}: the ${a.place} and the ${b.place} overlap once grown`);
      }
    }
  }
  // The porch light is still clipped clear of the swings without cutting a grown needs_you.
  for (const [needs, turns] of [[1, 0], [3, 2], [5, 5]]) {
    const rows = [...idsFor('aaaaaaaa', needs).map((id) => row(id, 'needs_you', { tokens: MAX_TOKENS })), ...idsFor('bbbbbbbb', turns).map((id) => row(id, 'your_turn', { tokens: MAX_TOKENS }))];
    const placed = [...V.layoutVillage(rows).values()];
    for (const y of V.PORCH_ROWS) {
      const clip = V.porchLightClipX(placed.filter((p) => p.lane === 'your_turn' && p.y === y).map((p) => p.x));
      if (clip === null) continue;
      for (const p of placed.filter((q) => q.lane === 'needs_you' && q.y === y)) assert(p.x - 22 * p.cap >= clip, `${needs} + ${turns}: the clip cuts a grown needs_you`);
    }
  }
});

check('a crowded place shrinks everyone into its cap, so bigger still means more tokens there', () => {
  const spread = [tok(1e3), tok(1e4), tok(1e5), tok(1e6), tok(1e7), tok(3e7), null, tok(3e5)];
  for (const place of ['harbour', 'workshop', 'porch']) {
    withFrameLoop((loop) => {
      const shapes = [];
      const { village } = geometryVillage(shapes);
      const repos = spread.map((_, i) => `repo-${i}`);
      const rows = crowd(place, spread.length).map((r, i) => ({ ...r, lane: PLACE_LANES[place][0], repo: repos[i], tokens: spread[i] }));
      const colourIds = new Map(rows.map((r, i) => [V.repoColour(repos[i], repos).light, r.id]));
      const layout = V.layoutVillage(rows);
      const cap = layout.get(rows[0].id).cap;
      assert(cap < 1.2, `${place}: 8 rows are capped (${cap})`);
      village.update(board(rows), { privacy: false });
      loop.pump(0.3);
      shapes.length = 0;
      loop.pump(0.1);
      // Look 7 is a square body 34 tall, so its drawn height gives its scale.
      const bodies = bodiesByColour(shapes, colourIds);
      const drawn = rows.map((r) => (bodies.get(r.id)[3] - bodies.get(r.id)[1]) / 34);
      rows.forEach((r, i) => near(drawn[i], (V.tokenScale(r) * cap) / V.TOKEN_SCALE.max, 1e-3, `${place}: ${JSON.stringify(spread[i] && spread[i].output)} tokens drawn at its share of the cap`));
      near(Math.max(...drawn), cap, 1e-3, `${place}: the most tokens reach the cap`);
      for (let i = 1; i < 6; i++) assert(drawn[i] > drawn[i - 1] + 0.03, `${place}: ${spread[i].output} tokens draw bigger than ${spread[i - 1].output} (${drawn[i].toFixed(3)} vs ${drawn[i - 1].toFixed(3)})`);
      assert(drawn[4] - drawn[2] >= 0.15 * cap, `${place}: 10M reads clearly bigger than 100k (${drawn[4].toFixed(2)} vs ${drawn[2].toFixed(2)})`);
      near(drawn[6], cap / V.TOKEN_SCALE.max, 1e-3, `${place}: no token count yet is drawn as the plain size's share`);
      village.destroy();
    });
  }

  // Mixed sizes stay inside what the place was capped for: never more than 1 px past the overlap at a uniform cap.
  const rand = seeded(4242);
  for (const place of Object.keys(PLACE_LANES)) {
    for (let n = 1; n <= 20; n += 1) {
      for (let trial = 0; trial < 6; trial++) {
        const rows = crowd(place, n).map((r) => ({ ...r, tokens: rand() < 0.1 ? null : tok(10 ** (2 + rand() * 6)) }));
        const slots = rows.map((r) => ({ ...V.layoutVillage(rows).get(r.id), size: V.tokenScale(r) }));
        const parts = (s, k) => V.avatarBoxes(s.lane, s.x, s.y, k);
        for (let i = 0; i < slots.length; i++) {
          const a = slots[i];
          const ka = (a.size * a.cap) / V.TOKEN_SCALE.max;
          assert(ka <= a.cap + 1e-9, `${place} ${n}: drawn within the cap`);
          for (const o of LANDMARKS) {
            const worst = (k) => Math.max(0, ...parts(a, k).map((p) => overlapBy(p, o)));
            assert(worst(ka) <= Math.max(worst(a.cap), V.CLASH_TOLERANCE) + 1, `${place} ${n}: a mixed-size character covers ${JSON.stringify(o)}`);
          }
          for (let j = i + 1; j < slots.length; j++) {
            const b = slots[j];
            const kb = (b.size * b.cap) / V.TOKEN_SCALE.max;
            const worst = (k1, k2) => Math.max(0, ...parts(a, k1).flatMap((p) => parts(b, k2).map((q) => overlapBy(p, q))));
            const mixed = worst(ka, kb);
            assert(mixed <= Math.max(worst(a.cap, b.cap), V.CLASH_TOLERANCE) + 1, `${place} ${n}: mixed sizes overlap by ${mixed.toFixed(1)}`);
          }
        }
      }
    }
  }
});

// Records ctx.scale calls, and where the barrier is rotated to.
function scaleSpy(log) {
  let at = null;
  return new Proxy(function () {}, {
    get: (_t, key) => {
      if (key === 'scale') return (sx, sy) => { log.scales.push([sx, sy]); return stub; };
      if (key === 'translate') return (x, y) => { at = { x, y }; return stub; };
      if (key === 'rotate') {
        return (a) => {
          if (at && Math.abs(at.x - V.BARRIER.pivotX) < 1e-9 && Math.abs(at.y - (V.BARRIER.y - 2)) < 1e-9) log.barrier.push(a);
          return stub;
        };
      }
      return key === Symbol.toPrimitive ? () => 0 : key === 'width' ? 10 : stub;
    },
    set: () => true,
    apply: () => stub,
  });
}

check('characters draw, hit-test and report hover points at their token size', () => {
  // Look 7: a square body 34 tall with a hat, standing on its legs, so its badge centre is (6 + 34 + 28) above its feet.
  const hoverFor = (lane, tokens) => {
    const v = makeVillage();
    const rows = [row(A, lane, { tokens })];
    v.village.update(board(rows), { privacy: false });
    const at = v.aim(rows, A);
    return { v, at, point: v.log.hovers.at(-1).point, slot: V.layoutVillage(rows).get(A) };
  };
  const big = hoverFor('open_pr', MAX_TOKENS);
  const plain = hoverFor('open_pr', null);
  const small = hoverFor('open_pr', tok(10));
  const k = big.slot.cap;
  eq(k, V.TOKEN_SCALE.max, 'a lone open PR grows to the largest size');
  near(big.point.y, big.slot.y - 68 * k - 14 * k, 1e-6, 'the hover point sits on top of the grown badge');
  near(plain.point.y, plain.slot.y - 68 - 14, 1e-6, 'a row without tokens keeps the plain size');
  near(small.point.y, small.slot.y - 68 * 0.85 - 14 * 0.85, 1e-6, 'a row with few tokens is smaller');
  // A point on the grown badge, well above where the plain badge would be, hits only the grown character.
  const high = { x: big.slot.x, y: big.slot.y - 68 * k };
  big.v.fire('pointerleave', 0, 0);
  big.v.fire('pointermove', high.x, high.y);
  eq(big.v.hoveredId(), A, 'the grown badge is hit where it is drawn');
  plain.v.fire('pointerleave', 0, 0);
  plain.v.fire('pointermove', high.x, high.y);
  eq(plain.v.hoveredId(), null, 'nothing there at the plain size');
  big.v.click(high.x, high.y);
  eq(big.v.log.opened, [A], 'and a click there opens it');

  // Drawn through one scale about the feet: the grown one at its size, the plain one without any.
  const drawn = (tokens) => {
    const log = { scales: [], barrier: [] };
    withFrameLoop((loop) => {
      reduceMotion = true;
      const listeners = new Map();
      const canvas = {
        width: 0, height: 0, style: {}, getContext: () => scaleSpy(log),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }),
        addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener() {},
      };
      const village = V.createVillage(canvas, {});
      village.resize();
      village.start();
      village.update(board([row(A, 'open_pr', { tokens })]), { privacy: false });
      loop.pump(0.3);
      village.destroy();
    });
    return log.scales;
  };
  assert(drawn(MAX_TOKENS).some(([sx, sy]) => sx === k && sy === k), 'the grown character is drawn scaled');
  assert(!drawn(null).some(([sx, sy]) => sx === sy && sx > 1), 'a plain one is not');

  // In a crowd that already touches, everyone stays plain whatever their tokens.
  const rows = crowd('harbour', 13, { tokens: MAX_TOKENS });
  eq(V.layoutVillage(rows).get(rows[0].id).cap, 1, 'a crowded harbour holds everyone at 1');
  const v = makeVillage();
  v.village.update(board(rows), { privacy: false });
  const slot = V.layoutVillage(rows).get(rows[0].id);
  const at = v.aim(rows, rows[0].id);
  near(v.log.hovers.at(-1).point.y, slot.y - 82, 1e-6, 'capped hover point');
  assert(at, 'still hoverable');

  // Headstones carry no size.
  const stone = (tokens) => {
    const w = makeVillage();
    w.village.update(board([row(A, 'graveyard', { tokens })]), { privacy: false });
    w.aimPoint(V.GRAVE_SLOTS[0].x, V.GRAVE_SLOTS[0].y, A, 40);
    return w.log.hovers.at(-1).point;
  };
  eq(stone(MAX_TOKENS), stone(null), 'a headstone is the same with or without tokens');

  // The largest passenger still fits inside its boat's gunwale (54 either side of the hull's centre, at BOAT_SCALE).
  assert(25 * V.TOKEN_SCALE.max <= 54 * V.BOAT_SCALE, `a grown passenger, arms and all, fits the boat (${25 * V.TOKEN_SCALE.max} of ${54 * V.BOAT_SCALE})`);
});

check('a change of size eases in at full rate and then drops back to ambient; reduced motion jumps straight to it', () => {
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false });
    v.village.start();
    const small = [row(A, 'running', { tokens: tok(10) })];
    v.village.update(board(small), { privacy: false });
    loop.pump(0.5);
    v.aim(small, A);
    const slot = V.layoutVillage(small).get(A);
    near(v.log.hovers.at(-1).point.y, slot.y - 82 * V.TOKEN_SCALE.min, 1e-6, 'starts small');
    const big = [row(A, 'running', { tokens: MAX_TOKENS })];
    v.village.update(board(big), { privacy: false });
    const easing = loop.pump(V.RESIZE_S);
    assert(easing.frames >= V.RESIZE_S * 45, `full rate while it grows (${easing.frames} frames)`);
    loop.pump(0.3);
    near(v.log.hovers.at(-1).point.y, slot.y - 82 * slot.cap, 2.5, 'the hover point follows it up');
    const after = loop.pump(2);
    assert(after.frames <= 26, `ambient once grown (${after.frames} frames in 2 s)`);
    v.village.destroy();
  });
  const w = makeVillage();
  const small = [row(A, 'running', { tokens: tok(10) })];
  w.village.update(board(small), { privacy: false });
  w.village.update(board([row(A, 'running', { tokens: MAX_TOKENS })]), { privacy: false });
  w.aim(small, A);
  near(w.log.hovers.at(-1).point.y, V.layoutVillage(small).get(A).y - 82 * V.TOKEN_SCALE.max, 1e-6, 'reduced motion: at its new size at once');
});

check('hall guests multiply the crowd scale by their token size, and still keep their distance', () => {
  eq(V.castleLayout(9), V.castleLayout(9, null), 'no sizes: as before');
  eq(V.castleLayout(9, Array(9).fill(1)).scale, V.castleLayout(9).scale, 'plain sizes change nothing');
  const big = V.castleLayout(60, Array(60).fill(1.5)).scale;
  near(big, V.castleLayout(60).scale / 1.5, 1e-9, 'big guests take proportionally more floor, so the crowd scale shrinks');
  eq(V.castleLayout(9, [1, 2]).scale, V.castleLayout(9).scale, 'a size list of the wrong length is ignored');

  // Reduced motion keeps guests on their spread spots; the grown guest's hover point follows crowd scale times size.
  const v = makeVillage();
  const ids = [0, 1, 2].map((i) => `local_12121212-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const rows = ids.map((id, i) => row(id, 'castle', { tokens: i === 1 ? MAX_TOKENS : null }));
  v.village.update(board(rows), { privacy: false });
  v.village.enterCastle();
  const layout = V.castleLayout(3, rows.map((r) => V.tokenScale(r)));
  const p = layout.points[1];
  v.aimPoint(p.x, p.y, ids[1], 260);
  const drawnK = layout.scale * V.TOKEN_SCALE.max;
  const r = Math.max(8, 14 * Math.min(1, layout.scale) * V.TOKEN_SCALE.max);
  near(v.log.hovers.at(-1).point.y, p.y - 68 * drawnK - r, 1e-6, 'badge top of the grown guest');
  const q = layout.points[0];
  v.aimPoint(q.x, q.y, ids[0], 200);
  near(v.log.hovers.at(-1).point.y, q.y - 68 * layout.scale - Math.max(8, 14 * Math.min(1, layout.scale)), 1e-6, 'badge top of a plain guest');

  for (const n of [5, 40]) {
    const sizes = Array.from({ length: n }, (_, i) => [0.85, 1, 1.5][i % 3]);
    const lay = V.castleLayout(n, sizes);
    const guests = lay.points.map((pt, i) => ({ px: pt.x, py: pt.y, size: sizes[i], rng: seeded(900 + i) }));
    let worst = Infinity;
    for (let f = 0; f < 24 * 30; f++) {
      V.wanderStep(guests, 1 / 24, lay.scale);
      if (f >= 24 * 6) for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) worst = Math.min(worst, V.hallSpacing(guests[i], guests[j], lay.scale));
    }
    assert(worst >= 0.8, `${n} mixed sizes: closest pair ${worst.toFixed(2)} of its personal space`);
  }
  near(V.hallSpacing({ px: 0, py: 0, size: 1.5 }, { px: 63, py: 0, size: 1.5 }, 1), 1, 1e-9, 'two big guests need more room');
  // In depth the guest in front sets the room, since its body rises over the one behind by its own size.
  const small = { px: 0, py: 0, size: 0.85 };
  const bigInFront = { px: 0, py: V.HALL.sepY * 1.5, size: 1.5 };
  near(V.hallSpacing(small, bigInFront, 1), 1, 1e-9, 'a small guest just behind a big one is touching it');
  near(V.hallSpacing(bigInFront, small, 1), 1, 1e-9, 'whichever way round');
  near(V.hallSpacing({ px: V.HALL.sepX * 1.175, py: 0, size: 0.85 }, { px: 0, py: 0, size: 1.5 }, 1), 1, 1e-9, 'across, the pair shares the room');

  // On screen: a big guest never hides much more of a small one than plain guests hide of each other.
  const body = (g, k) => [g.px - 18 * k * g.size, g.py - 50 * k * g.size, g.px + 18 * k * g.size, g.py];
  const hidden = (a, b) => {
    const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    const oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
    return ox > 0 && oy > 0 ? (ox * oy) / Math.min(area(a), area(b)) : 0;
  };
  const worstHidden = (sizes) => {
    const lay = V.castleLayout(sizes.length, sizes);
    const guests = lay.points.map((pt, i) => ({ px: pt.x, py: pt.y, size: sizes[i], rng: seeded(700 + i) }));
    let worst = 0;
    for (let f = 0; f < 24 * 24; f++) {
      V.wanderStep(guests, 1 / 24, lay.scale);
      if (f < 24 * 6 || f % 2) continue;
      for (let i = 0; i < guests.length; i++) for (let j = i + 1; j < guests.length; j++) worst = Math.max(worst, hidden(body(guests[i], lay.scale), body(guests[j], lay.scale)));
    }
    return worst;
  };
  const plainWorst = worstHidden(Array(60).fill(1));
  const mixedWorst = worstHidden(Array.from({ length: 60 }, (_, i) => (i % 2 ? 1.5 : 0.85)));
  assert(mixedWorst <= Math.max(0.4, plainWorst * 2), `big and small guests: at most ${(mixedWorst * 100).toFixed(0)}% of a body hidden (plain guests ${(plainWorst * 100).toFixed(0)}%)`);
});

// ---------- the border patrol ----------

// ----- theme packs -----

check('the horse keeps to the roads all the way round, and holds still when asked', () => {
  // Every node of the circuit is a road junction the village already has, so the horse cannot be trotting a line
  // nobody paints.
  for (const node of V.HORSE_CIRCUIT) {
    assert(V.ROAD_NODES.some(([x, y]) => x === node.x && y === node.y),
      `the circuit turns at ${JSON.stringify(node)}, which is a road junction`);
  }
  assert(V.HORSE_REACH * 2 < V.ROAD_BAND, `the horse (${V.HORSE_REACH * 2} wide) fits the road band (${V.ROAD_BAND})`);

  // Two things, measured apart. Where the horse stands is on a road's centreline; how wide it paints is measured
  // across the leg it is running, which is the direction the band is only 38 px wide in. Measuring its width along
  // the leg instead would fail at every corner for a horse of any size at all, since two bands meeting at a right
  // angle leave the outer corner uncovered.
  const half = V.ROAD_BAND / 2;
  const onRoad = (x, y) => V.ROAD_LINES.some(([[x0, y0], [x1, y1]]) => {
    const vx = x1 - x0;
    const vy = y1 - y0;
    const k = Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / (vx * vx + vy * vy)));
    return Math.hypot(x - (x0 + vx * k), y - (y0 + vy * k)) <= half;
  });
  const loop = V.HORSE_CIRCUIT.reduce((sum, a, i) => {
    const b = V.HORSE_CIRCUIT[(i + 1) % V.HORSE_CIRCUIT.length];
    return sum + Math.hypot(b.x - a.x, b.y - a.y);
  }, 0);
  const period = loop / V.HORSE_SPEED;
  let seen = 0;
  for (let t = 0; t <= period * 2; t += period / 900) {
    const h = V.horseAt(t);
    assert(Math.abs(h.dir) === 1, `the horse faces one way or the other at t ${t.toFixed(2)}`);
    assert(onRoad(h.x, h.y), `the horse stands off the road at t ${t.toFixed(2)}: ${h.x.toFixed(1)},${h.y.toFixed(1)}`);
    for (const d of [-V.HORSE_REACH, V.HORSE_REACH]) {
      const p2 = h.axis === 'x' ? { x: h.x, y: h.y + d } : { x: h.x + d, y: h.y };
      assert(onRoad(p2.x, p2.y),
        `the horse paints off the road at t ${t.toFixed(2)}: ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`);
    }
    seen += 1;
  }
  assert(seen > 1000, 'the whole circuit was walked');

  // It goes somewhere over a lap, and nowhere at all under reduced motion.
  const places = new Set();
  for (let t = 0; t <= period; t += period / 40) places.add(`${V.horseAt(t).x.toFixed(0)},${V.horseAt(t).y.toFixed(0)}`);
  assert(places.size > 30, `the horse gets round the circuit (${places.size} places)`);
  const still = new Set();
  for (let t = 0; t <= period; t += period / 40) still.add(`${V.horseAt(t, true).x},${V.horseAt(t, true).y}`);
  eq(still.size, 1, 'reduced motion holds it at one place');
});

check('the frontier line runs straight from the berth to the jetty, over water all the way, and every other pack keeps the voyage', () => {
  const xy = (p) => ({ x: p.x, y: p.y });
  eq(V.sailLane(), V.SAIL_WAYPOINTS, 'the default is the voyage');
  eq(V.sailLane('village'), V.SAIL_WAYPOINTS, 'and so is the green village');
  eq(V.sailLane('nope'), V.SAIL_WAYPOINTS, 'and so is a pack nobody has heard of');
  const straight = V.sailLane('west');
  assert(straight !== V.SAIL_WAYPOINTS, 'the frontier runs its own line');

  const routeOf = (lane) => [xy(V.BOAT_BERTH), ...lane.map(xy), xy(V.JETTY_BERTH)];
  const voyage = V.routeLength(routeOf(V.SAIL_WAYPOINTS));
  const run = V.routeLength(routeOf(straight));
  assert(run < voyage * 0.4 && run > voyage * 0.25,
    `the frontier run is about a third of the voyage (${run.toFixed(0)} against ${voyage.toFixed(0)})`);

  // Same rules the voyage is held to: open water all along it, a hull clear of the coast, and never over the sand.
  for (const lane of [routeOf(straight), [...routeOf(straight)].reverse()]) {
    for (let i = 1; i < lane.length; i += 1) {
      for (let k = 0; k <= 200; k += 1) {
        const q = {
          x: lane[i - 1].x + (lane[i].x - lane[i - 1].x) * (k / 200),
          y: lane[i - 1].y + (lane[i].y - lane[i - 1].y) * (k / 200),
        };
        assert(q.x > V.shoreX(q.y) && !V.onIsland(q.x, q.y), `the frontier line stays on the water at ${JSON.stringify(q)}`);
        const box = V.hullBox(q.x, q.y);
        for (let y = box[1]; y <= box[1] + box[3] + 1e-9; y += 1) {
          assert(box[0] > V.shoreX(y), `a locomotive at ${JSON.stringify(q)} crosses the waterline at y ${y.toFixed(0)}`);
        }
        for (const cx of [box[0], box[0] + box[2] / 2, box[0] + box[2]]) {
          for (const cy of [box[1], box[1] + box[3] / 2, box[1] + box[3]]) {
            assert(!V.onIsland(cx, cy, 6), `a locomotive at ${JSON.stringify(q)} covers the island`);
          }
        }
      }
    }
  }

  // The outward run, the engine that comes back for the next passenger and the one that goes to fetch one all take
  // the line the pack is given, not the default.
  const from = { x: 700, y: 700, area: 'land' };
  const to = { x: V.ISLAND.cx, y: V.ISLAND.cy, area: 'island' };
  const legs = V.planJourney(from, to, { lane: straight });
  const sail = legs.find((l) => l.kind === 'sail');
  assert(sail, 'the journey still crosses');
  eq(sail.pts.length, 2, 'the crossing is one straight leg');
  const journey = V.scheduleJourney(legs, 0);
  const trips = V.scheduleFerries(journey, 0, straight);
  assert(trips.length > 0, 'an engine comes back for the next passenger');
  for (const trip of trips) eq(trip.pts.length, 2, `the ${trip.kind} run takes the same straight line`);
  // And the voyage is untouched: its crossing still goes the long way round.
  const long = V.planJourney(from, to).find((l) => l.kind === 'sail');
  eq(long.pts.length, V.SAIL_WAYPOINTS.length + 2, 'the green village still sails the whole voyage');
});

check('the locomotive stands on the boat\'s own footing: inside the hull it replaces and under BOAT_TOP', () => {
  const L = V.LOCO;
  assert(L.back >= V.HULL.l, `the tender's back sheet (${L.back}) is inside the hull's stern (${V.HULL.l})`);
  assert(L.nose <= V.HULL.r, `the cowcatcher (${L.nose}) is inside the hull's bow (${V.HULL.r})`);
  assert(L.wheels <= V.HULL.b, `the wheels (${L.wheels}) stand on the hull's own waterline (${V.HULL.b})`);
  // The chimney and its plume rise where a boat's mast and flag do, and no higher: every box the boat declares,
  // and the lighthouse beam's reckoning of what it falls on, is built from BOAT_TOP.
  assert(L.plume >= V.BOAT_TOP, `the plume (${L.plume}) stays under BOAT_TOP (${V.BOAT_TOP})`);
  assert(L.cap > L.plume, 'the chimney cap is below the top of its own plume');
  assert(L.cap < V.HULL.t, 'and above the hull it stands on');
});

check('a fight breaks out in the mine inside one cycle, takes in whoever is nearest, and stops dead under reduced motion', () => {
  // Timing first, as a pure function: somewhere in every cycle there is a fight, they alternate, and reduced
  // motion has none at all rather than a frozen punch.
  const kinds = new Set();
  let fights = 0;
  for (let t = 0; t < V.WEST_FIGHT_PERIOD; t += 0.05) {
    const f = V.fightAt(t);
    if (!f) continue;
    fights += 1;
    kinds.add(f.kind);
    assert(f.k >= 0 && f.k <= 1, `a fight at ${t.toFixed(2)} is somewhere in its own run (${f.k})`);
  }
  assert(fights > 0, 'a fight breaks out inside one cycle');
  eq([...kinds], ['brawl'], 'the first cycle is a brawl');
  eq(V.fightAt(V.WEST_FIGHT_PERIOD).kind, 'shootout', 'and the next is a shootout');
  eq(V.fightAt(V.WEST_FIGHT_PERIOD * 2).kind, 'brawl', 'and then they turn about again');
  eq(V.fightAt(V.WEST_FIGHT_PERIOD - 0.01), null, 'the rest of a cycle is quiet');
  for (const t of [0, 0.5, V.WEST_FIGHT_PERIOD * 3 + 0.2]) {
    eq(V.fightAt(t, true), null, `reduced motion: nothing at ${t}`);
  }

  // The pair: the two standing nearest each other, west first, so the cloud between them always has both inside it.
  eq(V.fightPair([]), null, 'nobody to fight');
  eq(V.fightPair([{ x: 0, y: 0 }]), null, 'one guest cannot brawl');
  const far = { x: 900, y: 500 };
  const near = [{ x: 200, y: 500 }, { x: 260, y: 500 }];
  eq(V.fightPair([far, ...near]), near, 'the two nearest each other, not the first two');
  eq(V.fightPair([near[1], near[0]]), near, 'and the westmost of the pair comes first');
});

check('every theme pack paints a whole village: no colour is left to chance, and both rooms are named', () => {
  const base = { day: V.resolveTheme('village', false), dusk: V.resolveTheme('village', true) };
  assert(V.THEME_KEYS.length >= 2, 'there is more than one pack to choose between');
  eq(V.THEME_KEYS[0], V.DEFAULT_THEME, 'the green village is the default and comes first');
  for (const packKey of V.THEME_KEYS) {
    for (const night of [false, true]) {
      const scheme = night ? 'dusk' : 'day';
      const T = V.resolveTheme(packKey, night);
      eq(T.pack, packKey, `${packKey} ${scheme}: the theme knows its pack`);
      eq(T.night, night, `${packKey} ${scheme}: the theme knows the time of day`);
      // A pack that left a colour out would paint `undefined`, which a canvas silently ignores: the shape
      // vanishes rather than erroring, so nothing downstream would ever say so.
      const missing = Object.keys(base[scheme]).filter((k) => T[k] === undefined);
      eq(missing, [], `${packKey} ${scheme}: colours the pack dropped`);
      // And a pack that misspells one does nothing at all: the base colour is kept and the new one is never read.
      const pack = V.THEME_PACKS.find((q) => q.key === packKey);
      const unknown = Object.keys(night ? pack.dusk : pack.day).filter((k) => !(k in base[scheme]));
      eq(unknown, [], `${packKey} ${scheme}: colours the pack names that the village has no use for`);
      // The floor a scene falls back to has to be the pack's own, or the margins either side of a themed room
      // keep the last pack's floor.
      for (const floor of ['hallFloor', 'roomFloor', 'grass']) {
        assert(typeof T[floor] === 'string' && T[floor].length > 0, `${packKey} ${scheme}: ${floor} is a colour`);
      }
    }
    // Every board a pack renames is a board the village has, and both rooms are named whatever the pack.
    for (const place of V.PLACE_KEYS) {
      const word = V.placeName(place, packKey);
      assert(typeof word === 'string' && word.length > 0 && word.length <= 20, `${packKey}: ${place} has a board name (${word})`);
    }
    for (const room of ['castle', 'cottages']) {
      assert(V.roomName(room, packKey).length > 0, `${packKey}: ${room} is named`);
    }
  }
  // An unknown pack is the green village rather than a village with no colours at all.
  eq(V.resolveTheme('nope', false), V.resolveTheme(V.DEFAULT_THEME, false), 'an unknown pack falls back');
  eq(V.placeName('harbour', 'nope'), V.placeName('harbour'), 'and so do its board names');
});

check('a name board stays readable in every pack, and no board colour can be read as a state badge', () => {
  for (const packKey of V.THEME_KEYS) {
    for (const night of [false, true]) {
      const scheme = `${packKey} ${night ? 'dusk' : 'day'}`;
      const T = V.resolveTheme(packKey, night);
      assert(contrast(T.signText, T.signBoard) >= 4.5,
        `${scheme}: board lettering is ${contrast(T.signText, T.signBoard).toFixed(2)}:1 on the board`);
      assert(contrast(T.signMuted, T.signBoard) >= 4.5,
        `${scheme}: the board's second line is ${contrast(T.signMuted, T.signBoard).toFixed(2)}:1`);
      // The badges are painted on the board, so a board that drifted towards one of them would swallow it. A pale
      // badge (Idle, Recent) is told from the board by its border instead, which is why either will do.
      for (const st of Object.values(V.STATE)) {
        const best = Math.max(de00(T.signBoard, st.color), de00(T.signBoard, st.border));
        assert(best >= 20, `${scheme}: the ${st.word} badge is only ${best.toFixed(1)} from the board it sits on`);
      }
      // The ground a character stands on is not a state colour either, in any pack.
      for (const [name, hex] of Object.entries(RESERVED)) {
        assert(de00(T.grass, hex) >= 12, `${scheme}: the ground is only ${de00(T.grass, hex).toFixed(1)} from ${name}`);
      }
    }
  }
});

check('the frontier kit is the Wild West\'s alone, and its hat lifts the painted badge and the clickable one together', () => {
  // One look per accessory. look also picks the shape (look % 3), so this covers round, square and tall as well.
  const LOOKS = [[0, 'none'], [4, 'hat'], [8, 'scarf'], [12, 'antenna'], [16, 'glasses']];
  const ID = 'local_abababab-0000-4000-8000-00000000c0c0';
  // Two lanes: one standing, and one lounging on Valhalla. A lounger wears no waistcoat, because a deck chair
  // cuts across where it would sit, but it is hatted like everyone else: `headroom` lifts every badge in this
  // pack by one hat, so a look left bare-headed here would hang its badge over a gap.
  const LANES = ['errored', 'valhalla'];

  // The badge's height above the character's feet, as painted and as hit tested. A body's height varies with its
  // shape, so the two packs are compared look for look rather than look against look.
  const badgeLift = (look, packKey, LANE) => {
    const rows = [row(ID, LANE, { look })];
    const slot = V.layoutVillage(rows).get(ID);
    const frame = lastFrame(paintedShapes(rows, { theme: packKey }).shapes, 'day', V.resolveTheme(packKey, false).grass);
    const discs = frame.filter((sh) => sh.kind === 'fill' && sh.style === V.STATE[LANE].color
      && sh.radii.some((r) => Math.abs(r - 14) < 0.01));
    eq(discs.length, 1, `${packKey}/${look}: one painted state badge`);
    // Steel on this character alone: the village paints plenty elsewhere (the jail's bars, the harbour barrier).
    const steel = frame.filter((sh) => sh.kind === 'fill' && sh.style === V.resolveTheme(packKey, false).steel
      && Math.abs((sh.box[0] + sh.box[2]) / 2 - slot.x) < 26 && sh.box[1] > slot.y - 60 && sh.box[3] < slot.y + 4);
    // The highest thing this character paints below its own badge: its hat if it wears one, else its head. The
    // badge is lifted by `headroom` whether or not a hat is drawn, so this is the only way to tell that one is.
    const badgeBottom = (discs[0].box[1] + discs[0].box[3]) / 2 + 14;
    // An errored session puffs smoke over its own head, in both packs alike, so it would mask the hat underneath.
    const smoke = V.resolveTheme(packKey, false).smoke;
    const onBody = frame.filter((sh) => Math.abs((sh.box[0] + sh.box[2]) / 2 - slot.x) < 30
      && sh.box[1] >= badgeBottom - 0.5 && sh.box[1] < slot.y && !String(sh.style).includes(smoke));
    const crown = onBody.length ? Math.min(...onBody.map((sh) => sh.box[1])) : slot.y;
    const v = makeVillage({ theme: packKey });
    v.village.start();
    v.village.update(board(rows), { privacy: false });
    // The village reports its hover point at the badge's centre, which is where a click has to land.
    const at = v.aim(rows, ID);
    v.village.destroy();
    return {
      painted: slot.y - (discs[0].box[1] + discs[0].box[3]) / 2, clickable: slot.y - at.y, steel,
      // How far the badge's underside sits above the highest thing this character paints below it.
      gap: crown - badgeBottom,
    };
  };

  for (const LANE of LANES) {
  for (const [look, accessory] of LOOKS) {
    const green = badgeLift(look, 'village', LANE);
    const west = badgeLift(look, 'west', LANE);
    // Dom's first bug: the lift was written out twice, so a taller hat raised the painted badge and left the
    // clickable one behind. Both packs are checked, because only one of them changes the hat.
    near(green.painted, green.clickable, 0.01, `village/${accessory}: the painted badge is where the click lands`);
    near(west.painted, west.clickable, 0.01, `west/${accessory}: the painted badge is where the click lands`);
    // In the frontier town everyone is hatted. A look already wearing one in the green village keeps its lift;
    // every other look gains exactly one hat. That difference is the kit, and it is the Wild West's alone.
    const alreadyHatted = accessory === 'hat' || accessory === 'antenna';
    near(west.painted - green.painted, alreadyHatted ? 0 : V.HAT_LIFT, 0.01,
      `${accessory}: what the frontier hat adds over the green village`);

    // A badge never floats: whatever a look wears, the top of its head or its hat comes up to meet it. This is what
    // a lift and a hat disagreeing looks like from outside, and it held in both packs at once. In the frontier town
    // `headroom` lifts every badge by one hat, so a look left bare-headed there opens a gap the width of the hat,
    // which is exactly what the loungers had: hatless, and their badges hanging over nothing.
    for (const [packName, m] of [['village', green], ['west', west]]) {
      assert(m.gap <= 6, `${packName}/${LANE}/${accessory}: the badge floats ${m.gap.toFixed(2)} px over the head under it`);
    }

    // The buckle and the revolver's butt are the kit's only steel, and neither lane paints a hammer, so steel in
    // the frame is the gun belt and nothing else. It says the kit is worn here and nowhere else.
    eq(green.steel.length, 0, `village/${LANE}/${accessory}: no gun belt in the green village`);
    if (LANE === 'valhalla') {
      eq(west.steel.length, 0, `west/${accessory}: a lounger wears no gun belt, since its chair cuts across it`);
    } else {
      assert(west.steel.length >= 2, `west/${accessory}: the belt's buckle and the revolver's butt are painted`);
      // Clipped to the body, so nothing hangs off the side of the narrowest one (a tall body is 26 wide).
      const slotX = V.layoutVillage([row(ID, LANE, { look })]).get(ID).x;
      for (const sh of west.steel) {
        assert(sh.box[0] >= slotX - 13 && sh.box[2] <= slotX + 13,
          `west/${accessory}: the gun belt stays inside the narrowest body (${sh.box[0]}..${sh.box[2]} around ${slotX})`);
      }
    }
  }
  }
});

const INK_ON_KHAKI = '#1d2125';

check('the border patrol: booth, barrier and guard sit clear of the harbour, the queue, the boats and the walkways', () => {
  const patrol = { barrier: V.BARRIER_BOX, guard: V.GUARD_BOX, booth: V.BOOTH_BOX, platform: V.PATROL_PLATFORM };
  const [dx, dy, dw, dh] = V.HARBOUR_DECK;
  const scenery = {
    deck: V.HARBOUR_DECK, boardwalk: [1466, 302, 160, 36], lighthouse: [1494, 52, 106, 136],
    harbourSign: V.signBox('harbour'), cottagesSign: V.signBox('cottages'),
    mooredBoat: [V.BOAT_BERTH.x - 44, V.BOAT_BERTH.y - 6, 88, 28], dockedBoat: [V.JETTY_BERTH.x - 44, V.JETTY_BERTH.y - 64, 88, 84],
    bollard: [1547, 328, 14, 12], boardwalkPost: [1556, 334, 8, 14],
  };
  for (const [a, box] of Object.entries(patrol)) {
    for (const [b, o] of Object.entries(scenery)) assert(!V.boxesOverlap(box, o), `${a} ${JSON.stringify(box)} overlaps ${b}`);
    assert(box[0] >= 0 && box[0] + box[2] <= V.LOGICAL_WIDTH, `${a} inside the canvas`);
  }
  assert(!V.boxesOverlap(V.GUARD_BOX, V.BOOTH_BOX) && !V.boxesOverlap(V.BARRIER_BOX, V.GUARD_BOX) && !V.boxesOverlap(V.BARRIER_BOX, V.BOOTH_BOX), 'guard, booth and barrier apart');
  // The coast moved west, so the patrol's platform still stands on piles in the water beside the pier, as drawn.
  for (const [name, box] of Object.entries(patrol)) {
    assert(box[0] > V.shoreX(box[1] + box[3] / 2), `${name} is still out over the water (coast ${V.shoreX(box[1] + box[3] / 2).toFixed(0)})`);
  }
  // The barrier spans the pier just below the deck, and the gate point is on the pier above it.
  assert(V.BARRIER.tipX < V.PIER.x - V.PIER.half && V.BARRIER.pivotX > V.PIER.x + V.PIER.half, 'the barrier spans the pier');
  assert(V.BARRIER.y > dy + dh && V.BARRIER.y < V.HARBOUR_BOARD.y - 20, 'between the deck and the pier tip');
  assert(V.GATE_POINT.x === V.PIER.x && V.GATE_POINT.y > dy + dh && V.GATE_POINT.y < V.BARRIER.y, 'the gate point is on the pier, before the barrier');
  // A boat at the pier berth under sail (heading right, sail up, bobbing) never reaches the platform or the guard.
  const s = V.BOAT_SCALE;
  const sail = [[8, -82], [8, -16], [50, -18], [4, -96], [20, -91]].map(([x, y]) => [V.BOAT_BERTH.x + x * s, V.BOAT_BERTH.y + 4 - 2.2 + y * s]);
  const tri = sail.slice(0, 3);
  const inTri = ([x, y]) => {
    const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
    const d1 = sign([x, y], tri[0], tri[1]);
    const d2 = sign([x, y], tri[1], tri[2]);
    const d3 = sign([x, y], tri[2], tri[0]);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  for (const box of [V.PATROL_PLATFORM, V.GUARD_BOX, V.BOOTH_BOX]) {
    for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) assert(!inTri([box[0] + (box[2] * i) / 20, box[1] + (box[3] * j) / 20]), `a sail at the berth reaches ${JSON.stringify(box)}`);
    const flag = [V.BOAT_BERTH.x + 4 * s, V.BOAT_BERTH.y + 4 - 2.2 - 96 * s, 16 * s, 10 * s];
    assert(!V.boxesOverlap(box, flag), `the flag reaches ${JSON.stringify(box)}`);
  }
  // The whole queue at its size, walkers off along the boardwalk, and walkers down the pier stay clear of it.
  for (const n of [1, 5, 14]) {
    for (const slot of V.layoutVillage(crowd('harbour', n, { tokens: MAX_TOKENS })).values()) {
      for (const part of V.avatarBoxes('open_pr', slot.x, slot.y, slot.cap)) {
        for (const [name, box] of Object.entries(patrol)) assert(!V.boxesOverlap(part, box), `${n} in the queue: ${slot.x},${slot.y} covers the ${name}`);
      }
    }
  }
  // A voyager takes the size of where it is going, which is the largest for a lone lounger on the beach.
  for (const k of [1, V.TOKEN_SCALE.max]) {
    for (let x = 1466; x <= 1640; x += 6) {
      for (const part of V.avatarBoxes('open_pr', x, V.EXIT_POINT.y, k)) for (const [name, box] of Object.entries(patrol)) assert(!V.boxesOverlap(part, box), `a walker at ${k} off along the boardwalk at ${x} covers the ${name}`);
    }
    for (let y = V.PIER.top; y <= V.HARBOUR_BOARD.y; y += 4) {
      for (const part of V.avatarBoxes('open_pr', V.PIER.x, y, k)) for (const name of ['guard', 'booth', 'platform']) assert(!V.boxesOverlap(part, patrol[name]), `a walker at ${k} on the pier at ${y} covers the ${name}`);
    }
  }
  // Whoever stands at the barrier, in every pack: three colours, never a reserved state colour, in either scheme.
  // A pack may dress them how it likes (the frontier's khaki, the Shire's grey), but a guard that could be read as
  // a state badge would say a session was blocked when it was only being waved through.
  for (const pack of V.THEME_KEYS) {
    for (const night of [false, true]) {
      const scheme = `${pack} ${night ? 'dusk' : 'day'}`;
      const R = V.resolveTheme(pack, night);
      const T = { khaki: R.patrolKhaki, khakiShade: R.patrolKhakiShade, navy: R.patrolNavy, white: R.patrolWhite };
      for (const [name, hex] of Object.entries(T)) {
        for (const [state, r] of Object.entries(RESERVED)) {
          assert(de00(hex, r) >= 12, `${scheme} ${name} ${hex} is too close to ${state} (${de00(hex, r).toFixed(1)})`);
        }
      }
      assert(contrast(T.navy, T.white) >= 4.5 && contrast(INK_ON_KHAKI, T.khaki) >= 4.5,
        `${scheme}: stripes and the guard's face read`);
    }
  }
  for (const theme of ['day', 'dusk']) {
    const T = V.PATROL_COLOURS[theme];
    eq(Object.keys(T).sort(), ['khaki', 'khakiShade', 'navy', 'white'], `${theme}: the patrol colours`);
    for (const [name, hex] of Object.entries(T)) {
      for (const [state, r] of Object.entries(RESERVED)) assert(de00(hex, r) >= 12, `${theme} ${name} ${hex} is too close to ${state} (${de00(hex, r).toFixed(1)})`);
    }
    assert(contrast(T.navy, T.white) >= 4.5 && contrast(INK_ON_KHAKI, T.khaki) >= 4.5, `${theme}: stripes and the guard's face read`);
  }
});

check('hovering the guard reports the patrol with the waiting count; a click does nothing', () => {
  eq(V.PATROL_ID, 'harbour:patrol', 'the id the page knows');
  eq(V.patrolState([row(A, 'open_pr'), row(B, 'open_pr'), row(C, 'running'), null, 'x', { lane: 'open_pr' }]), { waiting: 3 }, 'counts open PRs only');
  eq([V.patrolState(null), V.patrolState([])], [{ waiting: 0 }, { waiting: 0 }], 'nothing waiting');
  const v = makeVillage();
  const rows = [row(A, 'open_pr'), row(B, 'open_pr'), row(C, 'castle')];
  v.village.update(board(rows), { privacy: false });
  v.fire('pointermove', V.GUARD.x, V.GUARD.y - 30);
  eq(v.hoveredId(), V.PATROL_ID, 'the guard is hovered');
  const point = v.log.hovers.at(-1).point;
  eq(point, { x: V.GUARD.x, y: V.GUARD_BOX[1] }, 'the point is the top of the guard\'s cap');
  v.fire('pointermove', V.BOOTH_BOX[0] + 10, V.BOOTH_BOX[1] + 20);
  eq(v.hoveredId(), V.PATROL_ID, 'the booth counts too');
  v.click(V.BOOTH_BOX[0] + 10, V.BOOTH_BOX[1] + 20);
  eq([v.log.opened, v.log.selected, v.log.scenes], [[], [], []], 'a click opens, selects and enters nothing');
  eq(v.hoveredId(), V.PATROL_ID, 'and keeps the hover');
  v.fire('pointermove', 20, 20);
  eq(v.log.hovers.at(-1), { id: null, point: null }, 'moving off clears it');
  v.village.enterCastle();
  v.fire('pointermove', V.GUARD.x, V.GUARD.y - 30);
  assert(v.hoveredId() !== V.PATROL_ID, 'no guard to hover inside the castle');
});

check('a merged PR stops at the barrier for its stamp, the barrier lifts, and anyone else is waved through', () => {
  const home = V.slotGrid('harbour', 3).points[0];
  const chair = V.slotGrid('beach', 1).points[0];
  const j = V.scheduleJourney(V.planJourney({ ...home, area: 'land' }, { ...chair, area: 'island' }, { stamp: true }), 10);
  eq(j.legs.map((l) => l.kind), ['walk', 'gate', 'walk', 'sail', 'walk'], 'legs with a stamp');
  const [toGate, gate, down] = j.legs;
  eq([toGate.pts.at(-1), gate.pts[0], down.pts[0], down.pts.at(-1)], [xy(V.GATE_POINT), xy(V.GATE_POINT), xy(V.GATE_POINT), xy(V.HARBOUR_BOARD)], 'to the gate, stamped there, down the pier');
  near(gate.dur, V.STAMP_S + V.LIFT_S, 1e-9, 'stamp then lift');
  assert(!V.planJourney({ ...V.HARBOUR_BOARD, area: 'land' }, { ...chair, area: 'island' }, { stamp: true }).some((l) => l.kind === 'gate'), 'already past the barrier: no stamp');
  const windows = V.barrierWindows(j);
  eq(windows.length, 1, 'one lift');
  const lift = (t) => V.barrierLift(windows, t);
  for (let t = 10; t < gate.t0 + V.STAMP_S - 1e-6; t += 0.05) eq(lift(t), 0, `down until the stamp is done (${t.toFixed(2)})`);
  const mid = V.journeyAt(j, gate.t0 + V.STAMP_S * 0.2);
  eq([xy(mid), mid.gate.mode, mid.gate.stamped, mid.walking], [xy(V.GATE_POINT), 'stamp', false, false], 'standing at the gate, passport out');
  assert(V.journeyAt(j, gate.t0 + V.STAMP_S * (V.STAMP_STRIKE + 0.05)).gate.stamped, 'stamped once the stamp comes down');
  assert(lift(gate.t0 + V.STAMP_S + V.LIFT_S / 2) > 0 && lift(gate.t0 + V.STAMP_S + V.LIFT_S / 2) < 1, 'rising');
  const crossAt = down.t0 + V.barrierCrossing(down) * down.dur;
  near(V.journeyAt(j, crossAt).y, V.BARRIER.y, 0.5, 'the crossing time puts its feet on the barrier line');
  for (let t = gate.t0 + gate.dur; t <= crossAt + 0.1; t += 0.02) eq(lift(t), 1, `up while it passes (${t.toFixed(2)})`);
  eq(lift(windows[0].down1 + 0.01), 0, 'down again once it is through');
  assert(windows[0].down1 < down.t0 + down.dur + 0.5, 'and before long');

  // From anywhere else: no stop, but the barrier is up as its feet cross, both ways.
  const work = V.slotGrid('workshop', 1).points[0];
  for (const [from, to, label] of [[{ ...work, area: 'land' }, { ...chair, area: 'island' }, 'outbound'], [{ ...chair, area: 'island' }, { ...work, area: 'land' }, 'inbound']]) {
    const w = V.scheduleJourney(V.planJourney(from, to), 0);
    assert(!w.legs.some((l) => l.kind === 'gate'), `${label}: no stamp`);
    const win = V.barrierWindows(w);
    eq(win.length, 1, `${label}: one crossing`);
    const leg = w.legs.find((l) => V.barrierCrossing(l) !== null);
    const tc = leg.t0 + V.barrierCrossing(leg) * leg.dur;
    near(V.journeyAt(w, tc).y, V.BARRIER.y, 0.5, `${label}: crossing on the line`);
    eq([V.barrierLift(win, tc - 0.12), V.barrierLift(win, tc), V.barrierLift(win, tc + 0.25)], [1, 1, 1], `${label}: up as it passes`);
    eq([V.barrierLift(win, tc - 1), V.barrierLift(win, tc + 1)], [0, 0], `${label}: down before and after`);
  }
  eq(V.barrierWindows(V.scheduleJourney([{ kind: 'walk', area: 'land', pts: [{ x: 1470, y: 320 }, { x: 1640, y: 320 }], dur: 1 }], 0)), [], 'walking off along the boardwalk passes no barrier');

  // Two merges at once: the second waits for the gate point to clear.
  const first = V.scheduleJourney(V.planJourney({ ...home, area: 'land' }, { ...chair, area: 'island' }, { stamp: true }), 0);
  const other = V.slotGrid('harbour', 3).points[1];
  const second = V.scheduleJourney(V.planJourney({ ...other, area: 'land' }, { ...V.slotGrid('beach', 2).points[1], area: 'island' }, { stamp: true }), 0);
  const delay = V.holdForGate(second, [first]);
  const g1 = first.legs[1];
  const g2 = second.legs[1];
  assert(delay > 0 && g2.t0 >= g1.t0 + g1.dur + V.GATE_CLEAR_S - 1e-9, `the second stamp waits its turn (${delay.toFixed(2)} s)`);
  eq(V.journeyAt(second, 0.5).walking, false, 'standing where it was meanwhile');
  eq(V.holdForGate(first, [second]), 0, 'the first is not held back by a later one');
});

check('in the village a merge from the queue is stamped at full rate, the barrier lifts, and the harbour settles to ambient', () => {
  withFrameLoop((loop) => {
    const log = { scales: [], barrier: [] };
    reduceMotion = false;
    const listeners = new Map();
    const hovers = [];
    const canvas = {
      width: 0, height: 0, style: {}, getContext: () => scaleSpy(log),
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }),
      addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener() {},
    };
    const village = V.createVillage(canvas, { onHover: (id, point) => hovers.push({ id, point }) });
    village.resize();
    village.start();
    const others = [0, 1, 2, 3].map((i) => row(`local_abcdabcd-0000-4000-8000-${String(i).padStart(12, '0')}`, 'open_pr'));
    const before = [row(A, 'open_pr'), ...others];
    village.update(board(before), { privacy: false });
    loop.pump(0.5);
    const calm = loop.pump(2);
    assert(calm.frames <= 26, `a queue and an idle guard stay ambient (${calm.frames} frames in 2 s)`);
    assert(log.barrier.length > 0 && log.barrier.every((a) => a === 0), 'the barrier is down');
    // Hover A so its movement is reported.
    const slot = V.layoutVillage(before).get(A);
    for (let k = 0; k <= 160 && !(hovers.length && hovers.at(-1).id === A); k += 2) listeners.get('pointermove')({ clientX: slot.x, clientY: slot.y - k });
    eq(hovers.at(-1).id, A, 'hovering the one that will merge');
    const after = [row(A, 'valhalla'), ...others];
    const t0 = clock.ms / 1000;
    village.update(board(after), { privacy: false });
    log.barrier.length = 0;
    const plan = V.scheduleJourney(V.planJourney({ ...slot, area: 'land' }, { ...V.layoutVillage(after).get(A), area: 'island' }, { stamp: true }), t0);
    const gate = plan.legs[1];
    loop.pump(gate.t0 - t0 + 0.05);
    const at = hovers.filter((h) => h.id === A).at(-1).point;
    log.barrier.length = 0;
    const stamping = loop.pump(V.STAMP_S - 0.1);
    assert(stamping.frames >= 45, `full rate while the guard stamps (${stamping.frames} frames)`);
    // Look 7's hover point is 82 above its feet at the plain size, and the walker already has its size on the beach.
    const k = (V.tokenScale(after[0]) * V.layoutVillage(after).get(A).cap) / V.TOKEN_SCALE.max;
    near(at.y + 82 * k, V.GATE_POINT.y, 1, 'it stands at the gate point');
    near(at.x, V.GATE_POINT.x, 1, 'on the pier');
    assert(log.barrier.every((a) => a === 0), 'the barrier stays down during the stamp');
    log.barrier.length = 0;
    loop.pump(V.LIFT_S + 0.6);
    assert(log.barrier.some((a) => Math.abs(a - Math.PI / 2) < 1e-6), 'then it lifts all the way');
    assert(log.barrier.some((a) => a > 0 && a < Math.PI / 2 - 1e-6), 'moving through the frames in between');
    loop.pump(12);
    log.barrier.length = 0;
    const settled = loop.pump(2);
    assert(settled.frames <= 26, `ambient again once it has sailed (${settled.frames} frames in 2 s)`);
    assert(log.barrier.length > 0 && log.barrier.every((a) => a === 0), 'and the barrier is down again');
    village.destroy();
  });

  withFrameLoop((loop) => {
    const log = { scales: [], barrier: [] };
    reduceMotion = true;
    const canvas = {
      width: 0, height: 0, style: {}, getContext: () => scaleSpy(log),
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }),
      addEventListener() {}, removeEventListener() {},
    };
    const village = V.createVillage(canvas, {});
    village.resize();
    village.start();
    village.update(board([row(A, 'open_pr'), row(B, 'running')]), { privacy: false });
    loop.pump(0.3);
    village.update(board([row(A, 'valhalla'), row(B, 'valhalla')]), { privacy: false });
    const out = loop.pump(3);
    assert(out.frames <= 4, `reduced motion: placed directly, no stamp (${out.frames} frames in 3 s)`);
    assert(log.barrier.length > 0 && log.barrier.every((a) => a === 0), 'reduced motion: the barrier stays down');
    village.destroy();
  });
});

// Records the bounding box, in scene units, of every path filled or stroked, with the style it was drawn in. It follows
// save, restore, setTransform, translate, scale and rotate; an arc or ellipse counts as its whole bounding square.
function geometrySpy(shapes) {
  let m = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let pts = [];
  // The arc radii of the path being built, in logical units: a rounded rect's corner radius reaches the canvas
  // only this way, and a pane drawn at a radius its opening does not have is invisible to a box.
  let radii = [];
  // lineWidth rides along so a stroke's real extent is readable: a path inside its budget can still paint outside
  // it by half a line width, which is how the world map's hover ring escaped its cell.
  const styles = { fillStyle: null, strokeStyle: null, lineWidth: 1, font: '', textAlign: 'start', textBaseline: 'alphabetic', globalAlpha: 1 };
  // globalAlpha alone is saved and restored with the transform, so `alpha` on a shape is what it was painted at: a
  // figure still fading in is not the same thing on screen as one standing in full view.
  const alphas = [];
  // A character is 0.62 em wide here, which is what `islandScene` assumes of the digits, and the em is read off
  // the font string the draw actually set. Text was invisible to this spy: it had no `fillText` at all, so the
  // numeral and the repo name, the two things the world map promises stay legible, were outside every box check
  // that cites it. And `measureText` was defined but its return value discarded by the proxy below, so every
  // string measured 10 px wide and `fitText` never truncated under any geometry check.
  const PER_EM = 0.62;
  const fontPx = () => {
    const m2 = /(\d+(?:\.\d+)?)px/.exec(String(styles.font));
    return m2 ? Number(m2[1]) : 10;
  };
  const add = (x, y) => pts.push([m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const oval = (x, y, rx, ry) => { add(x - rx, y - ry); add(x + rx, y - ry); add(x - rx, y + ry); add(x + rx, y + ry); };
  const emit = (kind, style, list, rads = []) => {
    if (!list.length) return;
    const xs = list.map((p) => p[0]);
    const ys = list.map((p) => p[1]);
    shapes.push({ kind, style, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], radii: rads.slice(), scale: Math.hypot(m[0], m[1]), turned: Math.abs(m[1]) > 1e-9, lw: Number(styles.lineWidth) || 1, alpha: Number(styles.globalAlpha) });
  };
  const ops = {
    save: () => { stack.push([...m]); alphas.push(styles.globalAlpha); },
    restore: () => { m = stack.pop() || [1, 0, 0, 1, 0, 0]; styles.globalAlpha = alphas.length ? alphas.pop() : 1; },
    setTransform: (a, b, c, d, e, f) => { m = [a, b, c, d, e, f].map(Number); },
    resetTransform: () => { m = [1, 0, 0, 1, 0, 0]; },
    translate: (x, y) => { m = [m[0], m[1], m[2], m[3], m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; },
    scale: (sx, sy) => { m = [m[0] * sx, m[1] * sx, m[2] * sy, m[3] * sy, m[4], m[5]]; },
    rotate: (a) => {
      const c = Math.cos(a);
      const s = Math.sin(a);
      m = [m[0] * c + m[2] * s, m[1] * c + m[3] * s, m[2] * c - m[0] * s, m[3] * c - m[1] * s, m[4], m[5]];
    },
    beginPath: () => { pts = []; radii = []; },
    moveTo: add,
    lineTo: add,
    arc: (x, y, r) => { radii.push(r * Math.hypot(m[0], m[1])); oval(x, y, r, r); },
    ellipse: (x, y, rx, ry) => oval(x, y, rx, ry),
    rect: (x, y, w, h) => { add(x, y); add(x + w, y + h); },
    fill: () => emit('fill', styles.fillStyle, pts, radii),
    stroke: () => emit('stroke', styles.strokeStyle, pts, radii),
    fillRect: (x, y, w, h) => {
      const saved = pts;
      pts = [];
      add(x, y);
      add(x + w, y + h);
      emit('fill', styles.fillStyle, pts);
      pts = saved;
    },
    // The glyph box: the advance width by the cap height, placed by the align and baseline the draw set. Emitted
    // as its own kind so a check can count it, measure it or skip it, and so the paint-call figures stay
    // comparable with the ones the cost table quotes.
    fillText: (text, x, y) => {
      const em = fontPx();
      const w = Array.from(String(text)).length * em * PER_EM;
      const cap = em * 0.72;
      const left = styles.textAlign === 'center' ? x - w / 2 : styles.textAlign === 'right' || styles.textAlign === 'end' ? x - w : x;
      const topY = styles.textBaseline === 'middle' ? y - cap / 2 : styles.textBaseline === 'top' || styles.textBaseline === 'hanging' ? y : y - cap;
      const saved = pts;
      pts = [];
      add(left, topY);
      add(left + w, topY + cap);
      emit('text', styles.fillStyle, pts);
      pts = saved;
    },
    measureText: (text) => ({ width: Array.from(String(text)).length * fontPx() * PER_EM }),
  };
  return new Proxy(function () {}, {
    get: (_t, key) => {
      // The return value is passed through, not swallowed: `ctx.measureText(t).width` came back 10 for every
      // string, so `fitText` and `fitTextMiddle` truncated nothing under any check that used this spy.
      if (key in ops) return (...args) => {
        const r = ops[key](...args);
        return r === undefined ? stub : r;
      };
      if (key in styles) return styles[key];
      return key === Symbol.toPrimitive ? () => 0 : key === 'width' ? 10 : stub;
    },
    set: (_t, key, value) => {
      if (key in styles) styles[key] = value;
      return true;
    },
    apply: () => stub,
  });
}

// A village drawn through geometrySpy, with motion.
function geometryVillage(shapes, opts = {}) {
  reduceMotion = opts.reduce === true;
  const listeners = new Map();
  const canvas = {
    width: 0, height: 0, style: {}, getContext: () => geometrySpy(shapes),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }),
    addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener() {},
  };
  const hovers = [];
  const islands = [];
  const village = V.createVillage(canvas, {
    onHover: (id, point) => hovers.push({ id, point }),
    onIsland: (repo) => islands.push(repo),
    mode: opts.mode,
    island: opts.island,
  });
  village.resize();
  village.start();
  return { village, listeners, hovers, islands };
}

// Each row's body box this frame, found by its repo colour (so every row needs its own repo): the largest shape filled
// in that colour, since hands are small discs.
function bodiesByColour(shapes, colourIds) {
  const out = new Map();
  for (const s of shapes) {
    const id = s.kind === 'fill' ? colourIds.get(s.style) : undefined;
    if (!id) continue;
    const w = s.box[2] - s.box[0];
    if (w < 20 * s.scale) continue;
    const old = out.get(id);
    if (!old || w * (s.box[3] - s.box[1]) > (old[2] - old[0]) * (old[3] - old[1])) out.set(id, s.box);
  }
  return out;
}

check('PRs merging in one update: nobody walks into the queue slot of one held back for the gate', () => {
  // Each case would put a queued row on a held walker's spot: in the same update, or at the next one (5 and 6) once the
  // queue closes up. A queue of 6 also re-spaces its slots as it shrinks.
  for (const [n, merged, againAt] of [[4, [0, 1], null], [5, [0, 2], 0.8], [6, [0, 3], 1.2], [6, [1, 2, 4], 1.5]]) withFrameLoop((loop) => {
    const label = `${n} in the queue, ${merged.length} merge${againAt ? `, another update at ${againAt} s` : ''}`;
    const shapes = [];
    const { village } = geometryVillage(shapes);
    const ids = 'abcdef'.slice(0, n).split('').map((ch) => `local_${ch.repeat(8)}-0000-4000-8000-000000000001`);
    const repos = ids.map((_, i) => `repo-${i}`);
    const colourIds = new Map(ids.map((id, i) => [V.repoColour(repos[i], repos).light, id]));
    const rows = (gone) => ids.map((id, i) => row(id, gone.includes(i) ? 'valhalla' : 'open_pr', { repo: repos[i] }));
    village.update(board(rows([])), { privacy: false });
    loop.pump(0.5);
    const t0 = clock.ms / 1000;
    village.update(board(rows(merged)), { privacy: false });
    // How long each pair of bodies has stood more than half on top of each other, without a break.
    const since = new Map();
    let worst = { secs: 0 };
    let frames = 0;
    let again = againAt;
    loop.pump(12, (ms) => {
      if (again !== null && ms / 1000 - t0 >= again) {
        again = null;
        village.update(board(rows(merged)), { privacy: false });
      }
      const bodies = bodiesByColour(shapes, colourIds);
      shapes.length = 0;
      if (bodies.size === n) frames += 1;
      const list = [...bodies.entries()];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const [ia, a] = list[i];
          const [ib, b] = list[j];
          const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
          const oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
          const key = `${ia.slice(6, 7)} and ${ib.slice(6, 7)}`;
          if (ox > Math.min(a[2] - a[0], b[2] - b[0]) / 2 && oy > Math.min(a[3] - a[1], b[3] - b[1]) / 2) {
            if (!since.has(key)) since.set(key, ms);
            const secs = (ms - since.get(key)) / 1000;
            if (secs > worst.secs) worst = { secs, key, at: ms / 1000 - t0 };
          } else {
            since.delete(key);
          }
        }
      }
    });
    assert(frames > 30, `${label}: every body was drawn while the second waited (${frames} frames)`);
    assert(worst.secs <= 0.4, `${label}: ${worst.key} stood on each other for ${worst.secs.toFixed(2)} s, until ${(worst.at || 0).toFixed(2)} s after the merge`);
    village.destroy();
  });

  // A single merge holds nobody back, so the queue closes up at once as before.
  withFrameLoop((loop) => {
    const shapes = [];
    const { village } = geometryVillage(shapes);
    const ids = 'abcdef'.split('').map((ch) => `local_${ch.repeat(8)}-0000-4000-8000-000000000002`);
    const repos = ids.map((_, i) => `repo-${i}`);
    const colourIds = new Map(ids.map((id, i) => [V.repoColour(repos[i], repos).light, id]));
    const before = ids.map((id, i) => row(id, 'open_pr', { repo: repos[i] }));
    village.update(board(before), { privacy: false });
    loop.pump(0.5);
    const after = before.map((r, i) => (i === 0 ? { ...r, lane: 'valhalla' } : r));
    village.update(board(after), { privacy: false });
    loop.pump(3);
    shapes.length = 0;
    loop.pump(0.1);
    const bodies = bodiesByColour(shapes, colourIds);
    const want = V.layoutVillage(after, V.layoutVillage(before));
    for (const id of ids.slice(1)) near((bodies.get(id)[0] + bodies.get(id)[2]) / 2, want.get(id).x, 1, `one merge: ${id.slice(6, 7)} has moved to its new slot`);
    village.destroy();
  });
});

check('a merge at the largest size passes the guard, and its passport stops short of the guard\'s cap', () => {
  withFrameLoop((loop) => {
    const shapes = [];
    const { village } = geometryVillage(shapes);
    const k = V.TOKEN_SCALE.max;
    const T = V.PATROL_COLOURS.day;
    const at = (x) => Math.abs(x - k) < 1e-6;
    village.update(board([row(A, 'open_pr', { tokens: MAX_TOKENS })]), { privacy: false });
    loop.pump(0.5);
    village.update(board([row(A, 'valhalla', { tokens: MAX_TOKENS })]), { privacy: false });
    const clash = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    const box = ([x, y, w, h]) => [x, y, x + w, y + h];
    const seen = { passports: 0, besideGuard: 0, worst: [] };
    loop.pump(7, () => {
      const frame = shapes.splice(0);
      const walker = frame.filter((s) => at(s.scale));
      if (!walker.length) return;
      const union = [Math.min(...walker.map((s) => s.box[0])), Math.min(...walker.map((s) => s.box[1])), Math.max(...walker.map((s) => s.box[2])), Math.max(...walker.map((s) => s.box[3]))];
      const guardParts = frame.filter((s) => Math.abs(s.scale - 1) < 1e-6 && s.kind === 'fill' && (
        (s.style === T.khaki && s.box[2] - s.box[0] >= 25)
        || (s.style === T.navy && s.box[1] < V.GUARD.y - 40 && s.box[2] - s.box[0] >= 19 && Math.abs((s.box[0] + s.box[2]) / 2 - V.GUARD.x) < 12)));
      assert(guardParts.length >= 3, `the guard's body and cap are drawn (${guardParts.length})`);
      if (union[3] > V.PIER.top && union[1] < V.HARBOUR_BOARD.y) seen.besideGuard += 1;
      for (const g of guardParts) assert(!clash(union, g.box), `the walker ${JSON.stringify(union.map(Math.round))} covers the guard's ${g.style === T.khaki ? 'body' : 'cap'} ${JSON.stringify(g.box.map(Math.round))}`);
      for (const [name, b] of [['platform', V.PATROL_PLATFORM], ['booth', V.BOOTH_BOX]]) assert(!clash(union, box(b)), `the walker ${JSON.stringify(union.map(Math.round))} covers the ${name}`);
      const passport = walker.find((s) => s.kind === 'fill' && s.style === T.navy && Math.abs(s.box[2] - s.box[0] - 14 * k) < 0.5 && Math.abs(s.box[3] - s.box[1] - 10 * k) < 0.5);
      if (passport) {
        seen.passports += 1;
        for (const g of guardParts.filter((p) => p.style === T.navy)) seen.worst.push(g.box[0] - passport.box[2]);
      }
    });
    assert(seen.passports > 20, `the passport is held out at the largest size (${seen.passports} frames)`);
    assert(seen.besideGuard > 20, `and the walker passes the guard (${seen.besideGuard} frames)`);
    assert(Math.min(...seen.worst) >= 2, `the passport stays at least 2 px short of the cap (${Math.min(...seen.worst).toFixed(1)})`);
    village.destroy();
  });
});

check('the passport comes down once stamped, so the rising barrier never sweeps through it', () => {
  for (const tokens of [null, MAX_TOKENS]) {
    withFrameLoop((loop) => {
      const shapes = [];
      const { village } = geometryVillage(shapes);
      const T = V.PATROL_COLOURS.day;
      village.update(board([row(A, 'open_pr', { tokens })]), { privacy: false });
      loop.pump(0.5);
      village.update(board([row(A, 'valhalla', { tokens })]), { privacy: false });
      const seen = { passport: 0, lifting: 0, both: 0 };
      loop.pump(5, () => {
        const frame = shapes.splice(0);
        const passport = frame.some((s) => s.kind === 'fill' && s.style === T.navy && Math.abs(s.box[2] - s.box[0] - 14 * s.scale) < 0.5 && Math.abs(s.box[3] - s.box[1] - 10 * s.scale) < 0.5);
        const lifting = frame.some((s) => s.turned && s.kind === 'fill' && s.style === T.white);
        seen.passport += passport ? 1 : 0;
        seen.lifting += lifting ? 1 : 0;
        seen.both += passport && lifting ? 1 : 0;
      });
      const label = tokens ? 'largest' : 'plain';
      assert(seen.passport >= 45, `${label}: the passport is held out through the stamp (${seen.passport} frames)`);
      assert(seen.lifting >= 10, `${label}: the barrier lifts (${seen.lifting} frames)`);
      eq(seen.both, 0, `${label}: frames with the barrier moving and the passport still out`);
      village.destroy();
    });
  }
});

// ---------- the jail and the graveyard's ghost ----------

check('a prisoner hovers, opens, and reports its point at its token size', () => {
  const hoverFor = (tokens) => {
    const v = makeVillage();
    const rows = jailRows(1, { tokens });
    v.village.update(board(rows), { privacy: false });
    v.aim(rows, rows[0].id);
    return { v, id: rows[0].id, point: v.log.hovers.at(-1).point, slot: V.layoutVillage(rows).get(rows[0].id) };
  };
  const big = hoverFor(MAX_TOKENS);
  const plain = hoverFor(null);
  const k = big.slot.cap;
  eq(k, V.TOKEN_SCALE.max, 'a lone prisoner grows to the largest size');
  near(big.point.y, big.slot.y - 68 * k - 14 * k, 1e-6, 'the hover point sits on top of the grown badge');
  near(plain.point.y, plain.slot.y - 68 - 14, 1e-6, 'and on the plain badge when there is no token count');
  const high = { x: big.slot.x, y: big.slot.y - 68 * k };
  big.v.fire('pointerleave', 0, 0);
  big.v.fire('pointermove', high.x, high.y);
  eq(big.v.hoveredId(), big.id, 'the grown badge is hit where it is drawn');
  plain.v.fire('pointerleave', 0, 0);
  plain.v.fire('pointermove', high.x, high.y);
  eq(plain.v.hoveredId(), null, 'nothing is there at the plain size');
  big.v.click(high.x, high.y);
  eq(big.v.log.opened, [big.id], 'a click on a prisoner opens its session');

  // A full yard: the front row and the back row are both still reachable.
  const full = jailRows(9);
  const w = makeVillage();
  w.village.update(board(full), { privacy: false });
  for (const id of [full[0].id, full.at(-1).id]) {
    w.fire('pointerleave', 0, 0);
    assert(w.aim(full, id), `${id} is hoverable in a full yard`);
  }
  // A terminal row has nothing to open, so it selects, as everywhere else.
  const cli = [row(A, 'jail', { kind: 'cli', canOpen: false, canCopyResume: true })];
  const u = makeVillage();
  u.village.update(board(cli), { privacy: false });
  const at = u.aim(cli, A);
  u.click(at.x, at.y);
  eq(u.log.selected, [A], 'a terminal row selects instead');
  eq(u.log.opened, [], 'and opens nothing');
});

check('a row sent to the jail walks there, at full rate while it walks and ambient once it stands', () => {
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false });
    v.village.start();
    const before = [row(A, 'running')];
    v.village.update(board(before), { privacy: false });
    loop.pump(0.5);
    const from = V.layoutVillage(before).get(A);
    const after = [row(A, 'jail')];
    const to = V.layoutVillage(after).get(A);
    const legs = V.planJourney({ x: from.x, y: from.y, area: 'land' }, { x: to.x, y: to.y, area: 'land' });
    assert(legs.every((l) => l.kind === 'walk'), `it walks the roads, it does not fade through a door (${legs.map((l) => l.kind)})`);
    // It comes round the east side of the graveyard and in at the gateway, both ways: a straight run off the road
    // would cross the fence and walk over the headstones.
    const [gx, gy, gw, gh] = V.GRAVEYARD.fence;
    const overGraves = (route) => {
      for (let i = 1; i < route.length; i++) {
        for (let k = 0; k <= 80; k++) {
          const x = route[i - 1].x + (route[i].x - route[i - 1].x) * (k / 80);
          const y = route[i - 1].y + (route[i].y - route[i - 1].y) * (k / 80);
          if (x >= gx && x <= gx + gw && y >= gy && y <= gy + gh) return { x: Math.round(x), y: Math.round(y) };
        }
      }
      return null;
    };
    for (const n of [1, 5, 9, 20]) {
      for (const slot of jailSlots(n)) {
        const inbound = V.planRoute({ x: from.x, y: from.y }, { x: slot.x, y: slot.y });
        const outbound = V.planRoute({ x: slot.x, y: slot.y }, { x: from.x, y: from.y });
        for (const [way, route] of [['in', inbound], ['out', outbound]]) {
          assert(!overGraves(route), `${n}: the walk ${way} at ${slot.x},${slot.y} crosses the graveyard at ${JSON.stringify(overGraves(route))}`);
          assert(route.some((p) => Math.hypot(p.x - V.JAIL.approach.x, p.y - V.JAIL.approach.y) < 1), `${n}: the walk ${way} goes through the gateway`);
        }
      }
    }
    v.village.update(board(after), { privacy: false });
    const walking = loop.pump(0.4);
    assert(walking.frames >= 20, `full rate while it walks (${walking.frames} frames in 0.4 s)`);
    loop.pump(legs.reduce((sum, l) => sum + l.dur, 0) + 0.2);
    const quiet = loop.pump(1);
    assert(quiet.frames <= 13, `ambient once it stands in the yard (${quiet.frames} frames in 1 s)`);
    const at = v.aimPoint(to.x, to.y, A, 120);
    v.click(at.x, at.y);
    eq(v.log.opened, [A], 'and it opens where it came to rest');
    v.village.destroy();
  });
});

// ---------- the graveyard's ghosts, and the night lighting ----------

// The graveyard's ghosts and the night lighting are drawn through geometrySpy, so a check reads what is painted
// rather than what the constants promise.
function paintedShapes(rows, { reduce = true, dark = false, seconds = 1, settle = 0.3, mode, island, open, visitors = null, hover = null, privacy = false, select = null, aim = null, theme } = {}) {
  const shapes = [];
  const state = { frames: 0, texts: [], islands: [], scenes: [], hovered: null };
  try {
    withFrameLoop((loop) => {
      reduceMotion = reduce;
      darkMode = dark;
      const listeners = new Map();
      const canvas = {
        width: 0, height: 0, style: {}, getContext: () => geometrySpy(shapes),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }),
        addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener() {},
      };
      const village = V.createVillage(canvas, {
        mode, island, theme, onIsland: (r) => state.islands.push(r), onScene: (s) => state.scenes.push(s),
        onHover: (id) => { state.hovered = id; },
      });
      village.resize();
      village.start();
      village.update(board(rows, visitors), { privacy });
      if (open !== undefined) village.openIsland(open);
      // Through the village's own call, so the hovered frame is the frame the page would get.
      if (hover) village.showVisitor(hover);
      if (select) village.setSelected(select);
      // A pointer swept up from a row's feet until the village reports that row hovered, and left there.
      if (aim) {
        const slot = V.layoutVillage(rows).get(aim);
        const move = listeners.get('pointermove');
        for (let k = 0; k <= 160 && state.hovered !== aim; k += 2) {
          move({ clientX: slot.x, clientY: slot.y - k, button: 0, isPrimary: true, pointerType: 'mouse' });
        }
        assert(state.hovered === aim, `the pointer could not hover ${aim}`);
      }
      // Reduced motion draws only on demand, so what this first pump paints is all there will be.
      loop.pump(settle);
      state.frames = loop.pump(seconds).frames;
      state.scene = village.getScene();
      state.island = village.getIsland();
      state.islandList = village.islands();
      village.destroy();
    });
  } finally {
    // In a finally, so one failing check cannot leave every later one running at dusk.
    reduceMotion = true;
    darkMode = false;
  }
  return { shapes, ...state };
}

// THEMES stays inside the village, so the colours a check needs are written out here: day, then dusk.
const GHOST_RGB = { day: '236, 241, 248', dusk: '214, 226, 240' };
const GRASS_HEX = { day: '#b8caa1', dusk: '#2d3b32' };
const WINDOW_LIT = { day: '#f6e0a6', dusk: '#f3d690' };

// One frame's shapes. `draw` clears the canvas with the theme's grass at the identity transform, so that
// full-canvas fill is where each frame begins, and a check that counts what is drawn needs exactly one of them.
function lastFrame(shapes, theme = 'day', clear = null) {
  const hex = clear || GRASS_HEX[theme];
  let start = 0;
  shapes.forEach((s, i) => {
    if (s.kind === 'fill' && s.style === hex
      && s.box[0] === 0 && s.box[1] === 0 && s.box[2] === 1600 && s.box[3] === 900) start = i;
  });
  return shapes.slice(start);
}

// The world map has no painted background layer in the harness (no document, so no offscreen canvas), so draw()
// clears it with the deep water instead of the grass.
const WORLD_WATER_HEX = { day: '#91b9c0', dusk: '#1d313c' };

const graveRows = (n) => Array.from({ length: n }, (_, i) => row(`local_22222222-0000-4000-8000-${String(i).padStart(12, '0')}`, 'graveyard'));
const ghostBodies = (shapes, theme = 'day') => shapes.filter((s) => s.kind === 'fill'
  && typeof s.style === 'string' && s.style.startsWith(`rgba(${GHOST_RGB[theme]}`));
// Every road as the band that is drawn: padded across its own line only, the way the surface is painted.
const roadBands = V.ROAD_LINES.map(([[x0, y0], [x1, y1]]) => {
  const half = V.ROAD_BAND / 2;
  return y0 === y1
    ? [Math.min(x0, x1), y0 - half, Math.abs(x1 - x0), V.ROAD_BAND]
    : [x0 - half, Math.min(y0, y1), V.ROAD_BAND, Math.abs(y1 - y0)];
});

check('an ent walks the ring the roads make round the workshop, on its roots, and stands still when asked', () => {
  for (const node of V.ENT_WALK_CIRCUIT) {
    assert(V.ROAD_NODES.some(([x, y]) => x === node.x && y === node.y),
      `the circuit turns at ${JSON.stringify(node)}, which is a road junction`);
  }
  const half = V.ROAD_BAND / 2;
  const onRoad = (x, y) => V.ROAD_LINES.some(([[x0, y0], [x1, y1]]) => {
    const vx = x1 - x0;
    const vy = y1 - y0;
    const k = Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / (vx * vx + vy * vy)));
    return Math.hypot(x - (x0 + vx * k), y - (y0 + vy * k)) <= half;
  });
  const [fl, ft, fr, fb] = V.ENT_WALK_FOOT;
  assert(Math.max(-fl, fr) < half, `the ent's roots (${fr - fl} across) fit the road band (${V.ROAD_BAND})`);
  const loop = V.ENT_WALK_CIRCUIT.reduce((sum, a, i) => {
    const b = V.ENT_WALK_CIRCUIT[(i + 1) % V.ENT_WALK_CIRCUIT.length];
    return sum + Math.hypot(b.x - a.x, b.y - a.y);
  }, 0);
  const period = loop / V.ENT_WALK_SPEED;
  let seen = 0;
  for (let t = 0; t <= period * 2; t += period / 900) {
    const e = V.walkingEntAt(t);
    assert(onRoad(e.x, e.y), `the ent stands off the road at t ${t.toFixed(2)}: ${e.x.toFixed(1)},${e.y.toFixed(1)}`);
    // Measured across the leg it is on, never along it, for the reason the horse's own check gives: two bands
    // meeting at a right angle leave the outer corner uncovered, so a box corner tested at a junction fails for
    // a walker of any size at all. Only the roots are tested: an ent walking the road towers over it the way a
    // session walking the road does, and nothing holds a walker's body to the band.
    for (const d of e.axis === 'x' ? [ft, fb] : [fl, fr]) {
      const p2 = e.axis === 'x' ? { x: e.x, y: e.y + d } : { x: e.x + d, y: e.y };
      assert(onRoad(p2.x, p2.y),
        `a root is off the road at t ${t.toFixed(2)}: ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`);
    }
    seen += 1;
  }
  assert(seen > 1000, 'the whole circuit was walked');
  assert(period > 60, `it goes at an ent's pace (${period.toFixed(0)} s a lap)`);

  const places = new Set();
  for (let t = 0; t <= period; t += period / 40) places.add(`${V.walkingEntAt(t).x.toFixed(0)},${V.walkingEntAt(t).y.toFixed(0)}`);
  assert(places.size > 30, `the ent gets round the circuit (${places.size} places)`);
  const still = new Set();
  for (let t = 0; t <= period; t += period / 40) still.add(`${V.walkingEntAt(t, true).x},${V.walkingEntAt(t, true).y}`);
  eq(still.size, 1, 'reduced motion holds it at one place');
  const rooted = new Set();
  for (let t = 0; t <= V.ENT_WALK_BEAT; t += V.ENT_WALK_BEAT / 20) rooted.add(V.entStride(t, true));
  eq([...rooted], [0], 'and its roots stay down');

  // It is a tree on a footing that moves, so the box that holds a standing ent holds this one too. Under reduced
  // motion it stands at the circuit's first node, which is in none of the eight boxes the standing ents take: a
  // tree colour in the frame whose centre is outside all of them is this one.
  const T = V.resolveTheme('shire', false);
  const inks = new Set([T.tree, T.treeDark, T.treeLight, T.trunk, T.moss]);
  const at = V.walkingEntAt(0, true);
  const box = V.treeBox([at.x, at.y, V.ENT_WALK_R]);
  const standing = V.TREES.map((tree) => V.treeBox(tree));
  const mine = lastFrame(paintedShapes([], { reduce: true, theme: 'shire' }).shapes).filter((sh) => {
    if (!inks.has(sh.style)) return false;
    const cx = (sh.box[0] + sh.box[2]) / 2;
    const cy = (sh.box[1] + sh.box[3]) / 2;
    return !standing.some(([bx, by, bw, bh]) => cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh);
  });
  assert(mine.length >= 8, `the walking ent is painted at all (${mine.length} shapes in the tree's own colours)`);
  for (const sh of mine) {
    const pad = sh.kind === 'stroke' ? sh.lw / 2 : 0;
    const out = Math.max(box[0] - (sh.box[0] - pad), (sh.box[2] + pad) - (box[0] + box[2]),
      box[1] - (sh.box[1] - pad), (sh.box[3] + pad) - (box[1] + box[3]));
    assert(out <= 0.01, `the walking ent paints ${out.toFixed(2)} px outside a tree's own box: ${JSON.stringify(sh.box.map((v) => Math.round(v * 10) / 10))}`);
  }
});

check('the grey pilgrim sets off fireworks at night, over open water, and they hold when asked', () => {
  const [sx, sy] = V.FIREWORK_FROM;
  // They leave from the head of his staff, which is inside the box he declares.
  const [gx, gy, gw, gh] = V.GUARD_BOX;
  assert(sx >= gx && sx <= gx + gw && sy >= gy && sy <= gy + gh,
    `the rockets leave from his staff ${JSON.stringify([sx, sy])}, inside ${JSON.stringify(V.GUARD_BOX)}`);

  const taken = { 'the harbour sign': V.signBox('harbour'), 'the guard': V.GUARD_BOX, 'the booth': V.BOOTH_BOX,
    'the barrier': V.BARRIER_BOX, 'the platform': V.PATROL_PLATFORM };
  assert(V.FIREWORKS.length >= 2, 'more than one goes up');
  for (const [i, f] of V.FIREWORKS.entries()) {
    const b = V.fireworkBox(f);
    assert(b[0] >= 0 && b[1] >= 0 && b[0] + b[2] <= 1600 && b[1] + b[3] <= 900, `firework ${i} is on the canvas`);
    // Over open water, so a burst never hangs over the deck, the queue or the land behind them.
    for (let y = b[1]; y <= b[1] + b[3]; y += 4) {
      assert(b[0] > V.shoreX(y), `firework ${i} hangs over the land at y ${y.toFixed(0)} (coast ${V.shoreX(y).toFixed(0)})`);
    }
    // Clear of the lantern on the point, which is the one thing up there at night that is not theirs.
    const [lx, ly, lw, lh] = V.LIGHTHOUSE.lantern;
    assert(!V.boxesOverlap(b, [lx - 24, ly - 20, lw + 48, lh + 120]), `firework ${i} covers the light on the point`);
    for (const [what, t] of Object.entries(taken)) {
      assert(!V.boxesOverlap(b, t), `firework ${i} ${JSON.stringify(b)} covers ${what} ${JSON.stringify(t)}`);
    }
  }

  // A whole cycle: it rises, it bursts, and there is a stretch with nothing in the sky.
  const f0 = V.FIREWORKS[0];
  let rising = 0;
  let bursting = 0;
  let dark = 0;
  for (let t = 0; t < V.FIREWORK_PERIOD; t += V.FIREWORK_PERIOD / 400) {
    const st = V.fireworkAt(t, false, f0);
    if (!st) dark += 1;
    else if (st.burst === 0) rising += 1;
    else bursting += 1;
    if (st) {
      assert(st.rise >= 0 && st.rise <= 1, `the rocket rises from 0 to 1 at t ${t.toFixed(2)} (${st.rise})`);
      assert(st.burst >= 0 && st.burst <= 1, `the burst opens from 0 to 1 at t ${t.toFixed(2)} (${st.burst})`);
    }
  }
  assert(rising > 20 && bursting > 20 && dark > 20, `it rises, bursts and rests (${rising}/${bursting}/${dark})`);
  // No two of them go up together, or it reads as one firework drawn twice.
  const phases = new Set(V.FIREWORKS.map((f) => f.phase));
  eq(phases.size, V.FIREWORKS.length, 'each goes up at its own moment');

  // Reduced motion holds every one of them open, rather than taking them away: still, not gone.
  for (const f of V.FIREWORKS) {
    const held = new Set();
    for (let t = 0; t < V.FIREWORK_PERIOD * 2; t += V.FIREWORK_PERIOD / 40) {
      const st = V.fireworkAt(t, true, f);
      assert(st, 'reduced motion never leaves the sky empty');
      held.add(`${st.rise},${st.burst}`);
    }
    eq(held.size, 1, 'and holds it at one pose');
  }

  // The same display is shown from inside the White Halls, through its two lancets. Each burst has to sit inside
  // the pane it is seen through: the draw clips to the lancet, which the spy cannot see, so a burst hung outside
  // one would be invisible on screen and invisible to every check as well.
  eq(V.HALL_FIREWORKS.length, V.HALL_WINDOWS.length, 'one through each window');
  const [bl, bt, bw, bh] = V.HALL_LANCET_BOX;
  for (const [i, f] of V.HALL_FIREWORKS.entries()) {
    assert(V.HALL_WINDOWS.includes(f.x), `hall firework ${i} is centred on a window (${f.x})`);
    const b = V.fireworkBox(f);
    assert(b[0] >= f.x + bl && b[0] + b[2] <= f.x + bl + bw && b[1] >= bt && b[1] + b[3] <= bt + bh,
      `hall firework ${i} ${JSON.stringify(b)} sits inside its own lancet ${JSON.stringify([f.x + bl, bt, bw, bh])}`);
  }
  eq(new Set(V.HALL_FIREWORKS.map((f) => f.phase)).size, V.HALL_FIREWORKS.length, 'and each goes up at its own moment');

  // Night only. Nothing of theirs is painted in the day, in either pack that has a barrier.
  const T = V.resolveTheme('shire', false);
  const sky = [V.fireworkBox(V.FIREWORKS[0]), V.fireworkBox(V.FIREWORKS[1])];
  for (const dark2 of [false, true]) {
    const lit = lastFrame(paintedShapes([], { reduce: true, dark: dark2, theme: 'shire' }).shapes, dark2 ? 'dusk' : 'day')
      .filter((sh) => (sh.style === T.flame || sh.style === T.flameCore || sh.style === V.resolveTheme('shire', true).flame
        || sh.style === V.resolveTheme('shire', true).flameCore)
        && sky.some(([bx, by, bw, bh]) => sh.box[0] >= bx && sh.box[2] <= bx + bw && sh.box[1] >= by && sh.box[3] <= by + bh));
    if (dark2) assert(lit.length >= 8, `they are painted at night (${lit.length} shapes)`);
    else eq(lit.length, 0, 'and nothing of them in the day');
  }
});

check('the spider keeps inside the lair\'s own plot all the way round, and holds still when asked', () => {
  const [px, py, pw, ph] = V.JAIL.plot;
  const loop = V.SPIDER_CIRCUIT.reduce((sum, a, i) => {
    const b = V.SPIDER_CIRCUIT[(i + 1) % V.SPIDER_CIRCUIT.length];
    return sum + Math.hypot(b.x - a.x, b.y - a.y);
  }, 0);
  const period = loop / V.SPIDER_SPEED;
  let seen = 0;
  for (let t = 0; t <= period * 2; t += period / 900) {
    const sp = V.spiderAt(t);
    assert(Math.abs(sp.dir) === 1, `the spider faces one way or the other at t ${t.toFixed(2)}`);
    assert(sp.x - V.SPIDER_REACH >= px && sp.x + V.SPIDER_REACH <= px + pw
      && sp.y - V.SPIDER_REACH >= py && sp.y + V.SPIDER_REACH <= py + ph,
      `the spider reaches outside the plot at t ${t.toFixed(2)}: ${sp.x.toFixed(1)},${sp.y.toFixed(1)}`);
    seen += 1;
  }
  assert(seen > 1000, 'the whole circuit was walked');

  const places = new Set();
  for (let t = 0; t <= period; t += period / 40) places.add(`${V.spiderAt(t).x.toFixed(0)},${V.spiderAt(t).y.toFixed(0)}`);
  assert(places.size > 30, `the spider gets round the circuit (${places.size} places)`);
  const still = new Set();
  for (let t = 0; t <= period; t += period / 40) still.add(`${V.spiderAt(t, true).x},${V.spiderAt(t, true).y}`);
  eq(still.size, 1, 'reduced motion holds it at one place');

  // And the reach is honest about the drawing. The lair's rock is painted in the same two colours, but that is in
  // the background layer, which this pass has no document to make: what is left in the plot is the spider.
  const T = V.resolveTheme('shire', false);
  const at = V.spiderAt(0, true);
  const mine = lastFrame(paintedShapes([], { reduce: true, theme: 'shire' }).shapes)
    .filter((sh) => (sh.style === T.towerStone || sh.style === T.towerEdge)
      && sh.box[0] >= px && sh.box[2] <= px + pw && sh.box[1] >= py && sh.box[3] <= py + ph);
  assert(mine.length >= 8, `the spider is painted at all (${mine.length} shapes in the tower's own stone)`);
  for (const sh of mine) {
    const out = Math.max(at.x - V.SPIDER_REACH - sh.box[0], sh.box[2] - (at.x + V.SPIDER_REACH),
      at.y - V.SPIDER_REACH - sh.box[1], sh.box[3] - (at.y + V.SPIDER_REACH));
    assert(out <= sh.lw / 2, `the spider paints ${out.toFixed(2)} px past its own reach: ${JSON.stringify(sh.box.map((v) => Math.round(v * 10) / 10))}`);
  }
});

check('gollum creeps inside the graveyard fence all the way round, and holds still when asked', () => {
  const [fx, fy, fw, fh] = V.GRAVEYARD.fence;
  // The rails are drawn 3 px either side of the fence's own lines, so the inside is that rect inset by 3.
  const inner = [fx + 3, fy + 3, fw - 6, fh - 6];
  const loop = V.GOLLUM_CIRCUIT.reduce((sum, a, i) => {
    const b = V.GOLLUM_CIRCUIT[(i + 1) % V.GOLLUM_CIRCUIT.length];
    return sum + Math.hypot(b.x - a.x, b.y - a.y);
  }, 0);
  const period = loop / V.GOLLUM_SPEED;
  let seen = 0;
  for (let t = 0; t <= period * 2; t += period / 900) {
    const g = V.gollumAt(t);
    assert(Math.abs(g.dir) === 1, `gollum faces one way or the other at t ${t.toFixed(2)}`);
    // A square reach rather than one measured across the leg: the circuit is a rectangle inside a rectangle, so
    // this is both simpler than the horse's road maths and stricter at every corner.
    assert(g.x - V.GOLLUM_REACH >= inner[0] && g.x + V.GOLLUM_REACH <= inner[0] + inner[2]
      && g.y - V.GOLLUM_REACH >= inner[1] && g.y + V.GOLLUM_REACH <= inner[1] + inner[3],
      `gollum reaches outside the fence at t ${t.toFixed(2)}: ${g.x.toFixed(1)},${g.y.toFixed(1)}`);
    seen += 1;
  }
  assert(seen > 1000, 'the whole circuit was walked');

  const places = new Set();
  for (let t = 0; t <= period; t += period / 40) places.add(`${V.gollumAt(t).x.toFixed(0)},${V.gollumAt(t).y.toFixed(0)}`);
  assert(places.size > 30, `gollum gets round the circuit (${places.size} places)`);
  const still = new Set();
  for (let t = 0; t <= period; t += period / 40) still.add(`${V.gollumAt(t, true).x},${V.gollumAt(t, true).y}`);
  eq(still.size, 1, 'reduced motion holds him at one place');

  // And the reach is honest about the drawing, not just about the circuit. Under reduced motion he stands at the
  // circuit's first node, so everything he paints there can be measured against it. The board is empty on
  // purpose: he is drawn whatever is on it, but what haunts the barrows is not, and the orcs' iron caps are the
  // same steel as his own skin, so with graves on the board they were being measured as him.
  const T = V.resolveTheme('shire', false);
  const at = V.gollumAt(0, true);
  const mine = lastFrame(paintedShapes([], { reduce: true, theme: 'shire' }).shapes)
    .filter((s) => (s.style === T.steel || s.style === T.flameCore)
      && s.box[0] >= inner[0] && s.box[2] <= inner[0] + inner[2]
      && s.box[1] >= inner[1] && s.box[3] <= inner[1] + inner[3]);
  assert(mine.length >= 8, `gollum is painted at all (${mine.length} shapes in the steel and the flame)`);
  for (const sh of mine) {
    const out = Math.max(at.x - V.GOLLUM_REACH - sh.box[0], sh.box[2] - (at.x + V.GOLLUM_REACH),
      at.y - V.GOLLUM_REACH - sh.box[1], sh.box[3] - (at.y + V.GOLLUM_REACH));
    assert(out <= sh.lw / 2, `gollum paints ${out.toFixed(2)} px past his own reach: ${JSON.stringify(sh.box.map((v) => Math.round(v * 10) / 10))}`);
  }
});

check('the graveyard decides how many ghosts float over it, from two to twelve', () => {
  eq([0, 1, 20, 60, 157, 400].map((n) => V.ghostCount(n)), [0, 2, 5, 8, 12, 12], 'the counts Charlie will see');
  eq(V.ghostCount(1), V.GHOST_MIN, 'one grave shows the floor');
  eq(V.GHOSTS.length, 12, 'twelve perches');
  eq(V.ghostCount(1e9), V.GHOSTS.length, 'and a graveyard cannot ask for a seventh');
  // Every step boundary, both sides, so a threshold cannot drift unnoticed.
  let last = V.GHOST_MIN;
  for (const step of V.GHOST_STEPS) {
    eq(V.ghostCount(step - 1), last, `${step - 1} graves`);
    eq(V.ghostCount(step), last + 1, `${step} graves`);
    last += 1;
  }
  for (let n = 1; n < 400; n++) {
    const here = V.ghostCount(n);
    assert(here >= V.ghostCount(n - 1) && here <= V.GHOSTS.length, `${n} graves is monotonic and capped (${here})`);
  }
  // A count that is not a count shows nothing rather than throwing or drawing a fraction of a ghost.
  for (const bad of [null, undefined, NaN, Infinity, -5, 0.5, '12', {}]) {
    const out = V.ghostCount(bad);
    assert(Number.isInteger(out) && out >= 0 && out <= V.GHOSTS.length, `${JSON.stringify(bad)} gives ${out}`);
  }
  eq(V.ghostsFor(157).length, 12, 'ghostsFor hands back that many perches');
  eq(V.ghostsFor(0), [], 'and none at all for an empty graveyard');
  eq(V.ghostsFor(400), V.GHOSTS.slice(0, 12), 'in perch order');
  eq(V.GHOST, V.GHOSTS[0], 'the first perch is the one a lone ghost always used');
  results.ghostCounts = Object.fromEntries([0, 1, 20, 60, 157, 400].map((n) => [n, V.ghostCount(n)]));
});

check('the graveyard ghost count reaches its new ceiling of twelve by about 160 graves', () => {
  eq(V.GHOSTS.length, 12, 'the raised maximum');
  eq(V.GHOST_STEPS.length, 10, 'ten steps above the floor of two reach twelve');
  for (const n of [155, 160, 165]) {
    const count = V.ghostCount(n);
    assert(count >= 10 && count <= 12, `${n} graves shows ${count} ghosts, wanted 10-12`);
  }
  eq(V.ghostCount(1e6), 12, 'nothing above the graveyard can ask for a thirteenth');
});

check('the disco ball and its lights are drawn in the sand castle hall at night, and only at night', () => {
  // The chain is a one-off literal colour nothing else in the hall paints, day or dusk, so its presence alone
  // proves whether drawDisco fired this frame without needing to unpick a gradient-filled light spot.
  const CHAIN = 'rgba(150, 150, 158, 0.8)';
  for (const [dark, wanted] of [[false, false], [true, true]]) {
    const shapes = [];
    withFrameLoop((loop) => {
      reduceMotion = true;
      darkMode = dark;
      const canvas = {
        width: 0, height: 0, style: {}, getContext: () => geometrySpy(shapes),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }),
        addEventListener() {}, removeEventListener() {},
      };
      const village = V.createVillage(canvas, {});
      village.resize();
      village.start();
      village.update(board([row(A, 'castle')]), { privacy: false });
      village.enterCastle();
      loop.pump(0.3);
      village.destroy();
    });
    reduceMotion = true;
    darkMode = false;
    const drawn = shapes.some((s) => s.kind === 'stroke' && s.style === CHAIN);
    eq(drawn, wanted, `${dark ? 'dusk' : 'day'}: the disco ball is ${wanted ? '' : 'not '}drawn`);
  }
});

check('every seat in the cottage room is hittable, at capacity', () => {
  const n = V.COTTAGE_SEAT_CAPACITY;
  const ids = Array.from({ length: n }, (_, i) => `local_c0ffeec0-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const rows = ids.map((id) => row(id, 'idle'));
  const seats = V.cottageSeatLayout(n).points;
  eq(seats.length, n, 'a seat per guest at capacity');
  const v = makeVillage({ reduce: true });
  v.village.update(board(rows), { privacy: false });
  v.village.enterCottages();
  seats.forEach((s, i) => {
    v.fire('pointermove', s.x, s.y);
    eq(v.hoveredId(), ids[i], `seat ${i} at ${s.x},${s.y} hovers its own guest`);
    v.click(s.x, s.y);
    eq(v.log.opened.at(-1), ids[i], `seat ${i} opens its own guest on click`);
  });
});

// The graveyard sign as painted: the arch, the board with its badge, count and "+N more", and the two hangers,
// which drawGraveyardSign paints in that order, arch first and hangers last. The arch is a curve, whose control
// point geometrySpy does not see, but its feet and apex lie inside the board and the hangers' span.
// The graveyard sign is picked out of a frame by the fence colour it hangs from, which each pack paints its own.
function graveSignShapes(frame, theme = 'day', pack = V.DEFAULT_THEME) {
  const dark = V.resolveTheme(pack, theme === 'dusk').fenceDark;
  const start = frame.findIndex((s) => s.kind === 'stroke' && s.style === dark && s.lw === 3);
  let hangers = 0;
  for (let i = start + 1; i < frame.length; i++) {
    if (frame[i].kind === 'stroke' && frame[i].style === dark && Math.abs(frame[i].lw - 1.5) < 1e-9 && ++hangers === 2) {
      return frame.slice(start, i + 1);
    }
  }
  throw new Error('no graveyard sign in the frame');
}
const boxOf = (shapes) => {
  const u = shapes.reduce((a, s) => [Math.min(a[0], s.box[0]), Math.min(a[1], s.box[1]), Math.max(a[2], s.box[2]), Math.max(a[3], s.box[3])],
    [Infinity, Infinity, -Infinity, -Infinity]);
  return [u[0], u[1], u[2] - u[0], u[3] - u[1]];
};
// The gap between two [x, y, w, h] boxes: the larger of the two axis gaps, negative when they overlap.
const gapOf = (a, b) => Math.max(b[0] - (a[0] + a[2]), a[0] - (b[0] + b[2]), b[1] - (a[1] + a[3]), a[1] - (b[1] + b[3]));

check('the ghosts float inside the graveyard fence, over the headstones, clear of its sign, the jail and each other', () => {
  const r1 = (b) => b.map((v) => Math.round(v * 10) / 10);
  const [fx, fy, fw, fh] = V.GRAVEYARD.fence;
  // Inside the fence as painted: its side posts are 6 wide on the fence line, its back posts reach down to fy + 28
  // and its front ones rise to fy + fh - 22.
  const inner = [fx + 3, fy + 28, fw - 6, fh - 22 - 28];
  // The sign Charlie's board shows, "+91 more" and all, read off the frame in both themes.
  const signs = ['day', 'dusk'].map((theme) => boxOf(graveSignShapes(
    lastFrame(paintedShapes(graveRows(123), { reduce: true, dark: theme === 'dusk' }).shapes, theme), theme)));
  eq(signs[0], signs[1], 'the sign is the same shape in both themes');
  const [sign] = signs;
  ghostSpans.forEach((span, i) => {
    const clear = (box, what) => {
      const gap = gapOf(span, box);
      assert(gap > 0, `ghost ${i} ${JSON.stringify(r1(span))} covers ${what} ${JSON.stringify(r1(box))}`);
    };
    assert(span[0] >= inner[0] && span[1] >= inner[1] && span[0] + span[2] <= inner[0] + inner[2]
      && span[1] + span[3] <= inner[1] + inner[3], `ghost ${i} ${JSON.stringify(r1(span))} floats inside the fence ${JSON.stringify(inner)}`);
    assert(span[0] >= fx && span[0] + span[2] <= fx + fw, `ghost ${i} never leaves the fence's x range`);
    clear(sign, 'the graveyard sign, its badge and its "+N more"');
    clear(V.JAIL.plot, "the jail's plot");
    // Over the headstones: every perch floats over at least one of them.
    assert(V.GRAVE_SLOTS.some((g) => V.boxesOverlap(span, [g.x - 12, g.y - 32, 24, 32])), `ghost ${i} floats over a headstone`);
    for (const place of Object.keys(V.PLACES)) clear(V.signBox(place), `the ${place} sign`);
    for (const spot of V.SPOT_KEYS) {
      for (const p of V.slotGrid(spot, 20).points) clear([p.x - 26, p.y - 102, 52, 107], `a ${spot} slot at ${JSON.stringify(p)}`);
    }
    for (const b of roadBands) clear(b, 'a road band');
    for (const tree of V.TREES) clear(V.treeBox(tree), `the tree at ${JSON.stringify(tree)}`);
    clear(V.COTTAGE.rect, 'the cottage');
  });
  ghostSpans.forEach((a, i) => ghostSpans.forEach((b, k) => {
    if (k <= i) return;
    const gap = gapOf(a, b);
    assert(gap > 0, `ghost ${i} ${JSON.stringify(r1(a))} touches ghost ${k} ${JSON.stringify(r1(b))}`);
  }));
  // Two ghosts is the commonest count, so those two are the pair that has to look spread rather than paired up.
  assert(Math.abs(V.GHOSTS[0].x - V.GHOSTS[1].x) > 200,
    `the first two perches are on the far sides of the graveyard (${V.GHOSTS[0].x} and ${V.GHOSTS[1].x})`);
});

check('a headstone under a ghost still hovers and clicks, since a ghost has no hit area', () => {
  const rows = graveRows(123);
  const graves = V.graveyardLayout(rows.map((r) => r.id));
  let tested = 0;
  for (const g of V.ghostsFor(rows.length)) {
    // The ghost's body at rest, where reduced motion holds it, and a headstone whose hit area lies under it.
    const body = [g.x - g.rx, g.y - g.ry, 2 * g.rx, 2 * g.ry];
    const under = [...graves].find(([, s]) => V.boxesOverlap(body, [s.x - 14, s.y - 36, 28, 40]));
    assert(under, `a headstone lies under the ghost at ${g.x},${g.y}`);
    const [id, s] = under;
    const x = Math.min(Math.max(g.x, s.x - 10), s.x + 10);
    const y = Math.min(Math.max(g.y, s.y - 30), s.y);
    assert(x >= body[0] && x <= body[0] + body[2] && y >= body[1] && y <= body[1] + body[3], `the point ${x},${y} is under the ghost's body`);
    const v = makeVillage();
    v.village.update(board(rows), { privacy: false });
    v.fire('pointermove', x, y);
    eq(v.hoveredId(), id, `the headstone at ${s.x},${s.y} under the ghost at ${g.x},${g.y} is hovered`);
    v.click(x, y);
    eq(v.log.opened, [id], 'and a click there opens it');
    v.village.destroy();
    tested += 1;
  }
  eq(tested, 11, 'every one of the eleven ghosts over a graveyard of 123');
});

check('the ghosts are drawn where their boxes say, bob on ambient frames alone, and hold still when asked', () => {
  // One grave is already two ghosts, and a full graveyard is twelve.
  for (const [graves, want] of [[1, 2], [20, 5], [60, 8], [157, 12]]) {
    const bodies = ghostBodies(lastFrame(paintedShapes(graveRows(graves), { reduce: true }).shapes));
    eq(bodies.length, want, `${graves} graves draws ${want} ghosts`);
    // Each body sits on its own perch, at the width that perch allows for.
    for (const g of V.ghostsFor(graves)) {
      const body = bodies.find((s) => Math.abs((s.box[0] + s.box[2]) / 2 - g.x) < 0.01);
      assert(body, `a ghost is drawn on the perch at ${g.x},${g.y}`);
      near((body.box[1] + body.box[3]) / 2, g.y, 0.01, `the perch at ${g.x} is drawn at its rest height`);
      near((body.box[2] - body.box[0]) / 2, g.rx, 0.01, `the perch at ${g.x} is drawn at its own size`);
    }
  }
  eq(ghostBodies(paintedShapes([row(A, 'running')], { reduce: true }).shapes).length, 0, 'no graves, no ghosts');
  // Over the headstones: translucent, and painted after every stone, in both themes.
  for (const [theme, stone] of [['day', '#c3bfb5'], ['dusk', '#69665f']]) {
    const frame = lastFrame(paintedShapes(graveRows(123), { reduce: true, dark: theme === 'dusk' }).shapes, theme);
    const lastStone = frame.reduce((at, s, i) => (s.kind === 'fill' && s.style === stone ? i : at), -1);
    const firstGhost = frame.findIndex((s) => ghostBodies([s], theme).length);
    assert(lastStone > 0 && firstGhost > lastStone, `${theme}: the ghosts are painted over the headstones (${firstGhost} after ${lastStone})`);
    for (const s of ghostBodies(frame, theme)) {
      const alpha = Number(/, ([\d.]+)\)$/.exec(s.style)[1]);
      assert(alpha > 0.4 && alpha < 0.8, `${theme}: a ghost is translucent (${s.style})`);
    }
  }

  // Bobbing: twelve ghosts moving, at no more than the ambient rate, each at a height of its own, and every part of
  // each of them inside its own perch's box over every frame.
  const moving = paintedShapes(graveRows(157), { reduce: false, seconds: 1 });
  assert(moving.frames <= 13, `twelve ghosts never raise the frame rate (${moving.frames} frames in 1 s)`);
  const heights = new Set(ghostBodies(moving.shapes).map((s) => Math.round((s.box[1] + s.box[3]) * 5)));
  assert(heights.size >= 12, `they bob on the ambient frames they are drawn on (${heights.size} heights)`);
  for (const s of ghostBodies(moving.shapes)) {
    const mid = [(s.box[0] + s.box[2]) / 2, (s.box[1] + s.box[3]) / 2];
    const span = ghostSpans.find((b) => mid[0] >= b[0] && mid[0] <= b[0] + b[2] && mid[1] >= b[1] && mid[1] <= b[1] + b[3]);
    assert(span && s.box[0] >= span[0] - 1e-6 && s.box[1] >= span[1] - 1e-6
      && s.box[2] <= span[0] + span[2] + 1e-6 && s.box[3] <= span[1] + span[3] + 1e-6,
    `every part of a ghost is inside its own box (${JSON.stringify(s.box.map(Math.round))})`);
  }
  for (const g of V.GHOSTS) {
    const bobs = Math.abs(V.ghostAt(g.period / 4 - g.phase, false, g).y - V.ghostAt((3 * g.period) / 4 - g.phase, false, g).y);
    const sways = Math.abs(V.ghostAt(g.swayPeriod / 4 - g.phase, false, g).x - V.ghostAt((3 * g.swayPeriod) / 4 - g.phase, false, g).x);
    near(bobs, 2 * g.bob, 1e-9, `the perch at ${g.x} bobs its whole amplitude`);
    near(sways, 2 * g.sway, 1e-9, `and sways its whole amplitude`);
    eq(V.ghostAt(0, true, g), { x: g.x, y: g.y }, `reduced motion holds the perch at ${g.x} at rest`);
    eq(V.ghostBox(0, true, g), V.ghostBox(93.7, true, g), 'so its box never moves');
  }
  // No two perches share a period, so they never bob in lockstep.
  eq(new Set(V.GHOSTS.map((g) => g.period)).size, V.GHOSTS.length, 'every perch has a clock of its own');

  // Readable over what they float over in both themes: THEMES.ghost, outlined in THEMES.slate, over the graveyard's
  // own grass and over a headstone.
  for (const [theme, fill, edge, grass, stone] of [['day', '#ecf1f8', '#7c8a96', '#adbf98', '#c3bfb5'], ['dusk', '#d6e2f0', '#56616b', '#29362d', '#69665f']]) {
    const drawn = lastFrame(paintedShapes(graveRows(157), { reduce: true, dark: theme === 'dusk' }).shapes, theme);
    const fills = new Set(ghostBodies(drawn, theme).map((s) => s.style));
    assert(fills.size && [...fills].every((s) => new RegExp(`^rgba\\(${GHOST_RGB[theme]}, [\\d.]+\\)$`).test(s)),
      `${theme}: every ghost is drawn in its theme's ghost colour (${[...fills]})`);
    const outline = drawn.filter((s) => s.kind === 'stroke' && s.style === edge
      && s.box[0] >= ghostSpan[0] && s.box[2] <= ghostSpan[0] + ghostSpan[2]
      && s.box[1] >= ghostSpan[1] && s.box[3] <= ghostSpan[1] + ghostSpan[3]);
    eq(outline.length, 12, `${theme}: all twelve are outlined in its theme slate`);
    for (const [what, under] of [['grass', grass], ['headstones', stone]]) {
      const over = Math.max(de00(fill, under), de00(edge, under));
      assert(over >= 20, `${theme}: the ghosts read against the graveyard's ${what} (${over.toFixed(1)})`);
    }
    assert(de00(fill, edge) >= 20, `${theme}: their outline reads against their bodies (${de00(fill, edge).toFixed(1)})`);
  }
  // The jail's bars have to read on the yard's earth in both themes too: THEMES.steel over THEMES.pathEdge.
  for (const [theme, steel, earth] of [['day', '#8a9096', '#cfc1a2'], ['dusk', '#747a80', '#3e3a33']]) {
    assert(de00(steel, earth) >= 20, `${theme}: the jail's bars read on the yard (${de00(steel, earth).toFixed(1)})`);
  }
});

// ---------- painted places: nothing a place draws reaches another place or the road ----------

// Every check above that keeps places apart compares slots or character boxes, and a swing frame is neither: it
// stood 102 px tall over the Porch's back row, across the road and into the graveyard fence, with every one of
// them green. These read what is painted instead. A place's footprint is every shape a frame gains when that
// place has rows, against the same frame with none, over every frame of some motion (the swings rock, the ghosts
// bob, a Blocked hops and its light pulses, smoke rises), plus what it paints whatever its rows: its sign, read off
// the empty frame, and for the graveyard its fence and plot, read off the background layer. The road is read off
// that layer too, as the bands its edge strokes paint.
const PAINT_PLACES = {
  porch: ['needs_you', 'your_turn', 'errored', 'stopped'], workshop: ['running'], harbour: ['open_pr'],
  beach: ['valhalla'], jail: ['jail'], graveyard: ['graveyard'], cottages: ['idle', 'recent'], castle: ['castle'],
};
const PAINT_COUNTS = [1, 5, 13, 20, 30];
const r2 = (n) => Math.round(n * 100) / 100;
// Tall with a hat, round with a hat and square with a hat: the tallest and the widest a character is drawn.
const PAINT_LOOKS = [5, 6, 7];
// The graveyard's own colours, per pack and time of day: it is found by them rather than by the ground it is on.
const fenceStyles = (pack, dark) => {
  const T = V.resolveTheme(pack, dark);
  return [T.graveGrass, T.fence, T.fenceDark];
};
// What the other places paint into the background layer, taken as the layer's shapes that lie inside the ground each
// one is built on: the Porch's house and lantern, the Workshop's shed, the jail's plot, the cottage, the castle, and
// the Harbour's deck, pier and lighthouse. The graveyard is taken by its fence's own colours instead.
const GROUNDS = {
  porch: V.PORCH_OBSTACLES, workshop: [[472, 340, 700, 198]], jail: [V.JAIL.plot], cottages: [V.COTTAGE.rect],
  castle: [V.CASTLE.rect],
  harbour: [V.HARBOUR_DECK, [V.PIER.x - V.PIER.half, V.PIER.top, 2 * V.PIER.half, V.PIER.tip - V.PIER.top], [1494, 52, 106, 136]],
};
// Every row at 1.5x, and every Blocked escalated, so its light column widens and it hops.
const paintRows = (lanes, n, repo, tag) => Array.from({ length: n }, (_, i) => row(
  `local_${tag.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`, lanes[i % lanes.length],
  { tokens: MAX_TOKENS, look: PAINT_LOOKS[i % PAINT_LOOKS.length], since: Date.now() - 20 * 60_000, repo }));
// The island these checks sail into, and the one row that keeps it on the map when the place under test is empty.
// That row is idle, so it is inside the cottage; the cottages themselves are anchored by a castle row instead.
const PAINT_ISLE = 'isle';
const anchorRows = (place, island) => (island
  ? [row('local_77777777-0000-4000-8000-000000000000', place === 'cottages' ? 'castle' : 'idle', { repo: PAINT_ISLE })] : []);
// A shape as a comparable key. The spy carries lineWidth across save and restore, so a fill's recorded width is
// whatever was stroked before it: only a stroke's width is part of what it paints.
const paintKey = (s) => `${s.kind}|${String(s.style)}|${s.box.map((v) => Math.round(v * 100) / 100).join(',')}|${Math.round(s.alpha * 1000)}|${s.kind === 'stroke' ? s.lw : ''}`;
// What a shape covers as [x, y, w, h]: a stroke paints half its width either side of its path.
const paintedBox = (s) => {
  const h = s.kind === 'stroke' ? (s.lw || 1) / 2 : 0;
  return [s.box[0] - h, s.box[1] - h, s.box[2] - s.box[0] + 2 * h, s.box[3] - s.box[1] + 2 * h];
};
// The frames of `seconds` of motion, each as its list of shapes. Smoke and sparks draw from Math.random, which is
// seeded here so the figures these checks report are the same on every run. With `bg`, the offscreen background
// layer is painted through the spy into it instead, which needs a document to create that layer.
function paintFrames(rows, { dark = false, island = false, seconds = 2, bg = null, pack = V.DEFAULT_THEME } = {}) {
  const shapes = [];
  const random = Math.random;
  const hadDocument = 'document' in globalThis;
  const priorDocument = globalThis.document;
  Math.random = seeded(20260918);
  try {
    withFrameLoop((loop) => {
      reduceMotion = false;
      darkMode = dark;
      if (bg) {
        globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {},
          createElement: () => ({ width: 0, height: 0, getContext: () => geometrySpy(bg) }) };
      }
      const canvas = {
        width: 0, height: 0, style: {}, getContext: () => geometrySpy(shapes),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }),
        addEventListener() {}, removeEventListener() {},
      };
      const village = V.createVillage(canvas, { mode: island ? 'world' : 'village', theme: pack });
      village.resize();
      village.start();
      village.update(board(rows), { privacy: false });
      if (island) village.openIsland(PAINT_ISLE);
      loop.pump(0.3);
      shapes.length = 0;
      loop.pump(seconds);
      village.destroy();
    });
  } finally {
    Math.random = random;
    reduceMotion = true;
    darkMode = false;
    if (bg && hadDocument) globalThis.document = priorDocument;
    else if (bg) delete globalThis.document;
  }
  const grass = V.resolveTheme(pack, dark).grass;
  const frames = [];
  for (const s of shapes) {
    if (s.kind === 'fill' && s.style === grass && s.box[0] === 0 && s.box[1] === 0 && s.box[2] === 1600 && s.box[3] === 900) frames.push([]);
    else if (frames.length) frames[frames.length - 1].push(s);
  }
  return frames;
}
// The whole-canvas orange ring the page draws while anything is blocked belongs to no place.
const isEdgeRing = (s) => s.kind === 'stroke' && s.box[0] < 8 && s.box[1] < 8 && s.box[2] > 1592 && s.box[3] > 892;
const paintCache = new Map();
function paintedScene(theme, island, pack = V.DEFAULT_THEME) {
  const at = `${pack}|${theme}|${island}`;
  if (paintCache.has(at)) return paintCache.get(at);
  const dark = theme === 'dusk';
  const bg = [];
  paintFrames([], { dark, bg, seconds: 0.1, pack });
  const roads = bg.filter((s) => s.kind === 'stroke' && s.lw === V.ROAD_BAND).map((s) => {
    const [x0, y0, x1, y1] = s.box;
    const h = s.lw / 2;
    return y0 === y1 ? [x0, y0 - h, x1 - x0, s.lw] : [x0 - h, y0, s.lw, y1 - y0];
  });
  const fence = bg.filter((s) => fenceStyles(pack, dark).includes(s.style));
  // One baseline per anchor, as a multiset of keys per frame.
  const baselines = new Map();
  const baseline = (place) => {
    const anchor = anchorRows(place, island);
    const id = anchor.length ? anchor[0].lane : '';
    if (!baselines.has(id)) {
      const frames = paintFrames(anchor, { dark, island, pack });
      baselines.set(id, frames.map((f) => {
        const m = new Map();
        for (const s of f) m.set(paintKey(s), (m.get(paintKey(s)) || 0) + 1);
        return m;
      }));
      baselines.set(`${id}:last`, frames[frames.length - 1]);
    }
    return { frames: baselines.get(id), last: baselines.get(`${id}:last`) };
  };
  // Footprint of `rows` over the anchor's baseline: the shapes it adds, each once.
  const footprint = (place, rows) => {
    const base = baseline(place);
    const frames = paintFrames([...anchorRows(place, island), ...rows], { dark, island, pack });
    assert(frames.length === base.frames.length, `${theme} ${island ? 'island' : 'village'} ${place}: ${frames.length} frames against ${base.frames.length}`);
    const out = new Map();
    frames.forEach((f, i) => {
      const left = new Map(base.frames[i]);
      for (const s of f) {
        const k = paintKey(s);
        const n = left.get(k) || 0;
        if (n > 0) left.set(k, n - 1);
        else if (!isEdgeRing(s)) out.set(k, s);
      }
    });
    return [...out.values()];
  };
  const places = {};
  for (const [place, lanes] of Object.entries(PAINT_PLACES)) {
    const shapes = new Map();
    // Keyed by what it covers: two shapes painting the same box are one box to keep clear.
    const add = (s, n) => {
      const box = paintedBox(s);
      const k = box.map(r2).join(',');
      if (!shapes.has(k)) shapes.set(k, { s, n, box });
    };
    for (const n of PAINT_COUNTS) for (const s of footprint(place, paintRows(lanes, n, PAINT_ISLE, '9'))) add(s, n);
    // What it paints whatever its rows: its sign, read off the empty frame, and its ground, off the background.
    const empty = baseline(place).last;
    const within = (b, [bx, by, bw, bh]) => b[0] >= bx - 2 && b[1] >= by - 2 && b[2] <= bx + bw + 2 && b[3] <= by + bh + 2;
    if (place === 'graveyard') {
      for (const s of graveSignShapes(empty, theme, pack)) add(s, 0);
      for (const s of fence) add(s, 'ground');
    } else if (V.PLACES[place]) {
      const [x, y, w, h] = V.signBox(place);
      const [cx, cy] = V.PLACES[place].sign;
      for (const s of empty) if (within(s.box, [x, y, w, h]) || within(s.box, [cx - 3.5, cy + 23, 7, 26])) add(s, 0);
    }
    for (const s of bg) if ((GROUNDS[place] || []).some((g) => within(s.box, g))) add(s, 'ground');
    places[place] = [...shapes.values()];
  }
  const out = { roads, fence, places, footprint };
  paintCache.set(at, out);
  return out;
}

// Where what a place paints for its rows and its sign already reached a road before this check existed, as the
// deepest it goes in, px, keyed by the road's index in ROAD_LINES. Nothing else may reach one at all, and the Porch
// never. The harbour queue stands on the deck the y 320 road runs onto, and from 13 queued its westmost shadows reach
// past the deck's end. The Workshop's back row, where a lone session stands, grows its badge up across the y 320 road
// at 1.5x, its sign's post and badge stand in that road's edge, and from 13 running its eastmost seat reaches the
// x 1174 road. Held at what they measure, so none of them can grow unnoticed.
// A place's ground is left out of this: a building's eaves over the road beside it, or a fence's feet on the road's
// edge, is the layout itself.
const ROAD_CONTACTS = { harbour: { 1: 10 }, workshop: { 1: 26.05, 3: 15.39 } };

const overlapDepth = (a, b) => Math.min(Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]),
  Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
// Thousands of boxes a place, so pairs are only compared where a 40 px grid puts them in the same cell.
const GRID = 40;
function gridOf(items) {
  const cells = new Map();
  for (const it of items) {
    const [x, y, w, h] = it.box;
    for (let gx = Math.floor(x / GRID); gx <= Math.floor((x + w) / GRID); gx++) {
      for (let gy = Math.floor(y / GRID); gy <= Math.floor((y + h) / GRID); gy++) {
        const k = `${gx},${gy}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(it);
      }
    }
  }
  return cells;
}
// Every item of `items` that `box` overlaps, through a grid from gridOf.
function nearBox(cells, box) {
  const [x, y, w, h] = box;
  const out = new Set();
  for (let gx = Math.floor(x / GRID); gx <= Math.floor((x + w) / GRID); gx++) {
    for (let gy = Math.floor(y / GRID); gy <= Math.floor((y + h) / GRID); gy++) {
      for (const it of cells.get(`${gx},${gy}`) || []) out.add(it);
    }
  }
  return out;
}

// The smallest gap between any box of `a` and any of `b`, looked for within `reach` px.
function nearestGap(a, b, reach = 120) {
  const cells = gridOf(b);
  let best = Infinity;
  for (const p of a) {
    const [x, y, w, h] = p.box;
    for (const q of nearBox(cells, [x - reach, y - reach, w + 2 * reach, h + 2 * reach])) best = Math.min(best, gapOf(p.box, q.box));
  }
  return best;
}

// How far what a place paints already reaches past the ground it declares, px, before this check existed. A shape
// that escapes its ground is invisible to the overlap check above, which only ever attributes a shape that is
// wholly inside one: that is the gap a reskin could walk straight through.
// How far what a place paints already reached past the ground it declares, px, before this check existed: an
// outline drawn on the edge itself, the Workshop's posts standing below its deck, the Harbour's lighthouse rocks.
// Held at what they measure, in every pack, so nothing can grow past them unnoticed and no reskin can drift out.
const GROUND_ESCAPES = { porch: 1, workshop: 4, jail: 2.6, cottages: 4.5, castle: 1.08, harbour: 12 };

check('what a place paints into the background stays on the ground it declares, in every theme pack', () => {
  const measured = {};
  for (const pack of V.THEME_KEYS) {
    for (const dark of [false, true]) {
      const label = `${pack} ${dark ? 'dusk' : 'day'}`;
      const bg = [];
      paintFrames([], { dark, bg, seconds: 0.1, pack });
      // The terrain wash: ground, track, flats and the tufts and flowers scattered over them. It sweeps across
      // every one of these boxes and belongs to none of them, so a place is judged on what it builds, not what it
      // stands on.
      const T = V.resolveTheme(pack, dark);
      const terrain = new Set([...T.flowers, ...[
        'grass', 'grassLight', 'grassDark', 'tuft', 'path', 'pathEdge', 'pebble', 'sand', 'sandLight', 'sandWet',
        'sandDot', 'dune', 'water', 'waterDeep', 'ripple', 'shallow', 'foam', 'graveGrass', 'shadow',
        // Planting belongs to no place either: a flower bed sits across the Porch's ground and the trees have
        // their own box check above.
        'tree', 'treeDark', 'treeLight', 'trunk',
      ].map((k) => T[k])]);
      for (const [place, grounds] of Object.entries(GROUNDS)) {
        let seen = 0;
        for (const [gx, gy, gw, gh] of grounds) {
          // Attributed by its centre, and only shapes no bigger than the ground itself: the sea, the roads and the
          // ground wash all sweep across these boxes and belong to none of them. The limit of attributing by the
          // centre: a shape moved clear off its ground belongs to no place and so is checked against none. This
          // catches a place growing past its footing, which is what a reskin does; it does not catch one part of a
          // building being moved somewhere else entirely, which the eye does.
          const mine = bg.filter((sh) => {
            if (terrain.has(sh.style)) return false;
            const [x0, y0, x1, y1] = sh.box;
            const cx = (x0 + x1) / 2;
            const cy = (y0 + y1) / 2;
            return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh
              && x1 - x0 <= gw * 1.2 && y1 - y0 <= gh * 1.2;
          });
          seen += mine.length;
          for (const sh of mine) {
            const pad = sh.kind === 'stroke' ? sh.lw / 2 : 0;
            const out = Math.max(gx - (sh.box[0] - pad), (sh.box[2] + pad) - (gx + gw),
              gy - (sh.box[1] - pad), (sh.box[3] + pad) - (gy + gh));
            if (out > 0) measured[`${pack}/${place}`] = Math.max(measured[`${pack}/${place}`] || 0, +out.toFixed(2));
            const allowed = GROUND_ESCAPES[place] || 0;
            assert(out <= allowed + 1e-6,
              `${label}: the ${place} paints ${sh.kind} ${String(sh.style)} ${JSON.stringify(sh.box.map(r2))} ${out.toFixed(2)} px off its ground ${JSON.stringify([gx, gy, gw, gh])}, ${allowed} allowed`);
          }
        }
        assert(seen > 0, `${label}: the ${place} paints something on its own ground`);
      }
    }
  }
  // The green village is held to exactly what it measured, so its own figures cannot drift unnoticed. Every other
  // pack is held to no further than that: a reskin that reaches less far off its ground than the shape it replaces
  // is strictly safer, and a white tower that stops short of a sand castle's spill should not have to be widened
  // to satisfy a check.
  for (const [place, allowed] of Object.entries(GROUND_ESCAPES)) {
    eq(measured[`${V.DEFAULT_THEME}/${place}`], allowed, `the ${place} still reaches exactly as far off its ground as it did`);
    for (const pack of V.THEME_KEYS) {
      const got = measured[`${pack}/${place}`] || 0;
      assert(got <= allowed + 1e-6, `${pack}: the ${place} reaches ${got} px off its ground, past the ${allowed} the green village does`);
    }
  }
});

check('what a place paints stays out of every other place and off the road: 0 to 30 rows at 1.5x, every theme pack, both schemes, one village and an island', () => {
  const measured = {};
  for (const pack of V.THEME_KEYS) {
  for (const theme of ['day', 'dusk']) {
    for (const island of [false, true]) {
      const label = `${pack}, ${theme}, ${island ? 'inside an island' : 'one village'}`;
      const { roads, places, footprint } = paintedScene(theme, island, pack);
      eq(roads.length, V.ROAD_LINES.length, `${label}: every road is read off the painted layer`);
      // No rows, nothing painted: the empty board is its own baseline, so 0 rows adds no shape to any place, and a
      // place at 0 is its sign alone, which is in `places` below.
      for (const name of Object.keys(PAINT_PLACES)) eq(footprint(name, []).length, 0, `${label}: the ${name} at 0 rows paints nothing past its sign`);
      const names = Object.keys(places);
      for (const name of names) assert(places[name].length > 0, `${label}: the ${name} paints something`);
      const grids = Object.fromEntries(names.map((name) => [name, gridOf(places[name])]));
      names.forEach((a, i) => names.forEach((b, k) => {
        if (k <= i) return;
        for (const p of places[a]) {
          for (const q of nearBox(grids[b], p.box)) {
            const depth = overlapDepth(p.box, q.box);
            assert(depth <= 0, `${label}: the ${a} at ${p.n} rows paints ${p.s.kind} ${String(p.s.style)} ${JSON.stringify(p.box.map(r2))} into the ${b} at ${q.n} (${q.s.kind} ${String(q.s.style)} ${JSON.stringify(q.box.map(r2))}), ${depth.toFixed(2)} px`);
          }
        }
      }));
      for (const name of names) {
        roads.forEach((r, ri) => {
          const depth = Math.max(0, ...places[name].filter((p) => p.n !== 'ground').map((p) => overlapDepth(p.box, r)));
          const allowed = (ROAD_CONTACTS[name] || {})[ri] || 0;
          assert(depth <= allowed + 1e-6, `${label}: the ${name} reaches ${depth.toFixed(2)} px into the road ${JSON.stringify(V.ROAD_LINES[ri])}, ${allowed} allowed`);
          // Recorded for the green village alone. A pack may reach less far into a road, never further, which is
          // what the inequality above holds every pack to.
          if (allowed && pack === V.DEFAULT_THEME) measured[`${name}/road${ri}`] = Math.max(measured[`${name}/road${ri}`] || 0, +depth.toFixed(2));
        });
      }
      // The Porch, which is where this came from: every shape it paints is below the road's lower edge.
      const roadFoot = V.ROAD_LINES[0][0][1] + V.ROAD_BAND / 2;
      const top = Math.min(...places.porch.map((p) => p.box[1]));
      assert(top > roadFoot, `${label}: the Porch paints up to y ${top.toFixed(2)}, over the road's edge at ${roadFoot}`);
      assert(top >= V.PORCH_CEILING - 1e-6, `${label}: nothing on the Porch rises above PORCH_CEILING (${top.toFixed(2)})`);
      const gap = nearestGap(places.porch, places.graveyard);
      measured[`${pack}|${theme}|${island ? 'island' : 'village'}`] = { porchTop: +top.toFixed(2), porchToRoad: +(top - roadFoot).toFixed(2), porchToGraveyard: +gap.toFixed(2) };
    }
  }
  }
  // Paint is geometry, and a pack is paint: every pack, both schemes and both maps put every place in exactly
  // the same spot. This is the whole reason a frontier town could be laid over a village with a large geometry
  // suite without moving a single crowd, sign or clickable door.
  const figures = Object.entries(measured).filter(([k]) => k.includes('|')).map(([, v]) => JSON.stringify(v));
  eq(new Set(figures).size, 1, `the same clearances in every pack, both schemes and both maps (${figures.join(' ')})`);
  for (const [name, roads] of Object.entries(ROAD_CONTACTS)) {
    for (const [ri, allowed] of Object.entries(roads)) eq(measured[`${name}/road${ri}`], allowed, `the ${name} still reaches exactly as far into road ${ri} as it did`);
  }
});

check('the merged Porch as painted keeps below the road and off the graveyard in every lane mix from 0 to 30', () => {
  // A spot's slots depend on its own count alone, the Porch's cap only falls as rows join it, a plate only narrows
  // as neighbours join its row, and the light is only ever clipped by the swings: so each spot painted alone, at
  // every count from 1 to 30, is the most it can paint in any mix. Stopped and errored share the steps, so each is
  // painted over every step slot.
  const { roads, places, footprint } = paintedScene('day', false);
  const roadFoot = V.ROAD_LINES[0][0][1] + V.ROAD_BAND / 2;
  const others = gridOf(Object.entries(places).filter(([name]) => name !== 'porch').flatMap(([name, list]) => list.map((p) => ({ ...p, name }))));
  for (const lanes of [['needs_you'], ['your_turn'], ['errored'], ['stopped']]) {
    for (let n = 1; n <= 30; n++) {
      for (const s of footprint('porch', paintRows(lanes, n, PAINT_ISLE, '6'))) {
        const box = paintedBox(s);
        const what = `${n} ${lanes[0]}: ${s.kind} ${String(s.style)} ${JSON.stringify(box.map(r2))}`;
        assert(box[1] > roadFoot, `${what} reaches the road`);
        // The canvas edge takes the touch a crowd's cap already allows (CLASH_TOLERANCE): the steps' stool at x 30.
        const tol = V.CLASH_TOLERANCE;
        assert(box[0] >= -tol && box[0] + box[2] <= V.LOGICAL_WIDTH + tol && box[1] + box[3] <= V.LOGICAL_HEIGHT + tol, `${what} leaves the canvas`);
        for (const r of roads) assert(overlapDepth(box, r) <= 0, `${what} is on the road ${JSON.stringify(r)}`);
        for (const q of nearBox(others, box)) assert(overlapDepth(box, q.box) <= 0, `${what} is on the ${q.name} (${JSON.stringify(q.box.map(r2))})`);
      }
    }
  }
});

// drawPlate's own fill, per theme (village.js THEMES): what tells a plate from a sign board, which has its own.
const PLATE_BG = { day: 'rgba(255, 255, 255, 0.96)', dusk: 'rgba(33, 37, 41, 0.95)' };
// A plate as painted: its fill, the border stroked round it (1.5 wide when emphasised) and its shadow, 1 right and
// 2.5 down.
const platePainted = (s) => [s.box[0] - 0.75, s.box[1] - 0.75, s.box[2] - s.box[0] + 1.75, s.box[3] - s.box[1] + 3.25];

check('no Porch plate is painted over the Porch sign: a lone Blocked, 1 to 8 of them, every mix, selected and hovered', () => {
  const title = 'Fix the loyalty points expiry calculation for every market at once';
  const [sx, sy, sw, sh] = V.signBox('porch');
  let gap = Infinity;
  let plates = 0;
  for (const theme of ['day', 'dusk']) {
    const dark = theme === 'dusk';
    // The sign as painted on the empty board: its board, border, shadow and words, all within its declared box.
    const empty = lastFrame(paintedShapes([], { dark }).shapes, theme);
    const signShapes = empty.filter((s) => s.box[0] >= sx - 4 && s.box[1] >= sy - 4 && s.box[2] <= sx + sw + 4 && s.box[3] <= sy + sh + 4);
    assert(signShapes.length > 4, `${theme}: the Porch sign is painted (${signShapes.length} shapes)`);
    const sign = signShapes.map(paintedBox).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]),
      Math.max(a[0] + a[2], b[0] + b[2]) - Math.min(a[0], b[0]), Math.max(a[1] + a[3], b[1] + b[3]) - Math.min(a[1], b[1])]);
    const look = (rows, what, opts = {}) => {
      const frame = lastFrame(paintedShapes(rows, { dark, ...opts }).shapes, theme);
      const found = frame.filter((s) => s.kind === 'fill' && s.style === PLATE_BG[theme]).map(platePainted);
      assert(found.length > 0, `${theme} ${what}: a plate is painted`);
      for (const p of found) {
        plates += 1;
        assert(overlapDepth(p, sign) <= 0, `${theme} ${what}: a plate painted at ${JSON.stringify(p.map(r2))} covers the Porch sign ${JSON.stringify(sign.map(r2))} by ${overlapDepth(p, sign).toFixed(2)} px`);
        if (p[1] < sign[1] + sign[3] && sign[1] < p[1] + p[3]) gap = Math.min(gap, sign[0] - (p[0] + p[2]));
      }
    };
    // The door alone: its anchor is the front row's right column, beside the sign, so a lone Blocked has the whole
    // row's width and nobody to narrow its plate. Then every mix the sign check lays out.
    for (const mix of [[1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0], [5, 0, 0], [6, 0, 0], [7, 0, 0], [8, 0, 0],
      [1, 1, 0], [1, 0, 1], [1, 1, 1], [5, 5, 2], [12, 12, 6]]) {
      const rows = porchRows(mix[0], mix[1], { title, tokens: MAX_TOKENS }, mix[2]);
      look(rows, mix.join('+'));
      // Selected and hovered, a plate is wider (up to 300) and says more: the row nearest the sign, and in a small
      // mix every Blocked.
      const layout = V.layoutVillage(rows);
      const blocked = rows.filter((r) => r.lane === 'needs_you');
      const nearest = blocked.reduce((a, b) => (layout.get(b.id).x > layout.get(a.id).x ? b : a));
      for (const r of mix[0] <= 3 ? blocked : [nearest]) look(rows, `${mix.join('+')} with ${r.id.slice(-2)} selected`, { select: r.id });
      look(rows, `${mix.join('+')} with the nearest Blocked hovered`, { aim: nearest.id });
    }
  }
  assert(gap > 0, `a plate beside the sign keeps off it (${gap.toFixed(2)} px)`);
  results.porchPlateToSign = { gap: +gap.toFixed(2), plates };
});

check("Charlie's board: 5 Needs input on the swings and 123 in the graveyard, painted apart, the ghosts over the graveyard", () => {
  const turns = Array.from({ length: 5 }, (_, i) => row(`local_bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`, 'your_turn',
    { tokens: MAX_TOKENS, look: PAINT_LOOKS[i % PAINT_LOOKS.length], repo: PAINT_ISLE }));
  const graves = Array.from({ length: 123 }, (_, i) => row(`local_22222222-0000-4000-8000-${String(i).padStart(12, '0')}`, 'graveyard',
    { look: i, repo: PAINT_ISLE }));
  const measured = {};
  for (const theme of ['day', 'dusk']) {
    for (const island of [false, true]) {
      const label = `${theme}, ${island ? 'inside an island' : 'one village'}`;
      const dark = theme === 'dusk';
      const { roads, fence } = paintedScene(theme, island);
      // Each half of the board is whatever the whole board paints that the other half alone does not.
      const whole = paintFrames([...turns, ...graves], { dark, island });
      const half = (rows) => paintFrames(rows, { dark, island });
      const minusFrames = (a, b) => {
        eq(a.length, b.length, `${label}: frames line up`);
        const out = new Map();
        a.forEach((f, i) => {
          const left = new Map();
          for (const s of b[i]) left.set(paintKey(s), (left.get(paintKey(s)) || 0) + 1);
          for (const s of f) {
            const k = paintKey(s);
            const n = left.get(k) || 0;
            if (n > 0) left.set(k, n - 1);
            else out.set(k, s);
          }
        });
        return [...out.values()];
      };
      const porchShapes = minusFrames(whole, half(graves));
      const porch = porchShapes.map(paintedBox);
      const graveyard = [...minusFrames(whole, half(turns)), ...fence].map(paintedBox);
      assert(porch.length > 0 && graveyard.length > 0, `${label}: both halves paint`);
      const roadFoot = V.ROAD_LINES[0][0][1] + V.ROAD_BAND / 2;
      const top = Math.min(...porch.map((b) => b[1]));
      assert(top > roadFoot, `${label}: the swings paint up to y ${top.toFixed(2)}, over the road's edge at ${roadFoot}`);
      const graveGrid = gridOf(graveyard.map((box) => ({ box })));
      for (const p of porch) {
        for (const r of roads) assert(overlapDepth(p, r) <= 0, `${label}: the swings paint ${JSON.stringify(p.map(r2))} on the road`);
        for (const q of nearBox(graveGrid, p)) assert(overlapDepth(p, q.box) <= 0, `${label}: the swings paint ${JSON.stringify(p.map(r2))} into the graveyard ${JSON.stringify(q.box.map(r2))}`);
      }
      const gap = nearestGap(porch.map((box) => ({ box })), graveyard.map((box) => ({ box })), 200);
      // The swing frames themselves, the shapes that crossed the road: one beam a row, read off the frame as the
      // 9 px tall bar in the frame's wood that spans the row's seats (a seat is 8 tall).
      const layout = V.layoutVillage(turns);
      const rowsOf = [...new Set([...layout.values()].map((s) => s.y))].sort((a, b) => a - b);
      eq(rowsOf, [...V.PORCH_ROWS], `${label}: the five sit on both Porch rows`);
      const wood = { day: '#a98563', dusk: '#6f5742' }[theme];
      const beams = porchShapes.filter((s) => s.kind === 'fill' && s.style === wood && Math.abs(s.box[3] - s.box[1] - 9) < 0.01 && s.box[2] - s.box[0] > 60);
      eq(beams.length, rowsOf.length, `${label}: a swing frame over each row`);
      const beamTop = Math.min(...beams.map((s) => s.box[1]));
      assert(beamTop > roadFoot, `${label}: the top swing frame's beam at y ${beamTop} is below the road's edge at ${roadFoot}`);
      // The ghosts: eleven for 123 graves, every one inside the fence and clear of the sign.
      const frame = whole[whole.length - 1];
      const bodies = ghostBodies(frame, theme);
      eq(bodies.length, 11, `${label}: eleven ghosts over 123 graves`);
      const sign = boxOf(graveSignShapes(frame, theme));
      const [fx, fy, fw, fh] = V.GRAVEYARD.fence;
      for (const b of bodies) {
        const box = paintedBox(b);
        assert(box[0] >= fx && box[0] + box[2] <= fx + fw && box[1] >= fy && box[1] + box[3] <= fy + fh, `${label}: a ghost ${JSON.stringify(box.map(r2))} floats over the graveyard`);
        assert(overlapDepth(box, sign) <= 0, `${label}: a ghost ${JSON.stringify(box.map(r2))} is over the sign ${JSON.stringify(sign.map(r2))}`);
      }
      measured[label] = { swingsTop: +top.toFixed(2), beamTop: +beamTop.toFixed(2), swingsToRoad: +(top - roadFoot).toFixed(2), swingsToGraveyard: +gap.toFixed(2) };
    }
  }
  const figures = Object.values(measured).map((v) => JSON.stringify(v));
  eq(new Set(figures).size, 1, `the same in both themes and both maps (${figures.join(' ')})`);
});

const litPanes = (shapes, theme) => shapes.filter((s) => s.kind === 'fill' && s.style === WINDOW_LIT[theme]);
const paneAt = (panes, [x, y, w, h]) => panes.find((s) => Math.abs(s.box[0] - x) < 0.01 && Math.abs(s.box[1] - y) < 0.01
  && Math.abs(s.box[2] - (x + w)) < 0.01 && Math.abs(s.box[3] - (y + h)) < 0.01);
// The beam's wedges: each is an arc of the whole reach about the lantern, so its box is that square.
const beamWedges = (shapes) => shapes.filter((s) => s.kind === 'fill'
  && Math.abs(s.box[0] - (V.LIGHTHOUSE.x - V.LIGHTHOUSE.reach)) < 0.01
  && Math.abs(s.box[1] - (V.LIGHTHOUSE.y - V.LIGHTHOUSE.reach)) < 0.01);

check('night lights the sand castle and the lighthouse lantern, and the day theme leaves them dark', () => {
  // No idle or recent rows, so the cottage's own windows stay dark and only the night lighting is lit.
  const rows = [row(A, 'valhalla'), row(B, 'open_pr'), row(C, 'graveyard')];
  eq(V.CASTLE_WINDOWS.length, 3, "the castle's keep and its two turrets");
  for (const box of V.CASTLE_WINDOWS) {
    const [cx, cy, cw, ch] = V.CASTLE.rect;
    assert(box[0] >= cx && box[1] >= cy && box[0] + box[2] <= cx + cw && box[1] + box[3] <= cy + ch,
      `a castle window ${JSON.stringify(box)} is on the castle ${JSON.stringify(V.CASTLE.rect)}`);
    assert(box[2] > 0 && box[3] > 0, `and has a pane to light (${JSON.stringify(box)})`);
  }

  const night = lastFrame(paintedShapes(rows, { reduce: true, dark: true }).shapes, 'dusk');
  const lit = litPanes(night, 'dusk');
  for (const box of V.CASTLE_WINDOWS) assert(paneAt(lit, box), `the castle window at ${JSON.stringify(box)} is lit at dusk`);
  // Every opening paintSandCastle draws is a capsule, so a pane at a smaller radius puts its four corners out on
  // the wall, where a box cannot see them: the radius has to be read off the canvas. An outline would cost light
  // too, on a pane 5.6 px wide, so the unpaned form takes none.
  for (const box of V.CASTLE_WINDOWS) {
    const want = Math.min(box[2], box[3]) / 2;
    const pane = paneAt(lit, box);
    eq(pane.radii.length, 4, `the castle window at ${JSON.stringify(box)} is a rounded rect`);
    for (const r of pane.radii) near(r, want, 1e-9, `its pane fills the capsule the castle paints (${r} against ${want})`);
    const outlined = night.filter((s) => s.kind === 'stroke' && paneAt([s], box));
    eq(outlined.length, 0, `and takes no outline (${outlined.map((s) => s.style).join(', ')})`);
  }
  const [lx, ly, lw, lh] = V.LIGHTHOUSE.lantern;
  assert(paneAt(lit, [lx + 2, ly + 2, lw - 4, lh - 4]), 'the lighthouse lantern is lit at dusk');
  eq(lit.length, 4, 'and nothing else is, with the cottage empty');
  eq(beamWedges(night).length, V.LIGHTHOUSE.cones.length, 'the beam is drawn at dusk');

  const day = lastFrame(paintedShapes(rows, { reduce: true, dark: false }).shapes, 'day');
  eq(litPanes(day, 'day').length, 0, 'in the day theme the castle and the lantern are dark');
  eq(litPanes(day, 'dusk').length, 0, 'in neither theme colour');
  eq(beamWedges(day).length, 0, 'and the beam is off');

  // The cottage windows still light for their own room, whatever the theme.
  const withGuests = [...rows, row(D, 'idle'), row('local_eeeeeeee-0000-4000-8000-000000000005', 'recent')];
  const litDay = litPanes(lastFrame(paintedShapes(withGuests, { reduce: true }).shapes, 'day'), 'day');
  eq(litDay.length, V.COTTAGE_WINDOWS.length, 'the cottage lights its windows in the day theme');
  for (const box of V.COTTAGE_WINDOWS) assert(paneAt(litDay, box), `the cottage window at ${JSON.stringify(box)} is lit`);
  const litNight = litPanes(lastFrame(paintedShapes(withGuests, { reduce: true, dark: true }).shapes, 'dusk'), 'dusk');
  eq(litNight.length, V.COTTAGE_WINDOWS.length + V.CASTLE_WINDOWS.length + 1,
    'and at dusk the castle and the lantern join them');
});

check('the lighthouse beam sweeps once about every 5 s, and never asks for a full-rate frame', () => {
  const { period } = V.LIGHTHOUSE;
  near(period, 5, 0.5, 'a revolution takes about 5 s');
  near(V.beamAngle(period) - V.beamAngle(0), Math.PI * 2, 1e-9, 'and it is exactly one turn');
  near(V.beamAngle(period / 4) - V.beamAngle(0), Math.PI / 2, 1e-9, 'a quarter turn in a quarter of it');
  const framesPerTurn = (period * 1000) / V.AMBIENT_FRAME_MS;
  assert(framesPerTurn >= 55 && framesPerTurn <= 65, `about 60 ambient frames to the turn (${framesPerTurn.toFixed(1)})`);
  // The pacing constant and the cone widths are coupled, and a frame count cannot see it: a step wider than the
  // narrowest cone leaves angles that get no brightest-core frame at all, so the sweep reads as gapped rather than
  // stepped. At AMBIENT_FRAME_MS 90 the count above still passes and this does not, which is what it is here for.
  const step = (Math.PI * 2 * V.AMBIENT_FRAME_MS) / 1000 / period;
  const core = 2 * Math.min(...V.LIGHTHOUSE.cones.map((c) => c.half));
  assert(step <= core, `the ambient step stays inside the brightest core (${step.toFixed(5)} rad against ${core.toFixed(5)})`);
  // Measured as well as inferred: every angle round the turn is within a half width of some sampled frame.
  let miss = 0;
  for (let k = 0; k < 2000; k++) {
    const want = (Math.PI * 2 * k) / 2000;
    let closest = Math.PI;
    for (let f = 0; f <= Math.ceil(framesPerTurn); f++) {
      const at = V.beamAngle((f * V.AMBIENT_FRAME_MS) / 1000) - V.LIGHTHOUSE.rest;
      closest = Math.min(closest, Math.abs(((want - at + Math.PI * 3) % (Math.PI * 2)) - Math.PI));
    }
    miss = Math.max(miss, closest);
  }
  assert(miss <= core / 2, `every angle gets a bright-core frame (worst miss ${miss.toFixed(5)} rad against ${(core / 2).toFixed(5)})`);
  // Sampled at the ambient rate the beam still passes through every quadrant, and moves on every one of those frames.
  const quadrants = new Set();
  const angles = new Set();
  for (let f = 0; f < framesPerTurn; f++) {
    const a = V.beamAngle((f * V.AMBIENT_FRAME_MS) / 1000);
    quadrants.add(Math.floor((((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2)));
    angles.add(Math.round(a * 100));
  }
  eq(quadrants.size, 4, 'the beam goes all the way round');
  assert(angles.size >= 55, `every ambient frame advances it (${angles.size} angles a turn)`);

  // Reduced motion holds it still, pointing out over the channel rather than into the harbour crowd.
  for (const t of [0, 1.3, 7.7, 99]) eq(V.beamAngle(t, true), V.LIGHTHOUSE.rest, `reduced motion holds the beam at ${t}`);
  for (const t of [0, 2.5, 60]) {
    near(V.beamAlphaAt(1300, 470, t, true), V.beamAlphaAt(1300, 470, 0, true), 1e-12, 'and the alpha with it');
  }

  // The pacing spy the other motion checks use: a dusk village with six ghosts, a crowded harbour and the beam
  // sweeping stays at the ambient rate. The beam is not in `anyMotion`, so nothing here asks for a full-rate frame.
  const rows = [...graveRows(157),
    ...Array.from({ length: 8 }, (_, i) => row(`local_33333333-0000-4000-8000-${String(i).padStart(12, '0')}`, 'open_pr'))];
  const quiet = paintedShapes(rows, { reduce: false, dark: true, seconds: 3, settle: 3 });
  assert(quiet.frames <= 3 * 13, `the beam rides the ambient tick (${quiet.frames} frames in 3 s)`);
  assert(quiet.frames >= 24, `and the ambient tick is still running (${quiet.frames} frames in 3 s)`);
  eq(beamWedges(lastFrame(quiet.shapes, 'dusk')).length, V.LIGHTHOUSE.cones.length, 'and every frame draws the beam');
  results.beam = { period, framesPerTurn: +framesPerTurn.toFixed(1), restFrameRate: +(quiet.frames / 3).toFixed(1) };
});

// Records the radial gradients and arcs the village draws, with each gradient's colour stops, so a check can read
// the alphas that actually reach the canvas rather than the model that says what they should be.
function gradientSpy(record) {
  const gradient = (args) => {
    const stops = [];
    record.gradients.push({ args, stops });
    return new Proxy(function () {}, {
      get: (_t, key) => (key === 'addColorStop' ? (at, colour) => { stops.push([at, colour]); return stub; }
        : key === Symbol.toPrimitive ? () => 0 : stub),
      set: () => true,
      apply: () => stub,
    });
  };
  return new Proxy(function () {}, {
    get: (_t, key) => {
      if (key === 'createRadialGradient') return (...args) => gradient(args);
      if (key === 'arc') return (...args) => { record.arcs.push(args); return stub; };
      return key === Symbol.toPrimitive ? () => 0 : key === 'width' ? 10 : stub;
    },
    set: () => true,
    apply: () => stub,
  });
}

check('the alpha the beam is measured at is the alpha it is drawn with', () => {
  const record = { gradients: [], arcs: [] };
  try {
    withFrameLoop((loop) => {
      reduceMotion = true;
      darkMode = true;
      const canvas = {
        width: 0, height: 0, style: {}, getContext: () => gradientSpy(record),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }),
        addEventListener() {}, removeEventListener() {},
      };
      const village = V.createVillage(canvas, {});
      village.resize();
      village.start();
      village.update(board([row(A, 'open_pr')]), { privacy: false });
      loop.pump(0.3);
      village.destroy();
    });
  } finally {
    darkMode = false;
  }

  const { x, y, reach, cones, rest } = V.LIGHTHOUSE;
  // The beam's own gradients: from the lantern itself out to the full reach. Every other warm glow in the village
  // starts at a radius of 2 or 3, so this picks out the three wedges and nothing else.
  const beams = record.gradients.filter((g) => g.args[0] === x && g.args[1] === y && g.args[2] === 0 && g.args[5] === reach);
  eq(beams.length, cones.length, 'one gradient per cone');
  const alphaOf = (colour) => {
    const m = /^rgba\(246, 222, 160, ([\d.]+)\)$/.exec(colour);
    assert(m, `a beam stop is the village's warm light (${colour})`);
    return Number(m[1]);
  };
  beams.forEach((g, i) => {
    eq(g.stops.map((s) => s[0]), V.BEAM_PROFILE.map((p) => p[0]), `cone ${i} stops at the profile's offsets`);
    g.stops.forEach(([, colour], k) => {
      near(alphaOf(colour), cones[i].alpha * V.BEAM_PROFILE[k][1], 1e-5, `cone ${i} stop ${k}`);
    });
  });
  // The three wedges, each centred on the resting angle at its own half width.
  const wedges = record.arcs.filter((a) => a[0] === x && a[1] === y && a[2] === reach);
  eq(wedges.length, cones.length, 'one wedge per cone');
  wedges.forEach((a, i) => {
    near((a[4] - a[3]) / 2, cones[i].half, 1e-9, `wedge ${i} is its cone's width`);
    near((a[3] + a[4]) / 2, rest, 1e-9, `wedge ${i} is centred on the resting angle`);
  });

  // And the two meet: composing the drawn stops down the beam's centre line gives beamAlphaAt at that point.
  V.BEAM_PROFILE.forEach(([f], k) => {
    const d = f * reach * 0.999; // just inside the reach, where the outermost stop is still drawn
    const px = x + d * Math.cos(rest);
    const py = y + d * Math.sin(rest);
    let keep = 1;
    for (const g of beams) keep *= 1 - alphaOf(g.stops[k][1]);
    near(V.beamAlphaAt(px, py, 0, true), 1 - keep, 2e-3, `the drawn alpha at ${(f * 100).toFixed(0)}% of the reach`);
  });
});

check('the beam never washes out an avatar, the harbour, the border patrol or a boat', () => {
  const blend = (top, base, a) => `#${hexRgb(top).map((c, i) => Math.round(c * a + hexRgb(base)[i] * (1 - a)))
    .map((c) => Math.min(255, Math.max(0, c)).toString(16).padStart(2, '0')).join('')}`;
  // The light a pack sweeps: the green village's and the frontier's warm lantern, and Middle-earth's red Eye.
  // The beam's alphas are the same in every pack, so the colour is the only thing that changes what it does to
  // what it falls on, and a redder light shifts a body further than a warm one at the same alpha.
  const lightOf = (pack) => `#${V.resolveTheme(pack, true).beamLight.split(',')
    .map((n) => Number(n.trim()).toString(16).padStart(2, '0')).join('')}`;
  // The most of the beam that can fall anywhere in a box, whatever the beam's angle.
  const peakOver = ([x, y, w, h]) => {
    let out = 0;
    for (let i = 0; i <= 12; i++) {
      for (let k = 0; k <= 12; k++) out = Math.max(out, V.beamPeakAt(x + (w * i) / 12, y + (h * k) / 12));
    }
    return out;
  };
  const lantern = V.beamPeakAt(V.LIGHTHOUSE.x, V.LIGHTHOUSE.y);
  near(lantern, 0.1, 0.002, 'the beam is brightest at the lantern');
  eq(V.beamAlphaAt(V.LIGHTHOUSE.x + V.LIGHTHOUSE.reach + 1, V.LIGHTHOUSE.y, 0), 0, 'and nothing past its reach');
  for (let t = 0; t < V.LIGHTHOUSE.period; t += 0.05) {
    const a = V.beamAlphaAt(V.LIGHTHOUSE.x, V.LIGHTHOUSE.y, t);
    assert(a <= lantern + 1e-12, `never brighter than its peak at t=${t.toFixed(2)} (${a.toFixed(4)})`);
  }

  // Everything the beam can sweep over: a body at every slot of every spot at the largest size, the harbour deck
  // and its sign, the border patrol, and a boat anywhere on either lane or at its berth.
  let avatar = { a: 0 };
  for (const spot of V.SPOT_KEYS) {
    for (const n of [1, 6, 14, 20]) {
      for (const p of V.slotGrid(spot, n).points) {
        for (const part of V.avatarBoxes(V.SPOTS[spot].place, p.x, p.y, V.TOKEN_SCALE.max)) {
          const a = peakOver(part);
          if (a > avatar.a) avatar = { a, spot, at: [Math.round(p.x), Math.round(p.y)] };
        }
      }
    }
  }
  let boat = { a: 0 };
  for (const lane of [V.SAIL_WAYPOINTS, V.RETURN_WAYPOINTS, [V.BOAT_BERTH, V.BOAT_BERTH]]) {
    for (let i = 1; i < lane.length; i++) {
      for (let k = 0; k <= 60; k++) {
        const x = lane[i - 1].x + (lane[i].x - lane[i - 1].x) * (k / 60);
        const y = lane[i - 1].y + (lane[i].y - lane[i - 1].y) * (k / 60);
        // boatBox, not hullBox: the mast, sail and flag stand 86 local units above the hull, which at the berth is
        // 60 px nearer the lantern, so the hull's box understates what the beam falls on.
        const a = peakOver(V.boatBox(x, y));
        if (a > boat.a) boat = { a, at: [Math.round(x), Math.round(y)] };
      }
    }
  }
  const harbour = peakOver(V.HARBOUR_DECK);
  const sign = peakOver(V.signBox('harbour'));
  let patrol = 0;
  for (const b of [V.GUARD_BOX, V.BOOTH_BOX, V.BARRIER_BOX, V.PATROL_PLATFORM]) patrol = Math.max(patrol, peakOver(b));

  // A body under the beam has to stay its own repo's colour. The palette's closest pair is 21.5 apart, so a lit
  // body that stays 18 from every other entry cannot be read as another repo.
  assert(avatar.a <= 0.09, `the most beam a body ever sits in is low (${avatar.a.toFixed(4)} at the ${avatar.spot})`);
  // The worst any pack does, which is what the recorded figures below hold.
  const worst = { shift: 0, other: Infinity, ink: Infinity };
  for (const pack of V.THEME_KEYS) {
    const WARM = lightOf(pack);
    let shift = { d: 0 };
    let other = { d: Infinity };
    let ink = { c: Infinity };
    for (const e of V.REPO_PALETTE) {
      const body = blend(WARM, e.dark, avatar.a);
      const face = blend(WARM, e.ink, avatar.a);
      if (de00(e.dark, body) > shift.d) shift = { d: de00(e.dark, body), e: e.name };
      if (contrast(face, body) < ink.c) ink = { c: contrast(face, body), e: e.name };
      for (const o of V.REPO_PALETTE) {
        if (o !== e && de00(body, o.dark) < other.d) other = { d: de00(body, o.dark), e: e.name, o: o.name };
      }
    }
    assert(shift.d <= 6, `${pack}: a lit body barely shifts (${shift.d.toFixed(2)} on ${shift.e})`);
    assert(other.d >= 18, `${pack}: and stays ${other.d.toFixed(2)} from every other repo colour (${other.e} against ${other.o})`);
    assert(ink.c >= 3, `${pack}: its face still reads on it (${ink.c.toFixed(2)}:1 on ${ink.e})`);
    worst.shift = Math.max(worst.shift, shift.d);
    worst.other = Math.min(worst.other, other.d);
    worst.ink = Math.min(worst.ink, ink.c);
  }
  assert(harbour <= 0.1 && boat.a <= 0.09 && sign <= 0.1,
    `the harbour ${harbour.toFixed(4)}, a boat ${boat.a.toFixed(4)} and the harbour sign ${sign.toFixed(4)} stay dim`);

  // Whoever stands at the barrier keeps the 12 they hold from every reserved state colour, under the beam too,
  // in every pack: the Shire's grey robe stands in the same light the frontier's khaki does.
  let uniform = { d: Infinity };
  const lit4 = V.THEME_KEYS.flatMap((pack) => {
    const R = V.resolveTheme(pack, true);
    return [['khaki', R.patrolKhaki], ['khakiShade', R.patrolKhakiShade], ['navy', R.patrolNavy], ['white', R.patrolWhite]]
      .map(([name, hex]) => [`${pack}/${name}`, hex, lightOf(pack)]);
  });
  for (const [name, hex, WARM] of lit4) {
    const lit = blend(WARM, hex, patrol);
    for (const [state, colour] of Object.entries(RESERVED)) {
      if (de00(lit, colour) < uniform.d) uniform = { d: de00(lit, colour), name, state };
    }
  }
  assert(uniform.d >= 12, `the lit uniform is only ${uniform.d.toFixed(2)} from ${uniform.state} (${uniform.name})`);

  // The state badge and the name plate are drawn after the beam, so neither is ever seen through it.
  const rows = Array.from({ length: 6 }, (_, i) => row(`local_44444444-0000-4000-8000-${String(i).padStart(12, '0')}`, 'open_pr'));
  const frame = lastFrame(paintedShapes(rows, { reduce: true, dark: true }).shapes, 'dusk');
  const wedges = beamWedges(frame);
  eq(wedges.length, V.LIGHTHOUSE.cones.length, 'the beam is drawn');
  const lastWedge = frame.lastIndexOf(wedges[wedges.length - 1]);
  const green = (from, to) => frame.filter((s, i) => i > from && i < to && s.kind === 'fill' && s.style === V.STATE.open_pr.color);
  assert(green(lastWedge, Infinity).length >= rows.length,
    `every character's badge is drawn over the beam (${green(lastWedge, Infinity).length} of ${rows.length})`);
  // What the draw order does leave under the beam: the scene's own fixtures. Every place sign carries a badge per
  // lane, the graveyard sign carries one and the two room doors carry one each, in eight reserved colours between
  // them, and as a stroke rather than a fill where the lane's badge is the hollow kind (`stopped`). Counting one
  // colour and one kind would say nothing about the other seven, so every reserved colour is counted and each one
  // has to be somewhere a fixture can be, which is what rules out a character's badge.
  const home = [
    ...V.PLACE_KEYS.map((key) => ({ what: `the ${key} sign`, box: V.signBox(key) })),
    { what: 'the graveyard sign', box: [V.GRAVEYARD.sign[0] - 65, V.GRAVEYARD.sign[1] - 35, 130, 70] },
    { what: 'the cottage room badge', box: [V.COTTAGE.badge[0] - 60, V.COTTAGE.badge[1] - 16, 120, 32] },
    { what: 'the castle room badge', box: [V.CASTLE.badge[0] - 60, V.CASTLE.badge[1] - 16, 120, 32] },
  ];
  const holds = ([x0, y0, x1, y1], [x, y, w, h]) => x0 >= x - 0.5 && y0 >= y - 0.5 && x1 <= x + w + 0.5 && y1 <= y + h + 0.5;
  const reserved = new Set(Object.values(RESERVED));
  const fixtures = frame.filter((s, i) => i < lastWedge && (s.kind === 'fill' || s.kind === 'stroke') && reserved.has(s.style));
  const onSigns = V.PLACE_KEYS.reduce((n, key) => n + V.PLACES[key].lanes.length, 0);
  eq(fixtures.length, onSigns + 3, 'one badge per lane on every place sign, plus the graveyard sign and the two room doors');
  const litBadges = [];
  for (const s of fixtures) {
    const at = home.find((h) => holds(s.box, h.box));
    assert(at, `a ${s.kind} in ${s.style} before the beam at ${JSON.stringify(s.box.map((v) => Math.round(v)))} is on no sign or room door`);
    const a = peakOver([s.box[0], s.box[1], s.box[2] - s.box[0], s.box[3] - s.box[1]]);
    if (a > 0) litBadges.push({ what: at.what, a: +a.toFixed(4) });
  }
  litBadges.sort((p, q) => q.a - p.a);
  // The same ceiling the bodies keep: a fixture badge is a flat pill of one reserved colour, so it has further to
  // travel before it reads as another state than a body has before it reads as another repo.
  for (const b of litBadges) assert(b.a <= 0.09, `${b.what} sits in too much beam (${b.a})`);
  eq(green(-1, lastWedge).length, 1, 'and of the greens only the harbour sign\'s own badge, never a character\'s');
  results.beamAlpha = {
    lantern: +lantern.toFixed(4),
    avatar: +avatar.a.toFixed(4), avatarSpot: avatar.spot, harbour: +harbour.toFixed(4),
    boat: +boat.a.toFixed(4), harbourSign: +sign.toFixed(4), patrol: +patrol.toFixed(4),
    fixtureBadges: fixtures.length, litBadges,
    bodyShift: +worst.shift.toFixed(2), nearestOtherRepo: +worst.other.toFixed(2), faceInk: +worst.ink.toFixed(2),
    uniformFromState: +uniform.d.toFixed(2),
  };
});

// ---------- the world of islands ----------

const FRAME = [V.WORLD.margin, V.WORLD.margin, 1600 - V.WORLD.margin * 2, 900 - V.WORLD.margin * 2];
const rnd2 = (n) => Math.round(n * 100) / 100;
const rnd5 = (n) => Math.round(n * 100000) / 100000;
const inBox = (inner, outer, tol = 1e-6) => inner[0] >= outer[0] - tol && inner[1] >= outer[1] - tol
  && inner[0] + inner[2] <= outer[0] + outer[2] + tol && inner[1] + inner[3] <= outer[1] + outer[3] + tol;
// A ring of the island art as [minX, minY, maxX, maxY], the shape geometrySpy reports a path as.
const polyBox = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])),
  Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
// One busy repo the size of Charlie's among small ones, every badge lane filled with a three-digit count so the
// widest badge row a real board can produce is the one measured.
const worldCounts = (n) => Array.from({ length: n }, (_, i) => (i === 0 ? 246 : (i % 5) + 1));
const worldEntries = (n) => worldCounts(n).map((count, i) => ({
  repo: `repo-${String(i).padStart(2, '0')}`, count,
  lanes: { needs_you: 111, your_turn: 222, errored: 333, open_pr: 444, jail: 555 },
}));

check('the world map lays out 1 to 24 repos with no overlaps, all inside the canvas, every label in its own island', () => {
  // 48 is the last count the strict guarantee is made at: past it the grid runs out of room and the name boards
  // give way to keep the islands clickable, which the next check covers.
  for (const n of [1, 2, 3, 6, 12, 24, 48]) {
    const islands = V.worldLayout(worldEntries(n));
    eq(islands.length, n, `${n} repos give ${n} islands`);
    for (const is of islands) {
      assert(is.rx > 0 && is.ry > 0 && Number.isFinite(is.cx) && Number.isFinite(is.cy), `${n}: ${is.repo} has a real size`);
      assert(inBox(is.box, FRAME), `${n}: ${is.repo} inside the canvas margin: ${is.box}`);
      assert(inBox(is.box, is.cell), `${n}: ${is.repo} keeps to its own cell: ${is.box} in ${is.cell}`);
      assert(inBox(is.sign, is.cell), `${n}: ${is.repo}'s name board keeps to its cell`);
      assert(is.nameBox && inBox(is.nameBox, is.sign), `${n}: ${is.repo}'s name is on its board`);
      assert(inBox(is.badges, is.sign), `${n}: ${is.repo}'s badge row is on its board`);
      const row = V.worldBadgeRow(is.lanes, is.badges[2], is.badges[3]);
      eq(row.cells.length, V.WORLD_BADGE_LANES.length, `${n}: ${is.repo} badges every lane that has one`);
      const rowBox = [is.cx - row.w / 2, is.badges[1] + is.badges[3] / 2 - row.cells[0].r, row.w, row.cells[0].r * 2];
      assert(inBox(rowBox, is.badges), `${n}: ${is.repo}'s drawn badges stay in their band: ${rowBox} in ${is.badges}`);
      for (const other of islands) {
        if (other === is) continue;
        assert(!V.boxesOverlap(is.box, other.box), `${n}: ${is.repo} overlaps ${other.repo}`);
        assert(!V.boxesOverlap(is.sign, other.box), `${n}: ${is.repo}'s board is over ${other.repo}`);
        assert(!V.boxesOverlap(is.nameBox, other.box), `${n}: ${is.repo}'s name is over ${other.repo}`);
      }
    }
    // Size follows the session count, and is clamped at both ends.
    const sorted = [...islands].sort((a, b) => a.count - b.count || (a.repo < b.repo ? -1 : 1));
    for (let i = 1; i < sorted.length; i++) {
      assert(sorted[i].ry >= sorted[i - 1].ry - 1e-9,
        `${n}: ${sorted[i].repo} at ${sorted[i].count} sessions is smaller than ${sorted[i - 1].repo} at ${sorted[i - 1].count}`);
    }
    const rys = islands.map((is) => is.ry);
    const floor = Math.min(V.WORLD.ryMin, Math.max(...rys) * V.WORLD.ryMinRatio);
    assert(Math.min(...rys) >= floor - 1e-9, `${n}: the smallest island (${rnd2(Math.min(...rys))}) is above the floor the ceiling allows (${rnd2(floor)})`);
    assert(Math.max(...rys) <= V.WORLD.ryMax + 1e-9, `${n}: largest island ${Math.max(...rys)}`);
    if (n > 1) assert(Math.max(...rys) > Math.min(...rys) + 1, `${n}: a 246-session repo reads bigger than a one-session one`);
    // The grid, derived from the layout's own arithmetic rather than counted off the drawn boxes, and tied back to
    // the cell.
    const cols = Math.min(n, Math.max(1, Math.ceil(Math.sqrt((n * FRAME[2]) / FRAME[3]))));
    const rows = Math.ceil(n / cols);
    eq([rnd2(islands[0].cell[2]), rnd2(islands[0].cell[3])], [rnd2(FRAME[2] / cols), rnd2(FRAME[3] / rows)],
      `${n}: the cell is the area divided by the ${cols} x ${rows} grid`);
  }
});

check('the world map stays valid past the counts it is designed for, and answers nothing for an empty board', () => {
  eq(V.worldLayout([]), [], 'no repos, no islands');
  eq(V.worldLayout(null), [], 'hostile input');
  eq(V.worldLayout([{ repo: 'x' }, null, 42, { count: 3 }]).length, 1, 'only entries naming a repo');
  eq(V.worldLayout([{ repo: 'x', count: -5 }])[0].count, 0, 'a negative count reads as none');
  // Valid to 400 repos: from about 51 the name board starts giving way, by 73 there is none, and from 121 the whole
  // sign goes, badges included. Nobody has 400 repos; this is here so an absurd board degrades instead of breaking.
  for (const n of [64, 100, 240, 400]) {
    const islands = V.worldLayout(worldEntries(n));
    for (const is of islands) {
      assert(is.rx > 0 && is.ry > 0, `${n}: ${is.repo} still has a size`);
      assert(inBox(is.box, FRAME), `${n}: ${is.repo} still inside the canvas`);
      assert(inBox(is.box, is.cell), `${n}: ${is.repo} still inside its cell`);
      assert(inBox(is.badges, is.sign), `${n}: ${is.repo}'s badges are still on its board`);
      const row = V.worldBadgeRow(is.lanes, is.badges[2], is.badges[3]);
      // Asserted, never skipped: wrapped in `if (row.cells.length)` an island with no badges at all passed
      // silently, which is how the sign vanishing from 121 repos once went unnoticed.
      eq(row.cells.length > 0, is.badges[3] > 0, `${n}: ${is.repo} badges exactly when its band has height`);
      if (row.cells.length) {
        const rowBox = [is.cx - row.w / 2, is.badges[1] + is.badges[3] / 2 - row.cells[0].r, row.w, row.cells[0].r * 2];
        assert(inBox(rowBox, is.badges), `${n}: ${is.repo}'s badges stay in their band`);
      }
    }
    for (let i = 0; i < islands.length; i++) {
      for (let j = i + 1; j < islands.length; j++) {
        assert(!V.boxesOverlap(islands[i].box, islands[j].box), `${n}: ${islands[i].repo} overlaps ${islands[j].repo}`);
      }
    }
  }
  // The degradation steps and the closing gap, measured rather than estimated: estimates had the gap reaching 0 px
  // "by about 400", where it is still 2.3 px, and the break hundreds of repos later than it is.
  const firstAt = (pred, hi = 900) => {
    for (let n = 1; n <= hi; n++) if (pred(V.worldLayout(worldEntries(n)))) return n;
    return null;
  };
  const escapes = (is) => !inBox(is.box, is.cell);
  const overlapping = (islands) => {
    for (let i = 0; i < islands.length; i++) {
      for (let j = i + 1; j < islands.length; j++) if (V.boxesOverlap(islands[i].box, islands[j].box)) return true;
    }
    return false;
  };
  const minGap = (islands) => {
    let m = Infinity;
    for (let i = 0; i < islands.length; i++) {
      for (let j = i + 1; j < islands.length; j++) {
        const [a, b] = [islands[i].box, islands[j].box];
        m = Math.min(m, Math.max(Math.max(a[0] - (b[0] + b[2]), b[0] - (a[0] + a[2])),
          Math.max(a[1] - (b[1] + b[3]), b[1] - (a[1] + a[3]))));
      }
    }
    return m;
  };
  const steps = {
    signBelowFull: firstAt((isl) => isl[0].sign[3] < V.WORLD.signH - 1e-9),
    nameGone: firstAt((isl) => !isl.some((is) => is.nameBox)),
    signGone: firstAt((isl) => isl.every((is) => is.badges[3] <= 0)),
    gapBelowFull: firstAt((isl) => isl.length > 1 && minGap(isl) < V.WORLD.pad * 2 - 1e-9),
    firstEscape: firstAt((isl) => isl.some(escapes)),
    firstOverlap: firstAt(overlapping),
  };
  eq(steps, { signBelowFull: 51, nameGone: 73, signGone: 121, gapBelowFull: 154, firstEscape: 685, firstOverlap: 685 },
    'the degradation steps have not moved');
  const gaps = {};
  for (const n of [24, 48, 100, 150, 200, 240, 300, 400, 500, 600, 684, 685]) gaps[n] = rnd2(minGap(V.worldLayout(worldEntries(n))));
  assert(gaps[400] > 2 && gaps[684] > 0 && gaps[685] < 0, `the gap closes at the break, not before: ${JSON.stringify(gaps)}`);
  // How far the badge counts stay readable, which is not how far the layout stays valid: the row shrinks as one to
  // stay on a board that shrinks with the cell, and a two-digit count in five lanes is an ordinary board. Measured
  // as the smallest numeral any island on the map draws, against a 9 px floor.
  const lanesOf = (digits) => {
    const n = [1, 11, 111][digits - 1];
    return Object.fromEntries(V.WORLD_BADGE_LANES.map((lane) => [lane, n]));
  };
  // `reviews` puts a two-digit review count on every island too, which is what the map looks like on a busy day.
  const numeral = (count, digits, reviews = 0) => {
    const islands = V.worldLayout(worldCounts(count).map((c, i) => ({ repo: `repo-${i}`, count: c, lanes: lanesOf(digits), reviews })));
    return Math.min(...islands.map((is) => {
      const row = V.worldBadgeRow(is.lanes, is.badges[2], is.badges[3], is.reviews);
      return row.cells.length ? 12 * row.k : 0;
    }));
  };
  const legibleWith = (reviews) => {
    const out = {};
    for (const digits of [1, 2, 3]) {
      let last = 0;
      for (let n = 1; n <= 200 && numeral(n, digits, reviews) >= 9 - 1e-9; n++) last = n;
      out[digits] = last;
    }
    return out;
  };
  const legibleTo = legibleWith(0);
  eq(legibleTo, { 1: 34, 2: 26, 3: 19 }, 'the badge numeral holds 9 px to the counts the README names');
  // A review costs a lane numeral nothing wherever the row had room beside the lanes. Fitted as one row with them,
  // it took these to 26, 19 and 13.
  const legibleWithReviews = legibleWith(11);
  eq(legibleWithReviews, { 1: 34, 2: 19, 3: 19 }, 'and with a review waiting on every island');
  // An empty badge row is the empty row, never a negative one.
  for (const [w, h] of [[0, 20], [200, 0], [-5, -5]]) eq(V.worldBadgeRow({ jail: 3 }, w, h).cells, [], `no room at ${w}x${h}`);
  eq(V.worldBadgeRow({}, 200, 20).cells, [], 'no counts, no badges');
  eq(V.worldBadgeRow({ jail: 0, needs_you: 2 }, 200, 20).cells.map((c) => c.lane), ['needs_you'], 'a zero lane is left out');
  // The reviews badge is fitted around the lanes: its count where there is room, its bare disc where there is not,
  // and it only ever costs the lanes that disc, on a row they already fill. It is never dropped.
  const two = lanesOf(2);
  const shape = (r) => r.cells.map((c) => [c.lane === V.REVIEWS ? 'reviews' : c.lane, !!c.glyphOnly]);
  const alone = V.worldBadgeRow(two, 244, 20);
  eq(alone.k, 1, 'five two-digit lanes fit a full board');
  const beside = V.worldBadgeRow({ needs_you: 3 }, 244, 20, 12);
  eq(shape(beside), [['needs_you', false], ['reviews', false]], 'with room, the review count sits beside the lanes');
  eq(beside.k, 1, 'at full size');
  const bare = V.worldBadgeRow(two, 244, 20, 12);
  eq(bare.k, alone.k, 'a review arriving leaves a lane numeral that had room exactly where it was');
  eq(shape(bare).at(-1), ['reviews', true], 'and shows as its bare disc when its count does not fit');
  const full = V.worldBadgeRow(two, 200, 20);
  const crowded = V.worldBadgeRow(two, 200, 20, 12);
  assert(full.k < 1 && crowded.k < full.k, `a row the lanes already fill gives up only the bare disc (${full.k} to ${crowded.k})`);
  near(crowded.k, 200 / (5 * 37 + 5 * 7 + 18), 1e-9, 'which is exactly one disc and one gap');
  eq(shape(crowded).at(-1), ['reviews', true], 'and the review is still on the board');
  assert(crowded.w <= 200 + 1e-9, 'inside it');
  eq(shape(V.worldBadgeRow({}, 244, 20, 5)), [['reviews', false]], 'a review on an island with no lane badges');
});

check('repos are grouped by the row\'s repo: none, one, many, and the no-repo island last', () => {
  eq(V.worldRepos([]), [], 'an empty board');
  eq(V.worldRepos(null), [], 'hostile input');
  const one = V.worldRepos([row(A, 'running', { repo: 'solo' }), row(B, 'idle', { repo: 'solo' })]);
  eq(one, [{ repo: 'solo', count: 2, lanes: { running: 1, idle: 1 }, reviews: 0 }], 'one repo, both lanes counted');
  // Visitors add each island's reviews-waiting count and never an island: a repo with a review request and no
  // sessions has none, which is the page's own rule, and the map's total is what says one is waiting. The island
  // is the one the server named, never one spelled like the repo: anyone can open a repo called `solo`.
  const reviewed = V.worldRepos([row(A, 'running', { repo: 'solo' })],
    V.visitorRows([{ id: 'pr1', number: 1, repo: 'solo', island: 'solo' }, { id: 'pr2', number: 2, repo: 'solo' },
      { id: 'pr3', number: 3, repo: 'solo', island: null }, { id: 'pr4', number: 4, repo: 'x', island: 'nowhere' }]));
  eq(reviewed.map((r) => [r.repo, r.reviews]), [['solo', 1]], 'only a visitor the server put on that island counts on it');
  // No repo at all: its own island, keyed on '' and listed last, so nothing on the board is invisible.
  const mixed = V.worldRepos([
    row(A, 'running', { repo: 'zed' }), row(B, 'running'), row(C, 'running', { repo: 'able' }),
    row(D, 'running', { repo: '' }), row(A, 'jail', { repo: 'zed' }),
  ]);
  eq(mixed.map((r) => r.repo), ['able', 'zed', ''], 'alphabetical, the no-repo island last');
  eq(mixed.map((r) => r.count), [1, 1, 2], 'a duplicate id counts once, and a blank repo joins the no-repo island');
  // Rows the village would not draw are not counted anywhere.
  eq(V.worldRepos([row(A, 'nonsense', { repo: 'x' }), { id: '', lane: 'running', repo: 'x' }]), [], 'no place, no island');
  eq(V.repoKeyOf({ repo: 'x' }), 'x', 'a repo is its own key');
  for (const r of [{ repo: '' }, { repo: null }, {}, null]) eq(V.repoKeyOf(r), V.NO_REPO_KEY, 'and no repo is the no-repo key');
  eq(V.worldLabel(''), V.NO_REPO_LABEL, 'the no-repo island is named');
  eq(V.worldLabel('a/b'), 'a/b', 'a repo is named after itself');
  // The hover id is in the same shape as the castle's and the cottage's, and round-trips.
  for (const repo of ['', 'a', 'has:colon', 'islandish']) eq(V.repoOfIslandId(V.islandHoverId(repo)), repo, `round trip ${repo}`);
  assert(V.isIslandId(V.CASTLE_ID) === false && V.isIslandId(V.COTTAGE_ID) === false, 'no room place is an island');
  eq(V.repoOfIslandId('castle:hall'), null, 'and no other place id reads as one');
  // The default mode is read off the board: one repo holding most of it is one village.
  const rows = (counts) => counts.flatMap((n, i) => Array.from({ length: n },
    (_, j) => row(`local_${String.fromCharCode(97 + i).repeat(8)}-0000-4000-8000-${String(j).padStart(12, '0')}`, 'running', { repo: `r${i}` })));
  eq(V.defaultMode([]), 'village', 'an empty board');
  eq(V.defaultMode(rows([9])), 'village', 'one repo');
  eq(V.defaultMode(rows([246, 11])), 'village', "Charlie's board");
  eq(V.defaultMode(rows([7, 3])), 'village', 'exactly 70 per cent');
  eq(V.defaultMode(rows([69, 31])), 'world', 'just under it');
  eq(V.defaultMode(rows([4, 3, 3])), 'world', 'an even spread');
  eq(V.MODE_SHARE, 0.7, 'the share the default turns on');
});

// Real board rows spread over `n` repos, so the art checks drive the shipped draw rather than the layout alone.
const artRows = (n) => {
  const lanes = ['running', 'needs_you', 'open_pr', 'idle', 'jail', 'valhalla', 'graveyard', 'your_turn', 'errored'];
  const out = [];
  for (let r = 0; r < n; r++) {
    const per = r === 0 ? 40 : ((r * 5) % 11) + 1;
    for (let i = 0; i < per; i++) {
      out.push(row(`local_${String(r).padStart(8, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`,
        lanes[i % lanes.length], { repo: `bp-${String(r).padStart(2, '0')}-${'x'.repeat(r % 7)}` }));
    }
  }
  return out;
};

const worldBoard = () => {
  const mine = ['needs_you', 'running', 'open_pr', 'jail', 'graveyard', 'idle', 'valhalla', 'errored']
    .map((lane, i) => row(`local_dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`, lane, { repo: 'mine' }));
  const other = ['running', 'running', 'your_turn', 'graveyard', 'castle', 'recent']
    .map((lane, i) => row(`local_eeeeeeee-0000-4000-8000-${String(i).padStart(12, '0')}`, lane, { repo: 'other' }));
  const none = [row(`local_ffffffff-0000-4000-8000-000000000000`, 'running')];
  return { mine, other, none, all: [...mine, ...other, ...none] };
};

check('hovering an island names it and reports the point above its sand; a click goes in, and Escape comes back out', () => {
  const { all } = worldBoard();
  const v = makeVillage({ mode: 'world' });
  v.village.update(board(all));
  eq(v.village.getScene(), 'world', 'world mode starts on the map');
  eq(v.village.getIsland(), null, 'with no island open');
  const islands = v.village.islands();
  eq(islands.map((i) => i.repo), ['mine', 'other', ''], 'one island per repo, the no-repo one last');
  const mine = islands[0];
  v.fire('pointermove', mine.cx, mine.cy);
  eq(v.hoveredId(), V.islandHoverId('mine'), 'the island under the pointer is named');
  const point = v.log.hovers[v.log.hovers.length - 1].point;
  near(point.x, mine.cx, 0.01, 'the point sits on its centre line');
  near(point.y, mine.cy - mine.ry - mine.halo, 0.01, 'at the top of its shallow ring, so a tooltip clears the island');
  // The open sea answers nothing, so a click out there does not wander into the nearest island.
  v.fire('pointermove', 1580, 880);
  eq(v.hoveredId(), null, 'the sea is not an island');
  // Including the sea inside the hit ellipse, which is where the bays are. `worldHit` answered the bare ellipse
  // while every ring drawn is the wobble, so a pointer 45 px out on plain deep water named an island and lit a
  // ring nowhere near it. The far canvas corner cannot see that: it is outside the ellipse too.
  for (const is of islands) {
    const n = V.islandSteps(is.ry);
    const w = [...V.islandWobble(is.repo, n)];
    const worst = w.indexOf(Math.min(...w));
    const a = (worst / n) * Math.PI * 2;
    // Nine tenths of the way out to the ellipse along the deepest bay's own ray: well outside the painted
    // shallow ring at 0.79 of it, and well inside the ellipse the hit test used to answer.
    const px = is.cx + Math.cos(a) * (is.rx + is.halo) * 0.94;
    const py = is.cy + Math.sin(a) * (is.ry + is.halo) * 0.94;
    const onBoard = px >= is.sign[0] && px <= is.sign[0] + is.sign[2] && py >= is.sign[1] && py <= is.sign[1] + is.sign[3];
    if (onBoard) continue;
    v.fire('pointermove', px, py);
    eq(v.hoveredId(), null, `${is.repo}: the bay at ${rnd2(px)},${rnd2(py)} is open water, ${rnd2((1 - Math.min(...w)) * 100)}% in`);
    // And the coast itself still answers, so the bay probe is not just a smaller island.
    v.fire('pointermove', is.cx + Math.cos(a) * is.rx * 0.5, is.cy + Math.sin(a) * is.ry * 0.5);
    eq(v.hoveredId(), V.islandHoverId(is.repo), `${is.repo}: its own sand still answers`);
  }
  // Its name board answers too, which is where the counts are read.
  v.fire('pointermove', mine.sign[0] + 4, mine.sign[1] + mine.sign[3] - 2);
  eq(v.hoveredId(), V.islandHoverId('mine'), 'the name board belongs to its island');
  v.click(mine.cx, mine.cy);
  eq(v.village.getScene(), 'village', 'a click goes inside');
  eq(v.village.getIsland(), 'mine', 'and that is the island now open');
  eq(v.log.islands, ['mine'], 'the page is told which island');
  eq(v.log.scenes, ['village'], 'and which scene');
  // The interiors are still reachable from inside an island, and leaving one comes back to the island.
  v.village.enterCottages();
  eq(v.village.getScene(), 'cottages', 'the cottage room opens inside the island');
  v.village.leaveScene();
  eq([v.village.getScene(), v.village.getIsland()], ['village', 'mine'], 'and closes back onto the island');
  v.village.leaveScene();
  eq([v.village.getScene(), v.village.getIsland()], ['world', null], 'leaving the island returns to the world');
  eq(v.log.islands, ['mine', null], 'and the page is told');
  v.village.leaveScene();
  eq(v.village.getScene(), 'world', 'and the world map does not go anywhere');
  v.village.destroy();
});

check('an interior opened from the world map closes back onto it, and no order of the exits leaves a scene that disagrees with itself', () => {
  const { all } = worldBoard();
  // Straight off the map, with no island open: closing onto 'village' drew every repo as one village while world
  // mode had nothing open and the page's scene bar showed nothing at all.
  const v = makeVillage({ mode: 'world' });
  v.village.update(board(all));
  v.village.enterCottages();
  eq(v.village.getScene(), 'cottages', 'the room opens from the map');
  v.village.leaveScene();
  eq([v.village.getScene(), v.village.getIsland()], ['world', null], 'and closes back onto the map');
  v.village.enterCastle();
  v.village.leaveScene();
  eq([v.village.getScene(), v.village.getIsland()], ['world', null], 'and so does the hall');
  v.village.destroy();

  // Every three-step order of the eight ways in and out. All four interior calls are exported and the page already
  // uses the leave half, so an unreachable-by-clicking hole here is one call away from being reachable.
  const steps = {
    'mode village': (x) => x.setMode('village'),
    'mode world': (x) => x.setMode('world'),
    'open mine': (x) => x.openIsland('mine'),
    'open other': (x) => x.openIsland('other'),
    'leave island': (x) => x.leaveIsland(),
    'enter castle': (x) => x.enterCastle(),
    'enter cottages': (x) => x.enterCottages(),
    'leave scene': (x) => x.leaveScene(),
  };
  const names = Object.keys(steps);
  const bad = [];
  let orders = 0;
  for (const a of names) {
    for (const b of names) {
      for (const c of names) {
        const w = makeVillage({ mode: 'world' });
        w.village.update(board(all));
        for (const name of [a, b, c]) steps[name](w.village);
        const [mode, scene, island] = [w.village.getMode(), w.village.getScene(), w.village.getIsland()];
        orders += 1;
        // The map is world mode with nothing open; a village is either one village or an open island; and an
        // island only ever exists in world mode.
        const ok = (scene !== 'world' || (mode === 'world' && island === null))
          && (scene !== 'village' || mode === 'village' || island !== null)
          && (island === null || mode === 'world');
        if (!ok) bad.push(`${a} / ${b} / ${c} -> ${mode} ${scene} ${JSON.stringify(island)}`);
        w.village.destroy();
      }
    }
  }
  eq(orders, names.length ** 3, 'every order was tried');
  eq(bad, [], `orders that end in a scene that disagrees with itself: ${bad.slice(0, 4).join('; ')}`);
});

check('nothing the world map paints leaves the island\'s own box, hover ring and all', () => {
  // The layout promises this structurally rather than by measurement, so a drawn thing it does not budget for is
  // exactly the case no box check was looking at. The hover ring was drawn 5 px outside `box` and escaped its cell
  // on a crowded map, which is why the stroke's own width is measured here and not just its path.
  const { all } = worldBoard();
  const shapes = [];
  let g = null;
  withFrameLoop((loop) => {
    g = geometryVillage(shapes, { mode: 'world' });
    g.village.update(board(all));
    loop.pump(0.2);
    const hovered = g.village.islands()[0];
    shapes.length = 0;
    g.listeners.get('pointermove')({ clientX: hovered.cx, clientY: hovered.cy, isPrimary: true, pointerType: 'mouse' });
    loop.pump(0.2);
    // The strokes centred on the island and reaching past its sand: the two the hover highlight draws, and only
    // those. Identified by geometry rather than by colour so a restyle cannot make this check stop looking.
    // Matched against the ring's own computed shape, not a centred box: the ring follows the wobbled coastline
    // now, so its bounding box is deliberately off-centre and the centroid test this check used to run found
    // nothing at all. Still geometry rather than colour, so a restyle cannot make it stop looking.
    const want = polyBox(V.islandCoast(hovered, hovered.halo - 1.5));
    const ring = shapes.filter((s) => s.kind === 'stroke'
      && Math.abs(s.box[0] - want[0]) < 0.6 && Math.abs(s.box[1] - want[1]) < 0.6
      && Math.abs(s.box[2] - want[2]) < 0.6 && Math.abs(s.box[3] - want[3]) < 0.6);
    assert(ring.length >= 1, `the hover ring reaches the canvas (${shapes.length} shapes)`);
    for (const s of ring) {
      // box is [minX, minY, maxX, maxY] here, grown by half the stroke, which is what is actually painted.
      const half = s.lw / 2;
      const painted = [s.box[0] - half, s.box[1] - half, s.box[2] - s.box[0] + s.lw, s.box[3] - s.box[1] + s.lw];
      assert(inBox(painted, hovered.box, 0.01), `the painted ring ${painted.map(rnd2)} leaves box ${hovered.box.map(rnd2)}`);
      assert(inBox(painted, hovered.cell, 0.01), `the painted ring leaves its cell ${hovered.cell.map(rnd2)}`);
    }
    g.village.destroy();
  });
});

check('a repo whose sessions have all aged into the graveyard still gets an island of its own colour', () => {
  // `worldRepos` counts graveyard rows and `repoNamesInView` deliberately drops them, so an island existed for a
  // repo with no palette entry and took the no-repo chalk: two islands the same grey, one of them the No repo one.
  // A repo finished with, whose rows have all aged out, is an ordinary state rather than a corner.
  const rows = [
    row('local_11111111-0000-4000-8000-000000000001', 'graveyard', { repo: 'ghosttown' }),
    row('local_22222222-0000-4000-8000-000000000002', 'running', { repo: '' }),
    row('local_33333333-0000-4000-8000-000000000003', 'running', { repo: 'alive' }),
  ];
  const shapes = [];
  withFrameLoop((loop) => {
    const g = geometryVillage(shapes, { mode: 'world', reduce: true });
    g.village.update(board(rows));
    loop.pump(0.2);
    const islands = g.village.islands();
    eq(islands.map((is) => is.repo), ['alive', 'ghosttown', ''], 'the graveyard-only repo has an island');
    // The flag's banner: the repo's colour is an accent now rather than the island's whole ground, and the banner
    // is the one piece of it every island carries at every size. Found by its own box, so a restyle of the fill
    // cannot make this stop looking. `flag.band` is the drawn polygon's box, swallowtail and all.
    const ground = (is) => {
      const band = V.islandScene(is).flag.band;
      const hit = shapes.filter((s) => s.kind === 'fill'
        && Math.abs(s.box[0] - band[0]) < 0.6 && Math.abs(s.box[1] - band[1]) < 0.6
        && Math.abs(s.box[2] - (band[0] + band[2])) < 0.6 && Math.abs(s.box[3] - (band[1] + band[3])) < 0.6);
      assert(hit.length, `${JSON.stringify(is.repo)} draws its flag`);
      return hit[hit.length - 1].style;
    };
    const colours = islands.map(ground);
    eq(new Set(colours).size, 3, `three islands, three colours: ${JSON.stringify(colours)}`);
    eq(colours[2], V.NO_REPO_COLOUR.light, 'the chalk belongs to the No repo island');
    // And the repo with a body on the board still wears exactly what that body wears, which is the invariant the
    // legend is built on: the page is handed `repoColour` and has to agree with the map.
    eq(colours[0], V.repoColour('alive', V.repoNamesInView(rows)).light, 'alive matches its own characters');
    g.village.destroy();
  });
});

check('island names that differ are drawn differently, however long a prefix they share', () => {
  // Repo names in one org share long prefixes, and the tail truncation every other plate uses drew three of
  // Charlie's own repos as one string from 27 repos up. Nothing else tells two islands apart: the palette repeats.
  const names = ['wonderful-things-core', 'wonderful-things-plc', 'wonderful-things-embed'];
  const drawnNames = (n, perChar) => {
    const texts = [];
    withFrameLoop((loop) => {
      const v = makeVillage({ mode: 'world', texts, measure: true, perChar });
      v.village.start();
      v.village.update(board(Array.from({ length: n }, (_, i) => row(
        `local_wwwwwwww-0000-4000-8000-${String(i).padStart(12, '0')}`, 'running',
        { repo: i < names.length ? names[i] : `repo-${String(i).padStart(3, '0')}` }))));
      loop.pump(0.2);
      v.village.destroy();
    });
    // The world map draws island names and counts, nothing else, and only these three names start with a w, so a
    // stray word showing up here fails the ownership test below by name rather than going unnoticed.
    return texts.filter((t) => t.startsWith('w'));
  };
  for (const perChar of [7, 7.5, 8, 8.5, 9]) {
    for (const n of [3, 12, 24, 27, 32, 40, 48]) {
      const drawn = drawnNames(n, perChar);
      eq(drawn.length, names.length, `${n} repos at ${perChar} px a char: all three boards carry a name`);
      eq(new Set(drawn).size, names.length, `${n} repos at ${perChar} px a char: ${JSON.stringify(drawn)}`);
      // Each drawn string belongs to exactly one of the three, head and tail: that is what makes it readable as
      // the repo it names rather than merely distinct from its neighbours.
      for (const text of drawn) {
        const [head, tail] = text.split('…');
        const owners = names.filter((name) => name.startsWith(head) && (tail === undefined || name.endsWith(tail)));
        eq(owners.length, 1, `${n} repos at ${perChar}: ${JSON.stringify(text)} names ${JSON.stringify(owners)}`);
      }
    }
  }
});

check('an island draws exactly its own repo\'s rows, and every sign counts that island', () => {
  const { mine, all } = worldBoard();
  // Every sign shows the open island's count, not the board's. Read from the words drawn on the boards, since a
  // sign that counted the whole board would name a number no crowd in front of it could account for.
  const said = (open) => {
    const texts = [];
    withFrameLoop((loop) => {
      const v = makeVillage({ mode: open ? 'world' : 'village', texts, measure: true });
      v.village.start();
      v.village.update(board(all));
      if (open) v.village.openIsland(open);
      loop.pump(0.2);
      v.village.destroy();
    });
    return texts;
  };
  // The board holds four Workshop rows (one of mine's, two of other's and the one with no repo) and two graveyard
  // rows, one each.
  const whole = said(null);
  const cell = (words, name) => words.slice(words.indexOf(name) + 1).find((s) => /^\d+$/.test(s));
  eq(cell(said('mine'), 'The Workshop'), '1', 'the Workshop counts this island only');
  eq(cell(whole, 'The Workshop'), '4', 'and the whole board when the whole board is on screen');
  eq(cell(said('mine'), 'Graveyard'), '1', 'the graveyard is per island');
  eq(cell(whole, 'Graveyard'), '2', 'and per board in one village');
  eq(cell(said('other'), 'The Workshop'), '2', "the other island counts its own");
  // And nobody else's rows are drawn. A body carries its repo colour, so a foreign body would show up as one.
  const painted = paintedShapes(all, { mode: 'world', open: 'mine' });
  eq([painted.scene, painted.island], ['village', 'mine'], 'the island is what is on screen');
  const frame = lastFrame(painted.shapes);
  const index = V.repoColourIndices(V.repoNamesInView(all));
  const mineHex = V.REPO_PALETTE[index.get('mine')].light;
  const otherHex = V.REPO_PALETTE[index.get('other')].light;
  const bodies = (hex) => frame.filter((s) => s.kind === 'fill' && s.style === hex && s.box[2] - s.box[0] >= 20 * s.scale);
  eq(bodies(otherHex).length, 0, "no other repo's body is drawn inside this island");
  // mine has 8 rows: one in the graveyard (a headstone, no colour) and one in no room place, so 7 stand about.
  const stands = mine.filter((s) => s.lane !== 'graveyard' && !V.isRoomPlace(V.placeForLane(s.lane)));
  eq(bodies(mineHex).length, stands.length, `every standing row of mine is drawn (${stands.length})`);
  // Each one stands where the layout of this island's rows alone puts it.
  const slots = [...V.layoutVillage(stands).values()].map((s) => `${Math.round(s.x)},${Math.round(s.y)}`).sort();
  const drawn = bodies(mineHex).map((s) => `${Math.round((s.box[0] + s.box[2]) / 2)},${Math.round(s.box[3])}`);
  for (const at of drawn) {
    const [x, y] = at.split(',').map(Number);
    assert(slots.some((s) => {
      const [sx, sy] = s.split(',').map(Number);
      return Math.abs(sx - x) <= 3 && Math.abs(sy - y) <= 60;
    }), `a body at ${at} stands on one of this island's slots: ${slots.join(' | ')}`);
  }
});

check('an island is the same layout engine on its own rows: every place guarantee comes with it', () => {
  const LANES = ['needs_you', 'your_turn', 'errored', 'stopped', 'running', 'open_pr', 'jail', 'valhalla'];
  for (const n of [0, 1, 5, 13, 20]) {
    for (const big of [false, true]) {
      const tokens = big ? MAX_TOKENS : undefined;
      const mineRows = Array.from({ length: n }, (_, i) => row(
        `local_11111111-0000-4000-8000-${String(i).padStart(12, '0')}`, LANES[i % LANES.length],
        tokens ? { repo: 'mine', tokens } : { repo: 'mine' }));
      // One row indoors, so the island exists even at 0 standing rows: an island is only ever a repo with rows.
      const resident = row('local_11111111-0000-4000-8000-000000000999', 'idle', { repo: 'mine' });
      const noise = Array.from({ length: 17 }, (_, i) => row(
        `local_22222222-0000-4000-8000-${String(i).padStart(12, '0')}`, LANES[i % LANES.length],
        tokens ? { repo: 'noise', tokens } : { repo: 'noise' }));
      const alone = V.layoutVillage(mineRows);
      const together = V.layoutVillage([...mineRows, ...noise]);
      // The filter is what makes every place per island: with the island open, the rows laid out are its rows
      // alone, so the caps, capacities, clearances and no-overlap guarantees are the ones already checked for a
      // board of that size. A crowded board must not be what an island of one row is laid out against.
      if (n > 1 && big) {
        const same = [...alone.keys()].every((id) => alone.get(id).cap === together.get(id).cap);
        assert(!same, `${n} rows: an island of one repo is not laid out with the other repo's crowd`);
      }
      const painted = paintedShapes([...mineRows, resident, ...noise], { mode: 'world', open: 'mine' });
      eq(painted.island, 'mine', `${n}/${big}: the island stayed open`);
      const index = V.repoColourIndices(V.repoNamesInView([...mineRows, resident, ...noise]));
      const hex = V.REPO_PALETTE[index.get('mine')].light;
      const frame = lastFrame(painted.shapes);
      const bodies = frame.filter((s) => s.kind === 'fill' && s.style === hex && s.box[2] - s.box[0] >= 20 * s.scale);
      eq(bodies.length, n, `${n}/${big}: every standing row of the island is drawn and nothing else`);
      for (const b of bodies) {
        const cx = (b.box[0] + b.box[2]) / 2;
        assert([...alone.values()].some((s) => Math.abs(s.x - cx) <= 3 && b.box[3] >= s.y - 80 && b.box[3] <= s.y + 4),
          `${n}/${big}: a body at ${cx.toFixed(0)},${b.box[3].toFixed(0)} is on a slot of this island alone`);
      }
    }
  }
});

check('the graveyard, the ghosts, the interiors and the beam are all per island', () => {
  const graves = (repo, n, tag) => Array.from({ length: n }, (_, i) => row(
    `local_${tag.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`, 'graveyard', { repo }));
  const idlers = (repo, n, tag) => Array.from({ length: n }, (_, i) => row(
    `local_${tag.repeat(8)}-0000-4000-8000-${String(i + 500).padStart(12, '0')}`, 'idle', { repo }));
  // 60 graves on one island asks for five ghosts, one grave on the other asks for two: a shared graveyard would
  // show the same number on both.
  const rows = [...graves('big', 60, '3'), ...graves('small', 1, '4'), ...idlers('big', 9, '5'), ...idlers('small', 2, '6')];
  const counts = {};
  for (const repo of ['big', 'small']) {
    const painted = paintedShapes(rows, { mode: 'world', open: repo });
    const frame = lastFrame(painted.shapes);
    counts[repo] = ghostBodies(frame).length;
  }
  eq(counts.big, V.ghostsFor(60).length, 'the busy island shows its own ghosts');
  eq(counts.small, V.ghostsFor(1).length, 'and the quiet one shows its own');
  assert(counts.big > counts.small, 'which is not the same number');
  // The cottage room holds that island's idle rows, and wanders at up to 24 fps only while it is open.
  for (const [repo, n] of [['big', 9], ['small', 2]]) {
    const v = makeVillage({ reduce: false, mode: 'world' });
    withFrameLoop((loop) => {
      v.village.start();
      v.village.update(board(rows));
      v.village.openIsland(repo);
      v.village.enterCottages();
      const inside = loop.pump(2).frames;
      assert(inside > 2 / (V.HALL_FRAME_MS / 1000) * 0.6 && inside <= 2 / (V.HALL_FRAME_MS / 1000) + 2,
        `${repo}: the room wanders at up to 24 fps (${inside} frames in 2 s)`);
      v.village.leaveScene();
      const back = loop.pump(2).frames;
      assert(back <= 2 / (V.AMBIENT_FRAME_MS / 1000) + 2, `${repo}: back on the island it is ambient again (${back} frames)`);
      v.village.destroy();
    });
    // The room holds exactly that island's idle rows.
    const painted = paintedShapes(rows, { mode: 'world', open: repo });
    eq(painted.islandList.find((i) => i.repo === repo).lanes.idle, n, `${repo}: its own idle count`);
  }
  // The beam still rides the ambient tick inside an island, with a full graveyard and a crowded harbour.
  const busy = [...graves('big', 157, '7'),
    ...Array.from({ length: 8 }, (_, i) => row(`local_88888888-0000-4000-8000-${String(i).padStart(12, '0')}`, 'open_pr', { repo: 'big' }))];
  const quiet = paintedShapes(busy, { reduce: false, dark: true, seconds: 3, settle: 3, mode: 'world', open: 'big' });
  eq(quiet.island, 'big', 'the island stayed open');
  assert(quiet.frames <= 3 * 13, `inside an island the beam rides the ambient tick (${quiet.frames} frames in 3 s)`);
  assert(quiet.frames >= 24, `and the ambient tick is still running (${quiet.frames} frames in 3 s)`);
  results.islandGhosts = counts;
});

check('the world map draws at the ambient rate at rest, and holds still under reduced motion', () => {
  const { all } = worldBoard();
  const moving = paintedShapes(all, { reduce: false, seconds: 3, settle: 1, mode: 'world' });
  eq(moving.scene, 'world', 'the map is what is on screen');
  assert(moving.frames <= 3 * 13, `the world map is ambient at most (${moving.frames} frames in 3 s)`);
  assert(moving.frames >= 24, `and it does keep ticking (${moving.frames} frames in 3 s)`);
  // What one frame paints, so the art cannot get more expensive without saying so. Islands are drawn per frame
  // (the sea is the only cached layer, and which repos exist changes with the board), so this is the map's whole
  // per-frame cost. Measured on the 48-repo case as well, which is the most islands the layout is designed for.
  const perFrame = (n) => {
    const shapes = [];
    let frames = 0;
    withFrameLoop((loop) => {
      // Not reduced: reduced motion draws on demand, so a pump paints nothing and the count is zero.
      const g = geometryVillage(shapes, { mode: 'world', reduce: false });
      g.village.update(board(artRows(n)));
      loop.pump(0.3);
      shapes.length = 0;
      frames = Math.max(1, loop.pump(2).frames);
      g.village.destroy();
    });
    const text = shapes.filter((s) => s.kind === 'text').length;
    return {
      all: +(shapes.length / frames).toFixed(1),
      paths: +((shapes.length - text) / frames).toFixed(1),
      text: +(text / frames).toFixed(1),
    };
  };
  const split = { 1: perFrame(1), 12: perFrame(12), 48: perFrame(48) };
  const cost = Object.fromEntries(Object.entries(split).map(([k, v]) => [k, v.all]));
  assert(cost[48] <= 2600, `a 48-repo map paints ${cost[48]} shapes a frame`);
  // What the count is: every fill, stroke, fillRect and string, on the `artRows` board, averaged over the frames
  // of a 2 s pump.
  // Under reduced motion the water stops: two frames a second apart are the same shapes.
  const still = paintedShapes(all, { reduce: true, seconds: 2, settle: 0.5, mode: 'world' });
  const one = lastFrame(still.shapes, 'day', WORLD_WATER_HEX.day);
  assert(one.length > 10, `the map is drawn at all (${one.length} shapes)`);
  const before = still.shapes.slice(0, still.shapes.length - one.length);
  const earlier = lastFrame(before, 'day', WORLD_WATER_HEX.day);
  if (earlier.length) {
    eq(one.map((s) => `${s.kind}|${s.style}|${s.box.map((v) => v.toFixed(2)).join(',')}`),
      earlier.map((s) => `${s.kind}|${s.style}|${s.box.map((v) => v.toFixed(2)).join(',')}`),
      'reduced motion draws the same map every frame');
  }
  // Nothing on the map is in the motion planner, so the rate cannot be lifted by an island.
  const hovered = makeVillage({ reduce: false, mode: 'world' });
  withFrameLoop((loop) => {
    hovered.village.start();
    hovered.village.update(board(all));
    const mine = hovered.village.islands()[0];
    let swept = 0;
    const frames = loop.pump(2, () => {
      swept += 1;
      hovered.fire('pointermove', mine.cx + (swept % 7) - 3, mine.cy + (swept % 5) - 2);
    }).frames;
    assert(frames <= 2 / (V.AMBIENT_FRAME_MS / 1000) + 2, `sweeping the map never lifts the rate (${frames} frames in 2 s)`);
    hovered.village.destroy();
  });
});

check('only the scene on screen is drawn, and a merge nobody can see never lifts the frame rate', () => {
  const { all } = worldBoard();
  const words = (open) => {
    const out = [];
    withFrameLoop((loop) => {
      const v = makeVillage({ mode: 'world', texts: out, measure: true });
      v.village.start();
      v.village.update(board(all));
      if (open) v.village.openIsland(open);
      loop.pump(0.3);
      v.village.destroy();
    });
    return out;
  };
  const map = words(null);
  for (const name of ['The Porch', 'The Workshop', 'The Harbour', 'Valhalla beach', 'The Jail', 'The Cottages', 'Graveyard']) {
    assert(!map.includes(name), `the world map does not draw ${name}`);
  }
  for (const name of ['mine', 'other', V.NO_REPO_LABEL]) assert(map.includes(name), `it draws ${name}'s island: ${map}`);
  const inside = words('mine');
  for (const name of ['The Porch', 'The Workshop', 'The Harbour']) assert(inside.includes(name), `inside an island ${name} is drawn`);
  for (const name of ['other', V.NO_REPO_LABEL]) assert(!inside.includes(name), `and no other island is drawn over it (${name})`);
  // A merge arriving while the map is up is placed rather than sailed, so nothing plans a voyage nobody can see.
  withFrameLoop((loop) => {
    const v = makeVillage({ reduce: false, mode: 'world' });
    v.village.start();
    v.village.update(board([row(A, 'open_pr', { repo: 'mine' })]));
    loop.pump(0.5);
    v.village.update(board([row(A, 'valhalla', { repo: 'mine' })]));
    const frames = loop.pump(3).frames;
    assert(frames <= 3 / (V.AMBIENT_FRAME_MS / 1000) + 2, `a merge on the map never lifts the rate (${frames} frames in 3 s)`);
    v.village.destroy();
  });
});

check('a repo leaving the board takes its island with it, and the mode toggle never loses the selection', () => {
  const { mine, other, none, all } = worldBoard();
  const v = makeVillage({ mode: 'world' });
  v.village.update(board(all));
  v.village.openIsland('other');
  v.village.setSelected(other[0].id);
  eq([v.village.getScene(), v.village.getIsland()], ['village', 'other'], 'other is open');
  v.village.update(board([...mine, ...none]));
  eq([v.village.getScene(), v.village.getIsland()], ['world', null], 'its repo has gone, so the world map comes back');
  eq(v.log.islands, ['other', null], 'and the page is told, once each way');
  // Switching modes keeps the selected session, whichever way it goes.
  v.village.update(board(all));
  v.village.openIsland('mine');
  v.village.setSelected(mine[1].id);
  v.village.setMode('village');
  eq([v.village.getMode(), v.village.getScene(), v.village.getIsland()], ['village', 'village', null], 'one village shows everything');
  eq(v.village.islands(), [], 'and has no islands');
  v.village.setMode('world');
  eq([v.village.getScene(), v.village.getIsland()], ['village', 'mine'], 'and the world remembers the island last open');
  // Walking out of an island says you are done with it, so the round-trip above must not bring it back. The page
  // forgets its own stored choice on the same exits, and two memories that disagree land a reader on an island
  // they had deliberately left.
  v.village.leaveIsland();
  v.village.setMode('village');
  v.village.setMode('world');
  eq([v.village.getScene(), v.village.getIsland()], ['world', null], 'an island left on purpose stays left');
  v.village.openIsland('mine');
  v.village.setMode('village');
  v.village.update(board([...other, ...none]));
  v.village.setMode('world');
  eq([v.village.getScene(), v.village.getIsland()], ['world', null], 'an island whose repo has gone falls back to the map');
  // Nor does it come back when its repo does: the fallback forgot it, the same way an exit does.
  v.village.update(board(all));
  v.village.setMode('village');
  v.village.setMode('world');
  eq([v.village.getScene(), v.village.getIsland()], ['world', null], 'and a repo returning does not reopen it');
  v.village.destroy();
  // An island named at creation is opened on the first board, and an unknown one leaves the map showing.
  const back = makeVillage({ mode: 'world', island: 'other' });
  back.village.update(board(all));
  eq([back.village.getScene(), back.village.getIsland()], ['village', 'other'], 'remembered between visits');
  back.village.destroy();
  const gone = makeVillage({ mode: 'world', island: 'no-such-repo' });
  gone.village.update(board(all));
  eq([gone.village.getScene(), gone.village.getIsland()], ['world', null], 'an unknown island is the world map');
  gone.village.destroy();
  // The no-repo island opens like any other, and an unknown repo asked for by hand falls back to the map.
  const spare = makeVillage({ mode: 'world' });
  spare.village.update(board(all));
  spare.village.openIsland(V.NO_REPO_KEY);
  eq([spare.village.getScene(), spare.village.getIsland()], ['village', ''], 'the no-repo island opens');
  spare.village.openIsland('nope');
  eq([spare.village.getScene(), spare.village.getIsland()], ['world', null], 'and an unknown one does not');
  // In one village mode the island calls do nothing at all.
  spare.village.setMode('village');
  spare.village.openIsland('mine');
  eq(spare.village.getMode(), 'world', 'openIsland is a request for the world');
  spare.village.setMode('village');
  spare.village.leaveIsland();
  eq([spare.village.getMode(), spare.village.getScene()], ['village', 'village'], 'and leaveIsland in one village does nothing');
  spare.village.setMode('nonsense');
  eq(spare.village.getMode(), 'village', 'an unknown mode is refused');
  spare.village.destroy();
});

// One village mode has to be the scene it has always been, shape for shape and word for word. The two digests below
// were taken from the village before the world of islands was written; a change to either is either a regression
// from this work or a deliberate change to the village, and then these literals move with it.
// ---------- the islands' own art ----------

// Every colour an island can paint under itself, day and dusk, so a check can ask what the art sits on.
const ISLAND_BACKDROPS = {
  day: { grass: '#b8caa1', grassDark: '#a8bc90', sandLight: '#f0e5c8', sandWet: '#d9c9a3', shallow: '#b9d7d6', water: '#a3c7cc', waterDeep: '#91b9c0' },
  dusk: { grass: '#2d3b32', grassDark: '#27332b', sandLight: '#595241', sandWet: '#474135', shallow: '#2c4650', water: '#243a46', waterDeep: '#1d313c' },
};
const SIGN_BOARD = { day: '#ebdec4', dusk: '#d9caab' };
const BADGE_HEX = V.WORLD_BADGE_LANES.map((lane) => V.STATE[lane].color);
// Every reserved state colour, fill and border, as the badges draw them: what the art must never use.
const RESERVED_HEX = new Set(Object.values(V.STATE).flatMap((s) => [s.color, s.border]).map((h) => h.toLowerCase()));
const islandArea = (is) => Math.PI * is.rx * is.ry;
const accentOf = (is) => V.islandScene(is).accent;
// Counts spread over every tier the silhouette has, plus a board the size of Charlie's.
const artEntries = (n, counts = null) => Array.from({ length: n }, (_, i) => ({
  repo: `bp-${String(i).padStart(2, '0')}-${'x'.repeat(i % 7)}`,
  count: counts ? counts[i % counts.length] : (i === 0 ? 246 : [1, 2, 4, 9, 12, 40, 60, 90][i % 8]),
  lanes: { needs_you: 11, your_turn: 2, errored: 1, open_pr: 7, jail: 3 },
}));

check('an island keeps one coastline per repo, and it is a coastline rather than an ellipse', () => {
  // The wobble is what stops the map reading as lily pads, and it has two jobs at once: it has to bite hard enough
  // to look drawn, and it has to peak at exactly 1 so every ring stays inside the ellipse `worldLayout` budgeted.
  const islands = V.worldLayout(artEntries(12));
  const shapes = new Set();
  for (const is of islands) {
    const n = V.islandSteps(is.ry);
    const w = [...V.islandWobble(is.repo, n)];
    eq([...V.islandWobble(is.repo, n)], w, `${is.repo}: the same repo asks for the same wobble`);
    const first = V.islandCoast(is, 0);
    const again = V.islandCoast(V.worldLayout(artEntries(12)).find((o) => o.repo === is.repo), 0);
    eq(again.map((p) => p.map(rnd5)), first.map((p) => p.map(rnd5)), `${is.repo}: the coast is the same between visits`);
    const top = Math.max(...w);
    assert(Math.abs(top - 1) < 1e-12, `${is.repo}: the coast peaks at 1, not ${top} (a ring past 1 leaves the box)`);
    const low = Math.min(...w);
    assert(low <= 1 - 0.08, `${is.repo}: the coast only varies by ${rnd2((1 - low) * 100)}%, which reads as an ellipse`);
    shapes.add(w.map((k) => k.toFixed(4)).join(','));
  }
  eq(shapes.size, islands.length, 'twelve repos, twelve different coastlines');
});

check('nothing an island paints leaves its own box or its own cell, at 1 to 240 repos and in both themes', () => {
  // The layout's promise is structural: a cell per island, and everything inside it. Art is the first thing drawn
  // on an island that the layout does not itself compute, so every shape of it is measured here against both.
  // Text counts: the numeral and the repo name are the two things that must stay legible and the likeliest
  // to overflow, and geometrySpy could not see them at all when this check was written.
  const measured = {};
  const ink = {};
  for (const n of [1, 2, 3, 6, 12, 24, 48, 100, 240]) {
    for (const dark of [false, true]) {
      const shapes = [];
      withFrameLoop((loop) => {
        darkMode = dark;
        try {
          const g = geometryVillage(shapes, { mode: 'world', reduce: true });
          g.village.update(board(artRows(n)));
          loop.pump(0.2);
          const hovered = g.village.islands()[0];
          shapes.length = 0;
          g.listeners.get('pointermove')({ clientX: hovered.cx, clientY: hovered.cy, isPrimary: true, pointerType: 'mouse' });
          loop.pump(0.2);
          const islands = g.village.islands();
          let checked = 0;
          let words = 0;
          for (const s of shapes) {
            const half = (s.kind === 'stroke' ? s.lw : 0) / 2;
            const painted = [s.box[0] - half, s.box[1] - half, s.box[2] - s.box[0] + s.lw * (s.kind === 'stroke' ? 1 : 0), s.box[3] - s.box[1] + s.lw * (s.kind === 'stroke' ? 1 : 0)];
            const mid = [(painted[0] + painted[2] / 2), (painted[1] + painted[3] / 2)];
            // The full-canvas water clear and the edge ring are the board's, not an island's.
            if (painted[2] > 1400 || painted[3] > 800) continue;
            const own = islands.find((is) => mid[0] >= is.cell[0] && mid[0] <= is.cell[0] + is.cell[2]
              && mid[1] >= is.cell[1] && mid[1] <= is.cell[1] + is.cell[3]);
            assert(own, `${n}/${dark ? 'dusk' : 'day'}: a ${s.kind} at ${mid.map(rnd2)} is in no island's cell`);
            assert(inBox(painted, own.box, 0.02), `${n}/${dark ? 'dusk' : 'day'}: ${own.repo} paints ${s.kind} ${painted.map(rnd2)} outside box ${own.box.map(rnd2)}`);
            assert(inBox(painted, own.cell, 0.02), `${n}/${dark ? 'dusk' : 'day'}: ${own.repo} paints ${s.kind} outside cell ${own.cell.map(rnd2)}`);
            checked += 1;
            if (s.kind === 'text') words += 1;
          }
          assert(checked > n * 12, `${n}: only ${checked} shapes measured, the art cannot be drawn`);
          // Every island draws its count, and every island whose board still has room draws its name, so a board
          // with no text at all means the numeral and the name slipped past this check rather than fitting.
          assert(words >= n, `${n}/${dark ? 'dusk' : 'day'}: only ${words} strings measured for ${n} islands`);
          if (!dark) {
            measured[n] = checked;
            ink[n] = words;
          }
          g.village.destroy();
        } finally {
          darkMode = false;
        }
      });
    }
  }
  results.islandShapes = measured;
  results.islandText = ink;
});

check('the repo accent is there at every size, and no two repos are confusable on it', () => {
  // A flat disc of the repo colour identified the repo and looked like a pie chart. The accent has to do the same
  // job on a shoreline, a banner and a roof, so the numbers that carry it are its area and its separation.
  let minFraction = 1;
  for (const n of [1, 2, 3, 6, 12, 24, 48]) {
    const islands = V.worldLayout(artEntries(n));
    for (const is of islands) {
      const a = accentOf(is);
      assert(a.total > 0, `${n}/${is.repo}: no accent at all`);
      assert(a.shore > 0 && a.banner > 0, `${n}/${is.repo}: shore ${rnd2(a.shore)} banner ${rnd2(a.banner)}`);
      minFraction = Math.min(minFraction, a.total / islandArea(is));
    }
  }
  // Separation. The accent is the palette entry undiluted, so the palette's own floors are the accent's floors,
  // and what is new is only what it sits on: the sea, the sand and the grass.
  const pairs = { day: Infinity, dusk: Infinity };
  const eitherOr = { day: Infinity, dusk: Infinity };
  // The tideline is the majority of the accent's area at every size and it is stroked entirely on the sand, so
  // that pair is checked on its own, fill-or-rim. The fill alone reaches 8.15 (the No repo chalk by day), which
  // is why the tideline is stroked twice like the banner and the roofs.
  const shoreEither = { day: Infinity, dusk: Infinity };
  const entries = [...V.REPO_PALETTE, V.NO_REPO_COLOUR];
  const chalk = { day: Infinity, dusk: Infinity };
  for (const theme of ['day', 'dusk']) {
    const pick = (e) => (theme === 'day' ? e.light : e.dark);
    const rim = (e) => (theme === 'day' ? e.lightEdge : e.darkEdge);
    for (const e of entries) {
      // The No repo chalk keeps its own lower floor, as it always has: its island is the one with "No repo" on
      // its board, so it is told apart by a name rather than only by a colour.
      for (const o of V.REPO_PALETTE) {
        if (o === e) continue;
        const d = de00(pick(e), pick(o));
        if (e === V.NO_REPO_COLOUR) chalk[theme] = Math.min(chalk[theme], d);
        else pairs[theme] = Math.min(pairs[theme], d);
      }
      for (const [name, hex] of Object.entries(ISLAND_BACKDROPS[theme])) {
        const d = de00(pick(e), hex);
        // Either the banner's own fill or the rim it is drawn with has to carry it: `No repo`'s dusk rim is close
        // to the dusk sand, and its fill is a pale chalk that nothing there could be mistaken for.
        eitherOr[theme] = Math.min(eitherOr[theme], Math.max(d, de00(rim(e), hex)));
        if (name.includes('sand')) shoreEither[theme] = Math.min(shoreEither[theme], Math.max(d, de00(rim(e), hex)));
      }
    }
    assert(pairs[theme] >= 20, `${theme}: two repo accents only ${rnd2(pairs[theme])} apart`);
    assert(chalk[theme] >= 12, `${theme}: the chalk only ${rnd2(chalk[theme])} from a repo accent`);
    assert(eitherOr[theme] >= 25, `${theme}: an accent only ${rnd2(eitherOr[theme])} from what it sits on, rim included`);
    assert(shoreEither[theme] >= 25, `${theme}: the tideline only ${rnd2(shoreEither[theme])} from the sand, rim included`);
  }
  assert(minFraction >= 0.03, `the accent falls to ${rnd2(minFraction * 100)}% of an island`);
  // Both strokes of the tideline are drawn, in that order: the check above is a palette fact, and this is the
  // draw. The accent's rim exists in the constants for every entry and was painted for the banner and the roofs
  // but not here, which is what made the fill-or-rim floor untrue of the tideline specifically.
  const shapes = [];
  withFrameLoop((loop) => {
    const g = geometryVillage(shapes, { mode: 'world', reduce: true });
    g.village.update(board(artRows(6)));
    loop.pump(0.2);
    for (const is of g.village.islands()) {
      const sc = V.islandScene(is);
      const col = V.repoColour(is.repo, V.repoNamesInView(artRows(6))) || V.NO_REPO_COLOUR;
      const ring = sc.rings.rim;
      const box = [Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1]))];
      const on = shapes.filter((s) => s.kind === 'stroke' && Math.abs(s.box[0] - box[0]) < 0.6 && Math.abs(s.box[1] - box[1]) < 0.6);
      const styles = on.map((s) => s.style);
      assert(styles.includes(col.light), `${is.repo}: the tideline's fill is not drawn (${JSON.stringify(styles)})`);
      assert(styles.indexOf(col.lightEdge) >= 0 && styles.indexOf(col.lightEdge) < styles.indexOf(col.light),
        `${is.repo}: the tideline's rim is not drawn under its fill (${JSON.stringify(styles)})`);
      const wide = on.find((s) => s.style === col.lightEdge);
      const thin = on.find((s) => s.style === col.light);
      assert(wide.lw > thin.lw, `${is.repo}: the rim stroke ${wide.lw} is not wider than the fill's ${thin.lw}`);
    }
    g.village.destroy();
  });
});

check('what stands on an island grows with its session count, and falls back to a bare rock when it is small', () => {
  // Two axes: more sessions means more to see, and a smaller island means less room to see it in. The second must
  // never undo the first, so a bigger repo can never end up with fewer buildings on the same map.
  const tiers = {};
  let smallest = null;
  const wanted = {};
  const drawn = {};
  for (const n of [1, 2, 3, 6, 12, 24, 48, 64, 100, 240, 400, 600]) {
    const spread = [1, 2, 3, 4, 9, 11, 12, 39, 40, 59, 60, 90, 246];
    const islands = V.worldLayout(artEntries(Math.max(n, spread.length), spread).slice(0, n));
    const byCount = new Map();
    for (const is of islands) {
      const f = V.islandScene(is).features;
      assert(f.rocks >= 1, `${n}/${is.repo}: an island with nothing on it at all`);
      // Drawn against wanted, feature by feature. Reading the thresholds off `islandFeatures` alone measures what
      // an island *wants*, and a monotonicity assertion over the drawn set is satisfied by a feature that is
      // uniformly absent: the second rock sat on the jetty and was dropped on two thirds of islands, and the
      // third was drawn on 2% of the islands that asked for it, with every check green.
      const want = V.islandFeatures(is.count, is.ry);
      for (const k of ['huts', 'rocks', 'jetty', 'lighthouse']) {
        wanted[k] = (wanted[k] || 0) + Number(want[k]);
        drawn[k] = (drawn[k] || 0) + Number(f[k]);
      }
      byCount.set(is.count, f);
      if (!smallest || is.ry < smallest.ry) smallest = { ry: is.ry, f, repos: n };
    }
    // Every feature, not just huts and rocks: the lighthouse was the one that inverted (a 150-session repo lost
    // it while a 60-session one kept it) and it was the one not asserted. Pairwise rather than between neighbours,
    // because an inversion between two islands three rows apart is the one a reader sees side by side.
    const ks = [...byCount.keys()].sort((a, b) => a - b);
    for (let i = 1; i < ks.length; i++) {
      for (let j = 0; j < i; j++) {
        const lo = byCount.get(ks[j]);
        const hi = byCount.get(ks[i]);
        for (const k of ['huts', 'rocks', 'jetty', 'lighthouse']) {
          const a = Number(lo[k]);
          const b = Number(hi[k]);
          assert(b >= a, `${n} repos: ${ks[i]} sessions has ${hi[k]} ${k} where ${ks[j]} has ${lo[k]}`);
        }
      }
    }
    if (n <= 48) {
      tiers[n] = ks.map((c) => {
        const f = byCount.get(c);
        return `${c}:${f.rocks}r${f.huts}h${f.jetty ? 'j' : ''}${f.lighthouse ? 'L' : ''}`;
      }).join(' ');
    }
  }
  // The smallest island a crowded map draws: one rock, a flag and nothing else, whatever the repo's count.
  eq({ huts: smallest.f.huts, jetty: smallest.f.jetty, lighthouse: smallest.f.lighthouse, rocks: smallest.f.rocks },
    { huts: 0, jetty: false, lighthouse: false, rocks: 1 }, `the smallest island (ry ${rnd2(smallest.ry)}) is a bare rock`);
  // One naming scheme is one set of coastlines, and the lighthouse inversion was invisible to this check partly
  // because `artEntries` only ever draws one. These are the schemes and the counts it showed up at, plus this
  // org's own names, which is the board Charlie actually opens.
  const schemes = [
    (i) => `plotgen-${i}`,
    (i) => `analytics-data-${i}`,
    (i) => `org/${String.fromCharCode(97 + (i % 26))}-svc`,
    (i) => `wonderful-things-${'abcdefgh'[i % 8]}`,
    (i) => ['wonderful-things-core', 'plotgen', 'analytics-data', 'tokentown', 'ad-slot-placement',
      'wonderful-things-plc', 'wonderful-things-embed', 'tools', 'report-hub', 'olympus', 'kpi',
      'subscriptions'][i % 12],
  ];
  const spread2 = [1, 2, 3, 4, 9, 11, 12, 39, 40, 59, 60, 90, 150, 246];
  for (const scheme of schemes) {
    for (const n of [2, 3, 4, 6, 8, 12, 16, 24, 32, 48]) {
      const islands = V.worldLayout(Array.from({ length: n }, (_, i) => ({
        repo: scheme(i), count: spread2[i % spread2.length], lanes: { needs_you: 2 },
      })));
      const seen = islands.map((is) => ({ c: is.count, f: V.islandScene(is).features, repo: is.repo, ry: is.ry }));
      for (const a of seen) {
        for (const b of seen) {
          if (a.c >= b.c) continue;
          for (const k of ['huts', 'rocks', 'jetty', 'lighthouse']) {
            assert(Number(b.f[k]) >= Number(a.f[k]),
              `${n} repos: ${b.repo} at ${b.c} sessions (ry ${rnd2(b.ry)}) shows ${b.f[k]} ${k} where `
              + `${a.repo} at ${a.c} (ry ${rnd2(a.ry)}) shows ${a.f[k]}`);
          }
        }
        const want = V.islandFeatures(a.c, a.ry);
        for (const k of ['huts', 'rocks', 'jetty', 'lighthouse']) {
          wanted[k] += Number(want[k]);
          drawn[k] += Number(a.f[k]);
        }
      }
    }
  }
  // A feature an island has the count and the size for is drawn nearly always: what is left is a deep bay or a
  // clash, which is the placement's own design. The rocks and the jetty have no slack at all; the lighthouse
  // stands on the narrowest ground, so a few are still lost to a bay.
  for (const k of ['huts', 'rocks', 'jetty']) {
    assert(drawn[k] === wanted[k], `${k}: ${drawn[k]} drawn of ${wanted[k]} wanted`);
  }
  assert(drawn.lighthouse >= wanted.lighthouse * 0.9,
    `lighthouse: only ${drawn.lighthouse} drawn of ${wanted.lighthouse} wanted`);
  // And the tiers are the count thresholds, read back off the shipped function at a size that has room for all.
  const at = (c) => V.islandFeatures(c, 250);
});

check('the numeral and the name board stay legible, and the badges stay the loudest thing on an island', () => {
  // The count moved off the repo colour and onto the grass, which is the same ink on the same ground whichever
  // entry the repo drew: what was 4.6:1 at worst is now the one pair below.
  const ink = { day: V.INK_DARK, dusk: V.INK_LIGHT };
  const numeral = {};
  for (const theme of ['day', 'dusk']) {
    let low = Infinity;
    for (const g of ['grass', 'grassDark']) low = Math.min(low, contrast(ink[theme], ISLAND_BACKDROPS[theme][g]));
    assert(low >= 7, `${theme}: the numeral is only ${rnd2(low)}:1 on the grass`);
    numeral[theme] = +low.toFixed(2);
  }
  // The grass is what the numeral is meant to sit on, and the row above is a fact about two colours. This is what
  // is actually painted under the glyphs: the topmost shape whose box reaches them, on every island of every
  // board, in both themes. The flag's mast crossed the digits at 2.65:1 from 80 repos before the shaft was cut
  // back to the numeral's top, and a rock still sits under them on a crowded map, which is the floor below.
  // A crowded map where some repos carry three-digit counts, which `artRows` never produces: the numeral is at
  // its 13 px floor and nearly as wide as the island, so this is the board where it collides with the art.
  const wideRows = (n) => {
    const lanes = ['running', 'needs_you', 'open_pr', 'idle', 'jail', 'valhalla', 'your_turn', 'errored'];
    const out = [];
    for (let r = 0; r < n; r++) {
      const per = [246, 150, 108, 60, 12, 4, 2, 1][r % 8];
      for (let i = 0; i < per; i++) {
        out.push(row(`local_${String(r).padStart(8, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`,
          lanes[i % lanes.length], { repo: `bp-${String(r).padStart(2, '0')}-${'x'.repeat(r % 7)}` }));
      }
    }
    return out;
  };
  for (const dark of [false, true]) {
    const theme = dark ? 'dusk' : 'day';
    let low = Infinity;
    let worst = '';
    for (const n of [1, 12, 48, 64, 80, 120]) {
      const shapes = [];
      withFrameLoop((loop) => {
        darkMode = dark;
        try {
          const g = geometryVillage(shapes, { mode: 'world', reduce: true });
          g.village.update(board(wideRows(n)));
          loop.pump(0.2);
          const islands = g.village.islands();
          for (const is of islands) {
            const num = V.islandScene(is).numeral;
            // The glyph ink, not the advance box: the outer side bearings carry no ink, and a shape clipped by
            // them is not under a digit.
            const glyph = [num.x - num.box[2] * 0.45, num.box[1], num.box[2] * 0.9, num.box[3]];
            // A stroke is inflated by its line width, exactly as the box-and-cell check does: the mast is a
            // vertical line, so its path alone is a zero-width box that overlaps nothing and the 2.65:1 pair it
            // painted under the digits was invisible to a check written this way.
            const under = shapes.filter((s) => {
              if (s.kind === 'text' || typeof s.style !== 'string' || !s.style.startsWith('#')) return false;
              const half = (s.kind === 'stroke' ? s.lw : 0) / 2;
              const w = s.box[2] - s.box[0] + (s.kind === 'stroke' ? s.lw : 0);
              const h = s.box[3] - s.box[1] + (s.kind === 'stroke' ? s.lw : 0);
              if (w > 1400) return false;
              return V.boxesOverlap(glyph, [s.box[0] - half, s.box[1] - half, w, h]);
            });
            const topmost = under[under.length - 1];
            if (!topmost) continue;
            const c = contrast(ink[theme], topmost.style);
            if (c < low) {
              low = c;
              worst = `${n} repos, ${topmost.style}`;
            }
          }
          g.village.destroy();
        } finally {
          darkMode = false;
        }
      });
    }
    // Above 4.5:1 everywhere, which is WCAG AA for the 13 px bold the smallest island draws. The mast's 2.65:1
    // was below it; the rock the numeral still shares a crowded island with is above it.
    assert(low >= 4.5, `${theme}: the numeral is only ${rnd2(low)}:1 on what is painted under it (${worst})`);
  }
  // And the one reason the badges win: they are saturated discs on a cream board, with nothing else on it.
  const badge = {};
  for (const theme of ['day', 'dusk']) {
    badge[theme] = +Math.min(...BADGE_HEX.map((h) => de00(h, SIGN_BOARD[theme]))).toFixed(2);
    assert(badge[theme] >= 20, `${theme}: a badge only ${badge[theme]} from its own board`);
  }
  // Nothing the art paints is anywhere near a badge colour, so no shape on an island can be read as a state.
  const art = {};
  for (const theme of ['day', 'dusk']) {
    let low = Infinity;
    let worst = '';
    const cols = { ...ISLAND_BACKDROPS[theme] };
    for (const e of [...V.REPO_PALETTE, V.NO_REPO_COLOUR]) {
      cols[`${e.name} fill`] = theme === 'day' ? e.light : e.dark;
      cols[`${e.name} rim`] = theme === 'day' ? e.lightEdge : e.darkEdge;
    }
    for (const [name, hex] of Object.entries(cols)) {
      for (const lane of V.WORLD_BADGE_LANES) {
        const d = de00(V.STATE[lane].color, hex);
        if (d < low) {
          low = d;
          worst = `${lane} / ${name}`;
        }
      }
    }
    art[theme] = { floor: +low.toFixed(2), pair: worst };
  }
  // The two floors are set by the pairs named in the results, and both are an accent's thin outline against the
  // jail's slate rather than an area against a disc: the badge is a bordered disc with a white glyph on a cream
  // board, which is the separation the check below actually leans on.
  assert(art.day.floor >= 12, `day: island art within ${art.day.floor} of a badge (${art.day.pair})`);
  assert(art.dusk.floor >= 8, `dusk: island art within ${art.dusk.floor} of a badge (${art.dusk.pair})`);

  // Structural, and the part that actually matters: the reserved colours are painted on the name boards and
  // nowhere else, and no accent shape reaches the band the badges sit in.
  const shapes = [];
  let reservedOnArt = 0;
  let reservedOnSign = 0;
  withFrameLoop((loop) => {
    const g = geometryVillage(shapes, { mode: 'world', reduce: true });
    g.village.update(board(artRows(12)));
    loop.pump(0.2);
    const islands = g.village.islands();
    for (const s of shapes) {
      const style = typeof s.style === 'string' ? s.style.toLowerCase() : '';
      if (!RESERVED_HEX.has(style)) continue;
      const mid = [(s.box[0] + s.box[2]) / 2, (s.box[1] + s.box[3]) / 2];
      const onSign = islands.some((is) => mid[0] >= is.sign[0] - 1 && mid[0] <= is.sign[0] + is.sign[2] + 1
        && mid[1] >= is.sign[1] - 1 && mid[1] <= is.sign[1] + is.sign[3] + 1);
      if (onSign) reservedOnSign += 1;
      else reservedOnArt += 1;
    }
    for (const is of islands) {
      const sc = V.islandScene(is);
      const accents = [sc.flag.band, ...sc.huts.map((h) => h.box), [is.cx - is.rx, is.cy - is.ry, is.rx * 2, is.ry * 2]];
      for (const a of accents) assert(!V.boxesOverlap(a, is.sign), `${is.repo}: an accent reaches the badge board`);
    }
    g.village.destroy();
  });
  eq(reservedOnArt, 0, 'a reserved state colour is painted somewhere other than a name board');
  assert(reservedOnSign >= 12, `the badges are drawn at all (${reservedOnSign} reserved-colour shapes on boards)`);
});

check('one village mode draws exactly the scene it drew before the world of islands', () => {
  const fnv = (text) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
    return (h >>> 0).toString(16);
  };
  const LANES = ['needs_you', 'your_turn', 'errored', 'stopped', 'running', 'open_pr', 'idle', 'recent',
    'valhalla', 'castle', 'jail', 'graveyard'];
  const mixed = [];
  LANES.forEach((lane, li) => {
    for (let i = 0; i < 3; i++) {
      const n = li * 3 + i;
      mixed.push(row(`local_${String.fromCharCode(97 + (n % 6)).repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`,
        lane, { repo: n % 7 === 0 ? null : n % 2 ? 'alpha/one' : 'beta/two', tokens: tok(1000 * (n + 1)) }));
    }
  });
  // The layout, place by place: slot, index, position and per-place cap.
  eq([...V.layoutVillage(mixed).entries()].map(([id, s]) => `${id}|${s.place}|${s.spot}|${s.index}|${rnd2(s.x)},${rnd2(s.y)}|${s.cap}`).sort(), [
    'local_aaaaaaaa-0000-4000-8000-000000000000|porch|porch|0|629,866|1.04',
    'local_aaaaaaaa-0000-4000-8000-000000000006|porch|steps|0|150,866|1.04',
    'local_aaaaaaaa-0000-4000-8000-000000000012|workshop|workshop|0|848,452|1.23',
    'local_aaaaaaaa-0000-4000-8000-000000000024|beach|beach|0|1394,848|1',
    'local_aaaaaaaa-0000-4000-8000-000000000030|jail|jail|0|112,246|1.25',
    'local_bbbbbbbb-0000-4000-8000-000000000001|porch|porch|1|479,866|1.04',
    'local_bbbbbbbb-0000-4000-8000-000000000007|porch|steps|1|90,866|1.04',
    'local_bbbbbbbb-0000-4000-8000-000000000013|workshop|workshop|1|940,452|1.23',
    'local_bbbbbbbb-0000-4000-8000-000000000025|beach|beach|1|1470,848|1',
    'local_bbbbbbbb-0000-4000-8000-000000000031|jail|jail|1|172,246|1.25',
    'local_cccccccc-0000-4000-8000-000000000002|porch|porch|2|629,734|1.04',
    'local_cccccccc-0000-4000-8000-000000000008|porch|steps|2|30,866|1.04',
    'local_cccccccc-0000-4000-8000-000000000014|workshop|workshop|2|756,452|1.23',
    'local_cccccccc-0000-4000-8000-000000000026|beach|beach|2|1356,796|1',
    'local_cccccccc-0000-4000-8000-000000000032|jail|jail|2|232,246|1.25',
    'local_dddddddd-0000-4000-8000-000000000003|porch|swings|0|380,866|1.04',
    'local_dddddddd-0000-4000-8000-000000000009|porch|steps|3|150,734|1.04',
    'local_dddddddd-0000-4000-8000-000000000015|harbour|harbour|0|1407,292|1',
    'local_eeeeeeee-0000-4000-8000-000000000004|porch|swings|1|230,866|1.04',
    'local_eeeeeeee-0000-4000-8000-000000000010|porch|steps|4|90,734|1.04',
    'local_eeeeeeee-0000-4000-8000-000000000016|harbour|harbour|1|1345,292|1',
    'local_ffffffff-0000-4000-8000-000000000005|porch|swings|2|380,734|1.04',
    'local_ffffffff-0000-4000-8000-000000000011|porch|steps|5|30,734|1.04',
    'local_ffffffff-0000-4000-8000-000000000017|harbour|harbour|2|1438,240|1',
  ], 'the village lays the same board out exactly as it did');
  // The per-place caps at every crowd size the cap check uses.
  const PLACE_LANES2 = { porch: ['needs_you', 'your_turn', 'errored', 'stopped'], workshop: ['running'], harbour: ['open_pr'], beach: ['valhalla'], jail: ['jail'] };
  const caps = {};
  for (const [place, lanes] of Object.entries(PLACE_LANES2)) {
    caps[place] = [0, 1, 5, 13, 20].map((n) => {
      const slots = [...V.layoutVillage(Array.from({ length: n }, (_, i) => row(
        `local_zzzzzzzz-0000-4000-8000-${String(i).padStart(12, '0')}`, lanes[i % lanes.length], { tokens: MAX_TOKENS }))).values()];
      return slots.length ? slots[0].cap : null;
    });
  }
  eq(caps, {
    porch: [null, 1.5, 1.14, 1.04, 1], workshop: [null, 1.5, 1.23, 1, 1], harbour: [null, 1.5, 1, 1, 1],
    beach: [null, 1.5, 1, 1, 1], jail: [null, 1.5, 1, 1, 1],
  }, 'and caps every place at the same scale');
  eq(V.graveyardLayout(Array.from({ length: 40 }, (_, i) => `local_gggggggg-0000-4000-8000-${String(i).padStart(12, '0')}`)).size,
    V.GRAVE_CAPACITY, 'the graveyard still holds what it held');
  eq(rnd5(V.castleLayout(12, Array.from({ length: 12 }, (_, i) => 0.9 + i * 0.05), V.HALL).scale), 1.18554, 'the hall crowd scale');
  eq(rnd5(V.castleLayout(7, null, V.ROOM).scale), 1.3, 'the cottage room crowd scale');
  // And the frame itself: every shape, and every word, at a fixed clock with nothing moving. The clear colour is
  // the scene's own floor, so one frame is isolated whichever scene is open.
  const CLEAR = { village: GRASS_HEX.day, hall: '#eee0bd', room: '#c79a63' };
  const digest = (open, clear) => {
    const shapes = [];
    const texts = [];
    let out = null;
    withFrameLoop((loop) => {
      reduceMotion = true;
      const canvas = {
        width: 0, height: 0, style: {}, getContext: () => geometrySpy(shapes),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }),
        addEventListener() {}, removeEventListener() {},
      };
      const village = V.createVillage(canvas, {});
      village.resize();
      village.start();
      village.update({ counts: {}, sessions: mixed });
      if (open) village[open]();
      loop.pump(0.5);
      village.destroy();
      const textCanvas = {
        width: 0, height: 0, style: {}, getContext: () => measuringRecorder(texts),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }),
        addEventListener() {}, removeEventListener() {},
      };
      const worded = V.createVillage(textCanvas, {});
      worded.resize();
      worded.start();
      worded.update({ counts: {}, sessions: mixed });
      if (open) worded[open]();
      loop.pump(0.5);
      worded.destroy();
      const all = lastFrame(shapes, 'day', clear);
      // The painted shapes and the text are digested apart, so `shapes` and `digest` stay the figures 396d093
      // drew and a future change to either is still caught. The spy could not see text at all when they were
      // first pinned; `ink` is what it sees now, pinned on the same frame.
      const frame = all.filter((s) => s.kind !== 'text');
      const ink = all.filter((s) => s.kind === 'text');
      const line = (s) => `${s.kind}|${s.style}|${s.box.map((v) => rnd2(v)).join(',')}|${s.radii.map((v) => rnd2(v)).join(' ')}`;
      out = {
        shapes: frame.length,
        digest: fnv(frame.map(line).join('\n')),
        ink: `${ink.length}/${fnv(ink.map(line).join('\n'))}`,
        words: fnv([...new Set(texts)].sort().join('\n')),
      };
    });
    return out;
  };
  results.oneVillage = {
    village: digest(null, CLEAR.village),
    hall: digest('enterCastle', CLEAR.hall),
    room: digest('enterCottages', CLEAR.room),
  };
  // The village digest moved from 928bb2b0 to d30e8a61 when `measureText` in geometrySpy started returning its
  // own measurement instead of a constant 10 px, which is what every sign and plate is sized from. Re-pinned
  // against 396d093's own village.js measured through the fixed spy, which gives these values exactly: the
  // scene is unchanged, the instrument was wrong. The shape count and the two interiors never moved.
  // It moved again, to e62d4286, when the Porch left the row under the road and the ghosts moved inside the fence:
  // diffed shape for shape against the scene before, every one of the 464 shapes that changed is a Porch shape or a
  // ghost, and the count is still 1070. The words moved because the steps' plates narrowed with their third column.
  //
  // The room moved again, from 6a7c40e (149 shapes) to 89d21940 (157 shapes), when the cottage room's eight
  // board-game tables shipped: one static shape apiece; the seats' own retune (clearing hit-region overlap between
  // a table's own north/south seats and between one row's south seat and the next row's north, then reordering the
  // seat list seat-major so a typical guest count spreads across tables instead of packing the first few) moved it
  // twice more without changing the shape count. Village and hall are untouched: this fixture's 3 graveyard
  // rows sit under the (also raised) ghost floor of 6 on both the old and new step tables, so the outdoor scene
  // does not move, and the hall digest below is rendered in day mode, where the disco (dusk-only) never draws.
  // It moved to b32b876b, same 157 shapes, when the tables grew to show their games and the seats moved to the
  // tables' sides and far rim.
  // It moved to dd1ec513 (165 shapes) when fillEllipse started honouring the stroke its callers pass. Diffed
  // shape for shape: the eight new shapes are the eight game pieces' own '#2b2b2b' outlines, which that call has
  // asked for since the tables shipped and silently did not get. Nothing else moved, in any of the three scenes.
  eq(results.oneVillage, {
    village: { shapes: 1070, digest: 'e62d4286', ink: '33/60929b59', words: 'd00b4209' },
    hall: { shapes: 104, digest: '207527e9', ink: '3/f513068', words: '29cbbb2d' },
    room: { shapes: 165, digest: 'dd1ec513', ink: '7/6ec12c21', words: 'db3b0380' },
  }, 'one village draws the same scene, shape for shape and word for word');
});

// ---------- visitors at the immigration desk ----------

// PRs waiting on a review. `waitingSince` ascends with the index, so index 0 is the longest wait and stands at
// the barrier, which makes every slot in these checks deterministic.
// Ids in the shape the server mints (`paths.REVIEW_ID_RE`: `pr:` and 16 hex), with the repo in the first half so
// two repos' queues never share one.
const deskId = (repo, i) => `pr:${[...repo].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0').slice(-8)}${String(i).padStart(8, '0')}`;
// `island` is the server's own field: the repo's island when the board has one, null when it does not.
const deskRows = (n, repo = 'bp-core', island = repo) => Array.from({ length: n }, (_, i) => ({
  id: deskId(repo, i + 1), number: i + 1, repo, owner: 'org', island, author: `dev-${i % 4}`,
  title: `never drawn ${i}`, waitingSince: 1000 + i, look: i * 7,
}));
const deskSlots = (list) => [...V.visitorLayout(V.visitorRows(list)).slots.entries()];

const PIER_BOX = [V.PIER.x - V.PIER.half, V.PIER.top, V.PIER.half * 2, V.PIER.tip - V.PIER.top];
const BOARDWALK_BOX = [1466, 302, 160, 36];
// The harbour queue at the largest size a session is ever drawn, over the whole of its slot rect rather than the
// slots one board happens to fill. Nothing shrinks the queue's own cap because a visitor arrived, so the queue
// has to be cleared at 1.5 whatever is standing in it.
const QUEUE_ENVELOPE = (() => {
  const [rx, ry, rw, rh] = V.SPOTS.harbour.rect;
  const a = V.avatarBox('open_pr', rx, ry, 1.5);
  const b = V.avatarBox('open_pr', rx + rw, ry + rh, 1.5);
  return [a[0], a[1], b[0] + b[2] - a[0], b[1] + b[3] - a[1]];
})();
const DESK_CLEAR = [
  ['the barrier', V.BARRIER_BOX], ['the guard', V.GUARD_BOX], ['the booth', V.BOOTH_BOX],
  ['the platform', V.PATROL_PLATFORM], ['the pier', PIER_BOX], ['the boardwalk', BOARDWALK_BOX],
  ['the moored boat', V.boatBox(V.BOAT_BERTH.x, V.BOAT_BERTH.y)],
  ['a boat at the jetty', V.boatBox(V.JETTY_BERTH.x, V.JETTY_BERTH.y)],
  ['the harbour queue at 1.5', QUEUE_ENVELOPE],
];
// Every part of every slot a session can stand in, at the largest size one is ever drawn, so a visitor can never
// be standing among sessions. Two things this is careful about, and each one failed a clearance that is not
// there: the real grids at every crowd size (including the spread past their tightest spacing) rather than a
// bounding box of the whole rect, and `avatarBoxes` part by part rather than `avatarBox`, whose union of them
// claims a workshop bench 60 px above where the bench is drawn.
const SESSION_ENVELOPES = (() => {
  const out = [];
  for (const key of V.SPOT_KEYS) {
    const lane = V.SPOTS[key].lanes[0];
    for (const n of [1, 2, 3, 5, 8, 12, 20, 40]) {
      for (const p of V.slotGrid(key, n).points) {
        for (const box of V.avatarBoxes(lane, p.x, p.y, 1.5)) out.push([`a ${key} slot at 1.5`, box]);
      }
    }
  }
  return out;
})();

check('the desk queue slots 0, 1, 3, 8 and 40 visitors, the head of it at the barrier and nothing touching', () => {
  eq(V.visitorLayout([]).slots.size, 0, 'no visitors, no slots');
  eq(V.visitorLayout(null).total, 0, 'hostile input');
  assert(V.slotGrid(V.VISITOR_SPOT, V.VISITOR_CAPACITY).overflow === false, 'the capacity is the slots that fit');
  assert(V.slotGrid(V.VISITOR_SPOT, V.VISITOR_CAPACITY + 1).overflow === true, 'and one more than that does not');
  const [lx, ly, lw, lh] = V.VISITOR_LANDING;
  for (const [what, box] of DESK_CLEAR) {
    assert(overlapBy(V.VISITOR_LANDING, box) <= 0, `the landing overlaps ${what} by ${overlapBy(V.VISITOR_LANDING, box).toFixed(1)}`);
  }
  for (const n of [0, 1, 3, 8, 40]) {
    const layout = V.visitorLayout(V.visitorRows(deskRows(n)));
    const shown = Math.min(n, V.VISITOR_CAPACITY);
    eq([layout.slots.size, layout.shown, layout.hidden, layout.total], [shown, shown, n - shown, n], `${n} waiting`);
    const slots = [...layout.slots.values()];
    const boxes = slots.map((s) => V.visitorBox(s.x, s.y));
    if (shown > 1) assert(slots[0].x > slots[1].x, `${n} waiting: the longest wait stands nearest the barrier`);
    boxes.forEach((box, i) => {
      for (let j = i + 1; j < boxes.length; j++) {
        assert(overlapBy(box, boxes[j]) <= 0, `${n} waiting: two visitors overlap by ${overlapBy(box, boxes[j]).toFixed(1)}`);
      }
      for (const [what, other] of [...DESK_CLEAR, ...SESSION_ENVELOPES]) {
        assert(overlapBy(box, other) <= 0, `${n} waiting: a visitor overlaps ${what} by ${overlapBy(box, other).toFixed(1)}`);
      }
      const { x, y } = slots[i];
      const planks = x >= lx && x <= lx + lw && y >= ly && y <= ly + lh;
      assert(x <= V.shoreX(y) || planks, `${n} waiting: a visitor stands on open water at ${Math.round(x)},${Math.round(y)}`);
    });
  }
  // The list itself: the page's own cleaning rules, since the map's badges, the HUD pill and this queue have to
  // be counting one list. A session wins an id that is somehow in both.
  eq(V.visitorRows([{ id: 'x', repo: 'r' }]).length, 0, 'a visitor with no PR number is dropped');
  eq(V.visitorRows([{ id: 'x', number: 1 }, { id: 'x', number: 2 }]).length, 1, 'a duplicate id counts once');
  eq(V.visitorRows([{ id: 'x', number: 1 }], new Set(['x'])).length, 0, 'a session wins the id');
  eq(V.visitorRows([{ id: 'a', number: 1, requestedAt: 9 }, { id: 'b', number: 2, waitingSince: 4 }]).map((v) => v.id),
    ['b', 'a'], 'longest wait first, under either field name');
  eq(V.visitorIsland({ island: 'bp-core', repo: 'other' }), 'bp-core', 'a visitor stands on the island the server named');
  for (const v of [{ repo: 'bp-core' }, { island: null, repo: 'bp-core' }, { island: '' }, { island: 7 }, null]) {
    eq(V.visitorIsland(v), null, `and on none otherwise, whatever its repo is called: ${JSON.stringify(v)}`);
  }
});

check('a visitor is hovered where it stands, points at the top of its head, opens its PR and is never a session', () => {
  const rows = [row(A, 'open_pr', { repo: 'bp-core' }), row(B, 'running', { repo: 'bp-core' })];
  const list = deskRows(3);
  const v = makeVillage();
  v.village.update(board(rows, list), { privacy: false });
  eq(v.village.visitors(), { shown: 3, waiting: 3, hidden: 0, board: 3 }, 'three at the desk');
  const [[id, slot], [second]] = deskSlots(list);
  const at = v.aimPoint(slot.x, slot.y, id);
  eq(v.hoveredId(), id, 'the visitor under the pointer is named by its own id');
  const point = v.log.hovers[v.log.hovers.length - 1].point;
  near(point.x, slot.x, 0.01, 'the point sits on its centre line');
  near(point.y, V.visitorBox(slot.x, slot.y)[1], 0.01, 'at the top of its head, since it carries no badge');
  v.click(at.x, at.y);
  eq(v.log.opened, [id], 'a click opens that PR, by id and nothing else');
  eq(v.log.selected, [], 'and never selects it: there is no session behind it');
  // Selection cannot be moved onto one either, so the ring stays where the page put it.
  v.village.setSelected(A);
  v.village.setSelected(id);
  v.village.setSelected(second);
  // The desk still answers for the guard and for the sessions queueing behind the barrier.
  const guard = v.aimPoint(V.GUARD.x, V.GUARD_BOX[1] + V.GUARD_BOX[3] - 2, V.PATROL_ID, 70);
  eq(v.hoveredId(), V.PATROL_ID, 'the guard still answers its own hover');
  v.click(guard.x, guard.y);
  eq(v.log.opened, [id], 'and a click on the guard still does nothing');
  assert(v.sweep(V.layoutVillage(rows).get(A).x, V.layoutVillage(rows).get(A).y, 120).includes(A),
    'the session in the queue behind the barrier is still hoverable');
  // Inside a room the desk is outside, so nothing there answers.
  v.village.enterCottages();
  v.fire('pointermove', slot.x, slot.y - 20);
  assert(v.hoveredId() !== id, 'a visitor is not hovered from inside an interior');
  v.village.destroy();
});

check('a visitor walks up the pier when it arrives and away again when its review lands, full rate only while it moves', () => {
  withFrameLoop((loop) => {
    const rows = [row(A, 'running', { repo: 'bp-core' })];
    const v = makeVillage({ reduce: false });
    v.village.start();
    v.village.update(board(rows, []), { privacy: false });
    loop.pump(0.4);
    const idle = loop.pump(2);
    assert(idle.frames <= 26, `ambient with nobody at the desk (${idle.frames} frames in 2 s)`);
    const list = deskRows(1);
    const [[id, slot]] = deskSlots(list);
    v.village.update(board(rows, list), { privacy: false });
    const arriving = loop.pump(1);
    assert(arriving.frames >= 45, `full rate while it walks up the pier (${arriving.frames} frames in 1 s)`);
    // The whole walk: it appears at the pier tip and is at its slot by the end of it.
    const path = V.visitorPath(V.VISITOR_DOCK, slot);
    loop.pump(0.45 + V.walkDuration(V.routeLength(path)) - 1 + 0.2);
    const settled = loop.pump(2);
    assert(settled.frames <= 26 && settled.timers >= 18,
      `ambient once it is in the queue (${settled.frames} frames, ${settled.timers} sleeps in 2 s)`);
    eq(v.village.visitors().shown, 1, 'standing at the desk');
    const found = v.aimPoint(slot.x, slot.y, id);
    assert(found, 'and hoverable where its slot is');
    v.village.update(board(rows, []), { privacy: false });
    const leaving = loop.pump(1);
    assert(leaving.frames >= 45, `full rate while it walks back down the pier (${leaving.frames} frames in 1 s)`);
    // The count drops with the board, so nothing outlives the request; the figure walks off rather than vanishing.
    eq(v.village.visitors().waiting, 0, 'the desk count drops at once');
    eq(v.village.visitors().shown, 1, 'and it is still walking off rather than gone mid-frame');
    loop.pump(V.walkDuration(V.routeLength(path)) + 0.6 + 0.2);
    const after = loop.pump(2);
    assert(after.frames <= 26, `ambient once it has gone (${after.frames} frames in 2 s)`);
    eq(v.village.visitors().shown, 0, 'and then it is gone');
    // The same board again plans nothing: a poll every few seconds must not restart the walk.
    v.village.update(board(rows, list), { privacy: false });
    loop.pump(0.45 + V.walkDuration(V.routeLength(path)) + 0.3);
    const again = loop.pump(2);
    assert(again.frames <= 26, `ambient after it arrives again (${again.frames} frames in 2 s)`);
    v.village.update(board(rows, list), { privacy: false });
    const idempotent = loop.pump(2);
    assert(idempotent.frames <= 26, `an unchanged board moves nobody (${idempotent.frames} frames in 2 s)`);
    v.village.destroy();
  });
});

// Every coat drawn in each frame while `pump` runs, as [x, y, w, h] with the alpha it was painted at. A coat is the
// visitor's trapezoid: a fill in one of the coat colours, taller than the head drawn in the same colour.
const COAT_FILLS = new Set(V.VISITOR_COATS.flatMap((c) => [c.light, c.dark]));
function coatFrames(shapes, loop, seconds) {
  const frames = [];
  let from = shapes.length;
  loop.pump(seconds, (ms) => {
    const drawn = shapes.slice(from);
    from = shapes.length;
    const coats = drawn.filter((s) => s.kind === 'fill' && COAT_FILLS.has(s.style) && s.box[3] - s.box[1] > 20)
      .map((s) => ({ box: [s.box[0], s.box[1], s.box[2] - s.box[0], s.box[3] - s.box[1]], alpha: s.alpha }));
    if (drawn.length) frames.push({ ms, coats });
  });
  return frames;
}

check('visitors arriving together step off one at a time, the back of the queue first, and never stand in a heap', () => {
  // The first board usually reaches the page before the first review search does, so every server start with the
  // page open walks the whole queue in at once, and so does every reconnect after an outage. With no stagger all
  // nine coats stood in one box at the pier tip for the first 0.74 s and overlapped for 1.1 s.
  const rows = [row(A, 'running', { repo: 'bp-core' })];
  const worst = { overlap: 0, at: null };
  let pairs = 0;
  const order = [];
  const stood = new Map();
  withFrameLoop((loop) => {
    const shapes = [];
    reduceMotion = false;
    const canvas = {
      width: 0, height: 0, style: {}, getContext: () => geometrySpy(shapes),
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }),
      addEventListener() {}, removeEventListener() {},
    };
    const village = V.createVillage(canvas, {});
    village.resize();
    village.start();
    village.update(board(rows, []), { privacy: false });
    loop.pump(0.5);
    const t0 = clock.ms;
    village.update(board(rows, deskRows(40)), { privacy: false });
    const frames = coatFrames(shapes, loop, V.VISITOR_CAPACITY * V.VISITOR_STAGGER_S + 3);
    const slots = [...V.visitorLayout(V.visitorRows(deskRows(40))).slots.values()];
    for (const f of frames) {
      const seen = f.coats.filter((c) => c.alpha >= 0.5);
      for (let i = 0; i < seen.length; i++) {
        for (let j = i + 1; j < seen.length; j++) {
          pairs += 1;
          const by = overlapBy(seen[i].box, seen[j].box);
          if (by > worst.overlap) Object.assign(worst, { overlap: by, at: (f.ms - t0) / 1000 });
        }
      }
      // The order they reach the queue: a slot counts as taken once a coat has stood on it for five frames, which
      // a walker passing over it on the way to the back never does.
      const here = new Set();
      for (const c of f.coats) {
        const cx = c.box[0] + c.box[2] / 2;
        const slot = slots.findIndex((sl) => Math.abs(sl.x - cx) < 0.5 && Math.abs(sl.y - (c.box[1] + c.box[3] + 3)) < 1.5);
        if (slot >= 0) here.add(slot);
      }
      for (const slot of here) {
        stood.set(slot, (stood.get(slot) || 0) + 1);
        if (stood.get(slot) === 5) order.push(slot);
      }
      for (const slot of [...stood.keys()]) if (!here.has(slot) && !order.includes(slot)) stood.delete(slot);
    }
    const last = frames[frames.length - 1];
    eq(last.coats.length, V.VISITOR_CAPACITY, 'the whole queue is standing at the end');
    village.destroy();
  });
  reduceMotion = true;
  assert(pairs > 100, `the check saw coats in view together (${pairs} pairs)`);
  assert(worst.overlap <= 2, `two coats in view overlap by ${worst.overlap.toFixed(1)} px at ${worst.at && worst.at.toFixed(2)} s`);
  eq(order, [8, 7, 6, 5, 4, 3, 2, 1, 0], 'the back of the queue arrives first, so nobody walks through anyone standing');
  results.visitorArrivals = { stagger: V.VISITOR_STAGGER_S, worstOverlap: rnd2(worst.overlap) };

  // The queue changing while some are still waiting their turn at the pier tip, unseen. One whose request is
  // answered before its turn is simply gone, since there is nothing to walk off; the rest keep their turns; and a
  // second batch steps off after the first rather than on top of it.
  withFrameLoop((loop) => {
    const shapes = [];
    reduceMotion = false;
    const canvas = {
      width: 0, height: 0, style: {}, getContext: () => geometrySpy(shapes),
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }),
      addEventListener() {}, removeEventListener() {},
    };
    const village = V.createVillage(canvas, {});
    village.resize();
    village.start();
    village.update(board(rows, []), { privacy: false });
    loop.pump(0.5);
    const list = deskRows(6);
    village.update(board(rows, list), { privacy: false });
    loop.pump(1);
    // The head of the queue arrives last, so it is still waiting: answered now, it never appears at all.
    village.update(board(rows, list.slice(1)), { privacy: false });
    eq(village.visitors().shown, 5, 'the one still waiting its turn is gone at once, with nothing to walk off');
    const later = deskRows(8).slice(6).map((v) => ({ ...v, waitingSince: v.waitingSince + 100 }));
    village.update(board(rows, [...list.slice(1), ...later]), { privacy: false });
    const frames = coatFrames(shapes, loop, 8 * V.VISITOR_STAGGER_S + 3);
    // On the pier, below the turn onto the landing: the stretch every arrival walks, where two turns that came
    // too close together would stand one on the other. Along the waterline a newcomer walking to the back of the
    // queue does pass the ones standing in it, since it is a single file.
    const onPier = (c) => c.box[1] + c.box[3] > V.VISITOR_WAY[0].y + 3;
    let seen = 0;
    for (const f of frames) {
      const tip = f.coats.filter((c) => c.alpha >= 0.5 && onPier(c));
      seen += tip.length;
      for (let i = 0; i < tip.length; i++) {
        for (let j = i + 1; j < tip.length; j++) {
          assert(overlapBy(tip[i].box, tip[j].box) <= 2, `two visitors stepping off the pier tip together: ${JSON.stringify(tip)}`);
        }
      }
    }
    assert(seen > 20, `the check saw arrivals on the pier (${seen})`);
    eq(frames[frames.length - 1].coats.length, 7, 'and all seven end up standing');
    village.destroy();
  });
  reduceMotion = true;
});

check('a visitor walking off one island does not walk on over the next, or over the map', () => {
  // A change of island or of mode places everyone directly, and the removal loop skipped a visitor already walking
  // off before it asked whether the change was direct, so the walk went on over whichever island opened next.
  const rows = [
    row('local_aaaaaaaa-0000-4000-8000-000000000001', 'running', { repo: 'alpha' }),
    row('local_bbbbbbbb-0000-4000-8000-000000000002', 'idle', { repo: 'beta' }),
  ];
  const list = deskRows(4, 'alpha');
  const [lx, ly, lw, lh] = V.VISITOR_LANDING;
  const landing = (s) => s.kind === 'fill' && Math.abs(s.box[0] - lx) < 0.01 && Math.abs(s.box[1] - ly) < 0.01
    && Math.abs(s.box[2] - (lx + lw)) < 0.01 && Math.abs(s.box[3] - (ly + lh)) < 0.01;
  for (const next of ['beta', 'map']) {
    withFrameLoop((loop) => {
      const shapes = [];
      reduceMotion = false;
      const canvas = {
        width: 0, height: 0, style: {}, getContext: () => geometrySpy(shapes),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }),
        addEventListener() {}, removeEventListener() {},
      };
      const village = V.createVillage(canvas, { mode: 'world', island: 'alpha' });
      village.resize();
      village.start();
      village.update(board(rows, list), { privacy: false });
      loop.pump(0.5);
      eq(village.visitors(), { shown: 4, waiting: 4, hidden: 0, board: 4 }, `${next}: four at alpha's desk`);
      // The head of the queue is reviewed, and a tenth of a second into its walk the reader moves on.
      village.update(board(rows, list.slice(1)), { privacy: false });
      loop.pump(0.1);
      eq(village.visitors().shown, 4, `${next}: it is walking off`);
      if (next === 'beta') village.openIsland('beta');
      else village.leaveIsland();
      eq(village.visitors().shown, village.visitors().waiting, `${next}: nobody on the desk who is not waiting there`);
      const from = shapes.length;
      const frames = coatFrames(shapes, loop, 1.5);
      if (next === 'beta') {
        eq(village.visitors(), { shown: 0, waiting: 0, hidden: 0, board: 3 }, 'beta has no desk queue');
        assert(frames.length > 0, 'beta was drawn');
        assert(frames.every((f) => f.coats.length === 0), `no coat on beta: ${frames.map((f) => f.coats.length).join(',')}`);
        assert(!shapes.slice(from).some(landing), 'and no landing, since nobody is waiting there');
      }
      village.destroy();
    });
  }
  reduceMotion = true;
});

// The shapes the desk queue adds to a frame, found by drawing the same board twice: nothing else moves under
// reduced motion, so the difference is the queue, its planks and its overflow line and nothing else.
// Geometry and colour only. `geometrySpy` does not save and restore its style state, so the `lineWidth` it
// reports for a shape depends on what was drawn before it: with that in the key, every shape after the new
// planks read as a new shape.
const shapeKey = (s) => `${s.kind}|${s.style}|${s.box.map((n) => rnd2(n)).join(',')}`;
// `list` draws that queue instead of `deskRows(n)`, and `base` reuses a frame already drawn with nobody waiting.
function deskShapes(rows, n, { dark = false, repo = 'bp-core', hover = null, list = null, base: given = null, privacy = false } = {}) {
  const theme = dark ? 'dusk' : 'day';
  const base = given || lastFrame(paintedShapes(rows, { dark }).shapes, theme);
  const full = lastFrame(paintedShapes(rows, { dark, visitors: list || deskRows(n, repo), hover, privacy }).shapes, theme);
  const seen = new Map();
  for (const s of base) seen.set(shapeKey(s), (seen.get(shapeKey(s)) || 0) + 1);
  const added = [];
  for (const s of full) {
    const k = shapeKey(s);
    if (seen.get(k)) {
      seen.set(k, seen.get(k) - 1);
      continue;
    }
    added.push(s);
  }
  return { added, base: base.length, full: full.length };
}

check('the desk queue draws itself and nothing else, on its own planks, in both themes and with no visitors at all', () => {
  const rows = [row(A, 'open_pr', { repo: 'bp-core' }), row(B, 'running', { repo: 'bp-core' })];
  // An empty list is the village as it was, shape for shape: the planks and the coats are drawn only for
  // somebody standing on them.
  eq(deskShapes(rows, 0).added, [], 'no visitors, nothing drawn');
  for (const dark of [false, true]) {
    const theme = dark ? 'dusk' : 'day';
    // The visitor at the head of the queue hovered, since its ring is the widest thing the queue draws and the
    // closest to the barrier. At 18 px across it reached past the barrier's box and no other frame showed it.
    const { added } = deskShapes(rows, 40, { dark, hover: deskSlots(deskRows(40))[0][0] });
    const coats = new Set(V.VISITOR_COATS.map((c) => (dark ? c.dark : c.light)));
    const bodies = added.filter((s) => s.kind === 'fill' && coats.has(s.style));
    eq(bodies.length, V.VISITOR_CAPACITY * 2, `${theme}: a coat and a head for each of the ${V.VISITOR_CAPACITY} drawn`);
    const passports = added.filter((s) => s.kind === 'fill' && s.style === V.REVIEWS.color);
    eq(passports.length, V.VISITOR_CAPACITY, `${theme}: a passport each, which is the tell that it is not a session`);
    const words = added.filter((s) => s.kind === 'text');
    eq(words.length, 1, `${theme}: one line of text, the +N more`);
    const ring = added.filter((s) => s.kind === 'stroke' && s.style === (dark ? 'rgba(0, 0, 0, 0.55)' : 'rgba(33, 37, 41, 0.55)'));
    eq(ring.length, 1, `${theme}: the hovered visitor's ring is in this frame, so the clearances below cover it`);
    // Every shape the queue adds, measured with its own line width, is clear of the desk and of every session slot.
    // Padded by 1.5 px all round, which covers the widest line the queue strokes: the spy's own `lineWidth` leaks
    // across save and restore, so a stroke's reported width is not always the width it was drawn at.
    const pad = 1.5;
    for (const s of added) {
      const rect = [s.box[0] - pad, s.box[1] - pad, s.box[2] - s.box[0] + pad * 2, s.box[3] - s.box[1] + pad * 2];
      for (const [what, other] of [...DESK_CLEAR, ...SESSION_ENVELOPES]) {
        assert(overlapBy(rect, other) <= 0,
          `${theme}: the queue paints over ${what} by ${overlapBy(rect, other).toFixed(1)} (${s.kind} ${s.style} at ${rect.map((n) => rnd2(n)).join(',')} vs ${other.map((n) => rnd2(n)).join(',')})`);
      }
    }
  }
  // Every shape one resting visitor draws is inside its own box, which is what the no-overlap guarantee above
  // rests on: the parts are a claim about the art, and nothing else checks that the art keeps to them. Grown by
  // 4 px for the ground shadow and the line widths, which `VISITOR_PARTS` leaves out exactly as a session's
  // parts leave out its own.
  const one = deskShapes(rows, 1).added;
  assert(one.length > 6, `a visitor and its planks are more than a few shapes (${one.length})`);
  const [sx, sy] = [...V.visitorLayout(V.visitorRows(deskRows(1))).slots.values()].map((s) => [s.x, s.y])[0];
  const grown = V.visitorBox(sx, sy).map((n, i) => (i < 2 ? n - 4 : n + 8));
  const LANDING_DRAWN = [V.VISITOR_LANDING[0] - 2, V.VISITOR_LANDING[1] - 2, V.VISITOR_LANDING[2] + 4, V.VISITOR_LANDING[3] + 14];
  for (const s of one) {
    const rect = [s.box[0], s.box[1], s.box[2] - s.box[0], s.box[3] - s.box[1]];
    assert(inBox(rect, grown) || inBox(rect, LANDING_DRAWN),
      `a shape outside the visitor's own box and its planks: ${s.kind} ${s.style} at ${rect.map((n) => rnd2(n)).join(',')}`);
  }
  // The overflow line says how many it could not fit, the way the graveyard's sign does.
  const texts = [];
  withFrameLoop((loop) => {
    const v = makeVillage({ texts, measure: true });
    v.village.start();
    v.village.update(board(rows, deskRows(40)), { privacy: false });
    loop.pump(0.2);
    v.village.destroy();
  });
  assert(texts.includes(`+${40 - V.VISITOR_CAPACITY} more`), `the queue says what it held back (${texts.slice(0, 8)})`);
  const few = [];
  withFrameLoop((loop) => {
    const v = makeVillage({ texts: few, measure: true });
    v.village.start();
    v.village.update(board(rows, deskRows(3)), { privacy: false });
    loop.pump(0.2);
    v.village.destroy();
  });
  assert(!few.some((s) => s.endsWith(' more')), 'and says nothing when the whole queue fits');
  // No session title or PR title reaches the canvas: a visitor carries no text of its own at all.
  assert(!texts.some((s) => s.includes('pr:') || s.includes('dev-')), 'no login or id is ever drawn');
});

check('reduced motion stands the queue in its slots at once, and the Reviews pill can point at one', () => {
  const rows = [row(A, 'running', { repo: 'bp-core' })];
  const list = deskRows(3);
  const v = makeVillage(); // reduced motion by default: no walk up the pier to wait out
  v.village.update(board(rows, list), { privacy: false });
  for (const [id, slot] of deskSlots(list)) {
    v.fire('pointermove', slot.x, slot.y - 20);
    eq(v.hoveredId(), id, `${id} is standing in its slot already, with no walk to wait for`);
  }
  // What the page's Reviews pill calls. It leaves an interior first, since the desk is outside it.
  const [[first, slot]] = deskSlots(list);
  v.fire('pointerleave', 0, 0);
  v.village.enterCottages();
  v.village.showVisitor(first);
  eq(v.village.getScene(), 'village', 'it comes back out of the room');
  eq(v.hoveredId(), first, 'and points at the visitor the pill sent');
  v.village.showVisitor('pr:nothing#1');
  eq(v.hoveredId(), first, 'an id that is not at the desk moves nothing');
  assert(slot.x > 1300, 'the one the pill sends is the longest wait, at the barrier end and always drawn');
  v.village.destroy();
});

// ---------- who was asked: by name, or through a team you are on ----------

// Along the queue in turn: asked of you, asked of a team, and a request that says neither, which is drawn as a team.
const MIXED_VIA = ['you', 'team', undefined];
const viaRows = (n, pattern = MIXED_VIA, repo = 'bp-core') => deskRows(n, repo).map((v, i) => {
  const via = pattern[i % pattern.length];
  return via === undefined ? v : { ...v, via, teams: via === 'team' ? ['web-platform'] : [] };
});
// THEMES stays inside the village: its sailCloth (the passport's pale spine) and woodDark (the suitcase).
const SPINE_HEX = { day: '#f7f1e2', dusk: '#b9b3a3' };
const CASE_HEX = { day: '#7a5c42', dusk: '#4b3a2c' };
// The suitcase as it stands at a resting visitor's feet, drawn over the low end of the sash.
const CASE_BODY = [-10, -11, 8, 12];
const polyArea = (p) => Math.abs(p.reduce((a, [x, y], i) => {
  const [x2, y2] = p[(i + 1) % p.length];
  return a + x * y2 - x2 * y;
}, 0)) / 2;
// A convex polygon clipped to an [x, y, w, h] box (Sutherland and Hodgman): the part of the sash a prop covers.
function clipToBox(poly, [bx, by, bw, bh]) {
  let out = poly;
  for (const [axis, at, sign] of [[0, bx, 1], [0, bx + bw, -1], [1, by, 1], [1, by + bh, -1]]) {
    const inside = (p) => sign * (p[axis] - at) >= 0;
    const cut = (a, b) => {
      const t = (at - a[axis]) / (b[axis] - a[axis]);
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    };
    const next = [];
    out.forEach((p, i) => {
      const q = out[(i + 1) % out.length];
      if (inside(p)) {
        next.push(p);
        if (!inside(q)) next.push(cut(p, q));
      } else if (inside(q)) next.push(cut(p, q));
    });
    out = next;
    if (!out.length) break;
  }
  return out;
}
const boxUnion = (boxes) => {
  const l = Math.min(...boxes.map((b) => b[0]));
  const t = Math.min(...boxes.map((b) => b[1]));
  return [l, t, Math.max(...boxes.map((b) => b[0] + b[2])) - l, Math.max(...boxes.map((b) => b[1] + b[3])) - t];
};

check('a visitor asked through a team wears a sash and lowers its passport, one asked by name presents it, and neither grows', () => {
  // The rule both clients share: only 'you' is personal. Anything else, a missing field included, is a team, so a
  // garbled answer never makes a request look more urgent than GitHub said it was.
  eq(V.VISITOR_VIA, ['you', 'team'], 'two looks');
  eq(V.visitorVia({ via: 'you' }), 'you', 'asked of you');
  for (const v of [{ via: 'team' }, {}, { via: 'YOU' }, { via: ' you' }, { via: ['you'] }, { via: 1 }, { via: null }, null, 'you']) {
    eq(V.visitorVia(v), 'team', `a team otherwise: ${JSON.stringify(v)}`);
  }
  const kept = V.visitorRows([
    { id: 'pr:a', number: 1, via: 'you', teams: ['web-platform'], title: 't', repo: 'r', waitingSince: 1 },
    { id: 'pr:b', number: 2, via: 'team', teams: ['<img src=x>'], waitingSince: 2 },
    { id: 'pr:c', number: 3, waitingSince: 3 },
  ]);
  eq(kept.map((v) => v.via), ['you', 'team', 'team'], 'the cleaned list keeps who was asked');
  for (const v of kept) {
    eq(Object.keys(v), ['id', 'login', 'island', 'number', 'waitingSince', 'via'], 'and never the team names, the title or the repo');
  }

  // One hit area for both looks, and it is the box every clearance in this file was measured with.
  const box0 = V.visitorBox(0, 0);
  eq(box0, [-10, -45, 20, 46], 'the box the desk was measured with');
  for (const via of V.VISITOR_VIA) eq(boxUnion(V.visitorBoxes(0, 0, via)), box0, `the ${via} look spans exactly that box`);
  eq(V.visitorBoxes(0, 0), V.visitorBoxes(0, 0, 'team'), 'a look nobody named is the team one');

  // The sash lies inside the coat by half the coat's outline all round, so the silhouette is the coat's own.
  const bottom = -3;
  const coat = V.visitorCoatShape(0, bottom);
  eq(coat, [[-6.5, -31], [6.5, -31], [8, -3], [-8, -3]], 'the coat the parts were measured with');
  const sash = V.visitorSash(0, bottom);
  eq(sash.length, 4, 'a band of four corners');
  for (const [x, y] of sash) {
    const half = 6.5 + (1.5 * (y + 31)) / 28;
    assert(y > -31 && y < bottom && Math.abs(x) <= half - 1 + 1e-9, `a sash corner outside the coat's inner edge at ${x},${y}`);
  }
  const P = V.VISITOR_PASSPORT;
  const pbox = (p) => [p[0], p[1], p[2] - p[0], p[3] - p[1]];
  const area = polyArea(sash);
  const coatArea = polyArea(coat);
  const underCase = polyArea(clipToBox(sash, CASE_BODY));
  const underPassport = polyArea(clipToBox(sash, pbox(P.team)));
  const visible = area - underCase - underPassport;
  // Across the band: its area over the length of its centre line, from the middle of one end to the other.
  const across = area / Math.hypot((sash[0][0] + sash[1][0] - sash[2][0] - sash[3][0]) / 2, (sash[0][1] + sash[1][1] - sash[2][1] - sash[3][1]) / 2);
  assert(area / coatArea >= 0.15, `the sash covers ${(100 * area / coatArea).toFixed(1)}% of the coat`);
  assert(across >= 4, `and is ${across.toFixed(2)} px across`);
  assert(visible >= 0.9 * area, `the suitcase and the passport hide ${(area - visible).toFixed(2)} of its ${area.toFixed(2)} px2`);
  assert(sash.every(([, y]) => y > V.visitorBoxes(0, 0, 'team')[1][1] + 14), 'and it starts below the head');

  // The passport: presented beside the head when you were asked, at the hip when a team was. One passport, the same
  // size, in two places that do not overlap.
  eq([P.you[2] - P.you[0], P.you[3] - P.you[1]], [P.team[2] - P.team[0], P.team[3] - P.team[1]], 'one passport, two places');
  assert(P.you[3] <= coat[0][1], 'asked of you: held up clear of the shoulders, against the scene behind');
  assert(P.team[1] >= coat[0][1] && P.team[3] <= bottom, 'asked of a team: held within the coat\'s height');
  assert(overlapBy(pbox(P.you), pbox(P.team)) < 0, 'the two places do not overlap');
  // How far the lowered one stands proud of the coat's edge, at its closest.
  const proud = Math.min(...[P.team[1], P.team[3]].map((y) => P.team[2] - (6.5 + (1.5 * (y + 31)) / 28)));

  // Colour, in both themes: the sash against every coat it can be on, the passport it touches, and the reserved
  // state colours; the lowered passport against the coat it is held on.
  const looks = { light: {}, dark: {} };
  for (const scheme of ['light', 'dark']) {
    const coats = V.VISITOR_COATS.map((c) => c[scheme]);
    const sashDe = Math.min(...coats.map((h) => de00(V.VISITOR_SASH, h)));
    const sashCr = Math.min(...coats.map((h) => contrast(V.VISITOR_SASH, h)));
    const spine = SPINE_HEX[scheme === 'light' ? 'day' : 'dusk'];
    const passportDe = Math.min(...coats.map((h) => de00(V.REVIEWS.color, h)));
    const spineDe = Math.min(...coats.map((h) => de00(spine, h)));
    assert(sashDe >= 30, `the sash is only ${sashDe.toFixed(2)} from a coat (${scheme})`);
    assert(sashCr >= 3, `the sash is only ${sashCr.toFixed(2)}:1 against a coat (${scheme})`);
    assert(spineDe >= 20, `the lowered passport's spine is only ${spineDe.toFixed(2)} from a coat (${scheme})`);
    looks[scheme] = { sashVsCoat: rnd2(sashDe), sashContrast: rnd2(sashCr), passportVsCoat: rnd2(passportDe), spineVsCoat: rnd2(spineDe) };
  }
  let res = { d: Infinity };
  for (const [name, hex] of Object.entries(RESERVED)) if (de00(V.VISITOR_SASH, hex) < res.d) res = { d: de00(V.VISITOR_SASH, hex), name };
  assert(res.d >= 15, `the sash is only ${res.d.toFixed(2)} from ${res.name}`);
  assert(!Object.values(V.STATE).some((st) => [st.color, st.border].includes(V.VISITOR_SASH)), 'and it is no lane\'s colour');
  const vsPassport = de00(V.VISITOR_SASH, V.REVIEWS.color);
  assert(vsPassport >= 30 && contrast(V.VISITOR_SASH, V.REVIEWS.color) >= 3, 'the passport reads where it crosses the sash');
});

check('both looks are drawn as measured at 0, 1, 3, 9 and 40 of mixed kinds, in both themes, and the desk loses no clearance', () => {
  const rows = [row(A, 'open_pr', { repo: 'bp-core' }), row(B, 'running', { repo: 'bp-core' })];
  const LANDING_DRAWN = [V.VISITOR_LANDING[0] - 2, V.VISITOR_LANDING[1] - 2, V.VISITOR_LANDING[2] + 4, V.VISITOR_LANDING[3] + 14];
  const rectOf = (s) => [s.box[0], s.box[1], s.box[2] - s.box[0], s.box[3] - s.box[1]];
  const gapsOf = (added) => Object.fromEntries(DESK_CLEAR.map(([what, box]) => [what, Math.min(...added.map((s) => -overlapBy(rectOf(s), box)))]));
  const lineOf = (s) => `${s.kind}|${s.style}|${s.box.map((n) => rnd2(n)).join(',')}|${s.radii.map((n) => rnd2(n)).join(' ')}`;
  const digestOf = (added) => `${added.length}/${fnv1a(added.map(lineOf).join('\n')).toString(16)}`;
  const at = (s, slot) => Math.abs((s.box[0] + s.box[2]) / 2 - slot.x) < 12.5;
  const digests = {};
  for (const dark of [false, true]) {
    const theme = dark ? 'dusk' : 'day';
    const base = lastFrame(paintedShapes(rows, { dark }).shapes, theme);
    for (const n of [0, 1, 3, 9, 40]) {
      const list = viaRows(n);
      // The same queue with everybody asked by name: the desk exactly as it was drawn before there were two looks.
      const plainList = viaRows(n, ['you']);
      const hover = n ? deskSlots(list)[0][0] : null;
      const mixed = deskShapes(rows, n, { dark, list, hover, base }).added;
      const plain = deskShapes(rows, n, { dark, list: plainList, hover, base }).added;
      if (n === 40 && !dark) digests['40 day hovered'] = digestOf(plain);
      const slots = [...V.visitorLayout(V.visitorRows(list)).slots.values()];
      const teams = slots.filter((s) => s.visitor.via === 'team').length;
      const what = `${theme}, ${n} waiting`;
      if (n === 0) eq(mixed, [], `${what}: nothing drawn`);
      eq(mixed.length, plain.length + teams, `${what}: a team look adds one shape, its sash, and nothing else`);
      const sashes = mixed.filter((s) => s.kind === 'fill' && s.style === V.VISITOR_SASH);
      eq(sashes.length, teams, `${what}: a sash on each team visitor drawn and on nobody else`);
      for (const slot of slots) {
        const { via } = slot.visitor;
        const mine = sashes.filter((s) => at(s, slot));
        eq(mine.length, via === 'team' ? 1 : 0, `${what}: slot ${slot.index} (${via})`);
        if (mine.length) {
          eq(mine[0].box.map(rnd2), polyBox(V.visitorSash(slot.x, slot.y - 3)).map(rnd2), `${what}: the sash is drawn where visitorSash says`);
        }
        const p = V.VISITOR_PASSPORT[via];
        const passport = [slot.x + p[0], slot.y + p[1], slot.x + p[2], slot.y + p[3]];
        eq(mixed.filter((s) => s.kind === 'fill' && s.style === V.REVIEWS.color && at(s, slot)).map((s) => s.box.map(rnd2)),
          [passport.map(rnd2)], `${what}: slot ${slot.index}'s passport is held where VISITOR_PASSPORT says for ${via}`);
        const spine = mixed.filter((s) => s.kind === 'stroke' && s.style === SPINE_HEX[theme] && at(s, slot));
        assert(spine.length === 1 && inBox(rectOf(spine[0]), [passport[0], passport[1], passport[2] - passport[0], passport[3] - passport[1]]),
          `${what}: slot ${slot.index}'s passport has its pale spine, in the colour the palette check measured`);
        // By its size as well as its colour: the landing's posts are the same wood.
        const suitcase = mixed.filter((s) => s.kind === 'fill' && s.style === CASE_HEX[theme] && at(s, slot)
          && rnd2(s.box[2] - s.box[0]) === CASE_BODY[2] && rnd2(s.box[3] - s.box[1]) === CASE_BODY[3]);
        eq(suitcase.map((s) => s.box.map(rnd2)), [[slot.x + CASE_BODY[0], slot.y + CASE_BODY[1], slot.x + CASE_BODY[0] + CASE_BODY[2],
          slot.y + CASE_BODY[1] + CASE_BODY[3]].map(rnd2)], `${what}: the suitcase stands where the sash's measure assumed`);
      }
      // Every shape belongs to a visitor's own box or to its planks, and all of them clear the desk and every
      // session slot, padded by the widest line the queue strokes (see the check above for why).
      const grown = slots.map((s) => V.visitorBox(s.x, s.y).map((v, i) => (i < 2 ? v - 4 : v + 8)));
      const pad = 1.5;
      for (const s of mixed) {
        const rect = rectOf(s);
        assert(s.kind === 'text' || inBox(rect, LANDING_DRAWN) || grown.some((g) => inBox(rect, g)),
          `${what}: a shape outside every visitor's box and the planks: ${s.kind} ${s.style} at ${rect.map(rnd2).join(',')}`);
        const padded = [rect[0] - pad, rect[1] - pad, rect[2] + pad * 2, rect[3] + pad * 2];
        for (const [name, other] of [...DESK_CLEAR, ...SESSION_ENVELOPES]) {
          assert(overlapBy(padded, other) <= 0, `${what}: the queue paints over ${name} by ${overlapBy(padded, other).toFixed(1)}`);
        }
      }
      if (n) {
        const [was, now] = [gapsOf(plain), gapsOf(mixed)];
        for (const [name] of DESK_CLEAR) {
          assert(now[name] >= was[name] - 1e-9, `${what}: ${name} is ${now[name].toFixed(2)} from the queue, ${was[name].toFixed(2)} with one look`);
        }
      }
    }
    digests[`9 ${theme}`] = digestOf(deskShapes(rows, 9, { dark, list: viaRows(9, ['you']), base }).added);
  }
  // The direct look is the look the desk always had, shape for shape: pinned from 819b05b's own village.js, which
  // drew every visitor this way.
  eq(digests, { '40 day hovered': '163/dcaa5f7e', '9 day': '160/7534cfff', '9 dusk': '160/96b25320' },
    'a visitor asked by name is drawn exactly as every visitor was before the team look');
  // Privacy mode draws the same two looks: who was asked is not text, and nothing about a visitor is.
  const list = viaRows(9);
  const privBase = lastFrame(paintedShapes(rows, { privacy: true }).shapes, 'day');
  eq(deskShapes(rows, 9, { list, base: privBase, privacy: true }).added.map(shapeKey),
    deskShapes(rows, 9, { list }).added.map(shapeKey), 'privacy mode changes nothing at the desk');
});

check('who was asked never moves a visitor\'s hit area, its hover point or what a click does, and no team name is drawn', () => {
  const hits = {};
  for (const via of V.VISITOR_VIA) {
    const list = viaRows(1, [via]);
    const v = makeVillage();
    v.village.update(board([], list), { privacy: false });
    const [[id, slot]] = deskSlots(list);
    const box = V.visitorBox(slot.x, slot.y);
    // Every half-pixel centre from 4 px outside the box to 4 px beyond it: the hovered set is the box, exactly.
    const got = [];
    const want = [];
    for (let x = box[0] - 3.5; x < box[0] + box[2] + 4; x += 1) {
      for (let y = box[1] - 3.5; y < box[1] + box[3] + 4; y += 1) {
        v.fire('pointermove', x, y);
        if (v.hoveredId() === id) got.push(`${x},${y}`);
        if (x > box[0] && x < box[0] + box[2] && y > box[1] && y < box[1] + box[3]) want.push(`${x},${y}`);
      }
    }
    eq(got, want, `${via}: hovered over exactly its box`);
    hits[via] = got.map((k) => k.split(',').map((n, i) => Number(n) - (i ? slot.y : slot.x)).join(','));
    v.fire('pointerleave', 0, 0);
    const aimed = v.aimPoint(slot.x, slot.y, id);
    const point = v.log.hovers[v.log.hovers.length - 1].point;
    eq([rnd2(point.x), rnd2(point.y)], [rnd2(slot.x), rnd2(box[1])], `${via}: the hover point is the top of its head`);
    v.click(aimed.x, aimed.y);
    eq([v.log.opened, v.log.selected], [[id], []], `${via}: a click opens that PR by id and selects nothing`);
    v.village.destroy();
  }
  eq(hits.you, hits.team, 'the two looks answer the pointer over the same points');
  // Team slugs are text GitHub users chose. The village keeps none of them and draws no text for a visitor.
  const texts = [];
  const hostile = ['<img src=x onerror=alert(1)>', 'web-platform', 'x'.repeat(300), 'pr:', '‮evil'];
  withFrameLoop((loop) => {
    const v = makeVillage({ texts, measure: true });
    v.village.start();
    v.village.update(board([row(A, 'running', { repo: 'bp-core' })], viaRows(12).map((r) => ({ ...r, teams: hostile }))), { privacy: false });
    loop.pump(0.2);
    v.village.destroy();
  });
  for (const t of texts) assert(!hostile.some((h) => t.includes(h.slice(0, 6))), `a team name reached the canvas: ${t}`);
  assert(texts.includes('+3 more'), 'while the overflow line is still written');
});

check('who was asked adds no motion: both looks walk in, stand and are hovered at the frame rate one look had', () => {
  const rows = [row(A, 'running', { repo: 'bp-core' })];
  const run = (pattern) => {
    let out = null;
    withFrameLoop((loop) => {
      const v = makeVillage({ reduce: false });
      v.village.start();
      v.village.update(board(rows, []), { privacy: false });
      loop.pump(0.4);
      const list = viaRows(9, pattern);
      v.village.update(board(rows, list), { privacy: false });
      const arriving = loop.pump(12);
      const standing = loop.pump(2);
      const [[, head], [, second]] = deskSlots(list);
      v.fire('pointermove', head.x, head.y - 20);
      const hovered = loop.pump(2);
      v.fire('pointermove', second.x, second.y - 20);
      const swept = loop.pump(2);
      v.village.update(board(rows, list.slice(1)), { privacy: false });
      const closing = loop.pump(4);
      const after = loop.pump(2);
      out = Object.fromEntries(Object.entries({ arriving, standing, hovered, swept, closing, after })
        .map(([k, r]) => [k, [r.frames, r.timers]]));
      v.village.destroy();
    });
    reduceMotion = true;
    return out;
  };
  const one = run(['you']);
  eq(run(MIXED_VIA), one, 'a mixed queue asks for exactly the frames and timers an all-direct one does');
  eq(run(['team']), one, 'and so does an all-team one');
  for (const k of ['standing', 'hovered', 'swept', 'after']) {
    assert(one[k][0] <= 26, `ambient while nobody walks: ${k} drew ${one[k][0]} frames in 2 s`);
  }
  assert(one.arriving[0] > 26 && one.closing[0] > 0, `full rate only while somebody walks (${JSON.stringify(one)})`);
});

check('the desk draws a request asked of you before any asked of a team, with the longest wait still at the barrier', () => {
  // Charlie's own board: every request so far arrives through a team. A direct one arriving among eleven of them is
  // the newest, so by wait alone it would be the twelfth, and the one that most needs him would be "+3 more".
  const teams = viaRows(11, ['team']);
  const direct = { ...viaRows(12, ['you'])[11], author: 'direct-dev' };
  const list = V.visitorRows([...teams, direct]);
  const layout = V.visitorLayout(list);
  eq([layout.shown, layout.hidden, layout.total], [9, 3, 12], 'nine drawn, three held back, twelve counted');
  assert(layout.slots.has(direct.id), 'the one asked of you is drawn');
  eq(layout.slots.get(list[0].id).index, 0, 'the longest wait still stands at the barrier, where the Reviews pill points');
  eq(layout.slots.get(direct.id).index, 8, 'and the newcomer at the back, since the drawn ones keep the list\'s order');
  eq([...layout.slots.values()].map((s) => s.index), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'slots in that order');
  // With nobody asked by name the desk draws exactly what it drew before: the nine longest waits.
  for (const n of [0, 1, 9, 40]) {
    const l = V.visitorRows(viaRows(n, ['team']));
    eq([...V.visitorLayout(l).slots.keys()], l.slice(0, V.VISITOR_CAPACITY).map((v) => v.id), `${n} team requests`);
  }
  // More asked of you than there is room for: the longest wait whoever was asked, then the longest of yours.
  const many = V.visitorRows(viaRows(15, ['team', 'you', 'you']));
  const m = V.visitorLayout(many);
  eq(m.slots.get(many[0].id).index, 0, 'the head is the longest wait, even asked of a team');
  eq([...m.slots.keys()].slice(1), many.slice(1).filter((v) => v.via === 'you').slice(0, 8).map((v) => v.id),
    'and every other place is asked of you, longest first');
});

check('a request asked of you reaching a full desk takes a place, and the team visitor it displaces fades where it stands', () => {
  // Displaced is not answered: it is still waiting, now among the "+N more". Walking off down the pier is what an
  // answered request does, and it would also cross the newcomer walking up it.
  const rows = [row(A, 'running', { repo: 'bp-core' })];
  const teams = viaRows(11, ['team']);
  const direct = { ...viaRows(12, ['you'])[11], author: 'direct-dev' };
  const before = [...V.visitorLayout(V.visitorRows(teams)).slots.values()];
  const after = V.visitorLayout(V.visitorRows([...teams, direct]));
  const gone = before.filter((s) => !after.slots.has(s.visitor.id));
  eq(gone.map((s) => s.index), [8], 'the team visitor at the back gives up its place');
  const at = gone[0];
  const worst = { overlap: 0 };
  let fading = null;
  let settled = null;
  withFrameLoop((loop) => {
    const shapes = [];
    reduceMotion = false;
    const { village } = geometryVillage(shapes, { reduce: false });
    village.update(board(rows, teams), { privacy: false });
    loop.pump(0.5);
    eq(village.visitors(), { shown: 9, waiting: 11, hidden: 2, board: 11 }, 'nine team visitors drawn, two held back');
    village.update(board(rows, [...teams, direct]), { privacy: false });
    eq(village.visitors(), { shown: 10, waiting: 12, hidden: 3, board: 12 }, 'for a moment ten: one fading, one waiting its turn');
    const frames = coatFrames(shapes, loop, 4);
    // Coats standing on the displaced one's slot, before the newcomer could have walked that far.
    const onSlot = (c) => Math.abs(c.box[0] + c.box[2] / 2 - at.x) < 0.5 && Math.abs(c.box[1] + c.box[3] + 3 - at.y) < 1.5;
    const early = frames.filter((f) => f.ms - frames[0].ms < 1000 * 0.9);
    fading = early.map((f) => f.coats.filter(onSlot).map((c) => rnd2(c.alpha))).map((a) => (a.length ? a[0] : null));
    // Nothing touches the fading one while it is in view. (A newcomer to the back of a single file does walk past
    // the ones standing ahead of it: that is the queue's own recorded cost, not this change's.)
    for (const f of early) {
      const mine = f.coats.filter(onSlot);
      for (const c of mine) for (const o of f.coats) if (o !== c) worst.overlap = Math.max(worst.overlap, overlapBy(c.box, o.box));
    }
    settled = { visitors: village.visitors(), coats: frames[frames.length - 1].coats.length, idle: loop.pump(2).frames };
    village.destroy();
  });
  reduceMotion = true;
  const shown = fading.filter((a) => a !== null);
  assert(shown.length >= 3 && shown[0] > 0.5, `it is still in view at first, where it stood (${JSON.stringify(fading)})`);
  assert(shown.every((a, i) => i === 0 || a <= shown[i - 1]), `and only fades, never walking off its slot (${JSON.stringify(fading)})`);
  assert(fading[fading.length - 1] === null, `and is gone before the newcomer arrives (${JSON.stringify(fading)})`);
  assert(worst.overlap <= 0, `two coats in view overlap by ${worst.overlap.toFixed(1)} px`);
  eq(settled.visitors, { shown: 9, waiting: 12, hidden: 3, board: 12 }, 'nine standing, the direct one among them');
  eq(settled.coats, V.VISITOR_CAPACITY, 'nine coats drawn at the end');
  assert(settled.idle <= 26, `ambient again once everyone stands (${settled.idle} frames in 2 s)`);
});

check('an island badges its own waits, the map says what the whole board has, and a repo with no sessions has no island', () => {
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => row(`local_aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, 'running', { repo: 'alpha' })),
    ...Array.from({ length: 2 }, (_, i) => row(`local_bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`, 'idle', { repo: 'beta' })),
  ];
  const list = [...deskRows(2, 'alpha'), ...deskRows(3, 'beta'), ...deskRows(1, 'ghost', null)];
  const out = paintedShapes(rows, { mode: 'world', visitors: list });
  eq(out.islandList.map((is) => [is.repo, is.reviews]), [['alpha', 2], ['beta', 3]],
    'each island counts its own waits, and the repo with no sessions has no island');
  const frame = lastFrame(out.shapes, 'day', WORLD_WATER_HEX.day);
  const teal = frame.filter((s) => s.kind === 'fill' && s.style === V.REVIEWS.color);
  for (const is of out.islandList) {
    const on = teal.filter((s) => s.box[0] >= is.sign[0] && s.box[2] <= is.sign[0] + is.sign[2]
      && s.box[1] >= is.sign[1] && s.box[3] <= is.sign[1] + is.sign[3]);
    eq(on.length, 1, `${is.repo}: one reviews badge on its own name board`);
  }
  // The whole board's total, in the top margin, which is outside every island's cell: the only thing that can
  // say the sixth wait exists at all.
  const cells = out.islandList.map((is) => is.cell);
  const margin = teal.filter((s) => s.box[3] <= V.WORLD.margin);
  eq(margin.length, 1, 'one total pill above the map');
  for (const cell of cells) {
    assert(overlapBy([margin[0].box[0], margin[0].box[1], margin[0].box[2] - margin[0].box[0], margin[0].box[3] - margin[0].box[1]],
      cell) <= 0, 'and it is outside every island cell');
  }
  const texts = [];
  withFrameLoop((loop) => {
    const v = makeVillage({ texts, measure: true, mode: 'world' });
    v.village.start();
    v.village.update(board(rows, list), { privacy: false });
    loop.pump(0.2);
    v.village.destroy();
  });
  assert(texts.includes('6 PRs waiting on your review'), `the map counts the whole board (${texts.slice(0, 10)})`);
  // An island shows only its own queue, and the map draws no village at all.
  const alpha = paintedShapes(rows, { mode: 'world', island: 'alpha', visitors: list });
  eq(alpha.scene, 'village', 'an island shows its village');
  const vAlpha = makeVillage({ mode: 'world', island: 'alpha' });
  vAlpha.village.update(board(rows, list), { privacy: false });
  eq(vAlpha.village.visitors(), { shown: 2, waiting: 2, hidden: 0, board: 6 },
    'the desk on an island holds that island, and the board total is still the board');
  vAlpha.village.destroy();
  const map = makeVillage({ mode: 'world' });
  map.village.update(board(rows, list), { privacy: false });
  const [[id, slot]] = deskSlots(list);
  map.fire('pointermove', slot.x, slot.y - 20);
  assert(map.hoveredId() !== id, 'and no visitor is hoverable on the map, where no village is drawn');
  map.village.destroy();
});

// ---------- the page, booted on a small DOM ----------

// Enough DOM for app.js to run: the tree parsed out of index.html, attributes, classes, children, focus and events.
// Text matching in tests/test_web.py holds the shape of the page's DOM code; this is for the behaviour text cannot
// reach, which so far means one thing: the page and the village agreeing on which island is open across an outage.
const VOID_TAGS = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'area', 'base', 'col']);

function makeDoc() {
  const doc = { hidden: false, visibilityState: 'visible', title: '', _on: new Map() };
  // A compound simple selector: tag, #id, .class and [attr] or [attr=value], in any combination and all required.
  // `button.pill` and `a.pr-pill` are real selectors in app.js, and a matcher that only took one token at a time
  // answered false for every one of them, so every committed check that looked for a HUD pill or a PR pill silently
  // passed over an empty list. Descendant combinators (`.card-actions button`) are matched right to left.
  const simple = (node, part) => {
    const tokens = part.match(/\[[^\]]*\]|[#.]?[A-Za-z][A-Za-z0-9_-]*/g);
    if (!tokens) return false;
    return tokens.every((token) => {
      const attr = token.match(/^\[([a-z-]+)(?:=["']?([^"'\]]*)["']?)?\]$/);
      if (attr) return node.attrs.has(attr[1]) && (attr[2] === undefined || node.attrs.get(attr[1]) === attr[2]);
      if (token.startsWith('.')) return node._class.split(/\s+/).includes(token.slice(1));
      if (token.startsWith('#')) return node.id === token.slice(1);
      return node.tagName === token.toUpperCase();
    });
  };
  const matches = (node, sel) => String(sel).split(',').map((s) => s.trim()).filter(Boolean).some((part) => {
    const chain = part.split(/\s+/);
    if (!simple(node, chain.pop())) return false;
    let at = node.parent;
    for (const ancestor of chain.reverse()) {
      while (at && !simple(at, ancestor)) at = at.parent;
      if (!at) return false;
      at = at.parent;
    }
    return true;
  });
  const mk = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), id: '', _class: '', _text: '', children: [], parent: null, hidden: false,
      attrs: new Map(), style: {}, _on: new Map(), value: '', checked: false, scrollTop: 0,
      scrollHeight: 0, clientHeight: 0, title: '', type: '',
    };
    // A write to `dataset` has to reach `attrs`, or `[data-column]` and `[data-id]` match nothing: a real DOM keeps
    // the two the same object, and the page sets most of its data attributes this way.
    const kebab = (k) => `data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    const data = {};
    Object.defineProperty(node, 'dataset', {
      value: new Proxy(data, {
        set: (t, k, v) => { t[k] = String(v); node.attrs.set(kebab(k), String(v)); return true; },
        deleteProperty: (t, k) => { delete t[k]; node.attrs.delete(kebab(k)); return true; },
      }),
    });
    Object.defineProperty(node, 'className', { get: () => node._class, set: (v) => { node._class = String(v); } });
    Object.defineProperty(node, 'classList', {
      get: () => {
        const parts = () => new Set(node._class.split(/\s+/).filter(Boolean));
        return {
          add: (...c) => { const s = parts(); c.forEach((x) => s.add(x)); node._class = [...s].join(' '); },
          remove: (...c) => { const s = parts(); c.forEach((x) => s.delete(x)); node._class = [...s].join(' '); },
          toggle: (c, on) => { const s = parts(); if (on === undefined ? s.has(c) : !on) s.delete(c); else s.add(c); node._class = [...s].join(' '); },
          contains: (c) => parts().has(c),
        };
      },
    });
    Object.defineProperty(node, 'textContent', {
      get: () => (node.children.length ? node.children.map((c) => c.textContent).join('') : node._text),
      set: (v) => { node.children.forEach((c) => { c.parent = null; }); node.children = []; node._text = v == null ? '' : String(v); },
    });
    node.setAttribute = (k, v) => {
      node.attrs.set(k, String(v));
      if (k === 'class') node._class = String(v);
      if (k === 'id') node.id = String(v);
      if (k === 'hidden') node.hidden = true;
      if (k.startsWith('data-')) node.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
    };
    node.getAttribute = (k) => (node.attrs.has(k) ? node.attrs.get(k) : null);
    node.removeAttribute = (k) => node.attrs.delete(k);
    node.hasAttribute = (k) => node.attrs.has(k);
    node.appendChild = (c) => {
      if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c);
      c.parent = node;
      node._text = '';
      node.children.push(c);
      return c;
    };
    node.append = (...cs) => cs.forEach((c) => {
      if (typeof c === 'string') node.appendChild(doc.createTextNode(c));
      else if (c && c._fragment) c.children.slice().forEach((g) => node.appendChild(g));
      else if (c) node.appendChild(c);
    });
    node.prepend = (c) => { c.parent = node; node.children.unshift(c); };
    node.removeChild = (c) => { node.children = node.children.filter((x) => x !== c); c.parent = null; return c; };
    node.remove = () => { if (node.parent) node.parent.removeChild(node); };
    node.replaceChildren = (...cs) => {
      node.children.forEach((c) => { c.parent = null; });
      node.children = [];
      node._text = '';
      cs.forEach((c) => node.append(c));
    };
    node.insertBefore = (c, ref) => {
      const at = node.children.indexOf(ref);
      node.children.splice(at < 0 ? node.children.length : at, 0, c);
      c.parent = node;
      return c;
    };
    node.addEventListener = (t, fn) => node._on.set(t, [...(node._on.get(t) || []), fn]);
    node.removeEventListener = (t, fn) => node._on.set(t, (node._on.get(t) || []).filter((f) => f !== fn));
    // Bubbles, so a handler delegated to an ancestor sees it, the way the page's own wiring expects.
    node.dispatch = (t, extra = {}) => {
      const e = { type: t, target: node, preventDefault() {}, stopPropagation() {}, ...extra };
      for (let p = node; p; p = p.parent) for (const fn of p._on.get(t) || []) fn({ ...e, currentTarget: p });
      return e;
    };
    node.click = () => node.dispatch('click');
    node.focus = () => { doc.activeElement = node; };
    node.blur = () => { if (doc.activeElement === node) doc.activeElement = doc.body; };
    node.contains = (other) => { for (let p = other; p; p = p.parent) if (p === node) return true; return false; };
    node.closest = (sel) => { for (let p = node; p; p = p.parent) if (matches(p, sel)) return p; return null; };
    node.matches = (sel) => matches(node, sel);
    const walk = (n, out) => { for (const c of n.children) { out.push(c); walk(c, out); } return out; };
    node.querySelectorAll = (sel) => walk(node, []).filter((n) => matches(n, sel));
    node.querySelector = (sel) => node.querySelectorAll(sel)[0] || null;
    node.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900, x: 0, y: 0 });
    node.scrollIntoView = () => {};
    node.getContext = () => null;
    return node;
  };
  doc.createElement = mk;
  doc.createElementNS = (_ns, tag) => mk(tag);
  doc.createTextNode = (t) => { const n = mk('#text'); n._text = String(t); return n; };
  doc.createDocumentFragment = () => { const n = mk('#fragment'); n._fragment = true; return n; };
  doc.body = mk('body');
  doc.head = mk('head');
  doc.documentElement = mk('html');
  doc.activeElement = doc.body;
  // Walked rather than indexed: app.js also assigns node.id directly, which an index built on setAttribute misses.
  const byId = (n, id) => {
    for (const c of n.children) {
      if (c.id === id) return c;
      const hit = byId(c, id);
      if (hit) return hit;
    }
    return null;
  };
  doc.getElementById = (id) => byId(doc.body, id) || byId(doc.head, id) || null;
  doc.addEventListener = (t, fn) => doc._on.set(t, [...(doc._on.get(t) || []), fn]);
  doc.removeEventListener = () => {};
  doc.dispatch = (t, extra = {}) => { for (const fn of doc._on.get(t) || []) fn({ type: t, preventDefault() {}, stopPropagation() {}, ...extra }); };
  doc.execCommand = () => true;
  const all = (n, out) => { for (const c of n.children) { out.push(c); all(c, out); } return out; };
  doc.querySelectorAll = (sel) => all(doc.body, []).filter((n) => matches(n, sel));
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  doc.mk = mk;
  return doc;
}

// index.html's own markup, so the page is wired to the elements it really ships with rather than a list kept in step
// by hand: an id renamed in the markup shows up here as a null the page trips over.
function parsePage(html, doc) {
  const src = html.replace(/<!doctype[^>]*>/i, '').replace(/<!--[\s\S]*?-->/g, '');
  const stack = [doc.body];
  let i = 0;
  let inBody = false;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i && inBody && stack.length > 1) {
      const text = src.slice(i, lt);
      if (text.trim()) stack[stack.length - 1]._text += text.replace(/\s+/g, ' ');
    }
    const gt = src.indexOf('>', lt);
    if (gt < 0) break;
    const raw = src.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase();
      if (name === 'body') inBody = false;
      else if (stack.length > 1 && stack[stack.length - 1].tagName === name.toUpperCase()) stack.pop();
      continue;
    }
    const named = raw.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
    if (!named) continue;
    const tag = named[1].toLowerCase();
    const attrs = [...raw.slice(named[1].length).matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)]
      .filter((a) => a[1] !== '/');
    const apply = (node) => attrs.forEach((a) => node.setAttribute(a[1], a[2] ?? a[3] ?? a[4] ?? ''));
    if (tag === 'body') {
      inBody = true;
      apply(doc.body);
      continue;
    }
    if (tag === 'script') {
      const close = src.indexOf('</script>', i);
      if (close >= 0) i = close + 9;
      continue;
    }
    if (!inBody) {
      if (tag === 'link') apply(doc.head.appendChild(doc.mk('link')));
      continue;
    }
    const node = doc.mk(tag);
    apply(node);
    stack[stack.length - 1].appendChild(node);
    if (!VOID_TAGS.has(tag) && !raw.endsWith('/')) stack.push(node);
  }
  return doc;
}

const PAGE_HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

function makeStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
}

let bootCount = 0;

// Boots the real app.js on that DOM, against a board it can be told to stop answering. `pump` runs the fake timers
// so a poll, a retry and an outage all happen on a clock the check drives.
async function bootPage({ board, stored = {} } = {}) {
  const doc = parsePage(PAGE_HTML, makeDoc());
  const local = makeStore(stored);
  const session = makeStore({ 'town.token': 'tok_aaaaaaaaaaaaaaaaaaaa' });
  const timers = [];
  const at = { ms: 0 };
  const server = { board, status: 200, etag: 'etag-1', failing: false };
  const pageStub = new Proxy(function () {}, {
    get: (_t, k) => (k === 'measureText' ? (t) => ({ width: String(t).length * 8 })
      : k === Symbol.toPrimitive ? () => 0 : k === 'width' ? 10 : pageStub),
    set: () => true,
    apply: () => pageStub,
  });
  doc.getElementById('village').getContext = () => pageStub;
  const win = {
    localStorage: local, sessionStorage: session, devicePixelRatio: 1,
    matchMedia: (q) => ({ matches: String(q).includes('reduce'), addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
  };
  const saved = {};
  const put = (k, v) => {
    saved[k] = { had: k in globalThis, value: globalThis[k] };
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  };
  put('document', doc);
  put('window', win);
  put('localStorage', local);
  put('sessionStorage', session);
  put('location', { hash: '', pathname: '/', search: '' });
  put('history', { replaceState() {} });
  put('navigator', { clipboard: { writeText: async () => {} } });
  put('matchMedia', win.matchMedia);
  put('CSS', { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) });
  put('performance', { now: () => at.ms });
  put('requestAnimationFrame', (f) => timers.push({ f, at: at.ms }) && timers.length);
  put('cancelAnimationFrame', () => {});
  put('setTimeout', (f, ms) => timers.push({ f, at: at.ms + (Number(ms) || 0) }) && timers.length);
  put('clearTimeout', (id) => { if (timers[id - 1]) timers[id - 1].dead = true; });
  put('setInterval', (f, ms) => timers.push({ f, at: at.ms + (Number(ms) || 0), every: Number(ms) || 1000 }) && timers.length);
  put('clearInterval', (id) => { if (timers[id - 1]) timers[id - 1].dead = true; });
  put('AbortController', function AbortStub() { this.signal = {}; this.abort = () => {}; });
  put('fetch', async (path) => {
    if (server.failing) throw new Error('offline');
    if (path !== '/api/board') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
    if (server.status === 304) return { ok: false, status: 304, headers: { get: () => server.etag } };
    return { ok: true, status: 200, headers: { get: () => server.etag }, json: async () => server.board };
  });

  bootCount += 1;
  await import(new URL(`../web/app.js?boot=${bootCount}`, import.meta.url));

  const pump = async (ms = 0) => {
    const until = at.ms + ms;
    for (let guard = 0; guard < 600; guard++) {
      const due = timers.filter((t) => !t.dead && !t.ran && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      at.ms = Math.max(at.ms, due.at);
      if (due.every) due.at += due.every;
      else due.ran = true;
      try { due.f(at.ms); } catch { /* a corner of the page this DOM does not reach */ }
      for (let i = 0; i < 4; i++) await Promise.resolve();
    }
    at.ms = Math.max(at.ms, until);
    for (let i = 0; i < 24; i++) await Promise.resolve();
  };
  await pump(0);

  return {
    doc,
    server,
    pump,
    local,
    restore: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (!v.had) delete globalThis[k];
        else Object.defineProperty(globalThis, k, { value: v.value, configurable: true, writable: true });
      }
    },
    crumbs: () => doc.getElementById('crumbs').children
      .filter((n) => n._class.includes('crumb-link') || n._class.includes('crumb-here')).map((n) => n.textContent),
    crumbLink: (text) => doc.getElementById('crumbs').children
      .find((n) => n._class.includes('crumb-link') && n.textContent === text) || null,
    listed: () => doc.getElementById('rail-body').querySelectorAll('.rail-list').reduce((n, ul) => n + ul.children.length, 0),
    scopeNote: () => (doc.getElementById('rail-scope').hidden ? null : doc.getElementById('rail-scope-text').textContent),
  };
}

const pageRow = (id, lane, repo) => ({
  id, lane, title: `title ${id.slice(-4)}`, repo, cwd: `/work/${repo}`, look: 7, kind: 'desktop', canOpen: true,
  started: '2026-09-18T00:00:00Z', updated: '2026-09-18T00:00:00Z', statusUpdatedAt: '2026-09-18T00:00:00Z',
  tokens: 1000,
});
const PAGE_BOARD = {
  counts: { running: 1, errored: 2, idle: 1 },
  sessions: [
    pageRow('local_aaaaaaaa-0000-4000-8000-000000000001', 'running', 'alpha'),
    pageRow('local_aaaaaaaa-0000-4000-8000-000000000002', 'errored', 'alpha'),
    pageRow('local_aaaaaaaa-0000-4000-8000-000000000004', 'idle', 'alpha'),
    pageRow('local_bbbbbbbb-0000-4000-8000-000000000003', 'errored', 'beta'),
  ],
};

// ---------- page helpers ----------

check('app.js loads headless', () => {
  if (appError) throw new Error(`import failed: ${appError && appError.name}: ${appError && appError.message}`);
});

await checkAsync('a poll outage gives the open island back on reconnect, on a fresh board and on a 304', async () => {
  // Three failed polls blank the village, and a blank board reads village-side as "its repo has left", so the
  // island was dropped and never came back: `w w` did not bring it (the village had forgotten it too) and only a
  // reload did, while storage went on naming an island that was not on screen.
  for (const reconnectWith of [200, 304]) {
    const p = await bootPage({ board: PAGE_BOARD, stored: { 'town.mode': 'world', 'town.island': 'beta', 'town.rail': 'open' } });
    try {
      eq(p.crumbs(), ['World', 'beta'], `${reconnectWith}: the remembered island opens on the first board`);
      eq(p.listed(), 1, 'and the list holds that island alone');
      eq(p.scopeNote(), 'Sessions on beta only.', 'and says so');
      eq(p.doc.body.dataset.island, 'open', 'and the body attribute agrees');
      p.server.failing = true;
      await p.pump(12000);
      eq(p.crumbs(), [], `${reconnectWith}: the outage takes the island off screen`);
      // Stale here was the bug the write was moved out of setIslandNow to fix, and moving it left this hole.
      eq(p.doc.body.dataset.island, 'none', `${reconnectWith}: and the body attribute follows it off`);
      p.server.failing = false;
      p.server.status = reconnectWith;
      await p.pump(12000);
      eq(p.crumbs(), ['World', 'beta'], `${reconnectWith}: reconnecting sails back to the island`);
      eq(p.listed(), 1, `${reconnectWith}: with the island's own list`);
      eq(p.scopeNote(), 'Sessions on beta only.', `${reconnectWith}: and its note`);
      eq(p.doc.body.dataset.island, 'open', `${reconnectWith}: and the attribute`);
      eq(p.local.getItem('town.island'), 'beta', `${reconnectWith}: storage and the screen agree`);
      // And the mode round-trip still finds it, which is the other thing the outage broke.
      p.doc.getElementById('mode-village').dispatch('click');
      await p.pump(200);
      eq(p.crumbs(), [], `${reconnectWith}: one village has no island`);
      p.doc.getElementById('mode-world').dispatch('click');
      await p.pump(200);
      eq(p.crumbs(), ['World', 'beta'], `${reconnectWith}: and the world comes back to it`);
    } finally {
      p.restore();
    }
  }

  // The other half of the same rule, and the one sailing back could have broken: an island walked out of on
  // purpose stays walked out of, through good polls and through an outage. The page forgets its stored choice on
  // those exits, and reconciling reads that memory, so nothing has an island to put back.
  const p = await bootPage({ board: PAGE_BOARD, stored: { 'town.mode': 'world', 'town.island': 'beta', 'town.rail': 'open' } });
  try {
    eq(p.crumbs(), ['World', 'beta'], 'on the island');
    p.doc.getElementById('scene-back').dispatch('click');
    await p.pump(200);
    eq(p.crumbs(), [], 'walked out to the map');
    eq(p.local.getItem('town.island'), null, 'and the page forgot it');
    await p.pump(6000);
    eq(p.crumbs(), [], 'a few good polls leave it on the map');
    p.server.failing = true;
    await p.pump(12000);
    p.server.failing = false;
    await p.pump(12000);
    eq(p.crumbs(), [], 'and so does an outage and a reconnect');
    eq(p.listed(), 2, 'with every repo in the list: both errored rows, not just the island one');
  } finally {
    p.restore();
  }
});

await checkAsync('activating a breadcrumb keeps keyboard focus in the page', async () => {
  // renderSceneBar replaces the crumbs, and its only focus restore fired when the bar closed altogether, so the
  // middle levels left focus on a detached node and a browser drops that to <body>: the next Tab starts at the top.
  const p = await bootPage({ board: PAGE_BOARD, stored: { 'town.mode': 'world', 'town.island': 'alpha', 'town.rail': 'open' } });
  try {
    const canvas = p.doc.getElementById('village');
    const fire = (type, x, y) => canvas.dispatch(type, { clientX: x, clientY: y, button: 0, isPrimary: true, pointerType: 'mouse', detail: 1 });
    const intoTheRoom = async () => {
      const [bx, by] = V.COTTAGE.badge;
      fire('pointermove', bx, by);
      fire('pointerdown', bx, by);
      fire('click', bx, by);
      await p.pump(200);
      eq(p.crumbs(), ['World', 'alpha', 'The Cottages'], 'three levels, the middle one a link');
    };
    await intoTheRoom();
    const middle = p.crumbLink('alpha');
    assert(middle, 'the island crumb is a link');
    middle.focus();
    assert(p.doc.activeElement === middle, 'the island crumb holds the focus');
    middle.dispatch('click');
    await p.pump(200);
    eq(p.crumbs(), ['World', 'alpha'], 'the room closed onto the island');
    assert(p.doc.body.contains(p.doc.activeElement), 'focus is still in the page');
    eq(p.doc.activeElement.id, 'scene-back', 'on the back button, that level being the current one now');

    // A crumb that survives its rebuild keeps the focus itself.
    await intoTheRoom();
    const root = p.crumbLink('World');
    root.focus();
    p.crumbLink('alpha').dispatch('click');
    await p.pump(200);
    assert(p.doc.body.contains(p.doc.activeElement), 'focus is still in the page');
    eq([p.doc.activeElement._class, p.doc.activeElement.textContent], ['crumb-link', 'World'], 'on the same crumb');

    // And the bar closing altogether still hands focus to the view, as it always did.
    p.crumbLink('World').focus();
    p.crumbLink('World').dispatch('click');
    await p.pump(200);
    eq(p.crumbs(), [], 'back out to the world map');
    eq(p.doc.activeElement.id, 'view-village', 'focus lands on the village view');
  } finally {
    p.restore();
  }
});

await checkAsync('the Reviews pill counts the board and a visitor click posts an id and nothing else', async () => {
  // Nothing committed could see a HUD pill until the stub matcher learned compound selectors: `renderPills` walks
  // `button.pill`, so every assertion about a pill was passing over an empty list. These are the rules a text match
  // cannot hold: that the pill carries the server's own number, that a visitor is not in any lane pill, and that a
  // click sends `{"id"}` with no URL in the body.
  const url = 'https://github.com/Acme-DataTeam/wonderful-things-core/pull/532';
  const visitorId = `pr:${'a3dbd8b1a59cdf1a'}`;
  const board = {
    ...PAGE_BOARD,
    visitors: [{ id: visitorId, number: 532, repo: 'alpha', owner: 'Acme-DataTeam', title: 'Fix the funnel',
      author: 'sam', waitingSince: -1, look: 7 }],
    reviews: { waiting: 1, byRepo: { alpha: 1 }, waitingOn: { [url]: ['robin'] } },
  };
  const p = await bootPage({ board, stored: { 'town.mode': 'village' } });
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path, init) => {
    if (typeof path === 'string' && path.startsWith('/api/')) {
      posts.push({ path, body: init && init.body, headers: init && init.headers });
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
    }
    return realFetch(path, init);
  };
  try {
    const pills = p.doc.getElementById('pills').querySelectorAll('button.pill');
    assert(pills.length > 1, `the matcher sees the pills: ${pills.length}`);
    const reviewsPill = pills.find((b) => b.dataset.lane === 'reviews');
    assert(reviewsPill, 'there is a Reviews pill');
    eq(reviewsPill.querySelector('.pill-count').textContent, '1', 'it carries the board number');
    assert(!reviewsPill._class.includes('zero'), 'and is not drawn as a zero');
    assert(reviewsPill.getAttribute('aria-label').includes('PR waiting on your review'), 'its own words');
    for (const other of pills.filter((b) => b.dataset.lane !== 'reviews')) {
      assert(!other.getAttribute('aria-label').includes('review'), `${other.dataset.lane} says nothing about reviews`);
    }

    p.doc.getElementById('view-board').dispatch('click');
    await p.pump(400);
    assert(!p.doc.getElementById('board-view').hidden, 'the Board is showing');
    const cards = p.doc.querySelectorAll('.kcard');
    for (const card of cards) assert(!card.textContent.includes('532'), 'no visitor became a card');
    const notes = p.doc.getElementById('board-foot').querySelectorAll('.board-note').map((n) => n.textContent);
    eq(notes.length, 2, `two foot notes: ${JSON.stringify(notes)}`);
    assert(notes[1].startsWith('Reviews 1: a PR waiting'), `the count is the second note: ${notes[1]}`);
    const columns = p.doc.querySelectorAll('[data-column]');
    eq(columns.length, 10, `ten columns, not eleven: ${columns.map((n) => n.attrs.get('data-column')).join(' ')}`);
    assert(!columns.some((n) => n.attrs.get('data-column') === 'reviews'), 'and none of them is a reviews column');

    p.doc.getElementById('view-village').dispatch('click');
    await p.pump(50);
    eq(posts.length, 0, 'nothing is posted by a render');

    // The real click, at the desk slot the village puts the longest wait in.
    const canvas = p.doc.getElementById('village');
    const [, slot] = [...V.visitorLayout(V.visitorRows(board.visitors)).slots.entries()][0];
    for (const type of ['pointermove', 'pointerdown', 'click']) {
      canvas.dispatch(type, { clientX: slot.x, clientY: slot.y - 40, button: 0, isPrimary: true, pointerType: 'mouse', detail: 1 });
    }
    await p.pump(200);
    eq(posts.map((q) => q.path), ['/api/open-review'], 'the click reaches the review route and no other');
    const sent = JSON.parse(posts[0].body);
    eq(Object.keys(sent), ['id'], 'exactly one key');
    eq(sent.id, visitorId, 'the id the board gave it');
    assert(!posts[0].body.includes('github.com'), `no URL in the body: ${posts[0].body}`);
    assert(!posts[0].body.includes('/'), `nothing path-shaped in the body: ${posts[0].body}`);
  } finally {
    globalThis.fetch = realFetch;
    p.restore();
  }
});

await checkAsync('the Reviews pill reaches a visitor in the World even when the longest wait has no island', async () => {
  // It always sailed for the oldest request, and when that repo had no island it neither sailed nor pointed at
  // anything, and said nothing: on the map, on another island, and on an island whose own desk had a visitor. The
  // village's answer was not read either, only whether it had the method.
  const visitor = (hex, number, island, waitingSince) => ({ id: `pr:${hex.repeat(16)}`, number, repo: island || 'ghost',
    owner: 'org', island, title: `Review ${number}`, author: 'sam', waitingSince, look: 7 });
  const ghost = visitor('0', 7, null, 1000);
  const alpha = visitor('a', 8, 'alpha', 2000);
  const withVisitors = (list) => ({ ...PAGE_BOARD, visitors: list, reviews: { waiting: list.length, byRepo: {}, waitingOn: {} } });
  const tip = (p) => p.doc.getElementById('village-tip');
  const toastText = (p) => (p.doc.getElementById('toast').hidden ? '' : p.doc.getElementById('toast').textContent);
  const pill = (p) => p.doc.getElementById('pills').querySelectorAll('button.pill').find((b) => b.dataset.lane === 'reviews');
  const cases = [
    { name: 'from the map', stored: { 'town.mode': 'world' } },
    { name: 'from another island', stored: { 'town.mode': 'world', 'town.island': 'beta' } },
    { name: 'from the island it is on', stored: { 'town.mode': 'world', 'town.island': 'alpha' } },
  ];
  for (const c of cases) {
    const p = await bootPage({ board: withVisitors([ghost, alpha]), stored: c.stored });
    try {
      pill(p).dispatch('click');
      await p.pump(200);
      eq(p.crumbs(), ['World', 'alpha'], `${c.name}: it sails to the oldest wait that has an island`);
      assert(!tip(p).hidden, `${c.name}: and points at it`);
      assert(tip(p).getAttribute('aria-label').includes('#8'), `${c.name}: at that visitor: ${tip(p).getAttribute('aria-label')}`);
      eq(toastText(p), '', `${c.name}: with nothing to explain`);
    } finally {
      p.restore();
    }
  }

  // Every request on a repo with no island: the World has no desk for them, so the toast says so and offers the way
  // to the one that does.
  const p = await bootPage({ board: withVisitors([ghost]), stored: { 'town.mode': 'world' } });
  try {
    pill(p).dispatch('click');
    await p.pump(200);
    eq(p.crumbs(), [], 'nowhere to sail');
    assert(tip(p).hidden, 'and nothing to point at');
    assert(toastText(p).startsWith('1 PR waits on a repo with no island here'), `said in words: ${toastText(p)}`);
    const action = p.doc.getElementById('toast').querySelectorAll('.toast-action')[0];
    eq(action && action.textContent, 'Show in One village', 'with the way there');
    action.dispatch('click');
    await p.pump(200);
    eq(p.doc.body.dataset.mode, 'village', 'which is One village');
    assert(!tip(p).hidden && tip(p).getAttribute('aria-label').includes('#7'), 'where it points at the visitor');
  } finally {
    p.restore();
  }

  // And a 404 on a click says the request has gone, whatever the source's health says: an outage never takes a
  // visitor's URL away, since a failed search keeps the last answer.
  eq(app.visitorOpenMessage(404), app.VISITOR_GONE_TOAST, 'a 404 is a request that has gone');
  eq(app.visitorOpenMessage(429), 'One moment, try again', 'a 429 is a moment');
});

// ---------- updates: the banner that offers them, the health panel's Updates rows and What's new ----------

const V110_AT = Date.UTC(2026, 8, 22, 9);
const updateHealth = (over = {}) => ({ enabled: true, reason: null, state: 'current',
  latest: { tag: 'v1.1.0', name: 'Tokentown 1.1.0', published: V110_AT }, version: 'v1.0.0', restart: false,
  canPull: false, running: null, lastError: null, lastCheckedAt: 0, ...over });

check('the update notice offers only something to do, in plain words', () => {
  if (!app) throw new Error('app.js did not load');
  const u = updateHealth;
  const nothing = [null, undefined, 'behind', 5, {}, u(), u({ state: 'ahead' }), u({ state: 'diverged' }),
    u({ state: null }), u({ enabled: false, state: 'behind' }), u({ enabled: 'yes', state: 'behind' }),
    u({ restart: 'yes' }), u({ restart: 1 }), u({ enabled: false, restart: true }), u({ state: 'behind', latest: null }),
    u({ state: 'behind', latest: { tag: 'latest' } }), u({ state: 'behind', latest: { tag: 'v1.1.0 && rm -rf ~' } }),
    u({ state: 'behind', latest: 'v1.1.0' })];
  for (const updates of nothing) eq(app.updateNoticeModel(updates), null, `nothing to do: ${JSON.stringify(updates)}`);
  const pull = app.updateNoticeModel(u({ state: 'behind', canPull: true }));
  eq([pull.kind, pull.text, pull.canRun, pull.button, pull.copyButton], ['pull',
    'Tokentown v1.1.0 is out. You have v1.0.0.', true, 'Update now', 'Copy the update command'], 'a release it can run');
  eq(app.updateNoticeModel(u({ state: 'behind', version: null })).text, 'Tokentown v1.1.0 is out.', 'no version of its own');
  eq(app.updateNoticeModel(u({ state: 'behind', version: 'unreleased' })).text, 'Tokentown v1.1.0 is out.', 'or a strange one');
  for (const canPull of [false, undefined, 'yes', 1]) {
    eq(app.updateNoticeModel(u({ state: 'behind', canPull })).canRun, false, `canPull ${canPull}: copy only`);
  }
  eq(app.updateNoticeModel(u({ state: 'behind', restart: true })).kind, 'pull', 'a pull first: it restarts too');
  const restart = app.updateNoticeModel(u({ restart: true }));
  eq([restart.kind, restart.canRun, restart.button, restart.copyButton], ['restart', true, 'Restart now',
    'Copy the restart command'], 'a pulled copy that runs the old code, with or without git');
  for (const m of [pull, restart]) {
    for (const [key, value] of Object.entries(m)) {
      if (key === 'canRun') continue;
      assert(typeof value === 'string' && value.length > 0, `${m.kind}.${key} is words`);
      assert(!/[–—]/.test(value), `${m.kind}.${key} has no dashes: ${value}`);
    }
  }
  assert(pull.how.includes('fast-forwards') && pull.how.includes('v1.1.0'), 'a pull says what it runs');
  assert(restart.copyHow.includes('tokentown stop'), 'and so does a restart');

  // Why Update now did not finish, in words: only a failed start check has changed anything.
  eq(app.updateFailureText('fetch', 'exit 128'), 'Could not fetch the changes from GitHub (exit 128). Nothing changed.', 'fetch');
  assert(app.updateFailureText('merge', 'exit 1').startsWith('A local edit in your Tokentown folder is in the way'), 'a local edit');
  eq(app.updateFailureText('merge', 'exit 128'), 'git would not fast-forward your Tokentown folder (exit 128). Nothing changed.', 'merge');
  const start = app.updateFailureText('start', 'exit 1');
  assert(start.includes('kept running the old one') && start.includes('tokentown serve') && !start.includes('Nothing changed'),
    `a failed start says what changed: ${start}`);
  eq(app.updateFailureText(null, 'HTTP 500'), 'Could not update (HTTP 500).', 'anything else claims nothing');
  eq(app.updateFailureText('fetch', 'x'.repeat(80)).length, 'Could not fetch the changes from GitHub (). Nothing changed.'.length + 40, 'capped');
  for (const text of [start, app.updateFailureText('fetch', 'exit 1'), app.UPDATE_RESTARTING_TEXT]) {
    assert(!/[–—]/.test(text), `no dashes: ${text}`);
  }

  // A reload once per new commit, and never for the one it already reloaded for.
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  eq(app.shouldReloadFor(a, b, null), true, 'a new commit');
  eq(app.shouldReloadFor(a, a, null), false, 'the same one');
  eq(app.shouldReloadFor(a, b, b), false, 'already reloaded for it');
  eq(app.shouldReloadFor(null, b, null), false, 'nothing seen yet');
  eq(app.shouldReloadFor(a, '', null), false, 'no commit');
  eq(app.shouldReloadFor(a, null, null), false, 'nothing reported');
});

check('the health panel says which version this is, the newest release, and why a check is off', () => {
  if (!app) throw new Error('app.js did not load');
  const u = updateHealth;
  const now = V110_AT + 10 * 60000;
  const running = `155ca5e${'0'.repeat(33)}`;
  eq(app.updateHealthRows(null), [['Status', 'not reported', false]], 'an older server');
  eq(app.updateHealthRows(u({ enabled: false, reason: 'not on main', state: null })),
    [['Status', 'Off: this copy is not on its main branch', false]], 'off, and why');
  eq(app.updateHealthRows(u({ enabled: false, reason: 'gh not found', state: null, lastError: 'gh not found' })),
    [['Status', 'Off: gh not found, so Tokentown cannot ask GitHub', true]], 'gh missing is worth a look');
  for (const reason of Object.keys(app.UPDATE_REASONS)) {
    assert(app.updateHealthRows(u({ enabled: false, reason }))[0][1].startsWith('Off: '), `${reason} has its own words`);
  }
  for (const odd of ['__proto__', 'constructor', 'toString', 'something new', null, 5]) {
    eq(app.updateHealthRows(u({ enabled: false, reason: odd })), [['Status', 'Off', false]], `an unknown reason ${odd}`);
  }
  eq(app.updateHealthRows(u({ state: 'behind', running, lastCheckedAt: now - 5 * 60000 }), now), [
    ['Status', 'On, asks GitHub about once an hour through gh', false],
    ['Version', 'v1.0.0 (155ca5e)', false],
    ['Newest release', `v1.1.0, ${app.releaseDate(V110_AT)}`, false],
    ['This copy', 'Older than v1.1.0, the newest release', false],
    ['Update now', 'Copies the command instead: it needs git and an https origin', false],
    ['Last check', '5 min ago', false],
    ['Last error', 'none', false],
  ], 'behind');
  eq(app.releaseDate(V110_AT), '22 Sept 2026', 'a date the British way');
  const row = (over, name) => app.updateHealthRows(u(over), now).find((r) => r[0] === name)[1];
  eq(row({ version: null, running }, 'Version'), '155ca5e, not a release', 'an unreleased build');
  eq(row({ version: null }, 'Version'), 'unknown', 'nothing to go on');
  eq(row({ version: 'v1.0.0 <b>' }, 'Version'), 'unknown', 'a version that is not a tag is not shown');
  eq(row({ latest: null }, 'Newest release'), 'none yet', 'no release yet');
  eq(row({ canPull: true }, 'Update now'), 'Updates with git when you press it', 'a pull it can make');
  eq(row({ restart: true }, 'This copy'), 'Changed on disk: restart Tokentown to run it', 'pulled, not restarted');
  eq(row({}, 'This copy'), 'Up to date: v1.1.0', 'current');
  eq(row({ state: 'ahead' }, 'This copy'), 'Newer than v1.1.0: changes not released yet', 'ahead');
  eq(row({ state: 'diverged' }, 'This copy'), 'Differs from v1.1.0', 'diverged');
  eq(row({ state: null }, 'This copy'), 'Not checked yet', 'no answer yet');
  eq(row({ state: null, latest: null, lastCheckedAt: now }, 'This copy'), 'No release published yet', 'none published');
  eq(row({ state: null, latest: null, lastCheckedAt: now, lastError: 'exit 1' }, 'This copy'), 'Not checked yet',
    'a failed check claims nothing');
  const failing = app.updateHealthRows(u({ state: null, lastError: 'gh not signed in', lastCheckedAt: null }), now);
  eq(failing.slice(-2), [['Last check', 'not yet', false], ['Last error', 'gh not signed in', true]], 'a failure warns');
  eq(app.updateHealthSummary(null), 'Updates not reported', 'summary, older server');
  eq(app.updateHealthSummary(u({ enabled: false, reason: 'not on main' })), 'Updates off (not on main)', 'summary, off');
  eq(app.updateHealthSummary(u({ state: 'behind' })), 'Updates: Older than v1.1.0, the newest release', 'summary, behind');
  assert(app.GH_PROBLEMS.has('gh not signed in'), 'the sign-in problem gets its own help');
});

check('release notes stay text, and the list marks the newest, yours and what is new to you', () => {
  if (!app) throw new Error('app.js did not load');
  const notes = "## What's Changed\n* **Update now** pulls a release by @someone in https://github.com/o/r/pull/9\n"
    + '- `tokentown check` names the version\n\nPlain words, <img src=x onerror=alert(1)>\n### Fixes\n+ one\n#nospace';
  eq(app.releaseNoteBlocks(notes), [
    { kind: 'h', text: "What's Changed" },
    { kind: 'li', text: 'Update now pulls a release by @someone in https://github.com/o/r/pull/9' },
    { kind: 'li', text: 'tokentown check names the version' },
    { kind: 'p', text: 'Plain words, <img src=x onerror=alert(1)>' },
    { kind: 'h', text: 'Fixes' },
    { kind: 'li', text: 'one' },
    { kind: 'p', text: '#nospace' },
  ], 'a heading, a bullet or a paragraph a line, markup kept as text');
  eq(app.releaseNoteBlocks(null), [], 'no notes');
  eq(app.releaseNoteBlocks('x\n'.repeat(500)).length, 200, 'at most 200 lines');
  eq(app.releaseNoteBlocks(`* ${'y'.repeat(1000)}`)[0].text.length, 400, 'a bullet is capped');

  const release = (tag, over = {}) => ({ tag, name: `Tokentown ${tag.slice(1)}`, published: V110_AT, notes: '* x', ...over });
  const list = [release('v1.2.0'), release('v1.1.0', { name: 'v1.1.0' }), release('v1.0.0'), release('latest'), null, 5];
  const marks = (items) => items.map((i) => [i.tag, i.newest, i.fresh, i.yours]);
  eq(marks(app.releaseListModel(list, updateHealth({ state: 'behind', version: 'v1.0.0' }))), [
    ['v1.2.0', true, true, false], ['v1.1.0', false, true, false], ['v1.0.0', false, false, true],
  ], 'yours, and the two after it new to you; an odd tag left out');
  eq(marks(app.releaseListModel(list, updateHealth({ state: 'behind', version: null }))),
    [['v1.2.0', true, true, false], ['v1.1.0', false, false, false], ['v1.0.0', false, false, false]],
    'no version of its own: only the newest is new, and only while older');
  eq(marks(app.releaseListModel(list, updateHealth({ state: 'current', version: 'v1.2.0' }))),
    [['v1.2.0', true, false, true], ['v1.1.0', false, false, false], ['v1.0.0', false, false, false]], 'up to date');
  eq(marks(app.releaseListModel(list, null)).map((m) => m[2]), [false, false, false], 'nothing new without a check');
  const items = app.releaseListModel(list, null);
  eq([items[0].name, items[1].name], ['Tokentown 1.2.0', ''], 'a name that only repeats the tag is dropped');
  eq(items[0].date, app.releaseDate(V110_AT), 'dated');
  eq(app.releaseListModel(Array.from({ length: 30 }, (_, n) => release(`v1.0.${n}`))).length, 10, 'at most ten');
  eq(app.releaseListModel('v1.0.0'), [], 'not a list');
});

// Boots the page on a board with health.updates, and answers the update routes as each check says.
async function bootUpdatePage(updates, answers = {}) {
  const board = { ...PAGE_BOARD, health: { ok: true, updates: updateHealth(updates) } };
  const p = await bootPage({ board, stored: { 'town.mode': 'village' } });
  const posts = [];
  const gets = [];
  const copied = [];
  const reloads = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path, init) => {
    if (path === '/api/update' || path === '/api/update-command' || path === '/api/releases') {
      if (path === '/api/releases') gets.push([path, init && init.method, init && init.headers]);
      else posts.push([path, init && init.body]);
      const answer = answers[path] || { status: 404, body: null };
      if (answer.wait) await answer.wait;
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, headers: { get: () => null },
        json: async () => { if (answer.body === null) throw new SyntaxError('no body'); return answer.body; } };
    }
    return realFetch(path, init);
  };
  navigator.clipboard.writeText = async (text) => { copied.push(text); };
  globalThis.location.reload = () => reloads.push(p.server.board.health.updates.running);
  const $ = (id) => p.doc.getElementById(id);
  const serve = async (next, etag) => {
    p.server.board = { ...PAGE_BOARD, health: { ok: true, updates: updateHealth(next) } };
    p.server.etag = etag;
    await p.pump(2100);
  };
  return { p, $, posts, gets, copied, reloads, serve, restore: () => { globalThis.fetch = realFetch; p.restore(); } };
}

await checkAsync('Update now posts {} to /api/update, says so while it runs, and reloads once the new server is up', async () => {
  const v1 = '1'.repeat(40);
  const v2 = '2'.repeat(40);
  let release;
  const answered = new Promise((resolve) => { release = resolve; });
  const t = await bootUpdatePage({ state: 'behind', canPull: true, running: v1 },
    { '/api/update': { status: 202, body: { restarting: true, pulled: true }, wait: answered } });
  const { $ } = t;
  try {
    assert(!$('update-banner').hidden, 'the banner shows while a newer release is out');
    eq($('update-text').textContent, 'Tokentown v1.1.0 is out. You have v1.0.0.', 'in plain words');
    eq($('update-go-word').textContent, 'Update now', 'with Update now');
    assert($('update-go').title.includes('fast-forwards'), `saying what it does: ${$('update-go').title}`);
    eq(t.posts.length, 0, 'nothing is posted by a render');

    $('update-go').dispatch('click');
    await t.p.pump(0);
    eq(t.posts, [['/api/update', '{}']], 'exactly {}: no path, no command, one post');
    eq($('update-go-word').textContent, 'Updating…', 'it says so while git runs');
    assert($('update-go').disabled && $('update-later').disabled, 'and takes no second click meanwhile');
    $('update-go').dispatch('click');
    await t.p.pump(0);
    eq(t.posts.length, 1, 'a second click is dropped');

    release();
    await t.p.pump(50);
    eq($('update-text').textContent, app.UPDATE_RESTARTING_TEXT, 'then that it is restarting');
    assert($('update-actions').hidden, 'with nothing left to press');
    eq(t.reloads, [], 'no reload before the new server answers');

    await t.serve({ state: 'current', version: 'v1.1.0', running: v2 }, 'etag-2');
    eq(t.reloads, [v2], 'the new server: one reload, for its commit');
    eq(t.p.doc.getElementById('update-banner').hidden, true, 'up to date: no banner');
    await t.serve({ state: 'current', version: 'v1.1.0', running: v2, lastCheckedAt: 99 }, 'etag-3');
    eq(t.reloads, [v2], 'and never twice for the same commit');
  } finally {
    t.restore();
  }
});

await checkAsync('a failed Update now says why, keeps the copy, and hands over the command for Terminal', async () => {
  const t = await bootUpdatePage({ state: 'behind', canPull: true, running: '3'.repeat(40) }, {
    '/api/update': { status: 500, body: { step: 'merge', error: 'exit 1' } },
    '/api/update-command': { status: 200, body: { command: 'cd /x && git merge --ff-only v1.1.0' } },
  });
  const { $ } = t;
  try {
    $('update-go').dispatch('click');
    await t.p.pump(50);
    assert($('update-text').textContent.startsWith('A local edit in your Tokentown folder is in the way'),
      `why, in words: ${$('update-text').textContent}`);
    eq($('update-go-word').textContent, 'Copy the update command', 'the way on is the command');
    assert(!$('update-go').disabled, 'which can be pressed');
    $('update-go').dispatch('click');
    await t.p.pump(50);
    eq(t.posts.map((q) => q[0]), ['/api/update', '/api/update-command'], 'it copies rather than trying again');
    eq(t.copied, ['cd /x && git merge --ff-only v1.1.0'], 'the server command, as it was given');
    eq(t.reloads, [], 'and nothing reloads');

    // A newer release changes the words, and Update now is back for it.
    await t.serve({ state: 'behind', canPull: true, running: '3'.repeat(40),
      latest: { tag: 'v1.2.0', name: '', published: V110_AT } }, 'etag-2');
    eq($('update-go-word').textContent, 'Update now', 'a new release is a new try');
    eq($('update-text').textContent, 'Tokentown v1.2.0 is out. You have v1.0.0.', 'naming it');
  } finally {
    t.restore();
  }

  for (const [answer, toastText] of [[{ status: 409, body: null }, 'Nothing to update right now'],
    [{ status: 429, body: null }, 'An update is already running']]) {
    const u = await bootUpdatePage({ state: 'behind', canPull: true }, { '/api/update': answer });
    try {
      u.$('update-go').dispatch('click');
      await u.p.pump(50);
      eq(u.$('toast').textContent, toastText, `a ${answer.status} is a toast`);
      eq(u.$('update-go-word').textContent, 'Update now', `and after a ${answer.status} the banner is as it was`);
    } finally {
      u.restore();
    }
  }
  const lost = await bootUpdatePage({ state: 'behind', canPull: true }, { '/api/update': { status: 500, body: null } });
  try {
    lost.$('update-go').dispatch('click');
    await lost.p.pump(50);
    eq(lost.$('update-text').textContent, 'Could not update (HTTP 500).', 'a bare 500 claims nothing about the copy');
  } finally {
    lost.restore();
  }
});

await checkAsync('without git or an https origin the banner copies the command, and Later holds until another release', async () => {
  const t = await bootUpdatePage({ state: 'behind', canPull: false }, {
    '/api/update-command': { status: 200, body: { command: 'cd /x && git merge --ff-only v1.1.0' } },
  });
  const { $ } = t;
  try {
    eq($('update-go-word').textContent, 'Copy the update command', 'the command, from the start');
    assert($('update-go').title.includes('fast-forwards your Tokentown folder to v1.1.0'), `and what it runs: ${$('update-go').title}`);
    $('health-btn').dispatch('click');
    assert(t.p.doc.getElementById('health-panel').textContent.includes('Older than v1.1.0'), 'Health has an Updates section');
    $('update-go').dispatch('click');
    await t.p.pump(50);
    eq(t.posts, [['/api/update-command', '{}']], 'exactly {} to the copy route and never /api/update');
    eq(t.copied, ['cd /x && git merge --ff-only v1.1.0'], 'copied as given');
    assert($('toast').textContent.startsWith('Update command copied. Paste it into Terminal'), `said: ${$('toast').textContent}`);

    $('update-later').dispatch('click');
    assert($('update-banner').hidden, 'Later hides it');
    await t.serve({ state: 'behind', canPull: false, lastCheckedAt: 5 }, 'etag-2');
    assert($('update-banner').hidden, 'and a scan with the same words keeps it hidden');
    await t.serve({ state: 'behind', canPull: false, latest: { tag: 'v1.2.0', name: '', published: V110_AT } }, 'etag-3');
    assert(!$('update-banner').hidden, 'another release brings it back');
    eq($('update-text').textContent, 'Tokentown v1.2.0 is out. You have v1.0.0.', 'naming the new one');

    await t.serve({ state: 'current', restart: true }, 'etag-4');
    eq($('update-go-word').textContent, 'Restart now', 'once pulled by hand, a restart needs no git');
    assert($('update-text').textContent.includes('Restart it to run the new version'), 'and says why');
    await t.serve({ state: 'current' }, 'etag-5');
    assert($('update-banner').hidden, 'restarted and up to date: nothing to offer');
    await t.serve({ enabled: false, reason: 'not on main', state: 'behind' }, 'etag-6');
    assert($('update-banner').hidden, 'and nothing for a copy it cannot check');
    eq(t.posts.length, 1, 'no render posted anything');
  } finally {
    t.restore();
  }
});

await checkAsync("What's new reads the releases with a GET, shows them as text, and can update from there", async () => {
  const releases = [
    { tag: 'v1.1.0', name: 'Tokentown 1.1.0', published: V110_AT,
      notes: "## What's Changed\n* Update now pulls a release\n<script>alert(1)</script>" },
    { tag: 'v1.0.0', name: '', published: V110_AT - 2 * 86400000, notes: '' },
  ];
  const t = await bootUpdatePage({ state: 'behind', canPull: true }, {
    '/api/releases': { status: 200, body: { releases } },
    '/api/update': { status: 202, body: { restarting: true, pulled: true } },
  });
  const { $ } = t;
  try {
    assert($('news').hidden, 'closed until asked');
    $('update-news').dispatch('click');
    await t.p.pump(50);
    assert(!$('news').hidden, 'the banner opens it');
    eq(t.gets.length, 1, 'one read of the releases');
    eq(t.gets[0][1], undefined, 'a GET');
    eq(t.gets[0][2]['X-Town-Token'], 'tok_aaaaaaaaaaaaaaaaaaaa', 'with the token');
    eq(t.posts.length, 0, 'and nothing posted');
    const sections = $('news-body').querySelectorAll('section');
    eq(sections.length, 2, 'a section a release');
    eq(sections[0].querySelector('h3').textContent, 'v1.1.0NewestNew to you', 'the newest, new to you');
    eq(sections[1].querySelector('h3').textContent, 'v1.0.0Yours', 'the one this copy runs');
    eq(sections[0].querySelectorAll('li').map((n) => n.textContent), ['Update now pulls a release'], 'bullets as a list');
    assert(sections[0].textContent.includes('<script>alert(1)</script>'), 'markup stays text');
    eq($('news-body').querySelectorAll('script').length, 0, 'and never becomes an element');
    assert(sections[1].textContent.includes('No notes for this release.'), 'a release with no notes says so');

    const go = $('news-body').querySelector('.news-go');
    assert(go && go.textContent === 'Update to v1.1.0 now', `an update from the notes: ${go && go.textContent}`);
    go.dispatch('click');
    await t.p.pump(50);
    assert($('news').hidden, 'which closes them');
    eq(t.posts, [['/api/update', '{}']], 'and posts {} like the banner');
  } finally {
    t.restore();
  }

  // Only a pull it can run gets a button here: copy-only and restart-only copies use the banner.
  for (const updates of [{ state: 'behind', canPull: false }, { state: 'current', restart: true, canPull: true }]) {
    const u = await bootUpdatePage(updates, { '/api/releases': { status: 200, body: { releases } } });
    try {
      u.$('update-news').dispatch('click');
      await u.p.pump(50);
      eq(u.$('news-body').querySelectorAll('section').length, 2, `the notes, for ${JSON.stringify(updates)}`);
      eq(u.$('news-body').querySelectorAll('.news-go').length, 0, `and no update button, for ${JSON.stringify(updates)}`);
    } finally {
      u.restore();
    }
  }

  const failing = await bootUpdatePage({ state: 'current' }, { '/api/releases': { status: 500, body: null } });
  try {
    failing.$('health-btn').dispatch('click');
    const open = failing.$('health-panel').querySelector('.health-news');
    assert(open, "the Health panel has a What's new button");
    open.dispatch('click');
    await failing.p.pump(50);
    assert(!failing.$('news').hidden && failing.$('health-panel').hidden, 'it swaps the panel for the notes');
    eq(failing.$('news-body').textContent, 'Could not load the release notes. Try again in a moment.', 'a failure says so');
    eq(failing.$('news-body').querySelectorAll('.news-go').length, 0, 'and offers no update when up to date');
  } finally {
    failing.restore();
  }
});

// node has no Path2D, so glyphPaths() returns null here and nothing else ever draws a badge glyph: a typo in a
// path string would reach the browser unseen. Parsed instead, command by command, against the SVG grammar the
// drawing code relies on.
check('every badge glyph is a well formed path, and the village has one for every lane the page gives an icon', () => {
  const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  for (const [name, def] of Object.entries(V.GLYPHS)) {
    assert(typeof def.d === 'string' && def.d.length > 4, `${name} has a path`);
    assert(def.rule === 'nonzero' || def.rule === 'evenodd' || typeof def.stroke === 'number',
      `${name} is filled with a rule or stroked with a width`);
    assert(!/[^MLHVCSQTAZmlhvcsqtaz0-9eE .,+-]/.test(def.d), `${name} has only path syntax: ${def.d}`);
    const parts = def.d.match(/[MLHVCSQTAZmlhvcsqtaz][^MLHVCSQTAZmlhvcsqtaz]*/g) || [];
    assert(parts.length, `${name} starts with a command`);
    assert(/^[Mm]/.test(def.d.trim()), `${name} opens with a moveto`);
    for (const part of parts) {
      const cmd = part[0].toUpperCase();
      const nums = (part.slice(1).match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) || []).map(Number);
      assert(nums.every(Number.isFinite), `${name}: ${part.trim()} has only finite numbers`);
      if (ARITY[cmd] === 0) eq(nums.length, 0, `${name}: ${part.trim()} takes no numbers`);
      else {
        assert(nums.length >= ARITY[cmd] && nums.length % ARITY[cmd] === 0,
          `${name}: ${part.trim()} is ${nums.length} numbers, not a multiple of ${ARITY[cmd]}`);
        // An arc's two flags are 0 or 1, and its radii are positive: a browser silently drops a bad arc.
        if (cmd === 'A') {
          for (let i = 0; i < nums.length; i += 7) {
            assert(nums[i] > 0 && nums[i + 1] > 0, `${name}: arc radii ${nums[i]},${nums[i + 1]}`);
            for (const f of [nums[i + 3], nums[i + 4]]) assert(f === 0 || f === 1, `${name}: arc flag ${f}`);
          }
        }
      }
    }
  }
  // Every lane the page draws an icon for has a village glyph of the same name, so the two badges match.
  if (!app) throw new Error('app.js did not load');
  for (const [lane, st] of Object.entries(V.STATE)) {
    assert(Object.prototype.hasOwnProperty.call(V.GLYPHS, st.glyph), `${lane}'s glyph ${st.glyph} exists`);
  }
  eq(V.STATE.jail.glyph, 'bars', "the jail's badge is the barred window");
});

// app.js loads village.js lazily, so it keeps its own copies of the place ids: nothing else would notice a drift.
check('the page and the village agree on place ids, the patrol count, the size line and the swatches', () => {
  if (!app) throw new Error('app.js did not load');
  eq([app.PATROL_ID, app.CASTLE_HALL_ID, app.COTTAGE_ROOM_ID], [V.PATROL_ID, V.CASTLE_ID, V.COTTAGE_ID], 'hover ids');
  eq([app.placeTipKind(V.PATROL_ID, 'village'), app.placeTipKind(V.CASTLE_ID, 'village'), app.placeTipKind(V.COTTAGE_ID, 'village')],
    ['patrol', 'castle', 'cottages'], 'village scene');
  eq([app.placeTipKind(V.PATROL_ID, 'castle'), app.placeTipKind(V.CASTLE_ID, 'cottages'), app.placeTipKind(V.COTTAGE_ID, 'cottages'),
    app.placeTipKind(A, 'village')], [null, null, null, null], 'inside a room, and a session');
  // The scene names the village reports, and the exits the page looks for on Escape and its back button.
  eq([app.sceneName('castle'), app.sceneName('cottages'), app.sceneName('cottage'), app.sceneName('village'), app.sceneName('nowhere')],
    ['castle', 'cottages', 'cottages', 'village', 'village'], 'scene names');
  const village = villageMod.createVillage({ getContext: () => stub, style: {}, addEventListener() {}, removeEventListener() {} }, {});
  for (const exit of ['leaveScene', 'leaveCastle', 'leaveCottages']) assert(typeof village[exit] === 'function', `the village answers ${exit}`);
  for (const enter of ['enterCastle', 'enterCottages']) assert(typeof village[enter] === 'function', `the village answers ${enter}`);
  village.destroy();
  const m2 = app.cottageRoomModel(3, 0);
  eq([m2.title, m2.count, m2.rows[0].key, m2.rows[0].text], ['The Cottages', 3, 'Idle', '3 sessions'], 'the cottage tooltip');

  const rows = [row(A, 'open_pr'), row(B, 'open_pr'), row(C, 'running')];
  const m = app.patrolModel(V.patrolState(rows).waiting);
  eq([m.title, m.key, m.waiting, m.count], ['Border patrol', 'Waiting to merge', '2 sessions', 2], 'two waiting');
  eq([app.patrolModel(1).waiting, app.patrolModel(0).waiting, app.patrolModel(-3).waiting, app.patrolModel('7').waiting,
    app.patrolModel(2.9).waiting], ['1 session', '0 sessions', '0 sessions', '0 sessions', '2 sessions'], 'singular, zero and junk counts');
  assert(m.text.includes('Waiting to merge: 2 sessions'), `aria text: ${m.text}`);

  // The world of islands: app.js keeps its own copies of these, because it needs the mode and the hover id before
  // village.js is imported. Nothing at runtime would notice a drift, and a different prefix or share would leave
  // the page and the map quietly disagreeing about which island is which.
  eq([app.MODES, app.MODE_SHARE, app.ISLAND_PREFIX, app.NO_REPO_KEY, app.NO_REPO_LABEL, app.WORLD_BADGE_LANES],
    [V.MODES, V.MODE_SHARE, V.ISLAND_PREFIX, V.NO_REPO_KEY, V.NO_REPO_LABEL, V.WORLD_BADGE_LANES], 'the world constants');
  for (const repo of ['', 'tokentown', 'has:colon']) {
    eq([app.islandHoverId(repo), app.repoOfIslandId(V.islandHoverId(repo))],
      [V.islandHoverId(repo), repo], `the page reads ${repo || 'the no-repo island'}'s hover id`);
  }
  eq(app.repoOfIslandId(V.CASTLE_ID), null, 'and no room place reads as an island');
  // The two that turn a row into an island and an island into a word. A drift here puts a row on one island and
  // its name on another, which nothing else would notice.
  for (const r of [row(A, 'running', { repo: 'tokentown' }), row(B, 'idle', { repo: '' }), row(C, 'graveyard'), { id: D, lane: 'running', repo: 7 }]) {
    eq(app.repoKeyOf(r), V.repoKeyOf(r), `repoKeyOf ${JSON.stringify(r.repo)}`);
  }
  for (const repo of ['tokentown', V.NO_REPO_KEY, null, undefined]) eq(app.worldLabel(repo), V.worldLabel(repo), `worldLabel ${repo}`);
  const isleRows = [row(A, 'running', { repo: 'b' }), row(B, 'idle'), row(C, 'jail', { repo: 'a' }), row(D, 'graveyard', { repo: 'a' })];
  eq(app.worldRepos(isleRows), V.worldRepos(isleRows), 'the page groups repos exactly as the village does');
  for (const repo of ['a', 'b', V.NO_REPO_KEY]) {
    eq(app.worldRowsFor(isleRows, repo).map((s) => s.id), V.worldRowsFor(isleRows, repo).map((s) => s.id), `the list of ${repo}`);
  }
  for (const spread of [[], isleRows, [row(A, 'running', { repo: 'a' }), row(B, 'running', { repo: 'a' }), row(C, 'running', { repo: 'a' }), row(D, 'running', { repo: 'b' })]]) {
    eq(app.defaultMode(spread), V.defaultMode(spread), 'and starts in the same mode');
  }
  const worldVillage = villageMod.createVillage({ getContext: () => stub, style: {}, addEventListener() {}, removeEventListener() {} }, { mode: 'world' });
  for (const name of ['setMode', 'openIsland', 'leaveIsland', 'getMode', 'getScene', 'getIsland', 'islands']) {
    assert(typeof worldVillage[name] === 'function', `the village answers ${name}`);
  }
  eq([worldVillage.getMode(), worldVillage.getScene(), worldVillage.getIsland()], ['world', 'world', null], 'world mode starts on the map');
  worldVillage.destroy();

  // The visitors, cleaned twice: the page keeps its own list for the HUD pill, the island tooltips and the Board's
  // foot note, the village keeps one for the queue it draws, and the two were written in parallel. Every field both
  // of them hold is compared here, on the shape the server really sends and on each shape only one of them used to
  // get right, because a drift shows up as a count nobody can reconcile rather than as a broken page.
  const guest = (hex, extra = {}) => ({ id: `pr:${hex.repeat(16).slice(0, 16)}`, number: 1, repo: 'tokentown', island: 'tokentown', ...extra });
  const guestBoards = {
    'the shape the server sends': { visitors: [guest('a', { number: 532, owner: 'Acme', title: 'T', author: 'sam', waitingSince: 1000, look: 7 })] },
    'author and login both sent': { visitors: [guest('b', { author: 'from_author', login: 'from_login' })] },
    'login alone': { visitors: [guest('c', { login: 'only_login' })] },
    'owner and repo as the repo': { visitors: [guest('d', { repo: 'Acme/tokentown', author: 'a' })] },
    'a repo named like an island, and no island': { visitors: [guest('9', { island: null }), guest('8', { number: 3, island: undefined })] },
    'an island named differently from the repo': { visitors: [guest('7', { repo: 'wonderful-things-core', island: 'plotgen' })] },
    'no PR number': { visitors: [{ id: `pr:${'e'.repeat(16)}`, repo: 'tokentown' }] },
    'prNumber, requestedAt and since': { visitors: [guest('f', { prNumber: 9, requestedAt: 40 }), guest('0', { number: 8, since: 20 })] },
    'a duplicate id': { visitors: [guest('1'), guest('1', { number: 2 })] },
    'no repo at all': { visitors: [{ id: `pr:${'2'.repeat(16)}`, number: 8, author: 'a' }] },
    'an id a session also holds': { sessions: [row(`pr:${'3'.repeat(16)}`, 'running')], visitors: [guest('3', { number: 10 })] },
    'hostile rows': { visitors: [null, 5, { number: 11 }, { id: '', number: 12 }] },
    // Who was asked: the tooltip's words and the look at the desk have to agree, or one PR is "Asked of you" in
    // the page and wears a team sash in the village.
    'asked of you and of a team': { visitors: [guest('4', { via: 'you', teams: [] }), guest('5', { number: 2, via: 'team', teams: ['web-platform'] })] },
    'no via at all': { visitors: [guest('6', { teams: ['web-platform'] })] },
    'a via that is neither': { visitors: [guest('a', { via: 'YOU' }), guest('b', { number: 2, via: ['you'] }), guest('c', { number: 3, via: null })] },
  };
  const isle = [row(A, 'running', { repo: 'tokentown' }), row(B, 'idle', { repo: 'plotgen' })];
  for (const [name, b] of Object.entries(guestBoards)) {
    const taken = new Set((b.sessions || []).map((s) => s.id));
    const paged = app.visitorsFrom(b);
    const queued = V.visitorRows(b.visitors, taken);
    const shrink = (v) => [v.id, v.login, v.island, v.number, v.waitingSince, v.via];
    eq(paged.map(shrink), queued.map(shrink), `the two cleanings agree on ${name}`);
    eq([...app.visitorsByRepo(paged).entries()], [...V.visitorsByRepo(queued).entries()],
      `and count the islands the same way with ${name}`);
    eq(app.worldRepos(isle, paged), V.worldRepos(isle, queued), `and badge the islands the same way with ${name}`);
  }
  // The whole board's number: the server's own when it sends one, the list's own length when it does not, in both.
  for (const reviews of [undefined, {}, { waiting: 3 }, { waiting: 0 }, { waiting: 'nonsense' }, { waiting: -2 }]) {
    const b = { sessions: [], counts: {}, visitors: [guest('4'), guest('5', { number: 2 })], reviews };
    const v = makeVillage();
    v.village.update(b, { privacy: false });
    eq(app.reviewsCount(b, app.visitorsFrom(b)), v.village.visitors().board,
      `the pill and the desk agree when reviews is ${JSON.stringify(reviews) || 'absent'}`);
    v.village.destroy();
  }

  eq(app.SIZE_LEGEND_TEXT, 'Bigger avatars = more output tokens', 'the size line');
  for (const text of [m.text, app.SIZE_LEGEND_TEXT]) assert(!text.includes('\u2014'), `no em dash in "${text}"`);

  for (const e of [...V.REPO_PALETTE, V.NO_REPO_COLOUR]) {
    eq([app.legendColour(e, false), app.legendColour(e, true)], [e.light, e.dark], `${e.name} swatch in both themes`);
  }
  const repoRows = [row(A, 'running', { repo: 'tokentown' }), row(B, 'open_pr', { repo: 'plotgen' }), row(C, 'idle', {})];
  const inView = V.repoNamesInView(repoRows);
  for (const dark of [false, true]) {
    const legend = app.repoLegendModel(repoRows, V.repoColour, { dark });
    for (const entry of legend.entries) {
      const want = entry.repo === null ? V.NO_REPO_COLOUR : V.repoColour(entry.repo, inView);
      eq(entry.colour, dark ? want.dark : want.light, `${entry.label} swatch (${dark ? 'dusk' : 'day'}) matches its characters`);
    }
  }
});

check('who a review request was asked of, in words: a team request never reads as one asked of you', () => {
  if (!app) throw new Error('app.js did not load');
  const now = 5_000_000;
  const said = (v) => app.visitorAskedText(v);
  eq([app.ASKED_OF_YOU, app.ASKED_OF_A_TEAM], ['Asked of you', 'Asked of a team you are on'], 'the two fixed lines');
  eq(said({ via: 'you', teams: ['web-platform'] }), app.ASKED_OF_YOU, 'asked of you names only you');
  for (const v of [{ via: 'team', teams: [] }, { via: 'team' }, { via: 'team', teams: ['bad slug', '<b>'] }]) {
    eq(said(v), app.ASKED_OF_A_TEAM, `no team known yet: ${JSON.stringify(v)}`);
  }
  eq(said({ via: 'team', teams: ['web-platform'] }), 'Asked of team web-platform', 'one team');
  eq(said({ via: 'team', teams: ['web-platform', 'reporting'] }), 'Asked of teams web-platform and reporting', 'two teams');
  eq(said({ via: 'team', teams: ['a', 'b', 'c'] }), 'Asked of teams a, b and c', 'three, all named');
  eq(said({ via: 'team', teams: ['a', 'b', 'c', 'd', 'e'] }), 'Asked of teams a, b, c and 2 more', 'past three, counted');
  // A slug is text other people choose, and `you` is a legal one: the line must still say it is a team.
  for (const teams of [['you'], ['You'], ['YOU'], ['you', 'web-platform'], ['web-platform', 'you'], ['you', 'a', 'b', 'c'],
    ['a-team-you-are-on'], ['of-you']]) {
    const text = said({ via: 'team', teams });
    assert(text !== app.ASKED_OF_YOU && text !== app.ASKED_OF_A_TEAM, `teams ${JSON.stringify(teams)} read as a fixed line: "${text}"`);
    assert(/^Asked of teams? /.test(text), `teams ${JSON.stringify(teams)} say they are teams: "${text}"`);
    const tip = app.visitorTipModel({ number: 5, via: 'team', teams, waitingSince: now - 60_000 }, { now });
    eq([tip.via, tip.asked], ['team', text], `the tooltip for ${JSON.stringify(teams)}`);
    assert(!tip.text.includes(app.ASKED_OF_YOU), `what a screen reader hears for ${JSON.stringify(teams)} never says "${app.ASKED_OF_YOU}": ${tip.text}`);
  }
  const direct = app.visitorTipModel({ number: 5, via: 'you', teams: [], waitingSince: now - 60_000 }, { now });
  eq([direct.via, direct.asked], ['you', app.ASKED_OF_YOU], 'a direct request');
  // The page keeps only GitHub's slug characters at the server's 40-character cut, distinct, at most ten.
  eq(app.visitorTeams({ teams: ['ok', 'bad slug', '<b>', 'x'.repeat(41), 'x'.repeat(40), 'ok', 7, null, 'dätä', 'a/b'] }),
    ['ok', 'x'.repeat(40)], 'hostile slugs are dropped, never cleaned');
  eq(app.visitorTeams({ teams: Array.from({ length: 30 }, (_, i) => `t${i}`) }).length, app.VISITOR_TEAMS_MAX, 'at most ten');
  // Privacy mode hides the title and keeps who was asked.
  const v = { number: 532, title: 'Client secret', via: 'team', teams: ['web-platform'], waitingSince: now - 3 * 3_600_000 };
  const priv = app.visitorTipModel(v, { privacy: true, now });
  eq([priv.title, priv.asked], ['PR #532', 'Asked of team web-platform'], 'privacy mode');
  assert(!priv.text.includes('Client secret'), 'privacy mode says no title');
  // The pill counts every visitor and gives the split, which always adds up to it.
  const teamOnes = Array.from({ length: 11 }, (_, i) => ({ id: `pr:${String(i).padStart(16, '0')}`, number: 500 + i, via: 'team', teams: ['web-platform'] }));
  const b = { sessions: [], visitors: teamOnes, reviews: { waiting: 11, viaYou: 0, viaTeam: 11 } };
  const split = app.reviewsSplit(b);
  eq(split, { total: 11, you: 0, team: 11 }, "Charlie's split");
  const pill = app.reviewsPillModel(split.total, split);
  eq([pill.count, pill.help], [11, 'Open PRs waiting on your review. 11 waiting: 0 asked of you, 11 of your teams'], 'the pill');
});

check('a VS Code session is named and opened as one, and a terminal one is not', () => {
  if (!app) throw new Error('app.js did not load');
  const tip = (extra) => app.tooltipModel(row(A, 'recent', { shortId: '55555555', ...extra }));
  const vscode = { kind: 'cli', surface: 'vscode', canOpen: true, canCopyResume: true };
  eq(tip({}).hint, 'Click to open in Claude', 'a desktop session');
  eq([tip(vscode).hint, tip(vscode).title], ['Click to open in VS Code', 'VS Code session 55555555'], 'a VS Code session');
  eq(tip({ ...vscode, title: 'Named in VS Code' }).title, 'Named in VS Code', 'a title the server sent wins');
  const terminal = { kind: 'cli', surface: 'terminal', canOpen: false, canCopyResume: true };
  eq([tip(terminal).hint, tip(terminal).title], ['Click to copy the resume command', 'Terminal session 55555555'], 'an ended terminal session');
  // Still running: no resume command (a second copy), and no tab Tokentown could bring forward.
  const running = { ...terminal, live: true, canCopyResume: false };
  eq([tip(running).hint, app.runningInTerminal(running)], [app.IN_A_TERMINAL, true], 'a terminal session still running');
  eq(app.IN_A_TERMINAL, 'Running in a terminal: switch to it there', 'its words');
  eq([app.runningInTerminal(terminal), app.runningInTerminal({ ...vscode, live: true }), app.runningInTerminal(null)],
    [false, false, false], 'only a live terminal session with nothing to click');
  eq(tip({ ...vscode, canOpen: false, canCopyResume: false }).hint, 'Click for details', 'a VS Code session whose folder is gone');
  // Still open in VS Code: a click only brings its window forward, because the session link would start a second copy.
  const open = { ...vscode, live: true, canCopyResume: false };
  eq(tip(open).hint, 'Click to bring its VS Code window forward', 'a VS Code session still open there');
  eq(app.openWords(open), { action: 'Switch to VS Code', hint: 'Click to bring its VS Code window forward', toast: 'Bringing VS Code forward' },
    'its words');
  eq(app.openWords({ ...vscode, live: false }), { action: 'Open in VS Code', hint: 'Click to open in VS Code', toast: 'Opening in VS Code' },
    'a closed one');
  eq([app.openWords({ ...terminal, live: true }).action, app.openWords(row(A, 'running', { live: true })).action, app.openWords(null).action],
    ['Open in Claude', 'Open in Claude', 'Open in Claude'], 'only VS Code switches');
  eq(tip({ ...terminal, title: 'Launcher tidy-up' }).title, 'Launcher tidy-up', 'a terminal session with a title Claude gave it');
  // A terminal or VS Code session that has ended rests in the graveyard: there is no archive to go by.
  const ended = row(A, 'graveyard', { ...terminal, restReason: 'ended' });
  eq([app.restText(ended), app.restingText(ended)], ['Laid to rest: the session ended', 'The session ended'], 'why it rests');
  eq(tip({ kind: 'cli', canOpen: false, canCopyResume: true }).title, 'Terminal session 55555555', 'an older server sends no surface');
  eq([app.openAppName({ surface: 'vscode' }), app.openAppName({ surface: 'desktop' }), app.openAppName({ surface: 'terminal' }),
    app.openAppName({}), app.openAppName(null)], ['VS Code', 'Claude', 'Claude', 'Claude', 'Claude'], 'the app a click opens');
});

check('a session in VS Code Insiders or Cursor is named and opened as one of theirs', () => {
  if (!app) throw new Error('app.js did not load');
  const tip = (extra) => app.tooltipModel(row(A, 'recent', { shortId: '55555555', ...extra }));
  for (const [editor, name] of [['vscode', 'VS Code'], ['vscode-insiders', 'VS Code Insiders'], ['cursor', 'Cursor']]) {
    const closed = { kind: 'cli', surface: 'vscode', editor, canOpen: true, canCopyResume: true };
    eq([tip(closed).hint, tip(closed).title], [`Click to open in ${name}`, `${name} session 55555555`], `a closed ${name} session`);
    const open = { ...closed, live: true, canCopyResume: false };
    eq(app.openWords(open), { action: `Switch to ${name}`, hint: `Click to bring its ${name} window forward`, toast: `Bringing ${name} forward` },
      `one still open in ${name}`);
    eq(app.openAppName(closed), name, `${name} opens it`);
    eq(app.openFailedText(open), `Could not open ${name}`, `a failed open names ${name}`);
  }
  eq(app.openFailedText(row(A, 'recent')), 'Could not open Claude', 'a failed open of a desktop session');
  // An editor the page does not know, or none at all, reads as VS Code: never as the key itself.
  for (const editor of ['windsurf', '__proto__', 'constructor', 'toString', 7, null, undefined, ['cursor']]) {
    eq(app.editorName({ surface: 'vscode', editor }), 'VS Code', `editor ${String(editor)}`);
  }
  // Only a session in an editor takes an editor's name.
  eq(app.openAppName({ surface: 'terminal', editor: 'cursor' }), 'Claude', 'a terminal row');
});

check('holding a toggle key acts once: d never sends Done and then undoes it', () => {
  if (!app) throw new Error('app.js did not load');
  for (const key of ['d', 'v', 'p', 's', 'i']) {
    eq(app.isRepeatedToggle({ key, repeat: true }), true, `${key} held`);
    eq(app.isRepeatedToggle({ key, repeat: false }), false, `${key} pressed`);
  }
  for (const key of ['j', 'k', 'n', 'Enter', 'D']) eq(app.isRepeatedToggle({ key, repeat: true }), false, `${key} still repeats`);
  eq([app.isRepeatedToggle(null), app.isRepeatedToggle({ key: 'd', repeat: 'yes' })], [false, false], 'odd events');
});

check('a Board row that moves into a folded section hands focus to that section toggle', () => {
  if (!app) throw new Error('app.js did not load');
  const rows = [row(A, 'valhalla'), row(B, 'recent'), row(C, 'graveyard')];
  const folded = () => false;
  eq(app.focusFallbackLane({ id: A, kind: 'action', action: 'done' }, rows, folded), 'valhalla', 'Done sent it to the beach');
  eq(app.focusFallbackLane({ id: C, kind: 'row' }, rows, folded), 'graveyard', 'any folded section');
  eq(app.focusFallbackLane({ id: A, kind: 'action' }, rows, (lane) => lane === 'valhalla'), null, 'an open section renders the row');
  eq(app.focusFallbackLane({ id: B, kind: 'row' }, rows, folded), null, 'lanes that never fold');
  eq(app.focusFallbackLane({ id: 'local_gone', kind: 'row' }, rows, folded), null, 'a row that left the board');
  eq([app.focusFallbackLane(null, rows, folded), app.focusFallbackLane({ id: A }, null, folded)], [null, null], 'nothing to go on');
});

check('a shared column shows the split its HUD pill does not, so the two numbers reconcile', () => {
  if (!app) throw new Error('app.js did not load');
  const some = (lane, n, from) => Array.from({ length: n }, (_, i) => row(`local_${from}${String(i).padStart(4, '0')}-0000-4000-8000-000000000000`, lane));
  const rows = [...some('needs_you', 26, 'aa'), ...some('stopped', 2, 'bb'), ...some('running', 3, 'cc')];
  const cols = app.boardColumns(rows);
  const blocked = cols.find((c) => c.key === 'needs_you');
  const pill = app.hudPillModel(board(rows).counts).pills.find((p) => p.key === 'needs_you');
  // The gap the split is there to explain: the pill counts the lane, the column counts the column.
  eq([pill.count, blocked.count], [26, 28], 'the Blocked pill and the Blocked column');
  eq(app.columnBreakdownText(blocked), '26 + 2 stopped', 'the header reads where its 28 came from');
  eq(app.columnLabel(blocked),
    `Blocked: 28 sessions, 26 blocked and 2 stopped. ${blocked.help}`, 'and so does the region');
  // Every column that holds one lane, and every shared column whose other lanes are empty, stays quiet.
  const single = cols.find((c) => c.key === 'running');
  eq([app.columnBreakdownText(single), app.columnLabel(single)],
    ['', `Running: 3 sessions. ${single.help}`], 'a single-lane column says nothing extra');
  const quiet = app.boardColumns([...some('needs_you', 4, 'dd')]).find((c) => c.key === 'needs_you');
  eq(app.columnBreakdownText(quiet), '', 'nor a shared column with nothing in its second lane');
  // Valhalla is the other shared column. Its pill already sums both lanes, so the numbers agreed; the split is
  // applied there too rather than only where it disagreed, or one column would explain itself and the other not.
  const isle = app.boardColumns([...some('valhalla', 5, 'ee'), ...some('castle', 2, 'ff')]).find((c) => c.key === 'valhalla');
  eq(app.columnBreakdownText(isle), '5 + 2 sand castle', 'the island and the castle behind it');
  eq(app.hudPillModel({ valhalla: 5, castle: 2 }).pills.find((p) => p.key === 'valhalla').count, isle.count,
    'and that pill already agreed with its column');
  // A count of one still reads as a count, and the totals always add up.
  for (const col of [blocked, isle]) {
    eq(col.parts.reduce((n, p) => n + p.count, 0), col.count, `${col.key} parts add to its count`);
  }
  eq([app.columnBreakdownText(null), app.columnBreakdownText({}), app.columnBreakdownText({ parts: [] })], ['', '', ''], 'junk columns');
});

check('edge scrolling reads the pointer against the board, and only inside the band', () => {
  if (!app) throw new Error('app.js did not load');
  const [left, right] = [20, 1580];
  eq(app.edgeScrollWay(30, left, right, 72), -1, 'in the left band');
  eq(app.edgeScrollWay(1560, left, right, 72), 1, 'in the right band');
  eq(app.edgeScrollWay(800, left, right, 72), 0, 'in the middle');
  eq([app.edgeScrollWay(left + 72, left, right, 72), app.edgeScrollWay(right - 72, left, right, 72)], [0, 0], 'at the band edges');
  eq(app.edgeScrollWay(-40, left, right, 72), -1, 'past the board entirely');
  eq([app.edgeScrollWay(NaN, left, right), app.edgeScrollWay(undefined, left, right), app.edgeScrollWay(30, 100, 100)],
    [0, 0, 0], 'no pointer and no board');
});

check('repeat opens of the same session are dropped for a second, or while in flight', () => {
  eq(app.isRepeatOpen(null, A, 5000), false, 'no previous open');
  eq(app.isRepeatOpen({ id: A, at: 1000, inflight: false }, A, 1999), true, 'within a second');
  eq(app.isRepeatOpen({ id: A, at: 1000, inflight: false }, A, 2000), false, 'after a second');
  eq(app.isRepeatOpen({ id: A, at: 1000, inflight: false }, B, 1001), false, 'another session');
  eq(app.isRepeatOpen({ id: A, at: 1000, inflight: true }, A, 9000), true, 'still in flight');
  eq(app.isRepeatOpen({ id: A, at: 1000, inflight: true }, A, 11000), false, 'in flight too long');
});

check('a reading from another day shows its date, not a weekday', () => {
  const now = new Date(2026, 8, 17, 9, 0).getTime();
  const weekOld = new Date(2026, 8, 10, 10, 0).getTime();
  const text = app.sampleTime(weekOld, now);
  assert(/\b10\b/.test(text) && /10:00/.test(text), `date and time in "${text}"`);
  const weekday = new Date(weekOld).toLocaleDateString([], { weekday: 'short' });
  assert(!text.includes(weekday), `no weekday in "${text}"`);
  assert(/^\d{2}:\d{2}$/.test(app.sampleTime(new Date(2026, 8, 17, 8, 15).getTime(), now)), 'today is time only');
  const model = app.usageBarModel({ fiveHourPct: null, weeklyPct: 46, sampledAt: weekOld, stale: true }, now);
  eq(model.asOf, `as of ${text}`, 'as of');
});

check('the tooltip never covers the pointer and stays in the stage', () => {
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const sizes = [{ w: 333, h: 272 }, { w: 220, h: 120 }, { w: 380, h: 330 }];
  const stages = [
    { left: 20, top: 100, right: 660, bottom: 460 },
    { left: 0, top: 80, right: 1200, bottom: 755 },
    { left: 0, top: 0, right: 520, bottom: 240 },
  ];
  let placed = 0;
  for (const stage of stages) {
    for (const size of sizes) {
      for (let i = 0; i < 4000; i++) {
        const anchor = { x: stage.left + rand() * (stage.right - stage.left), y: stage.top + rand() * (stage.bottom - stage.top) };
        const pointer = { x: anchor.x + (rand() * 40 - 20), y: anchor.y + 5 + rand() * 55 };
        const at = app.placeTooltip(anchor, pointer, size, stage);
        if (at === null) continue;
        placed += 1;
        const h = at.maxHeight == null ? size.h : at.maxHeight;
        assert(h >= Math.min(size.h, app.TIP_MIN_HEIGHT) && h <= size.h, `height ${h}`);
        const cursor = { left: pointer.x - 6, right: pointer.x + 22, top: pointer.y - 6, bottom: pointer.y + 28 };
        const overlapX = Math.min(at.x + size.w, cursor.right) - Math.max(at.x, cursor.left);
        const overlapY = Math.min(at.y + h, cursor.bottom) - Math.max(at.y, cursor.top);
        assert(!(overlapX > 0 && overlapY > 0),
          `covers the cursor: stage ${JSON.stringify(stage)} size ${JSON.stringify(size)} anchor ${JSON.stringify(anchor)} pointer ${JSON.stringify(pointer)} at ${JSON.stringify(at)}`);
        if (size.h <= stage.bottom - stage.top - 16) {
          assert(at.y >= stage.top + 8 - 1e-6 && at.y + h <= stage.bottom - 8 + 1e-6, `inside vertically: ${JSON.stringify(at)}`);
        }
      }
    }
  }
  assert(placed > 30000, `placed only ${placed}`);
});

process.stdout.write(`${JSON.stringify(results)}\n`);
process.exitCode = results.failed.length ? 1 : 0;
