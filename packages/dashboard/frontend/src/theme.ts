export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "mds-theme";
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveThemePreference(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? getSystemTheme() : preference;
}

export function getResolvedThemeFromDocument(): ResolvedTheme {
  if (typeof document === "undefined") {
    return "light";
  }
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function applyResolvedTheme(theme: ResolvedTheme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(stored)) {
      return stored;
    }
  } catch {
    // localStorage may be unavailable in locked-down browsers.
  }
  return DEFAULT_THEME_PREFERENCE;
}

export function persistThemePreference(preference: ThemePreference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // localStorage may be unavailable in locked-down browsers.
  }
}

export function subscribeToSystemTheme(onChange: (theme: ResolvedTheme) => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = () => onChange(getSystemTheme());
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
