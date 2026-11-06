export type ComparableScanLifecycle = {
  status: string;
  coverage: string;
  pages: readonly { outcome: string }[];
};

/** A scan may drive longitudinal comparison only after every requested page is analyzed. */
export function isComparableScan(scan: ComparableScanLifecycle): boolean {
  return (
    scan.status === 'completed' &&
    scan.coverage === 'COMPLETE' &&
    scan.pages.length > 0 &&
    scan.pages.every((page) => page.outcome === 'ANALYZED')
  );
}
