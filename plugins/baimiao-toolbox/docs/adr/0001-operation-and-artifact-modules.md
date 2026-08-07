# ADR 0001: Shared Operation and Artifact Modules

## Status

Accepted

## Decision

Local operations are described by the operation catalog and executed through a handler registry. Local and remote file publication uses the local artifact transaction module, which stages files privately and publishes with a hard link so existing outputs are never overwritten.

OCR input conversion is exposed through a narrow preparation module. Its production converter is loaded lazily; tests and MCP adapters can inject a converter without loading unrelated media runtimes.

## Consequences

New operations have one execution seam and can be tested without spawning the CLI. Publication and rollback rules are tested in one implementation. Runtime-heavy OCR dependencies remain local and on-demand.
