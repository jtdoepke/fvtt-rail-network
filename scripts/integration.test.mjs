import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ============================================================================
// Foundry VTT Mocks
// ============================================================================

// Minimal mock of a Foundry DrawingDocument
function makeDrawingDoc({ x, y, points, segmentId, stations }) {
  return {
    x,
    y,
    shape: { points },
    flags: {
      "rail-network": { segmentId, stations },
    },
  };
}

// ============================================================================
// Phase 1: Drawing-to-Path Conversion
// ============================================================================

// Import the function under test — it will be added to engine.mjs since it's
// a pure function that converts Drawing data to engine path format
const {
  drawingToPath,
  buildRouteSegments,
  findStationArrivalTime,
  applyEvents,
  computeEffectiveDelay,
  resolveRoutePath,
  findAllActiveDepartures,
  getActiveEvents,
  getTrainPosition,
  findExtraDepartures,
  computeDesiredTokens,
} = await import("./engine.mjs");

const SECONDS_PER_DAY = 86400;

const SECONDS_PER_HOUR = 3600;

describe("drawingToPath", () => {
  it("converts a Drawing with stations and waypoints into engine path format", () => {
    const doc = makeDrawingDoc({
      x: 1000,
      y: 2000,
      // 4 points: indices 0, 1, 2, 3
      points: [0, 0, 100, 50, 200, 100, 300, 0],
      segmentId: "sharn-wroat",
      stations: [
        { pointIndex: 0, name: "Sharn", dwellMinutes: 0 },
        { pointIndex: 3, name: "Wroat", hoursFromPrev: 6.8, dwellMinutes: 10 },
      ],
    });

    const path = drawingToPath(doc);

    assert.equal(path.length, 4);

    // Station at index 0
    assert.equal(path[0].station, "Sharn");
    assert.equal(path[0].x, 1000); // doc.x + 0
    assert.equal(path[0].y, 2000); // doc.y + 0
    assert.equal(path[0].dwellMinutes, 0);

    // Waypoints at indices 1 and 2
    assert.equal(path[1].x, 1100); // doc.x + 100
    assert.equal(path[1].y, 2050); // doc.y + 50
    assert.equal("station" in path[1], false);

    assert.equal(path[2].x, 1200);
    assert.equal(path[2].y, 2100);
    assert.equal("station" in path[2], false);

    // Station at index 3
    assert.equal(path[3].station, "Wroat");
    assert.equal(path[3].x, 1300); // doc.x + 300
    assert.equal(path[3].y, 2000); // doc.y + 0
    assert.equal(path[3].hoursFromPrev, 6.8);
    assert.equal(path[3].dwellMinutes, 10);
  });

  it("handles a Drawing with only stations (no waypoints)", () => {
    const doc = makeDrawingDoc({
      x: 0,
      y: 0,
      points: [0, 0, 500, 500],
      segmentId: "a-b",
      stations: [
        { pointIndex: 0, name: "A", dwellMinutes: 5 },
        { pointIndex: 1, name: "B", hoursFromPrev: 2, dwellMinutes: 0 },
      ],
    });

    const path = drawingToPath(doc);

    assert.equal(path.length, 2);
    assert.equal(path[0].station, "A");
    assert.equal(path[1].station, "B");
  });

  it("handles a Drawing with only waypoints (no stations)", () => {
    const doc = makeDrawingDoc({
      x: 10,
      y: 20,
      points: [0, 0, 100, 100],
      segmentId: "curve",
      stations: [],
    });

    const path = drawingToPath(doc);

    assert.equal(path.length, 2);
    assert.equal("station" in path[0], false);
    assert.equal(path[0].x, 10);
    assert.equal(path[0].y, 20);
    assert.equal(path[1].x, 110);
    assert.equal(path[1].y, 120);
  });

  it("handles a Drawing with no stations array in flags", () => {
    const doc = {
      x: 0,
      y: 0,
      shape: { points: [0, 0, 100, 100] },
      flags: {
        "rail-network": { segmentId: "bare" },
      },
    };

    const path = drawingToPath(doc);

    assert.equal(path.length, 2);
    assert.equal("station" in path[0], false);
  });
});

// ============================================================================
// Phase 2: Event Application Helpers
// ============================================================================

// Helper: build a simple A→B→C route for reuse in event tests
function makeTestLegs() {
  return buildRouteSegments([
    { station: "A", x: 0, y: 0, dwellMinutes: 5 },
    { station: "B", x: 300, y: 400, hoursFromPrev: 1, dwellMinutes: 10 },
    { station: "C", x: 600, y: 400, hoursFromPrev: 2, dwellMinutes: 0 },
  ]);
}

describe("findStationArrivalTime", () => {
  it("returns 0 for the first station (train starts there)", () => {
    const { legs } = makeTestLegs();
    assert.equal(findStationArrivalTime(legs, "A"), 0);
  });

  it("returns dwell + travel time for second station", () => {
    const { legs } = makeTestLegs();
    // A dwell=5min(300s) + travel A→B=1h(3600s) = 3900s
    assert.equal(findStationArrivalTime(legs, "B"), 3900);
  });

  it("returns cumulative time for third station", () => {
    const { legs } = makeTestLegs();
    // A dwell=300 + travel A→B=3600 + B dwell=600 + travel B→C=7200 = 11700s
    assert.equal(findStationArrivalTime(legs, "C"), 11700);
  });

  it("returns null for unknown station", () => {
    const { legs } = makeTestLegs();
    assert.equal(findStationArrivalTime(legs, "Nonexistent"), null);
  });
});

describe("applyEvents", () => {
  it("returns unchanged elapsed when no events match", () => {
    const { legs } = makeTestLegs();
    const result = applyEvents([], 1000, 5000, legs, 6000);
    assert.equal(result.skip, false);
    assert.equal(result.adjustedElapsed, 5000);
  });

  it("destroy event targeting this departure returns skip", () => {
    const { legs } = makeTestLegs();
    const events = [
      { type: "destroy", target: { routeId: "r1", departureTime: 1000 }, startTime: 1500, endTime: null },
    ];
    const result = applyEvents(events, 1000, 5000, legs, 6000);
    assert.equal(result.skip, true);
  });

  it("destroy event targeting different departure does not skip", () => {
    const { legs } = makeTestLegs();
    const events = [
      { type: "destroy", target: { routeId: "r1", departureTime: 9999 }, startTime: 1500, endTime: null },
    ];
    const result = applyEvents(events, 1000, 5000, legs, 6000);
    assert.equal(result.skip, false);
  });

  it("delay event subtracts effective delay from elapsed", () => {
    const { legs } = makeTestLegs();
    const events = [
      { type: "delay", target: { routeId: "r1", departureTime: 1000 }, startTime: 1000, endTime: null, delayHours: 2 },
    ];
    // elapsed=5000, delay=2h=7200s → adjustedElapsed = max(0, 5000 - 7200) = 0
    const result = applyEvents(events, 1000, 5000, legs, 6000);
    assert.equal(result.skip, false);
    assert.equal(result.adjustedElapsed, 0);
  });

  it("delay event with small delay partially reduces elapsed", () => {
    const { legs } = makeTestLegs();
    const events = [
      { type: "delay", target: { routeId: "r1", departureTime: 1000 }, startTime: 1000, endTime: null, delayHours: 0.5 },
    ];
    // elapsed=5000, delay=0.5h=1800s → adjustedElapsed = 5000 - 1800 = 3200
    const result = applyEvents(events, 1000, 5000, legs, 6000);
    assert.equal(result.adjustedElapsed, 3200);
  });

  it("blockTrack clamps elapsed at named station arrival time", () => {
    const { legs } = makeTestLegs();
    // Block at B. Arrival at B = 3900s. Elapsed = 5000 > 3900, so clamp.
    const events = [
      { type: "blockTrack", target: { routeId: "r1", stationName: "B" }, startTime: 0, endTime: null },
    ];
    const result = applyEvents(events, 1000, 5000, legs, 6000);
    assert.equal(result.adjustedElapsed, 3900);
    assert.equal(result.stationClamp, "B");
  });

  it("blockTrack does not clamp if train has not reached station yet", () => {
    const { legs } = makeTestLegs();
    // Block at B. Arrival at B = 3900s. Elapsed = 2000 < 3900, no clamp.
    const events = [
      { type: "blockTrack", target: { routeId: "r1", stationName: "B" }, startTime: 0, endTime: null },
    ];
    const result = applyEvents(events, 1000, 2000, legs, 3000);
    assert.equal(result.adjustedElapsed, 2000);
    assert.equal(result.stationClamp, null);
  });

  it("halt event clamps specific departure at named station", () => {
    const { legs } = makeTestLegs();
    const events = [
      { type: "halt", target: { routeId: "r1", departureTime: 1000, stationName: "B" }, startTime: 0, endTime: null },
    ];
    const result = applyEvents(events, 1000, 5000, legs, 6000);
    assert.equal(result.adjustedElapsed, 3900);
    assert.equal(result.stationClamp, "B");
  });

  it("halt event does not affect different departure", () => {
    const { legs } = makeTestLegs();
    const events = [
      { type: "halt", target: { routeId: "r1", departureTime: 9999, stationName: "B" }, startTime: 0, endTime: null },
    ];
    const result = applyEvents(events, 1000, 5000, legs, 6000);
    assert.equal(result.adjustedElapsed, 5000);
    assert.equal(result.stationClamp, null);
  });

  it("multiple events: delay + blockTrack applied together", () => {
    const { legs } = makeTestLegs();
    const events = [
      { type: "delay", target: { routeId: "r1", departureTime: 1000 }, startTime: 1000, endTime: null, delayHours: 0.5 },
      { type: "blockTrack", target: { routeId: "r1", stationName: "B" }, startTime: 0, endTime: null },
    ];
    // elapsed=5000, delay=1800s → 3200. Then blockTrack at B arrival=3900. 3200 < 3900 so no clamp.
    const result = applyEvents(events, 1000, 5000, legs, 6000);
    assert.equal(result.adjustedElapsed, 3200);
    assert.equal(result.stationClamp, null);
  });
});

// ============================================================================
// Phase 3: Token Reconciliation — computeDesiredTokens
// ============================================================================

describe("computeDesiredTokens", () => {
  // A simple route with inline path, daily schedule at 14:00
  const testSegments = [
    {
      segmentId: "a-b",
      path: [
        { station: "A", x: 0, y: 0, dwellMinutes: 5 },
        { station: "B", x: 300, y: 400, hoursFromPrev: 1, dwellMinutes: 10 },
        { station: "C", x: 600, y: 400, hoursFromPrev: 2, dwellMinutes: 0 },
      ],
    },
  ];

  function makeRoute() {
    return {
      id: "test-route",
      tokenPrototype: {
        name: "Test Express",
        texture: { src: "icons/svg/lightning.svg" },
        width: 0.8,
        height: 0.8,
      },
      schedule: [
        {
          cron: "0 14",
          routeNumbers: ["1"],
          direction: "outbound",
          segments: testSegments,
        },
      ],
    };
  }

  it("produces a token for an active departure", () => {
    const route = makeRoute();
    // Day 5, 15:00 — 1 hour after the 14:00 departure
    const worldTime = 5 * SECONDS_PER_DAY + 15 * SECONDS_PER_HOUR;
    const tokens = computeDesiredTokens(route, worldTime, []);

    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].routeId, "test-route");
    assert.equal(tokens[0].departureTime, 5 * SECONDS_PER_DAY + 14 * SECONDS_PER_HOUR);
    assert.equal(tokens[0].routeNum, "1");
    assert.ok(tokens[0].x != null);
    assert.ok(tokens[0].y != null);
  });

  it("produces no tokens when no departure is active", () => {
    const route = makeRoute();
    // Day 5, 10:00 — before the 14:00 departure, yesterday's is done (journey ~3.25h)
    const worldTime = 5 * SECONDS_PER_DAY + 10 * SECONDS_PER_HOUR;
    const tokens = computeDesiredTokens(route, worldTime, []);

    assert.equal(tokens.length, 0);
  });

  it("skips route when closeLine event is active", () => {
    const route = makeRoute();
    const worldTime = 5 * SECONDS_PER_DAY + 15 * SECONDS_PER_HOUR;
    const events = [
      { id: "e1", type: "closeLine", target: { routeId: "test-route" }, startTime: 0, endTime: null },
    ];
    const tokens = computeDesiredTokens(route, worldTime, events);

    assert.equal(tokens.length, 0);
  });

  it("destroy event removes the targeted departure", () => {
    const route = makeRoute();
    const worldTime = 5 * SECONDS_PER_DAY + 15 * SECONDS_PER_HOUR;
    const depTime = 5 * SECONDS_PER_DAY + 14 * SECONDS_PER_HOUR;
    const events = [
      { id: "e1", type: "destroy", target: { routeId: "test-route", departureTime: depTime }, startTime: depTime, endTime: null },
    ];
    const tokens = computeDesiredTokens(route, worldTime, events);

    assert.equal(tokens.length, 0);
  });

  it("blockTrack event holds train at named station", () => {
    const route = makeRoute();
    // 2 hours after departure — train would normally be past B
    const depTime = 5 * SECONDS_PER_DAY + 14 * SECONDS_PER_HOUR;
    const worldTime = depTime + 2 * SECONDS_PER_HOUR;
    const events = [
      { id: "e1", type: "blockTrack", target: { routeId: "test-route", stationName: "B" }, startTime: 0, endTime: null },
    ];
    const tokens = computeDesiredTokens(route, worldTime, events);

    assert.equal(tokens.length, 1);
    // Should be held at station B
    assert.equal(tokens[0].atStation, "B");
    assert.ok(Math.abs(tokens[0].x - 300) < 1);
    assert.ok(Math.abs(tokens[0].y - 400) < 1);
  });

  it("returns null position for completed journey (token should be deleted)", () => {
    const route = makeRoute();
    // Journey is ~3.25h. 5 hours after departure = completed.
    const depTime = 5 * SECONDS_PER_DAY + 14 * SECONDS_PER_HOUR;
    const worldTime = depTime + 5 * SECONDS_PER_HOUR;
    const tokens = computeDesiredTokens(route, worldTime, []);

    // No token — journey complete, departure no longer active
    assert.equal(tokens.length, 0);
  });

  it("assigns route numbers correctly with multiple departure hours", () => {
    const route = makeRoute();
    route.schedule = [
      { cron: "0 14", routeNumbers: ["1"], direction: "outbound", segments: testSegments },
      { cron: "0 15", routeNumbers: ["3"], direction: "outbound", segments: testSegments },
    ];

    // Day 5, 15:30 — both departures active (journey ~3.25h, both within window)
    const worldTime = 5 * SECONDS_PER_DAY + 15.5 * SECONDS_PER_HOUR;
    const tokens = computeDesiredTokens(route, worldTime, []);

    assert.equal(tokens.length, 2);
    const routeNums = tokens.map(t => t.routeNum).sort();
    assert.ok(routeNums.includes("1"));
    assert.ok(routeNums.includes("3"));
  });

  it("delay event slows train position", () => {
    const route = makeRoute();
    const depTime = 5 * SECONDS_PER_DAY + 14 * SECONDS_PER_HOUR;
    // 1 hour after departure, but with 0.5h delay → effectively only 0.5h into journey
    const worldTime = depTime + 1 * SECONDS_PER_HOUR;
    const events = [
      { id: "e1", type: "delay", target: { routeId: "test-route", departureTime: depTime }, startTime: depTime, endTime: null, delayHours: 0.5 },
    ];
    const tokensWithDelay = computeDesiredTokens(route, worldTime, events);
    const tokensWithout = computeDesiredTokens(route, worldTime, []);

    assert.equal(tokensWithDelay.length, 1);
    assert.equal(tokensWithout.length, 1);
    // With delay, train should be behind where it would be without delay
    // The delayed train is effectively at 0.5h elapsed instead of 1h
    // Both should exist but at different positions
    assert.notDeepEqual(
      { x: tokensWithDelay[0].x, y: tokensWithDelay[0].y },
      { x: tokensWithout[0].x, y: tokensWithout[0].y }
    );
  });

  it("includes extra departures from extraDeparture events", () => {
    const route = makeRoute();
    const worldTime = 5 * SECONDS_PER_DAY + 10 * SECONDS_PER_HOUR; // before normal departure
    const events = [
      {
        id: "ex1", type: "extraDeparture",
        target: { routeId: "test-route", stationName: "B" },
        startTime: worldTime - 1000, endTime: null,
      },
    ];
    const tokens = computeDesiredTokens(route, worldTime, events);

    // Should have 1 token from the extra departure (no normal departures active at 10:00)
    assert.equal(tokens.length, 1);
  });
});
