# Security Policy

Rig reads your **entire codebase** to build its graph and runs a local server that exposes it over MCP and HTTP. We take that trust seriously.

## What Rig does with your data

- **Everything is local.** The graph lives in `.rig/rig.db` inside your project. Embeddings run on-device. **No code, query, or graph data is uploaded anywhere.**
- The web map binds to **loopback (`127.0.0.1`) by default**. Binding to a non-loopback address *requires* a bearer token (`--auth`); Rig refuses to bind externally without one.
- `rig install` writes MCP server entries into your agent's config files (e.g. `.claude.json`). It merges, never clobbers.
- The first run downloads an embedding model from the Hugging Face CDN to your local model cache. This is the only outbound network call in the core flow.

## Supported versions

Until a 1.0 release, only the latest published version receives security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security reports.**

Email **kingolajohn55@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (a minimal repro is ideal),
- any suggested remediation.

We aim to acknowledge within 72 hours and to ship a fix or mitigation before public disclosure. We'll credit you in the changelog unless you'd prefer to remain anonymous.

## Scope

In scope: the `rig` CLI, the MCP server, the web server/auth, the installer's config writes, and anything that could exfiltrate local code or graph data.

Out of scope: vulnerabilities in upstream dependencies (report those upstream), and issues requiring a pre-compromised local machine.
