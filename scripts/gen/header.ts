export const tsHeader = (sources: string[]): string =>
  `// GENERATED FILE — DO NOT EDIT.
// Source: ${sources.join(', ')}
// Edit the .contract.ts file(s), then run \`bun run gen\`.

`;

export const sqlHeader = (sources: string[]): string =>
  `-- GENERATED FILE — DO NOT EDIT.
-- Source: ${sources.join(', ')}
-- Edit the .contract.ts file(s), then run \`bun run gen\`.

`;

export const mdHeader = (sources: string[]): string =>
  `<!-- GENERATED FILE — DO NOT EDIT.
     Source: ${sources.join(', ')}
     Edit the .contract.ts file(s), then run \`bun run gen\`. -->

`;
