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
    - . /opt/rivet/lib/load-env.sh; load_optional_dotenv /vault/dotenv; node --preserve-symlinks /app/wrapper/api/dist/api/src/scripts/project-managed-app-settings.js
  env:
{{ include "rivet.env.deploymentStorageBootstrap" . | nindent 4 }}
{{ include "rivet.env.appSettings" . | nindent 4 }}
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
