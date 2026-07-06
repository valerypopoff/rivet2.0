---
id: docker
sidebar_label: Docker
---

# Rivet Server Docker Image

The `serve` command from the Rivet CLI is available as a Docker image, allowing you to run a Rivet server in a containerized environment.

## Quick Start

```bash
# Start a server on port 3000 with a mounted project directory
docker run -p 3000:3000 -v /path/to/project:/project valerypopoff/rivet-server:latest
```

## Description

The Docker image provides the same functionality as the serve command, but packaged in a container for easier deployment and consistent environments. The server runs on port 3000 by default inside the container.

For more information on the `serve` command, see the [Rivet CLI documentation](./serve.md).

## Usage

### Basic Usage

Mount your project directory and expose the server port:

```bash
docker run \
  -p 3000:3000 \
  -v /path/to/project:/project \
  valerypopoff/rivet-server:latest
```

### With LLM Configuration

To use configured-key LLM features, provide the needed API keys as environment variables:

```bash
docker run \
  -p 3000:3000 \
  -v /path/to/project:/project \
  -e OPENAI_API_KEY=your-api-key \
  -e ANTHROPIC_API_KEY=your-anthropic-key \
  -e GOOGLE_GENERATIVE_AI_API_KEY=your-google-key \
  -e CUSTOM_AI_API_KEY=your-custom-provider-key \
  valerypopoff/rivet-server:latest
```

### Custom Port

To use a different port:

```bash
docker run \
  -p 8080:3000 \
  -v /path/to/project:/project \
  valerypopoff/rivet-server:latest
```

### To Pass Additional Arguments

To pass additional arguments to the server, append them to the end of the command:

```bash
docker run \
  -p 3000:3000 \
  -v /path/to/project:/project \
  valerypopoff/rivet-server:latest --dev --allow-specifying-graph-id
```

### Endpoint Aliases and Auth

The Docker image accepts the same `rivet serve` options as the CLI:

```bash
docker run \
  -p 3000:3000 \
  -v /path/to/project:/project \
  -e RIVET_CLI_BEARER_TOKEN=secret \
  valerypopoff/rivet-server:latest \
  --endpoint ask="Ask Graph" \
  --cors-origin https://example.com
```

The endpoint above is available at `POST /endpoints/ask` and requires `Authorization: Bearer secret`.

### Dataset Files

If your project uses Data Studio datasets, mount the project directory with the `.rivet-data` file next to the `.rivet-project` file:

```text
/project/my-project.rivet-project
/project/my-project.rivet-data
```

Dataset mutations stay in memory unless `--save-datasets` is passed.

You can check the mounted project before serving it:

```bash
docker run --rm \
  -v /path/to/project:/project \
  valerypopoff/rivet-server:latest \
  doctor /project/my-project.rivet-project
```

### Serving Rivet Web Apps

The published Docker entrypoint defaults to `rivet serve /project` when no command is provided. To serve a Rivet web app instead, pass the CLI subcommand directly:

```bash
docker run \
  -p 3000:3000 \
  -v /path/to/project:/project \
  valerypopoff/rivet-server:latest \
  serve-app /project "Support assistant"
```

## Building Custom Images

Instead of mounting your project at runtime, you can create your own Docker image that includes your Rivet project files. This is useful when you want to:

- Bundle your project files directly in the image
- Build a self-contained deployment artifact
- Set default CLI arguments

### Basic Example

```dockerfile
FROM valerypopoff/rivet-server:latest

# Copy project files into the image
COPY ./my-project-dir /project

# Optionally set default CLI arguments
CMD ["--dev", "--allow-specifying-graph-id"]
```

Then, build and run the image:

```bash
docker build -t my-rivet-server .
docker run -p 3000:3000 my-rivet-server
```

## Environment Variables

See the [Rivet CLI documentation](./serve.md#options) for a list of environment variables that can be used with the server.

## Volume Mounting

The container expects your Rivet project file to be mounted at `/project` inside the container. The mounted directory should contain the Rivet project file and any other files needed by the project, such as any `.rivet-data` file.

The image entrypoint runs the globally installed CLI as `rivet serve /project` when no CLI subcommand is passed. Additional non-command arguments appended to `docker run` are forwarded to that default `serve /project` command. If the first argument is `completion`, `doctor`, `list`, `inspect`, `run`, `serve`, or `serve-app`, the entrypoint runs that CLI command directly.

Maintainers building the published image should pass the CLI package version through the `RIVET_CLI_VERSION` Docker build argument. The package's `docker-publish.sh` script does this automatically.

Maintainers can run the repository Docker smoke check when Docker is available:

```bash
yarn workspace @valerypopoff/rivet2-cli run smoke:docker
```

That smoke check builds a temporary Docker image from the current local CLI package tarball and the real entrypoint script, verifies the image can run `list`, `doctor`, and `--help`, then removes the temporary smoke image.

## Examples

### Using Docker Compose

```yaml
version: '3'
services:
  rivet:
    image: valerypopoff/rivet-server:latest
    ports:
      - '3000:3000'
    volumes:
      - ./my-project:/project
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - GOOGLE_GENERATIVE_AI_API_KEY=${GOOGLE_GENERATIVE_AI_API_KEY}
      - CUSTOM_AI_API_KEY=${CUSTOM_AI_API_KEY}
```

### Using Kubernetes

You can deploy the Rivet server to Kubernetes using a ConfigMap for your project file and environment variables for configuration.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: rivet-project
data:
  project.rivet-project: |
    # Your project file contents here
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rivet-server
spec:
  replicas: 1
  selector:
    matchLabels:
      app: rivet-server
  template:
    metadata:
      labels:
        app: rivet-server
    spec:
      containers:
        - name: rivet-server
          image: valerypopoff/rivet-server:latest
          ports:
            - containerPort: 3000
          volumeMounts:
            - name: project-volume
              mountPath: /project
      volumes:
        - name: project-volume
          configMap:
            name: rivet-project
---
apiVersion: v1
kind: Service
metadata:
  name: rivet-server
spec:
  selector:
    app: rivet-server
  ports:
    - port: 80
      targetPort: 3000
  type: ClusterIP
```
