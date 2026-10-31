import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const connect = vi.fn();
const launch = vi.fn();
vi.mock('playwright', () => ({ chromium: { connect, launch } }));

import { createBrowserSession, normalizeWcagCriteria, toRawViolations } from '../src/axeAdapter';

describe('normalizeWcagCriteria', () => {
  it('converts only raw axe success-criterion tags into dotted criteria', () => {
    expect(normalizeWcagCriteria(['wcag131', 'wcag111', 'wcag2aa', 'best-practice', 'wcag999'])).toEqual(['1.3.1', '1.1.1']);
  });
});

describe('toRawViolations', () => {
  it('retains every axe node with its own selector and DOM evidence', () => {
    const findings = toRawViolations([
      {
        id: 'image-alt',
        impact: 'critical',
        description: 'Images must have alternative text',
        tags: ['wcag2a', 'wcag111'],
        nodes: [
          { target: ['img.hero'], html: '<img class="hero">', failureSummary: 'Fix this image.' },
          { target: ['main', 'img.card'], html: '<img class="card">', failureSummary: 'Fix this card image.' }
        ]
      }
    ]);

    expect(findings).toEqual([
      expect.objectContaining({ selector: 'img.hero', domSnippet: '<img class="hero">', failureSummary: 'Fix this image.' }),
      expect.objectContaining({ selector: 'main >> img.card', domSnippet: '<img class="card">', failureSummary: 'Fix this card image.' })
    ]);
  });

  it('preserves structural target identity while keeping display selectors readable', () => {
    const findings = toRawViolations([
      {
        id: 'image-alt',
        impact: 'critical',
        description: 'Images must have alternative text',
        nodes: [
          { target: ['button'], html: '<button>top</button>', failureSummary: 'top evidence' },
          { target: [['iframe'], ['button']], html: '<button>frame</button>', failureSummary: 'frame evidence' },
          { target: [['iframe'], ['iframe'], ['button']], html: '<button>nested</button>', failureSummary: 'nested evidence' },
          { target: [['custom-element'], ['button']], html: '<button>shadow</button>', failureSummary: 'shadow evidence' },
          { target: [['iframe'], ['button']], html: '<button>frame duplicate</button>', failureSummary: 'duplicate evidence' }
        ]
      }
    ]);

    expect(findings.map((finding) => finding.targetIdentity)).toEqual([
      '["button"]',
      '[["iframe"],["button"]]',
      '[["iframe"],["iframe"],["button"]]',
      '[["custom-element"],["button"]]',
      '[["iframe"],["button"]]'
    ]);
    expect(findings.map((finding) => finding.selector)).toEqual([
      'button',
      'iframe >> button',
      'iframe >> iframe >> button',
      'custom-element >> button',
      'iframe >> button'
    ]);
    expect(findings[1]).toMatchObject({ domSnippet: '<button>frame</button>', failureSummary: 'frame evidence' });
  });
});

describe('createBrowserSession sidecar boundary', () => {
  const originalEndpoint = process.env.PLAYWRIGHT_WS_ENDPOINT;

  beforeEach(() => {
    connect.mockReset();
    launch.mockReset();
    process.env.PLAYWRIGHT_WS_ENDPOINT = 'ws://browser:3000/a-strong-unlogged-token';
  });

  it('connects only to the configured remote sidecar and blocks service workers', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue({ ok: () => true, status: () => 200 }),
      title: vi.fn().mockResolvedValue('Fixture'),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png'))
    };
    const context = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    connect.mockResolvedValue(browser);

    const session = await createBrowserSession();
    await session.crawlPage('https://allowed.example');

    expect(connect).toHaveBeenCalledWith('ws://browser:3000/a-strong-unlogged-token');
    expect(browser.newContext).toHaveBeenCalledWith({ serviceWorkers: 'block' });
    expect(launch).not.toHaveBeenCalled();
    await session.close();
  });

  it('fails closed before any local browser launch when the endpoint is missing or malformed', async () => {
    process.env.PLAYWRIGHT_WS_ENDPOINT = '';
    await expect(createBrowserSession()).rejects.toThrow('PLAYWRIGHT_WS_ENDPOINT');
    process.env.PLAYWRIGHT_WS_ENDPOINT = 'http://browser:3000/not-websocket';
    await expect(createBrowserSession()).rejects.toThrow('PLAYWRIGHT_WS_ENDPOINT');
    expect(connect).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('turns connection failures into a sanitized scan startup failure with no fallback', async () => {
    connect.mockRejectedValue(new Error('websocket endpoint ws://browser:3000/secret-token refused'));

    await expect(createBrowserSession()).rejects.toThrow('Remote scanner browser is unavailable');
    expect(launch).not.toHaveBeenCalled();
  });

  afterAll(() => {
    if (originalEndpoint === undefined) delete process.env.PLAYWRIGHT_WS_ENDPOINT;
    else process.env.PLAYWRIGHT_WS_ENDPOINT = originalEndpoint;
  });
});
