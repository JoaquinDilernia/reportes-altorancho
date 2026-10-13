import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTra, parseLoginResponse, parsePersona, cuitCandidatesFromDni, parsePersonaResponse, soapFault, arcaEnv } from '../posArca.mjs';

test('buildTra: pide el servicio con ventana de ±10 minutos', () => {
  const xml = buildTra('ws_sr_constancia_inscripcion', new Date('2026-10-13T15:00:00Z'));
  assert.match(xml, /<service>ws_sr_constancia_inscripcion<\/service>/);
  assert.match(xml, /<generationTime>2026-10-13T14:50:00.000Z<\/generationTime>/);
  assert.match(xml, /<expirationTime>2026-10-13T15:10:00.000Z<\/expirationTime>/);
});

test('parseLoginResponse: saca token y sign del XML escapado', () => {
  const inner = '<loginTicketResponse><header><expirationTime>2026-10-14T03:00:00.000-03:00</expirationTime></header><credentials><token>TOK</token><sign>SIG</sign></credentials></loginTicketResponse>';
  const escaped = inner.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const xml = `<soapenv:Envelope><soapenv:Body><loginCmsResponse><loginCmsReturn>${escaped}</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>`;
  const r = parseLoginResponse(xml);
  assert.equal(r.token, 'TOK');
  assert.equal(r.sign, 'SIG');
  assert.equal(r.expiresAt, new Date('2026-10-14T03:00:00.000-03:00').getTime());
});

test('parsePersona: responsable inscripto con domicilio fiscal', () => {
  const xml = `<personaReturn><datosGenerales><idPersona>30712345671</idPersona><razonSocial>MUEBLES SA</razonSocial>
    <domicilioFiscal><direccion>AV SIEMPREVIVA 742</direccion><localidad>CIUDAD AUTONOMA BUENOS AIRES</localidad><codPostal>1428</codPostal><descripcionProvincia>CIUDAD AUTONOMA BUENOS AIRES</descripcionProvincia></domicilioFiscal>
    </datosGenerales><datosRegimenGeneral><impuesto><idImpuesto>30</idImpuesto></impuesto></datosRegimenGeneral></personaReturn>`;
  assert.deepEqual(parsePersona(xml), {
    cuit: '30712345671', name: 'MUEBLES SA', afipResponsibility: 'responsable_inscripto',
    street: 'AV SIEMPREVIVA 742', city: 'CIUDAD AUTONOMA BUENOS AIRES', zip: '1428', province: 'CIUDAD AUTONOMA BUENOS AIRES',
  });
});

test('parsePersona: monotributo y persona física (apellido + nombre); error → null', () => {
  const mono = `<personaReturn><datosGenerales><idPersona>20301234561</idPersona><apellido>PEREZ</apellido><nombre>ANA</nombre></datosGenerales><datosMonotributo><categoriaMonotributo>x</categoriaMonotributo></datosMonotributo></personaReturn>`;
  assert.equal(parsePersona(mono).name, 'PEREZ ANA');
  assert.equal(parsePersona(mono).afipResponsibility, 'monotributo');
  assert.equal(parsePersona('<personaReturn><errorConstancia><error>No existe</error></errorConstancia></personaReturn>'), null);
});

test('cuitCandidatesFromDni: prefijos 20, 27, 23, 24 con dígito verificador', () => {
  const c = cuitCandidatesFromDni('30123456');
  assert.equal(c.length, 4);
  assert.ok(c.every((x) => /^\d{11}$/.test(x)));
  assert.ok(c[0].startsWith('2030123456'));
});

test('parsePersonaResponse: fault de persona inexistente → null; otros faults y HTTP de error → throw', () => {
  const fault = (s) => `<soapenv:Fault><faultcode>x</faultcode><faultstring>${s}</faultstring></soapenv:Fault>`;
  assert.equal(parsePersonaResponse(fault('No existe persona con ese Id')), null);
  assert.throws(() => parsePersonaResponse(fault('Token invalido')), /ARCA: Token invalido/);
  assert.throws(() => parsePersonaResponse('<html>502</html>', false), /ARCA/);
  assert.equal(soapFault('<a>ok</a>'), null);
});

test('arcaEnv: prod por defecto, homo, y valores raros fallan', () => {
  assert.equal(arcaEnv(undefined), 'prod');
  assert.equal(arcaEnv('prod'), 'prod');
  assert.equal(arcaEnv('homo'), 'homo');
  assert.throws(() => arcaEnv('test'), /POS_ARCA_ENV inválido/);
});

test('parseLoginResponse: vencimiento inválido → throw', () => {
  const inner = '<x><expirationTime>basura</expirationTime><token>T</token><sign>S</sign></x>';
  const xml = `<loginCmsReturn>${inner.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</loginCmsReturn>`;
  assert.throws(() => parseLoginResponse(xml), /vencimiento/);
});

test('parsePersona: decodifica entidades e ignora impuestos no activos', () => {
  const xml = `<personaReturn><datosGenerales><idPersona>30712345671</idPersona><razonSocial>PEREZ &amp; HIJOS SRL</razonSocial>
    <domicilioFiscal><direccion>CALLE 1</direccion></domicilioFiscal></datosGenerales>
    <datosRegimenGeneral><impuesto><idImpuesto>30</idImpuesto><estadoImpuesto>BA</estadoImpuesto></impuesto><impuesto><idImpuesto>32</idImpuesto><estadoImpuesto>AC</estadoImpuesto></impuesto></datosRegimenGeneral></personaReturn>`;
  const p = parsePersona(xml);
  assert.equal(p.name, 'PEREZ & HIJOS SRL');
  assert.equal(p.afipResponsibility, 'exento');
});

test('cuitCandidatesFromDni: omite 20/27/24 cuando el resto da 10', () => {
  const c = cuitCandidatesFromDni('30000002'); // con 20 el resto es 10
  assert.ok(!c.some((x) => x.startsWith('20')));
  assert.ok(c.some((x) => x.startsWith('23')));
});
