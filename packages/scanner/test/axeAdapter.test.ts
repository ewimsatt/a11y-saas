import { describe, expect, it } from 'vitest';
import { toRawViolations } from '../src/axeAdapter';

describe('toRawViolations', () => {
  it('retains every axe node with its own selector and DOM evidence', () => {
    const findings = toRawViolations([
      {
        id: 'image-alt',
        impact: 'critical',
        description: 'Images must have alternative text',
        tags: ['wcag2a', 'wcag111'],
        nodes: [
          { target: ['img.hero'], html: '<img class="hero">', failureSummary: 'Fix this image.' },
          { target: ['main', 'img.card'], html: '<img class="card">', failureSummary: 'Fix this card image.' }
        ]
      }
    ]);

    expect(findings).toEqual([
      expect.objectContaining({ selector: 'img.hero', domSnippet: '<img class="hero">', failureSummary: 'Fix this image.' }),
      expect.objectContaining({ selector: 'main >> img.card', domSnippet: '<img class="card">', failureSummary: 'Fix this card image.' })
    ]);
  });

  it('preserves structural target identity while keeping display selectors readable', () => {
    const findings = toRawViolations([
      {
        id: 'image-alt',
        impact: 'critical',
        description: 'Images must have alternative text',
        nodes: [
          { target: ['button'], html: '<button>top</button>', failureSummary: 'top evidence' },
          { target: [['iframe'], ['button']], html: '<button>frame</button>', failureSummary: 'frame evidence' },
          { target: [['iframe'], ['iframe'], ['button']], html: '<button>nested</button>', failureSummary: 'nested evidence' },
          { target: [['custom-element'], ['button']], html: '<button>shadow</button>', failureSummary: 'shadow evidence' },
          { target: [['iframe'], ['button']], html: '<button>frame duplicate</button>', failureSummary: 'duplicate evidence' }
        ]
      }
    ]);

    expect(findings.map((finding) => finding.targetIdentity)).toEqual([
      '["button"]',
      '[["iframe"],["button"]]',
      '[["iframe"],["iframe"],["button"]]',
      '[["custom-element"],["button"]]',
      '[["iframe"],["button"]]'
    ]);
    expect(findings.map((finding) => finding.selector)).toEqual([
      'button',
      'iframe >> button',
      'iframe >> iframe >> button',
      'custom-element >> button',
      'iframe >> button'
    ]);
    expect(findings[1]).toMatchObject({ domSnippet: '<button>frame</button>', failureSummary: 'frame evidence' });
  });
});
