export function hamming(a, b) {
  let value = BigInt(a) ^ BigInt(b);
  let distance = 0;
  while (value) {
    value &= value - 1n;
    distance += 1;
  }
  return distance;
}

export function hammingHex(a, b) {
  if (!a || !b) return 64;
  return hamming(BigInt(`0x${a}`), BigInt(`0x${b}`));
}

export function hashToHex(hash) {
  return BigInt(hash).toString(16).padStart(16, "0");
}

export function dHashFromImageData(imageData) {
  const { data, width, height } = imageData;
  if (width !== 9 || height !== 8) {
    throw new Error("dHash requires a 9x8 ImageData input");
  }

  let result = 0n;
  let bit = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const leftIndex = (y * width + x) * 4;
      const rightIndex = (y * width + x + 1) * 4;
      const left = luminance(data, leftIndex);
      const right = luminance(data, rightIndex);
      if (left > right) result |= 1n << bit;
      bit += 1n;
    }
  }
  return result;
}

function luminance(data, offset) {
  return data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
}
