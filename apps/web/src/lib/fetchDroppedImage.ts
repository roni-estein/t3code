import { deriveImageFilenameFromUrl } from "../composer-logic";

/**
 * Fetch a URL that was dropped onto the composer and return it as a `File`
 * suitable for the existing image-attachment pipeline.
 *
 * Returns `null` (instead of throwing) for every failure mode so the caller
 * can aggregate results across a batch of URLs without a single bad URL
 * poisoning the whole drop:
 *
 *   - network / CORS failure  → `null`
 *   - non-2xx response         → `null`
 *   - non-image content type   → `null`
 *
 * Note: `response.ok` is checked explicitly. `fetch` only rejects on network
 * errors — 4xx/5xx resolve successfully and would otherwise silently return
 * an error-page body wrapped as a "file".
 */
export async function fetchDroppedImageAsFile(url: string): Promise<File | null> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "omit" });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    return null;
  }

  if (!blob.type.startsWith("image/")) return null;

  const name = deriveImageFilenameFromUrl(url, blob.type);
  return new File([blob], name, { type: blob.type });
}
