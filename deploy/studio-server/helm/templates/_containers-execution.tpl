{{- define "rivet.containers.execution" -}}
- name: {{ ternary "execution" "api" (eq .Values.deploymentProfile "single-machine") }}
  image: {{ include "rivet.image" (dict "root" . "image" .Values.images.api) }}
  imagePullPolicy: {{ .Values.images.api.pullPolicy }}
  {{- include "rivet.pod.containerSecurityContext" . | nindent 2 }}
  ports:
    - name: execution-http
      containerPort: {{ .Values.service.execution.targetPort }}
  {{- include "rivet.pod.apiProbes" (dict "root" . "port" "execution-http") | nindent 2 }}
  {{- include "rivet.pod.preStop" . | nindent 2 }}
  env:
{{ include "rivet.env.apiWorkload" (dict "root" . "port" .Values.service.execution.targetPort "profile" "execution" "storageBackend" .Values.workflowStorage.backend "replicaTier" "endpoint" "jobWorkerEnabled" "false") | nindent 4 }}
    {{- if eq .Values.deploymentProfile "single-machine" }}
    - name: RIVET_POD_NAME
      valueFrom:
        fieldRef:
          fieldPath: metadata.name
    - name: RIVET_RUNNER_SLOT_ID
      value: "$(RIVET_POD_NAME):execution"
    {{- else }}
    - name: RIVET_RUNNER_SLOT_ID
      valueFrom:
        fieldRef:
          fieldPath: metadata.name
    {{- end }}
  volumeMounts:
{{ include "rivet.pod.roleVolumeMounts" (dict "root" . "role" "execution") | nindent 4 }}
  resources:
{{ toYaml .Values.resources.execution | nindent 4 }}
{{- end -}}
