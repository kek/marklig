import { describe, it, expect } from "vitest";

import { decideAndroidBack } from "../src/mobile-bootstrap";
import type { MobilePairing } from "../src/shell/mobile-pairings";

// `decideAndroidBack` is the pure brain of the Android hardware-back bridge
// (issue #96): given the currently rendered route it decides whether JS pops
// to another route (handled) or lets the activity background the app
// (unhandled). The native MainActivity callback consumes only this boolean.

const pairing: MobilePairing = {
  pair_id_hex: "deadbeef",
} as MobilePairing;

describe("decideAndroidBack", () => {
  it("library route is unhandled so Android backgrounds the app", () => {
    expect(decideAndroidBack({ kind: "library" })).toEqual({
      handled: false,
    });
  });

  it("document reached via a recent pops to the library", () => {
    expect(
      decideAndroidBack({
        kind: "document",
        source: "# hi",
        uriForRecents: "content://doc.md",
      }),
    ).toEqual({ handled: true, next: { kind: "library" } });
  });

  it("first-launch sample document (no uriForRecents) also pops to the library, matching the always-visible back-bar", () => {
    expect(
      decideAndroidBack({ kind: "document", source: "# sample" }),
    ).toEqual({ handled: true, next: { kind: "library" } });
  });

  it("pair route pops to the library", () => {
    expect(decideAndroidBack({ kind: "pair" })).toEqual({
      handled: true,
      next: { kind: "library" },
    });
  });

  it("synced route pops to the library", () => {
    expect(decideAndroidBack({ kind: "synced", pairing })).toEqual({
      handled: true,
      next: { kind: "library" },
    });
  });
});
