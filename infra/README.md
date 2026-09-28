# Regional infrastructure baseline

This directory packages the selected upstream platform components and the first-party configuration used to make the Contabo lab reproducible. It contains no provider credentials, node addresses, generated machine configurations, kubeconfigs, database passwords or backup keys.

Use the [Talos recipe](talos/README.md) to generate private machine configurations and reserve storage before first provisioning. Use the [Flux platform baseline](platform/README.md) after the one-time Cilium bootstrap. Flux owns platform releases; the regional controller owns customer environment resources; CNPG owns PostgreSQL instances; Talos lifecycle operations own host and Kubernetes upgrades.

The baseline is still a lab-qualified configuration, not a production installation guarantee. The [M1 evidence](../docs/evidence/m1-2026-09-28.md) records fixed volume limits, restart persistence and native TLS SQL on one manually provisioned database. Automated provider bootstrap, node replacement, multiple independent failure domains, staged upgrades, backup/PITR, capacity limits and tenant isolation acceptance remain required work.

An adopter must select its own region inventory, maintenance policy, storage allocation, management access rules, object-store credentials and recovery objectives. Values particular to an installation stay in its ignored local state or private deployment repository. Do not commit generated Talos files or Kubernetes Secrets to this public repository.
