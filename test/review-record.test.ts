import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The review record quotes Codex's findings with file:line links. Those
// lines only mean something at the commit Codex reviewed, so every link in
// its text must stay pinned to that commit.
const REVIEWED_SHA = 'eb16c284011c35655aefe40b69e22d0a79d7540a';
const record = readFileSync(
  new URL('../reviews/2026-09-26-codex-adversarial-review.md', import.meta.url),
  'utf8',
);
const codexText = record.slice(
  record.indexOf('# Verdict: NO-SHIP'),
  record.indexOf('## My decisions'),
);
const linkTargets = [...codexText.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!);

describe('Codex review record', () => {
  it('pins every file:line link in Codex text to the reviewed commit', () => {
    expect(linkTargets).toHaveLength(43);
    for (const target of linkTargets) {
      expect(target).toMatch(
        new RegExp(
          `^https://github\\.com/Raz-Gits/Instantly-Reply-Bot/blob/${REVIEWED_SHA}/[\\w./-]+(\\?plain=1)?#L\\d+$`,
        ),
      );
    }
  });

  it('keeps no local or HEAD-relative paths in Codex text', () => {
    expect(codexText).not.toMatch(/C:\/Users/);
    expect(codexText).not.toMatch(/\]\(\.\.\//);
  });
});
