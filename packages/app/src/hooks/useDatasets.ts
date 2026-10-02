import { type DatasetId, type DatasetMetadata, type ProjectId } from '@valerypopoff/rivet2-core';
import { useEffect, useRef } from 'react';
import { datasetsState } from '../state/dataStudio';
import { useAtom } from 'jotai';
import { useDatasetProvider } from '../providers/ProvidersContext';
import { handleError } from '../utils/errorHandling.js';

export function useDatasets(projectId: ProjectId) {
  const datasetProvider = useDatasetProvider();
  const [datasets, setDatasets] = useAtom(datasetsState);

  const selectedProject = useRef(projectId);
  selectedProject.current = projectId;
  const mounted = useRef(true);

  const reloadDatasets = async () => {
    try {
      const datasets = await datasetProvider.getDatasetsForProject(projectId);
      if (mounted.current && selectedProject.current === projectId) setDatasets(datasets);
    } catch (err) {
      if (!mounted.current || selectedProject.current !== projectId) return;
      handleError(err, 'Failed to reload datasets', {
        metadata: {
          projectId,
        },
      });
    }
  };

  const updateDatasets = async (operation: () => Promise<void>) => {
    await operation();
    await reloadDatasets();
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    void (async () => {
      await datasetProvider.loadDatasets?.(projectId);
      if (!current) return;
      const datasets = await datasetProvider.getDatasetsForProject(projectId);
      if (current && selectedProject.current === projectId) setDatasets(datasets);
    })().catch((err) => {
      if (current) handleError(err, 'Failed to initialize datasets', { metadata: { projectId } });
    });
    return () => {
      current = false;
    };
  }, [datasetProvider, projectId, setDatasets]);

  const putDataset = async (dataset: DatasetMetadata) => {
    await updateDatasets(async () => {
      await datasetProvider.putDatasetMetadata(dataset);
    });
  };

  const deleteDataset = async (datasetId: DatasetId) => {
    await updateDatasets(async () => {
      await datasetProvider.deleteDataset(datasetId);
    });
  };

  return {
    datasets,
    putDataset,
    deleteDataset,
  };
}
