import { defineApp } from "convex/server";
import batchedReplay from "@convex-dev/batched-replay/convex.config.js";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import staticHosting from "@convex-dev/static-hosting/convex.config.js";

// The hosted demo's page is served from the deployment's own .convex.site
// URL by the static hosting component, which owns the root. The app has no
// HTTP endpoints of its own, but any it adds would live under /api.
const app = defineApp({ httpPrefix: "/api" });
app.use(batchedReplay);
app.use(rateLimiter);
app.use(staticHosting, { httpPrefix: "/" });

export default app;
