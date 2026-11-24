import { createBrowserSession } from '../scanner/src/axeAdapter.js';

const seed = 'https://allowed.test/https-discovery';
const childUrl = 'https://allowed.test/https-child';
const session = await createBrowserSession();
try {
  const hrefs = await session.discoverPage(seed);
  const child = await session.scanPage(childUrl);
  console.log(JSON.stringify({
    hrefs,
    child: {
      responseStatus: child.responseStatus,
      title: child.title,
      html: child.html,
      screenshotBytes: child.screenshotBuffer.byteLength,
      violations: child.violations.length
    }
  }));
} finally {
  await session.close();
}
