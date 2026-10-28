import { defineMigrationContract } from '@rig/contracts';

// Hybrid search.
//
// - nodes_fts is rebuilt with more to match than name and qualified_name:
//   - tokens: name + qualified name with camelCase split into words, so
//     handleLogin, handle_login and handle-login all hold "handle login"
//     (unicode61 already splits on `_`, `-`, `.` and `/`; SQLite has no regex,
//     so the split is a space before every capital — acronyms come out letter
//     by letter here, but the name column still holds them whole);
//   - signature, and docstring (or a skill's description);
//   - text: free text written by agents or lifted from docs — a waypoint's
//     summary, rationale and key_terms, a markdown section's body excerpt.
//   Search weights the columns name > qualified_name > tokens >
//   signature/docstring > text (search-queries.ts). The triggers keep the
//   v7 scoping (only name/data updates touch the index) and every existing
//   node is indexed again here.
// - embeddings.seq — a per-model change counter: every upsert stamps the
//   model's highest seq + 1, so an in-memory vector index can pick up exactly
//   the rows written since it last looked (idx_embeddings_model_seq makes that
//   and the row count an index lookup). Existing rows keep 0.
//
// The camelCase split is 26 nested replace() calls, in two subqueries of 13:
// one expression nested 26 deep overflows SQLite's parser stack.
const replaceCaps = (letters: string, expr: string): string =>
  letters.split('').reduce((acc, c) => `replace(${acc}, '${c}', ' ${c}')`, expr);

const camelSplit = (expr: string): string =>
  `(SELECT ${replaceCaps('NOPQRSTUVWXYZ', 's.x')} FROM (SELECT ${replaceCaps('ABCDEFGHIJKLM', expr)} AS x) AS s)`;

const ftsValues = (row: string): string => `
    ${row}.name,
    COALESCE(json_extract(${row}.data, '$.qualifiedName'), ${row}.name),
    ${camelSplit(`${row}.name || ' ' || COALESCE(json_extract(${row}.data, '$.qualifiedName'), '')`)},
    COALESCE(json_extract(${row}.data, '$.signature'), ''),
    COALESCE(json_extract(${row}.data, '$.docstring'), json_extract(${row}.data, '$.description'), ''),
    trim(
      COALESCE(json_extract(${row}.data, '$.summary'), '') || ' ' ||
      COALESCE(json_extract(${row}.data, '$.rationale'), '') || ' ' ||
      COALESCE((SELECT group_concat(value, ' ') FROM json_each(${row}.data, '$.key_terms')), '') || ' ' ||
      COALESCE(json_extract(${row}.data, '$.excerpt'), '')
    ),
    ${row}.id`;

const FTS_COLUMNS = 'name, qualified_name, tokens, signature, docstring, text, node_id';

export default defineMigrationContract({
  version: 14,
  description:
    'Hybrid search: nodes_fts with tokens/signature/docstring/text columns, embeddings.seq',
  applied_in_phase: 4,
  forward: `
DROP TRIGGER IF EXISTS nodes_after_insert;
DROP TRIGGER IF EXISTS nodes_after_update;
DROP TRIGGER IF EXISTS nodes_after_delete;
DROP TABLE IF EXISTS nodes_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name, qualified_name, tokens, signature, docstring, text, node_id UNINDEXED
);

CREATE TRIGGER nodes_after_insert AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(${FTS_COLUMNS})
  VALUES (${ftsValues('NEW')}
  );
END;

CREATE TRIGGER nodes_after_update AFTER UPDATE OF name, data ON nodes BEGIN
  DELETE FROM nodes_fts WHERE node_id = OLD.id;
  INSERT INTO nodes_fts(${FTS_COLUMNS})
  VALUES (${ftsValues('NEW')}
  );
END;

CREATE TRIGGER nodes_after_delete AFTER DELETE ON nodes BEGIN
  DELETE FROM nodes_fts WHERE node_id = OLD.id;
END;

INSERT INTO nodes_fts(${FTS_COLUMNS})
SELECT ${ftsValues('n')}
FROM nodes n;

ALTER TABLE embeddings ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_embeddings_model_seq ON embeddings(model, seq);
  `.trim(),
  rollback: `
DROP INDEX IF EXISTS idx_embeddings_model_seq;
-- SQLite cannot DROP COLUMN before 3.35; embeddings.seq stays (intentional no-op).
DROP TRIGGER IF EXISTS nodes_after_insert;
DROP TRIGGER IF EXISTS nodes_after_update;
DROP TRIGGER IF EXISTS nodes_after_delete;
DROP TABLE IF EXISTS nodes_fts;
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  name, qualified_name, node_id UNINDEXED
);
CREATE TRIGGER nodes_after_insert AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(name, qualified_name, node_id)
  VALUES (NEW.name, COALESCE(json_extract(NEW.data, '$.qualifiedName'), NEW.name), NEW.id);
END;
CREATE TRIGGER nodes_after_update AFTER UPDATE OF name, data ON nodes BEGIN
  DELETE FROM nodes_fts WHERE node_id = OLD.id;
  INSERT INTO nodes_fts(name, qualified_name, node_id)
  VALUES (NEW.name, COALESCE(json_extract(NEW.data, '$.qualifiedName'), NEW.name), NEW.id);
END;
CREATE TRIGGER nodes_after_delete AFTER DELETE ON nodes BEGIN
  DELETE FROM nodes_fts WHERE node_id = OLD.id;
END;
INSERT INTO nodes_fts(name, qualified_name, node_id)
SELECT name, COALESCE(json_extract(data, '$.qualifiedName'), name), id FROM nodes;
  `.trim(),
});
