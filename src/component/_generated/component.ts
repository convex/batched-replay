/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    batches: {
      append: FunctionReference<
        "mutation",
        "internal",
        {
          duration: number;
          retentionMs?: number;
          room: string;
          samples: Array<{ t: number; v: any }>;
          stream: string;
        },
        null | { end: number; seq: number; start: number },
        Name
      >;
      history: FunctionReference<
        "query",
        "internal",
        {
          after?: { creationTime: number; seq: number; start: number };
          limit?: number;
          room: string;
          stream?: string;
        },
        {
          batches: Array<{
            _creationTime: number;
            _id: string;
            end: number;
            expiresAt?: number;
            room: string;
            samples: Array<{ t: number; v: any }>;
            seq: number;
            start: number;
            stream: string;
          }>;
          next: { creationTime: number; seq: number; start: number } | null;
        },
        Name
      >;
      latest: FunctionReference<
        "query",
        "internal",
        { count?: number; room: string; stream: string },
        Array<{
          _creationTime: number;
          _id: string;
          end: number;
          expiresAt?: number;
          room: string;
          samples: Array<{ t: number; v: any }>;
          seq: number;
          start: number;
          stream: string;
        }>,
        Name
      >;
    };
    streams: {
      clear: FunctionReference<
        "mutation",
        "internal",
        { room: string; stream?: string },
        null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { limit?: number; room: string },
        {
          epoch: number;
          streams: Array<{
            firstStart: number;
            lastEnd: number;
            stream: string;
          }>;
        },
        Name
      >;
    };
  };
