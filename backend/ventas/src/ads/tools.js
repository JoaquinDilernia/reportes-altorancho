import { TEAM_TOOL_DEFINITIONS } from './teamTools.js';

const s = (description) => ({ type: 'string', description });
const n = (description) => ({ type: 'number', description });
const why = {
  title: s('Título corto de la recomendación, en lenguaje simple (ej. "Pausar el anuncio de lámparas colgantes")'),
  reason: s('Por qué, con los números de Meta de la familia del objeto que lo justifican (ej. compras y ROAS en ventas, costo por clic en tráfico, CPM en alcance)'),
  expected_impact: s('Qué esperás que pase y cuándo se va a poder medir'),
};
const whyReq = ['title', 'reason', 'expected_impact'];

// Las acciones sobre Meta (pausar, activar, presupuesto, conjuntos, anuncios) quedan como recomendaciones
// pendientes de aprobación en el panel, salvo la pausa automática (pausar un anuncio de ventas que gastó el mínimo sin compras).
export const META_TOOLS = [
  {
    name: 'pause_ad',
    description: 'Pausar un anuncio. Usalo con anuncios que gastaron de verdad sin compras en Meta (campañas de ventas), o con fatiga clara (frecuencia alta y CTR cayendo en delivery7d, como diagnóstico; el éxito se mide en platform7d). Nunca dejes un conjunto activo sin anuncios. Con la pausa automática prendida, el sistema verifica en Meta el gasto mínimo sin compras y solo entonces se ejecuta; en cualquier otro caso queda para aprobar.',
    input_schema: { type: 'object', properties: { ad_id: s('ID del anuncio'), ad_name: s('Nombre del anuncio'), ...why }, required: ['ad_id', ...whyReq] },
  },
  {
    name: 'set_status',
    description: 'Proponer pausar o activar una campaña, un conjunto o un anuncio. Activar algo empieza a gastar plata: siempre queda pendiente de aprobación.',
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['campaign', 'adset', 'ad'] },
        object_id: s('ID del objeto'), object_name: s('Nombre del objeto'),
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] },
        ...why,
      },
      required: ['level', 'object_id', 'status', ...whyReq],
    },
  },
  {
    name: 'propose_budget_change',
    description: 'Proponer cambiar el presupuesto diario de una campaña (CBO) o de un conjunto. En PESOS. Cambios de hasta ±20% por vez y respetando el tope mensual.',
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['campaign', 'adset'] }, object_id: s('ID'), object_name: s('Nombre'),
        current_budget_ars: n('Presupuesto diario actual en pesos'), proposed_budget_ars: n('Presupuesto diario propuesto en pesos'),
        ...why,
      },
      required: ['level', 'object_id', 'current_budget_ars', 'proposed_budget_ars', ...whyReq],
    },
  },
  {
    name: 'propose_adset',
    description: 'Proponer un conjunto nuevo dentro de una campaña de ventas existente (por ejemplo para probar otro público). Buscá antes los intereses reales con search_interest — nunca inventes IDs. El conjunto se crea PAUSADO y optimiza igual que los otros conjuntos de esa campaña (compras en la web); sin presupuesto propio si la campaña es CBO.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: s('ID de la campaña'),
        name: s('Nombre del conjunto, en MAYÚSCULAS con guiones bajos (ej. INT_DECO_HOGAR_AMBA)'),
        targeting: { type: 'object', description: 'Targeting de Graph API: geo_locations, age_min, age_max, flexible_spec con intereses, targeting_automation.advantage_audience (0 o 1)' },
        daily_budget_ars: n('Solo si la campaña NO es CBO: presupuesto diario del conjunto en pesos'),
        creative_id: s('Opcional: id de una pieza sin usar para crear el anuncio en el mismo paso'),
        ...why,
      },
      required: ['campaign_id', 'name', 'targeting', ...whyReq],
    },
  },
  {
    name: 'create_ad',
    description: 'Proponer publicar una pieza subida al panel (de la lista unusedCreatives) como anuncio en un conjunto, con botón "Comprar" al link de la pieza. El anuncio nace ACTIVO dentro del conjunto (si el conjunto está pausado no gasta).',
    input_schema: { type: 'object', properties: { creative_id: s('id de la pieza en el panel'), adset_id: s('ID del conjunto destino'), adset_name: s('Nombre del conjunto'), ...why }, required: ['creative_id', 'adset_id', ...whyReq] },
  },
  {
    name: 'promote_ig_post',
    description: 'Proponer promocionar un post o reel que ya está publicado en el Instagram de Altorancho (lista igPosts) como anuncio en un conjunto, con botón "Comprar". Usa el post original: suma sus likes y comentarios, y el texto es el del post (no se edita). Si el post muestra un producto puntual, pasá el link de ese producto. No lo propongas si ya está en promotedIn para ese conjunto.',
    input_schema: {
      type: 'object',
      properties: {
        ig_media_id: s('id del post (de igPosts)'), adset_id: s('ID del conjunto destino'), adset_name: s('Nombre del conjunto'),
        permalink: s('Link del post (de igPosts)'),
        link: s('Opcional: link de la tienda al que lleva el botón (ej. https://altorancho.com/productos/...). Si falta, va a la home.'),
        ...why,
      },
      required: ['ig_media_id', 'adset_id', ...whyReq],
    },
  },
  {
    name: 'search_interest',
    description: 'Buscar intereses reales de Meta (con tamaño de público) para armar segmentaciones. Solo lectura.',
    input_schema: { type: 'object', properties: { query: s('Término, ej. "decoración de interiores", "iluminación"') }, required: ['query'] },
  },
];

export const TOOL_DEFINITIONS = [...META_TOOLS, ...TEAM_TOOL_DEFINITIONS];

export const READ_ONLY_TOOLS = new Set(['search_interest']);
export const META_ACTIONS = new Set(['pause_ad', 'set_status', 'propose_budget_change', 'propose_adset', 'create_ad', 'promote_ig_post']);
