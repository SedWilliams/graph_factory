# Graph Factory

Edit a graph. Get an agentic coding system your harness can actually run.

You draw the pipeline — agents, tools, gates, branches, retry loops — and Graph
Factory saves it as one YAML file, compiles that file into native config for Claude
Code, Pi, opencode, or Codex, and can execute it directly against any of them.

```bash
npm install
npm start          # editor on http://127.0.0.1:4180
```

---

## Why a file, and why YAML

The graph is the deliverable. It belongs in the repository it drives, next to the
code it changes, in a format a reviewer can read in a pull request. Three candidates,
weighed against what the file has to survive:

| | verdict |
|---|---|
| **Markdown** | Reads beautifully, parses ambiguously. A graph is a set of typed edges, and there is no way to write an edge list in prose that two tools will agree on. Kept as a *generated* document, never as the source. |
| **JSON** | Parses unambiguously, edits badly. Every prompt in this format is multi-line, and JSON has no multi-line string — a prompt becomes one line of `\n` escapes that nobody can review in a diff. Kept as lossless interchange. |
| **YAML** | Parses unambiguously *and* block scalars keep prompts readable. It is also what every one of these harnesses already speaks. **Canonical.** |

Emission is deterministic — fixed key order, prompts always as literal blocks — so
two saves of the same graph produce byte-identical files.

```yaml
version: 1
id: review-until-clean
name: Review until clean
defaults:
  model: claude-opus-5
  harness: claude
inputs:
  - id: task
    type: string
    required: true
nodes:
  - id: builder
    type: agent
    tools: [read, write, edit, bash]
    output: work
    prompt: |-
      Implement the following. If review feedback is present, address every point.

      Task: {{inputs.task}}
      Feedback: {{review}}
  - id: verdict
    type: router
    expression: review
edges:
  - from: builder
    to: reviewer
  - from: verdict
    to: shipped
    type: branch
    when: contains(review, "APPROVED")
  - from: verdict
    to: builder
    type: feedback
```

## The model

**Eight node types.** `start` · `agent` (an LLM turn) · `tool` (a shell command or
MCP call, no model) · `gate` (stop and ask a human) · `router` (branch on a
condition) · `parallel` (fan out and join) · `loop` (repeat with a cap) · `end`.

**Five edge types.** `flow` runs the target next. `branch` runs it only when a
condition holds. `handoff` delegates carrying context. `feedback` is the only edge
allowed to close a cycle — that is what makes a retry loop legal and an accidental
cycle an error. `uses` is not control flow at all: it binds a tool to the agent
permitted to call it, and becomes a tool allow-list at compile time.

**References, not expressions.** A prompt may name a value (`{{inputs.task}}`,
`{{plan}}`) but never compute one. That is deliberate: it lets the validator prove
every reference resolves *before* a run starts, and it means a compiled bundle
carries no semantics the target harness would have to reimplement.

## Validation

Errors block compilation; warnings do not. The split matters — a warning is usually
a graph mid-edit, an error is a graph no harness can run.

Errors include: a step with no instructions, a cycle with no feedback edge, an edge
pointing at a node that does not exist, a `uses` edge that is not agent→tool, a loop
with neither an exit condition nor a cap, and — the one that catches the most real
bugs — a prompt reading a value produced by a node that does not run first.

## Compiling

```bash
graph-factory compile review.agentgraph.yaml --target claude --out .
```

Every harness gets its agents natively. None of them can express a router or a
feedback loop in config, so each bundle also carries the control flow as an explicit
ordered instruction sheet for the orchestrating agent.

- **claude** — `.claude/agents/*.md` subagents plus a `/graph-id` slash command.
- **pi** — agent files, a real executable entry in `agent-chain.yaml`, and a team.
  The chain covers the linear spine; anything it cannot hold is listed by name.
- **opencode** — agents and a command in `opencode.json`, with tool permissions
  written out explicitly (a withheld tool is `false`, not merely absent).
- **codex** — `AGENTS.md`, `config.toml` profiles whose sandbox matches what each
  agent may do, prompt files, and a shell runner.
- **portable** — the canonical YAML, a Markdown doc with a Mermaid diagram, and
  `run.json`: a resolved execution manifest that loses nothing.

Each compiler reports what it had to give up. Codex will say that it is going to
serialise your parallel node, because Codex has one agent.

## Running

```bash
graph-factory run review.agentgraph.yaml --harness claude --input task="…"
graph-factory run review.agentgraph.yaml --input task="…"      # dry run
```

A dry run renders every prompt and prints the exact command line that would be
executed, without calling a model — the cheapest way to see what a graph will
actually send.

Execution is token passing over edges: every edge is pending, taken, or skipped, and
a node runs once all of its incoming edges resolve with at least one taken. That one
rule gives branching, joining, and dead-branch elimination, and lets independent
nodes run genuinely concurrently. A feedback edge additionally *rewinds* the body it
points into, so the loop can run again while everything outside it keeps its state.

Gates block. In the CLI they wait on stdin (`--yes` opts out for CI); in the editor
the run parks and shows an approve/reject card.

## CLI

```
graph-factory validate <file>
graph-factory compile  <file> --target <name> [--out <dir>]
graph-factory run      <file> [--harness <name>] [--input k=v]... [--yes]
graph-factory show     <file> [--format yaml|json|markdown|plan]
graph-factory new      <template> [--out <file>]
graph-factory serve    [--port 4180]
```

## The editor

Pick a type from the palette and click to place it. Shift-drag between nodes to
connect them, or drag from the handle on a node's right edge. Select anything to edit
it; `Delete` removes it. Node positions are saved into the file, so a graph reopens
exactly as you left it — the force simulation only touches nodes you have not placed
yourself.

The status pill is live validation, the strip beneath the canvas lists every issue
and jumps to the node responsible, and **Export** previews the full compiled bundle
for any target before a single file is written.

## Layout

```
bin/graph-factory.mjs   CLI
src/graph/              schema · normalize · validate · topology · template · serialize
src/compile/            one module per target, plus the shared plan/narrative
src/run/                executor · conditions · adapters · run store
src/server.mjs          zero-dependency node:http API
public/                 the editor
```

Graphs live in `GraphFactoryData/graphs/` (override with `GRAPH_FACTORY_HOME`). The
server binds to loopback only: the run endpoints execute agent CLIs with write access
to the working directory, so this is a local developer tool by construction.

One runtime dependency (`yaml`). `npm test` runs 55 tests over the schema, validator,
executor, and all five compilers.
