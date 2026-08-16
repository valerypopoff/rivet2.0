import Button from '@atlaskit/button';
import Portal from '@atlaskit/portal';
import { type DatasetId, type DatasetMetadata, newId } from '@valerypopoff/rivet2-core';
import { type FC, useState } from 'react';
import { useAtomValue, useAtom } from 'jotai';
import { useContextMenu } from '../../hooks/useContextMenu';
import { useDatasets } from '../../hooks/useDatasets';
import { selectedDatasetState } from '../../state/dataStudio';
import { projectState } from '../../state/savedGraphs';
import { DatasetListItem } from './DatasetListItem';
import { wrapAsync } from '../../utils/errorHandling';
import { PopupMenu, PopupMenuItem } from '../PopupMenu';

export const DatasetList: FC<{ className?: string }> = ({ className }) => {
  const [selectedDataset, setSelectedDataset] = useAtom(selectedDatasetState);
  const {
    refs,
    floatingStyles,
    contextMenuRef,
    showContextMenu,
    contextMenuData,
    handleContextMenu,
    setShowContextMenu,
  } = useContextMenu();
  const [renamingDataset, setRenamingDataset] = useState<DatasetId>();

  const project = useAtomValue(projectState);
  const { datasets, ...datasetsMethods } = useDatasets(project.metadata.id);

  const datasetErrorOptions = (datasetId: DatasetId) => ({
    metadata: {
      datasetId,
      projectId: project.metadata.id,
    },
  });

  const newDataset = () => {
    const metadata: DatasetMetadata = {
      id: newId<DatasetId>(),
      projectId: project.metadata.id,
      name: 'New Dataset',
      description: '',
    };

    return wrapAsync(
      async () => {
        await datasetsMethods.putDataset(metadata);
        setRenamingDataset(metadata.id);
      },
      'Failed to create dataset',
      datasetErrorOptions(metadata.id),
    )();
  };

  const updateDataset = wrapAsync(
    async (dataset: DatasetMetadata) => {
      await datasetsMethods.putDataset(dataset);
    },
    'Failed to update dataset',
    (dataset) => datasetErrorOptions(dataset.id),
  );

  const selectedDatasetForContextMenu =
    contextMenuData.data?.type === 'dataset'
      ? datasets?.find((set) => set.id === contextMenuData.data!.element.dataset.datasetid)
      : undefined;

  const deleteDataset = wrapAsync(
    async (dataset: DatasetMetadata) => {
      setShowContextMenu(false);
      await datasetsMethods.deleteDataset(dataset.id);
    },
    'Failed to delete dataset',
    (dataset) => datasetErrorOptions(dataset.id),
  );

  return (
    <div
      className={className ?? 'left-sidebar'}
      onContextMenu={(e) => {
        handleContextMenu(e);
        e.preventDefault();
      }}
    >
      <header>
        <h2>Datasets</h2>
        <Button appearance="primary" onClick={newDataset}>
          +
        </Button>
      </header>
      <div className="datasets-list">
        {(datasets ?? []).map((dataset) => (
          <DatasetListItem
            key={dataset.id}
            dataset={dataset}
            isSelected={dataset.id === selectedDataset}
            isRenaming={dataset.id === renamingDataset}
            onSelect={() => setSelectedDataset(dataset.id)}
            onRename={() => setRenamingDataset(dataset.id)}
            onUpdate={(updated) => {
              updateDataset(updated);
              setRenamingDataset(undefined);
            }}
          />
        ))}
      </div>
      <Portal>
        {showContextMenu && contextMenuData.data?.type === 'dataset' && (
          <div
            ref={refs.setReference}
            style={{
              position: 'absolute',
              zIndex: 500,
              left: contextMenuData.x,
              top: contextMenuData.y,
            }}
          >
            <PopupMenu ref={refs.setFloating} style={floatingStyles} minWidth="max-content">
              <PopupMenuItem onClick={() => setRenamingDataset(selectedDatasetForContextMenu?.id)}>Rename</PopupMenuItem>
              <PopupMenuItem tone="danger" onClick={() => deleteDataset(selectedDatasetForContextMenu!)}>
                Delete
              </PopupMenuItem>
            </PopupMenu>
          </div>
        )}
      </Portal>
    </div>
  );
};
