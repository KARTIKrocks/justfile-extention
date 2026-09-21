/**
 * The differential suite.
 *
 * Every fixture is parsed twice — by us and by `just` — and the two must agree.
 * This is the safety net the rest of the extension is built on: it is what lets
 * Tier 1 be fast and local without drifting away from the tool it models.
 *
 * A failure here means our parser is wrong. Fix the parser, not the comparison.
 */

import { describe, expect, it } from "vitest";
import {
    capabilitiesFor,
    comparableFromDump,
    comparableFromParser,
    dumpWithJust,
    type Fixture,
    justVersion,
    loadFixtures,
    MINIMUM_SUPPORTED_VERSION,
    versionAtLeast,
} from "./harness.js";

const fixtures = loadFixtures();
const installed = justVersion();
// Only compare fields this version of just actually reports.
const caps = capabilitiesFor(installed);

describe(`differential against just ${installed}`, () => {
    it("has fixtures to compare", () => {
        expect(fixtures.length).toBeGreaterThan(0);
    });

    it("runs against a just new enough to be meaningful", () => {
        expect(versionAtLeast(installed, MINIMUM_SUPPORTED_VERSION)).toBe(true);
    });

    for (const fixture of fixtures) {
        const skip = fixture.requires !== undefined && !versionAtLeast(installed, fixture.requires);

        it.skipIf(skip)(`agrees with just on ${fixture.name}`, () => {
            const dump = dumpWithJust(fixture.path);

            // A fixture just itself rejects is a broken fixture, not a parser
            // bug. Fail loudly rather than silently comparing nothing.
            expect(dump.ok, `just rejected ${fixture.name}:\n${dump.stderr ?? ""}`).toBe(true);

            const fromJust = comparableFromDump(dump.json, caps);
            const fromUs = comparableFromParser(fixture.source, caps);

            expect(fromUs).toEqual(fromJust);
        });
    }
});

describe("parser totality over fixtures", () => {
    // Truncating a file at every byte simulates typing it, and is the cheapest
    // way to find inputs that make a parser throw or hang.
    const truncations = (fixture: Fixture): string[] => {
        const points: string[] = [];
        for (let i = 0; i <= fixture.source.length; i += 7) {
            points.push(fixture.source.slice(0, i));
        }
        return points;
    };

    for (const fixture of fixtures) {
        it(`survives every truncation of ${fixture.name}`, () => {
            for (const prefix of truncations(fixture)) {
                expect(() => comparableFromParser(prefix, caps)).not.toThrow();
            }
        });
    }
});
