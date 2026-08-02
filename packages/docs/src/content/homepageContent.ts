export type HomepageCard = {
  eyebrow: string;
  title: string;
  description: string;
};

export type HomepageDemoId = 'agent' | 'workflow' | 'web-app' | 'batch-runs' | 'structured-output';

export type HomepageDemo = Pick<HomepageCard, 'title' | 'description'> & {
  demoId: HomepageDemoId;
  instruction: string;
};
export type HomepageFeature = HomepageDemo;
export type HomepageContextualDemo = HomepageDemo & Pick<HomepageCard, 'eyebrow'>;
export type HomepageFoundation = Omit<HomepageCard, 'eyebrow'>;

export type HomepageUseCaseIcon = 'agent' | 'knowledge' | 'prompt' | 'web-app' | 'evaluation' | 'automation';

export type HomepageUseCase = HomepageCard & {
  icon: HomepageUseCaseIcon;
};

const agentDemo = {
  demoId: 'agent',
  title: 'LLM agent with tools',
  description: 'Let an LLM call a typed tool backed by a Rivet graph. Inspect the call, tool result, and final answer.',
  instruction: 'Paste your OpenAI API key, then run the project to watch the LLM call its tool graph.',
} satisfies HomepageDemo;
const workflowDemo = {
  demoId: 'workflow',
  title: 'Multi-step LLM workflow',
  description: 'Run focused LLM steps in parallel, combine their results, and inspect every value in the workflow.',
  instruction: 'Paste your OpenAI API key, then run the project to see two LLM steps execute in parallel.',
} satisfies HomepageDemo;
const webAppDemo = {
  demoId: 'web-app',
  title: 'Web app powered by a workflow',
  description: 'Put a chat interface over an LLM workflow. Build both in Rivet and keep them in the same project.',
  instruction: 'Paste your OpenAI API key, then open “Chat web app — open this” under Web Apps.',
} satisfies HomepageDemo;
const batchRunsDemo = {
  demoId: 'batch-runs',
  title: 'One node, many inspectable runs',
  description:
    'Feed three requests into one LLM node, run them in parallel, and switch between the node’s individual inputs, outputs, durations, and statuses.',
  instruction:
    'Paste your OpenAI API key, then run the project; the Classify requests node processes three customer requests as parallel, selectable runs.',
} satisfies HomepageDemo;
const structuredOutputDemo = {
  demoId: 'structured-output',
  title: 'Typed structured output',
  description:
    'Constrain an LLM with a visible JSON schema, expose its fields as typed values, and pass them through ordinary Rivet nodes without parsing strings by hand.',
  instruction:
    'Paste your OpenAI API key, then run the project; the LLM extracts a support ticket into the visible schema and the final Text node renders a triage card.',
} satisfies HomepageDemo;

export const homepageContent = {
  demos: [agentDemo, workflowDemo, webAppDemo, batchRunsDemo, structuredOutputDemo] satisfies HomepageDemo[],
  meta: {
    title: 'Rivet 2 — Visual AI workflows you can inspect, test, and ship',
    description:
      'Rivet 2 is a free, open-source visual IDE and runtime for building AI agents, knowledge workflows, prompt pipelines, and production AI applications.',
  },
  hero: {
    eyebrow: 'Free · Open-source · MIT licensed',
    title: 'Build AI agents, workflows, and web apps visually',
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
    features: [agentDemo, workflowDemo, webAppDemo] satisfies HomepageFeature[],
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
  foundationsDemo: {
    ...batchRunsDemo,
    eyebrow: 'Live execution demo',
  } satisfies HomepageContextualDemo,
  useCases: {
    eyebrow: 'Built for practical AI work',
    title: 'One workspace for the systems around your model.',
    description:
      'Start with a small prompt chain or assemble a complete application. Rivet gives each part of the system a visible place to live.',
    cards: [
      {
        icon: 'agent',
        eyebrow: 'Agents and tools',
        title: 'Tool-using assistants',
        description:
          'Define tool contracts, delegate calls to graphs, run tools in parallel, and inspect every argument and result before the model continues.',
      },
      {
        icon: 'knowledge',
        eyebrow: 'Knowledge and RAG',
        title: 'Grounded AI workflows',
        description:
          'Synchronize provider-neutral knowledge sources, search with multiple queries, assemble evidence, and keep retrieval separate from generation.',
      },
      {
        icon: 'prompt',
        eyebrow: 'Prompt engineering',
        title: 'Structured generation pipelines',
        description:
          'Build multi-step prompts, reusable model profiles, strict response schemas, fallbacks, transformations, and validation into one readable flow.',
      },
      {
        icon: 'web-app',
        eyebrow: 'AI product surfaces',
        title: 'Web apps and chat experiences',
        description:
          'Create project-contained forms, chat interfaces, actions, and output views, then serve them through the CLI or embed them in your own host.',
      },
      {
        icon: 'evaluation',
        eyebrow: 'Evaluation',
        title: 'Repeatable tests for AI behavior',
        description:
          'Use Trivet test suites, datasets, recordings, and validation graphs to turn important examples into checks you can rerun.',
      },
      {
        icon: 'automation',
        eyebrow: 'Automation',
        title: 'Model-assisted business workflows',
        description:
          'Combine LLMs with HTTP, files, datasets, MCP, schedules, branching, and custom code without hiding the logic inside one giant agent prompt.',
      },
    ] satisfies HomepageUseCase[],
  },
  useCasesDemo: {
    ...structuredOutputDemo,
    eyebrow: 'Live typed-data demo',
  } satisfies HomepageContextualDemo,
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
  wrapper: {
    eyebrow: 'A ready self-hosted Rivet server',
    title: 'Serve Rivet projects without building the host yourself.',
    description:
      'Rivet Studio Server is a ready-to-deploy, self-hosted wrapper for Rivet projects. Use it when you want production API endpoints and web apps without writing and maintaining your own Node server.',
    capabilities: [
      'Publish project workflows as callable API endpoints',
      'Serve web apps defined inside Rivet projects',
      'Keep deployment and project execution on infrastructure you control',
      'Start with a ready server instead of implementing the hosting layer from scratch',
    ],
    serverLabel: 'Rivet Studio Server',
    deploymentLabel: 'One self-hosted runtime for your Rivet projects',
    services: [
      ['API endpoints', 'Run project workflows over HTTP'],
      ['Published web apps', 'Serve project-defined interfaces'],
      ['Rivet projects', 'Deploy the same artifacts you edit'],
    ],
    runtimeSurfaces: ['Self-hosted', 'Docker-ready', 'Your infrastructure'],
    action: {
      label: 'View Rivet Studio Server on GitHub',
      to: 'https://github.com/valerypopoff/Rivet-Studio-Server',
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
