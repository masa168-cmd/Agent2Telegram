# Sources and license declarations

## pi-telegram-plus (inherited implementation)

- Author recorded by upstream: **jalyfeng**. The package retains that author field.
- Repository: https://github.com/jalyfeng/pi-telegram-plus
- Baseline commit: `50d39ff9b2e0ad60d165920956a5bd92ff078891`.
- Baseline package version: `0.0.12` (Git snapshot, not the different npm 0.0.12 source).
- The fixed upstream `package.json` declares **MIT**. This fork preserves that declaration and existing source notices. The downloaded source snapshot did not contain a standalone LICENSE file; no additional upstream copyright notice has been invented here.
- Original documentation/history is available at the fixed commit. Retained upstream docs and scripts may describe features, release automation or verification that do not apply to this fork; the root README and compatibility document take precedence.

## pi-telegram-mux (design reference)

- Repository: https://github.com/hkfires/pi-telegram-mux
- Reviewed commit: `cfb175d07c49c97c771c98103280ba2e7c848e05`.
- Its per-session forum binding and coordinator architecture informed the investigation. The new `forum-*` implementation was written for this fork; mux's restricted output RPC was not copied or installed alongside plus.

Dependencies retain their own licenses in their distributed packages and lockfile metadata.
