/**
 * Comparing `just` version strings.
 *
 * Tier 1: no VS Code API, no I/O, no subprocesses. See AGENTS.md. Pure so it
 * can be tested without spawning anything, and so the differential test
 * harness — which needs the identical comparison to decide what a given
 * binary can be expected to support — can share this rather than keep its
 * own copy in sync by hand.
 */

/**
 * The oldest `just` release this extension supports.
 *
 * PRD 8.29: the release that introduced `[group]` and `[doc]`, which the
 * Explorer and hover surfaces depend on. Below this the extension runs in
 * reduced mode — Tier 1 plus recipe execution — and says so once rather than
 * repeatedly.
 */
export const MINIMUM_SUPPORTED_VERSION = "1.27.0";

/** Compare dotted version strings numerically. Returns true when `a` >= `b`. */
export function versionAtLeast(a: string, b: string): boolean {
    const partsOf = (v: string): number[] => v.split(".").map(Number);
    const pa = partsOf(a);
    const pb = partsOf(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (x !== y) {
            return x > y;
        }
    }
    return true;
}
