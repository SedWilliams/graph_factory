# Contributing

Bug reports, graphs that failed to compile, and features are all welcome just
open an issue or pr.

## Getting set up

```bash
git clone https://github.com/SedWilliams/graph_factory.git
cd graph_factory
npm install
npm test
```

## Before you open a pull request

```bash
npm test     # the suite must be green
npm run lint # prettier, check mode
npm run check # every entry point parses
```

## Directory layout

| | |
|---|---|
| `src/graph/` | schema, normalize, validate, topology, template, serialize |
| `src/compile/` | one module per target, plus the shared plan and narrative |
| `src/run/` | executor, conditions, adapters, run store |
| `src/server.mjs` | the zero-dependency `node:http` API |
| `public/` | the editor |
| `tools/` | asset capture for the README — not part of the app |

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
