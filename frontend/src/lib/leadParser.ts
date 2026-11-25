export interface ParsedLeadsResult {
  emails: string[];
  duplicateCount: number;
  invalidCount: number;
  totalTokensScanned: number;
}

const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/;

/**
 * Parses email addresses from CSV, TSV, or plain-text lead files.
 * Handles quoted cells, header rows (e.g. "email,name"), semicolons, and newlines.
 */
export function parseLeadsFromText(rawText: string): ParsedLeadsResult {
  const seen = new Set<string>();
  const emails: string[] = [];
  let duplicateCount = 0;
  let invalidCount = 0;
  let totalTokensScanned = 0;

  const lines = rawText.split(/\r?\n/);

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx].trim();
    if (!line) continue;

    const tokens = line
      .split(/[,;\t\s]+/)
      .map((t) => t.replace(/^["'<>()]+|["'<>()]+$/g, '').trim())
      .filter(Boolean);

    for (const token of tokens) {
      // Skip common CSV header labels without counting them as invalid emails
      if (
        lineIdx === 0 &&
        /^(email|e-mail|email_address|lead_email|recipient|name|first_name|last_name|company)$/i.test(
          token,
        )
      ) {
        continue;
      }

      totalTokensScanned++;

      if (EMAIL_REGEX.test(token)) {
        const normalized = token.toLowerCase();
        if (seen.has(normalized)) {
          duplicateCount++;
        } else {
          seen.add(normalized);
          emails.push(normalized);
        }
      } else if (token.includes('@')) {
        invalidCount++;
      }
    }
  }

  return {
    emails,
    duplicateCount,
    invalidCount,
    totalTokensScanned,
  };
}
