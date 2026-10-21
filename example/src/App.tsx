import "./App.css";
import { useSyncExternalStore } from "react";
import Cursors from "./Cursors";
import Drawing from "./Drawing";
import Racer from "./Racer";
import Marble from "./Marble";
import Tilt from "./Tilt";

// The demos in the menu.
const DEMOS = {
  "#cursors": { name: "Cursors", Demo: Cursors },
  "#drawing": { name: "Drawing", Demo: Drawing },
  "#racer": { name: "Racer", Demo: Racer },
  "#marble": { name: "Marble", Demo: Marble },
};
// Plus the phone half of the marble, opened from its QR code. It's a phone
// screen, so it has no menu.
const PAGES = { ...DEMOS, "#tilt": { name: "Tilt", Demo: Tilt } };

function useHash() {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("hashchange", onChange);
      return () => window.removeEventListener("hashchange", onChange);
    },
    () => location.hash,
  );
}

export default function App() {
  const hash = useHash();
  // "#racer?autodrive=1" is the racer, with options.
  const page = hash.split("?")[0];
  const current = page in PAGES ? (page as keyof typeof PAGES) : "#cursors";
  const { Demo } = PAGES[current];
  return (
    <>
      <Demo />
      {current in DEMOS && (
        <nav className="demo-nav">
          {Object.entries(DEMOS).map(([href, { name }]) => (
            <a key={href} href={href} aria-current={href === current}>
              {name}
            </a>
          ))}
        </nav>
      )}
    </>
  );
}
