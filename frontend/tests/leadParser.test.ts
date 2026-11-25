import { describe, expect, it } from 'vitest';
import { parseLeadsFromText } from '../src/lib/leadParser';

describe('parseLeadsFromText', () => {
  it('parses CSV with header row, deduplicates case-insensitively, and counts invalid emails', () => {
    const csv = [
      'email,name,company',
      'Alice@Acme.com,Alice,Acme',
      '"bob@startup.io",Bob,Startup',
      'alice@acme.com,Alice Duplicate,Acme',
      'bad-email@,Invalid,Test',
      'carol@enterprise.org; dave@saas.dev',
    ].join('\n');

    const result = parseLeadsFromText(csv);

    expect(result.emails).toEqual([
      'alice@acme.com',
      'bob@startup.io',
      'carol@enterprise.org',
      'dave@saas.dev',
    ]);
    expect(result.duplicateCount).toBe(1);
    expect(result.invalidCount).toBe(1);
  });

  it('handles 1,500+ leads cleanly', () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `lead${i}@domain.com`);
    const result = parseLeadsFromText(lines.join('\n'));
    expect(result.emails).toHaveLength(1500);
    expect(result.duplicateCount).toBe(0);
    expect(result.invalidCount).toBe(0);
  });
});
