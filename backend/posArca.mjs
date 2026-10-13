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
const SOAP_TIMEOUT_MS = 8_000;

export function arcaEnabled() {
  return Boolean(process.env.POS_ARCA_CUIT && process.env.POS_ARCA_CERT && process.env.POS_ARCA_KEY);
}
export function arcaEnv(raw = process.env.POS_ARCA_ENV) {
  if (raw === undefined || raw === '' || raw === 'prod') return 'prod';
  if (raw === 'homo') return 'homo';
  throw new Error('POS_ARCA_ENV inválido');
}
const urls = () => URLS[arcaEnv()];
// El ticket se separa por ambiente y CUIT: uno de homologación no sirve en producción.
const TA_REF = () => getDb().collection('pos_settings').doc(`arcaTicket_${arcaEnv()}_${process.env.POS_ARCA_CUIT}`);

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
  const expiresAt = new Date(tag(inner, 'expirationTime') ?? '').getTime();
  if (Number.isNaN(expiresAt)) throw new Error('ARCA devolvió un ticket sin vencimiento válido');
  return { token, sign, expiresAt };
}

// Devuelve el texto del SOAP Fault (o null si no hay).
export function soapFault(xml) {
  const f = tag(xml, 'faultstring');
  return f === null ? null : unescapeXml(f);
}

// Interpreta la respuesta del padrón: falla ante fault/HTTP de error, null si la persona no existe.
export function parsePersonaResponse(xml, httpOk = true) {
  const fault = soapFault(xml);
  if (fault !== null) {
    if (/no existe|inexistente/i.test(fault)) return null;
    throw new Error(`ARCA: ${fault}`);
  }
  if (!httpOk) throw new Error('ARCA: el servicio respondió con error');
  return parsePersona(xml);
}

async function soap(url, body, action = '') {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: action },
    body, signal: AbortSignal.timeout(SOAP_TIMEOUT_MS),
  });
  return { xml: await res.text(), ok: res.ok };
}

const validTicket = (t) => t && t.token && t.sign && t.expiresAt - Date.now() > 5 * 60 * 1000;
let loginInFlight = null;

async function login() {
  const cms = signTra(buildTra(SERVICE));
  const { xml } = await soap(urls().wsaa, `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`);
  const fault = soapFault(xml);
  if (fault && /ya posee un TA|TA valido|TA válido/i.test(fault)) {
    // Otra instancia ya pidió el ticket: lo leemos del caché una vez.
    const saved = (await TA_REF().get()).data();
    if (validTicket(saved)) return saved;
    throw new Error('ARCA ya emitió un ticket de acceso que este servidor no tiene guardado; esperá unos minutos y reintentá');
  }
  const ticket = parseLoginResponse(xml);
  await TA_REF().set(ticket);
  return ticket;
}

async function getTicket() {
  const saved = (await TA_REF().get()).data();
  if (validTicket(saved)) return saved;
  // Un solo login a la vez dentro del proceso.
  loginInFlight ??= login().finally(() => { loginInFlight = null; });
  return loginInFlight;
}

export function parsePersona(xml) {
  if (tag(xml, 'errorConstancia') && !tag(xml, 'datosGenerales')) return null;
  const general = tag(xml, 'datosGenerales');
  if (!general) return null;
  const txt = (src, name) => { const v = tag(src, name); return v === null ? null : unescapeXml(v); };
  const name = txt(general, 'razonSocial') ?? [txt(general, 'apellido'), txt(general, 'nombre')].filter(Boolean).join(' ');
  const domicilio = tag(general, 'domicilioFiscal') ?? '';
  // Solo impuestos activos: si trae estadoImpuesto y no es 'AC', se ignora.
  const impuestos = [...(tag(xml, 'datosRegimenGeneral') ?? '').matchAll(/<impuesto>([\s\S]*?)<\/impuesto>/g)]
    .filter((m) => { const e = tag(m[1], 'estadoImpuesto'); return e === null || e === 'AC'; })
    .map((m) => Number(tag(m[1], 'idImpuesto')));
  let afipResponsibility = 'consumidor_final';
  if (tag(xml, 'datosMonotributo')) afipResponsibility = 'monotributo';
  else if (impuestos.includes(30)) afipResponsibility = 'responsable_inscripto';
  else if (impuestos.includes(32)) afipResponsibility = 'exento';
  return {
    cuit: txt(general, 'idPersona'), name, afipResponsibility,
    street: txt(domicilio, 'direccion') ?? '', city: txt(domicilio, 'localidad') ?? '',
    zip: txt(domicilio, 'codPostal') ?? '', province: txt(domicilio, 'descripcionProvincia') ?? '',
  };
}

export async function getPersona(cuit) {
  const { token, sign } = await getTicket();
  const { xml, ok } = await soap(urls().padron, `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="http://a5.soap.ws.server.puc.sr/"><soapenv:Header/><soapenv:Body><a5:getPersona_v2><token>${token}</token><sign>${sign}</sign><cuitRepresentada>${process.env.POS_ARCA_CUIT}</cuitRepresentada><idPersona>${cuit}</idPersona></a5:getPersona_v2></soapenv:Body></soapenv:Envelope>`);
  return parsePersonaResponse(xml, ok);
}

export function cuitCandidatesFromDni(dni) {
  const body = String(dni).replace(/\D/g, '').padStart(8, '0');
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  return ['20', '27', '23', '24'].map((prefix) => {
    const base = `${prefix}${body}`;
    const sum = weights.reduce((s, w, i) => s + w * Number(base[i]), 0);
    const mod = 11 - (sum % 11);
    // Con resto 10 el CUIT no existe con 20/27/24 (ARCA lo pasa a 23).
    if (mod === 10 && prefix !== '23') return null;
    return `${base}${mod === 11 ? 0 : mod === 10 ? 9 : mod}`;
  }).filter((c) => c && isValidCuit(c));
}

export async function lookupArca(doc) {
  if (!arcaEnabled()) return null;
  const digits = String(doc).replace(/\D/g, '');
  if (digits.length === 11) return isValidCuit(digits) ? getPersona(digits) : null;
  if (digits.length < 7 || digits.length > 8) return null;
  // Candidatos en paralelo; el ticket se resuelve una sola vez (single-flight).
  const results = await Promise.allSettled(cuitCandidatesFromDni(digits).map(getPersona));
  const found = results.find((r) => r.status === 'fulfilled' && r.value);
  if (found) return found.value;
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
  return null;
}
