// test/posPromotions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePromotion, isPromotionActive, promotionApplies, resolveExtraDiscount } from '../posPromotions.mjs';

const NOW = new Date('2026-10-20T15:00:00-03:00').getTime();
const decorador = {
  id: 'deco', name: 'Decorador/Arquitecto', kind: 'auto', type: 'pct', value: 5, active: true,
  requiresPaymentMethodId: 'efectivo', requiresCustomerTagId: 1, from: null, to: null, code: null,
};
const cupon = { id: 'c1', name: 'Cupón 10', kind: 'cupon', code: 'HOLA10', type: 'pct', value: 10, active: true, from: null, to: null };
const motivo = { id: 'm1', name: 'Cliente frecuente', kind: 'motivo', type: 'amount', value: 2000, active: true, from: null, to: null };
const vencida = { ...cupon, id: 'c2', code: 'VIEJO', to: '2026-10-01' };

test('isPromotionActive: respeta activo y fechas (fecha "hasta" inclusive)', () => {
  assert.equal(isPromotionActive(cupon, NOW), true);
  assert.equal(isPromotionActive({ ...cupon, active: false }, NOW), false);
  assert.equal(isPromotionActive(vencida, NOW), false);
  assert.equal(isPromotionActive({ ...cupon, from: '2026-10-21' }, NOW), false);
  assert.equal(isPromotionActive({ ...cupon, to: '2026-10-20' }, NOW), true);
});

test('promotionApplies: decorador solo con efectivo y cliente con la etiqueta', () => {
  assert.equal(promotionApplies(decorador, { paymentMethodIds: ['efectivo'], customerTagIds: [1], now: NOW }).ok, true);
  assert.equal(promotionApplies(decorador, { paymentMethodIds: ['efectivo', 'credito'], customerTagIds: [1], now: NOW }).ok, false);
  assert.equal(promotionApplies(decorador, { paymentMethodIds: ['efectivo'], customerTagIds: [], now: NOW }).ok, false);
});

test('resolveExtraDiscount: cupón por código (sin distinguir mayúsculas)', () => {
  const r = resolveExtraDiscount([cupon, motivo], { code: 'hola10' }, { paymentMethodIds: ['credito'], customerTagIds: [], now: NOW });
  assert.deepEqual(r, { promotionId: 'c1', name: 'Cupón 10', type: 'pct', value: 10 });
});

test('resolveExtraDiscount: código inexistente o vencido → error claro', () => {
  const ctx = { paymentMethodIds: ['credito'], customerTagIds: [], now: NOW };
  assert.throws(() => resolveExtraDiscount([cupon], { code: 'NADA' }, ctx), /no existe/);
  assert.throws(() => resolveExtraDiscount([vencida], { code: 'VIEJO' }, ctx), /no está vigente/);
});

test('resolveExtraDiscount: la elección de caja gana sobre la automática; sin elección, aplica la automática', () => {
  const ctx = { paymentMethodIds: ['efectivo'], customerTagIds: [1], now: NOW };
  assert.equal(resolveExtraDiscount([decorador, motivo], { promotionId: 'm1' }, ctx).promotionId, 'm1');
  assert.equal(resolveExtraDiscount([decorador, motivo], {}, ctx).promotionId, 'deco');
  assert.equal(resolveExtraDiscount([decorador], {}, { ...ctx, customerTagIds: [] }), null);
});

test('resolveExtraDiscount: un motivo que pide otro medio de pago → error', () => {
  const soloEfectivo = { ...motivo, requiresPaymentMethodId: 'efectivo' };
  assert.throws(
    () => resolveExtraDiscount([soloEfectivo], { promotionId: 'm1' }, { paymentMethodIds: ['credito'], customerTagIds: [], now: NOW }),
    /solo con/,
  );
});

test('validatePromotion: % entre 1 y 100, monto > 0, cupón con código único', () => {
  assert.deepEqual(validatePromotion({ ...cupon, value: 150 }, []), ['El porcentaje tiene que estar entre 1 y 100']);
  assert.deepEqual(validatePromotion({ ...motivo, value: 0 }, []), ['El monto tiene que ser mayor a 0']);
  assert.deepEqual(validatePromotion({ ...cupon, code: '' }, []), ['El cupón necesita un código']);
  assert.deepEqual(validatePromotion({ ...cupon, id: 'otro' }, [cupon]), ['Ya hay un cupón activo con ese código']);
});

test('validatePromotion: un cupón vencido con el mismo código no bloquea uno nuevo activo', () => {
  const expired = { ...cupon, id: 'old', code: 'REUSO', to: '2026-10-01' };
  const fresh = { ...cupon, id: 'new', code: 'REUSO' };
  assert.deepEqual(validatePromotion(fresh, [expired], NOW), []);
});

test('validatePromotion: guardar un cupón inactivo con código ya usado por uno activo está permitido', () => {
  const inactive = { ...cupon, id: 'draft', code: 'HOLA10', active: false };
  assert.deepEqual(validatePromotion(inactive, [cupon], NOW), []);
});

test('validatePromotion: fecha con formato inválido se rechaza', () => {
  const msg = 'Fecha inválida (usá AAAA-MM-DD)';
  assert.deepEqual(validatePromotion({ ...motivo, to: '20/10/2026' }, [], NOW), [msg]);
  assert.deepEqual(validatePromotion({ ...motivo, from: '2026-10-1' }, [], NOW), [msg]);
  assert.deepEqual(validatePromotion({ ...motivo, from: '2026-10-01', to: '2026-10-31' }, [], NOW), []);
});

test('validatePromotion: monto Infinity se rechaza', () => {
  assert.deepEqual(validatePromotion({ ...motivo, value: Infinity }, [], NOW), ['El monto tiene que ser mayor a 0']);
});
