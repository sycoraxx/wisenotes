import test from "node:test";
import assert from "node:assert/strict";
import { dHashFromImageData, hamming, hammingHex, hashToHex } from "../lib/dhash.js";

test("hamming counts differing bits", () => {
  assert.equal(hamming(0n, 0n), 0);
  assert.equal(hamming(0b1010n, 0b0011n), 2);
  assert.equal(hammingHex("0000000000000000", "ffffffffffffffff"), 64);
});

test("dHash encodes horizontal luminance changes", () => {
  const width = 9;
  const height = 8;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = 255 - x * 20;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  assert.equal(hashToHex(dHashFromImageData({ data, width, height })), "ffffffffffffffff");
});

test("dHash rejects the wrong sample size", () => {
  assert.throws(
    () => dHashFromImageData({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    /9x8/
  );
});
