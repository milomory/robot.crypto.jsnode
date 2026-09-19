# Fixed Crypto Auth transport ACL operation

Installed under explicit network-stage approval. Separate broker profile and
root-owned helpers, derived from ops/tls without changing that existing profile.
The secret reference is opaque metadata for the existing Hyperion sudo credential;
values flow only through the peer-checked stdin bridge, never to model output.

Remote operation adds one source allow inside one exact pre-existing location,
backups/hash-checks the vhost, tests/reloads nginx, and conditionally restores
only its own failed edit. It refuses ambiguous, repeated or changed-policy input.
It does not issue certificates, modify browser ACLs, register clients or create
grants. Runtime compose/CA setup is separate. See docs/AUTH-TRANSPORT-DEPLOYMENT.md.

Do not rerun installer over occupied helpers/profile. An already applied remote
patch intentionally fails closed; use read-only inspection to check its state.
