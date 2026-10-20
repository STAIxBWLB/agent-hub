# PII screen calibration (issue #198), 2026-10-20

- Screen: campus gateway, model coding
- Fixtures: 78 synthetic items (38 positives, 40 hard negatives), test/fixtures/pii-screen.json
- Recall (pii labels only): 100.0%; bound 90.0%, fixed before measuring: met
- Recall as handled (pii or unknown): 100.0%
- Precision (pii labels): 100.0%
- Unknown rate: 0.0%
- Hard negatives held as PII (pii or unknown): 0.0%
- Category agreement on true positives: 100.0%
- Latency: p50 233 ms, p95 301 ms, max 710 ms
- Missed positives: none
- Negatives not cleared: none
