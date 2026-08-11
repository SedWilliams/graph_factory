/*
 * TEMPLATES — starter graphs.
 *
 * These are not demos. Each one is a system that compiles cleanly and runs, and
 * they exist to teach the format by example: the first shows sequential handoff,
 * the second a review loop closed by a feedback edge, the third a parallel fan-out
 * with a human gate. Between them every node type appears at least once.
 */

import { normalizeGraph } from './normalize.mjs';

const templates = [
  {
    key: 'plan-build-review',
    title: 'Plan → build → review',
    blurb: 'The standard development cycle: one agent plans, one implements, one reviews before anything is called done.',
    graph: {
      id: 'plan-build-review',
      name: 'Plan, build, review',
      description: 'Three agents in sequence. The planner may only read; the builder may write; the reviewer reads the diff and reports.',
      defaults: { model: 'claude-opus-5', harness: 'claude', maxTurns: 30 },
      inputs: [{ id: 'task', label: 'Task', type: 'string', required: true, description: 'What should be built.' }],
      nodes: [
        { id: 'begin', type: 'start', name: 'Task in' },
        {
          id: 'planner',
          type: 'agent',
          name: 'Planner',
          role: 'Architecture and implementation planning',
          model: 'claude-opus-5',
          tools: ['read', 'grep', 'glob'],
          output: 'plan',
          system: 'You plan work. You never modify files.',
          prompt:
            'Plan the implementation for:\n\n{{inputs.task}}\n\nIdentify the files to change, the order to change them in, and the risks. Output a numbered plan.',
        },
        {
          id: 'builder',
          type: 'agent',
          name: 'Builder',
          role: 'Implementation',
          tools: ['read', 'write', 'edit', 'grep', 'glob', 'bash'],
          output: 'diff',
          prompt: 'Implement this plan exactly. Do not expand its scope.\n\n{{plan}}\n\nOriginal task: {{inputs.task}}',
        },
        {
          id: 'tests',
          type: 'tool',
          name: 'Test suite',
          run: 'npm test',
          output: 'test_output',
          description: 'The gate the builder has to get past before review is worth anyone time.',
        },
        {
          id: 'reviewer',
          type: 'agent',
          name: 'Reviewer',
          role: 'Independent code review',
          tools: ['read', 'grep', 'glob'],
          output: 'review',
          prompt:
            'Review this implementation for correctness, then for style.\n\nWhat was built:\n{{diff}}\n\nTest output:\n{{test_output}}\n\nReport findings most severe first. If nothing is wrong, say APPROVED.',
        },
        { id: 'done', type: 'end', name: 'Reviewed change', output: 'review' },
      ],
      edges: [
        { from: 'begin', to: 'planner' },
        { from: 'planner', to: 'builder', type: 'handoff' },
        { from: 'builder', to: 'tests' },
        { from: 'tests', to: 'reviewer' },
        { from: 'reviewer', to: 'done' },
        { from: 'builder', to: 'tests', type: 'uses' },
      ],
    },
  },
  {
    key: 'review-until-clean',
    title: 'Review until clean',
    blurb: 'A build/review loop that keeps going until the reviewer approves or the iteration cap is hit.',
    graph: {
      id: 'review-until-clean',
      name: 'Review until clean',
      description: 'The reviewer decides whether the work ships. A router sends rejected work back to the builder through a feedback edge.',
      defaults: { model: 'claude-opus-5', harness: 'claude', maxTurns: 40 },
      inputs: [
        { id: 'task', label: 'Task', type: 'string', required: true },
        { id: 'max_rounds', label: 'Maximum rounds', type: 'number', default: 3 },
      ],
      nodes: [
        { id: 'begin', type: 'start', name: 'Task in' },
        {
          id: 'attempt',
          type: 'loop',
          name: 'Until approved',
          until: 'approved',
          maxIterations: 3,
          description: 'Each pass is one build-and-review round.',
        },
        {
          id: 'builder',
          type: 'agent',
          name: 'Builder',
          tools: ['read', 'write', 'edit', 'bash'],
          output: 'work',
          prompt:
            'Implement the following. If review feedback is present, address every point in it.\n\nTask: {{inputs.task}}\n\nFeedback: {{review}}',
        },
        {
          id: 'reviewer',
          type: 'agent',
          name: 'Reviewer',
          tools: ['read', 'grep', 'bash'],
          output: 'review',
          prompt:
            'Review this work against the task.\n\nTask: {{inputs.task}}\n\nWork:\n{{work}}\n\nEnd your reply with APPROVED or CHANGES REQUESTED.',
        },
        { id: 'verdict', type: 'router', name: 'Verdict', expression: 'review' },
        { id: 'shipped', type: 'end', name: 'Approved', output: 'work' },
      ],
      edges: [
        { from: 'begin', to: 'attempt' },
        { from: 'attempt', to: 'builder' },
        { from: 'builder', to: 'reviewer' },
        { from: 'reviewer', to: 'verdict' },
        { from: 'verdict', to: 'shipped', type: 'branch', when: 'contains(review, "APPROVED")' },
        { from: 'verdict', to: 'builder', type: 'feedback', label: 'changes requested' },
      ],
    },
  },
  {
    key: 'parallel-audit',
    title: 'Parallel audit with a gate',
    blurb: 'Three specialists inspect the same change at once; a human approves the merged report before anything is applied.',
    graph: {
      id: 'parallel-audit',
      name: 'Parallel audit',
      description: 'Security, performance, and test coverage are independent questions, so they are asked at the same time.',
      defaults: { model: 'claude-opus-5', harness: 'claude', maxTurns: 20 },
      inputs: [{ id: 'target', label: 'What to audit', type: 'string', default: 'the working tree' }],
      nodes: [
        { id: 'begin', type: 'start', name: 'Audit request' },
        { id: 'split', type: 'parallel', name: 'Three passes', join: 'all', concurrency: 3 },
        {
          id: 'security',
          type: 'agent',
          name: 'Security',
          tools: ['read', 'grep', 'glob'],
          output: 'security_report',
          prompt:
            'Audit {{inputs.target}} for injection, auth bypass, exposed secrets, and unsafe deserialisation. Report findings with file and line.',
        },
        {
          id: 'performance',
          type: 'agent',
          name: 'Performance',
          tools: ['read', 'grep', 'glob'],
          output: 'performance_report',
          prompt: 'Audit {{inputs.target}} for hot-path allocations, N+1 queries, and unbounded work. Report findings with file and line.',
        },
        {
          id: 'coverage',
          type: 'agent',
          name: 'Coverage',
          tools: ['read', 'grep', 'glob', 'bash'],
          output: 'coverage_report',
          prompt: 'Audit {{inputs.target}} for untested behaviour. Name the specific cases that have no test.',
        },
        {
          id: 'merge',
          type: 'agent',
          name: 'Editor',
          tools: ['read'],
          output: 'report',
          prompt:
            'Merge these three audits into one report, most severe first, dropping duplicates.\n\nSecurity:\n{{security_report}}\n\nPerformance:\n{{performance_report}}\n\nCoverage:\n{{coverage_report}}',
        },
        { id: 'approve', type: 'gate', name: 'Approve findings', prompt: 'Read the merged report. Approve to open the fix tasks.', onReject: 'stop' },
        { id: 'filed', type: 'end', name: 'Report filed', output: 'report' },
      ],
      edges: [
        { from: 'begin', to: 'split' },
        { from: 'split', to: 'security' },
        { from: 'split', to: 'performance' },
        { from: 'split', to: 'coverage' },
        { from: 'security', to: 'merge' },
        { from: 'performance', to: 'merge' },
        { from: 'coverage', to: 'merge' },
        { from: 'merge', to: 'approve' },
        { from: 'approve', to: 'filed', type: 'branch', default: true },
      ],
    },
  },
];

export function templateList() {
  return templates.map(({ key, title, blurb }) => ({ key, title, blurb }));
}

export function templateGraph(key) {
  const found = templates.find(template => template.key === key);
  return found ? normalizeGraph(found.graph) : null;
}

export function starterGraphs() {
  return templates.map(template => normalizeGraph(template.graph));
}
