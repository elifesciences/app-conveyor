# Deploying App Conveyor

App Conveyor loads pipelines from two independent sources that can be active at the same time:

- **CRD watch** — App Conveyor watches `Pipeline` custom resources in your cluster and starts/stops engines dynamically. Enabled by setting `WATCH_NAMESPACE`.
- **Static config** — pipelines defined in a `conveyor.yaml` (or `CONFIG_PATH`) are loaded once at startup. Enabled automatically when the file is present.

Both sources feed into the same live pipeline list. If the same pipeline ID appears in both, the static config wins and the CRD is ignored — useful for ops-owned pipelines that should not be overridden by cluster resources.

At least one source must be active. If neither is configured the process exits with an error.

All deployments need:

- A persistent volume for the SQLite database
- A Secret for the GitHub token
- RBAC permissions to read Flux and Kubernetes resources

The examples below use the namespace `app-conveyor` throughout. Adjust namespaces, resource names, and image tags to match your environment.

---

## RBAC

### Pipeline CRD permissions (required when `WATCH_NAMESPACE` is set)

The scope depends on the value of `WATCH_NAMESPACE`:

- **Named namespaces** (`WATCH_NAMESPACE=default,staging`) — bind the role per namespace with `RoleBinding`s.
- **All namespaces** (`WATCH_NAMESPACE=*`) — bind cluster-wide with a `ClusterRoleBinding`.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: app-conveyor
rules:
  # Pipeline CRDs — required when WATCH_NAMESPACE is set
  - apiGroups: ["app-conveyor.elifesciences.org"]
    resources: ["pipelines"]
    verbs: ["get", "list", "watch"]
  # Flux and Kubernetes resources — read-only, required for the relevant step types
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets"]
    verbs: ["get"]
  - apiGroups: ["image.toolkit.fluxcd.io"]
    resources: ["imagepolicies", "imageupdateautomations"]
    verbs: ["get"]
  - apiGroups: ["kustomize.toolkit.fluxcd.io"]
    resources: ["kustomizations"]
    verbs: ["get"]
---
# For WATCH_NAMESPACE=* — binds cluster-wide
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: app-conveyor
subjects:
  - kind: ServiceAccount
    name: app-conveyor
    namespace: app-conveyor
roleRef:
  kind: ClusterRole
  name: app-conveyor
  apiGroup: rbac.authorization.k8s.io
```

For named namespaces, replace the `ClusterRoleBinding` with a `RoleBinding` in each watched namespace:

```yaml
# Repeat for each namespace in WATCH_NAMESPACE
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: app-conveyor
  namespace: default          # <-- one per watched namespace
subjects:
  - kind: ServiceAccount
    name: app-conveyor
    namespace: app-conveyor
roleRef:
  kind: ClusterRole
  name: app-conveyor
  apiGroup: rbac.authorization.k8s.io
```

If your pipeline steps target resources in namespaces other than the watched namespace, add `RoleBinding`s in those namespaces too.

### Static config only (no `WATCH_NAMESPACE`)

If you are not using CRD watching, omit the `app-conveyor.elifesciences.org` rule from the ClusterRole. You still need the Flux/Kubernetes read rules for any step types you use.

---

## Manifests

### Namespace and ServiceAccount

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: app-conveyor
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app-conveyor
  namespace: app-conveyor
```

### GitHub token secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: app-conveyor-github
  namespace: app-conveyor
type: Opaque
stringData:
  token: "<your-github-pat>"   # needs read:packages and repo scope
```

### StatefulSet

A StatefulSet is used because App Conveyor is a single-instance stateful workload. The `volumeClaimTemplate` provisions the PVC automatically.

The `env` block varies by which sources are active:

**CRD watching only** (`WATCH_NAMESPACE` set, no config file):

```yaml
          env:
            - name: WATCH_NAMESPACE
              value: "*"        # or "default,staging" for named namespaces
            - name: DB_PATH
              value: /data/conveyor.db
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: app-conveyor-github
                  key: token
```

**Static config only** (config file mounted, no `WATCH_NAMESPACE`):

```yaml
          env:
            - name: CONFIG_PATH
              value: /config/conveyor.yaml
            - name: DB_PATH
              value: /data/conveyor.db
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: app-conveyor-github
                  key: token
```

**Both sources active** (CRD watching + static config for ops-owned pipelines):

```yaml
          env:
            - name: WATCH_NAMESPACE
              value: "*"
            - name: CONFIG_PATH
              value: /config/conveyor.yaml
            - name: DB_PATH
              value: /data/conveyor.db
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: app-conveyor-github
                  key: token
```

Full StatefulSet (adjust the `env` block above as needed):

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: app-conveyor
  namespace: app-conveyor
spec:
  replicas: 1
  serviceName: app-conveyor
  selector:
    matchLabels:
      app: app-conveyor
  template:
    metadata:
      labels:
        app: app-conveyor
    spec:
      serviceAccountName: app-conveyor
      containers:
        - name: app-conveyor
          image: ghcr.io/elifesciences/app-conveyor:latest
          ports:
            - containerPort: 3000
          env:
            # ... see variants above
          livenessProbe:
            httpGet:
              path: /healthz
              port: 3000
          readinessProbe:
            httpGet:
              path: /healthz
              port: 3000
          volumeMounts:
            - name: data
              mountPath: /data
            # Add this if using a static config file:
            # - name: config
            #   mountPath: /config
      # Add this if using a static config file:
      # volumes:
      #   - name: config
      #     configMap:
      #       name: app-conveyor-config
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        resources:
          requests:
            storage: 1Gi
```

### Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: app-conveyor
  namespace: app-conveyor
spec:
  selector:
    app: app-conveyor
  ports:
    - port: 80
      targetPort: 3000
```

---

## CRD setup

### Install the CRD

```bash
kubectl apply -f crds/pipeline.yaml
```

### Create Pipeline resources

```yaml
apiVersion: app-conveyor.elifesciences.org/v1alpha1
kind: Pipeline
metadata:
  name: my-app
  namespace: default
spec:
  name: My App
  pollIntervalMs: 60000
  steps:
    - id: source
      type: git
      repo: my-org/my-app
      branch: main
    - id: build
      type: gha
      repo: my-org/my-app
      workflow: build.yml
    - id: image
      type: ghcr
      image: ghcr.io/my-org/my-app
    - id: deploy
      type: k8s-deploy
      namespace: my-namespace
      name: my-app
```

App Conveyor picks up the CR immediately — no restart required. Deleting or modifying the CR stops or restarts the engine for that pipeline.

---

## Static config setup

Mount a `conveyor.yaml` as a ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-conveyor-config
  namespace: app-conveyor
data:
  conveyor.yaml: |
    pipelines:
      - id: my-app
        name: My App
        steps:
          # ... your pipeline definition here
```

Static config pipelines take precedence over any CRD with the same ID. Changes require a pod restart.

---

## Notes

- **Replicas**: Must stay at 1. SQLite does not support concurrent writers and there is no benefit to running multiple instances.
- **Storage**: 1Gi is generous — the database will stay well under 100MB in normal use. Use any `ReadWriteOnce` storage class available in your cluster.
- **GitHub token**: A classic PAT with `read:packages` and `repo` scopes is required for pipelines using the `ghcr` step against org-owned images. Fine-grained PATs cannot access organisation-owned packages.
