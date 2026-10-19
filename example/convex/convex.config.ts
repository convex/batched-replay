import { defineApp } from "convex/server";
import batchedReplay from "@convex-dev/batched-replay/convex.config.js";

const app = defineApp();
app.use(batchedReplay);

export default app;
