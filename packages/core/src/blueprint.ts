// SPDX-License-Identifier: Apache-2.0
// Architecture blueprints (backlog E4, first version): the project drawn
// like a house plan, from the same data as the orientation map.
//
// Built to the E4 research:
// - Boxes come only from declared structure (workspace packages), never
//   from clustering.
// - Edges only with evidence: file imports resolved to files (`ast:import`),
//   aggregated per package pair and weighted by count. Name-matched calls
//   (`ast:name`) are a heuristic and are not drawn.
// - Inferred elements (data stores, external services, HTTP surfaces from
//   declared dependencies) are dashed and say what they were inferred from.
// - At most five shape kinds, a legend on every drawing, classic Mermaid
//   syntax (GitHub pins an older Mermaid), and a hard cap on boxes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteAdapter } from './db/adapter.ts';
import { isTestPath, readDeclaredDeps, readManifests, type Manifest } from './orientation.ts';

export type BlueprintLevel = 'site' | 'floor';

/** Runtime dependencies that mean "this package talks to a data store". */
const DATA_STORES: Record<string, string> = {
  pg: 'PostgreSQL',
  postgres: 'PostgreSQL',
  'pg-promise': 'PostgreSQL',
  psycopg2: 'PostgreSQL',
  'psycopg2-binary': 'PostgreSQL',
  psycopg: 'PostgreSQL',
  asyncpg: 'PostgreSQL',
  mysql: 'MySQL',
  mysql2: 'MySQL',
  pymysql: 'MySQL',
  'better-sqlite3': 'SQLite',
  sqlite3: 'SQLite',
  mongodb: 'MongoDB',
  mongoose: 'MongoDB',
  pymongo: 'MongoDB',
  motor: 'MongoDB',
  redis: 'Redis',
  ioredis: 'Redis',
  '@prisma/client': 'Prisma database',
  '@elastic/elasticsearch': 'Elasticsearch',
  elasticsearch: 'Elasticsearch',
};

/** Runtime dependencies that mean "this package calls an external service". */
const EXTERNAL: Record<string, string> = {
  stripe: 'Stripe',
  '@anthropic-ai/sdk': 'Anthropic API',
  anthropic: 'Anthropic API',
  openai: 'OpenAI API',
  '@octokit/rest': 'GitHub API',
  octokit: 'GitHub API',
  twilio: 'Twilio',
  '@sendgrid/mail': 'SendGrid',
  boto3: 'AWS',
  '@aws-sdk/client-s3': 'AWS S3',
  '@slack/web-api': 'Slack API',
};

/** Runtime dependencies that mean "this package serves HTTP". */
const HTTP_SERVERS = new Set([
  'express',
  'fastify',
  'hono',
  'koa',
  'next',
  'fastapi',
  'flask',
  'django',
  '@nestjs/core',
]);

export interface BlueprintBox {
  id: string;
  label: string;
  /** package: a declared package; store / external / io: inferred from a dependency or manifest field. */
  kind: 'package' | 'store' | 'external' | 'io';
  detail?: string;
  /** What an inferred box was inferred from (dependency name, manifest field). */
  evidence?: string;
  inferred: boolean;
}

export interface BlueprintEdge {
  from: string;
  to: string;
  /** Resolved file imports behind it (package → package), or 1 for inferred links. */
  weight: number;
  inferred: boolean;
}

export interface Blueprint {
  level: BlueprintLevel;
  commit: string | null;
  boxes: BlueprintBox[];
  edges: BlueprintEdge[];
  /** Packages folded into one "+N more" box to stay under the cap. */
  folded: string[];
}

export const FLOOR_MAX_BOXES = 30;

const slug = (s: string): string =>
  s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'root';

export interface BlueprintOptions {
  level?: BlueprintLevel;
  commit?: string | null;
  maxBoxes?: number;
}

export const buildBlueprint = (
  db: SqliteAdapter,
  projectRoot: string,
  opts: BlueprintOptions = {},
): Blueprint => {
  const level = opts.level ?? 'floor';
  const maxBoxes = opts.maxBoxes ?? FLOOR_MAX_BOXES;
  const files = (
    db.prepare(`SELECT path FROM files ORDER BY path`).all() as { path: string }[]
  ).map((r) => r.path);
  const manifests = readManifests(files, (p) => {
    try {
      return readFileSync(join(projectRoot, p), 'utf-8');
    } catch {
      return null;
    }
  });
  const deps = readDeclaredDeps(db).filter((d) => d.runtime);

  // Packages: the declared ones below the root; the root alone when there are none.
  const sub = manifests.filter((m) => m.dir !== '');
  const pkgList: Manifest[] = sub.length ? sub : manifests.filter((m) => m.dir === '');
  const dirs = pkgList.map((m) => m.dir).sort((a, b) => b.length - a.length);
  const pkgOf = (f: string): string | null =>
    dirs.find((d) => d === '' || f === d || f.startsWith(`${d}/`)) ?? null;
  const manifestPkg = new Map(pkgList.map((m) => [m.path, m.dir]));

  // Evidence edges: resolved imports between non-test files, per package pair.
  const fileOfNode = new Map(
    (
      db
        .prepare(`SELECT id, json_extract(data, '$.filePath') AS p FROM nodes WHERE type = 'file'`)
        .all() as {
        id: string;
        p: string;
      }[]
    ).map((r) => [r.id, r.p]),
  );
  const weights = new Map<string, number>();
  const filesPer = new Map<string, number>();
  for (const f of files) {
    const p = pkgOf(f);
    if (p !== null && !isTestPath(f)) filesPer.set(p, (filesPer.get(p) ?? 0) + 1);
  }
  for (const e of db
    .prepare(`SELECT src, dst FROM edges WHERE provenance = 'ast:import'`)
    .all() as {
    src: string;
    dst: string;
  }[]) {
    const a = fileOfNode.get(e.src);
    const b = fileOfNode.get(e.dst);
    if (!a || !b || isTestPath(a) || isTestPath(b)) continue;
    const pa = pkgOf(a);
    const pb = pkgOf(b);
    if (pa === null || pb === null || pa === pb) continue;
    const k = `${pa}\0${pb}`;
    weights.set(k, (weights.get(k) ?? 0) + 1);
  }

  // Fold the smallest packages when there are too many to read.
  const ranked = [...pkgList].sort(
    (a, b) => (filesPer.get(b.dir) ?? 0) - (filesPer.get(a.dir) ?? 0) || a.dir.localeCompare(b.dir),
  );
  const keep = new Set(ranked.slice(0, Math.max(1, maxBoxes - 1)).map((m) => m.dir));
  const folded = ranked.filter((m) => !keep.has(m.dir)).map((m) => m.dir);
  const boxOf = (dir: string): string => (keep.has(dir) ? `pkg_${slug(dir)}` : 'pkg_more');

  const boxes: BlueprintBox[] = [];
  const edges: BlueprintEdge[] = [];
  if (level === 'floor') {
    for (const m of ranked.filter((x) => keep.has(x.dir)))
      boxes.push({
        id: boxOf(m.dir),
        label: m.name ?? (m.dir || 'project'),
        kind: 'package',
        detail: `${m.dir || '.'} · ${filesPer.get(m.dir) ?? 0} files`,
        inferred: false,
      });
    if (folded.length)
      boxes.push({
        id: 'pkg_more',
        label: `+${folded.length} more packages`,
        kind: 'package',
        inferred: false,
      });
    const agg = new Map<string, number>();
    for (const [k, w] of weights) {
      const [pa, pb] = k.split('\0') as [string, string];
      const a = boxOf(pa);
      const b = boxOf(pb);
      if (a === b) continue;
      agg.set(`${a}\0${b}`, (agg.get(`${a}\0${b}`) ?? 0) + w);
    }
    for (const [k, w] of [...agg].sort(([x], [y]) => x.localeCompare(y))) {
      const [from, to] = k.split('\0') as [string, string];
      edges.push({ from, to, weight: w, inferred: false });
    }
  } else {
    boxes.push({
      id: 'system',
      label: 'this project',
      kind: 'package',
      detail: `${pkgList.length} packages`,
      inferred: false,
    });
  }

  // Inferred surroundings: data stores, external services, I/O surfaces.
  const added = new Map<string, BlueprintBox>();
  const link = (fromPkg: string, box: BlueprintBox, outward: boolean): void => {
    if (!added.has(box.id)) added.set(box.id, box);
    const owner = level === 'floor' ? boxOf(fromPkg) : 'system';
    const e = outward ? { from: owner, to: box.id } : { from: box.id, to: owner };
    if (!edges.some((x) => x.from === e.from && x.to === e.to))
      edges.push({ ...e, weight: 1, inferred: box.inferred });
  };
  for (const d of deps) {
    const pkg = manifestPkg.get(d.manifest) ?? (sub.length ? null : '');
    if (pkg === null || pkg === undefined) continue;
    const store = DATA_STORES[d.name];
    if (store)
      link(
        pkg,
        {
          id: `store_${slug(store)}`,
          label: store,
          kind: 'store',
          evidence: `dependency ${d.name}`,
          inferred: true,
        },
        true,
      );
    const ext = EXTERNAL[d.name];
    if (ext)
      link(
        pkg,
        {
          id: `ext_${slug(ext)}`,
          label: ext,
          kind: 'external',
          evidence: `dependency ${d.name}`,
          inferred: true,
        },
        true,
      );
    if (HTTP_SERVERS.has(d.name))
      link(
        pkg,
        {
          id: `io_http_${slug(pkg)}`,
          label: 'HTTP routes',
          kind: 'io',
          evidence: `dependency ${d.name}`,
          inferred: true,
        },
        false,
      );
  }
  for (const m of pkgList) {
    const bin = m.json?.bin;
    if (bin && (typeof bin === 'string' || typeof bin === 'object'))
      link(
        m.dir,
        {
          id: `io_cli_${slug(m.dir)}`,
          label: 'command line',
          kind: 'io',
          evidence: `${m.path} bin`,
          inferred: false,
        },
        false,
      );
  }
  boxes.push(...[...added.values()].sort((a, b) => a.id.localeCompare(b.id)));
  return { level, commit: opts.commit ?? null, boxes, edges, folded };
};

const esc = (s: string): string =>
  s.replace(/"/g, '#quot;').replace(/[<>]/g, (c) => (c === '<' ? '#lt;' : '#gt;'));

/** Mermaid flowchart in the classic shape syntax, with a legend and the commit in the title. */
export const blueprintToMermaid = (b: Blueprint): string => {
  const L: string[] = [];
  const title = `${b.level === 'site' ? 'Site plan' : 'Floor plan'}${b.commit ? ` at ${b.commit.slice(0, 7)}` : ''}`;
  L.push('---', `title: ${title}`, '---', 'flowchart LR');
  for (const x of b.boxes) {
    const text =
      esc(x.label) +
      (x.detail ? `<br/><small>${esc(x.detail)}</small>` : '') +
      (x.evidence ? `<br/><small>from ${esc(x.evidence)}</small>` : '');
    const shape =
      x.kind === 'store' ? `[("${text}")]` : x.kind === 'io' ? `[/"${text}"/]` : `["${text}"]`;
    L.push(`  ${x.id}${shape}`);
  }
  for (const e of b.edges) {
    const label = e.inferred ? '' : `|${e.weight} import${e.weight === 1 ? '' : 's'}|`;
    L.push(`  ${e.from} ${e.inferred ? '-.->' : '-->'}${label} ${e.to}`);
  }
  const of = (k: BlueprintBox['kind']) => b.boxes.filter((x) => x.kind === k).map((x) => x.id);
  L.push('  classDef external fill:#f2f2f2,stroke:#888,color:#333');
  L.push('  classDef inferred stroke-dasharray: 5 4');
  if (of('external').length) L.push(`  class ${of('external').join(',')} external`);
  const inferred = b.boxes.filter((x) => x.inferred).map((x) => x.id);
  if (inferred.length) L.push(`  class ${inferred.join(',')} inferred`);
  L.push(
    '  subgraph legend["Legend"]',
    '    lg_pkg["package"]',
    '    lg_store[("data store")]',
    '    lg_io[/"input / output"/]',
    '    lg_ext["external service"]',
    '    lg_a["solid arrow: resolved imports"]',
    '    lg_b["dashed: inferred from a dependency"]',
    '  end',
    '  class lg_ext external',
    '  class lg_b inferred',
  );
  return L.join('\n');
};
