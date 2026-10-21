import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import App from "./App.jsx";
import { CountingWebSocket } from "./usage";
import "./index.css";

const address = import.meta.env.VITE_CONVEX_URL;

// The counting socket feeds the usage readout in each HUD.
const convex = new ConvexReactClient(address, {
  webSocketConstructor: CountingWebSocket,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
);
