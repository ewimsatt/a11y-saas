import { afterEach, describe, expect, it } from 'vitest';
import { createApp, resolveRuntimeConfig } from '../src/app';

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('local runtime boundary', () => {
  it('uses loopback and the local web origins by default', () => {
    expect(resolveRuntimeConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3001,
      allowedOrigins: ['http://localhost:3010', 'http://127.0.0.1:3010']
    });
  });

  it('rejects a non-loopback API host before listening', () => {
    expect(() => resolveRuntimeConfig({ HOST: '0.0.0.0' })).toThrow(/loopback/i);
  });

  it('allows configured trusted origins while refusing untrusted browser origins', async () => {
    const app = await createApp({
      host: '127.0.0.1',
      port: 3001,
      allowedOrigins: ['http://localhost:3010']
    }, { includeApplicationRoutes: false });
    apps.push(app);

    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/healthz',
      headers: {
        origin: 'http://localhost:3010',
        'access-control-request-method': 'GET'
      }
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3010');

    const denied = await app.inject({
      method: 'OPTIONS',
      url: '/healthz',
      headers: {
        origin: 'https://untrusted.example',
        'access-control-request-method': 'GET'
      }
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
