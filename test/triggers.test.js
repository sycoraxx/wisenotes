import test from "node:test";
import assert from "node:assert/strict";
import { findTriggers, scoreSegment } from "../lib/triggers.js";

test("visual and mathematical cues receive useful scores", () => {
  const explicit = scoreSegment("As you can see, this equation contains an integral.");
  assert.ok(explicit.score >= 6);
  assert.ok(explicit.reasons.includes("explicit visual cue"));
});

test("nearby triggers are merged by strongest score", () => {
  const triggers = findTriggers([
    { start: 10, text: "This matrix is important." },
    { start: 14, text: "Look at this equation on the board." },
    { start: 30, text: "Now run this code snippet." }
  ]);
  assert.equal(triggers.length, 2);
  assert.equal(triggers[0].t, 14);
  assert.equal(triggers[1].t, 30);
});
