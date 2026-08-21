const { DateTime } = require("luxon");

const TIME_ZONE = "Europe/Madrid";
const NUMERIC_VALUE_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function normalizeProviderValues(items) {
    const normalized = [];
    let invalidIntervalCount = 0;

    for (const item of items) {
        const value = item && item.value;
        const numericValue = typeof value === "number"
            ? value
            : typeof value === "string" && NUMERIC_VALUE_PATTERN.test(value) ? Number(value) : NaN;
        if (!item || typeof item.datetime !== "string"
            || !Number.isFinite(numericValue)) {
            invalidIntervalCount += 1;
            continue;
        }

        const startsAt = DateTime.fromISO(item.datetime, { setZone: true });
        if (!startsAt.isValid) {
            invalidIntervalCount += 1;
            continue;
        }

        const madridStart = startsAt.setZone(TIME_ZONE);
        normalized.push({
            startsAt: madridStart.toISO({ suppressMilliseconds: true }),
            instant: madridStart.toUTC().toISO({ suppressMilliseconds: true }),
            utcOffsetMinutes: madridStart.offset,
            valueEurMWh: numericValue
        });
    }

    normalized.sort((left, right) => left.instant.localeCompare(right.instant));
    return {
        values: normalized,
        receivedIntervalCount: items.length,
        invalidIntervalCount
    };
}

// Legacy response shape remains in place until the day-specific route is delivered.
class precioModel {
    constructor(response) {
        this.precioZona = response.data.type;
        // Comprueba si 'included' existe y tiene al menos un elemento
        if (response.included && response.included.length > 0) {
            this.moneda = response.included.map(item => item.type);
            this.preciosHoras = response.included.flatMap(item => item.attributes.values.map(valueItem => new Value(valueItem)));
        } else {
            this.moneda = [];
            this.preciosHoras = [];
        }
    }
}

class Value {
    constructor(item) {
        this.precio = item.value;
        this.datetime = item.datetime;
    }
}

module.exports = precioModel;
module.exports.normalizeProviderValues = normalizeProviderValues;
