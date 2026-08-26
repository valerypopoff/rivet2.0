{{- define "rivet.env.vaultDotenv" -}}
- name: RIVET_VAULT_DOTENV_FILE_NAME
  value: {{ .Values.vault.dotenvFileName | quote }}
{{- end -}}

{{- define "rivet.env.deploymentStorageBootstrap" -}}
{{- $root := . -}}
{{- $appDataRoot := "/data/rivet-app" -}}
{{- if hasKey . "root" -}}
{{- $root = .root -}}
{{- $appDataRoot = default $appDataRoot .appDataRoot -}}
{{- end -}}
{{- include "rivet.env.vaultDotenv" $root }}
- name: RIVET_APP_DATA_ROOT
  value: {{ $appDataRoot | quote }}
- name: RIVET_DEPLOYMENT_STORAGE_MODE
  value: {{ $root.Values.workflowStorage.backend | quote }}
- name: RIVET_DEPLOYMENT_DATABASE_MODE
  value: {{ $root.Values.postgres.mode | quote }}
- name: RIVET_DEPLOYMENT_DATABASE_SSL_MODE
  value: {{ $root.Values.postgres.sslMode | quote }}
{{- if $root.Values.postgres.connectionStringSecretName }}
- name: RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.postgres.connectionStringSecretName }}
      key: {{ $root.Values.postgres.connectionStringSecretKey }}
{{- else }}
- name: RIVET_DEPLOYMENT_DATABASE_HOST
  value: {{ $root.Values.postgres.host | quote }}
- name: RIVET_DEPLOYMENT_DATABASE_PORT
  value: {{ $root.Values.postgres.port | quote }}
- name: RIVET_DEPLOYMENT_DATABASE_NAME
  value: {{ $root.Values.postgres.database | quote }}
- name: RIVET_DEPLOYMENT_DATABASE_USERNAME
  value: {{ $root.Values.postgres.username | quote }}
{{- if $root.Values.postgres.passwordSecretName }}
- name: RIVET_DEPLOYMENT_DATABASE_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.postgres.passwordSecretName }}
      key: {{ $root.Values.postgres.passwordSecretKey }}
{{- end }}
{{- end }}
- name: RIVET_DEPLOYMENT_STORAGE_BUCKET
  value: {{ $root.Values.objectStorage.bucket | quote }}
- name: RIVET_DEPLOYMENT_STORAGE_REGION
  value: {{ $root.Values.objectStorage.region | quote }}
- name: RIVET_DEPLOYMENT_STORAGE_ENDPOINT
  value: {{ $root.Values.objectStorage.endpoint | quote }}
- name: RIVET_DEPLOYMENT_STORAGE_FORCE_PATH_STYLE
  value: {{ $root.Values.objectStorage.forcePathStyle | quote }}
{{- if $root.Values.objectStorage.accessKeySecretName }}
- name: RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.objectStorage.accessKeySecretName }}
      key: {{ $root.Values.objectStorage.accessKeySecretKey }}
{{- end }}
{{- if $root.Values.objectStorage.secretKeySecretName }}
- name: RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.objectStorage.secretKeySecretName }}
      key: {{ $root.Values.objectStorage.secretKeySecretKey }}
{{- end }}
{{- end -}}

{{- define "rivet.env.appSettings" -}}
{{- $root := . -}}
{{- $includeDatabase := true -}}
{{- if hasKey . "root" -}}
{{- $root = .root -}}
{{- if hasKey . "includeDatabase" -}}
{{- $includeDatabase = .includeDatabase -}}
{{- end -}}
{{- end -}}
- name: RIVET_APP_SETTINGS_BACKEND
  value: {{ $root.Values.appSettings.backend | quote }}
{{- if $includeDatabase }}
- name: RIVET_DEPLOYMENT_DATABASE_SSL_MODE
  value: {{ $root.Values.postgres.sslMode | quote }}
{{- if $root.Values.postgres.connectionStringSecretName }}
- name: RIVET_APP_SETTINGS_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.postgres.connectionStringSecretName }}
      key: {{ $root.Values.postgres.connectionStringSecretKey }}
{{- else }}
- name: RIVET_DEPLOYMENT_DATABASE_HOST
  value: {{ $root.Values.postgres.host | quote }}
- name: RIVET_DEPLOYMENT_DATABASE_PORT
  value: {{ $root.Values.postgres.port | quote }}
- name: RIVET_DEPLOYMENT_DATABASE_NAME
  value: {{ $root.Values.postgres.database | quote }}
- name: RIVET_DEPLOYMENT_DATABASE_USERNAME
  value: {{ $root.Values.postgres.username | quote }}
{{- if $root.Values.postgres.passwordSecretName }}
- name: RIVET_DEPLOYMENT_DATABASE_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.postgres.passwordSecretName }}
      key: {{ $root.Values.postgres.passwordSecretKey }}
{{- end }}
{{- end }}
{{- end }}
{{- if $root.Values.appSettings.encryptionKeySecretName }}
- name: RIVET_APP_SETTINGS_ENCRYPTION_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.appSettings.encryptionKeySecretName }}
      key: {{ $root.Values.appSettings.encryptionKeySecretKey }}
{{- end }}
{{- if $root.Values.appSettings.previousEncryptionKeySecretName }}
- name: RIVET_APP_SETTINGS_ENCRYPTION_KEY_PREVIOUS
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.appSettings.previousEncryptionKeySecretName }}
      key: {{ $root.Values.appSettings.previousEncryptionKeySecretKey }}
{{- end }}
{{- end -}}
{{- define "rivet.env.authKey" -}}
{{- if .Values.auth.keySecretName }}
- name: RIVET_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.auth.keySecretName }}
      key: {{ .Values.auth.keySecretKey }}
{{- end }}
{{- end -}}

{{- define "rivet.env.globalValues" -}}
{{- range $key, $value := .Values.env }}
- name: {{ $key }}
  value: {{ tpl (printf "%v" $value) $ | quote }}
{{- end }}
{{- end -}}

{{- define "rivet.env.proxyValues" -}}
{{- $root := . -}}
{{- range $key := list "RIVET_PUBLISHED_WORKFLOWS_BASE_PATH" "RIVET_LATEST_WORKFLOWS_BASE_PATH" "RIVET_PUBLISHED_APPS_BASE_PATH" "RIVET_LATEST_APPS_BASE_PATH" "RIVET_WEB_APPS_BASE_PATH" "RIVET_LATEST_WEB_APPS_BASE_PATH" "RIVET_PROXY_RESOLVER" "RIVET_TRUST_INCOMING_FORWARDED_HEADERS" }}
{{- if hasKey $root.Values.env $key }}
- name: {{ $key }}
  value: {{ tpl (printf "%v" (index $root.Values.env $key)) $root | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "rivet.env.apiWorkload" -}}
{{- $root := .root -}}
{{- include "rivet.env.vaultDotenv" $root }}
- name: PORT
  value: {{ .port | quote }}
- name: RIVET_API_PROFILE
  value: {{ .profile | quote }}
- name: RIVET_WORKSPACE_ROOT
  value: /workspace
- name: RIVET_WORKFLOWS_ROOT
  value: /workflows
- name: RIVET_APP_DATA_ROOT
  value: /data/rivet-app
- name: RIVET_RUNTIME_LIBRARIES_ROOT
  value: /data/runtime-libraries
- name: RIVET_RUNTIME_PROCESS_ROLE
  value: api
- name: RIVET_RUNTIME_LIBRARIES_REPLICA_TIER
  value: {{ .replicaTier | quote }}
- name: RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED
  value: {{ .jobWorkerEnabled | quote }}
- name: RIVET_DEPLOYMENT_MANAGED_WORKFLOW_SCHEMA_MODE
  value: verify
{{ include "rivet.env.appSettings" $root }}
{{ include "rivet.env.authKey" $root }}
{{ include "rivet.env.globalValues" $root }}
{{- end -}}

{{- define "rivet.env.executorWorkload" -}}
{{- $root := .root -}}
{{- include "rivet.env.vaultDotenv" $root }}
- name: PORT
  value: {{ .port | quote }}
- name: HOME
  value: /home/rivet
- name: RIVET_RUNTIME_LIBRARIES_ROOT
  value: /data/runtime-libraries
- name: RIVET_RUNTIME_PROCESS_ROLE
  value: executor
- name: RIVET_RUNTIME_LIBRARIES_REPLICA_TIER
  value: editor
- name: RIVET_LLM_PROFILE_HEALTH_API_URL
  value: {{ printf "http://127.0.0.1:%v/api/workflows/llm-profile-health" .apiPort | quote }}
- name: RIVET_EXECUTION_ENVIRONMENT_API_URL
  value: {{ printf "http://127.0.0.1:%v/api/workflows/execution-environment" .apiPort | quote }}
{{ include "rivet.env.authKey" $root }}
{{ include "rivet.env.globalValues" $root }}
{{- end -}}
