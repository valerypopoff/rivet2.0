import CopyIcon from '@atlaskit/icon/glyph/copy';
import ModalDialog, { ModalBody, ModalHeader, ModalTitle, ModalTransition } from '@atlaskit/modal-dialog';
import { useEffect, useRef, useState, type FC } from 'react';
import type { HostedRouteConfig, WorkflowProjectItem } from './types';
import { getPublishedItems } from './publishedItems';
import { SegmentedControl, SegmentedControlButton } from './SegmentedControl';
import './PublishedItemsModal.css';

async function copyTextToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) {
      throw new Error('Clipboard access was denied.');
    }
  }
}

export const PublishedItemsModal: FC<{
  isOpen: boolean;
  onClose(): void;
  onOpenProject(project: WorkflowProjectItem): void;
  projects: readonly WorkflowProjectItem[];
  routeConfig: HostedRouteConfig;
}> = ({ isOpen, onClose, onOpenProject, projects, routeConfig }) => {
  if (!isOpen) {
    return null;
  }

  return (
    <OpenPublishedItemsModal
      onClose={onClose}
      onOpenProject={onOpenProject}
      projects={projects}
      routeConfig={routeConfig}
    />
  );
};

const OpenPublishedItemsModal: FC<{
  onClose(): void;
  onOpenProject(project: WorkflowProjectItem): void;
  projects: readonly WorkflowProjectItem[];
  routeConfig: HostedRouteConfig;
}> = ({ onClose, onOpenProject, projects, routeConfig }) => {
  const [activeKind, setActiveKind] = useState<'endpoint' | 'web-app'>('endpoint');
  const [copyResult, setCopyResult] = useState<{ itemId: string; outcome: 'copied' | 'failed' } | null>(null);
  const copiedResetTimeoutRef = useRef<number | null>(null);

  const items = getPublishedItems(projects, routeConfig);
  const endpointItems = items.filter((item) => item.kind === 'endpoint');
  const webAppItems = items.filter((item) => item.kind === 'web-app');
  const visibleItems = activeKind === 'endpoint' ? endpointItems : webAppItems;

  useEffect(
    () => () => {
      if (copiedResetTimeoutRef.current != null) {
        window.clearTimeout(copiedResetTimeoutRef.current);
      }
    },
    [],
  );

  const copyRoute = async (itemId: string, route: string) => {
    try {
      await copyTextToClipboard(new URL(route, window.location.origin).toString());
      setCopyResult({ itemId, outcome: 'copied' });
    } catch {
      setCopyResult({ itemId, outcome: 'failed' });
    }
    if (copiedResetTimeoutRef.current != null) {
      window.clearTimeout(copiedResetTimeoutRef.current);
    }
    copiedResetTimeoutRef.current = window.setTimeout(() => {
      copiedResetTimeoutRef.current = null;
      setCopyResult(null);
    }, 1500);
  };

  return (
    <ModalTransition>
      <ModalDialog
        testId="published-items-modal"
        width="large"
        label="Published endpoints and apps"
        onClose={onClose}
        shouldScrollInViewport={false}
      >
        <ModalHeader>
          <div className="published-items-header">
            <div className="published-items-header-content">
              <ModalTitle>Published</ModalTitle>
              <div className="published-items-help">
                Endpoints and web apps currently published by this Rivet server.
              </div>
              <SegmentedControl className="published-items-tabs" label="Published item type" role="tablist">
                <SegmentedControlButton
                  id="published-items-endpoints-tab"
                  selected={activeKind === 'endpoint'}
                  role="tab"
                  aria-controls="published-items-panel"
                  aria-selected={activeKind === 'endpoint'}
                  onClick={() => setActiveKind('endpoint')}
                >
                  Endpoints ({endpointItems.length})
                </SegmentedControlButton>
                <SegmentedControlButton
                  id="published-items-web-apps-tab"
                  selected={activeKind === 'web-app'}
                  role="tab"
                  aria-controls="published-items-panel"
                  aria-selected={activeKind === 'web-app'}
                  onClick={() => setActiveKind('web-app')}
                >
                  Web apps ({webAppItems.length})
                </SegmentedControlButton>
              </SegmentedControl>
            </div>
            <button
              type="button"
              className="published-items-close-button"
              onClick={onClose}
              aria-label="Close published items"
            >
              {'\u00d7'}
            </button>
          </div>
        </ModalHeader>
        <ModalBody>
          <div className="published-items-content">
            {visibleItems.length === 0 ? (
              <div
                id="published-items-panel"
                className="published-items-empty"
                role="tabpanel"
                aria-labelledby={activeKind === 'endpoint'
                  ? 'published-items-endpoints-tab'
                  : 'published-items-web-apps-tab'}
              >
                No {activeKind === 'endpoint' ? 'endpoints' : 'web apps'} are currently published.
              </div>
            ) : (
              <div
                id="published-items-panel"
                className="published-items-list"
                role="tabpanel"
                aria-labelledby={activeKind === 'endpoint'
                  ? 'published-items-endpoints-tab'
                  : 'published-items-web-apps-tab'}
              >
                {visibleItems.map((item) => (
                  <article className="published-item" key={item.id}>
                    <div className="published-item-main">
                      <div className="published-item-details">
                        <span className="published-item-name">{item.label}</span>
                        <button
                          type="button"
                          className="published-item-project-link"
                          onClick={() => onOpenProject(item.project)}
                          title={`Open ${item.project.name}`}
                        >
                          <span className="published-item-project-label">Project:</span>{' '}
                          <span className="published-item-project-name">{item.project.name}</span>
                        </button>
                        <span className={`published-item-status published-item-status-${item.status}`}>
                          {item.status === 'published' ? 'Published' : 'Unpublished changes'}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="published-item-route"
                      onClick={() => void copyRoute(item.id, item.route)}
                      title={`Copy ${item.route}`}
                      aria-label={`Copy ${item.route}`}
                      aria-live="polite"
                    >
                      <span className="published-item-route-copy-icon" aria-hidden="true">
                        <CopyIcon label="" size="small" />
                      </span>
                      <span className="published-item-route-label">
                        {copyResult?.itemId === item.id
                          ? `${copyResult.outcome === 'copied' ? 'Copied' : 'Copy failed'}: ${item.route}`
                          : item.route}
                      </span>
                    </button>
                  </article>
                ))}
              </div>
            )}
          </div>
        </ModalBody>
      </ModalDialog>
    </ModalTransition>
  );
};
