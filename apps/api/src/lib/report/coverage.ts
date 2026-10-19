import { scoreGrade } from './stats';

export type Coverage = 'PENDING' | 'COMPLETE' | 'PARTIAL' | 'FAILED';

export function reportAssessment(coverage: Coverage, score: number): {
  score: number | null;
  grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  label: string;
} {
  if (coverage === 'COMPLETE') return { score, grade: scoreGrade(score), label: 'Complete coverage' };
  if (coverage === 'PARTIAL') return { score: null, grade: null, label: 'Partial coverage' };
  if (coverage === 'FAILED') return { score: null, grade: null, label: 'Scan failed' };
  return { score: null, grade: null, label: 'Scan not complete' };
}
