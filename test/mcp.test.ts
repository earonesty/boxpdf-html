import { describe, expect, it } from "vitest";
import { dispatch } from "../src/mcp.js";

function call(method: string, params?: unknown) {
  return dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

async function callTool(name: string, args: Record<string, unknown>) {
  const res = (await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as any;
  return res.result;
}

describe("mcp dispatch — protocol", () => {
  it("initialize advertises resources + tools", async () => {
    const res = (await call("initialize")) as any;
    expect(res.result.protocolVersion).toBeTruthy();
    expect(res.result.capabilities.tools).toBeDefined();
    expect(res.result.capabilities.resources).toBeDefined();
  });

  it("notifications (no id) get no response", async () => {
    expect(await dispatch({ jsonrpc: "2.0", method: "initialized" })).toBeUndefined();
  });

  it("unknown method returns -32601", async () => {
    const res = (await call("does/not/exist")) as any;
    expect(res.error.code).toBe(-32601);
  });

  it("tools/list exposes html_to_pdf and boxpdf_docs", async () => {
    const res = (await call("tools/list")) as any;
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain("html_to_pdf");
    expect(names).toContain("boxpdf_docs");
  });
});

describe("mcp dispatch — html_to_pdf", () => {
  it("renders HTML to an inline PDF resource with diagnostics", async () => {
    const result = await callTool("html_to_pdf", { html: "<h1>Invoice</h1><p>Thanks!</p>" });
    expect(result.isError).toBeFalsy();
    const resource = result.content.find((c: any) => c.type === "resource");
    expect(resource.resource.mimeType).toBe("application/pdf");
    const bytes = Buffer.from(resource.resource.blob, "base64");
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(result.structuredContent.pages).toBeGreaterThanOrEqual(1);
  });

  it("reports unsupported CSS instead of silently dropping it", async () => {
    const result = await callTool("html_to_pdf", {
      html: '<div style="mix-blend-mode: multiply; backdrop-filter: blur(4px)">x</div>'
    });
    expect(result.structuredContent.unsupportedCss.length).toBeGreaterThan(0);
  });

  it("blocks remote images unless allowRemote is set", async () => {
    const result = await callTool("html_to_pdf", { html: '<img src="https://example.com/a.png">' });
    expect(JSON.stringify(result.structuredContent.warnings)).toMatch(/blocked|allowRemote/i);
  });

  it("errors on empty html", async () => {
    const result = await callTool("html_to_pdf", { html: "" });
    expect(result.isError).toBe(true);
  });
});

describe("mcp dispatch — docs & resources", () => {
  it("boxpdf_docs defaults to the quickstart", async () => {
    const result = await callTool("boxpdf_docs", {});
    expect(result.content[0].text).toMatch(/flowToPdf/);
  });

  it("serves the boxpdf library README as a resource", async () => {
    const list = (await call("resources/list")) as any;
    const uris = list.result.resources.map((r: any) => r.uri);
    expect(uris).toContain("boxpdf://readme");
    const read = (await call("resources/read", { uri: "boxpdf://readme" })) as any;
    expect(read.result.contents[0].text).toMatch(/boxpdf/);
  });

  it("rewrites template imports to the published package", async () => {
    const read = (await call("resources/read", { uri: "boxpdf://templates/receipt" })) as any;
    expect(read.result.contents[0].text).toMatch(/from "@boxpdf\/writer"/);
  });
});
