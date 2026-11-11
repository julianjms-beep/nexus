# NEXUS Update channel

The files NEXUS OS downloads to update itself: `latest.json` (signed with NEXUS's ed25519 key; the signature is `latest.json.sig`) and the bundles it names. NEXUS installs nothing whose signature does not check against the public key it ships with.

Published from the `main` branch with `vm/lab/publish-update.sh`.
