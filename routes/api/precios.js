// Encargado de gestionar las peticiones para obtener los precios de las distintas CCAA
const router = require("express").Router();
const precioModel = require("../../models/electricidad.precios");
const axios = require("axios");
const moment = require("moment");

router.get('/', async (req, res) => {// Petición sobre la ruta /api/precios
    try{
        const currentDate = moment().format('YYYY-MM-DD');
        const nextDayDate = moment().add(1, 'day').format('YYYY-MM-DD');
        const apiUri = process.env.APIREDTADAURI.replace(/start_date=[^&]*/, `start_date=${currentDate}`).replace(/end_date=[^&]*/, `end_date=${nextDayDate}`);
        const response = await axios.get(apiUri);
        const precioData = new precioModel(response.data);
        res.json(precioData);
    }catch(err){
        res.json({error: err.message});
    }
});
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
