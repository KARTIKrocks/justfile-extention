import { describe, expect, it } from "vitest";
import { MINIMUM_SUPPORTED_VERSION, versionAtLeast } from "./version.js";

describe("versionAtLeast", () => {
    it("is true when equal", () => {
        expect(versionAtLeast("1.27.0", "1.27.0")).toBe(true);
    });

    it("is true when strictly newer", () => {
        expect(versionAtLeast("1.58.0", "1.27.0")).toBe(true);
        expect(versionAtLeast("2.0.0", "1.58.0")).toBe(true);
        expect(versionAtLeast("1.27.1", "1.27.0")).toBe(true);
    });

    it("is false when strictly older", () => {
        expect(versionAtLeast("1.21.0", "1.27.0")).toBe(false);
        expect(versionAtLeast("1.27.0", "1.27.1")).toBe(false);
        expect(versionAtLeast("0.9.9", "1.0.0")).toBe(false);
    });

    it("treats a missing trailing component as zero", () => {
        expect(versionAtLeast("1.27", "1.27.0")).toBe(true);
        expect(versionAtLeast("1.27.0", "1.27")).toBe(true);
        expect(versionAtLeast("1", "1.0.1")).toBe(false);
    });

    it("compares numerically, not lexically", () => {
        // A string comparison would put "1.9.0" after "1.10.0".
        expect(versionAtLeast("1.10.0", "1.9.0")).toBe(true);
        expect(versionAtLeast("1.9.0", "1.10.0")).toBe(false);
    });
});

describe("MINIMUM_SUPPORTED_VERSION", () => {
    it("is 1.27.0, per PRD 8.29", () => {
        expect(MINIMUM_SUPPORTED_VERSION).toBe("1.27.0");
    });
});
