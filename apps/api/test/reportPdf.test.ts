import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPdf } from '../src/lib/report/pdf';

const mocks = vi.hoisted(() => ({
  browserClose: vi.fn(),
  contextClose: vi.fn(),
  launch: vi.fn(),
  newContext: vi.fn(),
  pdf: vi.fn(),
  route: vi.fn(),
  setContent: vi.fn()
}));
vi.mock('playwright', () => ({ chromium: { launch: mocks.launch } }));

const page = { setContent: mocks.setContent, pdf: mocks.pdf };
const context = { newPage: async () => page, close: mocks.contextClose, route: mocks.route };
const browser = { newContext: mocks.newContext, close: mocks.browserClose };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete process.env.PDF_RENDERER_URL;
  delete process.env.PDF_RENDERER_TOKEN;
  mocks.pdf.mockResolvedValue(Buffer.from('unit-test-only'));
  mocks.newContext.mockResolvedValue(context);
  mocks.launch.mockResolvedValue(browser);
});

describe('PDF renderer boundaries', () => {
  it('delegates packaged rendering to the authenticated PDF renderer service', async () => {
    process.env.PDF_RENDERER_URL = 'http://pdf-renderer:3002/render';
    process.env.PDF_RENDERER_TOKEN = 'fixture-renderer-token';
    const remotePdf = Buffer.from('%PDF-1.7 fixture');
    const fetchMock = vi.fn().mockResolvedValue(new Response(remotePdf, {
      status: 200,
      headers: { 'content-type': 'application/pdf' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(renderPdf('<h1>Fixture</h1>', 'fixture-scan')).resolves.toEqual(remotePdf);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('http://pdf-renderer:3002/render', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer fixture-renderer-token' }),
      body: JSON.stringify({ html: '<h1>Fixture</h1>', scanTitle: 'fixture-scan' })
    }));
  });

  it('preserves a renderer request-policy denial as a fail-closed client error', async () => {
    process.env.PDF_RENDERER_URL = 'http://pdf-renderer:3002/render';
    process.env.PDF_RENDERER_TOKEN = 'fixture-renderer-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'PDF renderer blocked external request' }), {
      status: 422,
      headers: { 'content-type': 'application/json' }
    })));

    await expect(renderPdf('<img src="http://canary.invalid/pixel.png">', 'fixture-scan')).rejects.toThrow('PDF renderer blocked external request');
  });

  it('reads the authenticated renderer response incrementally and rejects a missing stream', async () => {
    process.env.PDF_RENDERER_URL = 'http://pdf-renderer:3002/render';
    process.env.PDF_RENDERER_TOKEN = 'fixture-renderer-token';
    const chunks = [Buffer.from('%PDF-1.7 '), Buffer.from('streamed fixture')];
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: chunks[0] })
        .mockResolvedValueOnce({ done: false, value: chunks[1] })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn(),
      releaseLock: vi.fn()
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      body: { getReader: () => reader },
      arrayBuffer: vi.fn(() => { throw new Error('must not buffer renderer response with arrayBuffer'); })
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(renderPdf('<h1>Fixture</h1>', 'fixture-scan')).resolves.toEqual(Buffer.concat(chunks));
    expect(reader.read).toHaveBeenCalledTimes(3);

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/pdf' }), body: null });
    await expect(renderPdf('<h1>Fixture</h1>', 'fixture-scan')).rejects.toThrow('PDF renderer service returned an unreadable PDF stream');
  });

  it('requests tags, outlines and escaped footer metadata', async () => {
    await renderPdf('<h1>Fixture</h1>', '<img src="https://invalid.test/">&');
    const options = mocks.pdf.mock.calls[0]![0];
    expect(options.tagged).toBe(true);
    expect(options.outline).toBe(true);
    expect(options.displayHeaderFooter).toBe(true);
    expect(options.footerTemplate).toContain('&lt;img src=&quot;https://invalid.test/&quot;&gt;&amp;');
    expect(options.footerTemplate).not.toContain('<img');
  });

  it('uses sandboxed packaged Chromium and a scriptless blocked-service-worker context', async () => {
    const original = process.env.PDF_CHROMIUM_EXECUTABLE_PATH;
    process.env.PDF_CHROMIUM_EXECUTABLE_PATH = '/usr/bin/chromium-browser';
    try {
      await renderPdf('<h1>Fixture</h1>', 'fixture-scan');
      expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({
        executablePath: '/usr/bin/chromium-browser',
        headless: true,
        chromiumSandbox: true
      }));
      expect(mocks.newContext).toHaveBeenCalledWith({ javaScriptEnabled: false, serviceWorkers: 'block' });
    } finally {
      if (original === undefined) delete process.env.PDF_CHROMIUM_EXECUTABLE_PATH;
      else process.env.PDF_CHROMIUM_EXECUTABLE_PATH = original;
    }
  });

  it('blocks every routed renderer request and fails closed after an attempted request', async () => {
    await renderPdf('<h1>Fixture</h1>', 'fixture-scan');
    expect(mocks.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    const handler = mocks.route.mock.calls[0]![1];
    const abort = vi.fn();
    await handler({ abort, request: () => ({ resourceType: () => 'image', url: () => 'http://canary.test/pixel.png' }) });
    expect(abort).toHaveBeenCalledOnce();
    await expect(renderPdf('<h1>Fixture</h1>', 'fixture-scan')).resolves.toEqual(Buffer.from('unit-test-only'));
  });

  it('closes the context and browser if rendering fails', async () => {
    mocks.pdf.mockRejectedValueOnce(new Error('Synthetic renderer failure'));
    await expect(renderPdf('<h1>Fixture</h1>', 'fixture-scan')).rejects.toThrow('Synthetic renderer failure');
    expect(mocks.contextClose).toHaveBeenCalledOnce();
    expect(mocks.browserClose).toHaveBeenCalledOnce();
  });
});
