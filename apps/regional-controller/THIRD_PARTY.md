# Regional PostgreSQL verification dependencies

First-party code remains Apache-2.0. Upstream packages retain their licenses; no upstream source is vendored or modified. The workspace lock pins distribution integrity and the transitive graph. These dependencies support ordinary PostgreSQL authentication verification, not a new database protocol or gateway.

| Package     | Pinned version | Origin and license                                                                                                      | Integration                                                                                                                                 |
| ----------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg`        | `8.23.0`       | [node-postgres](https://github.com/brianc/node-postgres/tree/df274d1ba9ad9d11a8f1079314faeafde7208207/packages/pg), MIT | Fresh bounded password-authenticated TLS connections, read-only identity/privilege checks and SQLSTATE handling for old-password rejection. |
| `@types/pg` | `8.23.1`       | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/pg), MIT                         | Development-only TypeScript declarations; no runtime credential processing.                                                                 |

The npm registry reports `pg` upstream revision `df274d1ba9ad9d11a8f1079314faeafde7208207`. Installed distribution metadata and license files were inspected on 2026-09-28. The exact package integrity values are recorded in `pnpm-lock.yaml`; runtime image and live CNPG qualification remain separate evidence.

The existing [Kubernetes JavaScript client](https://github.com/kubernetes-client/javascript) remains Apache-2.0 licensed and pinned to `2.0.0`. It provides authenticated Kubernetes resource reads, creates and conditional JSON patches. CloudNativePG remains the PostgreSQL role engine. Its documentation carries a separate CC-BY-4.0 license; this implementation uses its APIs and links to documentation without copying those documents.
