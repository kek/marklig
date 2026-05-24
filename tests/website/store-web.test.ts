import { describe, it, expect, beforeEach } from "vitest";
import { getValue, setValue, deleteValue, listKeys } from "../../src/website/store-web";

describe("website store-web shim", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("setValue then getValue round-trips a string", async () => {
    await setValue("foo", "bar");
    expect(await getValue<string>("foo")).toBe("bar");
  });

  it("setValue then getValue round-trips a number", async () => {
    await setValue("n", 42);
    expect(await getValue<number>("n")).toBe(42);
  });

  it("setValue then getValue round-trips a boolean", async () => {
    await setValue("flag", true);
    expect(await getValue<boolean>("flag")).toBe(true);
  });

  it("setValue then getValue round-trips null (distinct from missing)", async () => {
    await setValue("nullable", null);
    expect(await getValue<string | null>("nullable")).toBeNull();
    // Compare with the absent case to make the contract explicit.
    expect(await getValue<string | null>("missing-nullable")).toBeUndefined();
  });

  it("getValue returns undefined for missing keys", async () => {
    expect(await getValue<string>("missing")).toBeUndefined();
  });

  it("deleteValue removes the key", async () => {
    await setValue("temp", "x");
    await deleteValue("temp");
    expect(await getValue<string>("temp")).toBeUndefined();
  });

  it("listKeys returns the set of stored keys", async () => {
    await setValue("a", 1);
    await setValue("b", 2);
    const keys = await listKeys();
    expect(keys).toHaveLength(2);
    expect(keys).toContain("a");
    expect(keys).toContain("b");
  });

  it("values that fail to JSON-parse return undefined", async () => {
    localStorage.setItem("marklig.web.broken", "{not json");
    expect(await getValue<unknown>("broken")).toBeUndefined();
  });
});
