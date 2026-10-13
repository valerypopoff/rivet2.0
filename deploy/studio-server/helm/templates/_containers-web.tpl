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
  {{- if .Values.tmpVolume.enabled }}
  volumeMounts:
{{ include "rivet.pod.roleTmpVolumeMount" (dict "root" . "role" "web") | nindent 4 }}
  {{- end }}
  resources:
{{ toYaml .Values.resources.web | nindent 4 }}
{{- end -}}
