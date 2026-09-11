import { Field } from '@atlaskit/form';
import Button from '@atlaskit/button';
import { css } from '@emotion/react';
import { type MCP } from '@valerypopoff/rivet2-core';
import { useAtom } from 'jotai';
import { Suspense, useState, type FC } from 'react';
import { toast } from 'react-toastify';
import { projectMetadataState } from '../state/savedGraphs';
import { handleError } from '../utils/errorHandling.js';
import { LazyCodeEditor } from './LazyComponents';

const styles = css`
  display: flex;
  flex-direction: column;
  gap: 16px;

  p {
    margin: 0;
  }

  .editor {
    height: 400px;
    display: flex;
    overflow: auto;
    resize: vertical;

    > div {
      width: 100%;
    }
  }

  .mcp-actions {
    display: flex;
    justify-content: flex-end;
  }
`;

export const ProjectMCPConfiguration: FC = () => {
  const [projectMetadata, setProjectMetadata] = useAtom(projectMetadataState);

  const mcpConfig = projectMetadata.mcpServer ?? {
    mcpServers: {
      serverName: {
        command: '',
        args: [''],
      },
    },
  } as unknown as MCP.Config;

  const [config, setConfig] = useState(() => JSON.stringify(mcpConfig, null, 2) ?? '');

  const onSave = () => {
    try {
      const cleanQuoteConfig = config
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"');
      const parsedConfig: MCP.Config = JSON.parse(cleanQuoteConfig);
      setProjectMetadata({ ...projectMetadata, mcpServer: parsedConfig });
      toast.success('MCP Configuration saved successfully');
    } catch (err) {
      handleError(err, 'Failed to save MCP configuration', {
        metadata: {
          configLength: config.length,
          projectId: projectMetadata.id,
        },
        toastError: false,
      });
      toast.error('Failed to save MCP Configuration: Please make sure your configuration is correctly JSON formatted.');
    }
  };

  return (
    <div css={styles}>
      <p>
        To use local MCP servers with your Rivet project, add the MCP configuration below. The configuration must be
        valid JSON and is saved with the Rivet project file.
      </p>

      <Field name="config" label="Configuration (JSON)">
        {() => (
          <div className="editor">
            <Suspense fallback={<div />}>
              <LazyCodeEditor language="json" text={config} wordWrap="off" onChange={setConfig} />
            </Suspense>
          </div>
        )}
      </Field>

      <div className="mcp-actions">
        <Button appearance="primary" onClick={onSave}>
          Save
        </Button>
      </div>
    </div>
  );
};
