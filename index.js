// Primer paso, configurar express
const express = require('express'); // Traemos la libreria
const cors = require('cors');
require('dotenv').config(); // Cargamos las variables del ficher .env en process.env

const app = express(); 

// Config, especificamos que nuestra app va a tratar las peticiones como si fuesen objetos
// y podremos recuperarlas dentro del req.body()
// app.use(cors({
//   origin: ['https://appluzfront.vercel.app', 'https://appluzfront-kkbvy1nw9-deimoss-projects.vercel.app/'],
//   methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
//   credentials: true, // Habilita el envío de cookies de manera segura entre el cliente y el servidor
//   optionsSuccessStatus: 204, // Responde con un 204 (sin contenido) para las solicitudes OPTIONS
//   }));
const allowedOrigins = [
  'http://localhost:4200',
  'http://localhost:3000',
  'http://localhost',
  'https://app-tarifa-luz-front.vercel.app',
  'https://app-tarifa-luz-front-git-main-deimoss-projects.vercel.app',
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

      const isLocalHost = /^http:\/\/localhost(:\d+)?$/.test(origin);
      const isVercelFrontend = /^https:\/\/.*\.vercel\.app$/.test(origin);
      const isAllowed = allowedOrigins.includes(origin) || isLocalHost || isVercelFrontend;

      if (isAllowed) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS no permitido para: ${origin}`));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: false}));

// Pensar en las rutas que vamos a usar para la llamada,para este caso y de momento será para obtener los datos de peninsula
// TODO hacer rutas para canarias, ceuta y melilla
// Peninsula -> GET /api/precios/peninsula
// Delegamos la peticiones que vayan por la ruta /api al fichero api.js
app.use('/api', require('./routes/api'));

// Ponemos la aplicación a escuchar
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor escuchando en puerto ${PORT}`);
});