import { type FC, type ReactNode, useEffect, useRef } from 'react';
import CrossIcon from 'majesticons/line/multiply-line.svg?react';
import type { AgentResponseTrace } from '@valerypopoff/rivet2-core';
import { css } from '@emotion/react';
import { createPortal } from 'react-dom';

const responseInspectorCss = css`
  position: fixed;
  inset: 0;
  z-index: 10020;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgb(7 10 15 / 72%);

  .rivet-agent-response-inspector {
    width: min(920px, 100%);
    max-height: min(820px, calc(100vh - 40px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--rivet-web-app-card-border, var(--grey-darkish));
    border-radius: 12px;
    background: var(--rivet-web-app-card-background, var(--grey-darker));
    color: var(--rivet-web-app-foreground, var(--foreground));
    box-shadow: 0 24px 70px rgb(0 0 0 / 45%);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 18px;
    border-bottom: 1px solid var(--rivet-web-app-card-border, var(--grey-darkish));
  }
  header div {
    display: grid;
    gap: 2px;
  }
  header span,
  .rivet-agent-response-inspector-unavailable p,
  .rivet-agent-response-inspector-metrics dt,
  .rivet-agent-response-inspector-timing,
  .rivet-agent-response-inspector-section article span,
  .rivet-agent-response-inspector-section p {
    color: var(--rivet-web-app-foreground-muted, var(--grey-light));
  }
  header span,
  .rivet-agent-response-inspector-metrics dt,
  .rivet-agent-response-inspector-timing {
    font-size: 12px;
  }
  header button {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    outline: none;
  }
  header button:hover,
  header button:focus-visible {
    background: var(--rivet-web-app-control-hover-background, var(--grey-dark));
  }
  header button:focus-visible {
    box-shadow: inset 0 0 0 1px var(--rivet-web-app-control-focus-border, var(--primary));
  }
  header svg {
    width: 20px;
    height: 20px;
  }
  .rivet-agent-response-inspector-body {
    display: grid;
    gap: 18px;
    min-height: 0;
    overflow: auto;
    padding: 20px;
  }
  .rivet-agent-response-inspector-unavailable {
    padding: 28px 18px;
  }
  .rivet-agent-response-inspector-unavailable p {
    margin-bottom: 0;
  }
  .rivet-agent-response-inspector-metric-group {
    display: grid;
    gap: 9px;
    min-width: 0;
  }
  .rivet-agent-response-inspector-group-heading {
    display: grid;
    gap: 3px;
  }
  .rivet-agent-response-inspector-group-heading h3 {
    margin: 0;
    font-size: 14px;
  }
  .rivet-agent-response-inspector-group-heading p {
    margin: 0;
    color: var(--rivet-web-app-foreground-muted, var(--grey-light));
    font-size: 12px;
    line-height: 1.45;
  }
  .rivet-agent-response-inspector-metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 10px;
    margin: 0;
    padding: 0;
    width: 100%;
  }
  .rivet-agent-response-inspector-metrics > div {
    min-width: 0;
    padding: 10px 12px;
    border-radius: 8px;
    background: color-mix(
      in srgb,
      var(--rivet-web-app-card-background, var(--grey-darker)) 92%,
      var(--rivet-web-app-foreground, var(--foreground)) 8%
    );
  }
  .rivet-agent-response-inspector-metrics dd {
    margin: 3px 0 0;
    font-weight: 600;
  }
  .rivet-agent-response-inspector-timing {
    display: grid;
    gap: 4px;
    margin: 0;
    padding: 0;
  }
  .rivet-agent-response-inspector-timing > div {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 8px;
  }
  .rivet-agent-response-inspector-timing dt {
    font-weight: 600;
  }
  .rivet-agent-response-inspector-timing dd {
    margin: 0;
  }
  .rivet-agent-response-inspector-section {
    border-top: 1px solid var(--rivet-web-app-card-border, var(--grey-darkish));
    padding: 12px 0;
  }
  .rivet-agent-response-inspector-section summary {
    cursor: pointer;
    font-weight: 600;
  }
  .rivet-agent-response-inspector-section article {
    display: grid;
    gap: 3px;
    padding: 10px 0;
  }
  .rivet-agent-response-inspector-section article + article {
    border-top: 1px solid var(--rivet-web-app-card-border, var(--grey-darkish));
  }
  .rivet-agent-response-inspector-section article span,
  .rivet-agent-response-inspector-section p {
    font-size: 13px;
  }
  @media (max-width: 560px) {
    padding: 10px;

    .rivet-agent-response-inspector {
      max-height: calc(100vh - 20px);
    }

    .rivet-agent-response-inspector-body {
      padding: 16px;
    }
  }
`;

export const AgentResponseInspector: FC<{
  trace?: AgentResponseTrace;
  onClose(): void;
  renderInPortal?: boolean;
}> = ({ trace, onClose, renderInPortal = false }) => {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const inspector = (
    <div
      css={responseInspectorCss}
      className="rivet-agent-response-inspector-backdrop"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        aria-label="Response inspector"
        aria-modal="true"
        className="rivet-agent-response-inspector"
        role="dialog"
      >
        <header>
          <div>
            <strong>Response inspector</strong>
            <span>Execution metadata only</span>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close response inspector"
            onClick={onClose}
            title="Close"
          >
            <CrossIcon aria-hidden="true" />
          </button>
        </header>
        {trace == null ? (
          <div className="rivet-agent-response-inspector-unavailable">
            <strong>Trace unavailable</strong>
            <p>This response was produced by an older host, a replay, or while response inspection was disabled.</p>
          </div>
        ) : (
          <div className="rivet-agent-response-inspector-body">
            <MetricGroup title="Execution">
              <Metric label="Status" value={trace.status} />
              <Metric label="Total duration" value={formatDuration(trace.durationMs)} />
              <Metric label="Model calls" value={String(trace.summary.modelCallCount)} />
              <Metric label="Tool calls" value={String(trace.summary.toolCallCount)} />
            </MetricGroup>
            <MetricGroup
              title="Recovery behavior"
              description="Provider request retries repeat a failed request. LLM profile fallbacks move to the next configured profile."
            >
              <Metric label="Provider request retries" value={String(trace.summary.retryCount)} />
              <Metric label="LLM profile fallbacks" value={String(trace.summary.fallbackCount)} />
            </MetricGroup>
            <MetricGroup title="Usage and cost">
              <Metric label="Input tokens" value={formatTokens(trace.summary.promptTokens)} />
              <Metric label="Output tokens" value={formatTokens(trace.summary.completionTokens)} />
              <Metric label="Cached input tokens" value={formatTokens(trace.summary.cachedTokens)} />
              <Metric label="Reasoning tokens" value={formatTokens(trace.summary.reasoningTokens)} />
              <Metric label="Model cost" value={formatCost(trace)} />
            </MetricGroup>
            {(trace.startedAt != null || trace.responseReadyAt != null || trace.backgroundWorkPending) && (
              <section className="rivet-agent-response-inspector-metric-group">
                <div className="rivet-agent-response-inspector-group-heading">
                  <h3>Timing</h3>
                </div>
                <dl className="rivet-agent-response-inspector-timing">
                  {trace.startedAt != null && (
                    <div>
                      <dt>Started</dt>
                      <dd>{formatTimestamp(trace.startedAt)}</dd>
                    </div>
                  )}
                  {trace.responseReadyAt != null && (
                    <div>
                      <dt>Response ready</dt>
                      <dd>{formatTimestamp(trace.responseReadyAt)}</dd>
                    </div>
                  )}
                  {trace.backgroundWorkPending && (
                    <div>
                      <dt>Async work</dt>
                      <dd>Still active when this response was delivered</dd>
                    </div>
                  )}
                </dl>
              </section>
            )}
            <TraceSection
              title="Model calls"
              omitted={trace.omittedModelCallCount}
              empty="No physical model calls recorded."
            >
              {trace.modelCalls.map((call) => (
                <article key={call.callId}>
                  <strong>
                    {call.provider} · {call.model}
                  </strong>
                  <span>
                    {call.outcome}
                    {call.profileIndex == null ? '' : ` · profile ${call.profileIndex + 1}`}
                    {' · '}round {(call.roundIndex ?? 0) + 1} · attempt {call.attemptIndex + 1}
                  </span>
                  <span>
                    {formatDuration(call.durationMs)} · {formatCallUsage(call.usage)} · {formatCallCost(call.pricing)}
                  </span>
                  {call.finishReason && <span>Finish reason: {call.finishReason}</span>}
                </article>
              ))}
            </TraceSection>
            <TraceSection title="Tool calls" omitted={trace.omittedToolCallCount} empty="No tool executions recorded.">
              {trace.toolCalls.map((call, index) => (
                <article key={`${call.toolCallId ?? call.toolName}-${index}`}>
                  <strong>{call.toolName}</strong>
                  <span>
                    {call.outcome} · {call.handlerKind}
                    {call.handlerName ? ` · ${call.handlerName}` : ''}
                  </span>
                  <span>{formatDuration(call.durationMs)}</span>
                </article>
              ))}
            </TraceSection>
          </div>
        )}
      </section>
    </div>
  );

  return renderInPortal && typeof document !== 'undefined' ? createPortal(inspector, document.body) : inspector;
};

const MetricGroup: FC<{ title: string; description?: string; children: ReactNode }> = ({
  title,
  description,
  children,
}) => (
  <section className="rivet-agent-response-inspector-metric-group">
    <div className="rivet-agent-response-inspector-group-heading">
      <h3>{title}</h3>
      {description && <p>{description}</p>}
    </div>
    <dl className="rivet-agent-response-inspector-metrics">{children}</dl>
  </section>
);

const Metric: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <dt>{label}</dt>
    <dd>{value}</dd>
  </div>
);

const TraceSection: FC<{ title: string; omitted: number; empty: string; children: ReactNode }> = ({
  title,
  omitted,
  empty,
  children,
}) => {
  const hasChildren = Array.isArray(children) ? children.length > 0 : children != null;
  return (
    <details className="rivet-agent-response-inspector-section" open>
      <summary>{title}</summary>
      <div>{hasChildren ? children : <p>{empty}</p>}</div>
      {omitted > 0 && <p>{omitted} additional rows omitted by the trace limit.</p>}
    </details>
  );
};

function formatDuration(value: number | undefined): string {
  return value == null ? 'Unavailable' : `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)} sec`;
}

function formatTokens(value: number | undefined): string {
  return value == null ? 'Not reported' : new Intl.NumberFormat().format(value);
}

function formatCallUsage(usage: AgentResponseTrace['modelCalls'][number]['usage']): string {
  if (usage == null) return 'usage not reported';
  const parts = [
    usage.promptTokens == null ? undefined : `${formatTokens(usage.promptTokens)} in`,
    usage.completionTokens == null ? undefined : `${formatTokens(usage.completionTokens)} out`,
    usage.cachedTokens == null ? undefined : `${formatTokens(usage.cachedTokens)} cached`,
    usage.reasoningTokens == null ? undefined : `${formatTokens(usage.reasoningTokens)} reasoning`,
  ].filter((part): part is string => part != null);
  return parts.length > 0 ? parts.join(', ') : 'usage not reported';
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

function formatCost(trace: AgentResponseTrace): string {
  if (trace.summary.costStatus === 'unknown') return 'Unknown';
  const value = `$${trace.summary.knownCostUsd.toFixed(6)}`;
  return trace.summary.costStatus === 'partial' ? `${value} (partial)` : value;
}

function formatCallCost(pricing: AgentResponseTrace['modelCalls'][number]['pricing']): string {
  return pricing.status === 'known' && pricing.costUsd != null ? `$${pricing.costUsd.toFixed(6)}` : 'cost unknown';
}
