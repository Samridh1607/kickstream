import { type Theme, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import { useEffect, useState } from "react";

const QUERY = "(prefers-color-scheme: dark)";

/** Follows the operating system's light or dark setting. */
export function useSystemTheme(): Theme {
  const [dark, setDark] = useState(() => window.matchMedia(QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(QUERY);
    const onChange = (event: MediaQueryListEvent) => setDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return dark ? webDarkTheme : webLightTheme;
}
