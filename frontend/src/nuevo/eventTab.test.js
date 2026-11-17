import { describe, it, expect } from 'vitest';
import { pickEvent } from './eventTab.js';

const windows = [
  { id: 'cyber', label: 'Cyber', start: '2026-10-29', end: '2026-11-15' },
  { id: 'black', label: 'Black', start: '2026-11-26', end: '2026-11-30' },
];

describe('pickEvent', () => {
  it('muestra el evento en curso', () => {
    expect(pickEvent(windows, '2026-11-03')?.id).toBe('cyber');
  });
  it('lo sigue mostrando el día después de que termina', () => {
    expect(pickEvent(windows, '2026-11-16')?.id).toBe('cyber');
  });
  it('pasado ese día pasa al próximo evento si faltan 3 semanas o menos', () => {
    expect(pickEvent(windows, '2026-11-17')?.id).toBe('black');
    expect(pickEvent(windows, '2026-11-05', { leadDays: 21 })?.id).toBe('cyber');
  });
  it('no muestra nada lejos de los eventos', () => {
    expect(pickEvent(windows, '2026-12-05')).toBeNull();
    expect(pickEvent(windows, '2026-09-01')).toBeNull();
  });
  it('ignora ventanas sin fechas', () => {
    expect(pickEvent([{ id: 'black' }], '2026-11-20')).toBeNull();
  });
});
