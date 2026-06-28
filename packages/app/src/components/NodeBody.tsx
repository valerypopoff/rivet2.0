import clsx from 'clsx';
import { type FC, memo, useState } from 'react';
import {
  type HeightCache,
  shouldPreserveCachedNodeBodyHeight,
  useNodeBodyHeight,
} from '../hooks/useNodeBodyHeight';
import { useUnknownNodeComponentDescriptorFor } from '../hooks/useNodeTypes.js';
import {
  type ChartNode,
  type ColorizedNodeBodySpec,
  type MarkdownNodeBodySpec,
  type NodeBodySpec,
  type PlainNodeBodySpec,
  type NodeBody as RenderedNodeBody,
  type NodeId,
} from '@valerypopoff/rivet2-core';

import { useMarkdown } from '../hooks/useMarkdown';
import { match } from 'ts-pattern';
import styled from '@emotion/styled';
import ColorizedPreformattedText from './ColorizedPreformattedText';
import { useDependsOnPlugins } from '../hooks/useDependsOnPlugins';
import { useGetRivetUIContext } from '../hooks/useGetRivetUIContext';
import { useProjectNodeRegistry } from '../hooks/useProjectNodeRegistry';
import { useAsyncEffect } from 'use-async-effect';
import { handleError } from '../utils/errorHandling.js';

export const NodeBody: FC<{ heightCache: HeightCache; node: ChartNode; interactive?: boolean; suspended?: boolean }> = memo(
  ({ heightCache, node, interactive = true, suspended = false }) =>
    suspended ? (
      <SuspendedNodeBody heightCache={heightCache} node={node} />
    ) : (
      <ActiveNodeBody heightCache={heightCache} interactive={interactive} node={node} />
    ),
);

NodeBody.displayName = 'NodeBody';

const ActiveNodeBody: FC<{ heightCache: HeightCache; interactive: boolean; node: ChartNode }> = ({
  heightCache,
  interactive,
  node,
}) => {
  const { Body } = useUnknownNodeComponentDescriptorFor(node);
  useDependsOnPlugins();

  const body = Body ? <Body node={node} /> : <UnknownNodeBody heightCache={heightCache} node={node} />;
  const readOnlyAttributes = interactive
    ? {}
    : ({
        'aria-disabled': true,
        inert: true,
      } as Record<string, unknown>);

  return (
    <div
      {...readOnlyAttributes}
      className={clsx('node-body', { 'node-body-readonly': !interactive })}
    >
      {body}
    </div>
  );
};

const SuspendedNodeBody: FC<{ heightCache: HeightCache; node: ChartNode }> = ({ heightCache, node }) => {
  const height = heightCache.get(node.id);

  return (
    <div className="node-body">
      {height == null ? null : <div aria-hidden="true" style={{ height: `${height}px` }} />}
    </div>
  );
};

const UnknownNodeBodyWrapper = styled.div<{
  fontSize: number;
  fontFamily: 'monospace' | 'sans-serif';
}>`
  overflow: hidden;
  font-size: calc(${(props) => props.fontSize}px * var(--ui-font-scale, 1));
  font-family: ${(props) => (props.fontFamily === 'monospace' ? 'var(--font-family-monospace)' : 'var(--font-family)')};

  .node-body-markdown > :first-child {
    margin-top: 0;
  }

  .node-body-markdown > :last-child {
    margin-bottom: 0;
  }

  pre {
    margin: 0;
  }

  .node-body-colorized-wrap {
    max-width: 100%;
    min-width: 0;
    overflow-wrap: normal;
    white-space: pre-wrap;
    width: 100%;
    word-break: normal;
  }
`;

// Fixes flickering due to async rendering of node body by caching the last resolved body.
// `undefined` is cached too, because a known-empty body must not reserve stale height while remounting.
const previousResolvedBodyMap = new Map<NodeId, RenderedNodeBody | undefined>();

type UnknownNodeBodyState = {
  body: RenderedNodeBody | undefined;
  hasResolvedBody: boolean;
  pending: boolean;
};

const UnknownNodeBody: FC<{ heightCache: HeightCache; node: ChartNode }> = ({ heightCache, node }) => {
  const getUIContext = useGetRivetUIContext();
  const projectNodeRegistry = useProjectNodeRegistry();

  const hasCachedBodyResult = previousResolvedBodyMap.has(node.id);
  const [bodyState, setBodyState] = useState<UnknownNodeBodyState>(() => ({
    body: previousResolvedBodyMap.get(node.id),
    hasResolvedBody: hasCachedBodyResult,
    pending: true,
  }));
  const { body, hasResolvedBody, pending } = bodyState;
  const { ref, height } = useNodeBodyHeight(heightCache, node.id, {
    ready: body != null,
    preserveCachedHeight: shouldPreserveCachedNodeBodyHeight({
      hasBody: body != null,
      hasResolvedBody,
      pending,
    }),
  });

  useAsyncEffect(async () => {
    setBodyState((current) => ({
      body: current.body,
      hasResolvedBody: current.hasResolvedBody,
      pending: true,
    }));

    try {
      const impl = projectNodeRegistry.createDynamicImpl(node);
      const renderedBody = await impl.getBody(await getUIContext({ node }));

      setBodyState({
        body: renderedBody,
        hasResolvedBody: true,
        pending: false,
      });

      previousResolvedBodyMap.set(node.id, renderedBody);
    } catch (err) {
      handleError(err, 'Failed to load body for node', {
        metadata: {
          nodeId: node.id,
          nodeType: node.type,
        },
      });
    }
  }, [getUIContext, node, projectNodeRegistry]);

  const bodySpec: NodeBodySpec | NodeBodySpec[] | undefined =
    typeof body === 'string' ? { type: 'plain', text: body } : body;
  let allSpecs = bodySpec ? (Array.isArray(bodySpec) ? bodySpec : [bodySpec]) : [];

  allSpecs = allSpecs.map((spec) => {
    if (spec.type === 'plain' && spec.text.startsWith('!markdown')) {
      return { type: 'markdown', text: spec.text.replace(/^!markdown/, '') };
    }

    return spec;
  });

  const renderedSpecs = allSpecs.map((spec) => ({
    spec,
    rendered: match(spec)
      .with({ type: 'plain' }, (spec) => <PlainNodeBody {...spec} />)
      .with({ type: 'markdown' }, (spec) => <MarkdownNodeBody {...spec} />)
      .with({ type: 'colorized' }, (spec) => <ColorizedNodeBody {...spec} />)
      .exhaustive(),
  }));

  if (renderedSpecs.length === 0 && (!pending || height == null)) {
    return null;
  }

  return (
    <div ref={ref} style={{ height }}>
      {renderedSpecs.map(({ spec, rendered }, i) => (
        <UnknownNodeBodyWrapper key={i} fontFamily={spec.fontFamily ?? 'monospace'} fontSize={spec.fontSize ?? 12}>
          {rendered}
        </UnknownNodeBodyWrapper>
      ))}
    </div>
  );
};

export const PlainNodeBody: FC<PlainNodeBodySpec> = memo(({ text }) => {
  return <pre className="pre-wrap">{text}</pre>;
});

PlainNodeBody.displayName = 'PlainNodeBody';

export const MarkdownNodeBody: FC<MarkdownNodeBodySpec> = memo(({ text, disableLinks }) => {
  const markdownBody = useMarkdown(text, true, { disableLinks });

  return <div className="pre-wrap node-body-markdown" dangerouslySetInnerHTML={markdownBody} />;
});

MarkdownNodeBody.displayName = 'MarkdownNodeBody';

function shouldWrapColorizedNodeBody(language: string): boolean {
  return language === 'prompt-interpolation-markdown';
}

export const ColorizedNodeBody: FC<ColorizedNodeBodySpec> = memo(({ text, language, theme }) => {
  const wrapWords = shouldWrapColorizedNodeBody(language);

  return (
    <ColorizedPreformattedText
      text={text}
      language={language}
      theme={theme}
      className={wrapWords ? 'node-body-colorized-wrap' : undefined}
      wrapWords={wrapWords}
    />
  );
});

ColorizedNodeBody.displayName = 'ColorizedNodeBody';
