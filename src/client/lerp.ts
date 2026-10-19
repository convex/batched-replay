// Blends two values: numbers are interpolated, objects field by field, and
// everything else (strings, booleans, arrays) steps to `b` once alpha reaches 1.
export function lerp(a: unknown, b: unknown, alpha: number): unknown {
  if (typeof a === "number" && typeof b === "number") {
    return a + (b - a) * alpha;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(b)) {
      out[key] = key in a ? lerp(a[key], b[key], alpha) : b[key];
    }
    return out;
  }
  return alpha >= 1 ? b : a;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
