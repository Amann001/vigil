# Cascading failure

One service fails and the services that call it fail or slow down too, so many services look
broken at once.

## Symptoms
- Errors or latency rise on several services at the same time.
- The customer-facing service often shows the most errors, even though it is not the cause.

## How to find the root cause
1. Follow the calls downstream: storefront calls inventory and orders; orders calls inventory
   and payments.
2. At each step ask whether a service's problem is explained by a dependency's problem. A
   service whose dependencies are all healthy but which is itself failing is the root cause.
3. Use timing: the root cause usually shows its problem first, and its callers follow.
4. Logs help: callers say `dependency unreachable` or `dependency returned an error` and name
   the dependency; the root cause logs its own, different error, or nothing if it is down.

## Fix
- Act only on the root-cause service, following the runbook for its kind of failure.
- Never restart the callers: they recover by themselves once the root cause is fixed, and
  restarting them adds outages without fixing anything.
