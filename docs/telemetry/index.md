# Telemetry

## Product events

* [Usage analytics](usage-analytics.md) - The Aptabase events Kangentic sends and their properties (app_launch, settings_snapshot, app_error sources, utility_worker_crashed, gpu_process_gone), how clientId and last-run uptime are derived, what is never collected, the KANGENTIC_TELEMETRY switches, and the local sink for checking events.

## Errors and crashes

* [Error reporting (Sentry)](error-reporting.md) - How Sentry runs in main and the renderer: path scrubbing, ignoreErrors filters, the console breadcrumb tag allowlist, foreign native crash handling, errors counted instead of reported (updater, GPU, workers), the GPU escalation report, and sourcemap and debug file upload.
