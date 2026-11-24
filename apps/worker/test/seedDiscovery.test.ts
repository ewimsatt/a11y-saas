import { describe, expect, it, vi } from 'vitest';
import { persistAndFreezeDiscoveryScope } from '../src/seedDiscovery';

describe('persistAndFreezeDiscoveryScope', () => {
  const scan = {
    id: 'scan-1',
    discoveryEnabled: true,
    discoveryState: 'PENDING' as const,
    pages: [{ url: 'https://example.test/', urlIdentity: 'https://example.test/' }]
  };

  it('freezes a zero-candidate scope before the CRAWL stage advances', async () => {
    const createPages = vi.fn();
    const freeze = vi.fn().mockResolvedValue(undefined);
    const advance = vi.fn().mockResolvedValue(true);

    await expect(persistAndFreezeDiscoveryScope({ scan, hrefs: [], createPages, freeze, advance })).resolves.toEqual({ urls: [], truncated: false });

    expect(createPages).not.toHaveBeenCalled();
    expect(freeze).toHaveBeenCalledWith({ discoveryState: 'FROZEN', discoveryTruncated: false });
    expect(advance).toHaveBeenCalledOnce();
    expect(freeze.mock.invocationCallOrder[0]).toBeLessThan(advance.mock.invocationCallOrder[0]);
  });

  it('persists bounded canonical candidates, records truncation, then advances', async () => {
    const createPages = vi.fn().mockResolvedValue(undefined);
    const freeze = vi.fn().mockResolvedValue(undefined);
    const advance = vi.fn().mockResolvedValue(true);
    const hrefs = Array.from({ length: 20 }, (_, index) => `https://example.test/${index}`);

    await expect(persistAndFreezeDiscoveryScope({ scan, hrefs, createPages, freeze, advance })).resolves.toEqual({
      urls: hrefs.slice(0, 19),
      truncated: true
    });

    expect(createPages).toHaveBeenCalledWith(hrefs.slice(0, 19).map((url) => ({ scanId: 'scan-1', url, urlIdentity: url })));
    expect(freeze).toHaveBeenCalledWith({ discoveryState: 'FROZEN', discoveryTruncated: true });
    expect(advance).toHaveBeenCalledOnce();
  });

  it('does not advance a scope when candidate persistence fails', async () => {
    const createPages = vi.fn().mockRejectedValue(new Error('insertion failed'));
    const freeze = vi.fn();
    const advance = vi.fn();

    await expect(persistAndFreezeDiscoveryScope({
      scan,
      hrefs: ['https://example.test/about'],
      createPages,
      freeze,
      advance
    })).rejects.toThrow('insertion failed');

    expect(freeze).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });

  it('does not refreeze or advance a scope that another delivery already froze', async () => {
    const createPages = vi.fn();
    const freeze = vi.fn();
    const advance = vi.fn();

    await expect(persistAndFreezeDiscoveryScope({
      scan: { ...scan, discoveryState: 'FROZEN' },
      hrefs: ['https://example.test/about'],
      createPages,
      freeze,
      advance
    })).resolves.toBeNull();

    expect(createPages).not.toHaveBeenCalled();
    expect(freeze).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });
});
