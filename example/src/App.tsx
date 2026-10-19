import "./App.css";
import { useSyncExternalStore } from "react";
import Cursors from "./Cursors";
import Drawing from "./Drawing";

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
  return (
    <>
      {hash === "#drawing" ? <Drawing /> : <Cursors />}
      <nav className="demo-nav">
        <a href="#cursors" aria-current={hash !== "#drawing"}>
          Cursors
        </a>
        <a href="#drawing" aria-current={hash === "#drawing"}>
          Drawing
        </a>
      </nav>
    </>
  );
}
