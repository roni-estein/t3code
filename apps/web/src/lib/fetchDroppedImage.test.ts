import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchDroppedImageAsFile } from "./fetchDroppedImage";

describe("fetchDroppedImageAsFile", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const mockFetch = () => globalThis.fetch as ReturnType<typeof vi.fn>;

  it("returns a File when the URL resolves to image bytes", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    mockFetch().mockResolvedValueOnce({
      ok: true,
      blob: () => Promise.resolve(blob),
    } as unknown as Response);

    const result = await fetchDroppedImageAsFile(
      "https://cdn.example.com/path/photo.png?token=abc",
    );
    expect(result).not.toBeNull();
    expect(result?.name).toBe("photo.png");
    expect(result?.type).toBe("image/png");
    expect(result?.size).toBe(3);
  });

  it("returns null on a network / CORS failure (fetch rejects)", async () => {
    mockFetch().mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const result = await fetchDroppedImageAsFile("https://blocked.example.com/x.png");
    expect(result).toBeNull();
  });

  it("returns null for non-2xx responses — never trusts body on error status", async () => {
    // Pattern: response.ok must be checked. fetch() resolves on 4xx/5xx,
    // and reading the body would otherwise wrap an HTML error page as a "file".
    mockFetch().mockResolvedValueOnce({
      ok: false,
      status: 403,
      blob: () => Promise.resolve(new Blob(["forbidden"], { type: "text/html" })),
    } as unknown as Response);

    const result = await fetchDroppedImageAsFile("https://cdn.example.com/forbidden.png");
    expect(result).toBeNull();
  });

  it("returns null when the response body is not an image", async () => {
    mockFetch().mockResolvedValueOnce({
      ok: true,
      blob: () => Promise.resolve(new Blob(["<html>"], { type: "text/html" })),
    } as unknown as Response);

    const result = await fetchDroppedImageAsFile("https://example.com/page");
    expect(result).toBeNull();
  });

  it("returns null when reading the body throws", async () => {
    mockFetch().mockResolvedValueOnce({
      ok: true,
      blob: () => Promise.reject(new Error("body stream closed")),
    } as unknown as Response);

    const result = await fetchDroppedImageAsFile("https://cdn.example.com/a.png");
    expect(result).toBeNull();
  });
});
