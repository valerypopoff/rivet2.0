{{- define "rivet.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "rivet.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "rivet.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "rivet.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" -}}
{{- end -}}

{{- define "rivet.labels" -}}
helm.sh/chart: {{ include "rivet.chart" . }}
app.kubernetes.io/name: {{ include "rivet.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "rivet.selectorLabels" -}}
app.kubernetes.io/name: {{ include "rivet.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "rivet.componentLabels" -}}
{{ include "rivet.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "rivet.proxyServiceName" -}}
{{- printf "%s-proxy" (include "rivet.fullname" .) -}}
{{- end -}}

{{- define "rivet.webServiceName" -}}
{{- printf "%s-web" (include "rivet.fullname" .) -}}
{{- end -}}

{{- define "rivet.apiServiceName" -}}
{{- printf "%s-api" (include "rivet.fullname" .) -}}
{{- end -}}

{{- define "rivet.executorServiceName" -}}
{{- printf "%s-executor" (include "rivet.fullname" .) -}}
{{- end -}}

{{- define "rivet.executionServiceName" -}}
{{- printf "%s-execution" (include "rivet.fullname" .) -}}
{{- end -}}

{{- define "rivet.serviceFqdn" -}}
{{- $serviceName := .serviceName -}}
{{- $namespace := .root.Release.Namespace -}}
{{- $clusterDomain := default "cluster.local" .root.Values.clusterDomain -}}
{{- printf "%s.%s.svc.%s" $serviceName $namespace $clusterDomain -}}
{{- end -}}

{{- define "rivet.backendName" -}}
{{- printf "%s-backend" (include "rivet.fullname" .) -}}
{{- end -}}

{{- define "rivet.executionName" -}}
{{- printf "%s-execution" (include "rivet.fullname" .) -}}
{{- end -}}

{{- define "rivet.backendHeadlessServiceName" -}}
{{- printf "%s-backend-headless" (include "rivet.fullname" .) -}}
{{- end -}}

{{- define "rivet.image" -}}
{{- if .image.digest -}}
{{- printf "%s@%s" .image.repository .image.digest -}}
{{- else -}}
{{- $tag := default .root.Chart.AppVersion .image.tag -}}
{{- printf "%s:%s" .image.repository $tag -}}
{{- end -}}
{{- end -}}

{{- define "rivet.vaultBaseAnnotations" -}}
{{- if .Values.vault.enabled -}}
{{- if .Values.vault.secretPath }}
vault.hashicorp.com/agent-inject: "true"
vault.hashicorp.com/agent-pre-populate-only: "true"
vault.hashicorp.com/agent-inject-secret-{{ .Values.vault.dotenvFileName }}: {{ .Values.vault.secretPath | quote }}
vault.hashicorp.com/secret-volume-path-{{ .Values.vault.dotenvFileName }}: "/vault"
vault.hashicorp.com/agent-inject-file-{{ .Values.vault.dotenvFileName }}: {{ .Values.vault.dotenvFileName | quote }}
{{- end }}
{{- if .Values.vault.role }}
vault.hashicorp.com/role: {{ .Values.vault.role | quote }}
{{- end }}
{{- if .Values.vault.authPath }}
vault.hashicorp.com/auth-path: {{ .Values.vault.authPath | quote }}
{{- end }}
{{- if .Values.vault.caSecretName }}
vault.hashicorp.com/tls-secret: {{ .Values.vault.caSecretName | quote }}
vault.hashicorp.com/ca-cert: {{ .Values.vault.caCertPath | quote }}
{{- end }}
{{- if .Values.vault.tlsSkipVerify }}
vault.hashicorp.com/tls-skip-verify: "true"
{{- end }}
{{- range $key, $value := .Values.vault.annotations }}
{{ $key }}: {{ tpl (printf "%v" $value) $ | quote }}
{{- end }}
{{- end -}}
{{- end -}}

{{- define "rivet.vaultAnnotations" -}}
{{- include "rivet.vaultBaseAnnotations" . }}
{{- if and .Values.vault.enabled .Values.vault.secretPath .Values.vault.dotenvTemplate }}
vault.hashicorp.com/agent-inject-template-{{ .Values.vault.dotenvFileName }}: |
{{ .Values.vault.dotenvTemplate | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "rivet.vaultProxyAnnotations" -}}
{{- include "rivet.vaultBaseAnnotations" . }}
{{- if and .Values.vault.enabled .Values.vault.secretPath }}
vault.hashicorp.com/agent-inject-template-{{ .Values.vault.dotenvFileName }}: |
  {{ printf "{{- with secret %q -}}" .Values.vault.secretPath }}
  RIVET_KEY={{ "{{ .Data.data.RIVET_KEY | toJSON }}" }}
  {{ "{{- end }}" }}
{{- end }}
{{- end -}}
