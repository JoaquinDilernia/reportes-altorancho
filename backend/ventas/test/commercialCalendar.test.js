import { describe, it, expect } from 'vitest';
import { commercialCalendarFor } from '../src/ads/commercialCalendar.js';
import { SYSTEM_PROMPT } from '../src/ads/systemPrompt.js';
import { GOOGLE_SYSTEM_PROMPT } from '../src/gads/systemPrompt.js';

const EVENTS = [
  { name: 'Cyber', from: '2026-11-02', to: '2026-11-04', notes: 'n' },
  { name: 'Black', from: '2026-11-27', to: '2026-11-29', notes: 'n' },
  { name: 'Hot Sale', month: '2027-05', notes: 'sin fecha' },
];

describe('calendario comercial', () => {
  it('hoy (23/10): el Cyber está por venir y el Black también; el Hot Sale todavía no aparece', () => {
    expect(commercialCalendarFor('2026-10-23', EVENTS)).toEqual([
      { name: 'Cyber', from: '2026-11-02', to: '2026-11-04', phase: 'antes', daysUntil: 10, notes: 'n' },
      { name: 'Black', from: '2026-11-27', to: '2026-11-29', phase: 'antes', daysUntil: 35, notes: 'n' },
    ]);
  });

  it('durante el evento está en curso y dos semanas después sigue como "después"; más tarde desaparece', () => {
    expect(commercialCalendarFor('2026-11-03', EVENTS)[0]).toMatchObject({ name: 'Cyber', phase: 'en curso', daysUntil: 0 });
    expect(commercialCalendarFor('2026-11-18', EVENTS)[0]).toMatchObject({ name: 'Cyber', phase: 'después' });
    expect(commercialCalendarFor('2026-11-19', EVENTS).map((e) => e.name)).toEqual(['Black']);
  });

  it('un evento sin fecha aparece unos meses antes de su mes, para preguntar si ya está confirmado', () => {
    expect(commercialCalendarFor('2027-03-01', EVENTS)).toEqual([{ name: 'Hot Sale', month: '2027-05', phase: 'sin fecha confirmada', notes: 'sin fecha' }]);
    expect(commercialCalendarFor('2027-06-05', EVENTS)).toEqual([]);
  });

  it('los dos prompts explican qué hacer con las fechas comerciales', () => {
    for (const p of [SYSTEM_PROMPT, GOOGLE_SYSTEM_PROMPT]) {
      expect(p).toContain('# Fechas comerciales');
      expect(p).toContain('commercialCalendar');
    }
  });
});
