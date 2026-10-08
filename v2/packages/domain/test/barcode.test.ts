import { describe, expect, it } from "vitest";
import { barcodeKey, isValidGtin, parseGs1 } from "../src";

describe("GTIN normalisation", () => {
  it("checks GS1 check digits", () => {
    expect(isValidGtin("036000291452")).toBe(true); // UPC-A
    expect(isValidGtin("4006381333931")).toBe(true); // EAN-13
    expect(isValidGtin("73513537")).toBe(true); // EAN-8
    expect(isValidGtin("036000291453")).toBe(false);
  });

  it("makes UPC-A, EAN-13 and GTIN-14 of one product the same key", () => {
    expect(barcodeKey("036000291452")).toBe("00036000291452");
    expect(barcodeKey("0036000291452")).toBe("00036000291452");
    expect(barcodeKey(" 00036000291452 ")).toBe("00036000291452");
  });

  it("keeps anything else as typed, upper-cased", () => {
    expect(barcodeKey("sku-abc 1")).toBe("SKU-ABC 1");
    expect(barcodeKey("036000291453")).toBe("036000291453");
  });

  it("finds the GTIN inside a GS1 code", () => {
    expect(barcodeKey("(01)00036000291452(21)SN123")).toBe("00036000291452");
  });
});

describe("GS1 element strings", () => {
  it("reads GTIN, lot, expiry and serial in either notation", () => {
    expect(parseGs1("(01)00036000291452(17)271231(10)LOT7(21)SN123")).toEqual({
      gtin: "00036000291452",
      expiry: "271231",
      lot: "LOT7",
      serial: "SN123",
    });
    expect(parseGs1("010003600029145221SN123\u001d10LOT7")).toEqual({ gtin: "00036000291452", serial: "SN123", lot: "LOT7" });
    expect(parseGs1("]d2010003600029145221SN9")).toEqual({ gtin: "00036000291452", serial: "SN9" });
  });

  it("returns null for plain codes", () => {
    expect(parseGs1("036000291452")).toBeNull();
    expect(parseGs1("HELLO")).toBeNull();
  });
});
