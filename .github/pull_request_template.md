<!-- Keep PRs focused — one seam at a time. See CONTRIBUTING.md. -->

## What & why

<!-- One or two sentences. Link the issue if there is one. -->

## Which seam does this touch?

<!-- node type · edge kind · pull term · tool · WS view · other (explain) — see docs/integration.md -->

## Checklist

- [ ] `bun run gen:check` passes (generated/ committed + fresh)
- [ ] `bun run check:compat` passes (no breaking changes to stable tools)
- [ ] `bun run check:migrations` passes (no edits to shipped migrations)
- [ ] `bun test` passes; new behavior has a test
- [ ] Files stay small and declarative
