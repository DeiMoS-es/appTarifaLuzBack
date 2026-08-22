// Encargado de gestionar las peticiones para obtener los precios de las distintas CCAA
const express = require("express");
const { normalizeProviderValues } = require("../../models/electricidad.precios");
const {
    classifyElectricityDay,
    createFailureResult,
    resolveElectricityDay,
    selectElectricityDayValues
} = require("../../services/electricity-day");
const axios = require("axios");

class MalformedProviderPayloadError extends Error {}

const NOT_PUBLISHED_DETAILS = new Set([
    "Los datos solicitados no están disponibles en este momento",
    "Los datos solicitados no están disponibles en este momento. Inténtelo de nuevo más tarde."
]);

function isProviderNotPublishedError(error) {
    const providerErrors = error?.response?.data?.errors;
    return error?.response?.status === 502
        && Array.isArray(providerErrors)
        && providerErrors.some(providerError => typeof providerError?.detail === "string"
            && NOT_PUBLISHED_DETAILS.has(providerError.detail.trim()));
}

function buildProviderUrl(template, day) {
    const url = new URL(template);
    url.searchParams.set("start_date", day.startsAt);
    url.searchParams.set("end_date", day.endsAt);
    return url.toString();
}

async function defaultProvider(request) {
    try {
        return await axios.get(request.url);
    } catch (error) {
        if (request.selector === "tomorrow" && isProviderNotPublishedError(error)) {
            return { data: { included: [] }, notPublished: true };
        }
        throw error;
    }
}

function providerValues(response) {
    const included = response?.data?.included;
    if (!Array.isArray(included)) throw new MalformedProviderPayloadError();

    const items = [];
    for (const group of included) {
        if (!Array.isArray(group?.attributes?.values)) throw new MalformedProviderPayloadError();
        items.push(...group.attributes.values);
    }
    return items;
}

function publicFailure(error) {
    if (error instanceof MalformedProviderPayloadError) {
        return { retryable: false, error: { code: "malformed_payload", message: "Electricity price provider returned an invalid payload" } };
    }
    if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT") {
        return { retryable: true, error: { code: "timeout", message: "Electricity price provider timed out" } };
    }
    if (error?.response) {
        return {
            retryable: error.response.status >= 500,
            error: { code: "provider", message: "Electricity price provider rejected the request" }
        };
    }
    return { retryable: true, error: { code: "transport", message: "Electricity price provider is unavailable" } };
}

function createRouter({
    provider = defaultProvider,
    clock = () => new Date(),
    apiUri = () => process.env.APIREDTADAURI
} = {}) {
    const router = express.Router();

    router.get('/', async (req, res) => {// Petición sobre la ruta /api/precios
        const now = clock();
        let day;
        try {
            day = resolveElectricityDay(req.query.day, now);
        } catch (error) {
            return res.status(400).json({
                error: { code: "invalid_day", message: "day must be today or tomorrow" }
            });
        }

        try {
            const url = buildProviderUrl(apiUri(), day);
            const response = await provider({ url, ...day });
            const normalized = selectElectricityDayValues(
                day.resolvedDate,
                normalizeProviderValues(providerValues(response))
            );
            const result = classifyElectricityDay({
                ...day,
                ...normalized,
                notPublished: response.notPublished === true,
                now
            });
            return res.status(200).json(result);
        } catch (error) {
            const failure = createFailureResult({ ...day, ...publicFailure(error) });
            return res.status(502).json(failure);
        }
    });

    return router;
}

const router = createRouter();

/*
router.get("/", async (req, res) => {
  // Petición sobre la ruta /api/precios
  try {
    const apiUri = getApiUrl();
    const response = await axios.get(apiUri);
    const precioData = new precioModel(response.data);
    res.json(precioData);
  } catch (err) {
    res.json({ error: err.message });
  }
});

&geo_limit=peninsular&geo_ids=8741
&geo_limit=canarias&geo_ids=8742
&geo_limit=baleares&geo_ids=8743
&geo_limit=ceuta&geo_ids=8744
&geo_limit=melilla&geo_ids=8745
Ejemplo para cuando añada la opción de seleccionar la zona, zona será un parámetro que nos viene por url
Buscando información el precio de la luz es el mismo en todo el territorio español
router.get("/:zone", async (req, res) => {
  try {
    console.log("Entro");
    const { zone } = req.params;
    const apiUri = getApiUrl(zone);
    const response = await axios.get(apiUri);
    res.json(response);
  } catch (error) {
    res.json({ error: error.message });
  }
});
*/

// const getApiUrl = (zone = "peninsular") => {
//   const currentDate = moment().format("YYYY-MM-DD");
//   const nextDayDate = moment().add(1, "day").format("YYYY-MM-DD");

//   let geoIds;
//   switch (zone) {
//     case "peninsular":
//       geoIds = "8741";
//       break;
//     case "canarias":
//       geoIds = "8742";
//       break;
//     case "baleares":
//       geoIds = "8743";
//       break;
//     case "ceuta":
//       geoIds = "8744";
//       break;
//     case "melilla":
//       geoIds = "8745";
//       break;
//     default:
//       geoIds = "8741"; // Valor predeterminado para peninsular en caso de zona no reconocida
//   }

//   return process.env.APIREDTADAURI
//     .replace(/start_date=[^&]*/, `start_date=${currentDate}`)
//     .replace(/end_date=[^&]*/, `end_date=${nextDayDate}`)
//     .replace(/&geo_limit=[^&]*/, `&geo_limit=${zone}`)
//     .replace(/&geo_ids=[^&]*/, `&geo_ids=${geoIds}`);
// };


module.exports = router;
module.exports.createRouter = createRouter;
module.exports.buildProviderUrl = buildProviderUrl;
module.exports.isProviderNotPublishedError = isProviderNotPublishedError;
