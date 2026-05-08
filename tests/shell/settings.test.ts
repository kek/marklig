import { describe, it, expect } from "vitest";

import { isRemoteUrl, shouldRenderImage } from "../../src/shell/settings";

describe("isRemoteUrl", () => {
  it("recognises http and https URLs", () => {
    expect(isRemoteUrl("http://example.com/x.png")).toBe(true);
    expect(isRemoteUrl("https://example.com/x.png")).toBe(true);
    expect(isRemoteUrl("HTTPS://example.com/x.png")).toBe(true);
  });

  it("recognises protocol-relative URLs", () => {
    expect(isRemoteUrl("//example.com/x.png")).toBe(true);
  });

  it("does not flag relative or absolute file paths as remote", () => {
    expect(isRemoteUrl("./img/x.png")).toBe(false);
    expect(isRemoteUrl("img/x.png")).toBe(false);
    expect(isRemoteUrl("/Users/ke/img.png")).toBe(false);
    expect(isRemoteUrl("file:///tmp/x.png")).toBe(false);
  });

  it("does not flag data: or blob: URIs as remote", () => {
    // These don't trigger network requests, so they aren't policy-gated.
    expect(isRemoteUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isRemoteUrl("blob:https://example.com/uuid")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isRemoteUrl("")).toBe(false);
  });
});

describe("shouldRenderImage", () => {
  it("always renders local images regardless of policy", () => {
    expect(shouldRenderImage("./x.png", "off")).toBe(true);
    expect(shouldRenderImage("./x.png", "placeholder")).toBe(true);
    expect(shouldRenderImage("./x.png", "load")).toBe(true);
  });

  it("renders remote images only when policy is 'load'", () => {
    const url = "https://example.com/x.png";
    expect(shouldRenderImage(url, "load")).toBe(true);
    expect(shouldRenderImage(url, "placeholder")).toBe(false);
    expect(shouldRenderImage(url, "off")).toBe(false);
  });
});
