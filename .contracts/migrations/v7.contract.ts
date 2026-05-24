import { defineMigrationContract } from '@rig/contracts';

// Scope the nodes-FTS update trigger to the columns the FTS index actually
// indexes (name + data.qualifiedName). Before this migration, any UPDATE on
// nodes — including hubness/is_hub-only writes from sync — fired a full FTS
// DELETE+INSERT per row. At 4500 nodes the hubness recompute on a 1-file edit
// took ~8s; with the trigger scoped to name+data it drops to ~50ms.
export default defineMigrationContract({
  version: 7,
  description: 'Scope nodes_after_update FTS trigger to name + data columns',
  applied_in_phase: 4,
  forward: `
DROP TRIGGER IF EXISTS nodes_after_update;
CREATE TRIGGER nodes_after_update AFTER UPDATE OF name, data ON nodes BEGIN
  DELETE FROM nodes_fts WHERE node_id = OLD.id;
  INSERT INTO nodes_fts(name, qualified_name, node_id)
  VALUES (
    NEW.name,
    COALESCE(json_extract(NEW.data, '$.qualifiedName'), NEW.name),
    NEW.id
  );
END;
  `.trim(),
  rollback: `
DROP TRIGGER IF EXISTS nodes_after_update;
CREATE TRIGGER nodes_after_update AFTER UPDATE ON nodes BEGIN
  DELETE FROM nodes_fts WHERE node_id = OLD.id;
  INSERT INTO nodes_fts(name, qualified_name, node_id)
  VALUES (
    NEW.name,
    COALESCE(json_extract(NEW.data, '$.qualifiedName'), NEW.name),
    NEW.id
  );
END;
  `.trim(),
});
