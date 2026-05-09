import { describe, it, expect, beforeEach } from "vitest";

import { t, setLocaleStrings, EN } from "../../src/i18n/strings";

describe("i18n", () => {
  beforeEach(() => {
    setLocaleStrings({});
  });

  it("returns the EN default for every key when no locale is installed", () => {
    expect(t("prefs.title")).toBe(EN["prefs.title"]);
    expect(t("reconcile.title")).toBe(EN["reconcile.title"]);
  });

  it("uses an installed locale's string when present", () => {
    setLocaleStrings({ "prefs.title": "Inställningar" });
    expect(t("prefs.title")).toBe("Inställningar");
  });

  it("falls back to EN per key when the locale doesn't translate it", () => {
    setLocaleStrings({ "prefs.title": "Inställningar" });
    // Not overridden — must still resolve.
    expect(t("reconcile.title")).toBe(EN["reconcile.title"]);
  });

  it("setLocaleStrings({}) reverts to all EN", () => {
    setLocaleStrings({ "prefs.title": "X" });
    setLocaleStrings({});
    expect(t("prefs.title")).toBe(EN["prefs.title"]);
  });
});
