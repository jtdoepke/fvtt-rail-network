import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = await import("./engine.mjs");
const {
  buildRouteSegments,
  getTrainPosition,
  findAllActiveDepartures,
  resolveRoutePath,
  getActiveEvents,
  computeEffectiveDelay,
  findExtraDepartures,
} = mod;

// ============================================================================
// Constants for test readability
// ============================================================================
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

// ============================================================================
// Cycle 1: Route Precomputation — buildRouteSegments(path)
// ============================================================================

describe("buildRouteSegments", () => {
  it("builds correct legs from a path with stations only", () => {
    const path = [
      { station: "A", x: 0, y: 0, dwellMinutes: 0 },
      { station: "B", x: 300, y: 400, hoursFromPrev: 2, dwellMinutes: 10 },
      { station: "C", x: 600, y: 400, hoursFromPrev: 1, dwellMinutes: 0 },
    ];

    const result = buildRouteSegments(path);

    assert.equal(result.legs.length, 2, "should have 2 legs (A→B, B→C)");

    // Leg A→B
    assert.equal(result.legs[0].startStation.station, "A");
    assert.equal(result.legs[0].endStation.station, "B");
    assert.equal(result.legs[0].travelSeconds, 2 * SECONDS_PER_HOUR);
    assert.equal(result.legs[0].dwellSeconds, 0); // dwell at start station A

    // Leg B→C
    assert.equal(result.legs[1].startStation.station, "B");
    assert.equal(result.legs[1].endStation.station, "C");
    assert.equal(result.legs[1].travelSeconds, 1 * SECONDS_PER_HOUR);
    assert.equal(result.legs[1].dwellSeconds, 10 * 60); // dwell at start station B
  });

  it("builds correct legs from a path with interleaved waypoints", () => {
    const path = [
      { station: "A", x: 0, y: 0, dwellMinutes: 0 },
      { x: 100, y: 0 },   // waypoint
      { x: 200, y: 100 },  // waypoint
      { station: "B", x: 300, y: 100, hoursFromPrev: 1, dwellMinutes: 5 },
    ];

    const result = buildRouteSegments(path);

    assert.equal(result.legs.length, 1, "should have 1 leg (A→B)");
    assert.equal(result.legs[0].points.length, 4, "leg should have 4 points (A + 2 waypoints + B)");
  });

  it("computes cumulative pixel distances correctly for waypoints", () => {
    const path = [
      { station: "A", x: 0, y: 0, dwellMinutes: 0 },
      { x: 100, y: 0 },   // 100px from A
      { x: 100, y: 100 }, // 100px from prev waypoint
      { station: "B", x: 100, y: 200, hoursFromPrev: 1, dwellMinutes: 0 },  // 100px from prev
    ];

    const result = buildRouteSegments(path);
    const leg = result.legs[0];

    assert.equal(leg.cumDistances.length, 4);
    assert.equal(leg.cumDistances[0], 0);
    assert.equal(leg.cumDistances[1], 100);
    assert.equal(leg.cumDistances[2], 200);
    assert.equal(leg.cumDistances[3], 300);
    assert.equal(leg.totalPixelDist, 300);
  });

  it("computes totalJourneySeconds correctly (sum of travel + dwell)", () => {
    const path = [
      { station: "A", x: 0, y: 0, dwellMinutes: 5 },      // 5 min dwell
      { station: "B", x: 100, y: 0, hoursFromPrev: 2, dwellMinutes: 10 }, // 2h travel, 10 min dwell
      { station: "C", x: 200, y: 0, hoursFromPrev: 3, dwellMinutes: 0 },  // 3h travel, 0 dwell
    ];

    const result = buildRouteSegments(path);

    // Total = dwell(A) + travel(A→B) + dwell(B) + travel(B→C)
    // = 5*60 + 2*3600 + 10*60 + 3*3600 = 300 + 7200 + 600 + 10800 = 18900
    assert.equal(result.totalJourneySeconds, 18900);
  });

  it("first station dwell is included, last station has no dwell after arrival", () => {
    const path = [
      { station: "A", x: 0, y: 0, dwellMinutes: 15 },
      { station: "B", x: 100, y: 0, hoursFromPrev: 1, dwellMinutes: 99 }, // B's dwell included as leg 2 start
    ];

    const result = buildRouteSegments(path);

    // Only 1 leg: A→B. A's dwell is included. B's dwell is NOT included
    // (B is the terminal station — there's no next leg to consume it).
    // Total = dwell(A) + travel(A→B) = 15*60 + 1*3600 = 900 + 3600 = 4500
    assert.equal(result.totalJourneySeconds, 4500);
    assert.equal(result.legs[0].dwellSeconds, 15 * 60);
  });
});

// ============================================================================
// Cycle 2: Position Calculation — getTrainPosition(legs, totalJourneySeconds, elapsed)
// ============================================================================

describe("getTrainPosition", () => {
  // Helper: build a simple A→B→C path for reuse
  function makeSimpleRoute() {
    return buildRouteSegments([
      { station: "A", x: 0, y: 0, dwellMinutes: 5 },
      { station: "B", x: 300, y: 400, hoursFromPrev: 1, dwellMinutes: 10 },
      { station: "C", x: 600, y: 400, hoursFromPrev: 2, dwellMinutes: 0 },
    ]);
  }

  it("returns first station position during dwell at origin", () => {
    const { legs, totalJourneySeconds } = makeSimpleRoute();
    // At elapsed=0, train is dwelling at A
    const pos = getTrainPosition(legs, totalJourneySeconds, 0);
    assert.deepEqual({ x: pos.x, y: pos.y }, { x: 0, y: 0 });
    assert.equal(pos.atStation, "A");
  });

  it("returns interpolated position between two stations (no waypoints)", () => {
    const { legs, totalJourneySeconds } = makeSimpleRoute();
    // A's dwell = 5 min = 300s. Travel A→B = 1h = 3600s.
    // At elapsed = 300 + 1800 = 2100, train is halfway through A→B travel.
    const pos = getTrainPosition(legs, totalJourneySeconds, 2100);
    assert.equal(pos.atStation, null);
    // A=(0,0), B=(300,400). Halfway = (150, 200)
    assert.ok(Math.abs(pos.x - 150) < 1, `x should be ~150, got ${pos.x}`);
    assert.ok(Math.abs(pos.y - 200) < 1, `y should be ~200, got ${pos.y}`);
  });

  it("returns interpolated position following waypoints", () => {
    const { legs, totalJourneySeconds } = buildRouteSegments([
      { station: "A", x: 0, y: 0, dwellMinutes: 0 },
      { x: 100, y: 0 },    // waypoint
      { x: 100, y: 100 },  // waypoint
      { station: "B", x: 100, y: 200, hoursFromPrev: 1, dwellMinutes: 0 },
    ]);
    // Total pixel dist = 100 + 100 + 100 = 300. Travel = 3600s.
    // At 1200s (1/3 travel), pixel dist = 100. Should be at (100, 0) — the first waypoint.
    const pos = getTrainPosition(legs, totalJourneySeconds, 1200);
    assert.ok(Math.abs(pos.x - 100) < 1, `x should be ~100, got ${pos.x}`);
    assert.ok(Math.abs(pos.y - 0) < 1, `y should be ~0, got ${pos.y}`);
  });

  it("returns correct position at exact station arrival time", () => {
    const { legs, totalJourneySeconds } = makeSimpleRoute();
    // Arrive at B: dwell(A)=300 + travel(A→B)=3600 = 3900
    const pos = getTrainPosition(legs, totalJourneySeconds, 3900);
    // At 3900s the A→B travel is complete. B's dwell starts. So atStation="B".
    assert.equal(pos.atStation, "B");
    assert.ok(Math.abs(pos.x - 300) < 1);
    assert.ok(Math.abs(pos.y - 400) < 1);
  });

  it("returns station position during dwell at intermediate station", () => {
    const { legs, totalJourneySeconds } = makeSimpleRoute();
    // B dwell starts at 3900, lasts 600s. At 4200 (midway through dwell), at B.
    const pos = getTrainPosition(legs, totalJourneySeconds, 4200);
    assert.equal(pos.atStation, "B");
    assert.ok(Math.abs(pos.x - 300) < 1);
    assert.ok(Math.abs(pos.y - 400) < 1);
  });

  it("returns null after journey completes", () => {
    const { legs, totalJourneySeconds } = makeSimpleRoute();
    const pos = getTrainPosition(legs, totalJourneySeconds, totalJourneySeconds + 1);
    assert.equal(pos, null);
  });

  it("returns null for negative elapsed time", () => {
    const { legs, totalJourneySeconds } = makeSimpleRoute();
    const pos = getTrainPosition(legs, totalJourneySeconds, -100);
    assert.equal(pos, null);
  });
});

// ============================================================================
// Cycle 3: Schedule & Departures — findAllActiveDepartures(worldTime, schedule, maxJourneySeconds)
// ============================================================================

describe("findAllActiveDepartures", () => {
  it("daily schedule: finds correct departures for current day", () => {
    const schedule = { intervalDays: 1, startDayOffset: 0, departureHours: [14] };
    // World time: day 5, 16:00 (2 hours after the 14:00 departure)
    const worldTime = 5 * SECONDS_PER_DAY + 16 * SECONDS_PER_HOUR;
    const maxJourney = 10 * SECONDS_PER_HOUR;

    const departures = findAllActiveDepartures(worldTime, schedule, maxJourney);

    assert.equal(departures.length, 1);
    assert.equal(departures[0].departureTime, 5 * SECONDS_PER_DAY + 14 * SECONDS_PER_HOUR);
    assert.equal(departures[0].elapsed, 2 * SECONDS_PER_HOUR);
  });

  it("daily schedule: finds departures from previous days (multi-day journey)", () => {
    const schedule = { intervalDays: 1, startDayOffset: 0, departureHours: [22] };
    // World time: day 6, 08:00. Yesterday's 22:00 departure is 10h in transit.
    const worldTime = 6 * SECONDS_PER_DAY + 8 * SECONDS_PER_HOUR;
    const maxJourney = 60 * SECONDS_PER_HOUR; // 60h journey

    const departures = findAllActiveDepartures(worldTime, schedule, maxJourney);

    // Should find day 6 (hasn't departed yet — 22:00 > 08:00, so skip),
    // day 5 at 22:00 (10h elapsed), day 4 at 22:00 (34h elapsed), day 3 at 22:00 (58h elapsed)
    assert.equal(departures.length, 3);
    assert.equal(departures[0].elapsed, 10 * SECONDS_PER_HOUR);  // most recent first
  });

  it("multi-day interval: skips non-run days", () => {
    const schedule = { intervalDays: 2, startDayOffset: 0, departureHours: [10] };
    // Day 0, 2, 4, 6... are run days. Day 1, 3, 5... are not.
    // World time: day 3, 12:00. Day 3 is NOT a run day.
    const worldTime = 3 * SECONDS_PER_DAY + 12 * SECONDS_PER_HOUR;
    const maxJourney = 30 * SECONDS_PER_HOUR;

    const departures = findAllActiveDepartures(worldTime, schedule, maxJourney);

    // Day 3: not a run day. Day 2: run day, departed at 10:00, elapsed = 26h. Active (< 30h).
    assert.equal(departures.length, 1);
    assert.equal(departures[0].departureTime, 2 * SECONDS_PER_DAY + 10 * SECONDS_PER_HOUR);
  });

  it("multi-day interval with offset: runs on correct offset days", () => {
    const schedule = { intervalDays: 3, startDayOffset: 1, departureHours: [10] };
    // Run days: 1, 4, 7, 10... (startDayOffset=1, interval=3)
    // World time: day 4, 15:00. Day 4 is a run day.
    const worldTime = 4 * SECONDS_PER_DAY + 15 * SECONDS_PER_HOUR;
    const maxJourney = 10 * SECONDS_PER_HOUR;

    const departures = findAllActiveDepartures(worldTime, schedule, maxJourney);

    assert.equal(departures.length, 1);
    assert.equal(departures[0].departureTime, 4 * SECONDS_PER_DAY + 10 * SECONDS_PER_HOUR);
    assert.equal(departures[0].elapsed, 5 * SECONDS_PER_HOUR);
  });

  it("multiple departure hours: finds all concurrent active trains", () => {
    const schedule = { intervalDays: 1, startDayOffset: 0, departureHours: [8, 14, 20] };
    // World time: day 5, 22:00. Journey takes 10h.
    const worldTime = 5 * SECONDS_PER_DAY + 22 * SECONDS_PER_HOUR;
    const maxJourney = 10 * SECONDS_PER_HOUR;

    const departures = findAllActiveDepartures(worldTime, schedule, maxJourney);

    // 20:00 today: 2h elapsed (active). 14:00 today: 8h elapsed (active). 8:00 today: 14h (too old).
    assert.equal(departures.length, 2);
    assert.equal(departures[0].elapsed, 2 * SECONDS_PER_HOUR);  // most recent first
    assert.equal(departures[1].elapsed, 8 * SECONDS_PER_HOUR);
  });

  it("no departures active when none are in transit", () => {
    const schedule = { intervalDays: 1, startDayOffset: 0, departureHours: [14] };
    // World time: day 5, 10:00. Today's departure hasn't happened yet.
    // Yesterday's 14:00 departed 20h ago. Journey is only 5h.
    const worldTime = 5 * SECONDS_PER_DAY + 10 * SECONDS_PER_HOUR;
    const maxJourney = 5 * SECONDS_PER_HOUR;

    const departures = findAllActiveDepartures(worldTime, schedule, maxJourney);

    assert.equal(departures.length, 0);
  });
});

// ============================================================================
// Cycle 4: Path Resolution & Segment Chaining — resolveRoutePath(segments, worldTime)
// ============================================================================

describe("resolveRoutePath", () => {
  it("chains two segments end-to-end, dropping duplicate junction point", () => {
    const segments = [
      {
        segmentId: "a-b",
        path: [
          { station: "A", x: 0, y: 0, dwellMinutes: 0 },
          { station: "B", x: 100, y: 0, hoursFromPrev: 1, dwellMinutes: 10 },
        ],
      },
      {
        segmentId: "b-c",
        path: [
          { station: "B", x: 100, y: 0, dwellMinutes: 0 },
          { station: "C", x: 200, y: 0, hoursFromPrev: 2, dwellMinutes: 0 },
        ],
      },
    ];

    const result = resolveRoutePath(segments, 1000);

    // Should have 3 nodes: A, B, C (duplicate B dropped)
    assert.equal(result.length, 3);
    assert.equal(result[0].station, "A");
    assert.equal(result[1].station, "B");
    assert.equal(result[2].station, "C");
    // B's dwell should come from first segment (10), not second (0)
    assert.equal(result[1].dwellMinutes, 10);
  });

  it("chains three segments, middle one inactive — truncates after first", () => {
    const segments = [
      {
        segmentId: "a-b",
        path: [
          { station: "A", x: 0, y: 0, dwellMinutes: 0 },
          { station: "B", x: 100, y: 0, hoursFromPrev: 1, dwellMinutes: 10 },
        ],
      },
      {
        segmentId: "b-c",
        effectiveStart: 999999, // not yet active at worldTime=100
        path: [
          { station: "B", x: 100, y: 0, dwellMinutes: 0 },
          { station: "C", x: 200, y: 0, hoursFromPrev: 2, dwellMinutes: 5 },
        ],
      },
      {
        segmentId: "c-d",
        path: [
          { station: "C", x: 200, y: 0, dwellMinutes: 0 },
          { station: "D", x: 300, y: 0, hoursFromPrev: 1, dwellMinutes: 0 },
        ],
      },
    ];

    const result = resolveRoutePath(segments, 100);

    // Middle segment inactive → truncate. Only A, B from first segment.
    assert.equal(result.length, 2);
    assert.equal(result[0].station, "A");
    assert.equal(result[1].station, "B");
  });

  it("segment with future effectiveStart is excluded", () => {
    const segments = [
      {
        segmentId: "a-b",
        effectiveStart: 5000,
        path: [
          { station: "A", x: 0, y: 0, dwellMinutes: 0 },
          { station: "B", x: 100, y: 0, hoursFromPrev: 1, dwellMinutes: 0 },
        ],
      },
    ];

    const result = resolveRoutePath(segments, 100);
    assert.equal(result.length, 0);
  });

  it("segment with past effectiveEnd is excluded", () => {
    const segments = [
      {
        segmentId: "a-b",
        effectiveEnd: 50,
        path: [
          { station: "A", x: 0, y: 0, dwellMinutes: 0 },
          { station: "B", x: 100, y: 0, hoursFromPrev: 1, dwellMinutes: 0 },
        ],
      },
    ];

    const result = resolveRoutePath(segments, 100);
    assert.equal(result.length, 0);
  });

  it("falls back to inline path when no Drawing data provided", () => {
    const segments = [
      {
        segmentId: "a-b",
        path: [
          { station: "A", x: 0, y: 0, dwellMinutes: 0 },
          { x: 50, y: 25 },
          { station: "B", x: 100, y: 0, hoursFromPrev: 1, dwellMinutes: 0 },
        ],
      },
    ];

    const result = resolveRoutePath(segments, 1000);

    assert.equal(result.length, 3);
    assert.equal(result[0].station, "A");
    assert.equal(result[1].x, 50); // waypoint preserved
    assert.equal(result[2].station, "B");
  });
});

// ============================================================================
// Cycle 5: Events — getActiveEvents(events, routeId, worldTime)
// ============================================================================

describe("getActiveEvents", () => {
  it("closeLine event suppresses route when active", () => {
    const events = [
      { id: "e1", type: "closeLine", target: { routeId: "r1" }, startTime: 100, endTime: 500 },
    ];
    const active = getActiveEvents(events, "r1", 200);
    assert.equal(active.length, 1);
    assert.equal(active[0].type, "closeLine");
  });

  it("closeLine with endTime: not active after endTime", () => {
    const events = [
      { id: "e1", type: "closeLine", target: { routeId: "r1" }, startTime: 100, endTime: 500 },
    ];
    const active = getActiveEvents(events, "r1", 600);
    assert.equal(active.length, 0);
  });

  it("closeLine with no startTime: models not-yet-open line", () => {
    const events = [
      { id: "e1", type: "closeLine", target: { routeId: "r1" }, startTime: null, endTime: 1000 },
    ];
    // Before endTime: active (line closed)
    assert.equal(getActiveEvents(events, "r1", 500).length, 1);
    // After endTime: inactive (line open)
    assert.equal(getActiveEvents(events, "r1", 1500).length, 0);
  });

  it("filters events by routeId", () => {
    const events = [
      { id: "e1", type: "closeLine", target: { routeId: "r1" }, startTime: 0, endTime: null },
      { id: "e2", type: "closeLine", target: { routeId: "r2" }, startTime: 0, endTime: null },
    ];
    const active = getActiveEvents(events, "r1", 100);
    assert.equal(active.length, 1);
    assert.equal(active[0].id, "e1");
  });

  it("blockTrack event is active within time range", () => {
    const events = [
      { id: "e1", type: "blockTrack", target: { routeId: "r1", stationName: "X" }, startTime: 100, endTime: 500 },
    ];
    assert.equal(getActiveEvents(events, "r1", 300).length, 1);
    assert.equal(getActiveEvents(events, "r1", 600).length, 0);
  });

  it("delay event targets specific departure", () => {
    const events = [
      { id: "e1", type: "delay", target: { routeId: "r1", departureTime: 5000 }, startTime: 5500, endTime: null, delayHours: 3 },
    ];
    const active = getActiveEvents(events, "r1", 6000);
    assert.equal(active.length, 1);
    assert.equal(active[0].delayHours, 3);
  });

  it("destroy event is permanent (null endTime)", () => {
    const events = [
      { id: "e1", type: "destroy", target: { routeId: "r1", departureTime: 5000 }, startTime: 5500, endTime: null },
    ];
    assert.equal(getActiveEvents(events, "r1", 99999).length, 1);
  });

  it("time reversal: event inactive before its startTime", () => {
    const events = [
      { id: "e1", type: "blockTrack", target: { routeId: "r1", stationName: "X" }, startTime: 1000, endTime: null },
    ];
    assert.equal(getActiveEvents(events, "r1", 500).length, 0); // before start
    assert.equal(getActiveEvents(events, "r1", 1500).length, 1); // after start
  });

  it("time reversal: event re-activates when moving before endTime", () => {
    const events = [
      { id: "e1", type: "blockTrack", target: { routeId: "r1", stationName: "X" }, startTime: 100, endTime: 500 },
    ];
    assert.equal(getActiveEvents(events, "r1", 300).length, 1); // active
    assert.equal(getActiveEvents(events, "r1", 600).length, 0); // expired
    assert.equal(getActiveEvents(events, "r1", 300).length, 1); // re-active after rewind
  });

  it("multiple overlapping events on same route", () => {
    const events = [
      { id: "e1", type: "blockTrack", target: { routeId: "r1", stationName: "X" }, startTime: 100, endTime: 500 },
      { id: "e2", type: "delay", target: { routeId: "r1", departureTime: 200 }, startTime: 150, endTime: null, delayHours: 2 },
      { id: "e3", type: "closeLine", target: { routeId: "r2" }, startTime: 0, endTime: null },
    ];
    const active = getActiveEvents(events, "r1", 300);
    assert.equal(active.length, 2); // e1 and e2, not e3 (different route)
  });
});

// ============================================================================
// Cycle 6: Delay Recovery — computeEffectiveDelay(event, worldTime)
// ============================================================================

describe("computeEffectiveDelay", () => {
  it("permanent delay: full delayHours always", () => {
    const evt = { delayHours: 3, startTime: 1000, endTime: null };
    assert.equal(computeEffectiveDelay(evt, 2000), 3);
    assert.equal(computeEffectiveDelay(evt, 99999), 3);
  });

  it("delay with endTime: linearly decreases to 0", () => {
    const evt = { delayHours: 6, startTime: 1000, endTime: 7000 }; // 6000s window
    // At startTime: full delay
    assert.equal(computeEffectiveDelay(evt, 1000), 6);
    // Midway: half delay
    assert.equal(computeEffectiveDelay(evt, 4000), 3);
    // At endTime: 0
    assert.equal(computeEffectiveDelay(evt, 7000), 0);
    // After endTime: 0
    assert.equal(computeEffectiveDelay(evt, 9000), 0);
  });

  it("delay with recoveryRate: decreases at fixed rate", () => {
    // 3h delay, recovers 0.5h per real hour = 1800s per 3600s
    const evt = { delayHours: 3, startTime: 0, endTime: null, recoveryRate: 0.5 };
    // At t=0: 3h delay
    assert.equal(computeEffectiveDelay(evt, 0), 3);
    // At t=2h (7200s): recovered 1h → 2h delay
    assert.ok(Math.abs(computeEffectiveDelay(evt, 7200) - 2) < 0.01);
    // At t=6h (21600s): recovered 3h → 0h delay
    assert.equal(computeEffectiveDelay(evt, 21600), 0);
    // At t=10h: still 0 (can't go negative)
    assert.equal(computeEffectiveDelay(evt, 36000), 0);
  });

  it("recoveryRate takes precedence over endTime", () => {
    const evt = { delayHours: 4, startTime: 0, endTime: 50000, recoveryRate: 1.0 };
    // With recoveryRate=1.0, delay recovers 1h per hour → fully recovered at t=4h (14400s)
    assert.equal(computeEffectiveDelay(evt, 14400), 0);
    // endTime would say delay until 50000, but recoveryRate takes precedence
  });

  it("before startTime: returns full delay (event not yet active)", () => {
    const evt = { delayHours: 2, startTime: 5000, endTime: null };
    // computeEffectiveDelay is called on active events, but if called before start, return full delay
    assert.equal(computeEffectiveDelay(evt, 3000), 2);
  });
});

// ============================================================================
// Cycle 7: Extra Departures — findExtraDepartures(activeEvents, worldTime, legs)
// ============================================================================

describe("findExtraDepartures", () => {
  // Build legs for a simple A→B→C route for testing
  function makeLegs() {
    return buildRouteSegments([
      { station: "A", x: 0, y: 0, dwellMinutes: 0 },
      { station: "B", x: 100, y: 0, hoursFromPrev: 2, dwellMinutes: 10 },
      { station: "C", x: 200, y: 0, hoursFromPrev: 3, dwellMinutes: 0 },
    ]);
  }

  it("creates a synthetic departure from named station", () => {
    const { legs, totalJourneySeconds } = makeLegs();
    const events = [
      {
        id: "ex1", type: "extraDeparture",
        target: { routeId: "r1", stationName: "B" },
        startTime: 5000, endTime: null,
      },
    ];

    const extras = findExtraDepartures(events, 6000, legs);

    assert.equal(extras.length, 1);
    assert.equal(extras[0].departureTime, 5000);
    assert.equal(extras[0].elapsed, 1000);
    assert.equal(extras[0].startStationName, "B");
  });

  it("extra departure not active before startTime", () => {
    const { legs } = makeLegs();
    const events = [
      {
        id: "ex1", type: "extraDeparture",
        target: { routeId: "r1", stationName: "B" },
        startTime: 5000, endTime: null,
      },
    ];

    const extras = findExtraDepartures(events, 4000, legs);
    assert.equal(extras.length, 0);
  });

  it("extra departure + destroy: replacement train scenario", () => {
    const { legs, totalJourneySeconds } = makeLegs();
    // The extra departure starts at B. Journey from B→C = 3h + 10min dwell at B.
    // So max journey from B = 10*60 + 3*3600 = 11400s.
    // At worldTime 5000 + 12000 = 17000, the extra train would have completed.
    const events = [
      {
        id: "ex1", type: "extraDeparture",
        target: { routeId: "r1", stationName: "B" },
        startTime: 5000, endTime: null,
      },
    ];

    // At 6000 (1000s after departure), train should be active
    const extras1 = findExtraDepartures(events, 6000, legs);
    assert.equal(extras1.length, 1);

    // At 17000 (12000s after departure), exceeds B→C journey time, should be inactive
    const extras2 = findExtraDepartures(events, 17000, legs);
    assert.equal(extras2.length, 0);
  });
});
