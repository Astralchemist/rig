// GENERATED FILE — DO NOT EDIT.
// Source: .contracts/events/index-progress.contract.ts, .contracts/events/focus-requested.contract.ts, .contracts/events/selection-changed.contract.ts, .contracts/events/node-promoted.contract.ts, .contracts/events/edge-accepted.contract.ts, .contracts/events/alias-added.contract.ts, .contracts/events/edge-proposed.contract.ts, .contracts/events/node-added.contract.ts, .contracts/events/edge-rejected.contract.ts
// Edit the .contract.ts file(s), then run `bun run gen`.

// index:progress
// payload (JSON Schema):
// {
//   "type": "object",
//   "properties": {
//     "phase": {
//       "type": "string"
//     },
//     "current": {
//       "type": "number"
//     },
//     "total": {
//       "type": "number"
//     },
//     "detail": {
//       "type": "string"
//     },
//     "done": {
//       "type": "boolean"
//     },
//     "nodes": {
//       "type": "number"
//     },
//     "edges": {
//       "type": "number"
//     },
//     "files": {
//       "type": "number"
//     }
//   },
//   "required": [
//     "phase"
//   ],
//   "additionalProperties": false,
//   "$schema": "http://json-schema.org/draft-07/schema#"
// }

// focus:requested
// payload (JSON Schema):
// {
//   "type": "object",
//   "properties": {
//     "node_ids": {
//       "type": "array",
//       "items": {
//         "type": "string"
//       }
//     }
//   },
//   "required": [
//     "node_ids"
//   ],
//   "additionalProperties": false,
//   "$schema": "http://json-schema.org/draft-07/schema#"
// }

// selection:changed
// payload (JSON Schema):
// {
//   "type": "object",
//   "properties": {
//     "node_id": {
//       "type": [
//         "string",
//         "null"
//       ]
//     }
//   },
//   "required": [
//     "node_id"
//   ],
//   "additionalProperties": false,
//   "$schema": "http://json-schema.org/draft-07/schema#"
// }

// node:promoted
// payload (JSON Schema):
// {
//   "type": "object",
//   "properties": {
//     "id": {
//       "type": "string"
//     },
//     "hubness": {
//       "type": "number"
//     }
//   },
//   "required": [
//     "id",
//     "hubness"
//   ],
//   "additionalProperties": false,
//   "$schema": "http://json-schema.org/draft-07/schema#"
// }

// edge:accepted
// payload (JSON Schema):
// {
//   "type": "object",
//   "properties": {
//     "pending_id": {
//       "type": "integer"
//     },
//     "src": {
//       "type": "string"
//     },
//     "dst": {
//       "type": "string"
//     }
//   },
//   "required": [
//     "pending_id",
//     "src",
//     "dst"
//   ],
//   "additionalProperties": false,
//   "$schema": "http://json-schema.org/draft-07/schema#"
// }

// alias:added
// payload (JSON Schema):
// {
//   "type": "object",
//   "properties": {
//     "node_id": {
//       "type": "string"
//     },
//     "alias": {
//       "type": "string"
//     }
//   },
//   "required": [
//     "node_id",
//     "alias"
//   ],
//   "additionalProperties": false,
//   "$schema": "http://json-schema.org/draft-07/schema#"
// }

// edge:proposed
// payload (JSON Schema):
// {
//   "type": "object",
//   "properties": {
//     "pending_id": {
//       "type": "integer"
//     },
//     "src": {
//       "type": "string"
//     },
//     "dst": {
//       "type": "string"
//     },
//     "kind": {
//       "type": "string"
//     },
//     "weight": {
//       "type": "number"
//     },
//     "provenance": {
//       "type": "string"
//     },
//     "rationale": {
//       "type": "string"
//     },
//     "proposed_at": {
//       "type": "integer"
//     }
//   },
//   "required": [
//     "pending_id",
//     "src",
//     "dst",
//     "kind",
//     "weight",
//     "provenance",
//     "rationale",
//     "proposed_at"
//   ],
//   "additionalProperties": false,
//   "$schema": "http://json-schema.org/draft-07/schema#"
// }

// node:added
// payload (JSON Schema):
// {
//   "type": "object",
//   "properties": {
//     "id": {
//       "type": "string"
//     },
//     "type": {
//       "type": "string"
//     },
//     "name": {
//       "type": "string"
//     }
//   },
//   "required": [
//     "id",
//     "type",
//     "name"
//   ],
//   "additionalProperties": false,
//   "$schema": "http://json-schema.org/draft-07/schema#"
// }

// edge:rejected
// payload (JSON Schema):
// {
//   "type": "object",
//   "properties": {
//     "pending_id": {
//       "type": "integer"
//     }
//   },
//   "required": [
//     "pending_id"
//   ],
//   "additionalProperties": false,
//   "$schema": "http://json-schema.org/draft-07/schema#"
// }

export type WsEvent =
  | { type: 'index:progress'; payload: unknown /* see schema above */ }
  | { type: 'focus:requested'; payload: unknown /* see schema above */ }
  | { type: 'selection:changed'; payload: unknown /* see schema above */ }
  | { type: 'node:promoted'; payload: unknown /* see schema above */ }
  | { type: 'edge:accepted'; payload: unknown /* see schema above */ }
  | { type: 'alias:added'; payload: unknown /* see schema above */ }
  | { type: 'edge:proposed'; payload: unknown /* see schema above */ }
  | { type: 'node:added'; payload: unknown /* see schema above */ }
  | { type: 'edge:rejected'; payload: unknown /* see schema above */ };
