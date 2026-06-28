# Rivet CLI

The Rivet CLI is a command line companion tool for Rivet that provides a number of useful commands for working with Rivet projects. The CLI is published under
NPM as [@valerypopoff/rivet2-cli](https://www.npmjs.com/package/@valerypopoff/rivet2-cli).

## Installation

The Rivet CLI does not need to be installed, and can be run using `npx` or `yarn dlx`. For example:

```bash
npx @valerypopoff/rivet2-cli --help
```

If you would like to install the CLI globally, you can do so using NPM:

```bash
npm install -g @valerypopoff/rivet2-cli
```

Then, rivet is available under the command `rivet`:

```bash
rivet --help
```

## Commands

The Rivet CLI provides the following commands:

- [`rivet list`](./cli/list.md) / [`rivet inspect`](./cli/list.md) - Inspect a project file without running it.
- [`rivet doctor`](./cli/doctor.md) - Check a project file for common CLI/runtime problems.
- [`rivet run`](./cli/run.md) - Runs a Rivet graph in a project using provided input values.
- [`rivet serve`](./cli/serve.md) - Serves a Rivet project using a local server.
- [`rivet serve-app`](./cli/serve-app.md) - Serves a project-contained Rivet web app.
- [`rivet completion`](./cli/completion.md) - Generates a shell completion script.

See the documentation for each command for more information, or start from the [CLI recipes](./cli/recipes.md) page for copy-paste examples.

## Docker

The Rivet CLI `serve` command is also available as a Docker image. You can run the Rivet server using Docker with the following command:

```bash
docker run -p 3000:3000 -v $(pwd):/project valerypopoff/rivet-server
```

See the [Docker page](./cli/docker) for more information.
