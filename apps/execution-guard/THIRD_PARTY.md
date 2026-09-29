# Execution guard dependencies

First-party code is Apache-2.0. The executable uses the maintained Go standard library and `golang.org/x/sys` pinned to `v0.40.0`, already used by the CRI reader. Go and x/sys retain their BSD licenses. The image preserves both upstream LICENSE files and the first-party license; no upstream source is forked or vendored. `go.sum` records module integrity.

The guard does not modify PostgreSQL or CloudNativePG. Their lifecycle and plugin interfaces are integration seams, with separately licensed upstream components retained as such.
