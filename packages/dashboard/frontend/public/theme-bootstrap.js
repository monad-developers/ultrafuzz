(() => {
  const key = "mds-theme";
  let preference = "system";

  try {
    const stored = globalThis.localStorage.getItem(key);
    if (stored === "system" || stored === "light" || stored === "dark") {
      preference = stored;
    }
  } catch {
    preference = "system";
  }

  const resolved =
    preference === "system"
      ? globalThis.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference;
  globalThis.document.documentElement.classList.toggle("dark", resolved === "dark");
  globalThis.document.documentElement.style.colorScheme = resolved;
})();
