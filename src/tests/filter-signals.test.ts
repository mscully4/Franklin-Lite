import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { statesEqual } from "../filter-signals.js";

// ── statesEqual ───────────────────────────────────────────────────────────────

describe("statesEqual", () => {
  test("equal objects return true", () => {
    assert.ok(statesEqual({ ci_failing: ["lint"], approved: false }, { ci_failing: ["lint"], approved: false }));
  });

  test("different values return false", () => {
    assert.ok(!statesEqual({ ci_failing: ["lint"] }, { ci_failing: ["lint", "test"] }));
  });

  test("order of array items matters", () => {
    assert.ok(!statesEqual({ ci_failing: ["a", "b"] }, { ci_failing: ["b", "a"] }));
  });

  test("empty object vs populated returns false", () => {
    assert.ok(!statesEqual({}, { ci_failing: [] }));
  });

  test("two empty objects are equal", () => {
    assert.ok(statesEqual({}, {}));
  });

  test("null values are compared correctly", () => {
    assert.ok(statesEqual({ last_updated: null }, { last_updated: null }));
    assert.ok(!statesEqual({ last_updated: null }, { last_updated: "2026-04-05T10:00:00Z" }));
  });

  test("first-time signal (previous state empty object) — differs from any state", () => {
    assert.ok(!statesEqual({}, { surfaced: true }));
  });
});
