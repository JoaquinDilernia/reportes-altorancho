# Altorancho Reportes — Frontend

Dashboard de React que consume la API del backend (`../backend`) para mostrar
el reporte semanal/mensual/por rango de ventas.

## Desarrollo local

    npm install
    cp .env.example .env   # ajustar VITE_API_URL al puerto real del backend local
    npm run dev
    npm test

Necesita el backend corriendo (`cd ../backend && npm run dev`) para poder loguearse
y ver datos reales.

## Build de producción

    npm run build

Genera `dist/` — subir el contenido de esa carpeta por FTP/cPanel a Hostinger o
GoDaddy, en el dominio `reportes.techdi.com.ar`. `VITE_API_URL` se resuelve en
build time: correr `npm run build` con esa variable apuntando a la URL real del
backend en Railway antes de subir, por ejemplo:

    VITE_API_URL=https://tu-backend.up.railway.app npm run build

Después de cada deploy del backend a una URL nueva, hay que volver a correr el
build con la URL correcta y volver a subir `dist/` — la URL queda fija dentro
del bundle, no se lee en runtime.

## Variables de entorno

Ver `.env.example`. Solo hay una: `VITE_API_URL`, la URL base del backend.
