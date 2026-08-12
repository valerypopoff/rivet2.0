import { type FC } from 'react';
import { helpModalOpenState } from '../state/ui';
import Modal, { ModalTransition, ModalBody, ModalFooter } from '@atlaskit/modal-dialog';
import Button from '@atlaskit/button';
import GithubIcon from '../assets/vendor_logos/github-mark-white.svg?react';
import QuestionIcon from 'majesticons/line/question-circle-line.svg?react';
import { css } from '@emotion/react';
import { useAtom } from 'jotai';
import { AppModalHeader } from './AppModalHeader';
import { USER_GUIDE_URL } from '../utils/documentationUrls.js';

const styles = css`
  ul li a,
  h2 a {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--ui-font-size-lg);

    svg {
      color: white;
    }

    img {
      height: 14px;
      object-fit: contain;
    }
  }
`;

export const HelpModal: FC = () => {
  const [helpModalOpen, setHelpModalOpen] = useAtom(helpModalOpenState);

  return (
    <ModalTransition>
      {helpModalOpen && (
        <Modal onClose={() => setHelpModalOpen(false)}>
          <AppModalHeader title="Help" />
          <ModalBody>
            <div css={styles}>
              <p>Need help with Rivet 2? Check out the following places.</p>

              <h2>
                <a href={USER_GUIDE_URL} target="_blank" rel="noreferrer">
                  <QuestionIcon /> Rivet 2 documentation
                </a>
              </h2>
              <p>Read the user guide, tutorial, API reference, node reference, and CLI documentation.</p>
              <h2>
                <a href="https://github.com/valerypopoff/rivet2.0/issues" target="_blank" rel="noreferrer">
                  <GithubIcon viewBox="0 0 100 100" /> GitHub issues
                </a>
              </h2>
              <p>Need to report a bug? Open an issue on GitHub to let us know!</p>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button appearance="primary" autoFocus onClick={() => setHelpModalOpen(false)}>
              Close
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </ModalTransition>
  );
};
