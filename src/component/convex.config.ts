import { defineComponent } from "convex/server";
import batchWorker from "@convex-dev/batch-worker/convex.config.js";

const component = defineComponent("batchedReplay");
// Runs the room feed: one worker loop per room that has it switched on.
component.use(batchWorker);

export default component;
