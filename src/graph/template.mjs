/*
 * TEMPLATE — the `{{ … }}` references that wire one node's output into the next
 * node's prompt.
 *
 * Deliberately not an expression language. A prompt may only name a value; it may
 * not compute one. That keeps two things true: the validator can prove every
 * reference resolves before a run starts, and a compiled bundle handed to another
 * harness carries no semantics that harness would have to reimplement.
 *
 * Recognised forms:
 *   {{inputs.task}}          a declared graph input
 *   {{plan}}                 shorthand for the output of node `plan`
 *   {{nodes.plan.output}}    the same thing, spelled out
 *   {{graph.name}}           graph metadata
 *   {{env.API_BASE}}         an environment variable
 */

const REFERENCE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function parseReference(raw) {
  const path = String(raw).split('.');
  if (path[0] === 'inputs' && path.length === 2) return { kind: 'input', id: path[1], raw };
  if (path[0] === 'env' && path.length === 2) return { kind: 'env', id: path[1], raw };
  if (path[0] === 'graph' && path.length === 2) return { kind: 'graph', id: path[1], raw };
  if (path[0] === 'nodes' && path.length === 3 && path[2] === 'output') return { kind: 'node', id: path[1], raw };
  if (path.length === 1) return { kind: 'node', id: path[0], raw };
  return { kind: 'unknown', id: raw, raw };
}

export function references(source) {
  const found = [];
  const text = String(source ?? '');
  for (const match of text.matchAll(REFERENCE)) found.push(parseReference(match[1]));
  return found;
}

// Every templated string on a node, so the validator can check them all without
// knowing which fields a given node type happens to use.
export function nodeReferences(node) {
  const fields = ['prompt', 'system', 'run', 'expression', 'until', 'description'];
  return fields.flatMap(field => references(node[field]).map(reference => ({ ...reference, field })));
}

/*
 * Rendering never throws on a missing value. A run that dies halfway through
 * because one optional input was blank is worse than one that substitutes an empty
 * string and reports the gap — and the validator has already had its chance to
 * refuse the graph outright.
 */
export function render(source, scope = {}) {
  const missing = [];
  const output = String(source ?? '').replace(REFERENCE, (match, expression) => {
    const reference = parseReference(expression);
    const value = lookup(reference, scope);
    if (value === undefined || value === null) {
      missing.push(reference);
      return '';
    }
    return String(value);
  });
  return { output, missing };
}

function lookup(reference, scope) {
  if (reference.kind === 'input') return scope.inputs?.[reference.id];
  if (reference.kind === 'node') return scope.outputs?.[reference.id];
  if (reference.kind === 'env') return scope.env?.[reference.id];
  if (reference.kind === 'graph') return scope.graph?.[reference.id];
  return undefined;
}

// Compilers emit for harnesses with their own substitution conventions, so they
// need the reference rewritten rather than resolved.
export function rewrite(source, translate) {
  return String(source ?? '').replace(REFERENCE, (match, expression) => {
    const replacement = translate(parseReference(expression));
    return replacement === undefined || replacement === null ? match : String(replacement);
  });
}
