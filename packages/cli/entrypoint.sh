#!/bin/sh

PROJECT_DIR=${PROJECT_DIR:-/project}

case "${1:-}" in
  run|serve|serve-app|-h|--help|--version)
    exec rivet "$@"
    ;;
esac

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Error: Project directory '$PROJECT_DIR' does not exist."
  exit 1
fi

exec rivet serve "$PROJECT_DIR" "$@"
