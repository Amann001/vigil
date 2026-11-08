# Service down

A service process has stopped: it no longer answers requests or reports metrics.

## Symptoms
- The service's `up` metric is 0 and its other metrics stop reporting (shown as missing).
- Services that call it log `dependency unreachable` with connection errors, and return 503
  or 502 to their own callers.
- Customers see errors on the pages that need the service.

## How to confirm
1. Check availability: when did the service go down, and has it come back by itself?
2. Look at memory in the minutes before it went down. Steadily rising memory means it was
   killed for running out of memory: follow the memory-leak runbook instead.
3. Check the service's own last log lines for an error or traceback before it stopped.

## Fix
- `restart_service` on the service that is down. Never restart its callers: they recover on
  their own once it is back.
- If it goes down again soon after a restart, escalate: something it depends on, or its own
  code or configuration, keeps killing it.
