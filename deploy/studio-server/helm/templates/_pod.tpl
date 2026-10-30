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
- name: node-tmp
  mountPath: /tmp
{{- end }}
{{- end -}}

{{- define "rivet.pod.tmpVolume" -}}
{{- if .Values.tmpVolume.enabled }}
- name: {{ .Values.tmpVolume.name }}
  emptyDir:
    sizeLimit: {{ .Values.tmpVolume.sizeLimit }}
- name: node-tmp
  emptyDir:
    sizeLimit: {{ .Values.tmpVolume.nodeTmpSizeLimit }}
{{- end }}
{{- end -}}

{{- define "rivet.pod.appSettingsProjectionInitContainer" -}}
{{- $root := .root -}}
- name: managed-app-settings-projection
  image: {{ include "rivet.image" (dict "root" $root "image" $root.Values.images.api) }}
  imagePullPolicy: {{ $root.Values.images.api.pullPolicy }}
  {{- include "rivet.pod.containerSecurityContext" $root | nindent 2 }}
  command:
    - /bin/sh
    - -ec
  args:
    - . /opt/rivet/lib/load-env.sh; load_optional_dotenv_preserving_deployment_storage /vault/dotenv; node /app/packages/studio-server-api/dist/studio-server-api/src/scripts/project-managed-app-settings.js
  env:
{{ include "rivet.env.deploymentStorageBootstrap" $root | nindent 4 }}
{{ include "rivet.env.appSettings" (dict "root" $root "includeDatabase" false) | nindent 4 }}
{{ include "rivet.env.authKey" $root | nindent 4 }}
  volumeMounts:
    - name: app-data
      mountPath: /data/rivet-app
{{ include "rivet.pod.tmpVolumeMount" $root | nindent 4 }}
  resources:
{{ toYaml .resources | nindent 4 }}
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

{{/* Co-located API roles must not write one another's file projections/caches. */}}
{{- define "rivet.pod.roleVolumeMounts" -}}
{{- $root := .root -}}
{{- $role := .role -}}
{{- range $mount := list (dict "name" "workspace" "path" "/workspace") (dict "name" "workflows" "path" "/workflows") (dict "name" "app-data" "path" "/data/rivet-app") (dict "name" "runtime-libraries" "path" "/data/runtime-libraries") }}
- name: {{ $mount.name }}
  mountPath: {{ $mount.path }}
  {{- if eq $root.Values.deploymentProfile "single-machine" }}
  subPath: {{ $role }}
  {{- end }}
{{- end }}
{{ include "rivet.pod.roleTmpVolumeMount" . }}
{{- end -}}

{{- define "rivet.pod.roleTmpVolumeMount" -}}
{{- if .root.Values.tmpVolume.enabled }}
- name: {{ .root.Values.tmpVolume.name }}
  mountPath: {{ .root.Values.tmpVolume.path }}
  {{- if eq .root.Values.deploymentProfile "single-machine" }}
  subPath: {{ .role }}
  {{- end }}
- name: node-tmp
  mountPath: /tmp
  {{- if eq .root.Values.deploymentProfile "single-machine" }}
  subPath: {{ .role }}
  {{- end }}
{{- end }}
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

{{- define "rivet.pod.backendVolumeMounts" -}}
{{- include "rivet.pod.apiVolumeMounts" . }}
{{- if and (or (not .Values.ha.enabled) (default false .haMaintenance) (has .Values.ha.controlPlane.mode (list "singleton" "singleton-overlap"))) .Values.legacyRestore.enabled (eq .Values.workflowStorage.backend "managed") (not .Values.compatibility.legacyStartupSettingsFiles) }}
- name: legacy-restore
  mountPath: /data/rivet-restore
{{- end }}
- name: app-data
  mountPath: /home/rivet/.local/share/com.valerypopoff.rivet2
{{- end -}}

{{- define "rivet.pod.placement" -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- $overlapBackend := and (eq $component "backend") (eq $root.Values.ha.controlPlane.mode "singleton-overlap") -}}
{{- if $overlapBackend }}
affinity:
  podAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - topologyKey: kubernetes.io/hostname
        labelSelector:
          matchLabels:
            {{- include "rivet.componentLabels" (dict "root" $root "component" "backend") | nindent 12 }}
{{- else }}
{{- if $root.Values.availability.topologySpread.enabled }}
topologySpreadConstraints:
  - maxSkew: {{ $root.Values.availability.topologySpread.maxSkew }}
    topologyKey: {{ $root.Values.availability.topologySpread.topologyKey | quote }}
    whenUnsatisfiable: {{ $root.Values.availability.topologySpread.whenUnsatisfiable }}
    {{- if eq $root.Values.availability.topologySpread.whenUnsatisfiable "DoNotSchedule" }}
    minDomains: {{ $root.Values.availability.topologySpread.minDomains }}
    {{- end }}
    {{- with $root.Values.availability.topologySpread.nodeTaintsPolicy }}
    nodeTaintsPolicy: {{ . }}
    {{- end }}
    labelSelector:
      matchLabels:
        {{- include "rivet.componentLabels" (dict "root" $root "component" $component) | nindent 8 }}
{{- end }}
{{- if $root.Values.availability.podAntiAffinity.enabled }}
affinity:
  podAntiAffinity:
    {{- if $root.Values.availability.podAntiAffinity.required }}
    requiredDuringSchedulingIgnoredDuringExecution:
      - topologyKey: {{ $root.Values.availability.podAntiAffinity.topologyKey | quote }}
        labelSelector:
          matchLabels:
            {{- include "rivet.componentLabels" (dict "root" $root "component" $component) | nindent 12 }}
    {{- else }}
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          topologyKey: {{ $root.Values.availability.podAntiAffinity.topologyKey | quote }}
          labelSelector:
            matchLabels:
              {{- include "rivet.componentLabels" (dict "root" $root "component" $component) | nindent 14 }}
    {{- end }}
{{- end }}
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

{{- define "rivet.proxyLifecycle" -}}
{{- $result := dict "preStopDelaySeconds" .Values.lifecycle.preStopDelaySeconds "terminationGracePeriodSeconds" .Values.lifecycle.terminationGracePeriodSeconds -}}
{{- range $key, $value := .Values.lifecycle.proxy -}}
{{- if not (has $key (list "preStopDelaySeconds" "terminationGracePeriodSeconds")) -}}
{{- fail (printf "Unknown lifecycle.proxy field %s" $key) -}}
{{- end -}}
{{- $_ := set $result $key $value -}}
{{- end -}}
{{- toJson $result -}}
{{- end -}}

{{- define "rivet.pod.proxyPreStop" -}}
{{- $lifecycle := include "rivet.proxyLifecycle" . | fromJson -}}
{{- include "rivet.pod.preStopWithDelay" (dict "root" . "delay" $lifecycle.preStopDelaySeconds) -}}
{{- end -}}

{{- define "rivet.pod.preStop" -}}
{{- include "rivet.pod.preStopWithDelay" (dict "root" . "delay" .Values.lifecycle.preStopDelaySeconds) -}}
{{- end -}}

{{- define "rivet.pod.preStopWithDelay" -}}
lifecycle:
  preStop:
    exec:
      {{- /* Validation owners have never admitted work and have no public edge. */}}
      command: ["/bin/sh", "-c", {{ printf "sleep %v" (ternary 0 .delay .root.Values.workflowSchema.maintenanceValidation) | quote }}]
{{- end -}}
