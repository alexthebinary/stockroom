/**
 * Dual-vision adjudication. A second model confirms the first; humans are
 * reached only when capture itself fails repeatedly.
 *
 * The assertion this file exists for: AGREEMENT IS COUNTED BY FAMILY, NOT BY
 * READER. Two models from one family sharing a failure mode is the way this
 * design fails silently, and it looks exactly like corroboration from inside.
 */
import { describe, expect, it } from "vitest";
import { adjudicate, MAX_CAPTURE_ATTEMPTS } from "../src/vision_adjudicate";
import { SERIAL_SOURCE } from "../src/serial_intake";

const R = (id: string, family: string, text: string | null, confidence = 0.9) =>
  ({ id, family, text, confidence });

describe("independent families", () => {
  it("two DIFFERENT families agreeing commits unflagged", () => {
    const d = adjudicate({
      brand: "Unitree",
      readers: [R("deepseek-vision", "deepseek", "UT123456"), R("llama-vision", "llama", "UT123456")],
    });
    expect(d.serial).toBe("UT123456");
    expect(d.agreement).toBe(2);
    expect(d.needsReview).toBe(false);
    expect(d.source).toBe(SERIAL_SOURCE.OCR_CORROBORATED);
  });

  it("🔴 two readers from the SAME family count as one, and stay flagged", () => {
    // The whole point. Same architecture, same corpus, same blind spot — a
    // scuffed 8 reads as B to both, confidently. This must NOT pass as
    // corroboration.
    const d = adjudicate({
      brand: "Unitree",
      readers: [R("deepseek-a", "deepseek", "UT123456"), R("deepseek-b", "deepseek", "UT123456")],
    });
    expect(d.agreement, "one family is one observation").toBe(1);
    expect(d.needsReview).toBe(true);
    expect(d.reviewReason).toMatch(/only one reader family/i);
  });

  it("a barcode outranks any number of agreeing vision models", () => {
    const d = adjudicate({
      brand: "Unitree",
      barcode: "UT999000",
      readers: [R("a", "deepseek", "UT999111"), R("b", "llama", "UT999111")],
    });
    expect(d.serial, "a check-digited machine read wins").toBe("UT999000");
    expect(d.needsReview, "but the dissent must stay visible").toBe(true);
    expect(d.reviewReason).toMatch(/barcode UT999000; vision read UT999111/);
  });

  it("barcode plus an agreeing model is the strongest evidence", () => {
    const d = adjudicate({
      brand: "Unitree",
      barcode: "UT555666",
      readers: [R("a", "deepseek", "UT555666")],
    });
    expect(d.needsReview).toBe(false);
    expect(d.agreement).toBe(2);
  });
});

describe("disagreement and repair", () => {
  it("takes the majority string but records the dissent", () => {
    const d = adjudicate({
      brand: "Unitree",
      readers: [
        R("a", "deepseek", "UT123456"),
        R("b", "llama", "UT123456"),
        R("c", "qwen", "UT123455"),
      ],
    });
    expect(d.serial).toBe("UT123456");
    expect(d.agreement).toBe(2);
    expect(d.needsReview).toBe(true);
    expect(d.reviewReason).toMatch(/dissent/i);
  });

  it("auto-repairs a single-family confusion rather than flagging it raw", () => {
    const d = adjudicate({ brand: "Unitree", readers: [R("a", "deepseek", "UTO12345")] });
    expect(d.serial).toBe("UT012345");
    expect(d.reviewReason).toMatch(/auto-corrected/i);
    expect(d.escalate).toBe(false);
  });
});

describe("capture failure retries before it reaches a person", () => {
  it("asks for another photo when nothing is legible", () => {
    const d = adjudicate({ brand: "Unitree", readers: [R("a", "deepseek", null)], attempt: 1 });
    expect(d.retry, "a second photo is free").toBe(true);
    expect(d.escalate).toBe(false);
  });

  it("escalates only after attempts are exhausted", () => {
    const d = adjudicate({
      brand: "Unitree", readers: [R("a", "deepseek", null)], attempt: MAX_CAPTURE_ATTEMPTS,
    });
    expect(d.retry).toBe(false);
    expect(d.escalate, "a repeatedly unreadable label is a broken photo, not a judgement").toBe(true);
  });

  it("retries a format mismatch once before accepting it", () => {
    const d = adjudicate({ brand: "Unitree", readers: [R("a", "deepseek", "!!!!")], attempt: 1 });
    expect(d.retry).toBe(true);
    expect(d.escalate).toBe(false);
  });

  it("accepts a stubborn format mismatch rather than stopping the dock", () => {
    const d = adjudicate({
      brand: "Unitree", readers: [R("a", "deepseek", "!!!!")], attempt: MAX_CAPTURE_ATTEMPTS,
    });
    expect(d.serial).toBe("!!!!");
    expect(d.retry).toBe(false);
    expect(d.escalate).toBe(false);
    expect(d.needsReview).toBe(true);
  });

  it("an unknown brand is not format-checked, and two families still suffice", () => {
    const d = adjudicate({
      brand: "BrandNewCo",
      readers: [R("a", "deepseek", "ZZ-9"), R("b", "llama", "ZZ-9")],
    });
    expect(d.serial).toBe("ZZ9");
    expect(d.needsReview).toBe(false);
  });
});
