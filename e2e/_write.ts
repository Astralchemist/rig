// Writes to the e2e project from outside the map, the way an agent's MCP
// server would, so specs can watch the live events arrive.
// usage: bun run e2e/_write.ts <projectRoot> waypoint <title> <refId>
//        bun run e2e/_write.ts <projectRoot> note <nodeId> <text>
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';

const [root, action, a, b] = process.argv.slice(2);
if (!root || !action || !a || !b)
  throw new Error('usage: _write.ts <root> waypoint|note <arg> <arg>');
const rig = await Rig.open(root, { embedder: new DeterministicEmbedder() });
const ctx = { sessionId: 'e2e-agent', actor: 'ai:e2e-agent' };
if (action === 'waypoint') {
  rig.writes.dropWaypoint(
    {
      kind: 'observation',
      title: a,
      summary: 'Dropped while the map was open.',
      constellationRefs: [b],
      rationale: 'e2e live',
    },
    ctx,
  );
} else if (action === 'note') {
  rig.writes.annotateNode({ nodeId: a, note: b, rationale: 'e2e live' }, ctx);
}
await rig.whenIdle();
rig.close();
