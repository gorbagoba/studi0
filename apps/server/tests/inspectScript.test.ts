import { describe, expect, it } from 'vitest';
import { INSPECT_SCRIPT } from '../src/graph/inspectScript.js';

describe('INSPECT_SCRIPT', () => {
  it('reads graphify-out/graph.json and prints one JSON line', () => {
    expect(INSPECT_SCRIPT).toContain('os.path.join("graphify-out", "graph.json")');
    expect(INSPECT_SCRIPT).toContain('print(json.dumps(');
    expect(INSPECT_SCRIPT).toContain('"entity_types"');
    expect(INSPECT_SCRIPT).toContain('"relations"');
    expect(INSPECT_SCRIPT).toContain('"orphans"');
  });

  it('tolerates a missing or corrupt graph file', () => {
    expect(INSPECT_SCRIPT).toContain('except Exception:');
    expect(INSPECT_SCRIPT).toContain('data = {}');
  });

  it('contains no absolute paths', () => {
    expect(INSPECT_SCRIPT).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(INSPECT_SCRIPT).not.toMatch(/["']\//);
    expect(INSPECT_SCRIPT).not.toContain('C:');
  });
});
