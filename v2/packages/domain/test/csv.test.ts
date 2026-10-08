import { describe, expect, it } from "vitest";
import { parseCsv } from "../src";

describe("parseCsv", () => {
  it("reads a header row into records, trimming headers", () => {
    expect(parseCsv("sku, name ,barcode\nW-1,Widget,012345678905\n")).toEqual([
      { sku: "W-1", name: "Widget", barcode: "012345678905" },
    ]);
  });

  it("handles quotes, embedded commas, escaped quotes, CRLF and blank lines", () => {
    const text = 'name,notes\r\n"Acme, Inc.","He said ""hi"""\r\n\r\nBolt Co,\r\n';
    expect(parseCsv(text)).toEqual([
      { name: "Acme, Inc.", notes: 'He said "hi"' },
      { name: "Bolt Co", notes: "" },
    ]);
  });

  it("keeps a newline inside a quoted field", () => {
    expect(parseCsv('a,b\n"line 1\nline 2",x')).toEqual([{ a: "line 1\nline 2", b: "x" }]);
  });

  it("returns nothing for an empty file", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("a,b\n")).toEqual([]);
  });
});
