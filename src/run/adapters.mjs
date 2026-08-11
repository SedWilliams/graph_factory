/*
 * ADAPTERS — how a single agent step actually reaches a model.
 *
 * Every harness here is a real CLI with real flags, checked against the installed
 * versions rather than guessed. The shapes differ more than they look:
 *
 *   claude    prompt via -p, tools as an allow-list, model by bare name
 *   pi        prompt as a positional message, --print for headless, tools as CSV
 *   opencode  `run` subcommand, model namespaced provider/model, agent by name
 *   codex     `exec` subcommand, behaviour set by a config profile, not by flags
 *
 * The dry adapter is not a mock for tests only. It is how you inspect what a graph
 * would send before spending tokens on it, so it renders every prompt exactly as
 * the live adapters would and returns a placeholder in place of the model's reply.
 */

import { spawn } from 'node:child_process';

const TOOL_TRANSLATION = {
  claude: {
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    grep: 'Grep',
    glob: 'Glob',
    bash: 'Bash',
    web_search: 'WebSearch',
    web_fetch: 'WebFetch',
    todo: 'TodoWrite',
  },
  pi: {
    read: 'read',
    write: 'write',
    edit: 'edit',
    grep: 'grep',
    glob: 'find',
    bash: 'bash',
    web_search: 'websearch',
    web_fetch: 'webfetch',
    todo: 'todo',
  },
  opencode: {
    read: 'read',
    write: 'write',
    edit: 'edit',
    grep: 'grep',
    glob: 'glob',
    bash: 'bash',
    web_search: 'websearch',
    web_fetch: 'webfetch',
    todo: 'todowrite',
  },
  codex: {},
};

const translate = (harness, tools) => (tools ?? []).map(tool => TOOL_TRANSLATION[harness]?.[tool] ?? tool);

function providerFor(model) {
  const id = String(model ?? '').toLowerCase();
  if (id.includes('/')) return null;
  if (id.startsWith('claude')) return 'anthropic';
  if (id.startsWith('gpt') || id.startsWith('o1') || id.startsWith('o3')) return 'openai';
  if (id.startsWith('gemini')) return 'google';
  return null;
}

/*
 * Each builder returns the exact argv. Kept as pure functions so a test can assert
 * the command line without spawning anything, and so the UI can show the developer
 * precisely what is about to run.
 */
export const COMMANDS = {
  claude(step, { cwd } = {}) {
    const args = ['-p', step.prompt, '--output-format', 'text'];
    if (step.model) args.push('--model', step.model);
    const tools = translate('claude', step.tools);
    if (tools.length) args.push('--allowedTools', tools.join(','));
    if (step.system) args.push('--append-system-prompt', step.system);
    return { command: 'claude', args, cwd };
  },
  pi(step, { cwd } = {}) {
    const args = ['--print', '--mode', 'text'];
    if (step.model) args.push('--model', step.model);
    const tools = translate('pi', step.tools);
    if (tools.length) args.push('--tools', tools.join(','));
    if (step.system) args.push('--append-system-prompt', step.system);
    // pi takes the message as a positional, so it has to come last.
    args.push(step.prompt);
    return { command: 'pi', args, cwd };
  },
  opencode(step, { cwd } = {}) {
    const args = ['run'];
    const provider = providerFor(step.model);
    if (step.model) args.push('--model', provider ? `${provider}/${step.model}` : step.model);
    if (step.agent) args.push('--agent', step.agent);
    args.push(step.system ? `${step.system}\n\n${step.prompt}` : step.prompt);
    return { command: 'opencode', args, cwd };
  },
  codex(step, { cwd, graphId } = {}) {
    const args = ['exec', '--skip-git-repo-check'];
    if (graphId && step.id) args.push('--profile', `${graphId}-${step.id}`);
    else if (step.model) args.push('--model', step.model);
    args.push(step.system ? `${step.system}\n\n${step.prompt}` : step.prompt);
    return { command: 'codex', args, cwd };
  },
};

export function buildCommand(harness, step, options = {}) {
  const builder = COMMANDS[harness];
  if (!builder) throw new Error(`No adapter for harness "${harness}". Known: ${Object.keys(COMMANDS).join(', ')}, dry.`);
  return builder(step, options);
}

export function createDryAdapter({ onCommand = null } = {}) {
  return {
    name: 'dry',
    live: false,
    async agent(step, context) {
      const harness = step.harness && COMMANDS[step.harness] ? step.harness : 'claude';
      const invocation = buildCommand(harness, step, context);
      onCommand?.(invocation);
      return {
        output: `[dry run] ${step.name || step.id} would call ${invocation.command} with ${step.prompt.length} characters of prompt.`,
        invocation,
      };
    },
    async tool(step) {
      return { output: `[dry run] would run: ${step.run || step.mcp}`, invocation: { command: step.run || step.mcp, args: [] } };
    },
  };
}

export function createHarnessAdapter(harness, { cwd = process.cwd(), timeoutMs = 20 * 60 * 1000, env = process.env, graphId = '' } = {}) {
  if (!COMMANDS[harness]) throw new Error(`No adapter for harness "${harness}". Known: ${Object.keys(COMMANDS).join(', ')}, dry.`);
  return {
    name: harness,
    live: true,
    async agent(step) {
      const invocation = buildCommand(harness, step, { cwd, graphId });
      const result = await execute(invocation.command, invocation.args, { cwd, timeoutMs, env });
      if (result.code !== 0) {
        throw new Error(`${harness} exited ${result.code} on step "${step.id}".\n${result.stderr.slice(-2000) || result.stdout.slice(-2000)}`);
      }
      return { output: result.stdout.trim(), invocation, stderr: result.stderr };
    },
    async tool(step) {
      if (!step.run) throw new Error(`Tool "${step.id}" has no command to run. MCP tools must be called by an agent.`);
      const result = await execute(step.run, [], { cwd, timeoutMs, env, shell: true });
      const output = `${result.stdout}${result.stderr}`.trim();
      if (result.code !== 0 && !step.continueOnError) {
        throw new Error(`Tool "${step.id}" exited ${result.code}.\n${output.slice(-2000)}`);
      }
      return { output, exitCode: result.code, invocation: { command: step.run, args: [] } };
    },
  };
}

export function createAdapter(harness, options = {}) {
  return harness === 'dry' ? createDryAdapter(options) : createHarnessAdapter(harness, options);
}

// A harness that hangs must not hang the run. The child is killed on timeout and
// whatever it managed to print is kept, because a partial answer names the problem
// better than an empty one.
function execute(command, args, { cwd, timeoutMs, env, shell = false }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, shell, windowsHide: true });
    } catch (error) {
      reject(new Error(`Could not start "${command}": ${error.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on('data', chunk => (stdout += chunk));
    child.stderr?.on('data', chunk => (stderr += chunk));
    child.on('error', error => {
      clearTimeout(timer);
      reject(new Error(`Could not run "${command}": ${error.message}. Is it installed and on your PATH?`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`"${command}" timed out after ${Math.round(timeoutMs / 1000)}s.\n${stderr.slice(-1000)}`));
        return;
      }
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}
