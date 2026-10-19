import { describe, expect, it } from 'vitest';
import { publicFailureReason } from '../src/failureReason';

describe('public failure messages across persistence and API/render boundaries', () => {
  it.each([
    "browserType.launch: Executable doesn't exist at /private/home/secret/browser",
    'Navigation timeout exceeded at https://alice:secret@example.com/?token=private',
    'HTTP 503 response',
    '/private/runtime/config contained an unexpected secret'
  ])('is idempotent after mapping %s', (raw) => {
    const publicMessage = publicFailureReason(raw);
    expect(publicFailureReason(publicMessage)).toBe(publicMessage);
    expect(publicMessage).not.toMatch(/alice|secret|\/private|token=/);
  });
  it('does not trust a controlled-message prefix followed by secret material', () => {
    const publicMessage = publicFailureReason("browserType.launch: Executable doesn't exist");
    expect(publicFailureReason(`${publicMessage} /private/secret?token=hidden`)).not.toMatch(/private|secret|hidden/);
  });
});
