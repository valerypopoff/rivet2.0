{{- define "rivet.containers.proxy" -}}
{{- $runtimeHealth := has .Values.ha.controlPlane.mode (list "singleton" "singleton-overlap") -}}
{{- $settingsService := include "rivet.apiServiceName" . -}}
{{- $settingsPort := .Values.service.api.port -}}
{{- if $runtimeHealth -}}
{{- $settingsService = include "rivet.executionServiceName" . -}}
{{- $settingsPort = .Values.service.execution.port -}}
{{- end -}}
- name: proxy
  image: {{ include "rivet.image" (dict "root" . "image" .Values.images.proxy) }}
  imagePullPolicy: {{ .Values.images.proxy.pullPolicy }}
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    allowPrivilegeEscalation: false
  ports:
    - name: proxy-http
      containerPort: {{ .Values.service.proxy.targetPort }}
  startupProbe:
    tcpSocket:
      port: proxy-http
    periodSeconds: 5
    timeoutSeconds: 2
    failureThreshold: 60
  livenessProbe:
    tcpSocket:
      port: proxy-http
    periodSeconds: 20
    timeoutSeconds: 2
    failureThreshold: 3
  readinessProbe:
    tcpSocket:
      port: proxy-http
    periodSeconds: 5
    timeoutSeconds: 2
    failureThreshold: 2
  {{- include "rivet.pod.proxyPreStop" . | nindent 2 }}
  env:
    - name: RIVET_VAULT_DOTENV_FILE_NAME
      value: {{ .Values.vault.dotenvFileName | quote }}
    - name: RIVET_WEB_UPSTREAM_HOST
      value: {{ include "rivet.serviceFqdn" (dict "root" . "serviceName" (include "rivet.webServiceName" .)) | quote }}
    - name: RIVET_WEB_UPSTREAM_PORT
      value: {{ .Values.service.web.port | quote }}
    - name: RIVET_API_UPSTREAM_HOST
      value: {{ include "rivet.serviceFqdn" (dict "root" . "serviceName" (include "rivet.apiServiceName" .)) | quote }}
    - name: RIVET_API_UPSTREAM_PORT
      value: {{ .Values.service.api.port | quote }}
    - name: RIVET_EXECUTION_UPSTREAM_HOST
      value: {{ include "rivet.serviceFqdn" (dict "root" . "serviceName" (include "rivet.executionServiceName" .)) | quote }}
    - name: RIVET_EXECUTION_UPSTREAM_PORT
      value: {{ .Values.service.execution.port | quote }}
    - name: RIVET_EXECUTOR_UPSTREAM_HOST
      value: {{ include "rivet.serviceFqdn" (dict "root" . "serviceName" (include "rivet.executorServiceName" .)) | quote }}
    - name: RIVET_EXECUTOR_UPSTREAM_PORT
      value: {{ .Values.service.executor.port | quote }}
    - name: RIVET_PROXY_SETTINGS_URL
      value: {{ printf "http://%s:%v/internal/app-settings/proxy-config" (include "rivet.serviceFqdn" (dict "root" . "serviceName" $settingsService)) $settingsPort | quote }}
    - name: RIVET_PROXY_HEALTH_OWNER
      value: {{ ternary "execution" "control" (has .Values.ha.controlPlane.mode (list "singleton" "singleton-overlap")) | quote }}
    {{- if .Values.auth.keySecretName }}
    - name: RIVET_KEY
      valueFrom:
        secretKeyRef:
          name: {{ .Values.auth.keySecretName }}
          key: {{ .Values.auth.keySecretKey }}
    {{- end }}
{{ include "rivet.env.proxyValues" . | nindent 4 }}
  {{- if .Values.tmpVolume.enabled }}
  volumeMounts:
{{ include "rivet.pod.roleTmpVolumeMount" (dict "root" . "role" "proxy") | nindent 4 }}
  {{- end }}
  resources:
{{ toYaml .Values.resources.proxy | nindent 4 }}
{{- if .Values.metrics.proxyExporter.enabled }}
- name: metrics-exporter
  image: {{ include "rivet.image" (dict "root" . "image" .Values.metrics.proxyExporter.image) }}
  imagePullPolicy: {{ .Values.metrics.proxyExporter.image.pullPolicy }}
  args:
    - --nginx.scrape-uri=http://127.0.0.1:18080/stub_status
    - --web.listen-address=:{{ .Values.metrics.proxyExporter.port }}
    - --log.level=warn
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534
    runAsGroup: 65534
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
  ports:
    - name: metrics
      containerPort: {{ .Values.metrics.proxyExporter.port }}
  resources:
{{ toYaml .Values.metrics.proxyExporter.resources | nindent 4 }}
{{- end }}
{{- end -}}
