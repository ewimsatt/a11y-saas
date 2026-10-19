const MAX_PUBLIC_FAILURE_LENGTH = 160;

/**
 * Converts untrusted runtime errors into stable, public-facing categories.
 * Raw exceptions can contain URLs, credentials, filesystem paths, and call logs.
 */
export function publicFailureReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  // Stored controlled messages pass through API and report sanitization again.
  // Match the whole message, never a prefix that could carry appended secrets.
  if (raw === 'Browser could not start. Install the configured Chromium browser and retry.') return raw;
  const normalized = raw.toLowerCase();
  if (normalized.includes('executable doesn\'t exist') || normalized.includes('browsertype.launch') || normalized.includes('browser could not be found')) {
    return 'Browser could not start. Install the configured Chromium browser and retry.';
  }
  if (normalized.includes('timeout') || normalized.includes('timed out')) {
    return 'The page could not be loaded before the scan timeout.';
  }
  if (normalized.includes('http ') || normalized.includes('response')) {
    return 'The page returned an unsuccessful HTTP response.';
  }
  return 'Page analysis failed. Retry the scan or check the target.';
}

export function boundedPublicFailureReason(error: unknown): string {
  return publicFailureReason(error).slice(0, MAX_PUBLIC_FAILURE_LENGTH);
}
