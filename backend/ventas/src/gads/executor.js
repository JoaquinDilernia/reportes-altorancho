import { httpError } from '../repo/ads.js';

export const KEYWORD_ID = /^\d+~\d+$/;
export const NUMERIC_ID = /^\d+$/;

const bad = (msg) => httpError(400, msg);
function numericId(v, label) {
  const id = String(v ?? '').trim();
  if (!NUMERIC_ID.test(id)) throw bad(`Id de ${label} inválido`);
  return id;
}
function keywordId(v) {
  const id = String(v ?? '').trim();
  if (!KEYWORD_ID.test(id)) throw bad('Id de palabra clave inválido');
  return id;
}
const isHttps = (v) => typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v) && v.length <= 2048;
// Lista de textos: recorta, saca vacíos y valida cantidad y largo
function texts(list, { min, max, maxLen, label }) {
  const out = (Array.isArray(list) ? list : []).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (out.length < min || out.length > max) throw bad(`Hacen falta entre ${min} y ${max} ${label}.`);
  const long = out.find((t) => t.length > maxLen);
  if (long) throw bad(`"${long}" pasa los ${maxLen} caracteres permitidos para ${label}.`);
  return out;
}
const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
};

// Imágenes de la pieza (subidas a Google al cargarlas: asset_name) por tipo de campo
const IMAGE_SLOTS = [
  { slot: 'landscape', fieldType: 'MARKETING_IMAGE', adField: 'marketingImages', label: 'horizontal' },
  { slot: 'square', fieldType: 'SQUARE_MARKETING_IMAGE', adField: 'squareMarketingImages', label: 'cuadrada' },
  { slot: 'portrait', fieldType: 'PORTRAIT_MARKETING_IMAGE', adField: 'portraitMarketingImages', label: 'vertical' },
];

// Ejecuta una acción sobre Google Ads (al aprobarla en el panel, o sola con la pausa automática)
export function createGoogleExecutor({ gads, repo }) {
  const update = (service, resourceName, fields, updateMask) => gads.mutate(service, [{ update: { resourceName, ...fields }, updateMask }]);

  async function setStatus({ level, object_id: objectId, status }) {
    if (status !== 'ENABLED' && status !== 'PAUSED') throw bad('Estado inválido: tiene que ser ENABLED o PAUSED.');
    switch (level) {
      case 'campaign':
        await update('campaigns', gads.resource('campaigns', numericId(objectId, 'campaña')), { status }, 'status');
        break;
      case 'ad_group':
        await update('adGroups', gads.resource('adGroups', numericId(objectId, 'grupo de anuncios')), { status }, 'status');
        break;
      case 'keyword':
        await update('adGroupCriteria', gads.resource('adGroupCriteria', keywordId(objectId)), { status }, 'status');
        break;
      default:
        throw bad(`Nivel inválido: ${level}`);
    }
    return { [String(objectId)]: status };
  }

  async function setBudget({ campaign_id: campaignId, proposed_budget_ars: ars }) {
    const id = numericId(campaignId, 'campaña');
    const pesos = Math.round(Number(ars));
    if (!Number.isFinite(pesos) || pesos <= 0) throw bad('El presupuesto propuesto tiene que ser un monto en pesos mayor a 0.');
    const rows = await gads.search(`SELECT campaign.id, campaign.campaign_budget, campaign_budget.explicitly_shared
FROM campaign
WHERE campaign.id = ${id}`);
    const row = rows.find((r) => String(r.campaign?.id) === id) ?? rows[0];
    const budget = row?.campaign?.campaignBudget;
    if (!budget) throw httpError(404, `No encontré la campaña ${id} o su presupuesto en Google Ads.`);
    // Un presupuesto compartido mueve a todas las campañas que lo usan: eso se cambia a mano
    if (row.campaignBudget?.explicitlyShared === true) throw httpError(409, 'La campaña usa un presupuesto compartido con otras: cambialo a mano en Google Ads.');
    await update('campaignBudgets', budget, { amountMicros: String(pesos * 1e6) }, 'amount_micros');
    return { [id]: pesos };
  }

  async function addNegatives({ level, target_id: targetId, keywords, match_type: matchType }) {
    if (!['EXACT', 'PHRASE', 'BROAD'].includes(matchType)) throw bad('Tipo de concordancia inválido.');
    const list = [...new Set(texts(keywords, { min: 1, max: 20, maxLen: 80, label: 'palabras negativas' }).map((k) => k.toLowerCase()))];
    const keyword = (text) => ({ text, matchType });
    if (level === 'campaign') {
      const campaign = gads.resource('campaigns', numericId(targetId, 'campaña'));
      const r = await gads.mutate('campaignCriteria', list.map((text) => ({ create: { campaign, negative: true, keyword: keyword(text) } })));
      return { added: list, resources: r.results.map((x) => x.resourceName) };
    }
    if (level === 'ad_group') {
      const adGroup = gads.resource('adGroups', numericId(targetId, 'grupo de anuncios'));
      const r = await gads.mutate('adGroupCriteria', list.map((text) => ({ create: { adGroup, negative: true, keyword: keyword(text) } })));
      return { added: list, resources: r.results.map((x) => x.resourceName) };
    }
    throw bad(`Nivel inválido: ${level}`);
  }

  async function searchAd({ ad_group_id: adGroupId, headlines, descriptions, final_url: finalUrl }) {
    const adGroup = gads.resource('adGroups', numericId(adGroupId, 'grupo de anuncios'));
    const h = texts(headlines, { min: 3, max: 15, maxLen: 30, label: 'títulos' });
    const d = texts(descriptions, { min: 2, max: 4, maxLen: 90, label: 'descripciones' });
    if (!isHttps(finalUrl)) throw bad('El link del anuncio tiene que ser https.');
    const r = await gads.mutate('adGroupAds', [{
      create: {
        adGroup, status: 'ENABLED',
        ad: { finalUrls: [finalUrl], responsiveSearchAd: { headlines: h.map((text) => ({ text })), descriptions: d.map((text) => ({ text })) } },
      },
    }]);
    return { ad: r.results[0]?.resourceName ?? null };
  }

  async function targetRoas({ campaign_id: campaignId, proposed_target_roas: roas }) {
    const id = numericId(campaignId, 'campaña');
    const value = Math.round(Number(roas) * 100) / 100;
    if (!Number.isFinite(value) || value <= 0) throw bad('El objetivo de ROAS tiene que ser un número mayor a 0 (ej. 4.5 = 450%).');
    await update('campaigns', gads.resource('campaigns', id), { maximizeConversionValue: { targetRoas: value } }, 'maximize_conversion_value.target_roas');
    return { [id]: { targetRoas: value } };
  }

  // Imágenes de la pieza ya subidas a Google; una imagen sin asset_name es un error claro, no se saltea
  function creativeImages(creative) {
    const out = [];
    for (const def of IMAGE_SLOTS) {
      const m = creative[def.slot];
      if (!m) continue;
      if (!m.asset_name) throw bad(`La imagen ${def.label} de la pieza "${creative.name}" no está subida a Google Ads: volvé a cargarla.`);
      out.push({ ...def, asset: m.asset_name });
    }
    return out;
  }

  async function toAssetGroup(creative, targetId) {
    const assetGroup = gads.resource('assetGroups', targetId);
    const headlines = asArray(creative.headlines).map((t) => String(t).trim()).filter(Boolean);
    const descriptions = asArray(creative.descriptions).map((t) => String(t).trim()).filter(Boolean);
    const longHeadline = String(creative.long_headline ?? '').trim();
    const images = creativeImages(creative);
    if (!images.length && !creative.youtube_url) throw bad(`La pieza "${creative.name}" no tiene imágenes ni video de YouTube.`);

    // Textos: un asset por texto, en un solo pedido
    const textItems = [
      ...headlines.map((text) => ({ text, fieldType: 'HEADLINE' })),
      ...(longHeadline ? [{ text: longHeadline, fieldType: 'LONG_HEADLINE' }] : []),
      ...descriptions.map((text) => ({ text, fieldType: 'DESCRIPTION' })),
    ];
    const links = [];
    if (textItems.length) {
      const r = await gads.mutate('assets', textItems.map(({ text }) => ({ create: { textAsset: { text } } })));
      textItems.forEach((t, i) => links.push({ asset: r.results[i].resourceName, fieldType: t.fieldType }));
    }
    for (const img of images) links.push({ asset: img.asset, fieldType: img.fieldType });
    if (creative.youtube_url) {
      links.push({ asset: await gads.createYoutubeAsset(creative.youtube_url, `${creative.name} - YouTube`), fieldType: 'YOUTUBE_VIDEO' });
    }
    await gads.mutate('assetGroupAssets', links.map((l) => ({ create: { assetGroup, asset: l.asset, fieldType: l.fieldType } })));
    return { resourceName: assetGroup, linked: links.length };
  }

  // Logo y nombre del negocio del primer anuncio de Demand Gen del grupo que los tenga
  async function brandingOf(targetId) {
    const rows = await gads.search(`SELECT ad_group.id, ad_group_ad.ad.demand_gen_multi_asset_ad.logo_images, ad_group_ad.ad.demand_gen_multi_asset_ad.business_name,
  ad_group_ad.ad.demand_gen_video_responsive_ad.logo_images, ad_group_ad.ad.demand_gen_video_responsive_ad.business_name
FROM ad_group_ad
WHERE ad_group.id = ${targetId} AND ad_group_ad.status != 'REMOVED'`);
    for (const r of rows) {
      const ad = r.adGroupAd?.ad || {};
      const multi = ad.demandGenMultiAssetAd;
      if (multi?.logoImages?.length && multi.businessName) return { logoImages: multi.logoImages, businessName: multi.businessName };
      const video = ad.demandGenVideoResponsiveAd;
      const name = typeof video?.businessName === 'string' ? video.businessName : video?.businessName?.text;
      if (video?.logoImages?.length && name) return { logoImages: video.logoImages, businessName: name };
    }
    return null;
  }

  async function toAdGroup(creative, targetId) {
    const adGroup = gads.resource('adGroups', targetId);
    const headlines = asArray(creative.headlines).map((t) => String(t).trim()).filter(Boolean).slice(0, 5);
    const descriptions = asArray(creative.descriptions).map((t) => String(t).trim()).filter(Boolean).slice(0, 5);
    const images = creativeImages(creative);
    if (!images.some((i) => i.slot === 'landscape' || i.slot === 'square')) {
      throw bad(`La pieza "${creative.name}" necesita una imagen horizontal o cuadrada para un anuncio de Demand Gen.`);
    }
    if (!headlines.length || !descriptions.length) throw bad(`La pieza "${creative.name}" necesita al menos un título y una descripción.`);
    if (!isHttps(creative.link)) throw bad(`La pieza "${creative.name}" no tiene un link https a la tienda.`);
    const branding = await brandingOf(targetId);
    if (!branding) throw httpError(409, 'No encontré un anuncio del grupo con logo y nombre del negocio para copiar: cargá el primer anuncio a mano en Google Ads.');
    const demandGenMultiAssetAd = {
      headlines: headlines.map((text) => ({ text })),
      descriptions: descriptions.map((text) => ({ text })),
      businessName: branding.businessName,
      logoImages: branding.logoImages.map((l) => ({ asset: l.asset })),
    };
    for (const img of images) (demandGenMultiAssetAd[img.adField] ??= []).push({ asset: img.asset });
    const r = await gads.mutate('adGroupAds', [{
      create: { adGroup, status: 'ENABLED', ad: { name: creative.name, finalUrls: [creative.link], demandGenMultiAssetAd } },
    }]);
    return { resourceName: r.results[0]?.resourceName ?? null, videoSkipped: Boolean(creative.youtube_url) };
  }

  // La pieza se reclama antes de tocar Google (un segundo "Publicar" recibe 409) y se libera si algo falla
  async function addAssets({ creative_id: creativeId, target, target_id: rawTarget }) {
    if (target !== 'asset_group' && target !== 'ad_group') throw bad(`Destino inválido: ${target}`);
    const targetId = numericId(rawTarget, target === 'asset_group' ? 'grupo de recursos' : 'grupo de anuncios');
    const creative = await repo.claimCreative(creativeId);
    let out;
    try {
      out = target === 'asset_group' ? await toAssetGroup(creative, targetId) : await toAdGroup(creative, targetId);
    } catch (err) {
      await repo.releaseCreative(creativeId);
      throw err;
    }
    await repo.markCreativeUsed(creative.id, out.resourceName, targetId);
    return { creative_id: creative.id, target, target_id: targetId, resource: out.resourceName, ...(out.linked ? { linked: out.linked } : {}),
      ...(out.videoSkipped ? { note: 'El video de YouTube no va en el anuncio de imágenes de Demand Gen.' } : {}) };
  }

  return async function execute(tool, input = {}) {
    switch (tool) {
      case 'set_status': return setStatus(input);
      case 'propose_budget_change': return setBudget(input);
      case 'add_negative_keywords': return addNegatives(input);
      case 'propose_search_ad': return searchAd(input);
      case 'set_target_roas': return targetRoas(input);
      case 'add_assets': return addAssets(input);
      default: throw new Error(`Acción desconocida: ${tool}`);
    }
  };
}

