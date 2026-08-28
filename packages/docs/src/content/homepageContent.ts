export type HomepageCard = {
  eyebrow: string;
  title: string;
  description: string;
};

export type HomepageDemoId = 'agent' | 'workflow' | 'web-app' | 'visual-code';

export type HomepageDemo = Pick<HomepageCard, 'title' | 'description'> & {
  demoId: HomepageDemoId;
  instruction: string;
};
export type HomepageFeature = HomepageDemo;
export type HomepageContextualDemo = HomepageDemo & Pick<HomepageCard, 'eyebrow'>;

export type HomepageUseCaseIcon = 'agent' | 'knowledge' | 'prompt' | 'web-app' | 'evaluation' | 'automation';

export type HomepageUseCase = HomepageCard & {
  icon: HomepageUseCaseIcon;
};

const agentDemo = {
  demoId: 'agent',
  title: 'LLM agents with tools',
  description:
    'The "LLM Chat" node automaticaly runs the tools and loops until the LLM answers with a non-toolcall response.',
  instruction: 'Paste your OpenAI API key, then run the project to watch the LLM call its tool graph.',
} satisfies HomepageDemo;
const workflowDemo = {
  demoId: 'workflow',
  title: 'Multi-step LLM workflows',
  description: 'Run LLM-powered branches in parallel and combine their results.',
  instruction: 'Paste your OpenAI API key, then run the project to see two LLM steps execute in parallel.',
} satisfies HomepageDemo;
const webAppDemo = {
  demoId: 'web-app',
  title: 'Workflow-powered web apps',
  description: 'Use a simple UI builder and run your AI workflows as web apps.',
  instruction: 'Paste your OpenAI API key, then open "Launch brief web app - open this" under Web Apps.',
} satisfies HomepageDemo;
const visualCodeDemo = {
  demoId: 'visual-code',
  title: 'A compact approval flow with one focused code step',
  description:
    'Number, Boolean, and Compare nodes make the policy visible. One Code node owns the tiered routing calculation that would be tedious to draw block by block.',
  instruction: 'Run the project and inspect how visible policy checks feed one focused Code node.',
} satisfies HomepageDemo;

export const homepageContent = {
  demos: [agentDemo, workflowDemo, webAppDemo, visualCodeDemo] satisfies HomepageDemo[],
  meta: {
    title: 'Rivet 2 — Visual AI workflows you can inspect, test, and ship',
    description:
      'Rivet 2 is a free, open-source visual IDE and runtime for building AI agents, knowledge workflows, prompt pipelines, and production AI applications.',
  },
  hero: {
    eyebrow: 'Free · Open-source · MIT licensed',
    title: 'Rivet 2 — visual IDE for production AI agents, workflows, and web apps',
    description:
      'Run the same Rivet 2 project in a desktop app, as an async function on your backend, or serve as an endpoint in a self-hosted web-service.',
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
  foundationsDemo: {
    ...visualCodeDemo,
    eyebrow: 'Live visual-plus-code demo',
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
          'Use evaluation suites, datasets, recordings, assertions, and evaluator graphs to turn important examples into checks you can rerun.',
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
        description: 'Save representative cases in evaluation datasets and suites so improvements stay improvements.',
      },
      {
        number: '04',
        title: 'Run in your stack',
        description: 'Execute projects from Node, the CLI, Docker, or an application that embeds the Rivet runtime.',
      },
      {
        number: '05',
        title: 'Debug live',
        description:
          'Connect the editor to a remote backend run and watch nodes finish in real time, including generated outputs and the exact point of failure.',
      },
      {
        number: '06',
        title: 'Replay what happened',
        description:
          'Capture completed runs, then reopen the recorded graph and data flow for post-mortem inspection instead of reconstructing the failure from logs.',
      },
    ],
  },
  wrapper: {
    eyebrow: 'Rivet Studio Server',
    title: 'Put Rivet on your VM. Get the whole workspace in your browser.',
    description:
      'Run Rivet Studio Server on infrastructure you control and use Rivet as a cloud workspace, project library, deployment surface, and observability console—without depending on the desktop app for everyday work.',
    facts: [
      {
        number: '01',
        title: 'The full editor in your browser',
        description:
          'Open the Rivet editor from any browser connected to your server. Build, run, and debug projects without installing the desktop app on that machine.',
      },
      {
        number: '02',
        title: 'Projects managed on the server',
        description:
          'Create folders, upload, edit, duplicate, rename, and save .rivet-project files in the hosted workspace. Routine edits no longer require a Git push just to reach the server.',
      },
      {
        number: '03',
        title: 'Publish workflows and web apps',
        description:
          'Turn a workflow into an HTTP endpoint or publish a project-contained web app from the UI, while keeping snapshots and execution on your own infrastructure.',
      },
      {
        number: '04',
        title: 'Recordings, live debugging, and run statistics',
        description:
          'Attach the Remote Debugger to latest server runs, reopen retained executions as graph replays, and inspect timing and outcome statistics across workflows and web-app actions.',
      },
    ],
    action: {
      label: 'View Rivet Studio Server for Rivet 2 on GitHub',
      to: 'https://github.com/valerypopoff/rivet2.0/tree/develop/deploy/studio-server',
    },
  },
  boundaries: {
    eyebrow: 'Know what Rivet is built for',
    title: 'Rivet is not Zapier for nontechnical users.',
    description:
      'Rivet 2 is a professional AI workflow IDE for developers. If your main need is choosing ready-made Google Drive, CRM, email, and other SaaS actions from a large connector catalog, an integration-automation product will fit better.',
    limitations: [
      {
        title: 'Not a no-code connector catalog',
        description:
          'Rivet does not aim to ship a dedicated node for every popular internet service. Its scope is AI systems and the general workflow primitives needed to build them.',
      },
      {
        title: 'Built for technical teams',
        description:
          'The workflow author is expected to understand HTTP APIs, authentication, JSON data, and, when the visual primitives stop being useful, JavaScript.',
      },
      {
        title: 'Bring ordinary integrations yourself',
        description:
          'Call the service API with HTTP Request or Code nodes, or package the integration as your own reusable node. Rivet keeps that contract visible instead of pretending the API is not there.',
      },
    ],
    fit: {
      eyebrow: 'Where Rivet does fit',
      title: 'Use Rivet when AI behavior is the hard part.',
      description:
        'Rivet concentrates its prebuilt surface on LLM providers, prompts, tools, knowledge and retrieval, structured data, testing, fallbacks, and execution inspection. Ordinary SaaS connectivity remains a developer-owned boundary.',
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
