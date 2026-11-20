#!/usr/bin/env bash
# A remote process can print arbitrary data, including partial or encoded secrets.
# Actions already reports the step name and exit status.
exec bash --noprofile --norc -eo pipefail "$1" >/dev/null 2>&1
