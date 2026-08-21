# Installation

## System Requirements

- macOS: macOS Monterey or later
- Windows: Windows 10 or later
- Linux: Modern version of `webkitgtk` installed that supports most of the recent web standards

## Releases

### [Download Rivet](../download.mdx)

Use the Download page for stable Windows and macOS releases from the `main` branch, plus developer Windows and macOS releases from the `develop` branch.

## Building from Source

### Prerequisites

To build and run Rivet from source, you will need:

- Rust (use [rustup](https://rustup.rs/))
- Node.js 22.21.1 or another compatible Node 22 runtime
- the checked-in Yarn release (`packageManager` currently points at Yarn 4.17.1)
- On Windows, Visual Studio Build Tools with the Windows SDK. Tauri needs
  `RC.EXE` on `PATH`, so use Developer PowerShell for Visual Studio or another
  shell where the Windows SDK tools are available.

### Install

A [blobless clone](https://github.blog/2020-12-21-get-up-to-speed-with-partial-clone-and-shallow-clone/) is recommended to download the repository more quickly. After cloning the repository, install the dependencies with `yarn`:

```bash
git clone --filter=blob:none git@github.com:valerypopoff/rivet2.0.git
cd rivet2.0
yarn install --immutable
```

### Build & Run

```bash
yarn dev
```

This will build and run the application in development mode.

To build the desktop app frontend package without launching Tauri:

```bash
yarn workspace @valerypopoff/rivet-app run build
```

To build package-consumer artifacts for wrappers that vendor this checkout:

```bash
yarn build:packages:local
```

Once running, proceed to [Setup](./setup.md)!
