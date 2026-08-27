type VertexAiOptions = {
  project?: string;
  location?: string;
};

const unsupported = () => {
  throw new Error(
    'Google Vertex AI application-credential flows are not supported in the hosted browser wrapper. Configure a Google API key instead.',
  );
};

export class VertexAI {
  constructor(_options: VertexAiOptions = {}) {}

  preview = {
    getGenerativeModel: unsupported,
  };
}
