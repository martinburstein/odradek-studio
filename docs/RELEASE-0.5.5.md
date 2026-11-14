# Studio 0.5.5 release scope

This is a curated distribution of the finished 0.5.4 feature set, with Studio branding, separate local app data, a clean source inventory and no private history or commissioning records. Optional pilot construction is deferred until explicitly requested so ordinary startup does not depend on omitted experimental qualification tooling. The Controller's checks and movement limits are unchanged.

## Verified

- Clean Windows build runner: all 208 automated tests passed with zero skips. Local checks also passed; one local symlink fixture required a filesystem-permission skip.
- Fresh packaged backend: ordinary startup and offline-only learning, three tests passed with new empty application data.
- Packaged executable identity/version/icons, renderer/source hashes, bundled Node, same-origin worker/CSP and private-content inventory checks passed.
- All four portable example runs match their published byte counts and SHA-256 hashes.
- Packaged headless UI: 13 simulator captures, 82 real retained-policy ghosts, replay/scrub, reference maps, trial plots and compact layouts passed with zero page exceptions or blocked network attempts.
- Clean-machine workflow built the installer and ZIP and passed the three fresh-data packaged backend tests.

The Windows installer and ZIP are unsigned. Native Electron window interaction, installer execution and a second-computer installation are not claimed by these checks. Hardware/contact performance is outside the release validation. Build-tool dependency audit reports six moderate transitive minimatch findings; the Controller runtime audit has zero findings. Build tools are excluded from the installed app.
