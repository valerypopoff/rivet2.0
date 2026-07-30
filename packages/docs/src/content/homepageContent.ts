export type HomepageCard = {
  eyebrow: string;
  title: string;
  description: string;
};

export type HomepageFeature = Pick<HomepageCard, 'title' | 'description'>;
export type HomepageFoundation = Omit<HomepageCard, 'eyebrow'>;

export const homepageContent = {
  meta: {
    title: 'Rivet 2 is a Visual AI workflows you can inspect, test, and ship',
    description:
      'Rivet 2 is a free, open-source visual IDE and runtime for building AI agents, knowledge workflows, prompt pipelines, and production AI applications.',
  },
  hero: {
    eyebrow: 'Free · Open-source · MIT licensed',
    title: 'Rivet 2 — IDE for production ready AI-harnesses: agents, workflows and web apps',
    description:
      'Prototype, inspect and run the same Rivet project in Node, from the CLI, or inside your own application.',
    primaryAction: {
      label: 'Download Rivet 2',
      to: '/download',
    },
    secondaryAction: {
      label: 'Read user guide',
      to: '/user-guide',
    },
    sourceAction: {
      label: 'View source on GitHub',
      to: 'https://github.com/valerypopoff/rivet2.0',
    },
    features: [
      {
        title: 'Visible AI systems',
        description: 'Keep prompts, tools, branching, and data flow readable on one canvas.',
      },
      {
        title: 'Inspectable runs',
        description: 'See each input, model request, tool result, error, and cost where it happened.',
      },
      {
        title: 'A runtime beyond the editor',
        description: 'Run the same project in the desktop app, Node, CLI, Docker, or your own host.',
      },
    ] satisfies HomepageFeature[],
  },
  workflowPreview: {
    projectName: 'support-agent.rivet-project',
    runState: 'Run complete',
    nodes: {
      prompt: {
        kind: 'INPUT',
        title: 'Customer question',
        detail: 'string',
        output: 'Question ready',
      },
      knowledge: {
        kind: 'KNOWLEDGE',
        title: 'Search product docs',
        detail: '6 grounded results',
        status: '184 ms',
        output: '6 results ready',
      },
      agent: {
        kind: 'LLM CHAT',
        title: 'Support agent',
        detail: 'Tools · structured output',
        status: '1.2 s',
        output: 'Answer ready',
      },
      output: {
        kind: 'OUTPUT',
        title: 'Helpful answer',
        detail: 'Markdown',
        output: 'Response emitted',
      },
    },
    inspector: {
      label: 'Latest run',
      title: 'Every step is inspectable',
      rows: [
        ['Prompt', 'ready'],
        ['Knowledge', '6 results'],
        ['Model response', 'complete'],
      ],
    },
    caption: ['Inputs', 'Model calls', 'Tool results', 'Outputs'],
  },
  philosophy: {
    eyebrow: 'An AI workflow IDE, not a black box',
    title: 'Visual when it helps. Code when it matters.',
    description:
      'Move quickly without giving up control. Rivet keeps prompts, tools, branching, data, and model calls visible on one canvas—and gives you code nodes when a visual block is not the right abstraction.',
  },
  foundations: [
    {
      title: 'Inspect the whole execution',
      description:
        'See inputs, outputs, tool calls, timing, errors, and intermediate values at the node where they happened. Debug the workflow instead of guessing what the model did.',
    },
    {
      title: 'Compose systems, not prompt demos',
      description:
        'Use subgraphs, loops, parallel work, reusable LLM profiles, async side effects, stored values, and typed inputs to keep complex agents legible.',
    },
    {
      title: 'Use code without abandoning the canvas',
      description:
        'Drop into JavaScript for custom transformations or integrations, then bring the result straight back into the visible workflow.',
    },
  ] satisfies HomepageFoundation[],
  useCases: {
    eyebrow: 'Built for practical AI work',
    title: 'One workspace for the systems around your model.',
    description:
      'Start with a small prompt chain or assemble a complete application. Rivet gives each part of the system a visible place to live.',
    cards: [
      {
        eyebrow: 'Agents and tools',
        title: 'Tool-using assistants',
        description:
          'Define tool contracts, delegate calls to graphs, run tools in parallel, and inspect every argument and result before the model continues.',
      },
      {
        eyebrow: 'Knowledge and RAG',
        title: 'Grounded AI workflows',
        description:
          'Synchronize provider-neutral knowledge sources, search with multiple queries, assemble evidence, and keep retrieval separate from generation.',
      },
      {
        eyebrow: 'Prompt engineering',
        title: 'Structured generation pipelines',
        description:
          'Build multi-step prompts, reusable model profiles, strict response schemas, fallbacks, transformations, and validation into one readable flow.',
      },
      {
        eyebrow: 'AI product surfaces',
        title: 'Web apps and chat experiences',
        description:
          'Create project-contained forms, chat interfaces, actions, and output views, then serve them through the CLI or embed them in your own host.',
      },
      {
        eyebrow: 'Evaluation',
        title: 'Repeatable tests for AI behavior',
        description:
          'Use Trivet test suites, datasets, recordings, and validation graphs to turn important examples into checks you can rerun.',
      },
      {
        eyebrow: 'Automation',
        title: 'Model-assisted business workflows',
        description:
          'Combine LLMs with HTTP, files, datasets, MCP, schedules, branching, and custom code without hiding the logic inside one giant agent prompt.',
      },
    ] satisfies HomepageCard[],
  },
  lifecycle: {
    eyebrow: 'From first idea to a running product',
    title: 'The graph stays useful after the prototype works.',
    steps: [
      {
        number: '01',
        title: 'Design',
        description: 'Build the data flow visually and keep large systems readable with reusable subgraphs.',
      },
      {
        number: '02',
        title: 'Inspect',
        description: 'Run from the editor and examine the exact values, requests, costs, and failures at every step.',
      },
      {
        number: '03',
        title: 'Test',
        description: 'Save representative cases in datasets and Trivet suites so improvements stay improvements.',
      },
      {
        number: '04',
        title: 'Run in your stack',
        description: 'Execute projects from Node, the CLI, Docker, or an application that embeds the Rivet runtime.',
      },
    ],
  },
  production: {
    eyebrow: 'A visual builder with a real runtime',
    title: 'Prototype fast. Keep the architecture.',
    description:
      'A Rivet project is not a screenshot of a prototype. It is the executable artifact. Keep editing it in the desktop IDE while production runs it through the Node package, CLI, Docker, or an embedded host.',
    capabilities: [
      'Run the same .rivet-project outside the editor',
      'Run in Browser or Node, or invoke project graphs programmatically',
      'Observe remote executions from the desktop debugger',
      'Bring your own providers, credentials, stores, and MCP tools',
      'Host workflows and web apps behind infrastructure you control',
    ],
    responsibilityNote:
      'Your production host remains responsible for authentication, tenancy, durable storage, quotas, telemetry, and deployment policy.',
    runtimeLabel: 'Node integration',
    commandLabel: 'Run a graph from your Node service',
    command: `import { runGraphInFile } from '@valerypopoff/rivet2-node';

const output = await runGraphInFile('./assistant.rivet-project', {
  graph: 'Chat',
  inputs: { message },
});`,
    runtimeSignals: ['Project loaded', 'Request handled', 'Outputs returned'],
    runtimeSurfaces: ['Desktop', 'Browser', 'Node', 'CLI', 'Embedded'],
    action: {
      label: 'Explore the API reference',
      to: '/api-reference',
    },
  },
  closing: {
    eyebrow: 'Build the workflow you actually want to maintain',
    title: 'Free to use. Open to inspect. Ready to grow with the project.',
    description:
      'Download the desktop app and build your first workflow, or start with the runtime packages if your AI system already lives in code.',
    primaryAction: {
      label: 'Get Rivet 2',
      to: '/download',
    },
    secondaryAction: {
      label: 'Build your first AI agent',
      to: '/getting-started/first-ai-agent',
    },
  },
} as const;
