// Flags de ejecución para desarrollo local seguro.

// Crons y reintentos en segundo plano: se apagan con DISABLE_CRONS=true.
export function backgroundJobsEnabled(env = process.env) {
  return env.DISABLE_CRONS !== 'true';
}

// En NODE_ENV=development exige escrituras Odoo simuladas y que dotenv lea
// .env.development (nunca el .env de producción).
export function assertSafeDevEnv(env = process.env) {
  if (env.NODE_ENV !== 'development') return;
  if (env.ODOO_WRITES !== 'dry') {
    throw new Error('Modo dev inseguro: NODE_ENV=development requiere ODOO_WRITES=dry');
  }
  if (!/(^|[\/])\.env\.development$/.test(env.DOTENV_CONFIG_PATH || '')) {
    throw new Error('Modo dev inseguro: NODE_ENV=development requiere DOTENV_CONFIG_PATH=.env.development');
  }
}
