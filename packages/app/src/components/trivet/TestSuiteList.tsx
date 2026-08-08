import { css } from '@emotion/react';
import { type FC, type MouseEvent } from 'react';
import clsx from 'clsx';
import { useContextMenu } from '../../hooks/useContextMenu';
import { useStableCallback } from '../../hooks/useStableCallback';
import Portal from '@atlaskit/portal';
import { type TrivetTestSuite } from '@valerypopoff/trivet';
import Tabs, { Tab, TabList, TabPanel } from '@atlaskit/tabs';
import { PopupMenu, PopupMenuItem } from '../PopupMenu';
import { NodeRunningIndicator } from '../visualNode/NodeRunningIndicator';

const styles = css`
  min-height: 100%;
  border-right: 1px solid var(--grey);

  .test-suite-list {
    margin: 10px -10px;
    flex: 1 1 auto;
  }

  .test-suite-item {
    display: flex;
    flex-direction: row;
    align-items: center;
    padding: 4px 16px;
    margin-top: 8px;
    cursor: pointer;

    &:hover {
      background-color: var(--grey-darkish);
    }
  }

  .test-suite-item.selected {
    background-color: var(--primary);
    color: var(--foreground-on-primary);

    &:hover {
      background-color: var(--primary-dark);
    }
  }

  .test-suite-status {
    width: 20px;
    margin-right: 4px;
  }
`;

export type TestSuiteListProps = {
  testSuites: TrivetTestSuite[];
  selectedTestSuite: TrivetTestSuite | undefined;
  setSelectedTestSuite: (id: string) => void;
  createNewTestSuite: () => void;
  deleteTestSuite: (id: string) => void;
  runningTestSuiteId: string | undefined;
  runTestSuite: (id: string) => void;
};

export const TestSuiteList: FC<TestSuiteListProps> = ({
  testSuites,
  setSelectedTestSuite,
  selectedTestSuite,
  createNewTestSuite,
  deleteTestSuite,
  runningTestSuiteId,
  runTestSuite,
}) => {
  const { contextMenuRef, showContextMenu, contextMenuData, handleContextMenu } = useContextMenu();

  const handleSidebarContextMenu = useStableCallback((e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    handleContextMenu(e);
  });

  function handleNew() {
    createNewTestSuite();
  }

  function handleDelete(id: string | undefined) {
    id && deleteTestSuite(id);
  }

  const selectedTestSuiteIdForContextMenu = contextMenuData.data
    ? contextMenuData.data?.element.dataset.testsuiteid
    : undefined;

  return (
    <div
      css={styles}
      onContextMenu={handleSidebarContextMenu}
      data-contextmenutype="test-suite-list"
      ref={contextMenuRef}
    >
      <Tabs id="test-suite-tabs">
        <TabList>
          <Tab>Test Suites</Tab>
        </TabList>
        <TabPanel>
          <div className="test-suite-list">
            {testSuites.map((testSuite) => (
              <div
                key={testSuite.id}
                onClick={() => setSelectedTestSuite(testSuite.id)}
                className={clsx('test-suite-item', { selected: testSuite.id === selectedTestSuite?.id })}
                data-contextmenutype="test-suite-item"
                data-testsuiteid={testSuite.id}
              >
                <div className="test-suite-name">{testSuite.name ?? 'Untitled Test Suite'}</div>
                <div className="test-suite-status spinner">
                  <NodeRunningIndicator
                    isRunning={runningTestSuiteId === testSuite.id}
                    delayMs={0}
                    label="Test suite running"
                  />
                </div>
              </div>
            ))}
          </div>
        </TabPanel>
      </Tabs>
      <Portal>
        {showContextMenu && contextMenuData.data?.type === 'test-suite-list' && (
          <PopupMenu
            className="test-suite-list-context-menu"
            minWidth="max-content"
            style={{
              position: 'absolute',
              zIndex: 500,
              left: contextMenuData.x,
              top: contextMenuData.y,
            }}
          >
            <PopupMenuItem onClick={handleNew}>New Test Suite</PopupMenuItem>
          </PopupMenu>
        )}
        {showContextMenu && contextMenuData.data?.type === 'test-suite-item' && (
          <PopupMenu
            className="test-suite-list-context-menu"
            minWidth="max-content"
            style={{
              position: 'absolute',
              zIndex: 500,
              left: contextMenuData.x,
              top: contextMenuData.y,
            }}
          >
            <PopupMenuItem
              onClick={() => selectedTestSuiteIdForContextMenu && runTestSuite(selectedTestSuiteIdForContextMenu)}
            >
              Run Test Suite
            </PopupMenuItem>
            <PopupMenuItem tone="danger" onClick={() => handleDelete(selectedTestSuiteIdForContextMenu)}>
              Delete
            </PopupMenuItem>
          </PopupMenu>
        )}
      </Portal>
    </div>
  );
};
