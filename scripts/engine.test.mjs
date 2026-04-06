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
  reversePath,
  applyDirection,
  findClosestEndpointPair,
  orientAndSlicePath,
  parseCronField,
  parseCronExpression,
  describeCronExpression,
  normalizeSchedule,
  computeDesiredTokens,
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
      { x: 100, y: 0 }, // waypoint
      { x: 200, y: 100 }, // waypoint
      { station: "B", x: 300, y: 100, hoursFromPrev: 1, dwellMinutes: 5 },
    ];

    const result = buildRouteSegments(path);

    assert.equal(result.legs.length, 1, "should have 1 leg (A→B)");
    assert.equal(result.legs[0].points.length, 4, "leg should have 4 points (A + 2 waypoints + B)");
  });

  it("computes cumulative pixel distances correctly for waypoints", () => {
    const path = [
      { station: "A", x: 0, y: 0, dwellMinutes: 0 },
      { x: 100, y: 0 }, // 100px from A
      { x: 100, y: 100 }, // 100px from prev waypoint
      { station: "B", x: 100, y: 200, hoursFromPrev: 1, dwellMinutes: 0 }, // 100px from prev
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
      { station: "A", x: 0, y: 0, dwellMinutes: 5 }, // 5 min dwell
      { station: "B", x: 100, y: 0, hoursFromPrev: 2, dwellMinutes: 10 }, // 2h travel, 10 min dwell
      { station: "C", x: 200, y: 0, hoursFromPrev: 3, dwellMinutes: 0 }, // 3h travel, 0 dwell
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
      { x: 100, y: 0 }, // waypoint
      { x: 100, y: 100 }, // waypoint
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
    const schedule = [{ cron: "0 14", routeNumbers: ["101"], direction: "outbound", segments: [] }];
    // World time: day 5, 16:00 (2 hours after the 14:00 departure)
    const worldTime = 5 * SECONDS_PER_DAY + 16 * SECONDS_PER_HOUR;
    const maxJourney = 10 * SECONDS_PER_HOUR;

    const departures = findAllActiveDepartures(worldTime, schedule, maxJourney);

    assert.equal(departures.length, 1);
    assert.equal(departures[0].departureTime, 5 * SECONDS_PER_DAY + 14 * SECONDS_PER_HOUR);
    assert.equal(departures[0].elapsed, 2 * SECONDS_PER_HOUR);
    assert.equal(departures[0].routeNum, "101");
  });

  it("daily schedule: finds departures from previous days (multi-day journey)", () => {
    const schedule = [{ cron: "0 22", routeNumbers: ["101"], direction: "outbound", segments: [] }];
    // World time: day 6, 08:00. Yesterday's 22:00 departure is 10h in transit.
    const worldTime = 6 * SECONDS_PER_DAY + 8 * SECONDS_PER_HOUR;
    const maxJourney = 60 * SECONDS_PER_HOUR; // 60h journey

    const departures = findAllActiveDepartures(worldTime, schedule, maxJourney);

    // Should find day 5 at 22:00 (10h elapsed), day 4 at 22:00 (34h elapsed), day 3 at 22:00 (58h elapsed)
    assert.equal(departures.length, 3);
    assert.equal(departures[0].elapsed, 10 * SECONDS_PER_HOUR); // most recent first
  });

  it("multi-day interval: skips non-run days", () => {
    // Every 48 hours starting at hour 10 = departures at hours 10, 58, 106, ...
    // Day 0 10:00, Day 2 10:00, Day 4 10:00, ...
    const schedule = [{ cron: "0 10/48", routeNumbers: ["101"], direction: "outbound", segments: [] }];
    // World time: day 3, 12:00.
    const worldTime = 3 * SECONDS_PER_DAY + 12 * SECONDS_PER_HOUR;
    const maxJourney = 30 * SECONDS_PER_HOUR;

    const departures = findAllActiveDepartures(worldTime, schedule, maxJourney);

    // Day 2 at 10:00 (abs hour 58), elapsed = 26h. Active (< 30h).
    assert.equal(departures.length, 1);
    assert.equal(departures[0].departureTime, 2 * SECONDS_PER_DAY + 10 * SECONDS_PER_HOUR);
  });

  it("multi-day interval with offset: runs on correct offset days", () => {
    // Every 72 hours (3 days) starting at hour 10, offset 24h
    // Matches hours where (absHour - 24) % 72 === 10 % 72
    // = absHour = 34, 106, 178, ... = day 1 10:00, day 4 10:00, day 7 10:00
    const schedule = [{ cron: "0 10/72 24", routeNumbers: ["101"], direction: "outbound", segments: [] }];
    // World time: day 4, 15:00. Day 4 at 10:00 = abs hour 106, (106-24)%72 = 82%72 = 10 ✓
    const worldTime = 4 * SECONDS_PER_DAY + 15 * SECONDS_PER_HOUR;
    const maxJourney = 10 * SECONDS_PER_HOUR;

    const departures = findAllActiveDepartures(worldTime, schedule, maxJourney);

    assert.equal(departures.length, 1);
    assert.equal(departures[0].departureTime, 4 * SECONDS_PER_DAY + 10 * SECONDS_PER_HOUR);
    assert.equal(departures[0].elapsed, 5 * SECONDS_PER_HOUR);
  });

  it("multiple departure hours: finds all concurrent active trains", () => {
    const schedule = [
      { cron: "0 8", routeNumbers: ["101"], direction: "outbound", segments: [] },
      { cron: "0 14", routeNumbers: ["102"], direction: "outbound", segments: [] },
      { cron: "0 20", routeNumbers: ["103"], direction: "outbound", segments: [] },
    ];
    // World time: day 5, 22:00. Journey takes 10h.
    const worldTime = 5 * SECONDS_PER_DAY + 22 * SECONDS_PER_HOUR;
    const maxJourney = 10 * SECONDS_PER_HOUR;

    const departures = findAllActiveDepartures(worldTime, schedule, maxJourney);

    // 20:00 today: 2h elapsed (active). 14:00 today: 8h elapsed (active). 8:00 today: 14h (too old).
    assert.equal(departures.length, 2);
    assert.equal(departures[0].elapsed, 2 * SECONDS_PER_HOUR); // most recent first
    assert.equal(departures[1].elapsed, 8 * SECONDS_PER_HOUR);
  });

  it("no departures active when none are in transit", () => {
    const schedule = [{ cron: "0 14", routeNumbers: ["101"], direction: "outbound", segments: [] }];
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
// findClosestEndpointPair
// ============================================================================

describe("findClosestEndpointPair", () => {
  it("finds matching endpoints", () => {
    const a = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const b = [
      { x: 100, y: 0 },
      { x: 200, y: 0 },
    ];
    const pair = findClosestEndpointPair(a, b);
    assert.equal(pair.indexA, 1);
    assert.equal(pair.indexB, 0);
    assert.equal(pair.distance, 0);
  });

  it("finds closest when no exact match", () => {
    const a = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const b = [
      { x: 102, y: 1 },
      { x: 200, y: 0 },
    ];
    const pair = findClosestEndpointPair(a, b);
    assert.equal(pair.indexA, 1);
    assert.equal(pair.indexB, 0);
    assert.ok(pair.distance < 3);
  });

  it("finds T-junction (B endpoint matches A mid-point)", () => {
    const a = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 0 },
    ];
    const b = [
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];
    const pair = findClosestEndpointPair(a, b);
    assert.equal(pair.indexA, 1);
    assert.equal(pair.indexB, 0);
    assert.equal(pair.distance, 0);
  });

  it("parallel tracks don't false-match mid-segment", () => {
    // Two tracks run parallel, close together at midpoints, converging at endpoints
    const a = [
      { x: 0, y: 0 },
      { x: 50, y: 1 },
      { x: 100, y: 0 },
    ];
    const b = [
      { x: 100, y: 0 },
      { x: 50, y: -1 },
      { x: 200, y: 0 },
    ];
    // Mid-points (50,1) and (50,-1) are distance 2, but one must be an endpoint.
    // Closest valid pair: A's last (100,0) and B's first (100,0), distance 0.
    const pair = findClosestEndpointPair(a, b);
    assert.equal(pair.indexA, 2);
    assert.equal(pair.indexB, 0);
    assert.equal(pair.distance, 0);
  });
});

// ============================================================================
// orientAndSlicePath
// ============================================================================

describe("orientAndSlicePath", () => {
  it("forward slice preserves order", () => {
    const path = [
      { station: "A", x: 0, y: 0, hoursFromPrev: 0, dwellMinutes: 0 },
      { station: "B", x: 100, y: 0, hoursFromPrev: 1, dwellMinutes: 5 },
      { station: "C", x: 200, y: 0, hoursFromPrev: 2, dwellMinutes: 0 },
    ];
    const result = orientAndSlicePath(path, 0, 2);
    assert.equal(result.length, 3);
    assert.equal(result[0].station, "A");
    assert.equal(result[0].hoursFromPrev, 0);
    assert.equal(result[1].station, "B");
    assert.equal(result[2].station, "C");
  });

  it("reverse slice reverses and shifts hoursFromPrev", () => {
    const path = [
      { station: "A", x: 0, y: 0, hoursFromPrev: 0, dwellMinutes: 0 },
      { station: "B", x: 100, y: 0, hoursFromPrev: 2, dwellMinutes: 5 },
      { station: "C", x: 200, y: 0, hoursFromPrev: 3, dwellMinutes: 0 },
    ];
    const result = orientAndSlicePath(path, 2, 0);
    assert.equal(result.length, 3);
    assert.equal(result[0].station, "C");
    assert.equal(result[0].hoursFromPrev, 0);
    assert.equal(result[1].station, "B");
    assert.equal(result[1].hoursFromPrev, 3);
    assert.equal(result[2].station, "A");
    assert.equal(result[2].hoursFromPrev, 2);
  });

  it("partial forward slice (T-junction)", () => {
    const path = [
      { station: "A", x: 0, y: 0, hoursFromPrev: 0, dwellMinutes: 0 },
      { station: "B", x: 100, y: 0, hoursFromPrev: 2, dwellMinutes: 5 },
      { station: "C", x: 200, y: 0, hoursFromPrev: 3, dwellMinutes: 0 },
    ];
    const result = orientAndSlicePath(path, 1, 2);
    assert.equal(result.length, 2);
    assert.equal(result[0].station, "B");
    assert.equal(result[0].hoursFromPrev, 0); // first station reset
    assert.equal(result[1].station, "C");
    assert.equal(result[1].hoursFromPrev, 3); // preserved
  });

  it("single point returns single node", () => {
    const path = [{ station: "A", x: 0, y: 0, hoursFromPrev: 5, dwellMinutes: 10 }];
    const result = orientAndSlicePath(path, 0, 0);
    assert.equal(result.length, 1);
    assert.equal(result[0].station, "A");
    assert.equal(result[0].hoursFromPrev, 0);
  });
});

// ============================================================================
// resolveRoutePath — closest-point chaining
// ============================================================================

describe("resolveRoutePath closest-point chaining", () => {
  it("auto-orients reversed segment", () => {
    const segments = [
      {
        segmentId: "a-b",
        path: [
          { station: "A", x: 0, y: 0, dwellMinutes: 0 },
          { station: "B", x: 100, y: 0, hoursFromPrev: 1, dwellMinutes: 5 },
        ],
      },
      {
        segmentId: "c-b", // B is at the end, reversed relative to expected travel
        path: [
          { station: "C", x: 200, y: 0, dwellMinutes: 0, hoursFromPrev: 0 },
          { station: "B", x: 100, y: 0, hoursFromPrev: 2, dwellMinutes: 0 },
        ],
      },
    ];

    const result = resolveRoutePath(segments, 1000);
    assert.equal(result.length, 3);
    assert.equal(result[0].station, "A");
    assert.equal(result[1].station, "B");
    assert.equal(result[2].station, "C");
    // B→C travel time: original C→B was 2h, reversed B→C should also be 2h
    assert.equal(result[2].hoursFromPrev, 2);
  });

  it("chains segments regardless of B's internal direction", () => {
    // Same physical track, B stored forward vs reversed — same result
    const segA = {
      segmentId: "a-b",
      path: [
        { station: "A", x: 0, y: 0, dwellMinutes: 0 },
        { station: "B", x: 100, y: 0, hoursFromPrev: 1, dwellMinutes: 5 },
      ],
    };
    const segBForward = {
      segmentId: "b-c",
      path: [
        { station: "B", x: 100, y: 0, dwellMinutes: 0 },
        { station: "C", x: 200, y: 0, hoursFromPrev: 2, dwellMinutes: 0 },
      ],
    };
    const segBReversed = {
      segmentId: "c-b",
      path: [
        { station: "C", x: 200, y: 0, dwellMinutes: 0 },
        { station: "B", x: 100, y: 0, hoursFromPrev: 2, dwellMinutes: 0 },
      ],
    };

    const r1 = resolveRoutePath([segA, segBForward], 1000);
    const r2 = resolveRoutePath([segA, segBReversed], 1000);

    assert.equal(r1.length, 3);
    assert.equal(r2.length, 3);
    assert.equal(r1[0].station, "A");
    assert.equal(r2[0].station, "A");
    assert.equal(r1[2].station, "C");
    assert.equal(r2[2].station, "C");
  });

  it("T-junction: B joins A mid-path, truncates A", () => {
    const segments = [
      {
        segmentId: "a-c",
        path: [
          { station: "A", x: 0, y: 0, dwellMinutes: 0 },
          { station: "B", x: 100, y: 0, hoursFromPrev: 1, dwellMinutes: 5 },
          { station: "C", x: 200, y: 0, hoursFromPrev: 1, dwellMinutes: 0 },
        ],
      },
      {
        segmentId: "b-d",
        path: [
          { station: "B", x: 100, y: 0, dwellMinutes: 0 },
          { station: "D", x: 100, y: 100, hoursFromPrev: 2, dwellMinutes: 0 },
        ],
      },
    ];

    const result = resolveRoutePath(segments, 1000);
    // A → B (truncated, C dropped) → D
    assert.equal(result.length, 3);
    assert.equal(result[0].station, "A");
    assert.equal(result[1].station, "B");
    assert.equal(result[2].station, "D");
  });

  it("junction dwell uses max of both sides", () => {
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
          { station: "B", x: 100, y: 0, dwellMinutes: 60 },
          { station: "C", x: 200, y: 0, hoursFromPrev: 2, dwellMinutes: 0 },
        ],
      },
    ];

    const result = resolveRoutePath(segments, 1000);
    assert.equal(result.length, 3);
    assert.equal(result[1].station, "B");
    assert.equal(result[1].dwellMinutes, 60); // max(10, 60)
  });

  it("three segments with auto-orientation", () => {
    const segments = [
      {
        segmentId: "a-b",
        path: [
          { station: "A", x: 0, y: 0, dwellMinutes: 0 },
          { station: "B", x: 100, y: 0, hoursFromPrev: 1, dwellMinutes: 5 },
        ],
      },
      {
        segmentId: "c-b", // stored reversed
        path: [
          { station: "C", x: 200, y: 0, dwellMinutes: 0 },
          { station: "B", x: 100, y: 0, hoursFromPrev: 2, dwellMinutes: 0 },
        ],
      },
      {
        segmentId: "c-d",
        path: [
          { station: "C", x: 200, y: 0, dwellMinutes: 0 },
          { station: "D", x: 300, y: 0, hoursFromPrev: 3, dwellMinutes: 0 },
        ],
      },
    ];

    const result = resolveRoutePath(segments, 1000);
    assert.equal(result.length, 4);
    assert.equal(result[0].station, "A");
    assert.equal(result[1].station, "B");
    assert.equal(result[2].station, "C");
    assert.equal(result[3].station, "D");
  });

  // Real-world config: sharn-fairhaven (Sharn→Wroat) and wroat-starilaskur (Wroat→Starilaskur).
  // Junction at Wroat (off by 1px between segments).
  // Two trips: Trip 1 lists [wroat-starilaskur, sharn-fairhaven] → should travel Starilaskur→Wroat→Sharn.
  //            Trip 2 lists [sharn-fairhaven, wroat-starilaskur] → should travel Sharn→Wroat→Starilaskur.
  const sharnFairhaven = {
    segmentId: "sharn-fairhaven",
    path: [
      { station: "Sharn", x: 3960, y: 5906, hoursFromPrev: 0, dwellMinutes: 0 },
      { x: 3985, y: 5902 },
      { station: "First Tower", x: 4015, y: 5851, hoursFromPrev: 1, dwellMinutes: 30 },
      { x: 4028, y: 5836 },
      { station: "Faircourt", x: 4090, y: 5663, hoursFromPrev: 2, dwellMinutes: 60 },
      { x: 4119, y: 5654 },
      { station: "Wroat", x: 4379, y: 5386, hoursFromPrev: 4, dwellMinutes: 60 },
    ],
  };
  const wroatStarilaskur = {
    segmentId: "wroat-starilaskur",
    path: [
      { station: "Wroat", x: 4379, y: 5387, hoursFromPrev: 0, dwellMinutes: 60 },
      { x: 4400, y: 5350 },
      { station: "Mainford", x: 4489, y: 5221, hoursFromPrev: 1, dwellMinutes: 60 },
      { x: 4600, y: 5200 },
      { station: "Earlsfield", x: 4825, y: 5161, hoursFromPrev: 2, dwellMinutes: 60 },
      { station: "Lowstead", x: 5028, y: 5101, hoursFromPrev: 1, dwellMinutes: 60 },
      { station: "Nowhere", x: 5297, y: 4999, hoursFromPrev: 1.5, dwellMinutes: 60 },
      { x: 5500, y: 4900 },
      { station: "Starilaskur", x: 5630, y: 4871, hoursFromPrev: 2, dwellMinutes: 60 },
    ],
  };

  it("real config trip 1: wroat-starilaskur then sharn-fairhaven → Starilaskur to Sharn", () => {
    const result = resolveRoutePath([wroatStarilaskur, sharnFairhaven], 1000);
    const stations = result.filter((n) => "station" in n);
    assert.deepEqual(
      stations.map((s) => s.station),
      ["Starilaskur", "Nowhere", "Lowstead", "Earlsfield", "Mainford", "Wroat", "Faircourt", "First Tower", "Sharn"],
    );
    // First station (departure) should have dwellMinutes=0
    assert.equal(stations[0].dwellMinutes, 0);
    assert.equal(stations[0].hoursFromPrev, 0);
    // Wroat junction should use max dwell: max(60, 60) = 60
    const wroat = stations.find((s) => s.station === "Wroat");
    assert.equal(wroat.dwellMinutes, 60);
    // First Tower dwell preserved
    assert.equal(stations.find((s) => s.station === "First Tower").dwellMinutes, 30);
  });

  it("real config trip 2: sharn-fairhaven then wroat-starilaskur → Sharn to Starilaskur", () => {
    const result = resolveRoutePath([sharnFairhaven, wroatStarilaskur], 1000);
    const stations = result.filter((n) => "station" in n);
    assert.deepEqual(
      stations.map((s) => s.station),
      ["Sharn", "First Tower", "Faircourt", "Wroat", "Mainford", "Earlsfield", "Lowstead", "Nowhere", "Starilaskur"],
    );
    // First station (departure) should have dwellMinutes=0
    assert.equal(stations[0].dwellMinutes, 0);
    assert.equal(stations[0].hoursFromPrev, 0);
    // Wroat junction should use max dwell
    const wroat = stations.find((s) => s.station === "Wroat");
    assert.equal(wroat.dwellMinutes, 60);
  });

  it("real config: both segment orderings produce same path (just reversed)", () => {
    const trip1 = resolveRoutePath([wroatStarilaskur, sharnFairhaven], 1000);
    const trip2 = resolveRoutePath([sharnFairhaven, wroatStarilaskur], 1000);
    const stations1 = trip1.filter((n) => "station" in n).map((s) => s.station);
    const stations2 = trip2.filter((n) => "station" in n).map((s) => s.station);
    assert.deepEqual(stations1, stations2.slice().reverse());
  });

  it("waypoint-only junction", () => {
    const segments = [
      {
        segmentId: "a-wp",
        path: [
          { station: "A", x: 0, y: 0, dwellMinutes: 0 },
          { x: 100, y: 0 }, // waypoint at junction
        ],
      },
      {
        segmentId: "wp-b",
        path: [
          { x: 100, y: 0 }, // waypoint at junction
          { station: "B", x: 200, y: 0, hoursFromPrev: 2, dwellMinutes: 0 },
        ],
      },
    ];

    const result = resolveRoutePath(segments, 1000);
    // A, waypoint, B — junction waypoint not duplicated
    assert.equal(result.length, 3);
    assert.equal(result[0].station, "A");
    assert.ok(!("station" in result[1])); // waypoint
    assert.equal(result[2].station, "B");
  });
});

// ============================================================================
// Cycle 5: Events — getActiveEvents(events, routeId, worldTime)
// ============================================================================

describe("getActiveEvents", () => {
  it("closeLine event suppresses route when active", () => {
    const events = [{ id: "e1", type: "closeLine", target: { routeId: "r1" }, startTime: 100, endTime: 500 }];
    const active = getActiveEvents(events, "r1", 200);
    assert.equal(active.length, 1);
    assert.equal(active[0].type, "closeLine");
  });

  it("closeLine with endTime: not active after endTime", () => {
    const events = [{ id: "e1", type: "closeLine", target: { routeId: "r1" }, startTime: 100, endTime: 500 }];
    const active = getActiveEvents(events, "r1", 600);
    assert.equal(active.length, 0);
  });

  it("closeLine with no startTime: models not-yet-open line", () => {
    const events = [{ id: "e1", type: "closeLine", target: { routeId: "r1" }, startTime: null, endTime: 1000 }];
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
      {
        id: "e1",
        type: "delay",
        target: { routeId: "r1", departureTime: 5000 },
        startTime: 5500,
        endTime: null,
        delayHours: 3,
      },
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
      {
        id: "e2",
        type: "delay",
        target: { routeId: "r1", departureTime: 200 },
        startTime: 150,
        endTime: null,
        delayHours: 2,
      },
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
    const { legs } = makeLegs();
    const events = [
      {
        id: "ex1",
        type: "extraDeparture",
        target: { routeId: "r1", stationName: "B" },
        startTime: 5000,
        endTime: null,
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
        id: "ex1",
        type: "extraDeparture",
        target: { routeId: "r1", stationName: "B" },
        startTime: 5000,
        endTime: null,
      },
    ];

    const extras = findExtraDepartures(events, 4000, legs);
    assert.equal(extras.length, 0);
  });

  it("extra departure + destroy: replacement train scenario", () => {
    const { legs } = makeLegs();
    // The extra departure starts at B. Journey from B→C = 3h + 10min dwell at B.
    // So max journey from B = 10*60 + 3*3600 = 11400s.
    // At worldTime 5000 + 12000 = 17000, the extra train would have completed.
    const events = [
      {
        id: "ex1",
        type: "extraDeparture",
        target: { routeId: "r1", stationName: "B" },
        startTime: 5000,
        endTime: null,
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

// ============================================================================
// Path Direction — reversePath, applyDirection
// ============================================================================

describe("reversePath", () => {
  it("reverses station order and shifts hoursFromPrev correctly", () => {
    const path = [
      { station: "A", x: 0, y: 0, hoursFromPrev: 0, dwellMinutes: 10 },
      { station: "B", x: 100, y: 0, hoursFromPrev: 2, dwellMinutes: 5 },
      { station: "C", x: 200, y: 0, hoursFromPrev: 3, dwellMinutes: 10 },
    ];
    const rev = reversePath(path);

    assert.equal(rev.length, 3);
    assert.equal(rev[0].station, "C");
    assert.equal(rev[1].station, "B");
    assert.equal(rev[2].station, "A");

    // First station in reversed path has hoursFromPrev = 0
    assert.equal(rev[0].hoursFromPrev, 0);
    // C→B travel time = original C.hoursFromPrev = 3
    assert.equal(rev[1].hoursFromPrev, 3);
    // B→A travel time = original B.hoursFromPrev = 2
    assert.equal(rev[2].hoursFromPrev, 2);

    // Dwell times stay on their stations
    assert.equal(rev[0].dwellMinutes, 10); // C's dwell
    assert.equal(rev[1].dwellMinutes, 5); // B's dwell
    assert.equal(rev[2].dwellMinutes, 10); // A's dwell
  });

  it("preserves waypoints in reversed order", () => {
    const path = [
      { station: "A", x: 0, y: 0, hoursFromPrev: 0 },
      { x: 50, y: 25 }, // waypoint
      { station: "B", x: 100, y: 0, hoursFromPrev: 2 },
    ];
    const rev = reversePath(path);

    assert.equal(rev.length, 3);
    assert.equal(rev[0].station, "B");
    assert.equal(rev[1].x, 50);
    assert.equal(rev[1].y, 25);
    assert.equal("station" in rev[1], false);
    assert.equal(rev[2].station, "A");
  });

  it("does not mutate the original path", () => {
    const path = [
      { station: "A", x: 0, y: 0, hoursFromPrev: 0 },
      { station: "B", x: 100, y: 0, hoursFromPrev: 2 },
    ];
    reversePath(path);
    assert.equal(path[0].station, "A");
    assert.equal(path[1].hoursFromPrev, 2);
  });
});

describe("applyDirection", () => {
  const path = [
    { station: "A", x: 0, y: 0, hoursFromPrev: 0, dwellMinutes: 10 },
    { station: "B", x: 100, y: 0, hoursFromPrev: 2, dwellMinutes: 5 },
    { station: "C", x: 200, y: 0, hoursFromPrev: 3, dwellMinutes: 10 },
  ];

  it("outbound returns path unchanged", () => {
    const result = applyDirection(path, "outbound");
    assert.equal(result, path); // same reference
  });

  it("return reverses the path", () => {
    const result = applyDirection(path, "return");
    assert.equal(result[0].station, "C");
    assert.equal(result[2].station, "A");
  });

  it("roundtrip concatenates outbound and reversed, deduping turnaround", () => {
    const result = applyDirection(path, "roundtrip");
    // A, B, C (outbound) + B, A (return, first station C dropped)
    const stations = result.filter((n) => "station" in n);
    assert.equal(stations.length, 5);
    assert.equal(stations[0].station, "A");
    assert.equal(stations[1].station, "B");
    assert.equal(stations[2].station, "C");
    assert.equal(stations[3].station, "B");
    assert.equal(stations[4].station, "A");
  });

  it("roundtrip journey has correct total time", () => {
    const result = applyDirection(path, "roundtrip");
    const { totalJourneySeconds } = buildRouteSegments(result);
    // Outbound: A(dwell 600s) → B(travel 7200s, dwell 300s) → C(travel 10800s) = 18900s
    // Return part: C's dwell is from outbound last station (10min=600s),
    //   then B(travel 10800s, dwell 300s) → A(travel 7200s) = 18300s + 600s = 18900s
    // But turnaround: C is shared, so total = outbound + C_dwell + return_travel
    // Actually let's just verify it's roughly double
    const outbound = buildRouteSegments(path).totalJourneySeconds;
    // Roundtrip includes C's dwell (turnaround) which outbound doesn't
    assert.ok(totalJourneySeconds > outbound);
    assert.ok(totalJourneySeconds <= outbound * 2 + 600); // at most double + C dwell
  });

  it("default/null direction returns path unchanged", () => {
    assert.equal(applyDirection(path, null), path);
    assert.equal(applyDirection(path, undefined), path);
  });
});

// ============================================================================
// Cron Parser — parseCronField, parseCronExpression, describeCronExpression
// ============================================================================

describe("parseCronField", () => {
  it("* matches everything", () => {
    const f = parseCronField("*");
    assert.equal(f.match(0), true);
    assert.equal(f.match(59), true);
    assert.equal(f.match(999), true);
  });

  it("bare number matches exactly", () => {
    const f = parseCronField("5");
    assert.equal(f.match(5), true);
    assert.equal(f.match(4), false);
    assert.equal(f.match(6), false);
  });

  it("bare number with implicitStep repeats", () => {
    const f = parseCronField("6", { implicitStep: 24 });
    assert.equal(f.match(6), true);
    assert.equal(f.match(30), true); // 6 + 24
    assert.equal(f.match(54), true); // 6 + 48
    assert.equal(f.match(7), false);
    assert.equal(f.match(5), false);
  });

  it("comma-separated values", () => {
    const f = parseCronField("1,3,5");
    assert.equal(f.match(1), true);
    assert.equal(f.match(3), true);
    assert.equal(f.match(5), true);
    assert.equal(f.match(2), false);
    assert.equal(f.match(4), false);
  });

  it("range N-N", () => {
    const f = parseCronField("1-5");
    assert.equal(f.match(0), false);
    assert.equal(f.match(1), true);
    assert.equal(f.match(3), true);
    assert.equal(f.match(5), true);
    assert.equal(f.match(6), false);
  });

  it("range with step N-N/S", () => {
    const f = parseCronField("0-10/3");
    assert.equal(f.match(0), true);
    assert.equal(f.match(3), true);
    assert.equal(f.match(6), true);
    assert.equal(f.match(9), true);
    assert.equal(f.match(1), false);
    assert.equal(f.match(12), false); // outside range
  });

  it("step from wildcard */S", () => {
    const f = parseCronField("*/15");
    assert.equal(f.match(0), true);
    assert.equal(f.match(15), true);
    assert.equal(f.match(30), true);
    assert.equal(f.match(45), true);
    assert.equal(f.match(7), false);
  });

  it("step N/S", () => {
    const f = parseCronField("6/48");
    assert.equal(f.match(6), true);
    assert.equal(f.match(54), true); // 6 + 48
    assert.equal(f.match(102), true); // 6 + 96
    assert.equal(f.match(0), false);
    assert.equal(f.match(48), false); // 48 != 6 mod 48
  });
});

describe("parseCronExpression", () => {
  it("parses 2-field non-Calendaria expression", () => {
    const parsed = parseCronExpression("0 6");
    assert.equal(parsed.minute.match(0), true);
    assert.equal(parsed.minute.match(1), false);
    assert.equal(parsed.hour.match(6), true);
    assert.equal(parsed.hour.match(30), true); // 6 + 24 (implicitStep)
    assert.equal(parsed.offset, 0);
  });

  it("parses 3-field non-Calendaria expression with offset", () => {
    const parsed = parseCronExpression("0 6/48 24");
    assert.equal(parsed.hour.match(6), true);
    assert.equal(parsed.hour.match(54), true);
    assert.equal(parsed.offset, 24);
  });

  it("parses 5-field Calendaria expression", () => {
    const parsed = parseCronExpression("0 6 * * 1,3", true);
    assert.equal(parsed.minute.match(0), true);
    assert.equal(parsed.hour.match(6), true);
    assert.equal(parsed.hour.match(30), false); // no implicitStep in Calendaria mode
    assert.equal(parsed.dayOfMonth.match(15), true); // * matches all
    assert.equal(parsed.month.match(6), true);
    assert.equal(parsed.dayOfWeek.match(1), true);
    assert.equal(parsed.dayOfWeek.match(3), true);
    assert.equal(parsed.dayOfWeek.match(2), false);
  });
});

describe("describeCronExpression", () => {
  it("daily at fixed time", () => {
    assert.equal(describeCronExpression("0 6"), "Daily at 06:00");
  });

  it("multiple hours", () => {
    assert.equal(describeCronExpression("0 6,18"), "At 06:00 and 18:00");
  });

  it("every N days", () => {
    assert.equal(describeCronExpression("0 12/48"), "At 12:00 every 2 days");
  });

  it("with offset", () => {
    assert.equal(describeCronExpression("0 6/48 24"), "At 06:00 every 2 days (offset 24h)");
  });

  it("every N hours", () => {
    assert.equal(describeCronExpression("0 */12"), "At :00 every 12 hours");
  });

  it("Calendaria with weekday names", () => {
    const info = { weekdayNames: ["Sul", "Mol", "Zol", "Wir", "Zor", "Far", "Sar"] };
    const desc = describeCronExpression("0 6 * * 1,3", true, info);
    assert.ok(desc.includes("Mol"));
    assert.ok(desc.includes("Wir"));
  });

  it("Calendaria without names uses numbers", () => {
    const desc = describeCronExpression("0 6 * * 1,3", true);
    assert.ok(desc.includes("1"));
    assert.ok(desc.includes("3"));
  });
});

// ============================================================================
// Schedule Normalization — normalizeSchedule
// ============================================================================

describe("normalizeSchedule", () => {
  it("converts old daily format to cron entries", () => {
    const route = {
      id: "test",
      segments: [{ segmentId: "a-b" }],
      schedule: { intervalDays: 1, startDayOffset: 0, departureHours: [6, 18] },
      routeNumbers: ["101", "102"],
    };
    const norm = normalizeSchedule(route);

    assert.ok(Array.isArray(norm.schedule));
    assert.equal(norm.schedule.length, 2);

    assert.equal(norm.schedule[0].cron, "0 6");
    assert.deepEqual(norm.schedule[0].routeNumbers, ["101"]);
    assert.equal(norm.schedule[0].direction, "outbound");
    assert.deepEqual(norm.schedule[0].segments, [{ segmentId: "a-b" }]);

    assert.equal(norm.schedule[1].cron, "0 18");
    assert.deepEqual(norm.schedule[1].routeNumbers, ["102"]);
  });

  it("converts multi-day interval with offset", () => {
    const route = {
      id: "test",
      segments: [{ segmentId: "a-b" }],
      schedule: { intervalDays: 2, startDayOffset: 1, departureHours: [6] },
      routeNumbers: ["101"],
    };
    const norm = normalizeSchedule(route);

    assert.equal(norm.schedule.length, 1);
    assert.equal(norm.schedule[0].cron, "0 6/48 24");
  });

  it("passes through already-normalized routes", () => {
    const route = {
      id: "test",
      schedule: [{ cron: "0 6", routeNumbers: ["101"], direction: "outbound", segments: [] }],
    };
    const norm = normalizeSchedule(route);
    assert.equal(norm, route); // same reference
  });

  it("handles missing fields gracefully", () => {
    const route = { id: "test" };
    const norm = normalizeSchedule(route);
    assert.ok(Array.isArray(norm.schedule));
    assert.equal(norm.schedule.length, 1);
    assert.equal(norm.schedule[0].direction, "outbound");
  });

  it("removes top-level segments and routeNumbers", () => {
    const route = {
      id: "test",
      segments: [{ segmentId: "a-b" }],
      routeNumbers: ["101"],
      schedule: { intervalDays: 1, startDayOffset: 0, departureHours: [6] },
    };
    const norm = normalizeSchedule(route);
    assert.equal(norm.segments, undefined);
    assert.equal(norm.routeNumbers, undefined);
    assert.equal(norm.id, "test");
  });
});

// ============================================================================
// computeDesiredTokens — delayed flag
// ============================================================================

describe("computeDesiredTokens", () => {
  // Simple two-station route for testing
  const makeRoute = () => ({
    id: "test-route",
    schedule: [
      {
        cron: "0 6",
        routeNumbers: ["101"],
        direction: "outbound",
        segments: [
          {
            segmentId: "seg1",
            path: [
              { station: "A", x: 0, y: 0, hoursFromPrev: 0, dwellMinutes: 0 },
              { station: "B", x: 100, y: 0, hoursFromPrev: 2, dwellMinutes: 0 },
            ],
          },
        ],
      },
    ],
  });

  // worldTime at 7:00 on day 0 — 1 hour into the 2-hour journey departing at 6:00
  const worldTime = 7 * SECONDS_PER_HOUR;

  it("returns delayed: false when no delay event", () => {
    const results = computeDesiredTokens(makeRoute(), worldTime, []);
    assert.equal(results.length, 1);
    assert.equal(results[0].delayed, false);
    assert.equal(results[0].routeNum, "101");
  });

  it("returns delayed: true when delay event targets the departure", () => {
    const depTime = 6 * SECONDS_PER_HOUR; // 06:00
    const events = [
      {
        id: "evt1",
        type: "delay",
        target: { routeId: "test-route", departureTime: depTime },
        startTime: 0,
        endTime: null,
        delayHours: 0.5,
      },
    ];
    const results = computeDesiredTokens(makeRoute(), worldTime, events);
    assert.equal(results.length, 1);
    assert.equal(results[0].delayed, true);
  });

  it("returns delayed: false when delay event targets a different departure", () => {
    const events = [
      {
        id: "evt1",
        type: "delay",
        target: { routeId: "test-route", departureTime: 99999 },
        startTime: 0,
        endTime: null,
        delayHours: 0.5,
      },
    ];
    const results = computeDesiredTokens(makeRoute(), worldTime, events);
    assert.equal(results.length, 1);
    assert.equal(results[0].delayed, false);
  });

  it("does not include texture/width/height in results", () => {
    const results = computeDesiredTokens(makeRoute(), worldTime, []);
    assert.equal(results.length, 1);
    assert.equal(results[0].texture, undefined);
    assert.equal(results[0].width, undefined);
    assert.equal(results[0].height, undefined);
  });
});
