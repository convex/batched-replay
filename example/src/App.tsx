import "./App.css";
import { useSyncExternalStore } from "react";
import Cursors from "./Cursors";
import Drawing from "./Drawing";
import Racer from "./Racer";
import Marble from "./Marble";
import Tilt from "./Tilt";

const DEMOS = {
  "#cursors": { name: "Cursors", Demo: Cursors },
  "#drawing": { name: "Drawing", Demo: Drawing },
  "#racer": { name: "Racer", Demo: Racer },
  "#marble": { name: "Marble", Demo: Marble },
  "#tilt": { name: "Tilt", Demo: Tilt },
};

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
  const current = page in DEMOS ? (page as keyof typeof DEMOS) : "#cursors";
  const { Demo } = DEMOS[current];
  return (
    <>
      <Demo />
      <nav className="demo-nav">
        {Object.entries(DEMOS).map(([href, { name }]) => (
          <a key={href} href={href} aria-current={href === current}>
            {name}
          </a>
        ))}
      </nav>
    </>
  );
}
