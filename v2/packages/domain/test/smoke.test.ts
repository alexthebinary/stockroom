import { describe, expect, it } from "vitest";
import { placeholder } from "../src";

describe("domain package", () => {
  it("loads", () => expect(placeholder).toBe(true));
});
