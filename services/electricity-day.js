const { DateTime } = require("luxon");

const TIME_ZONE = "Europe/Madrid";
const SELECTORS = new Set(["today", "tomorrow"]);

function asMadridDateTime(value) {
    if (DateTime.isDateTime(value)) return value.setZone(TIME_ZONE);
    if (value instanceof Date) return DateTime.fromJSDate(value, { zone: TIME_ZONE });
    if (typeof value === "string") return DateTime.fromISO(value, { setZone: true }).setZone(TIME_ZONE);
    return DateTime.now().setZone(TIME_ZONE);
}

function dayStart(resolvedDate) {
    const start = DateTime.fromISO(resolvedDate, { zone: TIME_ZONE }).startOf("day");
    if (!start.isValid || start.toISODate() !== resolvedDate) {
        throw new RangeError("resolvedDate must be an ISO calendar date");
    }
    return start;
}

function expectedHourlyIntervals(resolvedDate) {
    const start = dayStart(resolvedDate);
    const end = start.plus({ days: 1 });
    const intervals = [];

    for (let cursor = start; cursor < end; cursor = cursor.plus({ hours: 1 })) {
        intervals.push({
            startsAt: cursor.toISO({ suppressMilliseconds: true }),
            instant: cursor.toUTC().toISO({ suppressMilliseconds: true }),
            utcOffsetMinutes: cursor.offset
        });
    }
    return intervals;
}

function expectedHourlyInstants(resolvedDate) {
    return expectedHourlyIntervals(resolvedDate).map(interval => interval.instant);
}

function selectElectricityDayValues(resolvedDate, normalized) {
    const expectedInstants = new Set(expectedHourlyInstants(resolvedDate));
    const start = dayStart(resolvedDate).toUTC().toMillis();
    const end = dayStart(resolvedDate).plus({ days: 1 }).toUTC().toMillis();
    let noncanonicalIntervalCount = 0;
    const values = normalized.values.filter(value => {
        if (expectedInstants.has(value.instant)) return true;
        const instant = DateTime.fromISO(value.instant, { setZone: true });
        if (instant.isValid && instant.toMillis() >= start && instant.toMillis() < end) {
            noncanonicalIntervalCount += 1;
        }
        return false;
    });
    const invalidIntervalCount = noncanonicalIntervalCount + (Array.isArray(normalized.invalidIntervals)
        ? normalized.invalidIntervals.filter(interval => {
            if (!interval?.instant) return true;
            const instant = DateTime.fromISO(interval.instant, { setZone: true });
            return !instant.isValid || (instant.toMillis() >= start && instant.toMillis() < end);
        }).length
        : normalized.invalidIntervalCount);

    return {
        values,
        receivedIntervalCount: values.length + invalidIntervalCount,
        invalidIntervalCount
    };
}

function resolveElectricityDay(selector, now) {
    if (!SELECTORS.has(selector)) throw new RangeError("day must be today or tomorrow");
    const madridNow = asMadridDateTime(now);
    if (!madridNow.isValid) throw new RangeError("now must be a valid timestamp");

    const start = madridNow.startOf("day").plus({ days: selector === "tomorrow" ? 1 : 0 });
    const end = start.plus({ days: 1 });
    return {
        selector,
        resolvedDate: start.toISODate(),
        timeZone: TIME_ZONE,
        startsAt: start.toISO({ suppressMilliseconds: true }),
        endsAt: end.toISO({ suppressMilliseconds: true })
    };
}

function resultBase(selector, resolvedDate, receivedIntervalCount) {
    const expectedIntervalCount = expectedHourlyIntervals(resolvedDate).length;
    return { selector, resolvedDate, timeZone: TIME_ZONE, expectedIntervalCount, receivedIntervalCount };
}

function hasExactCoverage(values, expected, invalidIntervalCount) {
    if (invalidIntervalCount !== 0 || values.length !== expected.length) return false;
    const expectedByInstant = new Map(expected.map(interval => [interval.instant, interval]));
    const seen = new Set();

    return values.every(value => {
        const match = value && expectedByInstant.get(value.instant);
        if (!match || seen.has(value.instant)) return false;
        seen.add(value.instant);
        return value.startsAt === match.startsAt
            && value.utcOffsetMinutes === match.utcOffsetMinutes
            && Number.isFinite(value.valueEurMWh);
    });
}

function classifyElectricityDay({
    selector,
    resolvedDate,
    values = [],
    receivedIntervalCount = values.length,
    invalidIntervalCount = 0,
    notPublished = false,
    now
}) {
    if (!SELECTORS.has(selector)) throw new RangeError("day must be today or tomorrow");
    const madridNow = asMadridDateTime(now);
    if (!madridNow.isValid) throw new RangeError("now must be a valid timestamp");

    const base = resultBase(selector, resolvedDate, receivedIntervalCount);
    if (receivedIntervalCount === 0) {
        const publicationAt = madridNow.startOf("day").set({ hour: 20, minute: 15, second: 0, millisecond: 0 });
        if (selector === "tomorrow" && madridNow < publicationAt) {
            return {
                ...base,
                state: "unavailable",
                values: [],
                retryable: true,
                reason: "before_publication",
                expectedPublicationAt: publicationAt.toISO({ suppressMilliseconds: true })
            };
        }
        if (selector === "tomorrow" && notPublished) {
            return { ...base, state: "unavailable", values: [], retryable: true, reason: "provider_delay" };
        }
        return { ...base, state: "empty", values: [] };
    }

    const expected = expectedHourlyIntervals(resolvedDate);
    if (!hasExactCoverage(values, expected, invalidIntervalCount)
        || receivedIntervalCount !== expected.length) {
        return { ...base, state: "incomplete", values, reason: "coverage_mismatch" };
    }
    return { ...base, state: "available", values };
}

function createFailureResult({ selector, resolvedDate, retryable, error }) {
    if (!SELECTORS.has(selector)) throw new RangeError("day must be today or tomorrow");
    if (!error || !["transport", "timeout", "provider", "malformed_payload"].includes(error.code)
        || typeof error.message !== "string") {
        throw new TypeError("failure error must match the result contract");
    }
    return {
        ...resultBase(selector, resolvedDate, 0),
        state: "failure",
        values: [],
        retryable: Boolean(retryable),
        error
    };
}

module.exports = {
    TIME_ZONE,
    resolveElectricityDay,
    expectedHourlyIntervals,
    expectedHourlyInstants,
    selectElectricityDayValues,
    classifyElectricityDay,
    createFailureResult
};
