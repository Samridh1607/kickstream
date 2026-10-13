import { type BrandVariants, createDarkTheme, createLightTheme, type Theme } from "@fluentui/react-components";
import { useEffect, useState } from "react";
import { create } from "zustand";

const QUERY = "(prefers-color-scheme: dark)";
const STORAGE_KEY = "kickstream.theme";

/** Kickstream violet, darkest to lightest, in the steps Fluent UI builds its themes from. */
export const BRAND: BrandVariants = {
  10: "#050208", 20: "#1C0F33", 30: "#2C1559", 40: "#3A1A78", 50: "#481E96", 60: "#5722B4", 70: "#6528CF", 80: "#7535E3",
  90: "#8448EA", 100: "#925CEE", 110: "#A070F1", 120: "#AE84F4", 130: "#BC98F6", 140: "#CAADF8", 150: "#D8C2FA", 160: "#E6D8FC",
};

export const lightTheme: Theme = createLightTheme(BRAND);
export const darkTheme: Theme = {
  ...createDarkTheme(BRAND),
  // The default dark brand text is too dim on the dark neutrals.
  colorBrandForeground1: BRAND[110],
  colorBrandForeground2: BRAND[120],
};

export type ThemeChoice = "system" | "light" | "dark";

function stored(): ThemeChoice {
  const value = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export const useThemeChoice = create<{ choice: ThemeChoice; setChoice(choice: ThemeChoice): void }>((set) => ({
  choice: stored(),
  setChoice: (choice) => {
    localStorage.setItem(STORAGE_KEY, choice);
    set({ choice });
  },
}));

function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia(QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(QUERY);
    const onChange = (event: MediaQueryListEvent) => setDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return dark;
}

/** True when the page is drawn dark: by the streamer's choice, or by the operating system's setting. */
export function useIsDark(): boolean {
  const choice = useThemeChoice((state) => state.choice);
  const systemDark = useSystemDark();
  return choice === "system" ? systemDark : choice === "dark";
}

export function useAppTheme(): Theme {
  return useIsDark() ? darkTheme : lightTheme;
}
