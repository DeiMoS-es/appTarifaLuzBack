const assert = require("node:assert/strict");
const http = require("node:http");
const { describe, it } = require("node:test");
const axios = require("axios");
const express = require("express");
const { expectedHourlyIntervals } = require("../services/electricity-day");
const { createRouter, isProviderNotPublishedError } = require("../routes/api/precios");

const API_TEMPLATE = "https://provider.test/prices?start_date=old&end_date=old";
const SHORT_NOT_PUBLISHED_DETAIL = "Los datos solicitados no están disponibles en este momento";
const CURRENT_NOT_PUBLISHED_DETAIL = `${SHORT_NOT_PUBLISHED_DETAIL}. Inténtelo de nuevo más tarde.`;

function providerError(status, detail) {
    return { response: { status, data: { errors: [{ detail }] } } };
}

function providerPayload(date, transform = values => values) {
    const values = expectedHourlyIntervals(date).map((interval, index) => ({
        datetime: interval.startsAt,
        value: index + 1
    }));
    return {
        data: {
            data: { type: "PVPC" },
            included: [{ type: "EUR/MWh", attributes: { values: transform(values) } }]
        }
    };
}

async function request(path, { provider, clock = () => "2024-01-15T12:00:00+01:00" } = {}) {
    const app = express();
    app.use("/api/precios", createRouter({ provider, clock, apiUri: () => API_TEMPLATE }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

    try {
        const address = server.address();
        return await new Promise((resolve, reject) => {
            http.get({ hostname: "127.0.0.1", port: address.port, path }, response => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", chunk => { body += chunk; });
                response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
            }).on("error", reject);
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

describe("GET /api/precios day contract", () => {
    it("retrieves today and tomorrow as separate complete Madrid ranges", async () => {
        const calls = [];
        const provider = async call => {
            calls.push(call);
            return providerPayload(call.resolvedDate);
        };

        const today = await request("/api/precios?day=today", { provider });
        const tomorrow = await request("/api/precios?day=tomorrow", { provider });

        assert.equal(today.status, 200);
        assert.equal(today.body.state, "available");
        assert.equal(today.body.resolvedDate, "2024-01-15");
        assert.equal(tomorrow.status, 200);
        assert.equal(tomorrow.body.state, "available");
        assert.equal(tomorrow.body.resolvedDate, "2024-01-16");
        assert.deepEqual(calls.map(call => {
            const url = new URL(call.url);
            return [url.searchParams.get("start_date"), url.searchParams.get("end_date")];
        }), [
            ["2024-01-15T00:00:00+01:00", "2024-01-16T00:00:00+01:00"],
            ["2024-01-16T00:00:00+01:00", "2024-01-17T00:00:00+01:00"]
        ]);
    });

    it("excludes an invalid inclusive next-midnight sample from today without stealing it from tomorrow", async () => {
        const provider = call => providerPayload(call.resolvedDate, values => {
            if (call.selector !== "today") return values;
            const tomorrowMidnight = expectedHourlyIntervals("2024-01-16")[0];
            return [...values, { datetime: tomorrowMidnight.startsAt, value: "invalid" }];
        });

        const today = await request("/api/precios?day=today", { provider });
        const tomorrow = await request("/api/precios?day=tomorrow", { provider });
        const todayInstants = new Set(today.body.values.map(value => value.instant));
        const tomorrowInstants = new Set(tomorrow.body.values.map(value => value.instant));

        assert.equal(today.body.state, "available");
        assert.equal(today.body.expectedIntervalCount, 24);
        assert.equal(today.body.receivedIntervalCount, 24);
        assert.equal(today.body.values.length, 24);
        assert.equal(today.body.values.at(-1).startsAt, "2024-01-15T23:00:00+01:00");
        assert.equal(tomorrow.body.state, "available");
        assert.equal(tomorrow.body.values[0].startsAt, "2024-01-16T00:00:00+01:00");
        assert.equal([...todayInstants].some(instant => tomorrowInstants.has(instant)), false);
    });

    it("reports an in-day noncanonical interval as incomplete coverage", async () => {
        const response = await request("/api/precios?day=today", {
            provider: call => providerPayload(call.resolvedDate, values => [
                ...values,
                { datetime: "2024-01-15T00:30:00+01:00", value: 99 }
            ])
        });

        assert.equal(response.status, 200);
        assert.equal(response.body.state, "incomplete");
        assert.equal(response.body.reason, "coverage_mismatch");
        assert.equal(response.body.expectedIntervalCount, 24);
        assert.equal(response.body.receivedIntervalCount, 25);
        assert.equal(response.body.values.length, 24);
        assert.equal(response.body.values.some(value => value.startsAt.includes("T00:30")), false);
    });

    it("returns 400 for unsupported, malformed, or unrelated selectors", async () => {
        const provider = async () => { throw new Error("provider must not be called"); };
        for (const path of [
            "/api/precios?day=yesterday",
            "/api/precios?day=today&day=tomorrow",
            "/api/precios?zone=peninsular"
        ]) {
            const response = await request(path, { provider });
            assert.equal(response.status, 400);
            assert.equal(response.body.error.code, "invalid_day");
        }
    });

    it("maps available, unavailable, incomplete, and empty domain states to 200", async () => {
        const cases = [
            {
                expected: "available",
                path: "/api/precios?day=today",
                provider: call => providerPayload(call.resolvedDate)
            },
            {
                expected: "unavailable",
                path: "/api/precios?day=tomorrow",
                provider: async () => ({ data: { included: [] } })
            },
            {
                expected: "incomplete",
                path: "/api/precios?day=today",
                provider: call => providerPayload(call.resolvedDate, values => values.slice(1))
            },
            {
                expected: "empty",
                path: "/api/precios?day=today",
                provider: async () => ({ data: { included: [] } })
            }
        ];

        for (const testCase of cases) {
            const response = await request(testCase.path, { provider: testCase.provider });
            assert.equal(response.status, 200);
            assert.equal(response.body.state, testCase.expected);
        }
    });

    it("preserves publication precedence and provider-delay semantics", async () => {
        const emptyProvider = async () => ({ data: { included: [] } });
        const before = await request("/api/precios?day=tomorrow", {
            provider: emptyProvider,
            clock: () => "2024-01-15T20:14:59+01:00"
        });
        const delayed = await request("/api/precios?day=tomorrow", {
            provider: async () => ({ data: { included: [] }, notPublished: true }),
            clock: () => "2024-01-15T20:15:00+01:00"
        });

        assert.equal(before.body.reason, "before_publication");
        assert.equal(before.body.expectedPublicationAt, "2024-01-15T20:15:00+01:00");
        assert.equal(delayed.status, 200);
        assert.equal(delayed.body.state, "unavailable");
        assert.equal(delayed.body.reason, "provider_delay");
    });

    it("recognizes only anchored 502 provider not-published details", () => {
        assert.equal(isProviderNotPublishedError(providerError(502, SHORT_NOT_PUBLISHED_DETAIL)), true);
        assert.equal(isProviderNotPublishedError(providerError(502, CURRENT_NOT_PUBLISHED_DETAIL)), true);
        assert.equal(isProviderNotPublishedError(providerError(502, `  ${CURRENT_NOT_PUBLISHED_DETAIL}\n`)), true);
        assert.equal(isProviderNotPublishedError(providerError(404, CURRENT_NOT_PUBLISHED_DETAIL)), false);
        assert.equal(isProviderNotPublishedError(providerError(502, "Bad gateway")), false);
        assert.deepEqual([
            `${SHORT_NOT_PUBLISHED_DETAIL}.`,
            `${SHORT_NOT_PUBLISHED_DETAIL} Inténtelo de nuevo más tarde.`,
            `${SHORT_NOT_PUBLISHED_DETAIL}.\nInténtelo de nuevo más tarde.`,
            `${SHORT_NOT_PUBLISHED_DETAIL}.  Inténtelo de nuevo más tarde.`,
            `${SHORT_NOT_PUBLISHED_DETAIL}. Unknown suffix`
        ].map(detail => isProviderNotPublishedError(providerError(502, detail))), [
            false,
            false,
            false,
            false,
            false
        ]);

        for (const malformed of [
            { response: { status: 502, data: {} } },
            { response: { status: 502, data: { errors: {} } } },
            providerError(502, null)
        ]) {
            assert.equal(isProviderNotPublishedError(malformed), false);
        }
    });

    it("maps the current production signal by publication time and selector", async () => {
        const originalGet = axios.get;
        try {
            axios.get = async () => {
                const error = new Error("not published");
                Object.assign(error, providerError(502, CURRENT_NOT_PUBLISHED_DETAIL));
                throw error;
            };

            const beforePublication = await request("/api/precios?day=tomorrow", {
                clock: () => "2024-01-15T20:14:59+01:00"
            });
            const delayed = await request("/api/precios?day=tomorrow", {
                clock: () => "2024-01-15T20:15:00+01:00"
            });
            const today = await request("/api/precios?day=today", {
                clock: () => "2024-01-15T20:15:00+01:00"
            });

            assert.equal(beforePublication.status, 200);
            assert.equal(beforePublication.body.state, "unavailable");
            assert.equal(beforePublication.body.reason, "before_publication");
            assert.equal(delayed.status, 200);
            assert.equal(delayed.body.state, "unavailable");
            assert.equal(delayed.body.reason, "provider_delay");
            assert.equal(today.status, 502);
            assert.equal(today.body.state, "failure");
            assert.equal(today.body.error.code, "provider");
        } finally {
            axios.get = originalGet;
        }
    });

    it("returns typed 502 failures without exposing provider error details", async () => {
        const secret = "https://provider.test/?token=secret";
        const timeout = new Error(secret);
        timeout.code = "ETIMEDOUT";
        const timedOut = await request("/api/precios?day=today", {
            provider: async () => { throw timeout; }
        });
        const malformed = await request("/api/precios?day=today", {
            provider: async () => ({ data: { unexpected: true } })
        });

        assert.equal(timedOut.status, 502);
        assert.equal(timedOut.body.state, "failure");
        assert.equal(timedOut.body.error.code, "timeout");
        assert.equal(JSON.stringify(timedOut.body).includes("secret"), false);
        assert.equal(malformed.status, 502);
        assert.equal(malformed.body.error.code, "malformed_payload");
    });

    it("requires the day selector when no query is provided", async () => {
        const response = await request("/api/precios", {
            provider: async () => { throw new Error("provider must not be called"); }
        });

        assert.equal(response.status, 400);
        assert.deepEqual(response.body, {
            error: { code: "invalid_day", message: "day must be today or tomorrow" }
        });
    });
});
