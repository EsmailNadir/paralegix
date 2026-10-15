/**
 * Structural guard: every `placeholderData` on a firm-scoped query must key its
 * fallback to the CURRENT firm, or a firm switch briefly shows the previous
 * firm's rows under the new firm's chrome.
 *
 * The correct-by-construction form:
 *
 *   placeholderData: (prev, prevQuery) =>
 *     (prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined)
 *
 * This class of bug was found and independently fixed five separate times
 * across different screens before this guard existed. A behavioural test on one
 * screen at a time never stops the sixth instance appearing on a screen nobody
 * thought to test; only a sweep over every call site does that.
 *
 * A file is exempt only when it is listed in ALLOWLIST below, with a comment
 * naming why: e.g. the query key carries no firm id at all, so there is
 * nothing to leak across firms.
 */
import fs from "fs";
import path from "path";

const SRC_ROOT = path.resolve(__dirname, "../../src");

/**
 * file (relative to src/) -> reason.
 *
 * `AdminFirmPicker` searches ACROSS every firm by design (it is how a
 * super-admin finds a firm to act on); its query key carries no `lawFirmId`
 * at all, so there is no firm boundary for a stale page to cross.
 */
const ALLOWLIST: Record<string, string> = {
  "components/adminComp/AdminFirmPicker.tsx":
    "cross-firm admin lookup; query key carries no lawFirmId",
};

function allTsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return allTsFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

interface Site {
  relPath: string;
  line: number;
  snippet: string;
}

function findPlaceholderDataSites(): Site[] {
  const sites: Site[] = [];
  for (const file of allTsFiles(SRC_ROOT)) {
    const content = fs.readFileSync(file, "utf8");
    const relPath = path.relative(SRC_ROOT, file).split(path.sep).join("/");
    const regex = /placeholderData:/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const line = content.slice(0, match.index).split("\n").length;
      // A three-line window covers every existing form in this codebase: a
      // one-line `keepPreviousData,` / `(prev) => prev,`, and the guarded
      // multi-line `(prev, prevQuery) => (...)`.
      const windowLines = content.split("\n").slice(line - 1, line + 2);
      sites.push({ relPath, line, snippet: windowLines.join("\n") });
    }
  }
  return sites;
}

describe("every placeholderData on a firm-scoped query guards its query key", () => {
  it("uses the query-key guard, or is on the reviewed exemption list", () => {
    const sites = findPlaceholderDataSites();
    expect(sites.length).toBeGreaterThan(0); // sanity: the scan itself still finds real sites

    const violations = sites.filter((site) => {
      if (ALLOWLIST[site.relPath]) return false;
      return !site.snippet.includes("prevQuery");
    });

    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  src/${v.relPath}:${v.line}\n    ${v.snippet.trim().split("\n").join("\n    ")}`)
        .join("\n\n");
      throw new Error(
        `Found ${violations.length} placeholderData site(s) with no query-key guard. ` +
          `Add the (prev, prevQuery) => (prevQuery?.queryKey?.[N] === <id> ? prev : undefined) ` +
          `form, or add the file to ALLOWLIST in this test with a reason:\n\n${detail}`,
      );
    }
  });

  it("does not let a stale allowlist entry hide behind a since-fixed site", () => {
    const sites = findPlaceholderDataSites();
    const seenPaths = new Set(sites.map((s) => s.relPath));
    for (const allowedPath of Object.keys(ALLOWLIST)) {
      expect(seenPaths.has(allowedPath)).toBe(true);
    }
  });
});
