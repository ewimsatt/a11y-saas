import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPdf } from '../src/lib/report/pdf';

const mocks = vi.hoisted(() => ({ pdf: vi.fn(), close: vi.fn(), setContent: vi.fn() }));
vi.mock('playwright', () => ({
  chromium: {
    launch: async () => ({
      newPage: async () => ({ setContent: mocks.setContent, pdf: mocks.pdf }),
      close: mocks.close
    })
  }
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pdf.mockResolvedValue(Buffer.from('unit-test-only'));
});

describe('PDF renderer boundaries', () => {
  it('requests tags, outlines and footers without interpolating raw metadata HTML', async () => {
    await renderPdf('<h1>Fixture</h1>', '<img src="https://invalid.test/">&');
    const options = mocks.pdf.mock.calls[0]![0];
    expect(options.tagged).toBe(true);
    expect(options.outline).toBe(true);
    expect(options.displayHeaderFooter).toBe(true);
    expect(options.footerTemplate).toContain('&lt;img src=&quot;https://invalid.test/&quot;&gt;&amp;');
    expect(options.footerTemplate).not.toContain('<img');
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('closes the browser if PDF rendering fails', async () => {
    mocks.pdf.mockRejectedValueOnce(new Error('Synthetic renderer failure'));
    await expect(renderPdf('<h1>Fixture</h1>', 'fixture-scan')).rejects.toThrow('Synthetic renderer failure');
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
