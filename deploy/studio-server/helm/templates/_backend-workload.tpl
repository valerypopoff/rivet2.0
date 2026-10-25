{{- define "rivet.backendWorkload" -}}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ include "rivet.backendName" . }}
  {{- if .Values.ha.enabled }}
  {{- with index .Values.ha.rolloutResourceVersions (include "rivet.backendName" .) }}
  resourceVersion: {{ . | quote }}
  {{- end }}
  {{- end }}
  labels:
    {{- include "rivet.labels" . | nindent 4 }}
    app.kubernetes.io/component: {{ ternary "maintenance" "backend" (default false .haMaintenance) }}
spec:
  serviceName: {{ ternary (printf "%s-maintenance" (include "rivet.fullname" .)) (include "rivet.backendHeadlessServiceName" .) (default false .haMaintenance) }}
  replicas: {{ .Values.replicaCount.backend }}
  # HA peers bootstrap together. Only the release owner may replace OnDelete pods
  # after incarnation-bound retirement; ordinary Helm updates cannot kill work.
  podManagementPolicy: {{ ternary "Parallel" "OrderedReady" .Values.ha.enabled }}
  updateStrategy:
    type: {{ ternary "OnDelete" "RollingUpdate" .Values.ha.enabled }}
  selector:
    matchLabels:
      {{- include "rivet.componentLabels" (dict "root" . "component" "backend") | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "rivet.componentLabels" (dict "root" . "component" "backend") | nindent 8 }}
      annotations:
        rivet.dev/managed-schema-reader-version: {{ .Values.workflowSchema.compatibility.minimumVersion | quote }}
        {{- with .Values.podAnnotations.backend }}
{{ toYaml . | nindent 8 }}
        {{- end }}
        {{- include "rivet.vaultAnnotations" . | nindent 8 }}
    spec:
      {{- include "rivet.pod.imagePullSecrets" . | nindent 6 }}
      terminationGracePeriodSeconds: {{ .Values.lifecycle.terminationGracePeriodSeconds }}
      {{- include "rivet.pod.placement" (dict "root" . "component" "backend") | nindent 6 }}
      {{- include "rivet.pod.workloadSecurityContext" . | nindent 6 }}
      {{- if .Values.compatibility.legacyStartupSettingsFiles }}
      initContainers:
        - name: deployment-storage-settings
          image: {{ include "rivet.image" (dict "root" . "image" .Values.images.api) }}
          imagePullPolicy: {{ .Values.images.api.pullPolicy }}
          {{- include "rivet.pod.containerSecurityContext" . | nindent 10 }}
          command: ["/bin/sh", "-ec"]
          args: [". /opt/rivet/lib/load-env.sh; load_optional_dotenv_preserving_deployment_storage /vault/dotenv; node /opt/rivet/lib/bootstrap-deployment-storage-settings.mjs"]
          env:
{{ include "rivet.env.deploymentStorageBootstrap" . | nindent 12 }}
          volumeMounts:
            - name: app-data
              mountPath: /data/rivet-app
{{ include "rivet.pod.tmpVolumeMount" . | nindent 12 }}
          resources:
{{ toYaml .Values.resources.api | nindent 12 }}
{{ include "rivet.pod.appSettingsProjectionInitContainer" (dict "root" . "resources" .Values.resources.api) | nindent 8 }}
      {{- end }}
      containers:
        {{- if .Values.compatibility.legacyStartupSettingsFiles }}
        # Predecessor API images do not contain the combined-backend supervisor.
        # Keep the two original containers only for the verified rollback path.
        - name: api
          image: {{ include "rivet.image" (dict "root" . "image" .Values.images.api) }}
          imagePullPolicy: {{ .Values.images.api.pullPolicy }}
          {{- include "rivet.pod.containerSecurityContext" . | nindent 10 }}
          ports:
            - name: api-http
              containerPort: {{ .Values.service.api.targetPort }}
          {{- include "rivet.pod.apiProbes" (dict "root" . "port" "api-http") | nindent 10 }}
          {{- include "rivet.pod.preStop" . | nindent 10 }}
          env:
{{ include "rivet.env.apiWorkload" (dict "root" . "port" .Values.service.api.targetPort "profile" "control" "storageBackend" .Values.workflowStorage.backend "replicaTier" "none" "jobWorkerEnabled" "true") | nindent 12 }}
            - name: RIVET_RUNNER_SLOT_ID
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          volumeMounts:
{{ include "rivet.pod.apiVolumeMounts" . | nindent 12 }}
            - name: project-bundles
              mountPath: /data/project-bundles
          resources:
{{ toYaml .Values.resources.api | nindent 12 }}
        - name: executor
          image: {{ include "rivet.image" (dict "root" . "image" .Values.images.executor) }}
          imagePullPolicy: {{ .Values.images.executor.pullPolicy }}
          {{- include "rivet.pod.containerSecurityContext" . | nindent 10 }}
          ports:
            - name: executor-http
              containerPort: {{ .Values.service.executor.targetPort }}
          startupProbe:
            tcpSocket:
              port: executor-http
            periodSeconds: 5
            timeoutSeconds: 2
            failureThreshold: 60
          livenessProbe:
            tcpSocket:
              port: executor-http
            periodSeconds: 20
            timeoutSeconds: 2
            failureThreshold: 3
          readinessProbe:
            tcpSocket:
              port: executor-http
            periodSeconds: 5
            timeoutSeconds: 2
            failureThreshold: 2
          {{- include "rivet.pod.preStop" . | nindent 10 }}
          env:
{{ include "rivet.env.executorWorkload" (dict "root" . "port" .Values.service.executor.targetPort "apiPort" .Values.service.api.targetPort "storageBackend" .Values.runtimeLibraries.backend) | nindent 12 }}
          volumeMounts:
{{ include "rivet.pod.executorVolumeMounts" . | nindent 12 }}
          resources:
{{ toYaml (default .Values.resources.api (index .Values.resources "executor")) | nindent 12 }}
        {{- else }}
        - name: backend
          image: {{ include "rivet.image" (dict "root" . "image" .Values.images.api) }}
          imagePullPolicy: {{ .Values.images.api.pullPolicy }}
          {{- include "rivet.pod.containerSecurityContext" . | nindent 10 }}
          command: ["node", "/opt/rivet/backend-supervisor.mjs"]
          ports:
            - name: api-http
              containerPort: {{ .Values.service.api.targetPort }}
            - name: executor-http
              containerPort: {{ .Values.service.executor.targetPort }}
            - name: backend-health
              containerPort: {{ .Values.service.backendHealth.targetPort }}
          startupProbe:
            httpGet:
              path: /readyz
              port: backend-health
            periodSeconds: {{ .Values.lifecycle.probes.startup.periodSeconds }}
            timeoutSeconds: {{ .Values.lifecycle.probes.startup.timeoutSeconds }}
            failureThreshold: {{ add .Values.lifecycle.probes.startup.failureThreshold (div 120 .Values.lifecycle.probes.startup.periodSeconds) 5 }}
          livenessProbe:
            httpGet:
              path: /livez
              port: backend-health
            periodSeconds: {{ .Values.lifecycle.probes.liveness.periodSeconds }}
            timeoutSeconds: {{ .Values.lifecycle.probes.liveness.timeoutSeconds }}
            failureThreshold: {{ .Values.lifecycle.probes.liveness.failureThreshold }}
          readinessProbe:
            httpGet:
              path: /readyz
              port: backend-health
            periodSeconds: {{ .Values.lifecycle.probes.readiness.periodSeconds }}
            timeoutSeconds: {{ .Values.lifecycle.probes.readiness.timeoutSeconds }}
            failureThreshold: {{ .Values.lifecycle.probes.readiness.failureThreshold }}
          {{- include "rivet.pod.preStop" . | nindent 10 }}
          env:
{{ include "rivet.env.apiWorkload" (dict "root" . "port" .Values.service.api.targetPort "profile" "control" "storageBackend" .Values.workflowStorage.backend "replicaTier" "none" "jobWorkerEnabled" "true") | nindent 12 }}
            - name: RIVET_RUNNER_SLOT_ID
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: RIVET_BACKEND_API_PORT
              value: {{ .Values.service.api.targetPort | quote }}
            {{- if .Values.ha.enabled }}
            - name: RIVET_ROLLING_RETIREMENT_PROTOCOL
              value: "1"
            - name: RIVET_ROLLING_RETIREMENT_SOCKET
              value: /tmp/rivet-retirement.sock
            - name: RIVET_HA_DEPLOYMENT
              value: "1"
            - name: RIVET_HA_MAINTENANCE
              value: {{ ternary "1" "0" (default false .haMaintenance) | quote }}
            - name: RIVET_HA_API_ONLY
              value: {{ ternary "1" "0" (default false .haMaintenance) | quote }}
            - name: RIVET_HA_PROTOCOL
              value: {{ ternary "0" "1" (default false .haMaintenance) | quote }}
            - name: RIVET_POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            {{- if eq .Values.ha.controlPlane.mode "singleton-overlap" }}
            - name: RIVET_POD_UID
              valueFrom:
                fieldRef:
                  fieldPath: metadata.uid
            - name: RIVET_POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
            - name: RIVET_NAMESPACE_UID
              value: {{ .Values.ha.namespaceUid | quote }}
            - name: RIVET_HOUSEKEEPING_PORT
              value: "8093"
            {{- end }}
            - name: RIVET_HA_BACKEND_NAME
              value: {{ include "rivet.backendName" . | quote }}
            - name: RIVET_HA_PEER_LIMIT
              value: {{ .Values.ha.peerLimit | quote }}
            - name: RIVET_HA_HEADLESS_SERVICE
              value: {{ include "rivet.serviceFqdn" (dict "root" . "serviceName" (include "rivet.backendHeadlessServiceName" .)) | quote }}
            - name: RIVET_HA_MAINTENANCE_URL
              value: {{ printf "http://%s:%v/" (include "rivet.serviceFqdn" (dict "root" . "serviceName" (printf "%s-maintenance" (include "rivet.fullname" .)))) .Values.service.api.targetPort | quote }}
            {{- end }}
            - name: RIVET_BACKEND_EXECUTOR_PORT
              value: {{ .Values.service.executor.targetPort | quote }}
            - name: RIVET_BACKEND_HEALTH_PORT
              value: {{ .Values.service.backendHealth.targetPort | quote }}
            - name: RIVET_BACKEND_API_STARTUP_TIMEOUT_MS
              value: {{ mul .Values.lifecycle.probes.startup.failureThreshold .Values.lifecycle.probes.startup.periodSeconds 1000 | quote }}
            - name: RIVET_BACKEND_SHUTDOWN_TIMEOUT_MS
              value: {{ mul (add .Values.lifecycle.shutdownGraceSeconds 10) 1000 | quote }}
            - name: RIVET_EXECUTOR_RUNTIME_CONFIG_URL
              value: {{ printf "http://127.0.0.1:%v/internal/executor-runtime-config" .Values.service.api.targetPort | quote }}
          volumeMounts:
{{ include "rivet.pod.backendVolumeMounts" . | nindent 12 }}
            - name: project-bundles
              mountPath: /data/project-bundles
          resources:
{{ toYaml (ternary .Values.resources.backendOverlap .Values.resources.backend (eq .Values.ha.controlPlane.mode "singleton-overlap")) | nindent 12 }}
        {{- end }}
        {{- if eq .Values.deploymentProfile "single-machine" }}
        {{- if gt (int .Values.replicaCount.web) 0 }}
{{ include "rivet.containers.web" . | nindent 8 }}
        {{- end }}
        {{- if gt (int .Values.replicaCount.proxy) 0 }}
{{ include "rivet.containers.proxy" . | nindent 8 }}
        {{- end }}
        {{- if gt (int .Values.replicaCount.execution) 0 }}
{{ include "rivet.containers.execution" . | nindent 8 }}
        {{- end }}
        {{- end }}
      volumes:
        {{- if and (or (not .Values.ha.enabled) (default false .haMaintenance) (has .Values.ha.controlPlane.mode (list "singleton" "singleton-overlap"))) .Values.legacyRestore.enabled (eq .Values.workflowStorage.backend "managed") (not .Values.compatibility.legacyStartupSettingsFiles) }}
        - name: legacy-restore
          persistentVolumeClaim:
            claimName: {{ include "rivet.fullname" . }}-legacy-restore
        {{- end }}
        - name: project-bundles
          emptyDir:
            sizeLimit: {{ .Values.writableVolumeLimits.projectBundles }}
        - name: workspace
          emptyDir:
            sizeLimit: {{ .Values.writableVolumeLimits.workspace }}
        {{- if eq .Values.workflowStorage.backend "filesystem" }}
        - name: workflows
          persistentVolumeClaim:
            claimName: {{ .Values.filesystem.workflows.existingClaimName }}
        {{- else }}
        - name: workflows
          emptyDir:
            sizeLimit: {{ .Values.writableVolumeLimits.workflows }}
        {{- end }}
        - name: app-data
          emptyDir:
            sizeLimit: {{ .Values.writableVolumeLimits.appData }}
        {{- if eq .Values.runtimeLibraries.backend "filesystem" }}
        - name: runtime-libraries
          persistentVolumeClaim:
            claimName: {{ .Values.filesystem.runtimeLibraries.existingClaimName }}
        {{- else if .Values.runtimeLibraries.cache.existingClaimName }}
        - name: runtime-libraries
          persistentVolumeClaim:
            claimName: {{ .Values.runtimeLibraries.cache.existingClaimName }}
        {{- else if not .Values.runtimeLibraries.cache.enabled }}
        - name: runtime-libraries
          emptyDir:
            sizeLimit: {{ .Values.writableVolumeLimits.runtimeLibraries }}
        {{- end }}
{{ include "rivet.pod.tmpVolume" . | nindent 8 }}
  {{- if and (eq .Values.runtimeLibraries.backend "managed") .Values.runtimeLibraries.cache.enabled (not .Values.runtimeLibraries.cache.existingClaimName) }}
  volumeClaimTemplates:
    - metadata:
        name: runtime-libraries
        labels:
          {{- include "rivet.labels" . | nindent 10 }}
          app.kubernetes.io/component: backend
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: {{ .Values.runtimeLibraries.cache.size }}
        {{- if .Values.runtimeLibraries.cache.storageClassName }}
        storageClassName: {{ .Values.runtimeLibraries.cache.storageClassName }}
        {{- end }}
  {{- end }}
{{- end -}}
