import { defineApp } from "convex/server";
import replay from "@convex-dev/replay/convex.config.js";

const app = defineApp();
app.use(replay, { httpPrefix: "/comments/" });

export default app;
