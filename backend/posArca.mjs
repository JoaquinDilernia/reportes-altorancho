// Consulta al padrón de ARCA (Constancia de Inscripción, A5) para completar
// los datos de Factura A desde el CUIT. Autenticación WSAA: un TRA firmado
// (CMS) con el certificado de la empresa → token + sign válidos ~12 h. El
// ticket se guarda en Firestore porque WSAA rechaza pedir otro mientras el
// anterior siga vigente (aunque se haya reiniciado el servidor).
import forge from 'node-forge';
import { getDb } from './firestore.mjs';
import { isValidCuit } from './feriaOdoo.mjs';

const SERVICE = 'ws_sr_constancia_inscripcion';
const URLS = {
  prod: { wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms', padron: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5' },
  homo: { wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms', padron: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5' },
};
const TA_REF = () => getDb().collection('pos_settings').doc('arcaTicket');

export function arcaEnabled() {
  return Boolean(process.env.POS_ARCA_CUIT && process.env.POS_ARCA_CERT && process.env.POS_ARCA_KEY);
}
const urls = () => URLS[process.env.POS_ARCA_ENV === 'homo' ? 'homo' : 'prod'];

export function buildTra(service, now = new Date()) {
  const gen = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const exp = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${Math.floor(now.getTime() / 1000)}</uniqueId><generationTime>${gen}</generationTime><expirationTime>${exp}</expirationTime></header><service>${service}</service></loginTicketRequest>`;
}

function signTra(tra) {
  const cert = forge.pki.certificateFromPem(process.env.POS_ARCA_CERT.replace(/\\n/g, '\n'));
  const key = forge.pki.privateKeyFromPem(process.env.POS_ARCA_KEY.replace(/\\n/g, '\n'));
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key, certificate: cert, digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

const tag = (xml, name) => xml.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`))?.[1]?.trim() ?? null;
const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function parseLoginResponse(xml) {
  const inner = unescapeXml(tag(xml, 'loginCmsReturn') ?? '');
  const token = tag(inner, 'token');
  const sign = tag(inner, 'sign');
  if (!token || !sign) throw new Error(`ARCA no devolvió el ticket de acceso: ${tag(xml, 'faultstring') ?? 'respuesta inválida'}`);
  return { token, sign, expiresAt: new Date(tag(inner, 'expirationTime')).getTime() };
}

async function soap(url, body, action = '') {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: action },
    body, signal: AbortSignal.timeout(20_000),
  });
  return res.text();
}

async function getTicket() {
  const saved = (await TA_REF().get()).data();
  if (saved && saved.expiresAt - Date.now() > 5 * 60 * 1000) return saved;
  const cms = signTra(buildTra(SERVICE));
  const xml = await soap(urls().wsaa, `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`);
  const ticket = parseLoginResponse(xml);
  await TA_REF().set(ticket);
  return ticket;
}

export function parsePersona(xml) {
  if (tag(xml, 'errorConstancia') && !tag(xml, 'datosGenerales')) return null;
  const general = tag(xml, 'datosGenerales');
  if (!general) return null;
  const name = tag(general, 'razonSocial') ?? [tag(general, 'apellido'), tag(general, 'nombre')].filter(Boolean).join(' ');
  const domicilio = tag(general, 'domicilioFiscal') ?? '';
  const impuestos = [...(tag(xml, 'datosRegimenGeneral') ?? '').matchAll(/<idImpuesto>(\d+)<\/idImpuesto>/g)].map((m) => Number(m[1]));
  let afipResponsibility = 'consumidor_final';
  if (tag(xml, 'datosMonotributo')) afipResponsibility = 'monotributo';
  else if (impuestos.includes(30)) afipResponsibility = 'responsable_inscripto';
  else if (impuestos.includes(32)) afipResponsibility = 'exento';
  return {
    cuit: tag(general, 'idPersona'), name, afipResponsibility,
    street: tag(domicilio, 'direccion') ?? '', city: tag(domicilio, 'localidad') ?? '',
    zip: tag(domicilio, 'codPostal') ?? '', province: tag(domicilio, 'descripcionProvincia') ?? '',
  };
}

export async function getPersona(cuit) {
  const { token, sign } = await getTicket();
  const xml = await soap(urls().padron, `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="http://a5.soap.ws.server.puc.sr/"><soapenv:Header/><soapenv:Body><a5:getPersona_v2><token>${token}</token><sign>${sign}</sign><cuitRepresentada>${process.env.POS_ARCA_CUIT}</cuitRepresentada><idPersona>${cuit}</idPersona></a5:getPersona_v2></soapenv:Body></soapenv:Envelope>`);
  return parsePersona(xml);
}

export function cuitCandidatesFromDni(dni) {
  const body = String(dni).replace(/\D/g, '').padStart(8, '0');
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  return ['20', '27', '23', '24'].map((prefix) => {
    const base = `${prefix}${body}`;
    const sum = weights.reduce((s, w, i) => s + w * Number(base[i]), 0);
    const mod = 11 - (sum % 11);
    return `${base}${mod === 11 ? 0 : mod === 10 ? 9 : mod}`;
  }).filter(isValidCuit);
}

export async function lookupArca(doc) {
  if (!arcaEnabled()) return null;
  const digits = String(doc).replace(/\D/g, '');
  if (digits.length === 11) return isValidCuit(digits) ? getPersona(digits) : null;
  if (digits.length < 7 || digits.length > 8) return null;
  for (const cuit of cuitCandidatesFromDni(digits)) {
    const persona = await getPersona(cuit);
    if (persona) return persona;
  }
  return null;
}
