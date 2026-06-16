import { describe, expect, it } from "vitest";
import { htmlToPdf } from "../src/index.js";

describe("htmlToPdf", () => {
  it("renders an HTML string to PDF bytes with zero configuration", async () => {
    const bytes = await htmlToPdf("<h1>Invoice</h1><p>Thanks for your order.</p>");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("lets a caller-supplied resolveFont win over the defaults", async () => {
    let asked = false;
    await htmlToPdf("<p>hi</p>", {
      resolveFont: () => {
        asked = true;
        return undefined;
      }
    });
    expect(asked).toBe(true);
  });
});
