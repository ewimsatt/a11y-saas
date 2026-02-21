import React from 'react';
import { IssuesTable } from '../components/IssuesTable';
import { EvidencePanel } from '../components/EvidencePanel';

const sample = [
  { id: '1', severity: 'CRITICAL', status: 'OPEN', wcag: '1.3.1', message: 'Headings should not be empty' }
] as const;

export default function HomePage() {
  return (
    <main>
      <h1>Issues > Accessibility</h1>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        <IssuesTable issues={[...sample] as any} />
        <EvidencePanel />
      </div>
    </main>
  );
}
