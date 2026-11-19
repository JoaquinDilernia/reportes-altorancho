const s = (description) => ({ type: 'string', description });

// Herramientas de equipo, iguales en todas las plataformas: pedidos de piezas, aprendizajes, resultados y preguntas
export const TEAM_TOOL_DEFINITIONS = [
  {
    name: 'request_creative',
    description: 'Pedirle al equipo una pieza nueva cuando hace falta (no hay piezas sin usar, fatiga, producto o ángulo sin probar). Sé concreto: formato, producto, qué se ve, qué dice, a qué link lleva, por qué.',
    input_schema: {
      type: 'object',
      properties: { concept: s('Idea de la pieza en una línea'), style_notes: s('Formato (feed 4:5 y/o historia 9:16, imagen o video), producto, qué mostrar, texto, tono, link'), reason: s('Por qué hace falta ahora') },
      required: ['concept', 'style_notes', 'reason'],
    },
  },
  {
    name: 'save_learning',
    description: 'Guardar o actualizar un aprendizaje con evidencia repetida (mínimo 2-3 observaciones consistentes, nunca de una sola muestra). Pasá learning_id para actualizar o marcarlo obsolete.',
    input_schema: { type: 'object', properties: { learning_id: s('ID existente (omitir para crear)'), text: s('El aprendizaje, corto y accionable'), evidence: s('Evidencia con fechas y números'), status: { type: 'string', enum: ['active', 'obsolete'] } }, required: ['text', 'evidence'] },
  },
  {
    name: 'record_outcome',
    description: 'Registrar qué pasó realmente después de una decisión ejecutada (lista decisionsToEvaluate), con números de ventas reales.',
    input_schema: { type: 'object', properties: { decision_id: s('ID de la decisión'), outcome: s('Resultado medido') }, required: ['decision_id', 'outcome'] },
  },
  {
    name: 'ask_team',
    description: 'Hacerle una pregunta al equipo cuando te falta un dato que solo ellos tienen (stock, márgenes, promos, lanzamientos, productos a empujar, tope de inversión). La ven en el panel y la contestan; la respuesta te llega en answeredQuestions en una próxima corrida. Una pregunta por llamada, concreta y que se pueda contestar en una o dos líneas. No repitas preguntas que sigan en openQuestions.',
    input_schema: {
      type: 'object',
      properties: {
        question: s('La pregunta, concreta (ej. "¿Hay stock suficiente de la lámpara Nórdica para subirle el presupuesto 20%?")'),
        why: s('Qué decisión destraba la respuesta'),
        quick_answers: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Opcional: hasta 4 respuestas típicas cortas para contestar con un toque (ej. "Sí", "No")' },
      },
      required: ['question', 'why'],
    },
  },
];

// Atiende una herramienta de equipo. Devuelve undefined si no es de equipo (la atiende el dispatcher de la plataforma).
export async function handleTeamTool(name, input, { repo, runId }) {
  switch (name) {
    case 'request_creative':
      await repo.addRequest({ concept: input.concept, styleNotes: input.style_notes, reason: input.reason });
      return { ok: true, note: 'Pedido cargado en el panel para el equipo.' };
    case 'save_learning':
      return { ok: true, learning_id: (await repo.upsertLearning(input)).id };
    case 'record_outcome':
      await repo.recordOutcome(input.decision_id, input.outcome);
      return { ok: true };
    case 'ask_team': {
      const question = String(input.question ?? '').trim();
      if (!question) return { error: 'Falta la pregunta.' };
      const quickAnswers = (Array.isArray(input.quick_answers) ? input.quick_answers : [])
        .filter((a) => typeof a === 'string' && a.trim())
        .slice(0, 4)
        .map((a) => a.trim().slice(0, 80));
      const q = await repo.addQuestion({ runId, question, why: String(input.why ?? ''), quickAnswers });
      return { ok: true, question_id: q.id, note: 'La pregunta quedó en el panel; la respuesta te llega en una próxima corrida.' };
    }
    default:
      return undefined;
  }
}