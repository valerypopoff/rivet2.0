---
id: completion
sidebar_label: completion
---

# Rivet CLI - Shell Completion

Generate a shell completion script for the `rivet` command.

## Bash

```bash
rivet completion >> ~/.bashrc
source ~/.bashrc
```

## Zsh

```bash
rivet completion >> ~/.zshrc
source ~/.zshrc
```

## Notes

Completion covers command names and static CLI options. It does not inspect a `.rivet-project` file to complete graph names, web app names, or output IDs.

Shell completion support comes from yargs. Test the generated script in your shell profile before checking it into a shared dotfiles setup.
