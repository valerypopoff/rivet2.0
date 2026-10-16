{{- define "rivet.containers.web" -}}
- name: web
  image: {{ include "rivet.image" (dict "root" . "image" .Values.images.web) }}
  imagePullPolicy: {{ .Values.images.web.pullPolicy }}
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: {{ .Values.tmpVolume.enabled }}
  ports:
    - name: web-http
      containerPort: {{ .Values.service.web.targetPort }}
  startupProbe:
    httpGet:
      path: /
      port: web-http
    periodSeconds: 5
    timeoutSeconds: 2
    failureThreshold: 60
  livenessProbe:
    httpGet:
      path: /
      port: web-http
    periodSeconds: 20
    timeoutSeconds: 2
    failureThreshold: 3
  readinessProbe:
    httpGet:
      path: /
      port: web-http
    periodSeconds: 5
    timeoutSeconds: 2
    failureThreshold: 2
  {{- include "rivet.pod.preStop" . | nindent 2 }}
  {{- if .Values.ha.enabled }}
  env:
    - name: RIVET_WEB_ASSETS_INSTALLATION
      value: {{ printf "%s/%s" .Release.Namespace .Release.Name | quote }}
    {{- if and .Values.vault.enabled .Values.vault.secretPath }}
    - name: RIVET_WEB_ASSETS_DOTENV_FILE
      value: {{ printf "/vault/%s" .Values.vault.dotenvFileName | quote }}
    {{- end }}
    - name: RIVET_DEPLOYMENT_STORAGE_BUCKET
      value: {{ .Values.objectStorage.bucket | quote }}
    - name: RIVET_DEPLOYMENT_STORAGE_REGION
      value: {{ .Values.objectStorage.region | quote }}
    - name: RIVET_DEPLOYMENT_STORAGE_ENDPOINT
      value: {{ .Values.objectStorage.endpoint | quote }}
    - name: RIVET_DEPLOYMENT_STORAGE_PREFIX
      value: {{ .Values.objectStorage.prefix | quote }}
    - name: RIVET_DEPLOYMENT_STORAGE_FORCE_PATH_STYLE
      value: {{ .Values.objectStorage.forcePathStyle | quote }}
    {{- if .Values.objectStorage.accessKeySecretName }}
    - name: RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID
      valueFrom:
        secretKeyRef:
          name: {{ .Values.objectStorage.accessKeySecretName }}
          key: {{ .Values.objectStorage.accessKeySecretKey }}
    {{- end }}
    {{- if .Values.objectStorage.secretKeySecretName }}
    - name: RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY
      valueFrom:
        secretKeyRef:
          name: {{ .Values.objectStorage.secretKeySecretName }}
          key: {{ .Values.objectStorage.secretKeySecretKey }}
    {{- end }}
  {{- end }}
  {{- if .Values.tmpVolume.enabled }}
  volumeMounts:
{{ include "rivet.pod.roleTmpVolumeMount" (dict "root" . "role" "web") | nindent 4 }}
  {{- end }}
  resources:
{{ toYaml .Values.resources.web | nindent 4 }}
{{- end -}}
