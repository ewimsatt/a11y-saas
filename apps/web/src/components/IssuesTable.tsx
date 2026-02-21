import React from 'react';

type Issue = {
  id: string;
  severity: 'CRITICAL' | 'SERIOUS' | 'MODERATE' | 'MINOR';
  status: 'OPEN' | 'FIXED' | 'REGRESSED' | 'WAIVED';
  wcag: string;
  message: string;
};

export function IssuesTable({ issues }: { issues: Issue[] }) {
  return (
    <div>
      <h2>Issues</h2>
      <div>
        <label>Severity</label> <select><option>All</option></select>
        <label>Status</label> <select><option>All</option></select>
        <label>WCAG</label> <input placeholder="e.g. 1.3.1" />
      </div>
      <table>
        <thead><tr><th>Severity</th><th>Status</th><th>WCAG</th><th>Message</th></tr></thead>
        <tbody>
          {issues.map(i => (
            <tr key={i.id}><td>{i.severity}</td><td>{i.status}</td><td>{i.wcag}</td><td>{i.message}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
