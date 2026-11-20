import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backgroundJobsEnabled, assertSafeDevEnv } from '../runtimeFlags.mjs';

test('backgroundJobsEnabled: apagado solo con DISABLE_CRONS=true', () => {
  assert.equal(backgroundJobsEnabled({ DISABLE_CRONS: 'true' }), false);
  assert.equal(backgroundJobsEnabled({}), true);
  assert.equal(backgroundJobsEnabled({ DISABLE_CRONS: 'false' }), true);
});

test('assertSafeDevEnv: en development exige ODOO_WRITES=dry', () => {
  assert.throws(() => assertSafeDevEnv({ NODE_ENV: 'development', DOTENV_CONFIG_PATH: '.env.development' }), /ODOO_WRITES=dry/);
});

test('assertSafeDevEnv: en development exige DOTENV_CONFIG_PATH a .env.development', () => {
  assert.throws(() => assertSafeDevEnv({ NODE_ENV: 'development', ODOO_WRITES: 'dry' }), /DOTENV_CONFIG_PATH/);
  assert.throws(() => assertSafeDevEnv({ NODE_ENV: 'development', ODOO_WRITES: 'dry', DOTENV_CONFIG_PATH: '.env' }), /DOTENV_CONFIG_PATH/);
});

test('assertSafeDevEnv: configuración dev correcta no tira', () => {
  assert.doesNotThrow(() => assertSafeDevEnv({ NODE_ENV: 'development', ODOO_WRITES: 'dry', DOTENV_CONFIG_PATH: '.env.development' }));
  assert.doesNotThrow(() => assertSafeDevEnv({ NODE_ENV: 'development', ODOO_WRITES: 'dry', DOTENV_CONFIG_PATH: './x/.env.development' }));
});

test('assertSafeDevEnv: fuera de development no hace nada', () => {
  assert.doesNotThrow(() => assertSafeDevEnv({}));
  assert.doesNotThrow(() => assertSafeDevEnv({ NODE_ENV: 'production' }));
});
