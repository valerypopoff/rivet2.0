import { type FC } from 'react';
import Modal, { ModalBody, ModalTransition, ModalFooter } from '@atlaskit/modal-dialog';
import { useAtomValue, useSetAtom } from 'jotai';
import { viewingNodeChangesState } from '../state/graphBuilder';
import { useHistoricalNodeChangeInfo } from '../hooks/useHistoricalNodeChangeInfo';
import * as yaml from 'yaml';
import { diffStringsUnified } from 'jest-diff';
import { AppModalHeader } from './AppModalHeader';
import { escapeHtml, toSanitizedMarkdownHtml } from '../hooks/useMarkdown.js';
import { sanitizeMarkdownHtml } from '../utils/markdown/sanitizeMarkdownHtml.js';
import { css } from '@emotion/react';

const diffStyles = css`
  .rivet-yaml-diff-before {
    color: #e74c3c;
  }

  .rivet-yaml-diff-after {
    color: #00b74c;
  }
`;

export const NodeChangesModalRenderer: FC = () => {
  const changes = useAtomValue(viewingNodeChangesState);

  return <ModalTransition>{changes == null ? null : <NodeChangesModal />}</ModalTransition>;
};

export const NodeChangesModal: FC = () => {
  const nodeId = useAtomValue(viewingNodeChangesState);
  const changes = useHistoricalNodeChangeInfo(nodeId!);
  const setViewingNodeChanges = useSetAtom(viewingNodeChangesState);

  if (changes == null || changes.changed === false) {
    return null;
  }

  const beforeYaml = changes.before ? yaml.stringify(changes.before) : '';
  const afterYaml = changes.after ? yaml.stringify(changes.after!) : '';

  const yamlDiff = diffStringsUnified(beforeYaml, afterYaml, {
    contextLines: 5,
    expand: false,
    aAnnotation: 'Before',
    bAnnotation: 'After',
    aColor: (str) => `<span class="rivet-yaml-diff-before">${escapeHtml(str)}</span>`,
    bColor: (str) => `<span class="rivet-yaml-diff-after">${escapeHtml(str)}</span>`,
  });
  const safeYamlDiff = toSanitizedMarkdownHtml(sanitizeMarkdownHtml(yamlDiff));

  return (
    <Modal
      width="xlarge"
      autoFocus={false}
      onClose={() => {
        setViewingNodeChanges(undefined);
      }}
    >
      <AppModalHeader title="Node Changes" />
      <ModalBody>
        <div css={diffStyles}>
          <pre style={{ whiteSpace: 'pre-wrap' }} dangerouslySetInnerHTML={safeYamlDiff} />
        </div>
      </ModalBody>
      <ModalFooter />
    </Modal>
  );
};
