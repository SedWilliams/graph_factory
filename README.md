<div align="center">

# Graph Factory

**Build an AI coding workflow visually. Run it with the coding tool you already use.**

[![License: MIT](https://img.shields.io/badge/license-MIT-8eaeea.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020.11-a4ca77.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-1-f0ce8e.svg)](package.json)

</div>

Graph Factory is a visual editor and command-line tool for AI coding workflows. Connect agents, tools, approval steps, branches, and retry loops to show how work should move from one step to the next.

Graph Factory saves the workflow as one YAML file. You can run that file directly or turn it into native configuration for Claude Code, Pi, OpenCode, or Codex.

Graph Factory calls these coding tools **harnesses**.

## Quick start

You need Node.js 20.11 or newer.

```bash
git clone https://github.com/SedWilliams/graph_factory.git
cd graph_factory
npm install
npm start
```

The editor opens at <http://127.0.0.1:4180>.

To use `graph-factory` from anywhere, link the CLI from the project root:

```bash
npm link
```

If you do not want to link it, replace `graph-factory` in any example with `node bin/graph-factory.mjs`.

---

## Why Graph Factory uses YAML

The graph is the source of truth. It belongs beside the code it works with. That makes the workflow easy to review, version, and discuss in a pull request.

Graph Factory considered three file formats:

| Format       | Trade-off                                                                         | How Graph Factory uses it     |
| ------------ | --------------------------------------------------------------------------------- | ----------------------------- |
| **Markdown** | Easy for people to read, but too ambiguous for typed nodes and edges.             | Generated documentation only. |
| **JSON**     | Precise, but multi-line prompts become hard-to-read strings full of `\n` escapes. | Lossless data exchange.       |
| **YAML**     | Precise and readable, with block strings for multi-line prompts.                  | The main file format.         |

Graph Factory always writes YAML keys in the same order and stores prompts as literal blocks. Saving the same graph twice produces identical files, which keeps diffs clean.

Here is a complete graph with one builder and one reviewer:

```yaml
version: 1
id: build-and-review
name: Build and review
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
      Complete this task:

      {{inputs.task}}
  - id: reviewer
    type: agent
    tools: [read, bash]
    output: review
    prompt: |-
      Review this work:

      {{work}}
  - id: done
    type: end
    output: review
edges:
  - from: builder
    to: reviewer
    type: handoff
  - from: reviewer
    to: done
```

## How a graph works

A graph contains **nodes** and **edges**. Nodes do the work. Edges decide what happens next.

### Node types

| Node       | What it does                                                                 |
| ---------- | ---------------------------------------------------------------------------- |
| `start`    | Starts the workflow and makes its inputs available.                          |
| `agent`    | Sends one prompt to an AI model.                                             |
| `tool`     | Runs a shell command or MCP tool without calling a model.                    |
| `gate`     | Pauses and asks a person to approve or reject the next step.                 |
| `router`   | Chooses a path by checking conditions.                                       |
| `parallel` | Starts several paths at once, then joins their results.                      |
| `loop`     | Repeats part of the workflow until a condition is met or a limit is reached. |
| `end`      | Finishes the workflow and names its final output.                            |

### Edge types

| Edge       | What it does                                                                            |
| ---------- | --------------------------------------------------------------------------------------- |
| `flow`     | Runs the next node.                                                                     |
| `branch`   | Runs the next node only when its condition matches.                                     |
| `handoff`  | Passes work and context to another agent.                                               |
| `feedback` | Sends work back for another attempt. This is the only edge that may close a cycle.      |
| `uses`     | Gives an agent permission to use a tool. It does not control the order of the workflow. |

Prompts can insert existing values with references such as `{{inputs.task}}` or `{{plan}}`. They cannot contain calculations.

This limit lets Graph Factory check every reference before a run begins. It also means compiled files do not depend on a separate expression engine.

## Validation

Run validation before compiling or running a graph:

```bash
graph-factory validate review.agentgraph.yaml
```

**Errors stop the graph.** They mean no supported harness can run it safely.

Errors include:

- a step with no instructions;
- an edge that points to a missing node;
- a `uses` edge that does not connect an agent to a tool;
- a cycle that does not use a `feedback` edge;
- a loop with no exit condition or iteration limit;
- a prompt that reads a value before another node creates it.

**Warnings do not stop the graph.** They usually point to unfinished or surprising parts of a graph that is still being edited.

## Compiling a graph

Compile a graph to create the files expected by a specific harness:

```bash
graph-factory compile review.agentgraph.yaml --target claude --out .
```

Each target receives native agent definitions. Because harness configuration files cannot represent every router or retry loop, the bundle also includes an ordered guide for the orchestrating agent.

- **Claude Code (`claude`)** — creates `.claude/agents/*.md` subagents and a `/graph-id` slash command.
- **Pi (`pi`)** — creates agent files, a team, and an executable entry in `agent-chain.yaml`. The bundle clearly lists any graph steps that the chain cannot represent.
- **OpenCode (`opencode`)** — adds agents and a command to `opencode.json`. Tool permissions are explicit, including tools that are not allowed.
- **Codex (`codex`)** — creates `AGENTS.md`, sandboxed `config.toml` profiles, prompt files, and a shell runner.
- **Portable (`portable`)** — includes the original YAML, Markdown documentation with a Mermaid diagram, and a complete `run.json` execution plan.

The compiler reports any target limitations instead of silently dropping behavior. For example, Codex runs parallel work in sequence because it has one agent.

**Export** lets you preview every generated file before anything is written.

## Running a graph

Run a graph directly with a harness:

```bash
graph-factory run review.agentgraph.yaml --harness claude --input task="…"
```

Leave out `--harness` for a dry run:

```bash
graph-factory run review.agentgraph.yaml --input task="…"
```

A dry run renders every prompt and prints the exact commands without calling a model. It is the fastest and cheapest way to check what the graph will send.

During a run, each node waits for its incoming paths to be resolved. It runs when at least one path reaches it. Unselected branches are skipped, and independent nodes can run at the same time.

A `feedback` edge resets only the part of the graph that needs another attempt. Results from the rest of the graph stay available.

A `gate` pauses the run. In the CLI, it waits for input in the terminal. Use `--yes` to approve gates automatically in CI. In the editor, it shows an approve or reject card.

## CLI reference

```text
graph-factory validate <file>
graph-factory compile  <file> --target <name> [--out <dir>]
graph-factory run      <file> [--harness <name>] [--input k=v]... [--yes]
graph-factory show     <file> [--format yaml|json|markdown|plan]
graph-factory new      <template> [--out <file>]
graph-factory serve    [--port 4180]
```

## Using the editor

1. Choose a node type from the palette, then click the canvas to place it.
2. Connect nodes by holding Shift while dragging, or drag from the handle on a node's right edge.
3. Select a node or edge to edit it.
4. Press `Delete` to remove the selected item.

Graph Factory saves node positions in the YAML file. When you reopen a graph, placed nodes stay where you left them. Automatic layout only moves nodes that you have not positioned yourself.

The editor also provides:

- a status pill that updates as you edit;
- an issue list that jumps to the node causing each problem;
- an **Export** preview that shows every generated file before writing it;
- light and midnight themes, available from the toggle in the top-left corner.

## Project layout

```text
bin/graph-factory.mjs   command-line interface
src/graph/              schema, normalization, validation, topology, templates, and serialization
src/compile/            target compilers and shared execution plans
src/run/                executor, conditions, harness adapters, and run storage
src/server.mjs          zero-dependency node:http API
public/                 visual editor
tools/                  README screenshot tools
```

By default, the editor stores graphs in `GraphFactoryData/graphs/`. Set `GRAPH_FACTORY_HOME` to use a different location.

The server listens only on the local machine. Its run endpoints can start coding tools with write access to the working directory, so Graph Factory is intentionally a local developer tool.

The project has one runtime dependency: `yaml`. Run `npm test` to execute 55 tests covering the schema, validator, executor, and all five compilers.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, project rules, and screenshot generation steps.

## License

[MIT](LICENSE) © SedWilliams
