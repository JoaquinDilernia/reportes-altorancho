import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { buildFullReport, ALL_CHANNELS } from './report.mjs';
import { authenticate, callKw } from './odoo.mjs';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-opus-5';
const MAX_TOKENS = 2000;

const SYSTEM_PROMPT = `Sos un analista de datos para Altorancho (muebles y decoración, Argentina). Analizás datos de ventas (ecommerce, locales físicos, mayorista) y de Meta Ads para ayudar a preparar la reunión semanal de números.

Reglas:
- Respondé siempre en español rioplatense, corto y directo — no un informe extenso.
- Los montos están en pesos argentinos (ARS).
- Basate en números concretos del período actual, que ya tenés como contexto abajo. Si hace falta comparar con otro período/canal que no tenés, usá la herramienta get_report_data.
- Si preguntan algo puntual que no está en el reporte (stock de un producto específico, datos de un cliente, una orden particular, etc.), usá la herramienta search_odoo para ir a buscarlo directo al ERP en vez de decir que no lo tenés.
- Priorizá lo accionable: qué está funcionando, qué no, y una sugerencia concreta cuando aplique.
- Texto plano, sin markdown: nada de "#" para títulos, nada de "**" para negrita, nada de tablas. Usá guiones ("- ") para listas y saltos de línea para separar ideas — el frontend no renderiza markdown, solo texto con saltos de línea.`;

// The same shape buildFullReport already accepts on /api/report — letting
// Claude pull any other period/channel on demand, not just the one already
// loaded on screen.
const getReportDataTool = betaZodTool({
  name: 'get_report_data',
  description: 'Trae ventas y performance de Meta Ads para un período y canales dados. Usalo para comparar contra otros períodos o canales además del que ya viene en el contexto.',
  inputSchema: z.object({
    period: z.enum(['week', 'month', 'custom']).describe('Tipo de período'),
    date: z.string().optional().describe('Fecha ancla YYYY-MM-DD (requerido si period es week o month)'),
    start: z.string().optional().describe('Fecha de inicio YYYY-MM-DD (requerido si period es custom)'),
    end: z.string().optional().describe('Fecha de fin YYYY-MM-DD (requerido si period es custom)'),
    channels: z.array(z.enum(ALL_CHANNELS)).optional().describe('Canales a incluir; si se omite, se usan todos (consolidado)'),
  }),
  run: async (input) => JSON.stringify(await buildFullReport(input)),
});

// Read-only, allowlisted access to Odoo for whatever isn't already in
// get_report_data — a specific product's stock, a customer, a particular
// order. Restricted to search_read (never write/unlink/create) on a fixed
// set of models so a chat message can never touch anything beyond what the
// dashboard's own Odoo service account already reads for syncing.
const ODOO_SEARCH_MODELS = ['product.template', 'product.product', 'stock.quant', 'sale.order', 'pos.order', 'res.partner', 'account.move'];

const searchOdooTool = betaZodTool({
  name: 'search_odoo',
  description: 'Busca datos directo en Odoo (el ERP) para algo puntual que no está en get_report_data: stock de un producto específico, datos de un cliente, el detalle de una orden particular, etc. Es de solo lectura.',
  inputSchema: z.object({
    model: z.enum(ODOO_SEARCH_MODELS).describe('Modelo de Odoo a consultar'),
    domain: z.array(z.any()).describe('Filtro estilo Odoo, ej: [["name", "ilike", "silla"]]'),
    fields: z.array(z.string()).describe('Campos a traer del modelo'),
    limit: z.number().int().min(1).max(50).default(20).describe('Máximo de resultados (tope 50)'),
  }),
  run: async ({ model, domain, fields, limit }) => {
    await authenticate();
    const results = await callKw(model, 'search_read', [domain], { fields, limit });
    return JSON.stringify(results);
  },
});

function systemPromptWithContext(report) {
  return `${SYSTEM_PROMPT}\n\nDatos del período que el usuario está mirando ahora mismo en el dashboard:\n\n${JSON.stringify(report)}`;
}

function textFrom(message) {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

export async function analyzeReport(params) {
  const report = await buildFullReport(params);
  const message = await client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPromptWithContext(report),
    tools: [getReportDataTool, searchOdooTool],
    messages: [{
      role: 'user',
      content: 'Analizá el período actual y dame 3 a 5 insights accionables en bullets cortos, con números concretos.',
    }],
  });
  return textFrom(message);
}

export async function chatAboutReport({ report, messages }) {
  const message = await client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPromptWithContext(report),
    tools: [getReportDataTool, searchOdooTool],
    messages,
  });
  return textFrom(message);
}
