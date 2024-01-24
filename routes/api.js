// encargado de gestionar todas las rutas de la api
const router = require('express').Router();

router.use('/precios', require('./api/precios')); // redirección para las peticiones de los precios


module.exports = router;