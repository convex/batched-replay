/// <reference types="vite/client" />
import { test } from "vitest";
import schema from "./schema.js";
import { convexTest } from "convex-test";
import batchWorker from "@convex-dev/batch-worker/test";
export const modules = import.meta.glob("./**/*.*s");

export function initConvexTest() {
  const t = convexTest(schema, modules);
  // The room feed runs on Batch Worker, mounted inside this component.
  batchWorker.register(t);
  return t;
}
test("setup", () => {});
