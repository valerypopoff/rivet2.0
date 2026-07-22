import { type RivetPlugin } from '../../index.js';
import { PineconeVectorDatabase } from './PineconeVectorDatabase.js';
import { registerIntegration } from '../../integrations/integrations.js';
import { registerKnowledgeStoreProvider } from '../../integrations/KnowledgeStoreProvider.js';
import { createPineconeKnowledgeStore, testPineconeKnowledgeConnection } from './PineconeKnowledgeStore.js';

export const pineconePlugin: RivetPlugin = {
  id: 'pinecone',
  name: 'Pinecone',

  register: () => {
    registerIntegration('vectorDatabase', 'pinecone', (context) => new PineconeVectorDatabase(context.settings));
    registerKnowledgeStoreProvider({
      id: 'pinecone',
      displayName: 'Pinecone',
      pluginId: 'pinecone',
      supportedExecutors: ['nodejs'],
      connectionConfigSpec: [
        { key: 'indexHost', label: 'Index Host', type: 'string', required: true },
        {
          key: 'namespaceTemplate',
          label: 'Namespace Template',
          type: 'string',
          required: true,
          default: '{sourceId}',
          description: 'Must contain {sourceId}. For example: book-{sourceId}.',
        },
        { key: 'textField', label: 'Integrated Embedding Text Field', type: 'string', default: 'chunk_text' },
        { key: 'apiVersion', label: 'Pinecone API Version', type: 'string', default: '2026-04' },
        { key: 'rerankModel', label: 'Rerank Model', type: 'string', default: 'bge-reranker-v2-m3' },
      ],
      credentialConfigSpec: [
        {
          key: 'apiKey',
          label: 'API Key',
          type: 'secret',
          description: 'Stored locally and never written to the project file. Leave blank to use the plugin default.',
        },
      ],
      createStore: (_connectionId, definition, context) =>
        createPineconeKnowledgeStore(definition, context.settings, context.credentials),
      testConnection: testPineconeKnowledgeConnection,
    });
  },

  configSpec: {
    pineconeApiKey: {
      type: 'secret',
      label: 'Pinecone API Key',
      description: 'The API key for the Pinecone service.',
      pullEnvironmentVariable: 'PINECONE_API_KEY',
      helperText: 'You may also set the PINECONE_API_KEY environment variable.',
    },
  },
};
