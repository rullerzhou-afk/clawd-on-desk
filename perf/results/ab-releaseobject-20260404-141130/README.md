# A/B Resource Test (releaseObject only)

- Date: 2026-04-04
- Scope: compare `main` vs `releaseobject_only` branch behavior under the same quick stress load
- Load generator: `bash scripts/run-clawdbot-stress.sh quick`
- Resource sampler: `bash scripts/monitor-clawd-resources.sh --interval 1 --pid <app_pid>`
- Duration per side: ~6 minutes

## Summary

### main
- samples: 292
- duration_min: 6.02
- cpu_avg: 58.51
- cpu_max: 110.40
- rss_start_mb: 447.42
- rss_end_mb: 427.48
- rss_max_mb: 599.20
- rss_delta_mb: -19.94
- rss_slope_mb_per_min: -3.31

### releaseobject_only
- samples: 297
- duration_min: 6.03
- cpu_avg: 54.65
- cpu_max: 81.00
- rss_start_mb: 380.42
- rss_end_mb: 498.30
- rss_max_mb: 635.12
- rss_delta_mb: 117.88
- rss_slope_mb_per_min: 19.54

## Notes

- This is a single short-run sample and should not be treated as a final conclusion.
- In this run, CPU indicators improved, but RSS slope increased on `releaseobject_only`.
- Recommend repeating with longer soak runs and multiple repetitions before deciding fix effectiveness.
