---
id: recipes
sidebar_label: Recipes
---

# Rivet CLI Recipes

Copy-paste examples for common local and reference-hosting workflows.

## Inspect Before Running

```bash
npx @valerypopoff/rivet2-cli list my-project.rivet-project
npx @valerypopoff/rivet2-cli doctor my-project.rivet-project
```

Use `inspect` or `doctor --json` when another script needs machine-readable output:

```bash
npx @valerypopoff/rivet2-cli inspect my-project.rivet-project > project-summary.json
npx @valerypopoff/rivet2-cli doctor my-project.rivet-project --json > project-health.json
```

## Run With JSON Inputs

```bash
npx @valerypopoff/rivet2-cli run my-project.rivet-project "Ask Graph" \
  --input-json prompt='"Hello from the CLI"' \
  --unwrap-output answer
```

For larger inputs, use a file:

```bash
cat > input.json <<'JSON'
{
  "prompt": "Summarize this text",
  "options": {
    "style": "short"
  }
}
JSON

npx @valerypopoff/rivet2-cli run my-project.rivet-project "Summarize" \
  --inputs-file ./input.json \
  --output-file ./result.json
```

## Run With Datasets

Keep dataset mutations in memory:

```bash
npx @valerypopoff/rivet2-cli run my-project.rivet-project "Append row" \
  --dataset-file ./local.rivet-data \
  --input-json row='["alpha","beta"]'
```

Persist dataset mutations back to the file:

```bash
npx @valerypopoff/rivet2-cli run my-project.rivet-project "Append row" \
  --dataset-file ./local.rivet-data \
  --save-datasets \
  --input-json row='["alpha","beta"]'
```

## Run An Evaluation In CI

Export **suite + dataset** from Rivet's Evaluations workspace, then run the bundle against the project containing its graphs:

```bash
npx @valerypopoff/rivet2-cli evaluations run \
  --project ./my-project.rivet-project \
  --suite-file ./quality-suite.json \
  --junit > evaluation-results.xml
```

Use `--benchmark --json` to capture target execution and accounting without applying the suite's quality checks:

```bash
npx @valerypopoff/rivet2-cli evaluations run \
  --project ./my-project.rivet-project \
  --suite-file ./quality-suite.json \
  --benchmark --json > benchmark-run.json
```

## Serve Named Graph Endpoints

```bash
npx @valerypopoff/rivet2-cli serve my-project.rivet-project \
  --host 127.0.0.1 \
  --port 8080 \
  --endpoint ask="Ask Graph" \
  --endpoint summarize="Summarize Graph"
```

Call an endpoint:

```bash
curl -X POST http://127.0.0.1:8080/endpoints/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Hello"}'
```

## Serve With Auth And CORS

```bash
export RIVET_CLI_BEARER_TOKEN=dev-secret

npx @valerypopoff/rivet2-cli serve my-project.rivet-project \
  --cors-origin http://localhost:5173
```

Call it:

```bash
curl -X POST http://localhost:3000/ \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"input":"Hello"}'
```

## Serve A Rivet Web App

```bash
npx @valerypopoff/rivet2-cli serve-app my-project.rivet-project "Support assistant" \
  --host 127.0.0.1 \
  --port 3000 \
  --dev
```

Open `http://127.0.0.1:3000/` in a browser.

If the app is mounted under a path:

```bash
npx @valerypopoff/rivet2-cli serve-app my-project.rivet-project "Support assistant" \
  --base-path /apps/support
```

Open `http://localhost:3000/apps/support/`.

## Docker

Serve the default/main workflow graph:

```bash
docker run --rm \
  -p 3000:3000 \
  -v /path/to/project:/project \
  valerypopoff/rivet-server:latest
```

Serve a web app:

```bash
docker run --rm \
  -p 3000:3000 \
  -v /path/to/project:/project \
  valerypopoff/rivet-server:latest \
  serve-app /project "Support assistant"
```

Inspect a project from the same image:

```bash
docker run --rm \
  -v /path/to/project:/project \
  valerypopoff/rivet-server:latest \
  doctor /project/my-project.rivet-project
```
