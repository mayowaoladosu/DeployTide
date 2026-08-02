# Separate immutable releases from mutable traffic aliases

A successful deployment creates an immutable release, while customer-visible names are aliases that can move between releases. Promotion and rollback therefore move aliases rather than rebuilding artifacts. This costs additional release retention but makes provenance, repeatability, and instant rollback part of the domain model.
