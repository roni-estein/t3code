import { describe, expect, it } from "vitest";

import {
  resolveDesktopUpdateChannel,
  shouldAcceptDesktopUpdateForCurrentVersion,
  shouldAllowDesktopPrereleaseUpdates,
} from "./updateChannel";

describe("updateChannel", () => {
  it("uses the stable latest channel for plain versions", () => {
    expect(resolveDesktopUpdateChannel("0.0.17")).toBe("latest");
    expect(shouldAllowDesktopPrereleaseUpdates("0.0.17")).toBe(false);
  });

  it("derives the prerelease channel from the installed version", () => {
    expect(resolveDesktopUpdateChannel("0.0.18-nightly.20260415")).toBe("nightly");
    expect(shouldAllowDesktopPrereleaseUpdates("0.0.18-nightly.20260415")).toBe(true);
  });

  it("accepts updates that stay on the same prerelease track", () => {
    expect(
      shouldAcceptDesktopUpdateForCurrentVersion(
        "0.0.18-nightly.20260415",
        "0.0.18-nightly.20260416",
      ),
    ).toBe(true);
  });

  it("rejects stable releases while running a nightly build", () => {
    expect(shouldAcceptDesktopUpdateForCurrentVersion("0.0.18-nightly.20260415", "0.0.17")).toBe(
      false,
    );
  });

  it("rejects updates from a different prerelease track", () => {
    expect(
      shouldAcceptDesktopUpdateForCurrentVersion("0.0.18-nightly.20260415", "0.0.18-beta.1"),
    ).toBe(false);
  });
});
