#!/bin/sh
set -eu

data_dir="${DATA_DIR:-/app/data}"

if [ "$(id -u)" = '0' ]; then
    # Only the data directory and regular profile files need ownership changes.
    # Do not follow symlinks or change application files outside this directory.
    mkdir -p -- "$data_dir" \
        && chown --no-dereference node:node -- "$data_dir" \
        && chmod u+rwx -- "$data_dir" \
        && find "$data_dir" -maxdepth 1 -type f -name '*.json' \
            -exec chown --no-dereference node:node -- {} + \
            -exec chmod u+rw -- {} + \
        || {
            printf >&2 'Machbar: cannot prepare DATA_DIR "%s". Check that the mount is writable and startup permission-repair capabilities are enabled.\n' "$data_dir"
            exit 1
        }

    # Re-enter as node so the write check and application both run unprivileged.
    exec gosu node "$0" "$@"
fi

mkdir -p -- "$data_dir" \
    && write_check="$(mktemp "$data_dir/.machbar-write-check.XXXXXX")" \
    && rm -- "$write_check" \
    || {
        printf >&2 'Machbar: DATA_DIR "%s" is not writable by UID %s/GID %s. Fix the mounted directory permissions or allow startup as root for automatic repair.\n' "$data_dir" "$(id -u)" "$(id -g)"
        exit 1
    }

exec "$@"
