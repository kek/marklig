// Issue #96: Android system back-button must drive the JS mobile router
// instead of exiting the app. The decision is a pure function of the
// current route so we can exercise the rules without booting CodeMirror
// or stubbing native APIs.

import { describe, it, expect } from "vitest";
import { decideAndroidBack } from "../../src/mobile-bootstrap";

describe("decideAndroidBack", () => {
  it("pops a shared/recent document back to the library", () => {
    const decision = decideAndroidBack({
      kind: "document",
      source: "# hi",
      uriForRecents: "file:///tmp/note.md",
    });
    expect(decision).toEqual({
      handled: true,
      next: { kind: "library" },
    });
  });

  it("releases the back-press for the first-launch bundled sample", () => {
    // No uriForRecents → no back-bar in the UI either; we want the OS
    // default (background the task) rather than an in-app dead-end.
    const decision = decideAndroidBack({
      kind: "document",
      source: "# sample",
    });
    expect(decision).toEqual({ handled: false });
  });

  it("releases the back-press at the library route", () => {
    const decision = decideAndroidBack({ kind: "library" });
    expect(decision).toEqual({ handled: false });
  });

  it("pops the pair form back to the library", () => {
    const decision = decideAndroidBack({ kind: "pair" });
    expect(decision).toEqual({
      handled: true,
      next: { kind: "library" },
    });
  });

  it("pops the synced view back to the library", () => {
    // `decideAndroidBack` only branches on `kind`, so we don't need a
    // real MobilePairing shape here — cast through unknown to satisfy
    // the discriminated-union without importing the pairing types.
    const decision = decideAndroidBack({
      kind: "synced",
      pairing: { pair_id_hex: "deadbeef" } as unknown as never,
    } as unknown as Parameters<typeof decideAndroidBack>[0]);
    expect(decision).toEqual({
      handled: true,
      next: { kind: "library" },
    });
  });
});
