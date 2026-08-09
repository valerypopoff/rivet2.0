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

function RivetNodeRunningIndicator() {
  return <span aria-hidden="true" className={styles.liveDemoRunningIndicator} />;
}

type DownloadPlatform = 'macos' | 'windows';

function detectDownloadPlatform(): DownloadPlatform {
  if (typeof navigator !== 'undefined' && /Macintosh|Mac OS X|iPhone|iPad/i.test(navigator.userAgent)) {
    return 'macos';
  }

  return 'windows';
}

function DownloadPlatformIcon({ platform }: { platform: DownloadPlatform }) {
  return platform === 'macos' ? (
    <svg aria-hidden="true" className={styles.actionIcon} viewBox="0 0 24 24">
      <path d="M16.7 12.7c0-2 1.6-3 1.7-3.1a3.7 3.7 0 0 0-2.9-1.6c-1.2-.1-2.4.7-3 .7-.7 0-1.7-.7-2.8-.7a3.9 3.9 0 0 0-3.3 2c-1.4 2.4-.4 5.9 1 7.9.7 1 1.5 2.1 2.5 2.1 1 0 1.4-.6 2.7-.6s1.6.6 2.7.6c1.1 0 1.8-1 2.5-2 .8-1.1 1.1-2.2 1.1-2.3-.1 0-2.1-.8-2.1-3Zm-2-6a3.5 3.5 0 0 0 .8-2.6 3.6 3.6 0 0 0-2.4 1.2 3.3 3.3 0 0 0-.9 2.5c1 .1 1.9-.5 2.5-1.1Z" />
    </svg>
  ) : (
    <svg aria-hidden="true" className={styles.actionIcon} viewBox="0 0 24 24">
      <path d="m3 4.2 7.4-1v7.2H3V4.2Zm8.5-1.2 9.5-1.3v8.7h-9.5V3Zm-8.5 8.5h7.4v7.3L3 17.8v-6.3Zm8.5 0H21v8.8l-9.5-1.3v-7.5Z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg aria-hidden="true" className={styles.actionIcon} viewBox="0 0 24 24">
      <path d="M12 2.2a9.8 9.8 0 0 0-3.1 19.1c.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.6 1.1 1.6 1.1.9 1.5 2.4 1.1 3 .9.1-.7.4-1.1.6-1.3-2.3-.3-4.7-1.1-4.7-5.1 0-1.1.4-2.1 1.1-2.8-.1-.3-.5-1.3.1-2.8 0 0 .9-.3 2.9 1.1a10.2 10.2 0 0 1 5.3 0c2-1.4 2.9-1.1 2.9-1.1.6 1.5.2 2.5.1 2.8.7.7 1.1 1.7 1.1 2.8 0 4-2.4 4.8-4.7 5.1.4.3.7.9.7 1.8v2.7c0 .3.2.6.7.5A9.8 9.8 0 0 0 12 2.2Z" />
    </svg>
  );
}

function DownloadAction({ label, to }: { label: string; to: string }) {
  const [platform, setPlatform] = useState<DownloadPlatform>('windows');

  useEffect(() => {
    setPlatform(detectDownloadPlatform());
  }, []);

  return (
    <ActionLink to={to}>
      <DownloadPlatformIcon platform={platform} />
      {label}
    </ActionLink>
  );
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
      <span className={styles.headingGlow} aria-hidden="true" />
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

type RivetDemoRequest =
  | { type: 'rivet-demo:status-request' }
  | { type: 'rivet-demo:interaction-state'; active: boolean };

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

  const setDemoInteractionActive = useCallback(
    (nextActive: boolean) => {
      setActive(nextActive);
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'rivet-demo:interaction-state', active: nextActive } satisfies RivetDemoRequest,
        targetOrigin ?? '*',
      );
    },
    [targetOrigin],
  );

  const collapse = useCallback(() => {
    setDemoInteractionActive(false);
    onCollapse();
    requestAnimationFrame(() => expandButtonRef.current?.focus());
  }, [onCollapse, setDemoInteractionActive]);

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
          setDemoInteractionActive(false);
        }
        window.focus();
      } else {
        setDemoInteractionActive(false);
        setReady(false);
        setError(typeof event.data.message === 'string' ? event.data.message : 'The embedded demo could not start.');
      }
    };

    window.addEventListener('message', handleMessage);
    requestDemoStatus();
    return () => window.removeEventListener('message', handleMessage);
  }, [collapse, expanded, requestDemoStatus, setDemoInteractionActive, targetOrigin]);

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
    setDemoInteractionActive(false);
    setError(undefined);
    setReady(false);
    setInstance((current) => current + 1);
  };

  const expand = () => {
    setDemoInteractionActive(true);
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
              {expanded ? 'Close large popup' : 'Open large popup'}
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
            sandbox="allow-same-origin allow-scripts allow-popups"
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
                setDemoInteractionActive(true);
                iframeRef.current?.focus();
              }}
            >
              <strong>Click to explore this project</strong>
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

type DemoShowcaseId = 'hero' | 'foundations';
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
  const hasDemoChoice = demos.length > 1;
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
        aria-label={hasDemoChoice ? 'Choose the Rivet project shown below' : 'Rivet project shown below'}
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
        <svg className={styles.landingAtmosphereFilters} aria-hidden="true" focusable="false">
          <defs>
            <filter id="landing-cloud-hero" x="-30%" y="-40%" width="160%" height="180%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.009 0.014"
                numOctaves="4"
                seed="17"
                result="cloudNoise"
              />
              <feDisplacementMap
                in="SourceGraphic"
                in2="cloudNoise"
                scale="118"
                xChannelSelector="R"
                yChannelSelector="B"
                result="displacedCloud"
              />
              <feColorMatrix in="cloudNoise" type="luminanceToAlpha" result="cloudOpacity" />
              <feComponentTransfer in="cloudOpacity" result="shapedCloudOpacity">
                <feFuncA type="table" tableValues="0.28 0.42 0.6 0.78 0.94" />
              </feComponentTransfer>
              <feComposite in="displacedCloud" in2="shapedCloudOpacity" operator="in" result="texturedCloud" />
              <feGaussianBlur in="texturedCloud" stdDeviation="36" />
            </filter>
            <filter id="landing-cloud-closing" x="-30%" y="-40%" width="160%" height="180%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.012 0.008"
                numOctaves="4"
                seed="31"
                result="cloudNoise"
              />
              <feDisplacementMap
                in="SourceGraphic"
                in2="cloudNoise"
                scale="94"
                xChannelSelector="G"
                yChannelSelector="R"
                result="displacedCloud"
              />
              <feColorMatrix in="cloudNoise" type="luminanceToAlpha" result="cloudOpacity" />
              <feComponentTransfer in="cloudOpacity" result="shapedCloudOpacity">
                <feFuncA type="table" tableValues="0.3 0.46 0.63 0.8 0.95" />
              </feComponentTransfer>
              <feComposite in="displacedCloud" in2="shapedCloudOpacity" operator="in" result="texturedCloud" />
              <feGaussianBlur in="texturedCloud" stdDeviation="32" />
            </filter>
            <filter id="landing-cloud-heading" x="-35%" y="-50%" width="170%" height="200%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.016 0.011"
                numOctaves="4"
                seed="43"
                result="cloudNoise"
              />
              <feDisplacementMap
                in="SourceGraphic"
                in2="cloudNoise"
                scale="72"
                xChannelSelector="B"
                yChannelSelector="G"
                result="displacedCloud"
              />
              <feColorMatrix in="cloudNoise" type="luminanceToAlpha" result="cloudOpacity" />
              <feComponentTransfer in="cloudOpacity" result="shapedCloudOpacity">
                <feFuncA type="table" tableValues="0.24 0.4 0.58 0.76 0.92" />
              </feComponentTransfer>
              <feComposite in="displacedCloud" in2="shapedCloudOpacity" operator="in" result="texturedCloud" />
              <feGaussianBlur in="texturedCloud" stdDeviation="24" />
            </filter>
          </defs>
        </svg>
        <section className={`${styles.hero} ${expandedShowcaseId === 'hero' ? styles.sectionWithExpandedDemo : ''}`}>
          <div className={styles.heroGrid}>
            <div className={styles.heroCopy}>
              <div className={styles.heroGlow} aria-hidden="true" />
              <p className={styles.heroEyebrow}>
                <span />
                {content.hero.eyebrow}
              </p>
              <h1>{content.hero.title}</h1>
              <p className={styles.heroDescription}>{content.hero.description}</p>
              <div className={styles.heroActions}>
                <DownloadAction label={content.hero.primaryAction.label} to={content.hero.primaryAction.to} />
                <ActionLink to={content.hero.secondaryAction.to} variant="secondary">
                  {content.hero.secondaryAction.label}
                </ActionLink>
                <ActionLink to={content.hero.sourceAction.to} variant="text">
                  <GitHubIcon />
                  {content.hero.sourceAction.label}
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
                  <UseCaseIcon name={useCase.icon} />
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

        <section className={styles.wrapperSection}>
          <div className={styles.sectionShell}>
            <SectionHeading
              eyebrow={content.wrapper.eyebrow}
              title={content.wrapper.title}
              description={content.wrapper.description}
            />
            <div className={styles.studioFactsGrid}>
              {content.wrapper.facts.map((fact) => (
                <article className={styles.studioFact} key={fact.number}>
                  <span>{fact.number}</span>
                  <h3>{fact.title}</h3>
                  <p>{fact.description}</p>
                </article>
              ))}
            </div>
            <ActionLink to={content.wrapper.action.to} variant="text">
              {content.wrapper.action.label}
            </ActionLink>
          </div>
        </section>

        <section className={styles.boundarySection}>
          <div className={styles.sectionShell}>
            <SectionHeading
              eyebrow={content.boundaries.eyebrow}
              title={content.boundaries.title}
              description={content.boundaries.description}
            />
            <div className={styles.boundaryGrid}>
              {content.boundaries.limitations.map((limitation) => (
                <article className={styles.boundaryCard} key={limitation.title}>
                  <h3>{limitation.title}</h3>
                  <p>{limitation.description}</p>
                </article>
              ))}
            </div>
            <aside className={styles.boundaryFit}>
              <span>{content.boundaries.fit.eyebrow}</span>
              <div>
                <h3>{content.boundaries.fit.title}</h3>
                <p>{content.boundaries.fit.description}</p>
              </div>
            </aside>
          </div>
        </section>

        <section className={styles.closingSection}>
          <div className={styles.closingContent}>
            <div className={styles.closingGlow} aria-hidden="true" />
            <p className={styles.eyebrow}>{content.closing.eyebrow}</p>
            <h2>{content.closing.title}</h2>
            <p>{content.closing.description}</p>
            <div className={styles.heroActions}>
              <ActionLink to={content.closing.primaryAction.to}>{content.closing.primaryAction.label}</ActionLink>
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
