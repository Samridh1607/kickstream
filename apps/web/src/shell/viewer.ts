import { useEffect, useState } from "react";

let asked: Promise<boolean> | null = null;

/**
 * Whether this visitor may use the studio. On a deployment with the public view, anyone may
 * watch /live and /match without signing in; they are shown only what they can use. Anything
 * but a plain "no" from the server counts as yes, so a page never hides the studio by mistake.
 */
export function canUseStudio(): Promise<boolean> {
  asked ??= fetch("/api/me")
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { studio?: unknown } | null) => body?.studio !== false)
    .catch(() => true);
  return asked;
}

/** For tests: forget the answer, so the next page asks again. */
export function forgetViewer() {
  asked = null;
}

export function useCanUseStudio(): boolean {
  const [studio, setStudio] = useState(true);
  useEffect(() => {
    let current = true;
    void canUseStudio().then((answer) => current && setStudio(answer));
    return () => {
      current = false;
    };
  }, []);
  return studio;
}
