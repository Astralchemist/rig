// SPDX-License-Identifier: Apache-2.0
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

  test('migrations are versioned 1, 2, 3, 4, 5, 6', () => {
    expect(SCHEMA).toContain('-- v1:');
    expect(SCHEMA).toContain('-- v2:');
    expect(SCHEMA).toContain('-- v3:');
    expect(SCHEMA).toContain('-- v4:');
    expect(SCHEMA).toContain('-- v5:');
    expect(SCHEMA).toContain('-- v6:');
  });

  test('v6 adds community_id column + index', () => {
    expect(SCHEMA).toMatch(/ALTER TABLE nodes ADD COLUMN community_id/);
    expect(SCHEMA).toContain('CREATE INDEX IF NOT EXISTS idx_nodes_community');
  });

  test('v5 adds text_hash to embeddings', () => {
    expect(SCHEMA).toMatch(/ALTER TABLE embeddings ADD COLUMN text_hash/);
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

  test('v12 adds extractor_version + per-file artifacts cascaded with the files row', () => {
    expect(SCHEMA).toContain('-- v12:');
    expect(SCHEMA).toMatch(/ALTER TABLE files ADD COLUMN extractor_version/);
    for (const t of ['file_refs', 'file_edges']) {
      expect(SCHEMA).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
      expect(SCHEMA).toMatch(
        new RegExp(`${t} \\(\\s*path TEXT NOT NULL REFERENCES files\\(path\\) ON DELETE CASCADE`),
      );
      // The complete extraction object, so new extractor fields round-trip.
      expect(SCHEMA).toMatch(new RegExp(`${t} \\([^;]+payload TEXT NOT NULL`));
    }
    expect(SCHEMA).toContain('CREATE INDEX IF NOT EXISTS idx_nodes_file_path');
  });

  test('v12 adds annotations (FK cascade + actor trigger) and orphaned_memory', () => {
    expect(SCHEMA).toContain('CREATE TABLE IF NOT EXISTS annotations');
    expect(SCHEMA).toMatch(
      /annotations \([\s\S]+node_id TEXT NOT NULL REFERENCES nodes\(id\) ON DELETE CASCADE/,
    );
    expect(SCHEMA).toContain('CREATE TRIGGER IF NOT EXISTS annotations_actor_nonempty');
    expect(SCHEMA).toContain('CREATE TABLE IF NOT EXISTS orphaned_memory');
    expect(SCHEMA).toContain('CREATE INDEX IF NOT EXISTS idx_orphaned_memory_anchor');
  });
});
