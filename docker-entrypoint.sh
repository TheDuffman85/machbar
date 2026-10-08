#!/bin/sh
set -eu

data_dir="${DATA_DIR:-/app/data}"

secure_migration_backup() {
    backup_dir="$data_dir/migration-backup"
    if [ ! -e "$backup_dir" ] && [ ! -L "$backup_dir" ]; then
        return 0
    fi
    [ -d "$backup_dir" ] && [ ! -L "$backup_dir" ] || return 1
    if [ "$(id -u)" = '0' ]; then
        chown --no-dereference node:node -- "$backup_dir" \
            && find "$backup_dir" -maxdepth 1 -type f -name '*.json' \
                -exec chown --no-dereference node:node -- {} + || return 1
    fi
    chmod 700 -- "$backup_dir" \
        && find "$backup_dir" -maxdepth 1 -type f -name '*.json' \
            -exec chmod 600 -- {} +
}

if [ "$(id -u)" = '0' ]; then
    # Only the data directory and regular data files need ownership changes.
    # Do not follow symlinks or change application files outside this directory.
    mkdir -p -- "$data_dir" \
        && chown --no-dereference node:node -- "$data_dir" \
        && chmod 700 -- "$data_dir" \
        && find "$data_dir" -maxdepth 1 -type f \( -name '*.json' -o -name 'data.db' -o -name 'data.db-*' \) \
            -exec chown --no-dereference node:node -- {} + \
            -exec chmod 600 -- {} + \
        && secure_migration_backup \
        || {
            printf >&2 'Machbar: cannot prepare DATA_DIR "%s". Check that the mount is writable and startup permission-repair capabilities are enabled.\n' "$data_dir"
            exit 1
        }

    # Re-enter as node so the write check and application both run unprivileged.
    exec gosu node "$0" "$@"
fi

mkdir -p -- "$data_dir" \
    && chmod 700 -- "$data_dir" \
    && find "$data_dir" -maxdepth 1 -type f \( -name '*.json' -o -name 'data.db' -o -name 'data.db-*' \) \
        -exec chmod 600 -- {} + \
    && secure_migration_backup \
    && write_check="$(mktemp "$data_dir/.machbar-write-check.XXXXXX")" \
    && rm -- "$write_check" \
    || {
        printf >&2 'Machbar: DATA_DIR "%s" is not writable by UID %s/GID %s or cannot be secured with owner-only permissions. Fix the mounted directory ownership or allow startup as root for automatic repair.\n' "$data_dir" "$(id -u)" "$(id -g)"
        exit 1
    }

exec "$@"
