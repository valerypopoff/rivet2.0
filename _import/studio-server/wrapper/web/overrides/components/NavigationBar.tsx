import { css } from '@emotion/react';
import { useAtom } from 'jotai';
import { type FC, type KeyboardEvent } from 'react';
import LeftIcon from 'majesticons/line/chevron-left-line.svg?react';
import RightIcon from 'majesticons/line/chevron-right-line.svg?react';
import CrossIcon from 'majesticons/line/multiply-line.svg?react';
import { useGraphHistoryNavigation } from '../../../../rivet/packages/app/src/hooks/useGraphHistoryNavigation';
import { Tooltip } from '../../../../rivet/packages/app/src/components/Tooltip';
import { goToSearchState, searchingGraphState } from '../../../../rivet/packages/app/src/state/graphBuilder';
import { NavigationGoToSearch } from './NavigationGoToSearch';

const styles = css`
  position: fixed;
  top: calc(50px + var(--project-selector-height));
  left: calc(var(--workflow-dashboard-sidebar-width, 0px) + 275px);
  background: transparent;
  z-index: 50;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;

  &.sidebar-closed {
    left: calc(var(--workflow-dashboard-sidebar-width, 0px) + 25px);
  }

  .button-placeholder {
    width: 32px;
    height: 32px;
  }

  button {
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    border-radius: 5px;
    background: transparent;
    padding: 8px;
    width: 32px;
    height: 32px;
    justify-content: center;
    box-shadow: 3px 1px 10px rgba(0, 0, 0, 0.4);

    &:hover {
      background-color: rgba(255, 255, 255, 0.2);
    }

    svg {
      width: 16px;
      height: 16px;
    }
  }

  .search {
    position: relative;
    input {
      background: var(--grey-dark);
      border: none;
      border-radius: 4px;
      padding: 4px 8px;
      color: var(--grey-lightest);
      width: 200px;
      height: 32px;
      font-size: 14px;
      font-family: var(--font-family);
      font-weight: 500;
      box-shadow: 3px 1px 10px rgba(0, 0, 0, 0.4);
    }

    .stopSearching {
      position: absolute;
      right: 0;
      top: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;

      svg {
        width: 24px;
        height: 24px;
      }
    }
  }

  .go-to {
    position: fixed;
    top: 100px;
    left: calc(50% + (var(--workflow-dashboard-sidebar-width, 0px) / 2));
    transform: translateX(-50%);
    z-index: 100;

    input {
      background: var(--grey-dark);
      border: none;
      border-radius: 4px;
      padding: 18px 18px;
      color: var(--grey-lightest);
      height: 32px;
      font-size: 14px;
      font-family: var(--font-family);
      font-weight: 500;
      box-shadow: 3px 1px 10px rgba(0, 0, 0, 0.4);
      width: 500px;
    }

    .entries {
      border-radius: 4px;
      box-shadow: 3px 1px 10px rgba(0, 0, 0, 0.4);
      max-height: 300px;
      overflow-y: auto;
      width: 500px;

      .entry {
        cursor: pointer;

        .search-result-item {
          padding: 8px;
          border-radius: 4px;
          background: var(--grey-darkerish);

          .title {
            font-weight: 500;
            font-size: 16px;
            margin-bottom: 4px;
            display: inline;
          }

          .graph {
            font-size: 13px;
            color: var(--grey-light);
            margin-bottom: 4px;
            display: inline;
            margin-left: 8px;
          }

          .description {
            font-size: 14px;
            color: var(--grey-light);
            margin-bottom: 4px;
            display: inline;
            margin-left: 8px;
          }

          .data {
            font-size: 13px;
            color: var(--grey-light);
            display: inline;
            margin-left: 16px;
          }

          &.selected {
            background: var(--grey-darkish);
          }
        }
      }
    }
  }

  .highlighted {
    background: var(--highlighted-text);
    color: var(--highlighted-text-contrast);
  }
`;

function resetGoToSearch() {
  return { searching: false, query: '', selectedIndex: 0, entries: [] };
}

function getNextSelectedIndex(currentIndex: number, entryCount: number, direction: 'up' | 'down'): number {
  if (entryCount === 0) {
    return 0;
  }

  if (direction === 'down') {
    return currentIndex + 1 >= entryCount ? 0 : currentIndex + 1;
  }

  return currentIndex - 1 < 0 ? entryCount - 1 : currentIndex - 1;
}

export const NavigationBar: FC = () => {
  const navigationStack = useGraphHistoryNavigation();
  const [searching, setSearching] = useAtom(searchingGraphState);
  const [goToSearch, setGoToSearch] = useAtom(goToSearchState);

  const handleGoToKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' || event.key === 'Enter') {
      setGoToSearch(resetGoToSearch());
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const direction = event.key === 'ArrowDown' ? 'down' : 'up';
      setGoToSearch((state) => ({
        ...state,
        selectedIndex: getNextSelectedIndex(state.selectedIndex, state.entries.length, direction),
      }));
    }
  };

  return (
    <div css={styles}>
      {navigationStack.hasBackward ? (
        <Tooltip content="Go to previous graph" placement="bottom">
          <button onClick={navigationStack.navigateBack}>
            <LeftIcon />
          </button>
        </Tooltip>
      ) : (
        <div className="button-placeholder" />
      )}

      {navigationStack.hasForward ? (
        <Tooltip content="Go to next graph" placement="bottom">
          <button onClick={navigationStack.navigateForward}>
            <RightIcon />
          </button>
        </Tooltip>
      ) : (
        <div className="button-placeholder" />
      )}

      {searching.searching ? (
        <div className="search">
          <input
            type="text"
            placeholder="Search..."
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={searching.query}
            onChange={(event) => setSearching({ searching: true, query: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearching({ searching: false, query: '' });
              }
            }}
          />
          <button className="stopSearching" onClick={() => setSearching({ searching: false, query: '' })}>
            <CrossIcon />
          </button>
        </div>
      ) : null}

      {goToSearch.searching ? (
        <div className="go-to">
          <div className="go-to-search">
            <input
              type="text"
              placeholder="Go to..."
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={goToSearch.query}
              onChange={(event) =>
                setGoToSearch((search) => ({
                  searching: true,
                  query: event.target.value,
                  selectedIndex: 0,
                  entries: search.entries,
                }))}
              onKeyDown={handleGoToKeyDown}
            />
          </div>
          <NavigationGoToSearch />
        </div>
      ) : null}
    </div>
  );
};
