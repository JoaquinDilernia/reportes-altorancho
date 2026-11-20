import { httpError } from '../repo/ads.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_TURNS = 12;

// Corrida del agente, igual para todas las plataformas: cada una pone su contexto, prompt, herramientas y dispatcher
export function createAgentRunner({
  anthropic, repo, buildContext, systemPrompt, tools, dispatch, platformLabel = 'Meta', model = DEFAULT_MODEL, log = console,
}) {
  async function process(runRow, settings) {
    const usage = { inputTokens: 0, outputTokens: 0 };
    try {
      const context = await buildContext();
      const kind = runRow.kind === 'daily' ? 'diario' : 'pedido desde el panel';
      const messages = [{ role: 'user', content: `Análisis ${kind} de la cuenta de ${platformLabel}. Datos actuales:\n\n${context}` }];
      let report = '';
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const stream = anthropic.beta.messages.stream({
          model,
          max_tokens: 32000,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'high' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: systemPrompt,
          tools,
          messages,
        });
        const resp = await stream.finalMessage();
        const u = resp.usage ?? {};
        usage.inputTokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        usage.outputTokens += u.output_tokens || 0;
        if (resp.stop_reason === 'refusal') throw new Error('El modelo no pudo completar el análisis (refusal).');
        messages.push({ role: 'assistant', content: resp.content });
        const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (text) report = text;
        if (resp.stop_reason !== 'tool_use') break;
        const results = [];
        for (const block of resp.content.filter((b) => b.type === 'tool_use')) {
          const result = await dispatch(block.name, block.input ?? {}, { runId: runRow.id, settings });
          results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result), ...(result.error ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
      }
      return await repo.finishRun(runRow.id, { status: 'done', report: report || 'El agente terminó sin dejar informe.', ...usage });
    } catch (err) {
      log.error(`[ads ${platformLabel}] corrida falló:`, err);
      return repo.finishRun(runRow.id, { status: 'failed', error: String(err.message || err).slice(0, 2000), ...usage });
    }
  }

  // Arranca una corrida y devuelve la fila enseguida; done se resuelve cuando termina
  // (el análisis tarda minutos: el panel muestra "analizando" y consulta de nuevo).
  return async function start(kind) {
    const settings = await repo.getSettings();
    if (!settings.agent_enabled && kind === 'daily') {
      const r = await repo.startRun(kind);
      const run = await repo.finishRun(r.id, { status: 'skipped', report: 'El agente está apagado en Ajustes.' });
      return { run, done: Promise.resolve(run) };
    }
    if (await repo.runningRun()) throw httpError(409, 'Ya hay un análisis corriendo. Esperá unos minutos.');
    const run = await repo.startRun(kind);
    return { run, done: process(run, settings) };
  };
}
