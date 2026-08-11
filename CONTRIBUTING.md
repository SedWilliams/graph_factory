# Contributing

Bug reports, graphs that failed to compile, and harness quirks are all welcome —
open an issue. If you are sending code, this is the shape of the project.

## Getting set up

```bash
git clone https://github.com/SedWilliams/graph_factory.git
cd graph_factory
npm install
npm test
```

Node 20.11 or newer. One runtime dependency (`yaml`); please keep it that way
unless there is a reason that could not be met with the standard library.

## Before you open a pull request

```bash
npm test     # the suite must be green
npm run lint # prettier, check mode
npm run check # every entry point parses
```

## Where things live

| | |
|---|---|
| `src/graph/` | schema, normalize, validate, topology, template, serialize |
| `src/compile/` | one module per target, plus the shared plan and narrative |
| `src/run/` | executor, conditions, adapters, run store |
| `src/server.mjs` | the zero-dependency `node:http` API |
| `public/` | the editor |
| `tools/` | asset capture for the README — not part of the app |

## House rules

**A new node or edge type touches four places.** The schema, the validator, every
compiler, and the executor. A type that compiles for one target and silently
disappears for another is worse than not having it — if a target genuinely cannot
express it, say so in that bundle's notes rather than dropping it quietly.

**Colours live in `public/styles/tokens/palette.css`.** It is the only file allowed
to contain a literal colour. Everything else reaches for a token.

**Errors block compilation, warnings do not.** A warning is a graph mid-edit; an
error is a graph no harness can run. When you add a check, decide which it is and
be able to defend the choice.

**Serialization is deterministic.** Fixed key order, prompts always as literal
blocks. Two saves of the same graph produce byte-identical files, and there is a
test that says so.

**Tests are `node --test`, no framework.** Add cases to the file that matches the
area you touched.

## Regenerating the screenshots

Screenshots are not tracked in git — `docs/assets/` is ignored. The capture script
is tracked instead, so anyone can rebuild the images from the running app:

```bash
npm start                        # in one terminal
node tools/capture-assets.mjs    # in another
```

Requires Chrome and `ffmpeg` on your PATH. Set `CHROME=/path/to/chrome` if it is
not found automatically.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
