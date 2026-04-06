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
  convertSpeedToPixelsPerHour,
  pixelDistanceToWorldDistance,
  mulberry32,
  hashSeed,
  weightedChoice,
  buildNetworkGraph,
  aStar,
  buildPathFromEdges,
  computeWanderingWalk,
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

// ============================================================================
// convertSpeedToPixelsPerHour
// ============================================================================

describe("convertSpeedToPixelsPerHour", () => {
  it("converts mph with mi grid (direct)", () => {
    // 30 mph, 100px grid, 46 mi per square → 30 * (100/46) ≈ 65.217
    const result = convertSpeedToPixelsPerHour(30, "mph", 100, 46, "mi");
    assert.ok(Math.abs(result - 30 * (100 / 46)) < 0.01);
  });

  it("converts mph with km grid (cross-unit)", () => {
    // 30 mph = 30 mi/h. 1 mi = 1.60934 km → 48.28 km/h
    // 100px grid, 50 km per square → 48.28 * (100/50) ≈ 96.56
    const result = convertSpeedToPixelsPerHour(30, "mph", 100, 50, "km");
    const expectedKmPerHour = 30 * 1.60934;
    const expectedPxPerHour = expectedKmPerHour * (100 / 50);
    assert.ok(Math.abs(result - expectedPxPerHour) < 0.01);
  });

  it("converts km/h with km grid (direct)", () => {
    const result = convertSpeedToPixelsPerHour(50, "km/h", 100, 25, "km");
    assert.ok(Math.abs(result - 50 * (100 / 25)) < 0.01);
  });

  it("converts km/h with mi grid (cross-unit)", () => {
    // 50 km/h. 1 km = 1/1.60934 mi → 31.069 mi/h
    // 100px grid, 46 mi → 31.069 * (100/46) ≈ 67.54
    const result = convertSpeedToPixelsPerHour(50, "km/h", 100, 46, "mi");
    const expectedMiPerHour = 50 / 1.60934;
    const expectedPxPerHour = expectedMiPerHour * (100 / 46);
    assert.ok(Math.abs(result - expectedPxPerHour) < 0.01);
  });

  it("handles flexible unit strings (case-insensitive)", () => {
    const base = convertSpeedToPixelsPerHour(30, "mph", 100, 46, "mi");
    for (const units of ["MPH", "miles per hour", "mi/hr", "Miles/Hour", "mi/h"]) {
      const result = convertSpeedToPixelsPerHour(30, units, 100, 46, "mi");
      assert.ok(Math.abs(result - base) < 0.001, `failed for "${units}"`);
    }
  });

  it("handles kph variants", () => {
    const base = convertSpeedToPixelsPerHour(50, "km/h", 100, 25, "km");
    for (const units of ["kph", "KPH", "kmh", "kmph", "Km/H", "kilometers per hour", "kilometres per hour"]) {
      const result = convertSpeedToPixelsPerHour(50, units, 100, 25, "km");
      assert.ok(Math.abs(result - base) < 0.001, `failed for "${units}"`);
    }
  });

  it("handles ft/s speed units", () => {
    // 10 ft/s = 36000 ft/h = 36000/5280 mi/h ≈ 6.818 mi/h
    // 100px grid, 1 mi → 6.818 * 100 ≈ 681.8
    const result = convertSpeedToPixelsPerHour(10, "ft/s", 100, 1, "mi");
    const expected = ((10 * 3600) / 5280) * 100;
    assert.ok(Math.abs(result - expected) < 0.1);
  });

  it("handles m/s speed units", () => {
    // 10 m/s = 36000 m/h = 36 km/h, 100px grid, 10 km → 36 * (100/10) = 360
    const result = convertSpeedToPixelsPerHour(10, "m/s", 100, 10, "km");
    const expected = ((10 * 3600) / 1000) * (100 / 10);
    assert.ok(Math.abs(result - expected) < 0.1);
  });

  it("handles grid units with various spellings", () => {
    const base = convertSpeedToPixelsPerHour(30, "mph", 100, 46, "mi");
    for (const gridUnit of ["mile", "miles"]) {
      const result = convertSpeedToPixelsPerHour(30, "mph", 100, 46, gridUnit);
      assert.ok(Math.abs(result - base) < 0.001, `failed for grid unit "${gridUnit}"`);
    }
  });

  it("returns null for zero speed", () => {
    assert.equal(convertSpeedToPixelsPerHour(0, "mph", 100, 46, "mi"), null);
  });

  it("returns null for zero grid distance", () => {
    assert.equal(convertSpeedToPixelsPerHour(30, "mph", 100, 0, "mi"), null);
  });

  it("returns null for unrecognized speed units", () => {
    assert.equal(convertSpeedToPixelsPerHour(30, "furlongs/fortnight", 100, 46, "mi"), null);
  });

  it("returns null for unrecognized grid units", () => {
    assert.equal(convertSpeedToPixelsPerHour(30, "mph", 100, 46, "leagues"), null);
  });

  it("returns null for negative speed", () => {
    assert.equal(convertSpeedToPixelsPerHour(-10, "mph", 100, 46, "mi"), null);
  });
});

// ============================================================================
// pixelDistanceToWorldDistance
// ============================================================================

describe("pixelDistanceToWorldDistance", () => {
  it("converts pixel distance to world distance", () => {
    // 200px, 100px grid, 46 mi per square → 92 mi
    assert.equal(pixelDistanceToWorldDistance(200, 100, 46), 92);
  });

  it("returns 0 for zero grid size", () => {
    assert.equal(pixelDistanceToWorldDistance(200, 0, 46), 0);
  });

  it("handles fractional results", () => {
    // 50px, 100px grid, 46 mi → 23 mi
    assert.equal(pixelDistanceToWorldDistance(50, 100, 46), 23);
  });
});

// ============================================================================
// buildRouteSegments — actor speed mode (pixelsPerHour)
// ============================================================================

describe("buildRouteSegments with pixelsPerHour", () => {
  it("derives travel time from pixel distance when pixelsPerHour is provided", () => {
    const path = [
      { station: "A", x: 0, y: 0, dwellMinutes: 0 },
      { station: "B", x: 300, y: 400, dwellMinutes: 5 }, // 500px away, no hoursFromPrev
    ];
    // 500px at 100 px/hr → 5 hours = 18000 seconds
    const result = buildRouteSegments(path, 100);
    assert.equal(result.legs.length, 1);
    assert.equal(result.legs[0].travelSeconds, 5 * SECONDS_PER_HOUR);
  });

  it("ignores hoursFromPrev when pixelsPerHour is provided", () => {
    const path = [
      { station: "A", x: 0, y: 0, dwellMinutes: 0 },
      { station: "B", x: 300, y: 400, hoursFromPrev: 99, dwellMinutes: 0 },
    ];
    // pixelsPerHour mode: hoursFromPrev=99 is ignored, uses 500px / 100 px/hr = 5h
    const result = buildRouteSegments(path, 100);
    assert.equal(result.legs[0].travelSeconds, 5 * SECONDS_PER_HOUR);
  });

  it("uses hoursFromPrev when pixelsPerHour is null (manual mode)", () => {
    const path = [
      { station: "A", x: 0, y: 0, dwellMinutes: 0 },
      { station: "B", x: 300, y: 400, hoursFromPrev: 2, dwellMinutes: 0 },
    ];
    const result = buildRouteSegments(path, null);
    assert.equal(result.legs[0].travelSeconds, 2 * SECONDS_PER_HOUR);
  });

  it("accounts for waypoints in pixel distance calculation", () => {
    const path = [
      { station: "A", x: 0, y: 0, dwellMinutes: 0 },
      { x: 100, y: 0 }, // waypoint
      { x: 100, y: 100 }, // waypoint
      { station: "B", x: 100, y: 100, dwellMinutes: 0 }, // at same pos as last waypoint
    ];
    // Distance: 0→(100,0)=100, (100,0)→(100,100)=100, (100,100)→(100,100)=0 → total 200px
    const result = buildRouteSegments(path, 50);
    assert.equal(result.legs[0].travelSeconds, (200 / 50) * SECONDS_PER_HOUR);
  });

  it("handles multi-leg paths in actor speed mode", () => {
    const path = [
      { station: "A", x: 0, y: 0, dwellMinutes: 0 },
      { station: "B", x: 300, y: 400, dwellMinutes: 5 }, // 500px
      { station: "C", x: 300, y: 700, dwellMinutes: 0 }, // 300px from B
    ];
    const result = buildRouteSegments(path, 100);
    assert.equal(result.legs[0].travelSeconds, 5 * SECONDS_PER_HOUR); // 500/100
    assert.equal(result.legs[1].travelSeconds, 3 * SECONDS_PER_HOUR); // 300/100
    assert.equal(
      result.totalJourneySeconds,
      5 * SECONDS_PER_HOUR + 5 * 60 + 3 * SECONDS_PER_HOUR, // travel + dwell at B + travel
    );
  });
});

// ============================================================================
// Wandering Routes — PRNG utilities
// ============================================================================

describe("mulberry32", () => {
  it("same seed produces same sequence", () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(42);
    for (let i = 0; i < 10; i++) {
      assert.equal(rng1(), rng2());
    }
  });

  it("different seeds produce different sequences", () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(99);
    const vals1 = Array.from({ length: 5 }, () => rng1());
    const vals2 = Array.from({ length: 5 }, () => rng2());
    assert.notDeepEqual(vals1, vals2);
  });

  it("output is in [0, 1)", () => {
    const rng = mulberry32(12345);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      assert.ok(v >= 0 && v < 1, `value ${v} out of range`);
    }
  });
});

describe("hashSeed", () => {
  it("same inputs produce same seed", () => {
    assert.equal(hashSeed(1000, "route-a"), hashSeed(1000, "route-a"));
  });

  it("different departure times produce different seeds", () => {
    assert.notEqual(hashSeed(1000, "route-a"), hashSeed(2000, "route-a"));
  });

  it("different route IDs produce different seeds", () => {
    assert.notEqual(hashSeed(1000, "route-a"), hashSeed(1000, "route-b"));
  });
});

describe("weightedChoice", () => {
  it("single eligible option always chosen", () => {
    const rng = mulberry32(1);
    const weights = { A: 5 };
    for (let i = 0; i < 10; i++) {
      assert.equal(weightedChoice(["A", "B", "C"], weights, rng), "A");
    }
  });

  it("unlisted options are never chosen", () => {
    const rng = mulberry32(42);
    const weights = { B: 1, C: 1 };
    for (let i = 0; i < 50; i++) {
      const choice = weightedChoice(["A", "B", "C"], weights, rng);
      assert.notEqual(choice, "A");
    }
  });

  it("extreme weights heavily bias selection", () => {
    const rng = mulberry32(7);
    const weights = { A: 1000, B: 1 };
    let aCount = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      if (weightedChoice(["A", "B"], weights, rng) === "A") aCount++;
    }
    assert.ok(aCount > N * 0.9, `expected >90% A but got ${aCount}/${N}`);
  });

  it("deterministic with same rng state", () => {
    const rng1 = mulberry32(55);
    const rng2 = mulberry32(55);
    const weights = { A: 1, B: 2, C: 3 };
    const options = ["A", "B", "C"];
    for (let i = 0; i < 20; i++) {
      assert.equal(weightedChoice(options, weights, rng1), weightedChoice(options, weights, rng2));
    }
  });

  it("returns null when no options are eligible", () => {
    const rng = mulberry32(1);
    const result = weightedChoice(["A", "B"], {}, rng);
    assert.equal(result, null);
  });
});

// ============================================================================
// Wandering Routes — Network graph
// ============================================================================

// Shared test fixtures for wandering route tests
//
//   Y-shaped network:
//        C(300,0)
//       /
//  A(0,0)--B(100,0)
//       \
//        D(300,200)
//
const wanderSegments = {
  "a-b": [
    { station: "A", x: 0, y: 0, dwellMinutes: 0 },
    { station: "B", x: 100, y: 0, hoursFromPrev: 1, dwellMinutes: 5 },
  ],
  "b-c": [
    { station: "B", x: 100, y: 0, dwellMinutes: 5 },
    { x: 150, y: -50 }, // waypoint
    { station: "C", x: 300, y: 0, hoursFromPrev: 2, dwellMinutes: 5 },
  ],
  "b-d": [
    { station: "B", x: 100, y: 0, dwellMinutes: 5 },
    { station: "D", x: 300, y: 200, hoursFromPrev: 3, dwellMinutes: 5 },
  ],
};

const wanderPathResolver = (segmentId) => wanderSegments[segmentId] ?? null;

describe("buildNetworkGraph", () => {
  it("creates bidirectional edges between consecutive stations", () => {
    const graph = buildNetworkGraph(["a-b"], wanderPathResolver);
    const adjA = graph.adjacency.get("A");
    const adjB = graph.adjacency.get("B");
    assert.ok(adjA, "A should be in adjacency");
    assert.ok(adjB, "B should be in adjacency");
    assert.equal(adjA.length, 1);
    assert.equal(adjA[0].targetStation, "B");
    assert.equal(adjB.length, 1);
    assert.equal(adjB[0].targetStation, "A");
  });

  it("stores edge cost from hoursFromPrev", () => {
    const graph = buildNetworkGraph(["a-b"], wanderPathResolver);
    const edgeAB = graph.adjacency.get("A").find((e) => e.targetStation === "B");
    assert.equal(edgeAB.cost, 1);
    const edgeBA = graph.adjacency.get("B").find((e) => e.targetStation === "A");
    assert.equal(edgeBA.cost, 1); // same cost both directions
  });

  it("stores fromIndex and toIndex for sub-path extraction", () => {
    const graph = buildNetworkGraph(["b-c"], wanderPathResolver);
    const edgeBC = graph.adjacency.get("B").find((e) => e.targetStation === "C");
    assert.equal(edgeBC.fromIndex, 0);
    assert.equal(edgeBC.toIndex, 2); // B(0), waypoint(1), C(2)
  });

  it("merges edges from multiple segments at shared station", () => {
    const graph = buildNetworkGraph(["a-b", "b-c", "b-d"], wanderPathResolver);
    const adjB = graph.adjacency.get("B");
    // B connects to A (from a-b), C (from b-c), D (from b-d)
    const targets = adjB.map((e) => e.targetStation).sort();
    assert.deepEqual(targets, ["A", "C", "D"]);
  });

  it("handles T-junction where segment endpoint meets mid-waypoint", () => {
    // Segment "long" has A--waypoint--C with no station at waypoint
    // Segment "branch" has endpoint near the waypoint
    const paths = {
      long: [
        { station: "A", x: 0, y: 0, dwellMinutes: 0 },
        { x: 100, y: 0 }, // waypoint at (100,0)
        { station: "C", x: 200, y: 0, hoursFromPrev: 2, dwellMinutes: 5 },
      ],
      branch: [
        { station: "E", x: 100, y: 100, dwellMinutes: 0 },
        { station: "F", x: 100, y: 1, hoursFromPrev: 1, dwellMinutes: 5 }, // F near waypoint at (100,0)
      ],
    };
    const resolver = (id) => paths[id];
    const graph = buildNetworkGraph(["long", "branch"], resolver);
    // F should connect to the graph via a synthetic junction near (100,0)
    // The junction splits "long" into A→junction and junction→C
    // F connects to the junction
    const junctionEdges = [...graph.adjacency.entries()].find(([name]) => name.startsWith("_junction"));
    assert.ok(junctionEdges, "should create a synthetic junction node");
    const [, junctionAdj] = junctionEdges;
    const jTargets = junctionAdj.map((e) => e.targetStation).sort();
    // Junction should connect to A, C (from split long), and F (from branch endpoint)
    assert.ok(jTargets.includes("A"), "junction connects to A");
    assert.ok(jTargets.includes("C"), "junction connects to C");
    assert.ok(jTargets.includes("F"), "junction connects to F");
  });

  it("skips segments with no stations", () => {
    const paths = {
      empty: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
    };
    const resolver = (id) => paths[id];
    const graph = buildNetworkGraph(["empty"], resolver);
    assert.equal(graph.adjacency.size, 0);
  });

  it("skips null/unresolvable segments", () => {
    const resolver = () => null;
    const graph = buildNetworkGraph(["missing"], resolver);
    assert.equal(graph.adjacency.size, 0);
  });
});

// ============================================================================
// Wandering Routes — A* pathfinding
// ============================================================================

describe("aStar", () => {
  it("finds direct connection between adjacent stations", () => {
    const graph = buildNetworkGraph(["a-b"], wanderPathResolver);
    const result = aStar(graph.adjacency, "A", "B");
    assert.ok(result, "should find a path");
    assert.equal(result.length, 1);
    assert.equal(result[0].segmentId, "a-b");
  });

  it("finds multi-hop path through intermediate stations", () => {
    const graph = buildNetworkGraph(["a-b", "b-c"], wanderPathResolver);
    const result = aStar(graph.adjacency, "A", "C");
    assert.ok(result, "should find a path");
    assert.equal(result.length, 2);
    assert.equal(result[0].segmentId, "a-b");
    assert.equal(result[1].segmentId, "b-c");
  });

  it("returns null for unreachable station", () => {
    // Disconnected graph: a-b and separate e-f
    const paths = {
      "a-b": wanderSegments["a-b"],
      "e-f": [
        { station: "E", x: 500, y: 500, dwellMinutes: 0 },
        { station: "F", x: 600, y: 500, hoursFromPrev: 1, dwellMinutes: 5 },
      ],
    };
    const resolver = (id) => paths[id];
    const graph = buildNetworkGraph(["a-b", "e-f"], resolver);
    const result = aStar(graph.adjacency, "A", "F");
    assert.equal(result, null);
  });

  it("chooses shortest of multiple paths", () => {
    // A--B--C with shortcut A--C (cost 1 vs cost 3 via B)
    const paths = {
      "a-b": [
        { station: "A", x: 0, y: 0, dwellMinutes: 0 },
        { station: "B", x: 100, y: 0, hoursFromPrev: 1, dwellMinutes: 0 },
      ],
      "b-c": [
        { station: "B", x: 100, y: 0, dwellMinutes: 0 },
        { station: "C", x: 200, y: 0, hoursFromPrev: 2, dwellMinutes: 0 },
      ],
      "a-c": [
        { station: "A", x: 0, y: 0, dwellMinutes: 0 },
        { station: "C", x: 200, y: 0, hoursFromPrev: 1, dwellMinutes: 0 },
      ],
    };
    const resolver = (id) => paths[id];
    const graph = buildNetworkGraph(["a-b", "b-c", "a-c"], resolver);
    const result = aStar(graph.adjacency, "A", "C");
    assert.ok(result);
    // Should pick the direct a-c route (cost 1) over a-b + b-c (cost 3)
    assert.equal(result.length, 1);
    assert.equal(result[0].segmentId, "a-c");
  });

  it("includes fromIndex/toIndex for sub-path extraction", () => {
    const graph = buildNetworkGraph(["b-c"], wanderPathResolver);
    const result = aStar(graph.adjacency, "B", "C");
    assert.ok(result);
    assert.equal(result[0].fromIndex, 0);
    assert.equal(result[0].toIndex, 2);
  });

  it("handles reverse traversal", () => {
    const graph = buildNetworkGraph(["a-b"], wanderPathResolver);
    const result = aStar(graph.adjacency, "B", "A");
    assert.ok(result);
    assert.equal(result[0].fromIndex, 1); // start at B (index 1)
    assert.equal(result[0].toIndex, 0); // end at A (index 0)
  });
});

// ============================================================================
// Wandering Routes — buildPathFromEdges
// ============================================================================

describe("buildPathFromEdges", () => {
  it("builds path from a single forward edge", () => {
    const graph = buildNetworkGraph(["a-b"], wanderPathResolver);
    const edges = [{ segmentId: "a-b", fromIndex: 0, toIndex: 1 }];
    const path = buildPathFromEdges(edges, graph.paths);
    assert.equal(path.length, 2);
    assert.equal(path[0].station, "A");
    assert.equal(path[1].station, "B");
  });

  it("builds path from a single reversed edge", () => {
    const graph = buildNetworkGraph(["a-b"], wanderPathResolver);
    const edges = [{ segmentId: "a-b", fromIndex: 1, toIndex: 0 }];
    const path = buildPathFromEdges(edges, graph.paths);
    assert.equal(path.length, 2);
    assert.equal(path[0].station, "B");
    assert.equal(path[1].station, "A");
  });

  it("includes waypoints in multi-point edge", () => {
    const graph = buildNetworkGraph(["b-c"], wanderPathResolver);
    const edges = [{ segmentId: "b-c", fromIndex: 0, toIndex: 2 }];
    const path = buildPathFromEdges(edges, graph.paths);
    assert.equal(path.length, 3); // B, waypoint, C
    assert.equal(path[0].station, "B");
    assert.ok(!("station" in path[1])); // waypoint
    assert.equal(path[2].station, "C");
  });

  it("chains multiple edges and drops duplicate junction", () => {
    const graph = buildNetworkGraph(["a-b", "b-c"], wanderPathResolver);
    const edges = [
      { segmentId: "a-b", fromIndex: 0, toIndex: 1 },
      { segmentId: "b-c", fromIndex: 0, toIndex: 2 },
    ];
    const path = buildPathFromEdges(edges, graph.paths);
    // A, B (junction — appears once, not twice), waypoint, C
    const stationNames = path.filter((n) => "station" in n).map((n) => n.station);
    assert.deepEqual(stationNames, ["A", "B", "C"]);
  });

  it("applies max-dwell rule at junctions", () => {
    // B has dwellMinutes 5 in a-b, and dwellMinutes 5 in b-c
    const graph = buildNetworkGraph(["a-b", "b-c"], wanderPathResolver);
    const edges = [
      { segmentId: "a-b", fromIndex: 0, toIndex: 1 },
      { segmentId: "b-c", fromIndex: 0, toIndex: 2 },
    ];
    const path = buildPathFromEdges(edges, graph.paths);
    const bNode = path.find((n) => n.station === "B");
    assert.equal(bNode.dwellMinutes, 5);
  });

  it("zeros first station dwellMinutes", () => {
    const graph = buildNetworkGraph(["a-b"], wanderPathResolver);
    const edges = [{ segmentId: "a-b", fromIndex: 0, toIndex: 1 }];
    const path = buildPathFromEdges(edges, graph.paths);
    assert.equal(path[0].dwellMinutes, 0);
  });
});

// ============================================================================
// Wandering Routes — computeWanderingWalk
// ============================================================================

describe("computeWanderingWalk", () => {
  const baseNetwork = {
    startStation: "A",
    segments: ["a-b", "b-c", "b-d"],
    maxHours: 48,
    weights: { A: 1, B: 2, C: 1, D: 1 },
  };

  it("produces legs compatible with getTrainPosition", () => {
    const result = computeWanderingWalk(baseNetwork, 1000, "route1", wanderPathResolver);
    assert.ok(result.legs.length > 0, "should produce legs");
    assert.ok(result.totalJourneySeconds > 0, "should have journey time");
    // First leg should start at A
    assert.equal(result.legs[0].startStation.station, "A");
    // Should be usable by getTrainPosition
    const pos = getTrainPosition(result.legs, result.totalJourneySeconds, 1800);
    assert.ok(pos, "getTrainPosition should return a position");
    assert.ok(typeof pos.x === "number");
    assert.ok(typeof pos.y === "number");
  });

  it("is deterministic — same seed produces same walk", () => {
    const r1 = computeWanderingWalk(baseNetwork, 1000, "route1", wanderPathResolver);
    const r2 = computeWanderingWalk(baseNetwork, 1000, "route1", wanderPathResolver);
    assert.equal(r1.legs.length, r2.legs.length);
    assert.equal(r1.totalJourneySeconds, r2.totalJourneySeconds);
    for (let i = 0; i < r1.legs.length; i++) {
      assert.equal(r1.legs[i].startStation.station, r2.legs[i].startStation.station);
      assert.equal(r1.legs[i].endStation.station, r2.legs[i].endStation.station);
    }
  });

  it("different seeds produce different walks", () => {
    const r1 = computeWanderingWalk(baseNetwork, 1000, "route1", wanderPathResolver);
    const r2 = computeWanderingWalk(baseNetwork, 2000, "route1", wanderPathResolver);
    // With different seeds, at least one station choice should differ
    const stations1 = r1.legs.map((l) => l.endStation.station).join(",");
    const stations2 = r2.legs.map((l) => l.endStation.station).join(",");
    // Not guaranteed to differ on every run, but overwhelmingly likely
    // with enough legs. Let's check they aren't all identical.
    assert.ok(r1.legs.length > 2, "should have enough legs to compare");
    // Soft check: if they're identical, try a third seed to confirm it's not a fluke
    if (stations1 === stations2) {
      const r3 = computeWanderingWalk(baseNetwork, 3000, "route1", wanderPathResolver);
      const stations3 = r3.legs.map((l) => l.endStation.station).join(",");
      assert.notEqual(stations1, stations3, "three identical walks is extremely unlikely");
    }
  });

  it("respects maxHours bound", () => {
    const shortNetwork = { ...baseNetwork, maxHours: 2 };
    const result = computeWanderingWalk(shortNetwork, 1000, "route1", wanderPathResolver);
    // Fewer legs than the uncapped version — first hop may overshoot maxHours
    // but subsequent hops are blocked. Total journey bounded by first hop + dwell.
    const uncapped = computeWanderingWalk(baseNetwork, 1000, "route1", wanderPathResolver);
    assert.ok(
      result.legs.length < uncapped.legs.length,
      `capped (${result.legs.length} legs) should have fewer legs than uncapped (${uncapped.legs.length})`,
    );
    assert.ok(
      result.totalJourneySeconds < uncapped.totalJourneySeconds,
      `capped journey (${result.totalJourneySeconds}s) should be shorter than uncapped (${uncapped.totalJourneySeconds}s)`,
    );
  });

  it("single segment network: train goes back and forth", () => {
    const singleNetwork = {
      startStation: "A",
      segments: ["a-b"],
      maxHours: 5,
      weights: { A: 1, B: 1 },
    };
    const result = computeWanderingWalk(singleNetwork, 42, "r", wanderPathResolver);
    assert.ok(result.legs.length >= 2, "should traverse at least twice");
    // Should alternate between A and B
    const starts = result.legs.map((l) => l.startStation.station);
    assert.equal(starts[0], "A");
    assert.equal(starts[1], "B");
  });

  it("terminates at dead end when no weighted destinations reachable", () => {
    // Only weight C, which is reachable from A via B
    // After arriving at C, no weighted destinations left (A and B not in weights)
    const deadEndNetwork = {
      startStation: "A",
      segments: ["a-b", "b-c"],
      maxHours: 48,
      weights: { C: 1 },
    };
    const result = computeWanderingWalk(deadEndNetwork, 1000, "route1", wanderPathResolver);
    // Should produce legs A→B→C then stop
    const endStations = result.legs.map((l) => l.endStation.station);
    assert.ok(endStations.includes("C"), "should reach C");
  });

  it("multi-hop: picks distant destination and routes through intermediates", () => {
    // Network: A--B--C, weights only A and C
    // From A, train picks C → routes through B to get there
    const linearNetwork = {
      startStation: "A",
      segments: ["a-b", "b-c"],
      maxHours: 48,
      weights: { A: 1, C: 1 },
    };
    const result = computeWanderingWalk(linearNetwork, 42, "route1", wanderPathResolver);
    // First walk segment should go A→B→C (multi-hop to reach C)
    assert.equal(result.legs[0].startStation.station, "A");
    // B should appear as an intermediate stop
    const allStations = result.legs.flatMap((l) => [l.startStation.station, l.endStation.station]);
    assert.ok(allStations.includes("B"), "B should be traversed as intermediate");
    assert.ok(allStations.includes("C"), "C should be reached");
  });
});

// ============================================================================
// Wandering Routes — computeDesiredTokens integration
// ============================================================================

describe("computeDesiredTokens with wandering routes", () => {
  const makeWanderRoute = () => ({
    id: "wander-test",
    type: "wander",
    network: {
      startStation: "A",
      segments: ["a-b", "b-c"],
      maxHours: 48,
      weights: { A: 1, B: 1, C: 1 },
    },
    schedule: [
      {
        cron: "0 6",
        routeNumbers: ["W1"],
      },
    ],
  });

  // Inline path resolver for wandering routes — resolves single segments
  const singleSegResolver = (segmentId) => {
    const paths = {
      "a-b": [
        { station: "A", x: 0, y: 0, dwellMinutes: 0 },
        { station: "B", x: 100, y: 0, hoursFromPrev: 1, dwellMinutes: 5 },
      ],
      "b-c": [
        { station: "B", x: 100, y: 0, dwellMinutes: 5 },
        { station: "C", x: 200, y: 0, hoursFromPrev: 2, dwellMinutes: 5 },
      ],
    };
    return paths[segmentId] ?? null;
  };

  // worldTime at 7:30 on day 0 — 1.5 hours into journey departing at 6:00
  const worldTime = 7.5 * SECONDS_PER_HOUR;

  it("produces tokens for wandering routes", () => {
    const results = computeDesiredTokens(makeWanderRoute(), worldTime, [], {
      singleSegmentResolver: singleSegResolver,
    });
    assert.ok(results.length > 0, "should produce at least one token");
    assert.equal(results[0].routeId, "wander-test");
    assert.ok(typeof results[0].x === "number");
    assert.ok(typeof results[0].y === "number");
  });

  it("closeLine event suppresses wandering departures", () => {
    const events = [
      {
        id: "close1",
        type: "closeLine",
        target: { routeId: "wander-test" },
        startTime: 0,
        endTime: null,
      },
    ];
    const results = computeDesiredTokens(makeWanderRoute(), worldTime, events, {
      singleSegmentResolver: singleSegResolver,
    });
    assert.equal(results.length, 0);
  });

  it("wandering tokens are deterministic across calls", () => {
    const opts = { singleSegmentResolver: singleSegResolver };
    const r1 = computeDesiredTokens(makeWanderRoute(), worldTime, [], opts);
    const r2 = computeDesiredTokens(makeWanderRoute(), worldTime, [], opts);
    assert.equal(r1.length, r2.length);
    for (let i = 0; i < r1.length; i++) {
      assert.equal(r1[i].x, r2[i].x);
      assert.equal(r1[i].y, r2[i].y);
      assert.equal(r1[i].atStation, r2[i].atStation);
    }
  });
});
