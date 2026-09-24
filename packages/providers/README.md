# @ai-drama/providers

Deterministic in-process Mock Provider for the M1 runtime loop.

Supported outcomes: `success`, `retryable_failure`, `terminal_failure`, `cancel`, and `delayed`. Delayed requests stay inspectable until `completeDelayed`. This package does not call vendor APIs or generate media.
