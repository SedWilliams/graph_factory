/*
 * CONDITIONS — the tiny language behind a branch's `when`.
 *
 * There is no eval here and there will not be one. A graph is a file that gets
 * committed, shared, and compiled into someone else's repository; if `when` were
 * JavaScript, opening a graph would mean running a stranger's code. So conditions
 * are a fixed set of predicates over values the run has already produced, combined
 * with `and`/`or`/`not` — enough to route on what an agent said, and nothing else.
 *
 *   contains(review, "APPROVED")     substring, case-insensitive
 *   equals(status, "done")           exact, case-insensitive, trimmed
 *   matches(review, "^LGTM")         regular expression
 *   empty(notes) / not empty(notes)  nothing, or only whitespace
 *   approved                         bare name: truthy and not a "no"
 *   contains(a,"x") and not empty(b)
 */

const FALSEY = new Set(['', 'false', 'no', 'none', 'null', 'undefined', '0', 'rejected']);

const CALL = /^(contains|equals|matches|startswith|endswith|empty)\s*\(([\s\S]*)\)$/i;

export function evaluateCondition(expression, scope = {}) {
  const source = String(expression ?? '').trim();
  if (!source) return { value: true, reason: 'no condition' };
  try {
    return { value: evaluateOr(source, scope), reason: source };
  } catch (error) {
    // A condition that will not parse must not silently take the branch. Refusing
    // is what makes the router's default meaningful.
    return { value: false, reason: `unparsable condition: ${error.message}`, error: String(error.message ?? error) };
  }
}

function evaluateOr(source, scope) {
  const parts = splitTop(source, ' or ');
  if (parts.length > 1) return parts.some(part => evaluateOr(part, scope));
  const ands = splitTop(source, ' and ');
  if (ands.length > 1) return ands.every(part => evaluateOr(part, scope));
  return evaluateUnary(source.trim(), scope);
}

function evaluateUnary(source, scope) {
  if (/^not\s+/i.test(source)) return !evaluateUnary(source.replace(/^not\s+/i, '').trim(), scope);
  if (source.startsWith('(') && source.endsWith(')') && balanced(source.slice(1, -1))) return evaluateOr(source.slice(1, -1), scope);

  const call = source.match(CALL);
  if (call) return evaluateCall(call[1].toLowerCase(), splitTop(call[2], ','), scope);

  // A bare name is the truthiness of a value the run produced.
  return truthy(resolve(source, scope));
}

function evaluateCall(name, rawArguments, scope) {
  const values = rawArguments.map(argument => resolve(argument.trim(), scope));
  const left = String(values[0] ?? '');
  const right = String(values[1] ?? '');
  if (name === 'empty') return left.trim() === '';
  if (name === 'contains') return left.toLowerCase().includes(right.toLowerCase());
  if (name === 'equals') return left.trim().toLowerCase() === right.trim().toLowerCase();
  if (name === 'startswith') return left.trim().toLowerCase().startsWith(right.trim().toLowerCase());
  if (name === 'endswith') return left.trim().toLowerCase().endsWith(right.trim().toLowerCase());
  if (name === 'matches') {
    try {
      return new RegExp(right, 'i').test(left);
    } catch {
      throw new Error(`"${right}" is not a valid regular expression`);
    }
  }
  throw new Error(`unknown predicate ${name}`);
}

// A quoted argument is a literal; anything else names an output, an input, or an
// environment variable, checked in that order.
function resolve(token, scope) {
  const raw = String(token ?? '').trim();
  if (!raw) return '';
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(raw)) return raw;
  const path = raw.split('.');
  if (path[0] === 'inputs' && path[1]) return scope.inputs?.[path[1]] ?? '';
  if (path[0] === 'env' && path[1]) return scope.env?.[path[1]] ?? '';
  if (path[0] === 'nodes' && path[1]) return scope.outputs?.[path[1]] ?? '';
  return scope.outputs?.[raw] ?? scope.inputs?.[raw] ?? '';
}

function truthy(value) {
  if (typeof value === 'boolean') return value;
  return !FALSEY.has(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );
}

// Splitting has to respect quotes and parentheses, or `contains(a, "x and y")`
// would be torn in half at the `and`.
function splitTop(source, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  const text = String(source);
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quote) {
      if (character === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth !== 0) continue;
    if (text.slice(i, i + separator.length).toLowerCase() === separator.toLowerCase()) {
      parts.push(text.slice(start, i));
      i += separator.length - 1;
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim()).filter(part => part !== '');
}

function balanced(source) {
  let depth = 0;
  for (const character of source) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}
