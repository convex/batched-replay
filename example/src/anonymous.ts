import { useState } from "react";

// Anonymous id, kept in sessionStorage: each tab is its own "user" (so two
// tabs in one browser see each other) and a reload stays the same user.
export function useAnonymousId() {
  const [id] = useState(() => {
    const saved = sessionStorage.getItem("cursor-id");
    if (saved) return saved;
    const fresh = crypto.randomUUID().slice(0, 8);
    sessionStorage.setItem("cursor-id", fresh);
    return fresh;
  });
  return id;
}

export function colorFor(id: string) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash} 80% 60%)`;
}
