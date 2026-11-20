#!/bin/bash
# T74g, fase 2: un encargo con `claude` real y confinado (ver REAL en run-fake.sh).
REAL=1 exec "$(dirname "$0")/run-fake.sh" "$@"
