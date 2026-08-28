{{- define "rivet.pod.imagePullSecrets" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
{{ toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "rivet.pod.workloadSecurityContext" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  fsGroup: 10001
{{- end -}}

{{- define "rivet.pod.containerSecurityContext" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  allowPrivilegeEscalation: false
{{- end -}}

{{- define "rivet.pod.tmpVolumeMount" -}}
{{- if .Values.tmpVolume.enabled }}
- name: {{ .Values.tmpVolume.name }}
  mountPath: {{ .Values.tmpVolume.path }}
{{- end }}
{{- end -}}

{{- define "rivet.pod.tmpVolume" -}}
{{- if .Values.tmpVolume.enabled }}
- name: {{ .Values.tmpVolume.name }}
  emptyDir:
    sizeLimit: {{ .Values.tmpVolume.sizeLimit }}
{{- end }}
{{- end -}}

{{- define "rivet.pod.appSettingsProjectionInitContainer" -}}
- name: managed-app-settings-projection
  image: {{ include "rivet.image" (dict "root" . "image" .Values.images.api) }}
  imagePullPolicy: {{ .Values.images.api.pullPolicy }}
  {{- include "rivet.pod.containerSecurityContext" . | nindent 2 }}
  command:
    - /bin/sh
    - -ec
  args:
    - . /opt/rivet/lib/load-env.sh; load_optional_dotenv /vault/dotenv; node /app/packages/studio-server-api/dist/studio-server-api/src/scripts/project-managed-app-settings.js
  env:
{{ include "rivet.env.deploymentStorageBootstrap" . | nindent 4 }}
{{ include "rivet.env.appSettings" (dict "root" . "includeDatabase" false) | nindent 4 }}
{{ include "rivet.env.authKey" . | nindent 4 }}
  volumeMounts:
    - name: app-data
      mountPath: /data/rivet-app
{{ include "rivet.pod.tmpVolumeMount" . | nindent 4 }}
{{- end -}}
{{- define "rivet.pod.apiVolumeMounts" -}}
- name: workspace
  mountPath: /workspace
- name: workflows
  mountPath: /workflows
- name: app-data
  mountPath: /data/rivet-app
- name: runtime-libraries
  mountPath: /data/runtime-libraries
{{- include "rivet.pod.tmpVolumeMount" . }}
{{- end -}}

{{- define "rivet.pod.executorVolumeMounts" -}}
# The executor keeps the Rivet desktop-app storage layout on purpose.
# Do not unify this mount path with the API app-data mount.
- name: app-data
  mountPath: /home/rivet/.local/share/com.valerypopoff.rivet2
- name: runtime-libraries
  mountPath: /data/runtime-libraries
- name: workspace
  mountPath: /workspace
{{- include "rivet.pod.tmpVolumeMount" . }}
{{- end -}}

{{- define "rivet.pod.placement" -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- if $root.Values.availability.topologySpread.enabled }}
topologySpreadConstraints:
  - maxSkew: {{ $root.Values.availability.topologySpread.maxSkew }}
    topologyKey: {{ $root.Values.availability.topologySpread.topologyKey | quote }}
    whenUnsatisfiable: {{ $root.Values.availability.topologySpread.whenUnsatisfiable }}
    labelSelector:
      matchLabels:
        {{- include "rivet.componentLabels" (dict "root" $root "component" $component) | nindent 8 }}
{{- end }}
{{- if $root.Values.availability.podAntiAffinity.enabled }}
affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          topologyKey: {{ $root.Values.availability.podAntiAffinity.topologyKey | quote }}
          labelSelector:
            matchLabels:
              {{- include "rivet.componentLabels" (dict "root" $root "component" $component) | nindent 14 }}
{{- end }}
{{- end -}}

{{- define "rivet.pod.apiProbes" -}}
startupProbe:
  httpGet:
    path: /livez
    port: {{ .port }}
  periodSeconds: {{ .root.Values.lifecycle.probes.startup.periodSeconds }}
  timeoutSeconds: {{ .root.Values.lifecycle.probes.startup.timeoutSeconds }}
  failureThreshold: {{ .root.Values.lifecycle.probes.startup.failureThreshold }}
livenessProbe:
  httpGet:
    path: /livez
    port: {{ .port }}
  periodSeconds: {{ .root.Values.lifecycle.probes.liveness.periodSeconds }}
  timeoutSeconds: {{ .root.Values.lifecycle.probes.liveness.timeoutSeconds }}
  failureThreshold: {{ .root.Values.lifecycle.probes.liveness.failureThreshold }}
readinessProbe:
  httpGet:
    path: /readyz
    port: {{ .port }}
  periodSeconds: {{ .root.Values.lifecycle.probes.readiness.periodSeconds }}
  timeoutSeconds: {{ .root.Values.lifecycle.probes.readiness.timeoutSeconds }}
  failureThreshold: {{ .root.Values.lifecycle.probes.readiness.failureThreshold }}
{{- end -}}

{{- define "rivet.pod.preStop" -}}
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", {{ printf "sleep %v" .Values.lifecycle.preStopDelaySeconds | quote }}]
{{- end -}}
