import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { createGoogleAdsClient } from '../src/services/googleAds.js';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = { client_email: 'a@b.iam', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const tokenRes = () => json({ access_token: 'T', expires_in: 3600 });
const quota = () => json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'cuota', details: [{ errors: [{ errorCode: { quotaError: 'RESOURCE_EXHAUSTED' }, message: 'x' }] }] } }, 429);
const make = (fetchFn, extra = {}) => createGoogleAdsClient({ serviceAccountJson: JSON.stringify(sa), customerId: '813-288-6784', fetchFn, sleep: vi.fn(async () => {}), ...extra });

describe('googleAds client', () => {
  it('pide token una vez, usa la URL v24 sin developer-token', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(tokenRes()).mockResolvedValue(json({ results: [{ a: 1 }] }));
    const c = make(fetchFn);
    await c.search('SELECT 1');
    await c.search('SELECT 2');
    expect(fetchFn.mock.calls.filter(([u]) => u.includes('oauth2')).length).toBe(1);
    const [url, opts] = fetchFn.mock.calls[1];
    expect(url).toBe('https://googleads.googleapis.com/v24/customers/8132886784/googleAds:search');
    expect(opts.headers['developer-token']).toBeUndefined();
    expect(opts.headers['login-customer-id']).toBeUndefined();
    expect(opts.headers.Authorization).toBe('Bearer T');
    expect(c.customerId).toBe('8132886784');
    expect(c.resource('campaigns', 5)).toBe('customers/8132886784/campaigns/5');
  });

  it('pagina juntando resultados', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(json({ results: [1], nextPageToken: 'p2' }))
      .mockResolvedValueOnce(json({ results: [2] }));
    expect(await make(fetchFn).search('q')).toEqual([1, 2]);
    expect(JSON.parse(fetchFn.mock.calls[2][1].body).pageToken).toBe('p2');
  });

  it('mutate manda validateOnly', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(tokenRes()).mockResolvedValue(json({ results: [] }));
    await make(fetchFn).mutate('campaigns', [{ create: {} }], { validateOnly: true });
    expect(fetchFn.mock.calls[1][0]).toMatch(/campaigns:mutate$/);
    expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toEqual({ operations: [{ create: {} }], validateOnly: true });
  });

  it('reintenta 429 dos veces y resuelve', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(tokenRes()).mockResolvedValueOnce(quota()).mockResolvedValueOnce(quota()).mockResolvedValueOnce(json({ results: [1] }));
    const sleep = vi.fn(async () => {});
    const c2 = make(fetchFn, { sleep });
    expect(await c2.search('q')).toEqual([1]);
    expect(sleep.mock.calls).toEqual([[5000], [10000]]);
  });

  it('quotaError persistente rechaza con mensaje de cuota', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(tokenRes()).mockImplementation(async () => quota());
    const sleep = vi.fn(async () => {});
    const err = await make(fetchFn, { sleep }).search('q').catch((e) => e);
    expect(err.message).toMatch(/cuota/);
    expect(err.googleCode).toBe('quotaError');
    expect(err.status).toBe(429);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('no reintenta otros 4xx y expone googleCode', async () => {
    const bad = json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'mal', details: [{ errors: [{ errorCode: { queryError: 'BAD' } }] }] } }, 400);
    const fetchFn = vi.fn().mockResolvedValueOnce(tokenRes()).mockResolvedValue(bad);
    const sleep = vi.fn();
    const err = await make(fetchFn, { sleep }).search('q').catch((e) => e);
    expect(err.message).toBe('Google Ads 400: mal');
    expect(err.googleCode).toBe('queryError');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('sube assets de imagen y YouTube', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(json({ results: [{ resourceName: 'customers/1/assets/9' }] }))
      .mockResolvedValueOnce(json({ results: [{ resourceName: 'customers/1/assets/10' }] }));
    const c = make(fetchFn);
    expect(await c.uploadImageAsset(Buffer.from('hola'), 'img')).toBe('customers/1/assets/9');
    expect(JSON.parse(fetchFn.mock.calls[1][1].body).operations[0]).toEqual({ create: { name: 'img', type: 'IMAGE', imageAsset: { data: Buffer.from('hola').toString('base64') } } });
    expect(await c.createYoutubeAsset('abc', 'yt')).toBe('customers/1/assets/10');
    expect(JSON.parse(fetchFn.mock.calls[2][1].body).operations[0]).toEqual({ create: { name: 'yt', type: 'YOUTUBE_VIDEO', youtubeVideoAsset: { youtubeVideoId: 'abc' } } });
  });
});
