{{- define "rivet.haRoleCommand" -}}
{{- if .root.Values.ha.enabled }}
command: ["node", "/opt/rivet/backend-supervisor.mjs"]
{{- end }}
{{- end -}}

{{- define "rivet.haRoleEnv" -}}
{{- if .root.Values.ha.enabled }}
- name: RIVET_ROLLING_RETIREMENT_PROTOCOL
  value: "1"
- name: RIVET_ROLLING_RETIREMENT_SOCKET
  value: /tmp/rivet-retirement.sock
- name: RIVET_HA_API_ONLY
  value: "1"
- name: RIVET_BACKEND_API_PORT
  value: {{ .port | quote }}
- name: RIVET_BACKEND_EXECUTOR_PORT
  value: {{ .root.Values.service.executor.targetPort | quote }}
- name: RIVET_BACKEND_HEALTH_PORT
  value: {{ .root.Values.service.backendHealth.targetPort | quote }}
- name: RIVET_EXECUTOR_RUNTIME_CONFIG_URL
  value: {{ printf "http://127.0.0.1:%v/internal/executor-runtime-config" .port | quote }}
{{- end }}
{{- end -}}
