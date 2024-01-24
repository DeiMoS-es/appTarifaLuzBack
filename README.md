### Para arrancar la app:
En el package.json creamos el script "start": "node app.js".
Para no tener que estar apagando y arrancando la app, instalamos nodemon y creamos el script "dev": "nodemon app.js", así al hacer npm run dev, se arrancará la app y se quedará a la escucha de los cambios y reinicirá la app