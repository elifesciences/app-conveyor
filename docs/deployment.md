# Deploying App Conveyor

App Conveyor is a stateful single-instance workload. It needs:

- A `conveyor.yaml` mounted as a ConfigMap
- A persistent volume for the SQLite database
- A Secret for the GitHub token
- RBAC permissions to read Flux and Kubernetes resources

The examples below use the namespace `app-conveyor` throughout. Adjust namespaces,
resource names, and image tags to match your environment.

---

## RBAC

App Conveyor only reads from the Kubernetes API — it never writes. It needs `get`
access to:

| Group | Resource | Why |
|---|---|---|
| `apps` | `deployments` | `k8s-deploy` step — checks rollout status |
| `image.toolkit.fluxcd.io` | `imagepolicies` | `flux-image` step — checks selected tag |
| `image.toolkit.fluxcd.io` | `imageupdateautomations` | `flux-kustomize` step — reads last push time |
| `kustomize.toolkit.fluxcd.io` | `kustomizations` | `flux-kustomize` step — checks reconciliation status |

Because pipelines can target resources in multiple namespaces (e.g. `flux-system`,
`epp--prod`), the role needs to cover each namespace used in your `conveyor.yaml`.
A ClusterRole bound with RoleBindings per namespace keeps the scope narrow.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: app-conveyor
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get"]
  - apiGroups: ["image.toolkit.fluxcd.io"]
    resources: ["imagepolicies", "imageupdateautomations"]
    verbs: ["get"]
  - apiGroups: ["kustomize.toolkit.fluxcd.io"]
    resources: ["kustomizations"]
    verbs: ["get"]
---
# Repeat this RoleBinding for each namespace app-conveyor needs to read from.
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: app-conveyor
  namespace: epp--prod       # <-- one per target namespace
subjects:
  - kind: ServiceAccount
    name: app-conveyor
    namespace: app-conveyor
roleRef:
  kind: ClusterRole
  name: app-conveyor
  apiGroup: rbac.authorization.k8s.io
```

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

### ConfigMap — conveyor.yaml

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

### StatefulSet

A StatefulSet is used rather than a Deployment because App Conveyor is a
single-instance stateful workload. The `volumeClaimTemplate` provisions the
PVC automatically and binds it stably to the pod, which is the correct
primitive for this use case.

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
            - name: CONFIG_PATH
              value: /config/conveyor.yaml
            - name: DB_PATH
              value: /data/conveyor.db
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: app-conveyor-github
                  key: token
          livenessProbe:
            httpGet:
              path: /healthz
              port: 3000
          readinessProbe:
            httpGet:
              path: /healthz
              port: 3000
          volumeMounts:
            - name: config
              mountPath: /config
            - name: data
              mountPath: /data
      volumes:
        - name: config
          configMap:
            name: app-conveyor-config
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

## Notes

- **Replicas**: Must stay at 1. SQLite does not support concurrent writers and
  there is no benefit to running multiple instances.
- **Storage**: 1Gi is generous — the database will stay well under 100MB in
  normal use. Use any `ReadWriteOnce` storage class available in your cluster.
