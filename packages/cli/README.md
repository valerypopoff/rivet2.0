# @valerypopoff/rivet2-cli

Command-line tools for running and serving Rivet 2 projects through the Node runtime.

## Usage

```bash
npx @valerypopoff/rivet2-cli --help
npx @valerypopoff/rivet2-cli run my-project.rivet-project
npx @valerypopoff/rivet2-cli serve my-project.rivet-project --port 8080
npx @valerypopoff/rivet2-cli serve-app my-project.rivet-project "My web app"
```

The CLI package exposes the `rivet` binary when installed globally:

```bash
npm install -g @valerypopoff/rivet2-cli
rivet --help
```

## Development

```bash
yarn workspace @valerypopoff/rivet2-cli run build
yarn workspace @valerypopoff/rivet2-cli run test
yarn workspace @valerypopoff/rivet2-cli run lint
yarn workspace @valerypopoff/rivet2-cli run verify
```

See the root [README](../../README.md), [package docs](../../developer-docs/PACKAGES.md), and public CLI docs under [packages/docs/docs/cli.md](../docs/docs/cli.md).
