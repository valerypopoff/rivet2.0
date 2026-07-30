import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import useBaseUrl from '@docusaurus/useBaseUrl';
import { homepageContent } from '../content/homepageContent';
import styles from './index.module.css';

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

function SectionHeading({
  eyebrow,
  title,
  description,
  align = 'left',
}: {
  eyebrow: string;
  title: string;
  description?: string;
  align?: 'left' | 'center';
}) {
  return (
    <div className={align === 'center' ? styles.sectionHeadingCentered : styles.sectionHeading}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h2>{title}</h2>
      {description && <p className={styles.sectionDescription}>{description}</p>}
    </div>
  );
}

function WorkflowNode({
  className,
  id,
  kind,
  title,
  detail,
  output,
  status,
}: {
  className: string;
  id: string;
  kind: string;
  title: string;
  detail: string;
  output: string;
  status?: string;
}) {
  return (
    <div className={`${styles.workflowNode} ${className}`}>
      <div className={styles.nodeHeader}>
        <span className={styles.nodeDot} />
        <span>{kind}</span>
        {status && <span className={styles.nodeStatus}>{status}</span>}
      </div>
      <strong>{title}</strong>
      <span className={styles.nodeDetail}>{detail}</span>
      <div className={styles.nodeOutput}>
        <span>Output</span>
        <b>{output}</b>
      </div>
      <i className={styles.inputPort} data-workflow-port={`${id}-input`} />
      <i className={styles.outputPort} data-workflow-port={`${id}-output`} />
    </div>
  );
}

type WorkflowPoint = { x: number; y: number };

type WorkflowConnectionLayout = {
  width: number;
  height: number;
  paths: string[];
};

function createConnectionPath(from: WorkflowPoint, to: WorkflowPoint) {
  const handle = Math.max(28, Math.abs(to.x - from.x) * 0.42);
  return `M ${from.x} ${from.y} C ${from.x + handle} ${from.y} ${to.x - handle} ${to.y} ${to.x} ${to.y}`;
}

function WorkflowPreview({ content }: { content: (typeof homepageContent)['workflowPreview'] }) {
  const { nodes } = content;
  const logoUrl = useBaseUrl('/img/logo.svg');
  const canvasRef = useRef<HTMLDivElement>(null);
  const [connections, setConnections] = useState<WorkflowConnectionLayout | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const updateConnections = () => {
      const canvasBounds = canvas.getBoundingClientRect();
      const getPortCenter = (name: string): WorkflowPoint | undefined => {
        const port = canvas.querySelector<HTMLElement>(`[data-workflow-port="${name}"]`);
        if (!port) {
          return undefined;
        }

        const bounds = port.getBoundingClientRect();
        return {
          x: bounds.left - canvasBounds.left + bounds.width / 2,
          y: bounds.top - canvasBounds.top + bounds.height / 2,
        };
      };

      const pairs: Array<[string, string]> = [
        ['prompt-output', 'agent-input'],
        ['knowledge-output', 'agent-input'],
        ['agent-output', 'output-input'],
      ];
      const paths = pairs.flatMap(([fromName, toName]) => {
        const from = getPortCenter(fromName);
        const to = getPortCenter(toName);
        return from && to ? [createConnectionPath(from, to)] : [];
      });
      const next = { width: canvasBounds.width, height: canvasBounds.height, paths };

      setConnections((current) =>
        current &&
        current.width === next.width &&
        current.height === next.height &&
        current.paths.join('|') === next.paths.join('|')
          ? current
          : next,
      );
    };

    updateConnections();

    const observer = new ResizeObserver(updateConnections);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={styles.workflowPreview} role="img" aria-label="Example Rivet workflow">
      <div className={styles.previewTopbar}>
        <span className={styles.previewLights}>
          <i />
          <i />
          <i />
        </span>
        <span className={styles.previewProject}>
          <img src={logoUrl} alt="" />
          {content.projectName}
        </span>
        <span className={styles.runState}>
          <i /> {content.runState}
        </span>
      </div>
      <div className={styles.canvas} ref={canvasRef}>
        {connections && (
          <svg
            className={styles.workflowConnections}
            viewBox={`0 0 ${connections.width} ${connections.height}`}
            aria-hidden="true"
          >
            {connections.paths.map((path, index) => (
              <path d={path} key={index} />
            ))}
          </svg>
        )}
        <WorkflowNode
          className={styles.promptNode}
          id="prompt"
          kind={nodes.prompt.kind}
          title={nodes.prompt.title}
          detail={nodes.prompt.detail}
          output={nodes.prompt.output}
        />
        <WorkflowNode
          className={styles.knowledgeNode}
          id="knowledge"
          kind={nodes.knowledge.kind}
          title={nodes.knowledge.title}
          detail={nodes.knowledge.detail}
          output={nodes.knowledge.output}
          status={nodes.knowledge.status}
        />
        <WorkflowNode
          className={styles.llmNode}
          id="agent"
          kind={nodes.agent.kind}
          title={nodes.agent.title}
          detail={nodes.agent.detail}
          output={nodes.agent.output}
          status={nodes.agent.status}
        />
        <WorkflowNode
          className={styles.outputNode}
          id="output"
          kind={nodes.output.kind}
          title={nodes.output.title}
          detail={nodes.output.detail}
          output={nodes.output.output}
        />
        <div className={styles.inspectorCard}>
          <span>{content.inspector.label}</span>
          <strong>{content.inspector.title}</strong>
          {content.inspector.rows.map(([label, value]) => (
            <div key={label}>
              <i />
              <span>{label}</span>
              <b>{value}</b>
            </div>
          ))}
        </div>
      </div>
      <div className={styles.previewCaption}>
        {content.caption.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  );
}

function ActionLink({
  children,
  to,
  variant = 'primary',
}: {
  children: ReactNode;
  to: string;
  variant?: 'primary' | 'secondary' | 'text';
}) {
  const className =
    variant === 'primary' ? styles.primaryAction : variant === 'secondary' ? styles.secondaryAction : styles.textAction;

  return (
    <Link className={className} to={to}>
      {children}
    </Link>
  );
}

export default function Home() {
  const content = homepageContent;

  return (
    <Layout description={content.meta.description}>
      <Head>
        <title>Rivet 2 — {content.meta.title}</title>
        <meta property="og:title" content={`Rivet 2 — ${content.meta.title}`} />
        <meta property="og:description" content={content.meta.description} />
      </Head>
      <main className={styles.landing}>
        <section className={styles.hero}>
          <div className={styles.heroGlow} aria-hidden="true" />
          <div className={styles.heroGrid}>
            <div className={styles.heroCopy}>
              <p className={styles.heroEyebrow}>
                <span />
                {content.hero.eyebrow}
              </p>
              <h1>{content.hero.title}</h1>
              <p className={styles.heroDescription}>{content.hero.description}</p>
              <div className={styles.heroActions}>
                <ActionLink to={content.hero.primaryAction.to}>
                  {content.hero.primaryAction.label} <Arrow />
                </ActionLink>
                <ActionLink to={content.hero.secondaryAction.to} variant="secondary">
                  {content.hero.secondaryAction.label}
                </ActionLink>
                <ActionLink to={content.hero.sourceAction.to} variant="text">
                  {content.hero.sourceAction.label} <Arrow />
                </ActionLink>
              </div>
            </div>
            <div className={styles.heroShowcase}>
              <div className={styles.heroFeatureList}>
                {content.hero.features.map((feature) => (
                  <article className={styles.heroFeature} key={feature.title}>
                    <h2>{feature.title}</h2>
                    <p>{feature.description}</p>
                  </article>
                ))}
              </div>
              <WorkflowPreview content={content.workflowPreview} />
            </div>
          </div>
        </section>

        <section className={styles.foundationSection}>
          <div className={styles.sectionShell}>
            <SectionHeading
              eyebrow={content.philosophy.eyebrow}
              title={content.philosophy.title}
              description={content.philosophy.description}
            />
            <div className={styles.foundationGrid}>
              {content.foundations.map((foundation, index) => (
                <article className={styles.foundationCard} key={foundation.title}>
                  <span className={styles.cardNumber}>{String(index + 1).padStart(2, '0')}</span>
                  <h3>{foundation.title}</h3>
                  <span>{foundation.description}</span>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.useCasesSection}>
          <div className={styles.sectionShell}>
            <SectionHeading
              eyebrow={content.useCases.eyebrow}
              title={content.useCases.title}
              description={content.useCases.description}
              align="center"
            />
            <div className={styles.useCaseGrid}>
              {content.useCases.cards.map((useCase) => (
                <article className={styles.useCaseCard} key={useCase.title}>
                  <p>{useCase.eyebrow}</p>
                  <h3>{useCase.title}</h3>
                  <span>{useCase.description}</span>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.lifecycleSection}>
          <div className={styles.sectionShell}>
            <SectionHeading eyebrow={content.lifecycle.eyebrow} title={content.lifecycle.title} />
            <div className={styles.lifecycleGrid}>
              {content.lifecycle.steps.map((step) => (
                <article className={styles.lifecycleStep} key={step.number}>
                  <span>{step.number}</span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.productionSection}>
          <div className={styles.sectionShell}>
            <div className={styles.productionGrid}>
              <div className={styles.productionCopy}>
                <SectionHeading
                  eyebrow={content.production.eyebrow}
                  title={content.production.title}
                  description={content.production.description}
                />
                <ul>
                  {content.production.capabilities.map((capability) => (
                    <li key={capability}>
                      <i />
                      {capability}
                    </li>
                  ))}
                </ul>
                <p className={styles.responsibilityNote}>{content.production.responsibilityNote}</p>
                <ActionLink to={content.production.action.to} variant="text">
                  {content.production.action.label} <Arrow />
                </ActionLink>
              </div>
              <div className={styles.runtimeCard}>
                <div className={styles.runtimeTopbar}>
                  <span>{content.production.runtimeLabel}</span>
                  <i />
                </div>
                <div className={styles.runtimeBody}>
                  <p>{content.production.commandLabel}</p>
                  <pre>
                    <code>{content.production.command}</code>
                  </pre>
                  <div className={styles.runtimeSignals}>
                    {content.production.runtimeSignals.map((signal) => (
                      <span key={signal}>
                        <i /> {signal}
                      </span>
                    ))}
                  </div>
                </div>
                <div className={styles.runtimeFooter}>
                  {content.production.runtimeSurfaces.map((surface) => (
                    <span key={surface}>{surface}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.closingSection}>
          <div className={styles.closingGlow} aria-hidden="true" />
          <div className={styles.closingContent}>
            <p className={styles.eyebrow}>{content.closing.eyebrow}</p>
            <h2>{content.closing.title}</h2>
            <p>{content.closing.description}</p>
            <div className={styles.heroActions}>
              <ActionLink to={content.closing.primaryAction.to}>
                {content.closing.primaryAction.label} <Arrow />
              </ActionLink>
              <ActionLink to={content.closing.secondaryAction.to} variant="secondary">
                {content.closing.secondaryAction.label}
              </ActionLink>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
