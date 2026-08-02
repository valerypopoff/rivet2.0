import React, { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import useBaseUrl from '@docusaurus/useBaseUrl';
import {
  homepageContent,
  type HomepageContextualDemo,
  type HomepageDemo,
  type HomepageDemoId,
} from '../content/homepageContent';
import styles from './index.module.css';

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

function RivetNodeRunningIndicator() {
  return <span aria-hidden="true" className={styles.liveDemoRunningIndicator} />;
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

type RivetDemoMessage =
  | { type: 'rivet-demo:error'; message?: unknown }
  | { type: 'rivet-demo:ready' }
  | { type: 'rivet-demo:release' };

type RivetDemoRequest = { type: 'rivet-demo:status-request' };

const RIVET_DEMO_STARTUP_TIMEOUT_MS = 30_000;

function isRivetDemoMessage(value: unknown): value is RivetDemoMessage {
  if (typeof value !== 'object' || value == null || !('type' in value)) {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  return type === 'rivet-demo:error' || type === 'rivet-demo:ready' || type === 'rivet-demo:release';
}

function RivetDemoWindow({
  demo,
  expanded,
  onCollapse,
  onExpand,
  url,
}: {
  demo: HomepageDemo;
  expanded: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  url: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string>();
  const [instance, setInstance] = useState(0);
  const [ready, setReady] = useState(false);
  const loadingLogoUrl = useBaseUrl('/img/logo.svg');
  const targetOrigin = typeof window === 'undefined' ? undefined : new URL(url, window.location.href).origin;

  const requestDemoStatus = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'rivet-demo:status-request' } satisfies RivetDemoRequest,
      targetOrigin ?? '*',
    );
  }, [targetOrigin]);

  const collapse = useCallback(() => {
    setActive(false);
    onCollapse();
    requestAnimationFrame(() => expandButtonRef.current?.focus());
  }, [onCollapse]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (
        event.source !== iframeRef.current?.contentWindow ||
        (targetOrigin && event.origin !== targetOrigin) ||
        !isRivetDemoMessage(event.data)
      ) {
        return;
      }

      if (event.data.type === 'rivet-demo:ready') {
        setReady(true);
        setError(undefined);
      } else if (event.data.type === 'rivet-demo:release') {
        if (expanded) {
          collapse();
        } else {
          setActive(false);
        }
        window.focus();
      } else {
        setActive(false);
        setReady(false);
        setError(typeof event.data.message === 'string' ? event.data.message : 'The embedded demo could not start.');
      }
    };

    window.addEventListener('message', handleMessage);
    requestDemoStatus();
    return () => window.removeEventListener('message', handleMessage);
  }, [collapse, expanded, requestDemoStatus, targetOrigin]);

  useEffect(() => {
    if (ready || error) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setActive(false);
      setError('Rivet did not finish opening this demo. Check that the demo server is running, then retry.');
    }, RIVET_DEMO_STARTUP_TIMEOUT_MS);

    return () => window.clearTimeout(timeout);
  }, [error, instance, ready, url]);

  useEffect(() => {
    if (!expanded) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        collapse();
        return;
      }

      if (event.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), select:not([disabled]), iframe, [href], [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((element) => element.getClientRects().length > 0);
        if (focusable.length === 0) {
          event.preventDefault();
          dialogRef.current.focus();
          return;
        }

        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => dialogRef.current?.focus());
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [collapse, expanded]);

  const reset = () => {
    setActive(false);
    setError(undefined);
    setReady(false);
    setInstance((current) => current + 1);
  };

  const expand = () => {
    setActive(true);
    onExpand();
    requestAnimationFrame(() => iframeRef.current?.focus());
  };

  return (
    <>
      {expanded ? <div aria-hidden="true" className={styles.liveDemoBackdrop} onMouseDown={collapse} /> : null}
      <div
        ref={dialogRef}
        aria-label={`${demo.title} — live Rivet 2 demo`}
        aria-modal={expanded || undefined}
        className={`${styles.liveDemo} ${active ? styles.liveDemoActive : ''} ${expanded ? styles.liveDemoExpanded : ''}`}
        role={expanded ? 'dialog' : 'region'}
        tabIndex={-1}
      >
        <div className={styles.liveDemoToolbar}>
          <div className={styles.liveDemoIntroduction}>
            <span
              aria-live="polite"
              className={`${styles.liveDemoState} ${!ready && !error ? styles.liveDemoStateLoading : ''} ${error ? styles.liveDemoStateError : ''}`}
            >
              <i />
              {error ? 'Live demo unavailable' : ready ? 'Live Rivet 2 editor' : 'Loading Rivet 2 editor'}
            </span>
            <span>{demo.instruction}</span>
          </div>
          <div className={styles.liveDemoActions}>
            <button type="button" onClick={reset}>
              Reset
            </button>
            <button
              ref={expandButtonRef}
              type="button"
              disabled={!ready || Boolean(error)}
              onClick={expanded ? collapse : expand}
            >
              {expanded ? (
                'Close large popup'
              ) : (
                <>
                  Open large popup <Arrow />
                </>
              )}
            </button>
          </div>
        </div>
        <div className={styles.liveDemoViewport}>
          <iframe
            key={instance}
            ref={iframeRef}
            className={styles.liveDemoIframe}
            src={url}
            title={`${demo.title} — interactive Rivet 2 editor`}
            loading="eager"
            sandbox="allow-same-origin allow-scripts"
            onLoad={requestDemoStatus}
          />
          {!ready && !error ? (
            <div aria-label="Loading Rivet 2 editor" className={styles.liveDemoLoading} role="status">
              <img alt="" src={loadingLogoUrl} />
              <RivetNodeRunningIndicator />
            </div>
          ) : error ? (
            <div className={styles.liveDemoError} role="alert">
              <img alt="" src={loadingLogoUrl} />
              <strong>Rivet could not open this demo</strong>
              <span>{error}</span>
              <button type="button" onClick={reset}>
                Retry
              </button>
            </div>
          ) : !active ? (
            <button
              className={styles.liveDemoActivation}
              type="button"
              onClick={() => {
                setActive(true);
                iframeRef.current?.focus();
              }}
            >
              <strong>Click to explore this project</strong>
              <span>
                The frame activates on click so it does not capture page scrolling. Press Escape to release it.
              </span>
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

type DemoShowcaseId = 'hero' | 'foundations' | 'use-cases';
type DemoPickerVariant = 'hero' | 'contextual';

function RivetDemoShowcase({
  demoBaseUrl,
  demos,
  expanded,
  onCollapse,
  onExpand,
  pickerVariant,
}: {
  demoBaseUrl: string;
  demos: readonly (HomepageDemo | HomepageContextualDemo)[];
  expanded: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  pickerVariant: DemoPickerVariant;
}) {
  const idPrefix = useId();
  const [selectedDemoId, setSelectedDemoId] = useState<HomepageDemoId>(demos[0]!.demoId);
  const selectedDemo = demos.find((demo) => demo.demoId === selectedDemoId) ?? demos[0]!;
  const panelId = `${idPrefix}-panel`;
  const selectedTabId = `${idPrefix}-${selectedDemo.demoId}-tab`;

  const selectDemo = (demoId: HomepageDemoId) => {
    if (demoId !== selectedDemoId) {
      setSelectedDemoId(demoId);
    }
  };

  const moveSelection = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % demos.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + demos.length) % demos.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = demos.length - 1;
    }

    if (nextIndex == null) {
      return;
    }

    event.preventDefault();
    const nextDemo = demos[nextIndex]!;
    selectDemo(nextDemo.demoId);
    document.getElementById(`${idPrefix}-${nextDemo.demoId}-tab`)?.focus();
  };

  return (
    <div className={styles.demoShowcase}>
      <div
        aria-label="Choose the Rivet project shown below"
        className={pickerVariant === 'hero' ? styles.heroFeatureList : styles.contextualDemoList}
        role="tablist"
      >
        {demos.map((demo, index) => {
          const selected = demo.demoId === selectedDemo.demoId;
          const contextualDemo = 'eyebrow' in demo ? demo : undefined;
          return (
            <button
              aria-controls={panelId}
              aria-selected={selected}
              className={`${pickerVariant === 'hero' ? styles.heroFeature : styles.contextualDemoOption} ${selected ? styles.demoOptionSelected : ''}`}
              id={`${idPrefix}-${demo.demoId}-tab`}
              key={demo.demoId}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
              onClick={() => selectDemo(demo.demoId)}
              onKeyDown={(event) => moveSelection(event, index)}
            >
              {contextualDemo ? <span className={styles.contextualDemoEyebrow}>{contextualDemo.eyebrow}</span> : null}
              <strong>{demo.title}</strong>
              <span>{demo.description}</span>
              {selected ? <i className={styles.selectedDemoIndicator}>Selected demo</i> : null}
            </button>
          );
        })}
      </div>

      <div aria-labelledby={selectedTabId} id={panelId} role="tabpanel">
        <RivetDemoWindow
          key={selectedDemo.demoId}
          demo={selectedDemo}
          expanded={expanded}
          onCollapse={onCollapse}
          onExpand={onExpand}
          url={getDemoUrl(demoBaseUrl, selectedDemo.demoId)}
        />
      </div>
    </div>
  );
}

function getDemoUrl(baseUrl: string, demoId: HomepageDemoId): string {
  const hashIndex = baseUrl.indexOf('#');
  const hash = hashIndex === -1 ? '' : baseUrl.slice(hashIndex);
  const urlWithoutHash = hashIndex === -1 ? baseUrl : baseUrl.slice(0, hashIndex);
  const queryIndex = urlWithoutHash.indexOf('?');
  const path = queryIndex === -1 ? urlWithoutHash : urlWithoutHash.slice(0, queryIndex);
  const searchParams = new URLSearchParams(queryIndex === -1 ? '' : urlWithoutHash.slice(queryIndex + 1));
  searchParams.set('project', demoId);
  return `${path}?${searchParams.toString()}${hash}`;
}

type UseCaseIconName = (typeof homepageContent)['useCases']['cards'][number]['icon'];

function UseCaseIcon({ name }: { name: UseCaseIconName }) {
  const paths: Record<UseCaseIconName, ReactNode> = {
    agent: (
      <>
        <circle cx="7" cy="16" r="3" />
        <circle cx="24" cy="8" r="3" />
        <circle cx="24" cy="24" r="3" />
        <path d="M10 16h5m0 0 6-6m-6 6 6 6" />
      </>
    ),
    knowledge: (
      <>
        <ellipse cx="13" cy="8" rx="8" ry="4" />
        <path d="M5 8v8c0 2.2 3.6 4 8 4 1.2 0 2.3-.1 3.3-.4M5 12c0 2.2 3.6 4 8 4" />
        <circle cx="22" cy="21" r="4" />
        <path d="m25 24 3 3" />
      </>
    ),
    prompt: (
      <>
        <path d="m9 7-5 9 5 9M23 7l5 9-5 9M13 11h7M12 16h8M13 21h7" />
      </>
    ),
    'web-app': (
      <>
        <rect x="4" y="5" width="24" height="22" rx="3" />
        <path d="M4 11h24M8 8h.1M12 8h.1M16 8h.1M10 16h12M10 21h8" />
      </>
    ),
    evaluation: (
      <>
        <rect x="6" y="4" width="20" height="24" rx="3" />
        <path d="m10 11 2 2 4-4M18 11h4m-12 8 2 2 4-4M18 19h4" />
      </>
    ),
    automation: (
      <>
        <circle cx="7" cy="8" r="3" />
        <circle cx="25" cy="24" r="3" />
        <path d="M10 8h5a4 4 0 0 1 4 4v8a4 4 0 0 0 4 4M13 18l3-3 3 3" />
      </>
    ),
  };

  return (
    <svg className={styles.useCaseIcon} viewBox="0 0 32 32" aria-hidden="true">
      {paths[name]}
    </svg>
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
  const [expandedShowcaseId, setExpandedShowcaseId] = useState<DemoShowcaseId | null>(null);
  const { siteConfig } = useDocusaurusContext();
  const builtDemoUrl = useBaseUrl('/rivet-demo/');
  const configuredDemoUrl = siteConfig.customFields?.promoDemoUrl;
  const demoBaseUrl = typeof configuredDemoUrl === 'string' && configuredDemoUrl ? configuredDemoUrl : builtDemoUrl;

  return (
    <Layout description={content.meta.description}>
      <Head>
        <title>{content.meta.title}</title>
        <meta property="og:title" content={content.meta.title} />
        <meta property="og:description" content={content.meta.description} />
      </Head>
      <main className={styles.landing}>
        <section className={`${styles.hero} ${expandedShowcaseId === 'hero' ? styles.sectionWithExpandedDemo : ''}`}>
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
              <RivetDemoShowcase
                demoBaseUrl={demoBaseUrl}
                demos={content.hero.features}
                expanded={expandedShowcaseId === 'hero'}
                onCollapse={() => setExpandedShowcaseId(null)}
                onExpand={() => setExpandedShowcaseId('hero')}
                pickerVariant="hero"
              />
            </div>
          </div>
        </section>

        <section
          className={`${styles.foundationSection} ${expandedShowcaseId === 'foundations' ? styles.sectionWithExpandedDemo : ''}`}
        >
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
            <RivetDemoShowcase
              demoBaseUrl={demoBaseUrl}
              demos={[content.foundationsDemo]}
              expanded={expandedShowcaseId === 'foundations'}
              onCollapse={() => setExpandedShowcaseId(null)}
              onExpand={() => setExpandedShowcaseId('foundations')}
              pickerVariant="contextual"
            />
          </div>
        </section>

        <section
          className={`${styles.useCasesSection} ${expandedShowcaseId === 'use-cases' ? styles.sectionWithExpandedDemo : ''}`}
        >
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
                  <UseCaseIcon name={useCase.icon} />
                  <p>{useCase.eyebrow}</p>
                  <h3>{useCase.title}</h3>
                  <span>{useCase.description}</span>
                </article>
              ))}
            </div>
            <RivetDemoShowcase
              demoBaseUrl={demoBaseUrl}
              demos={[content.useCasesDemo]}
              expanded={expandedShowcaseId === 'use-cases'}
              onCollapse={() => setExpandedShowcaseId(null)}
              onExpand={() => setExpandedShowcaseId('use-cases')}
              pickerVariant="contextual"
            />
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

        <section className={styles.wrapperSection}>
          <div className={styles.sectionShell}>
            <div className={styles.wrapperGrid}>
              <div className={styles.wrapperCard}>
                <div className={styles.wrapperTopbar}>
                  <span>{content.wrapper.serverLabel}</span>
                  <i />
                </div>
                <div className={styles.wrapperBody}>
                  <strong>{content.wrapper.deploymentLabel}</strong>
                  <div className={styles.wrapperServices}>
                    {content.wrapper.services.map(([label, description]) => (
                      <div key={label}>
                        <i />
                        <span>
                          <b>{label}</b>
                          {description}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className={styles.runtimeFooter}>
                  {content.wrapper.runtimeSurfaces.map((surface) => (
                    <span key={surface}>{surface}</span>
                  ))}
                </div>
              </div>
              <div className={styles.wrapperCopy}>
                <SectionHeading
                  eyebrow={content.wrapper.eyebrow}
                  title={content.wrapper.title}
                  description={content.wrapper.description}
                />
                <ul>
                  {content.wrapper.capabilities.map((capability) => (
                    <li key={capability}>
                      <i />
                      {capability}
                    </li>
                  ))}
                </ul>
                <ActionLink to={content.wrapper.action.to} variant="text">
                  {content.wrapper.action.label} <Arrow />
                </ActionLink>
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
