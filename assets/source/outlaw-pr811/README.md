# PR #811 source provenance

These files preserve the source material contributed by Anthony
(`anthonyonazure`) and Oscar in [PR #811](https://github.com/rullerzhou-afk/clawd-on-desk/pull/811)
at commit `1b7259e938a1bca35f28afc8b291f14b9be30b78`.

- `cigarette-fragment.svg` is the isolated cigarette design used to build
  `assets/accessories/cigarette.svg`. Its paper roll and ember keep crisp pixel
  edges; the sub-pixel smoke particles intentionally use normal rendering.
- `western-cowboy-hat.svg` is the isolated `HAT_STD` design used to build
  `assets/accessories/western-cowboy-hat.svg`. It remains a separate catalog
  item so the earlier contributor-authored `cowboy-hat.svg` is not replaced.
- `clawd-outlaw-bender.svg` is the unmodified author-provided 15-second bender
  animation. The runtime copy lives in `assets/svg/`; its root viewBox is one
  unit taller so Electron does not crop the final face-plant pose. Its original
  CSS timeline is retained and `rendering.objectChannelFiles` keeps this file
  on Electron's document-backed channel for asset-specific timeline control
  and deterministic re-entry verification.

The full generated Outlaw theme is not shipped. The existing Clawd sprites and
the two separately attributed Outlaw accessories are composed at runtime.
