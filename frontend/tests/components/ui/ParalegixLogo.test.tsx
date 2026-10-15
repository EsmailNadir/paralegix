import React from "react";
import fs from "fs";
import path from "path";
import { render } from "@testing-library/react";
import ParalegixLogo from "@/components/ui/ParalegixLogo";

// The mark exists as JSX in ParalegixLogo and as static SVGs: the two under
// public/img that the favicons, app icons and structured-data logo are built
// from, and the docs site's favicon, which is also its nav logo. These tests
// keep every copy drawing the same gavel, so a change to one cannot ship
// without the others.

/** Every drawable shape inside the gavel group, as tag plus geometry attributes. */
function gavelShapes(root: ParentNode): string[] {
  const group = root.querySelector('g[fill="#FFFFFF"]');
  if (!group) throw new Error("gavel group not found");
  return Array.from(group.querySelectorAll("rect, path, g")).map((el) => {
    const attrs = ["x", "y", "width", "height", "rx", "d", "transform"]
      .filter((a) => el.hasAttribute(a))
      .map((a) => `${a}=${el.getAttribute(a)}`);
    return `${el.tagName.toLowerCase()} ${attrs.join(" ")}`;
  });
}

/** Reads an SVG by its path from the repository root. */
function parseSvgFile(repoPath: string): Document {
  const file = path.join(__dirname, "../../../..", repoPath);
  return new DOMParser().parseFromString(fs.readFileSync(file, "utf8"), "image/svg+xml");
}

describe("ParalegixLogo mark", () => {
  it("draws the gavel head, handle and sound block", () => {
    const { container } = render(<ParalegixLogo />);
    const shapes = gavelShapes(container);
    // Body, two end caps, collar and handle inside the turned group, then the
    // two-step sound block outside it.
    expect(shapes.filter((s) => s.startsWith("rect"))).toHaveLength(6);
    expect(shapes.filter((s) => s.startsWith("path"))).toHaveLength(1);
    expect(shapes).toContain("g transform=translate(52 50) rotate(-45)");
  });

  it.each([
    "frontend/public/img/paralegix-mark.svg",
    "frontend/public/img/paralegix-icon.svg",
    "docs/public/favicon.svg",
  ])(
    "matches the geometry of %s",
    (file) => {
      const { container } = render(<ParalegixLogo />);
      expect(gavelShapes(parseSvgFile(file))).toEqual(gavelShapes(container));
    },
  );
});
