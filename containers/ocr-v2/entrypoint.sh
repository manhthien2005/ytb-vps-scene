#!/bin/sh
set -eu

site_dir="$(python -c 'import site; print(site.getsitepackages()[0])')"
if [ -d "$site_dir/nvidia" ]; then
    nvidia_libs="$(find "$site_dir/nvidia" -mindepth 2 -maxdepth 2 -type d -name lib -print 2>/dev/null | paste -sd: -)"
    if [ -n "$nvidia_libs" ]; then
        export LD_LIBRARY_PATH="${nvidia_libs}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    fi
fi

if [ "${1:-}" = "--provider-smoke" ]; then
    shift
    exec python /app/provider_smoke.py "$@"
fi

exec python /app/worker.py "$@"
