# Altorancho Reportes — Backend

Sincroniza ventas de Odoo (locales + mayorista) y Tienda Nube (ecommerce) a
Firestore, y expone `/api/report` para el dashboard.

## Variables de entorno (configurar en Railway)

Ver `.env.example` para la lista completa: credenciales de Odoo, Tienda Nube,
Firebase, `DASHBOARD_PASSWORD`, `AUTH_SECRET`, `SYNC_INTERVAL_HOURS`,
`ALLOWED_ORIGIN` (poner el dominio del frontend en Hostinger/GoDaddy una vez
desplegado, en vez de `*`).

### ⚠️ Seguridad: Valores aleatorios requeridos

Los valores en `.env.example` para `AUTH_SECRET` y `DASHBOARD_PASSWORD` son
placeholders de ejemplo. **ANTES de cualquier deploy a producción**, estos DEBEN
ser reemplazados por valores aleatorios seguros:

- `AUTH_SECRET`: Generar una cadena aleatoria de 32+ caracteres (se usa para
  firmar JWT tokens). Ejemplo: usar `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `DASHBOARD_PASSWORD`: Generar una contraseña fuerte única (no usar el
  placeholder `change-this`). Esta es la credencial para acceder a `/api/report`.

Sin estos cambios, el backend será vulnerable a autenticación débil.

## Firestore: índice compuesto requerido

`querySalesByRange` (usado por `/api/report`) combina `.where('channel', 'in', channels)`
con un rango en `.where('date', ...)`, lo cual requiere un índice compuesto en
`altorancho_reportes_sales`: `channel` (Arrays/IN) + `date` (Ascending). Está
descripto en `firestore.indexes.json` (`firebase deploy --only firestore:indexes`
lo crea).

En un proyecto de Firebase nuevo, si no se desplegó ese índice, el primer
llamado a `/api/report` va a devolver un error 500 de Firestore que incluye un
link directo a la consola para crear el índice. Basta con abrir ese link una
vez, esperar ~1 minuto a que el índice termine de construirse, y reintentar.

## Backfill inicial

Una sola vez, después del primer deploy, correr localmente (no como parte del
deploy de Railway):

    npm run backfill -- --months=14

## Desarrollo local

    npm install
    npm run dev
    npm test
