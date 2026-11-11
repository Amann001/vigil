#!/bin/bash
# Start the shop, then Vigil; if either stops, stop the container so the host restarts it whole.
set -u

# The customers' pace matches the campaign the detector learned from (3 sessions a second, a
# simulated day every 30 minutes), so normal traffic looks normal to it.
python -m shop.launch --rate 3 --cycle-minutes 30 &
shop=$!

# The watcher reads Prometheus from its first poll: give the shop time to start and be scraped.
for _ in $(seq 60); do
    python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9090/-/ready', timeout=2)"         2>/dev/null && break
    sleep 2
done
sleep 20

vigil up &
vigil=$!

wait -n "$shop" "$vigil"
echo "A part stopped; stopping the container."
kill "$shop" "$vigil" 2>/dev/null
exit 1
