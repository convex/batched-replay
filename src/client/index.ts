import { mutationGeneric, queryGeneric } from "convex/server";
import type {
  Auth,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import { v } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import { sampleValidator } from "../component/schema.js";
import {
  batchValidator,
  cursorValidator,
  historyPageValidator,
} from "../component/shared.js";
import type { Sample } from "./sender.js";

export { Sender, type SenderOptions } from "./sender.js";
export { Player, type PlayerBatch, type PlayerOptions } from "./player.js";
export { HistoryPlayer, type HistoryPage } from "./history.js";
export { lerp } from "./lerp.js";
export type { Sample };

type History = ComponentApi["batches"]["history"]["_returnType"];
export type HistoryCursor = NonNullable<History["next"]>;

/**
 * Use from your own queries and mutations. `V` is the shape of one sample's
 * value, e.g. `new BatchedReplay<{ x: number; y: number }>(components.batchedReplay)`.
 */
export class BatchedReplay<V = unknown> {
  constructor(
    private component: ComponentApi,
    private options: { retentionMs?: number } = {},
  ) {}

  append(
    ctx: MutationCtx,
    args: {
      room: string;
      stream: string;
      samples: Sample<V>[];
      duration: number;
    },
  ) {
    return ctx.runMutation(this.component.batches.append, {
      ...args,
      retentionMs: this.options.retentionMs,
    });
  }

  latest(
    ctx: QueryCtx,
    args: { room: string; stream: string; count?: number },
  ) {
    return ctx.runQuery(this.component.batches.latest, args);
  }

  history(
    ctx: QueryCtx,
    args: {
      room: string;
      stream?: string;
      after?: HistoryCursor;
      limit?: number;
    },
  ) {
    return ctx.runQuery(this.component.batches.history, args);
  }

  streams(ctx: QueryCtx, args: { room: string }) {
    return ctx.runQuery(this.component.streams.list, args);
  }

  /** Deletes a stream's batches, or the whole room's. */
  clear(ctx: MutationCtx, args: { room: string; stream?: string }) {
    return ctx.runMutation(this.component.streams.clear, args);
  }
}

type ReadOp = { type: "read"; room: string };
type WriteOp = { type: "write"; room: string; stream?: string };

/**
 * For re-exporting an API that React clients can call, e.g.
 * `export const { append, latest, history, streams } =
 *   exposeApi(components.batchedReplay, { auth })`.
 * See example/convex/cursors.ts.
 */
export function exposeApi(
  component: ComponentApi,
  options: {
    /** How long batches are kept after they end. Default: forever. */
    retentionMs?: number;
    /**
     * Authenticate every call. For writes, return the stream key the caller
     * may write to (or throw). For reads, return anything or throw to deny.
     */
    auth: (
      ctx: { auth: Auth },
      operation: ReadOp | WriteOp,
    ) => Promise<string | void>;
  },
) {
  return {
    append: mutationGeneric({
      args: {
        room: v.string(),
        stream: v.optional(v.string()),
        samples: v.array(sampleValidator),
        duration: v.number(),
      },
      returns: v.object({
        seq: v.number(),
        start: v.number(),
        end: v.number(),
      }),
      handler: async (ctx, args) => {
        const stream = await options.auth(ctx, {
          type: "write",
          room: args.room,
          stream: args.stream,
        });
        if (typeof stream !== "string") {
          throw new Error("auth must return the stream key for writes");
        }
        return await ctx.runMutation(component.batches.append, {
          room: args.room,
          stream,
          samples: args.samples,
          duration: args.duration,
          retentionMs: options.retentionMs,
        });
      },
    }),
    latest: queryGeneric({
      args: {
        room: v.string(),
        stream: v.string(),
        count: v.optional(v.number()),
      },
      returns: v.array(batchValidator),
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "read", room: args.room });
        return await ctx.runQuery(component.batches.latest, args);
      },
    }),
    history: queryGeneric({
      args: {
        room: v.string(),
        stream: v.optional(v.string()),
        after: v.optional(cursorValidator),
        limit: v.optional(v.number()),
      },
      returns: historyPageValidator,
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "read", room: args.room });
        return await ctx.runQuery(component.batches.history, args);
      },
    }),
    streams: queryGeneric({
      args: { room: v.string() },
      returns: v.array(
        v.object({
          stream: v.string(),
          firstStart: v.number(),
          lastEnd: v.number(),
        }),
      ),
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "read", room: args.room });
        return await ctx.runQuery(component.streams.list, args);
      },
    }),
  };
}

// Convenient types for `ctx` args, that only include the bare minimum.
type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type MutationCtx = Pick<
  GenericMutationCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;
