# Error spike

A running service returns server errors (5xx) on a share of its requests.

## Symptoms
- The service's error ratio jumps from about 0% while it stays up.
- Its own logs show errors that are new compared with normal operation, for example
  `connection pool exhausted` or unhandled exceptions, with status 500.
- Callers log `dependency returned an error` for it and return 502 to their own callers.

## How to confirm
1. Find the service whose errors are its own: it logs the underlying error itself, while its
   callers only report that a dependency failed.
2. Check whether its own dependencies are healthy. If they fail, the cause is further
   downstream: follow the cascading-failure runbook.
3. Note when the new kind of error first appeared; that is usually when the incident began.

## Fix
- `restart_service` on the service producing the errors when the error points at in-process
  state (an exhausted pool, a broken connection): a fresh process starts clean.
- If the errors continue after a restart, escalate with the error messages.
