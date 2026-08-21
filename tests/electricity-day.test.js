const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
    classifyElectricityDay,
    createFailureResult,
    expectedHourlyIntervals,
    resolveElectricityDay
} = require("../services/electricity-day");
const { normalizeProviderValues } = require("../models/electricidad.precios");

function pricedIntervals(date) {
    return expectedHourlyIntervals(date).map((interval, index) => ({
        ...interval,
        valueEurMWh: index
    }));
}

function classify(date, values, overrides = {}) {
    return classifyElectricityDay({
        selector: "today",
        resolvedDate: date,
        values,
        now: `${date}T12:00:00+01:00`,
        ...overrides
    });
}

describe("Madrid electricity days", () => {
    it("resolves selectors and 23-, 24-, and 25-hour calendar days", () => {
        assert.equal(resolveElectricityDay("today", "2024-03-30T23:30:00Z").resolvedDate, "2024-03-31");
        assert.equal(resolveElectricityDay("tomorrow", "2024-03-30T23:30:00Z").resolvedDate, "2024-04-01");

        for (const [date, count] of [["2024-03-31", 23], ["2024-01-15", 24], ["2024-10-27", 25]]) {
            const values = pricedIntervals(date);
            const result = classify(date, values);
            assert.equal(values.length, count);
            assert.equal(result.state, "available");
            assert.equal(result.expectedIntervalCount, count);
            assert.equal(result.receivedIntervalCount, count);
        }
    });

    it("preserves fallback 02:00 intervals as ordered, distinct instants and offsets", () => {
        const repeated = expectedHourlyIntervals("2024-10-27").filter(interval => interval.startsAt.includes("T02:00"));
        assert.deepEqual(repeated.map(value => value.utcOffsetMinutes), [120, 60]);
        assert.equal(new Set(repeated.map(value => value.instant)).size, 2);
        assert.deepEqual(repeated.map(value => value.instant), ["2024-10-27T00:00:00Z", "2024-10-27T01:00:00Z"]);

        const normalized = normalizeProviderValues(repeated.reverse().map((value, index) => ({
            datetime: value.startsAt,
            value: index
        })));
        assert.deepEqual(normalized.values.map(value => value.instant), ["2024-10-27T00:00:00Z", "2024-10-27T01:00:00Z"]);
    });

    it("gives strict pre-publication precedence to successful empty tomorrow data", () => {
        const result = classifyElectricityDay({
            selector: "tomorrow",
            resolvedDate: "2024-01-16",
            values: [],
            now: "2024-01-15T20:14:59+01:00"
        });
        assert.equal(result.state, "unavailable");
        assert.equal(result.reason, "before_publication");
        assert.equal(result.retryable, true);
        assert.equal(result.expectedPublicationAt, "2024-01-15T20:15:00+01:00");
    });

    it("forbids before_publication at and after 20:15 and distinguishes provider delay", () => {
        for (const now of ["2024-01-15T20:15:00+01:00", "2024-01-15T21:00:00+01:00"]) {
            const generic = classifyElectricityDay({
                selector: "tomorrow", resolvedDate: "2024-01-16", values: [], now
            });
            assert.equal(generic.state, "empty");
            assert.equal("reason" in generic, false);
            assert.equal("expectedPublicationAt" in generic, false);

            const delayed = classifyElectricityDay({
                selector: "tomorrow", resolvedDate: "2024-01-16", values: [], now, notPublished: true
            });
            assert.equal(delayed.state, "unavailable");
            assert.equal(delayed.reason, "provider_delay");
            assert.equal("expectedPublicationAt" in delayed, false);
        }
    });

    it("classifies missing, duplicate, extra, and invalid non-empty coverage as incomplete", () => {
        const date = "2024-01-15";
        const complete = pricedIntervals(date);
        const normalizedInvalid = normalizeProviderValues(complete.map((value, index) => ({
            datetime: index === 0 ? "invalid" : value.startsAt,
            value: value.valueEurMWh
        })));
        const normalizedInvalidValues = [" ", true].map(invalidValue => normalizeProviderValues(
            complete.map((value, index) => ({
                datetime: value.startsAt,
                value: index === 0 ? invalidValue : value.valueEurMWh
            }))
        ));
        for (const normalized of normalizedInvalidValues) {
            assert.equal(normalized.values.length, complete.length - 1);
            assert.equal(normalized.invalidIntervalCount, 1);
        }
        const cases = [
            classify(date, complete.slice(1)),
            classify(date, [...complete.slice(0, -1), complete[0]]),
            classify(date, [...complete, { ...complete[0], instant: "2024-01-16T23:00:00Z" }]),
            classify(date, normalizedInvalid.values, normalizedInvalid),
            ...normalizedInvalidValues.map(normalized => classify(date, normalized.values, normalized))
        ];
        for (const result of cases) {
            assert.equal(result.state, "incomplete");
            assert.equal(result.reason, "coverage_mismatch");
        }
    });

    it("constructs only fields allowed by each exhaustive result variant", () => {
        const date = "2024-01-15";
        const variants = {
            available: classify(date, pricedIntervals(date)),
            unavailable: classifyElectricityDay({
                selector: "tomorrow", resolvedDate: "2024-01-16", values: [], now: "2024-01-15T20:00:00+01:00"
            }),
            incomplete: classify(date, pricedIntervals(date).slice(1)),
            empty: classify(date, []),
            failure: createFailureResult({
                selector: "today", resolvedDate: date, retryable: true,
                error: { code: "transport", message: "offline" }
            })
        };
        assert.deepEqual(Object.keys(variants).sort(), ["available", "empty", "failure", "incomplete", "unavailable"]);
        assert.equal("reason" in variants.available, false);
        assert.equal("retryable" in variants.empty, false);
        assert.equal("error" in variants.incomplete, false);
        assert.equal("expectedPublicationAt" in variants.failure, false);
        assert.deepEqual(variants.unavailable.values, []);
    });
});
