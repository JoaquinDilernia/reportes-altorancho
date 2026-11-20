import { TEAM_TOOL_DEFINITIONS } from '../ads/teamTools.js';

const s = (description) => ({ type: 'string', description });
const n = (description) => ({ type: 'number', description });
const why = {
  title: s('Título corto de la recomendación, en lenguaje simple (ej. "Pausar la palabra clave \\"sillones baratos\\"")'),
  reason: s('Por qué, con los números de Google de la familia del objeto que lo justifican (ej. compras y ROAS en ventas, costo por clic en tráfico, CPM en alcance)'),
  expected_impact: s('Qué esperás que pase y cuándo se va a poder medir'),
};
const whyReq = ['title', 'reason', 'expected_impact'];

// Todas las acciones sobre Google Ads quedan como recomendaciones pendientes de aprobación en el panel,
// salvo la pausa automática (palabra clave o grupo de Search de ventas que gastó el mínimo sin compras).
export const GOOGLE_TOOLS = [
  {
    name: 'set_status',
    description: 'Pausar o activar una campaña, un grupo de anuncios o una palabra clave. Activar algo empieza a gastar plata: siempre queda pendiente de aprobación. Con la pausa automática prendida, pausar una palabra clave o un grupo de una campaña de Search de ventas se ejecuta solo si el sistema verifica en Google el gasto mínimo sin compras; en cualquier otro caso queda para aprobar. Nunca pauses palabras de marca (alto rancho / altorancho) sin preguntarle antes al equipo.',
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['campaign', 'ad_group', 'keyword'] },
        object_id: s('ID del objeto. Palabra clave: el id compuesto "<adGroupId>~<criterionId>" tal como viene en keywords[].id'),
        object_name: s('Nombre de la campaña o grupo, o texto de la palabra clave'),
        status: { type: 'string', enum: ['ENABLED', 'PAUSED'] },
        ...why,
      },
      required: ['level', 'object_id', 'status', ...whyReq],
    },
  },
  {
    name: 'propose_budget_change',
    description: 'Proponer cambiar el presupuesto diario de una campaña. En PESOS. Cambios de hasta ±20% por vez y respetando el tope mensual.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: s('ID de la campaña'), campaign_name: s('Nombre de la campaña'),
        current_budget_ars: n('Presupuesto diario actual en pesos (campaigns[].dailyBudgetArs)'),
        proposed_budget_ars: n('Presupuesto diario propuesto en pesos'),
        ...why,
      },
      required: ['campaign_id', 'current_budget_ars', 'proposed_budget_ars', ...whyReq],
    },
  },
  {
    name: 'add_negative_keywords',
    description: 'Proponer palabras clave negativas a nivel campaña o grupo de anuncios, a partir de términos de búsqueda (searchTerms) que gastaron sin compras y no tienen que ver con lo que vende la tienda.',
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['campaign', 'ad_group'] },
        target_id: s('ID de la campaña o del grupo de anuncios'),
        target_name: s('Nombre de la campaña o del grupo'),
        keywords: { type: 'array', items: { type: 'string', maxLength: 80 }, minItems: 1, maxItems: 20, description: 'Las palabras negativas (hasta 20)' },
        match_type: { type: 'string', enum: ['EXACT', 'PHRASE', 'BROAD'] },
        ...why,
      },
      required: ['level', 'target_id', 'keywords', 'match_type', ...whyReq],
    },
  },
  {
    name: 'propose_search_ad',
    description: 'Proponer un anuncio de búsqueda adaptable nuevo en un grupo de anuncios de Search: de 3 a 15 títulos (máximo 30 caracteres cada uno) y de 2 a 4 descripciones (máximo 90 caracteres), con el link de la tienda.',
    input_schema: {
      type: 'object',
      properties: {
        ad_group_id: s('ID del grupo de anuncios'), ad_group_name: s('Nombre del grupo'),
        headlines: { type: 'array', items: { type: 'string', maxLength: 30 }, minItems: 3, maxItems: 15, description: 'Títulos, de 30 caracteres como máximo' },
        descriptions: { type: 'array', items: { type: 'string', maxLength: 90 }, minItems: 2, maxItems: 4, description: 'Descripciones, de 90 caracteres como máximo' },
        final_url: s('Link de la tienda (https://altorancho.com/...)'),
        ...why,
      },
      required: ['ad_group_id', 'headlines', 'descriptions', 'final_url', ...whyReq],
    },
  },
  {
    name: 'set_target_roas',
    description: 'Proponer cambiar el objetivo de ROAS de una campaña que puja por valor de conversión (Performance Max o Search con maximizar valor). Hasta ±20% por vez y no más de una vez por semana por campaña (mirá recentDecisions): cada cambio vuelve a poner a aprender a Smart Bidding.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: s('ID de la campaña'), campaign_name: s('Nombre de la campaña'),
        current_target_roas: n('Objetivo de ROAS actual (campaigns[].targetRoas, ej. 4.5 = 450%)'),
        proposed_target_roas: n('Objetivo de ROAS propuesto, en la misma escala (ej. 5 = 500%)'),
        ...why,
      },
      required: ['campaign_id', 'current_target_roas', 'proposed_target_roas', ...whyReq],
    },
  },
  {
    name: 'add_assets',
    description: 'Proponer sumar una pieza subida al panel (lista unusedCreatives) a un grupo de recursos de Performance Max (target asset_group: suma títulos, título largo, descripciones, imágenes y video de YouTube) o como anuncio nuevo en un grupo de anuncios de Demand Gen (target ad_group: necesita imagen horizontal o cuadrada).',
    input_schema: {
      type: 'object',
      properties: {
        creative_id: s('id de la pieza en el panel'),
        target: { type: 'string', enum: ['asset_group', 'ad_group'] },
        target_id: s('ID del grupo de recursos (assetGroups[].id) o del grupo de anuncios de Demand Gen'),
        target_name: s('Nombre del grupo'),
        ...why,
      },
      required: ['creative_id', 'target', 'target_id', ...whyReq],
    },
  },
];

export const GOOGLE_TOOL_DEFINITIONS = [...GOOGLE_TOOLS, ...TEAM_TOOL_DEFINITIONS];

export const GOOGLE_ACTIONS = new Set(GOOGLE_TOOLS.map((t) => t.name));
