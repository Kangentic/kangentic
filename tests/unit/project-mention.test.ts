import { describe, it, expect } from 'vitest';
import {
  findProjectMentions,
  isCommonWordName,
  PROJECT_TARGETING_PHRASES,
  type MentionCandidate,
} from '../../src/main/agent/mcp-http/project-mention';

// The routing check behind kangentic_create_task. A false positive costs the
// caller a confusing notice (or, for a Backlog create, a refusal); a missed
// strong hit lets a task land on the wrong board unflagged. Names are invented.

const ACTIVE: MentionCandidate = { name: 'host-app', isActive: true };

function projects(...names: string[]): MentionCandidate[] {
  return [ACTIVE, ...names.map((name) => ({ name, isActive: false }))];
}

function namesIn(description: string, ...registered: string[]): string[] {
  return findProjectMentions(projects(...registered), '', description).map((mention) => mention.name);
}

describe('findProjectMentions: standalone tokens', () => {
  it('does not match inside a hyphenated filename', () => {
    expect(namesIn('Follow the rule in no-garden-rules.md before merging.', 'Garden')).toEqual([]);
    // The same filename in the name's own case, and with a case-insensitive
    // name, so the boundary (not the case rule) is what keeps it out.
    expect(namesIn('Follow the rule in no-Garden-rules.md before merging.', 'Garden')).toEqual([]);
    expect(namesIn('Follow the rule in no-lumen-rules.md before merging.', 'LUMEN')).toEqual([]);
  });

  it('does not match inside a slashed path, nor a dotted filename', () => {
    expect(namesIn('See foo/Garden/bar for the layout.', 'Garden')).toEqual([]);
    expect(namesIn('Read Garden.json first.', 'Garden')).toEqual([]);
    expect(namesIn('Read lumen.json first.', 'LUMEN')).toEqual([]);
  });

  it('still matches a sentence-final name and a possessive', () => {
    expect(namesIn('The linter was ported from Lumen.', 'Lumen')).toEqual(['Lumen']);
    expect(namesIn("Check Lumen's changelog", 'Lumen')).toEqual(['Lumen']);
  });

  it('matches a dotted project name as a whole token', () => {
    expect(namesIn('update the acme.io landing page', 'acme.io')).toEqual(['acme.io']);
    expect(namesIn('see acmexio for details', 'acme.io')).toEqual([]);
  });
});

describe('findProjectMentions: skipped regions', () => {
  it('skips an inline code span', () => {
    expect(namesIn('Run `Lumen check` locally.', 'Lumen')).toEqual([]);
    expect(namesIn('Run ``Lumen `x` check`` locally.', 'Lumen')).toEqual([]);
  });

  it('skips fenced code, and matches again after the fence closes', () => {
    const description = ['Steps:', '```', 'cd Lumen', 'npm test', '```', 'Done.'].join('\n');
    expect(namesIn(description, 'Lumen')).toEqual([]);
    expect(namesIn(`${description}\nThen tell Lumen.`, 'Lumen')).toEqual(['Lumen']);
  });

  it('skips a URL', () => {
    expect(namesIn('Spec at https://example.test?ref=orbit-api and www.example.test?orbit-api', 'orbit-api')).toEqual([]);
  });
});

describe('findProjectMentions: case', () => {
  it('matches a common-word name only in its own case', () => {
    expect(namesIn('keep garden data out of logs', 'Garden')).toEqual([]);
    expect(namesIn('mirror the Garden setup', 'Garden')).toEqual(['Garden']);
    expect(namesIn('as in the field notes', 'Field Notes')).toEqual([]);
    expect(namesIn('as in Field Notes', 'Field Notes')).toEqual(['Field Notes']);
  });

  it('matches an identifier-like name in any case', () => {
    expect(namesIn('copy it from Orbit-API', 'orbit-api')).toEqual(['orbit-api']);
    expect(namesIn('copy it from lumen', 'LUMEN')).toEqual(['LUMEN']);
  });

  it('classifies names on both sides of the common-word heuristic', () => {
    expect(isCommonWordName('Garden')).toBe(true);
    expect(isCommonWordName('Field Notes')).toBe(true);
    for (const name of ['lumen', 'LUMEN', 'OrbitApi', 'orbit-api', 'acme.io', 'Phase2']) {
      expect(isCommonWordName(name)).toBe(false);
    }
  });
});

describe('findProjectMentions: strength', () => {
  it('rates a title hit of an identifier-like name strong, and of a common-word name weak', () => {
    expect(findProjectMentions(projects('orbit-api'), 'Port the orbit-api linter', 'long description')).toEqual([
      { name: 'orbit-api', registeredName: 'orbit-api', strength: 'strong', where: 'title' },
    ]);
    // "Lumen" is also an ordinary capitalized word, so a bare title hit is only a hint.
    expect(findProjectMentions(projects('Lumen'), 'Port the Lumen linter', 'long description')).toEqual([
      { name: 'Lumen', registeredName: 'Lumen', strength: 'weak', where: 'title' },
    ]);
  });

  it('rates a source reference weak and a targeting phrase strong', () => {
    for (const description of [
      'Port the config from Lumen.',
      'See Lumen PR 1794 for context.',
      "Read from Lumen's local clone.",
      // Phrases that look like targeting but name a source.
      'Copy the rules file in Lumen.',
      'It was copied from Lumen to do the parsing.',
      'The helper lives in the Lumen project.',
    ]) {
      expect(findProjectMentions(projects('Lumen'), 'Port the linter', description)).toEqual([
        { name: 'Lumen', registeredName: 'Lumen', strength: 'weak', where: 'mention' },
      ]);
    }
    for (const description of ['Please add it to Lumen.', "This belongs on Lumen's board.", 'Put a card under Lumen.', 'Track it in the Lumen backlog.', "Add to Lumen's todo."]) {
      expect(findProjectMentions(projects('Lumen'), 'Port the linter', description)).toEqual([
        { name: 'Lumen', registeredName: 'Lumen', strength: 'strong', where: 'phrase' },
      ]);
    }
  });

  it('rates a bare "in X" weak in the description and strong in the title', () => {
    expect(findProjectMentions(projects('Lumen'), 'Fix it', 'The script in Lumen does this.')[0].strength).toBe('weak');
    expect(findProjectMentions(projects('Lumen'), 'Fix the flaky test in Lumen', '')[0].strength).toBe('strong');
  });

  it('rates every phrase the routing instructions list as strong in a description, except the bare "in X"', () => {
    for (const phrase of PROJECT_TARGETING_PHRASES) {
      const description = `Context first. Then ${phrase.replace('X', 'Lumen')} please.`;
      const [mention] = findProjectMentions(projects('Lumen'), 'Untitled', description);
      expect(mention?.strength, phrase).toBe(phrase === 'in X' ? 'weak' : 'strong');
    }
  });

  it('keeps the strongest hit when a project is named more than once', () => {
    const description = "Ported from Lumen. Once it works, add it to Lumen's backlog too.";
    expect(findProjectMentions(projects('Lumen'), 'Port', description)).toEqual([
      { name: 'Lumen', registeredName: 'Lumen', strength: 'strong', where: 'phrase' },
    ]);
  });
});

function mentionsOf(registered: string, title: string, description: string) {
  return findProjectMentions(projects(registered), title, description);
}

describe('findProjectMentions: linear time on one huge token', () => {
  // A task description may run to 27,500 characters and this runs on main's
  // thread for every create that omits `project`. At 300,000 characters the old
  // quadratic patterns took 12 to 30 s; linear ones take milliseconds. The bound
  // is generous so a slow CI runner never trips it, and far below the old cost.
  const BUDGET_MS = 2000;
  const hugeTokens: Array<[string, string]> = [
    // PATH: one \S+ token with no separator.
    ['a long word', 'a'.repeat(300_000)],
    // URL: a long run the scheme pattern could restart inside from every boundary.
    ['a long hyphenated chain', 'a-'.repeat(150_000)],
    // INLINE_CODE. A bare run of backticks at the start of a line is read as a
    // fence and never reaches the inline pattern, so a prefix keeps it inline.
    ['a long backtick run inside a line', `x ${'`'.repeat(300_000)}`],
    // URL: a dotted chain, the other shape the capped scheme pattern guards.
    ['a long dotted chain', 'a.'.repeat(150_000)],
    // INLINE_CODE: a single backtick that never closes, from every position.
    ['many unclosed backticks on one line', 'x ` a '.repeat(50_000)],
    // Fence scan: every line opens or closes a block.
    ['a fence marker on every line', '```\n'.repeat(100_000)],
  ];

  for (const [label, text] of hugeTokens) {
    it(`finishes fast for ${label}`, () => {
      const startedAt = performance.now();
      const found = findProjectMentions(projects('Lumen'), '', text);
      const elapsed = performance.now() - startedAt;
      expect(found).toEqual([]);
      expect(elapsed).toBeLessThan(BUDGET_MS);
    });
  }

  it('finishes fast when the name itself repeats tens of thousands of times', () => {
    // Each hit is classified from an 80-character window, so the cost grows with
    // the hit count, not with the text length squared.
    const startedAt = performance.now();
    const found = findProjectMentions(projects('Lumen'), '', 'Lumen '.repeat(50_000));
    const elapsed = performance.now() - startedAt;
    expect(found).toEqual([{ name: 'Lumen', registeredName: 'Lumen', strength: 'weak', where: 'mention' }]);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});

describe('findProjectMentions: fences and paths', () => {
  it('skips a ~~~ fence and matches again after it closes', () => {
    const fenced = ['Steps:', '~~~', 'cd Lumen', '~~~', 'Done.'].join('\n');
    expect(namesIn(fenced, 'Lumen')).toEqual([]);
    expect(namesIn(`${fenced}\nThen tell Lumen.`, 'Lumen')).toEqual(['Lumen']);
  });

  it('does not close a four-backtick fence with a three-backtick line', () => {
    const open = ['Steps:', '````', 'cd Lumen', '```', 'still Lumen'];
    expect(namesIn(open.join('\n'), 'Lumen')).toEqual([]);
    // Closed by a run of four or more, and only then does prose count again.
    expect(namesIn([...open, '````', 'Done.'].join('\n'), 'Lumen')).toEqual([]);
    expect(namesIn([...open, '````', 'Then tell Lumen.'].join('\n'), 'Lumen')).toEqual(['Lumen']);
    expect(namesIn([...open, '`````', 'Then tell Lumen.'].join('\n'), 'Lumen')).toEqual(['Lumen']);
  });

  it('does not close a fence with a run of the other fence character', () => {
    expect(namesIn(['```', 'cd Lumen', '~~~', 'still Lumen'].join('\n'), 'Lumen')).toEqual([]);
  });

  it('blanks the rest of the text after a fence that never closes', () => {
    expect(namesIn(['Intro.', '```', 'cd Lumen', 'tell Lumen too'].join('\n'), 'Lumen')).toEqual([]);
  });

  it('skips a fence written with CRLF line endings and matches again after its close', () => {
    const fenced = ['Steps:', '```', 'cd Lumen', '```', 'Done.'].join('\r\n');
    expect(namesIn(fenced, 'Lumen')).toEqual([]);
    expect(namesIn(`${fenced}\r\nThen tell Lumen.`, 'Lumen')).toEqual(['Lumen']);
  });

  it('does not match a name inside a Windows path', () => {
    expect(namesIn('See C:\\work\\Lumen\\src for the layout.', 'Lumen')).toEqual([]);
  });
});

describe('findProjectMentions: curly apostrophe', () => {
  it('reads a curly possessive as a targeting phrase', () => {
    for (const description of ['Put it on Lumen\u2019s board.', 'Add to Lumen\u2019s todo.']) {
      expect(mentionsOf('Lumen', 'Port the linter', description)).toEqual([
        { name: 'Lumen', registeredName: 'Lumen', strength: 'strong', where: 'phrase' },
      ]);
    }
  });
});

describe('findProjectMentions: placing verbs', () => {
  it('rates a placement of a card or task into the project strong', () => {
    for (const description of [
      'Move this task into Lumen.',
      'Create a card onto Lumen.',
      'Create a task in Lumen for the footer.',
      'Add a new card in Lumen.',
    ]) {
      expect(mentionsOf('Lumen', 'Port the linter', description), description).toEqual([
        { name: 'Lumen', registeredName: 'Lumen', strength: 'strong', where: 'phrase' },
      ]);
    }
  });

  it('rates code or files that live in the project, or a verb in another sentence, weak', () => {
    for (const description of [
      'Add the helper in Lumen to the shared package.',
      'Move the logic in Lumen to the shared package.',
      'We should add it. Then ported to Lumen.',
      'Please file the bug in Lumen.',
    ]) {
      expect(mentionsOf('Lumen', 'Port the linter', description), description).toEqual([
        { name: 'Lumen', registeredName: 'Lumen', strength: 'weak', where: 'mention' },
      ]);
    }
  });
});

describe('findProjectMentions: title rules', () => {
  it('rates a bare title hit of a common-word name weak', () => {
    expect(mentionsOf('Garden', 'Garden party invites', '')).toEqual([
      { name: 'Garden', registeredName: 'Garden', strength: 'weak', where: 'title' },
    ]);
  });

  it('rates a title hit inside a targeting phrase strong', () => {
    expect(mentionsOf('Lumen', "Track it on Lumen's board", '')).toEqual([
      { name: 'Lumen', registeredName: 'Lumen', strength: 'strong', where: 'title' },
    ]);
  });

  it('rates a title hit of an identifier-like name strong anywhere', () => {
    expect(mentionsOf('orbit-api', 'orbit-api cleanup', '')).toEqual([
      { name: 'orbit-api', registeredName: 'orbit-api', strength: 'strong', where: 'title' },
    ]);
  });

  it('lets a description targeting phrase lift a weak title hit to strong', () => {
    expect(mentionsOf('Garden', 'Garden party invites', 'Please add it to Garden.')).toEqual([
      { name: 'Garden', registeredName: 'Garden', strength: 'strong', where: 'phrase' },
    ]);
  });

  it('keeps a weak title hit weak when the description only mentions the name', () => {
    expect(mentionsOf('Garden', 'Garden party invites', 'Ported from Garden.')).toEqual([
      { name: 'Garden', registeredName: 'Garden', strength: 'weak', where: 'title' },
    ]);
  });
});

describe('findProjectMentions: Unicode', () => {
  it('treats a letter next to the name as part of a longer word', () => {
    expect(namesIn('Ported from Lumen\u00e9.', 'Lumen')).toEqual([]);
    expect(namesIn('Ported from \u00e9Lumen.', 'Lumen')).toEqual([]);
    expect(namesIn('Ported from Lumen.', 'Lumen')).toEqual(['Lumen']);
  });

  it('classifies an accented capitalized word as a common-word name that matches only in its case', () => {
    expect(isCommonWordName('\u00c9clair')).toBe(true);
    expect(namesIn('ported from \u00e9clair', '\u00c9clair')).toEqual([]);
    expect(namesIn('ported from \u00c9clair', '\u00c9clair')).toEqual(['\u00c9clair']);
  });

  it('treats a digit or a non-Latin letter next to the name as part of a longer word', () => {
    expect(namesIn('Ported from Lumen2.', 'Lumen')).toEqual([]);
    expect(namesIn('Ported from 2Lumen.', 'Lumen')).toEqual([]);
    // Cyrillic capital Zhe, on each side.
    expect(namesIn('Ported from Lumen\u0416.', 'Lumen')).toEqual([]);
    expect(namesIn('Ported from \u0416Lumen.', 'Lumen')).toEqual([]);
  });

  it('matches an identifier-like name with accented letters in any case', () => {
    expect(namesIn('Ported from CAF\u00c9-API.', 'caf\u00e9-api')).toEqual(['caf\u00e9-api']);
    expect(namesIn('Ported from caf\u00e9-api.', 'CAF\u00c9-API')).toEqual(['CAF\u00c9-API']);
  });
});

describe('findProjectMentions: registered name normalization', () => {
  it('matches on the collapsed name and reports the registered one for the selector', () => {
    expect(mentionsOf('  Field   Notes ', '', 'as in Field Notes')).toEqual([
      { name: 'Field Notes', registeredName: '  Field   Notes ', strength: 'weak', where: 'mention' },
    ]);
  });

  it('yields one mention for two registered names that normalize alike', () => {
    const found = findProjectMentions(projects('Lumen Labs', ' Lumen   Labs'), '', 'Ported from Lumen Labs.');
    expect(found).toHaveLength(1);
    expect(found[0].registeredName).toBe('Lumen Labs');
  });
});

describe('findProjectMentions: scope', () => {
  it('ignores the active project and names under three characters', () => {
    expect(findProjectMentions([{ name: 'Lumen', isActive: true }, { name: 'QA', isActive: false }], 'Lumen QA pass', '')).toEqual([]);
  });

  it('returns each project once, in registration order', () => {
    const found = findProjectMentions(projects('Garden', 'orbit-api'), '', 'Ported from orbit-api and Garden, then orbit-api again.');
    expect(found.map((mention) => mention.name)).toEqual(['Garden', 'orbit-api']);
  });
});
