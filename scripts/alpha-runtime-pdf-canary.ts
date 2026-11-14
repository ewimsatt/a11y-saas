async function main() {
  const { renderPdf } = await import('/app/apps/api/src/lib/report/pdf.ts');
  try {
    await renderPdf('<!doctype html><html><body><img src="http://web:3999/canary.png"></body></html>', 'alpha-request-canary');
    throw new Error('PDF renderer unexpectedly accepted an external request');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('PDF renderer blocked external request')) throw error;
    console.log(JSON.stringify({ blocked: true, message }));
  }
}

main();
