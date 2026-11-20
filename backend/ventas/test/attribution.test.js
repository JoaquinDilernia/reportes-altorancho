import { describe, it, expect } from 'vitest';
import { attribute, extractParams, RULES_VERSION } from '../src/engine/attribution.js';

const NULL_UTM = { utm_campaign: null, utm_content: null, utm_medium: null, utm_source: null, utm_term: null };
const v = (landing, utm = NULL_UTM) => ({ landingUrl: landing, visitLandingPage: landing, visitUtm: utm });

describe('attribute — Meta', () => {
  it('#59431: UTMs con IDs → anuncio, conjunto y campaña', () => {
    const r = attribute(v('https://altorancho.com/productos/MSI027TP/?variant=1216127748&utm_source=meta&utm_medium=cpc&utm_campaign=altorancho_valordeconv_dpa_aon&utm_content=120248950422870142&utm_id=120226653113540142&utm_term=120242524693650142&fbclid=PAZX'));
    expect(r).toMatchObject({
      channel: 'meta', confidence: 'ad',
      ad_id: '120248950422870142', adset_id: '120242524693650142', campaign_id: '120226653113540142',
      campaign_name: 'altorancho_valordeconv_dpa_aon', rules_version: RULES_VERSION,
    });
  });
  it('#59439: solo nombre de campaña → confidence campaign sin IDs', () => {
    const r = attribute(v('https://altorancho.com/search/?q=reposera&utm_source=meta&utm_medium=cpc&utm_campaign=altorancho_conversiones_eventos_aon&fbclid=PAZX'));
    expect(r).toMatchObject({ channel: 'meta', confidence: 'campaign', campaign_id: null, ad_id: null, campaign_name: 'altorancho_conversiones_eventos_aon' });
  });
  it('#59420: utm_content no numérico no se toma como anuncio', () => {
    const r = attribute(v('https://altorancho.com/productos/x/?utm_source=meta&utm_medium=cpc&utm_campaign=altorancho_conversiones_dpa_aon&utm_content=altorancho_conversiones_dpa_postevento&fbclid=PAZX'));
    expect(r).toMatchObject({ channel: 'meta', confidence: 'campaign', ad_id: null });
  });
  it('fbclid solo, sin UTMs → redes orgánicas (FB/IG agregan fbclid a cualquier link: bio, posteos, historias)', () => {
    expect(attribute(v('https://altorancho.com/?fbclid=PAZX'))).toMatchObject({ channel: 'social_organic', confidence: 'none' });
    expect(attribute(v('https://altorancho.com/?fbclid=PAZX&gclid=G1')).channel).toBe('google');
  });
  it('source facebook + medium paid también es Meta', () => {
    expect(attribute(v('https://altorancho.com/?utm_source=facebook&utm_medium=paid&utm_campaign=x')).channel).toBe('meta');
  });
});

describe('attribute — Google', () => {
  it('#59459: gad_campaignid + gclid → Google con campaña', () => {
    const r = attribute(v('https://altorancho.com/?gad_source=1&gad_campaignid=11472612872&gbraid=0AAA&gclid=Cj0K'));
    expect(r).toMatchObject({ channel: 'google', confidence: 'campaign', campaign_id: '11472612872' });
  });
  it('#59427: gclid sin campaña → Google sin identificar', () => {
    expect(attribute(v('https://altorancho.com/productos/mmc011ne/?_gl=1*cpnl5r&gclid=CjwK&gbraid=0AAA'))).toMatchObject({ channel: 'google', confidence: 'none' });
  });
  it('#59457: TN guarda "gclid:…" dentro de utm_campaign y la landing no trae params', () => {
    const r = attribute(v('https://altorancho.com/productos/MEC011PT/?variant=1185074032', { ...NULL_UTM, utm_campaign: 'gclid:Cj0KCQjwuJLW' }));
    expect(r).toMatchObject({ channel: 'google', campaign_name: null });
  });
});

describe('attribute — Pinterest', () => {
  it('UTMs con nombre de campaña (pinterest / cpc) + epik', () => {
    const r = attribute(v('https://altorancho.com/productos/x/?utm_campaign=altorancho_lower_conversiones_catalogo_aon&utm_medium=cpc&utm_source=pinterest&epik=dj0zJnU9VVFI'));
    expect(r).toMatchObject({ channel: 'pinterest', confidence: 'campaign', campaign_name: 'altorancho_lower_conversiones_catalogo_aon', campaign_id: null });
    expect(r.source_raw.epik).toBe('dj0zJnU9VVFI');
  });
  it('UTMs con IDs (Pinterest / PaidSocial): campaña y anuncio', () => {
    const r = attribute(v('https://altorancho.com/?utm_campaign=626760227913&utm_medium=PaidSocial&utm_source=Pinterest&utm_content=2680092892168'));
    expect(r).toMatchObject({ channel: 'pinterest', confidence: 'ad', campaign_id: '626760227913', ad_id: '2680092892168', campaign_name: null });
  });
  it('solo epik (sin UTMs) también es Pinterest pago', () => {
    expect(attribute(v('https://altorancho.com/?epik=dj0yJnU9')).channel).toBe('pinterest');
  });
  it('pin orgánico (pinterest / social) → redes sin pauta', () => {
    expect(attribute(v('https://altorancho.com/?utm_source=pinterest&utm_medium=social')).channel).toBe('social_organic');
  });
});

describe('attribute — resto de canales', () => {
  it('#59437: link en bio de IG → redes orgánicas (aunque traiga fbclid)', () => {
    expect(attribute(v('https://altorancho.com/?utm_source=ig&utm_medium=social&utm_content=link_in_bio&fbclid=PAZX')).channel).toBe('social_organic');
  });
  it('#59413: email de Perfit con espacios y | en la campaña', () => {
    const r = attribute(v('https://altorancho.com/?utm_source=perfit&utm_medium=email&utm_campaign=Productos en 12 cuotas | Fresh&pc=44369'));
    expect(r).toMatchObject({ channel: 'email', campaign_name: 'Productos en 12 cuotas | Fresh' });
  });
  it('#59461: home sin parámetros → orgánica', () => {
    expect(attribute(v('https://altorancho.com/')).channel).toBe('organic');
  });
  it('#59419: landing en checkout success sin params → orgánica', () => {
    expect(attribute(v('https://altorancho.com/checkout/v3/success/2084232794/34b8')).channel).toBe('organic');
  });
  it('#59425: sin customer_visit → unknown', () => {
    expect(attribute({ landingUrl: null, visitLandingPage: null, visitUtm: NULL_UTM })).toMatchObject({ channel: 'unknown', confidence: 'none' });
  });
  it('utm_source desconocido → other', () => {
    expect(attribute(v('https://altorancho.com/?utm_source=tiktok&utm_medium=bio')).channel).toBe('other');
  });
  it('URL malformada o relativa no rompe', () => {
    expect(attribute(v('http://')).channel).toBe('organic');
    expect(attribute(v('/productos/x?utm_source=meta&utm_medium=cpc&utm_campaign=c1')).channel).toBe('meta');
  });
  it('source_raw guarda solo los parámetros relevantes', () => {
    const r = attribute(v('https://altorancho.com/?variant=1&gclid=abc&gad_campaignid=12345678'));
    expect(r.source_raw).toEqual({ gclid: 'abc', gad_campaignid: '12345678' });
  });
});

describe('extractParams', () => {
  it('la landing gana sobre utm_parameters; utm_parameters completa lo que falta', () => {
    const p = extractParams({
      landingUrl: null,
      visitLandingPage: 'https://altorancho.com/?utm_source=meta&UTM_MEDIUM=cpc',
      visitUtm: { utm_source: 'otro', utm_campaign: 'camp' },
    });
    expect(p).toMatchObject({ utm_source: 'meta', utm_medium: 'cpc', utm_campaign: 'camp' });
  });
});

describe('WhatsApp y vendedores', () => {
  it('bot (productos y carritos) y difusiones van a whatsapp, con la campaña', () => {
    expect(attribute({ landingUrl: 'https://altorancho.com/cart-link/1-2?utm_source=whatsapp&utm_medium=bot&utm_campaign=carrito_bot' })).toMatchObject({ channel: 'whatsapp', campaign_name: 'carrito_bot' });
    expect(attribute({ landingUrl: 'https://altorancho.com/productos/x/?utm_source=whatsapp&utm_medium=bot&utm_campaign=producto_bot' })).toMatchObject({ channel: 'whatsapp', campaign_name: 'producto_bot' });
    expect(attribute({ landingUrl: 'https://altorancho.com/?utm_source=whatsapp&utm_medium=difusion&utm_campaign=cyber' })).toMatchObject({ channel: 'whatsapp', campaign_name: 'cyber' });
  });
  it('links de vendedores', () => {
    expect(attribute({ landingUrl: 'https://altorancho.com/?utm_source=vendedor&utm_medium=whatsapp&utm_campaign=lucia' })).toMatchObject({ channel: 'vendedor', campaign_name: 'lucia' });
  });
});

it('las UTMs de Revie (estrellas de reseñas en la tienda) no pisan el canal', () => {
  const revie = { utm_source: 'revie', utm_medium: 'revie_star', utm_campaign: 'revie' };
  const a = attribute({ landingUrl: 'https://altorancho.com/', visitLandingPage: 'https://altorancho.com/', visitUtm: revie });
  expect(a.channel).toBe('organic');
  expect(a.source_raw).toEqual({});
  expect(attribute({ landingUrl: 'https://altorancho.com/?gclid=abc', visitLandingPage: null, visitUtm: revie }).channel).toBe('google');
  expect(attribute(v('https://altorancho.com/productos/x/?utm_source=revie&utm_medium=revie_star&utm_campaign=revie')).channel).toBe('organic');
});
