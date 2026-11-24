import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

describe('scanner egress harness', () => {
  it('runs the baked production BrowserSession probe outside the browser trust boundary', async () => {
    const [compose, harness, probe, dockerfile, alphaCompose, acceptanceCompose, productionDockerfile, productionPackage] = await Promise.all([
      readFile(resolve(root, 'docker-compose.scanner-boundary-test.yml'), 'utf8'),
      readFile(resolve(root, 'scripts/test-scanner-egress.mjs'), 'utf8'),
      readFile(resolve(root, 'test/network-fixtures/scanner-probe.ts'), 'utf8'),
      readFile(resolve(root, 'infra/scanner-probe/Dockerfile'), 'utf8'),
      readFile(resolve(root, 'docker-compose.alpha.yml'), 'utf8'),
      readFile(resolve(root, 'scripts/acceptance-compose.yml'), 'utf8'),
      readFile(resolve(root, 'infra/playwright/Dockerfile'), 'utf8'),
      readFile(resolve(root, 'infra/playwright/package.json'), 'utf8')
    ]);

    const scannerProbe = compose.match(/^  scanner-probe:\n([\s\S]*?)(?=^  [a-z][\w-]+:|^networks:)/m)?.[0] ?? '';
    const browser = compose.match(/^  browser:\n([\s\S]*?)(?=^  [a-z][\w-]+:|^networks:)/m)?.[0] ?? '';

    expect(scannerProbe).toContain('build:');
    expect(scannerProbe).toMatch(/context: \./);
    expect(scannerProbe).toMatch(/user: node[\s\S]*?read_only: true/);
    expect(scannerProbe).toMatch(/networks:\n\s+browser_internal: \{\}/);
    expect(scannerProbe).not.toContain('scanner_egress:');
    expect(scannerProbe).not.toMatch(/trap_(?:private|metadata|ipv6):/);
    expect(browser).not.toContain('volumes:');
    expect(compose).not.toContain('./packages/scanner/src:/app/scanner/src:ro');
    expect(compose).not.toContain('./test/network-fixtures:/app/fixtures:ro');

    expect(harness).toContain("'scanner-probe', 'node', '/app/node_modules/tsx/dist/cli.mjs', '/app/scanner-probe/scanner-probe.ts'");
    expect(harness).toContain('PLAYWRIGHT_WS_ENDPOINT=ws://browser:3000/');
    expect(harness).toContain("['browser', 'scanner-probe', 'smokescreen', 'fixture', 'dns']");

    expect(dockerfile).toContain('COPY infra/scanner-probe/package.json infra/scanner-probe/package-lock.json ./');
    expect(dockerfile).toContain('COPY packages/scanner/src ./scanner/src');
    expect(dockerfile).toContain('COPY test/network-fixtures/scanner-probe.ts ./scanner-probe/scanner-probe.ts');
    expect(dockerfile).not.toMatch(/COPY\s+\.\s+\./);
    expect(dockerfile).not.toMatch(/node_modules/);

    expect(probe).toContain("import { createBrowserSession } from '../scanner/src/axeAdapter.js'");
    expect(probe).toContain('session.discoverPage(');
    expect(probe).toContain('session.scanPage(');

    // The root-context boundary harness may carry its own fixture probe, but the
    // shipped alpha and full-stack browser image must remain buildable from its
    // narrow `infra/playwright` context.
    expect(browser).toMatch(/dockerfile: infra\/playwright\/Dockerfile\.test/);
    expect(alphaCompose).toContain('build: { context: ./infra/playwright }');
    expect(acceptanceCompose).toMatch(/browser:\n\s+build:\n\s+context: \.\.\/infra\/playwright/);
    expect(productionDockerfile).toContain('COPY package.json package-lock.json /app/');
    expect(productionDockerfile).toContain('COPY --chown=pwuser:pwuser server.mjs /app/server.mjs');
    expect(productionDockerfile).not.toContain('browser-probe.mjs');
    expect(productionDockerfile).not.toContain('COPY infra/playwright/');
    expect(productionPackage).not.toContain('@axe-core/playwright');
    expect(productionPackage).not.toContain('"tsx"');
  });
});
