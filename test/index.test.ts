import { describe, expect, it } from "vitest";
import { prepareHtml } from "../src/index.js";

describe("prepareHtml", () => {
  it("keeps the source HTML and options together", () => {
    expect(prepareHtml("<p>Hello</p>", { baseUrl: "https://example.com" })).toEqual({
      html: "<p>Hello</p>",
      options: { baseUrl: "https://example.com" }
    });
  });
});
