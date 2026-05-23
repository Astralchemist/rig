import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCHEMA = readFileSync(resolve(__dirname, '../generated/core/schema.sql'), 'utf-8');

// Golden assertions on the generated schema. Locks in v1 + v2 surfaces so an
// accidental migration edit fails loudly. Update intentionally when migration
// contracts change.
describe('schema golden (v1 + v2)', () => {
  const expectedTables = [
    'schema_versions',
    'files',
    'nodes',
    'edges',
    'edges_semantic',
    'embeddings',
    'activations',
    'unresolved_refs',
    'pending_edges',
    'mutation_log',
  ];
  const expectedTriggers = [
    'nodes_after_insert',
    'nodes_after_update',
    'nodes_after_delete',
    'edges_provenance_nonempty',
    'edges_semantic_provenance_nonempty',
    'pending_edges_provenance_nonempty',
    'pending_edges_rationale_nonempty',
  ];

  for (const t of expectedTables) {
    test(`table ${t} present`, () => {
      expect(SCHEMA).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    });
  }

  for (const t of expectedTriggers) {
    test(`trigger ${t} present`, () => {
      expect(SCHEMA).toContain(`CREATE TRIGGER IF NOT EXISTS ${t}`);
    });
  }

  test('FTS5 virtual table includes node_id UNINDEXED', () => {
    expect(SCHEMA).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts');
    expect(SCHEMA).toContain('node_id UNINDEXED');
  });

  test('migrations are versioned 1, 2, 3, 4', () => {
    expect(SCHEMA).toContain('-- v1:');
    expect(SCHEMA).toContain('-- v2:');
    expect(SCHEMA).toContain('-- v3:');
    expect(SCHEMA).toContain('-- v4:');
  });

  test('v3 adds is_hub + hubness columns + hub indexes', () => {
    expect(SCHEMA).toMatch(/ALTER TABLE nodes ADD COLUMN is_hub/);
    expect(SCHEMA).toMatch(/ALTER TABLE nodes ADD COLUMN hubness/);
    expect(SCHEMA).toContain('CREATE INDEX IF NOT EXISTS idx_nodes_is_hub');
    expect(SCHEMA).toContain('CREATE INDEX IF NOT EXISTS idx_nodes_hubness');
  });

  test('v4 adds aliases table + FTS + provenance trigger', () => {
    expect(SCHEMA).toContain('CREATE TABLE IF NOT EXISTS aliases');
    expect(SCHEMA).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS aliases_fts');
    expect(SCHEMA).toContain('CREATE TRIGGER IF NOT EXISTS aliases_provenance_nonempty');
  });

  test('embeddings table has vector BLOB + dim columns', () => {
    expect(SCHEMA).toMatch(/embeddings[^;]+dim INTEGER/);
    expect(SCHEMA).toMatch(/embeddings[^;]+vector BLOB/);
  });

  test('pending_edges has status CHECK + provenance NOT NULL + rationale NOT NULL', () => {
    expect(SCHEMA).toContain("status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected'))");
    expect(SCHEMA).toMatch(/pending_edges[\s\S]+provenance TEXT NOT NULL/);
    expect(SCHEMA).toMatch(/pending_edges[\s\S]+rationale TEXT NOT NULL/);
  });
});
