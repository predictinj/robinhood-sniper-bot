import type { SafetyFinding, SafetyReport } from '../types/index.js';

export type SafetyGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface SafetyScore {
  score: number; // 0..100
  grade: SafetyGrade;
}

/**
 * Collapse a set of findings into an Axiom-style 0..100 risk score + letter
 * grade for at-a-glance UI. This is a *display* aid — the hard gate is still
 * `report.passed` (any critical failure blocks a buy regardless of score).
 */
export function scoreFindings(findings: SafetyFinding[]): SafetyScore {
  let score = 100;
  for (const f of findings) {
    if (f.passed) continue;
    if (f.severity === 'critical') score -= 45;
    else if (f.severity === 'warning') score -= 12;
  }
  // active-owner / limit warnings that "pass" but still carry risk nudge it down a touch
  for (const f of findings) {
    if (f.passed && f.severity === 'warning' && (f.check === 'ownership' || f.check === 'tx_wallet_limits')) {
      score -= 5;
    }
  }
  score = Math.max(0, Math.min(100, score));
  return { score, grade: gradeFor(score) };
}

export function scoreReport(report: SafetyReport): SafetyScore {
  return scoreFindings(report.findings);
}

function gradeFor(score: number): SafetyGrade {
  if (score >= 85) return 'A';
  if (score >= 68) return 'B';
  if (score >= 50) return 'C';
  if (score >= 30) return 'D';
  return 'F';
}
