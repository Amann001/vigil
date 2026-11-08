# Normal variation (not an incident)

Some changes look unusual but are part of normal operation and need no action.

## Examples
- **Card declines.** payments declines a few percent of cards (HTTP 402, `card declined`).
  That is the business working, not a failure, unless the decline rate jumps far above usual.
- **Busier or quieter traffic.** Request rates follow a daily cycle. More requests with normal
  latency and error ratios are more customers, not a fault.
- **Out-of-stock replies.** inventory rejects reservations for products that sold out (HTTP
  409) until it restocks.
- **Small memory changes.** Memory moves by a few megabytes as a process works.

## How to tell
- Real incidents degrade latency, errors or availability; normal variation does not.
- Compare with the usual values: a change within the usual range is not an incident.

## Fix
- None. Do not restart anything; escalate only if the alert cannot be explained.
