import { describe, expect, it } from "vitest";
import { passwordFromEnvironment } from "../src/password-env.js";

describe("passwordFromEnvironment", () => {
  it("leaves encryption disabled when --password-env is omitted", () => {
    expect(passwordFromEnvironment(undefined, {})).toBeUndefined();
  });

  it("returns the password without including it in diagnostics", () => {
    expect(passwordFromEnvironment("PDF_PASSWORD", {
      PDF_PASSWORD: "correct horse battery staple"
    })).toBe("correct horse battery staple");
  });

  it("rejects missing and empty environment variables", () => {
    expect(() => passwordFromEnvironment("PDF_PASSWORD", {})).toThrow(
      /PDF_PASSWORD.*not set/
    );
    expect(() => passwordFromEnvironment("PDF_PASSWORD", {
      PDF_PASSWORD: ""
    })).toThrow(/PDF_PASSWORD.*empty/);
  });
});
