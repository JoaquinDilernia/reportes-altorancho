import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createAdsRepo } from '../src/repo/ads.js';

describe('archiveBacklog', () => {
  it('archiva lo pendiente y descarta preguntas abiertas de esa plataforma; lo aprendido queda', async () => {
    const db = await createTestDb();
    const meta = createAdsRepo(db);
    const google = createAdsRepo(db, { platform: 'google' });
    await meta.addDecision({ tool: 'pause_ad', title: 'Pausar A', status: 'pending' });
    await meta.addDecision({ tool: 'pause_ad', title: 'Pausar B', status: 'pending' });
    await meta.addDecision({ tool: 'pause_ad', title: 'Ya rechazada', status: 'rejected' });
    await google.addDecision({ tool: 'set_budget', title: 'Google', status: 'pending' });
    await meta.addQuestion({ question: '¿Black Friday?' });
    await meta.upsertLearning({ text: 'Los carruseles andan mejor' });

    expect(await meta.archiveBacklog()).toEqual({ decisions: 2, questions: 1 });

    expect(await meta.countPending()).toBe(0);
    expect(await meta.countOpenQuestions()).toBe(0);
    // el agente lee la historia sin estado: lo archivado no aparece, lo rechazado sí
    expect((await meta.listDecisions()).map((d) => d.title)).toEqual(['Ya rechazada']);
    expect((await meta.listDecisions({ status: 'archived' }))).toHaveLength(2);
    expect(await google.countPending()).toBe(1);
    expect(await meta.listLearnings({ activeOnly: true })).toHaveLength(1);
    await db.close();
  });
});
