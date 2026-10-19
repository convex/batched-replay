import { mutationGeneric, queryGeneric } from "convex/server";
import type {
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  RegisteredMutation,
  RegisteredQuery,
} from "convex/server";
import { v, type Infer, type Validator, type VAny } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  batchValidatorFor,
  cursorValidator,
  historyPageValidatorFor,
  streamListValidator,
} from "../component/shared.js";
import type { Sample } from "./sender.js";

export { Sender, type SenderOptions } from "./sender.js";
export { Player, type PlayerBatch, type PlayerOptions } from "./player.js";
export { HistoryPlayer, type HistoryPage } from "./history.js";
export { lerp } from "./lerp.js";
export type { Sample };

type History = ComponentApi["batches"]["history"]["_returnType"];
export type HistoryCursor = NonNullable<History["next"]>;
/** A stored batch whose samples hold values of type `V`. */
export type Batch<V> = Omit<History["batches"][number], "samples"> & {
  samples: Sample<V>[];
};
export type StreamList = ComponentApi["streams"]["list"]["_returnType"];

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

  /** The room's most recently active streams, newest first, and its epoch. */
  streams(ctx: QueryCtx, args: { room: string; limit?: number }) {
    return ctx.runQuery(this.component.streams.list, args);
  }

  /**
   * Deletes a stream's batches, or the whole room's, then bumps the room's
   * epoch so every viewer starts again.
   */
  clear(ctx: MutationCtx, args: { room: string; stream?: string }) {
    return ctx.runMutation(this.component.streams.clear, args);
  }
}

export type ExposeApiOptions<
  Value,
  DataModel extends GenericDataModel = GenericDataModel,
> = {
  /**
   * Validates each sample's value on `append`, e.g.
   * `v.object({ x: v.number(), y: v.number() })`, and types it for the
   * React hooks. Default: `v.any()`.
   */
  value?: Value;
  /** How long batches are kept after they end. Default: forever. */
  retentionMs?: number;
  /**
   * Called before every read of `room`. Throw to deny. Annotate `ctx` with
   * your app's `QueryCtx` to get typed `ctx.db` access.
   */
  authorizeRead(
    ctx: GenericQueryCtx<DataModel>,
    args: { room: string },
  ): Promise<void>;
  /**
   * Called before every append. Return the stream key this caller writes to
   * (`stream` is what the client asked for), or throw to deny.
   */
  authorizeWrite(
    ctx: GenericMutationCtx<DataModel>,
    args: { room: string; stream?: string },
  ): Promise<string>;
};

/**
 * For re-exporting an API that React clients can call, e.g.
 * `export const { append, latest, history, streams } =
 *   exposeApi(components.batchedReplay, { value, authorizeRead, authorizeWrite })`.
 * See example/convex/cursors.ts.
 */
export function exposeApi<
  Value extends Validator<any, "required", any> = VAny,
  DataModel extends GenericDataModel = GenericDataModel,
>(
  component: ComponentApi,
  options: ExposeApiOptions<Value, DataModel>,
): ExposedApi<Infer<Value>> {
  const value = (options.value ?? v.any()) as Value;
  // The functions below are registered without the app's data model, so
  // hand the callbacks the ctx typed the way the app declared them.
  const authorizeRead = (
    ctx: GenericQueryCtx<GenericDataModel>,
    room: string,
  ) =>
    options.authorizeRead(ctx as unknown as GenericQueryCtx<DataModel>, {
      room,
    });
  return {
    append: mutationGeneric({
      args: {
        room: v.string(),
        stream: v.optional(v.string()),
        samples: v.array(v.object({ t: v.number(), v: value })),
        duration: v.number(),
      },
      returns: v.union(
        v.null(),
        v.object({ seq: v.number(), start: v.number(), end: v.number() }),
      ),
      handler: async (ctx, args) => {
        const stream = await options.authorizeWrite(
          ctx as unknown as GenericMutationCtx<DataModel>,
          { room: args.room, stream: args.stream },
        );
        if (typeof stream !== "string") {
          throw new Error("authorizeWrite must return the stream key");
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
      returns: v.array(batchValidatorFor(value)),
      handler: async (ctx, args) => {
        await authorizeRead(ctx, args.room);
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
      returns: historyPageValidatorFor(value),
      handler: async (ctx, args) => {
        await authorizeRead(ctx, args.room);
        return await ctx.runQuery(component.batches.history, args);
      },
    }),
    streams: queryGeneric({
      args: { room: v.string(), limit: v.optional(v.number()) },
      returns: streamListValidator,
      handler: async (ctx, args) => {
        await authorizeRead(ctx, args.room);
        return await ctx.runQuery(component.streams.list, args);
      },
    }),
  };
}

/** What `exposeApi` returns, typed with the sample value `V`. */
export type ExposedApi<V> = {
  append: RegisteredMutation<
    "public",
    { room: string; stream?: string; samples: Sample<V>[]; duration: number },
    Promise<{ seq: number; start: number; end: number } | null>
  >;
  latest: RegisteredQuery<
    "public",
    { room: string; stream: string; count?: number },
    Promise<Batch<V>[]>
  >;
  history: RegisteredQuery<
    "public",
    { room: string; stream?: string; after?: HistoryCursor; limit?: number },
    Promise<{ batches: Batch<V>[]; next: HistoryCursor | null }>
  >;
  streams: RegisteredQuery<
    "public",
    { room: string; limit?: number },
    Promise<StreamList>
  >;
};

// Convenient types for `ctx` args, that only include the bare minimum.
type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type MutationCtx = Pick<
  GenericMutationCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;
