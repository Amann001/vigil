# High latency

Requests to a service take much longer than usual, while they still mostly succeed.

## Symptoms
- The service's p95 latency is many times its usual value.
- Its callers become slow too, because they wait for it; requests in flight pile up.
- Errors may follow if callers give up waiting (timeouts).

## How to confirm
1. Compare the service's own latency with the latency of the calls it makes to its
   dependencies. If its dependencies answer quickly but the service is slow, the service
   itself is the cause. If a dependency is slow, follow the slowness downstream to it.
2. Check whether the slowness is on every request or only some routes or a share of requests.
3. Check CPU and memory: a saturated or leaking process can become slow.

## Fix
- `restart_service` on the slow service when the slowness is inside it (stuck threads, a
  blocked resource): a fresh process starts without that state.
- Do not restart a fast service that is only waiting on a slow dependency.
- If it is slow again after a restart, escalate.
