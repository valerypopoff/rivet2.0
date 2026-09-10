import { type FC } from 'react';
import TextField from '@atlaskit/textfield';
import Button from '@atlaskit/button';
import { css } from '@emotion/react';
import type { PluginLoadSpec } from '@valerypopoff/rivet2-core';
import { type PluginInfo } from '../../plugins.js';
import { PluginCatalogItem } from './PluginCatalogItem.js';
import { getPluginSpecId, getPluginSpecLabel, pluginSpecMatchesSearch } from '../../utils/pluginUsage.js';

const pluginCatalogStyles = css`
  .plugin-search {
    padding: 16px;
    border-bottom: 1px solid var(--grey);
  }

  .plugin {
    display: grid;
    grid-template-columns: 32px 120px minmax(0, 1fr) auto;
    row-gap: 8px;
    column-gap: 12px;
    padding: 24px 16px;
    align-items: center;
    border-bottom: 1px solid var(--grey);
  }

  .plugin-icon {
    width: 32px;
    height: 32px;
    grid-column: 1;
    grid-row: 1 / -1;

    &.missing {
      border: 1px solid var(--grey);
    }

    img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
  }

  .plugin-name {
    font-weight: 600;
  }

  .plugin-actions {
    display: flex;
    align-items: center;
    align-self: end;
    gap: 8px;
    grid-column: -1;
  }

  .plugin-name-author {
    grid-column: 2;
  }

  .plugin-links {
    grid-column: 2;

    a {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    svg {
      width: 16px;
      height: 16px;
    }
  }

  .plugin-description {
    grid-column: 3;
    grid-row: 1 / -1;
  }

  .extra-plugin-id {
    color: var(--grey-light);
    font-family: var(--font-family-monospace);
    font-size: 12px;
  }
`;

export const PluginCatalog: FC<{
  searchText: string;
  onSearchTextChange: (value: string) => void;
  plugins: PluginInfo[];
  installedExtraSpecs: PluginLoadSpec[];
  isInstalled: (plugin: PluginInfo) => boolean;
  onAddPlugin: (plugin: PluginInfo) => void;
  onRemovePlugin: (plugin: PluginInfo) => void;
  onRemovePluginSpec: (spec: PluginLoadSpec) => void;
  onAddManualPlugin: () => void;
}> = ({
  searchText,
  onSearchTextChange,
  plugins,
  installedExtraSpecs,
  isInstalled,
  onAddPlugin,
  onRemovePlugin,
  onRemovePluginSpec,
  onAddManualPlugin,
}) => {
  const extraSpecs = installedExtraSpecs.filter((spec) => pluginSpecMatchesSearch(spec, searchText));

  return (
    <div className="plugin-list" css={pluginCatalogStyles}>
      <div className="plugin-search">
        <TextField
          autoComplete="off"
          spellCheck={false}
          placeholder="Search..."
          value={searchText}
          onChange={(event) => onSearchTextChange((event.target as HTMLInputElement).value)}
        />
      </div>
      <div className="plugins">
        {extraSpecs.map((spec) => {
          const label = getPluginSpecLabel(spec);

          return (
            <div className="plugin custom-plugin" key={`installed-extra-plugin-${getPluginSpecId(spec)}`}>
              <div className="plugin-icon" />
              <div className="plugin-name-author">
                <div className="plugin-name">{label}</div>
                <div className="plugin-author">Installed in this Rivet app</div>
              </div>
              <div className="plugin-description">
                This plugin is installed from outside the catalog.
                <div className="extra-plugin-id">{getPluginSpecId(spec)}</div>
              </div>
              <div className="plugin-actions">
                <span className="installed">Installed</span>
                <Button appearance="danger" onClick={() => onRemovePluginSpec(spec)}>
                  Remove
                </Button>
              </div>
            </div>
          );
        })}
        {plugins.map((pluginInfo) => (
          <PluginCatalogItem
            key={pluginInfo.id}
            plugin={pluginInfo}
            isInstalled={isInstalled(pluginInfo)}
            onAddPlugin={onAddPlugin}
            onRemovePlugin={onRemovePlugin}
          />
        ))}
        {!searchText && (
          <div className="plugin custom-plugin" key="custom-plugin">
            <div className="plugin-icon" />
            <div className="plugin-name-author">
              <div className="plugin-name">NPM Plugin</div>
            </div>
            <div className="plugin-description">Add a plugin from NPM manually</div>
            <div className="plugin-actions">
              <Button appearance="default" onClick={onAddManualPlugin}>
                Add
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
