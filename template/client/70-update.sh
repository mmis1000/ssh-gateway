# where --update saves the new version, this script is never replaced while it runs
UPDATE_FILE="$0.new"

# get the current version of this script from the gateway and save it as UPDATE_FILE, for the user
# to compare and move over this one
function update_script {
    local download="$UPDATE_FILE.download"
    write_known_hosts
    write_client_key

    echo "Getting the current version of this script from $TARGET_HOST..."
    # ControlMaster no: goes through the connection of a running tunnel when there is one, but
    # never leaves a connection behind. ssh takes the first value of an option, so it comes first
    if ! ( umask 077; ssh -o "ControlMaster no" "${SSH_OPTS[@]}" $TARGET_USER@$TARGET_HOST "v$SCRIPT_VERSION: update" < /dev/null > "$download" )
    then
        rm -f "$download"
        echo "Could not get the new version from $TARGET_HOST, nothing was saved." >&2
        exit 1
    fi
    # a cut off download could still look like a script, a complete one ends with the call of main
    if [ "$(head -n 1 "$download")" != '#! /bin/bash' ] || [ "$(tail -n 1 "$download")" != 'main "$@"; exit' ] || ! bash -n "$download" 2>/dev/null
    then
        rm -f "$download"
        echo "What $TARGET_HOST sent is not a complete script, nothing was saved." >&2
        exit 1
    fi
    if cmp -s "$download" "$0"
    then
        rm -f "$download"
        echo "This script is already the current version."
        return 0
    fi

    [ -x "$0" ] && chmod u+x "$download"
    mv "$download" "$UPDATE_FILE" || exit 1
    echo "Saved the new version to $UPDATE_FILE. Compare it with this one:"
    echo "  diff $(printf '%q %q' "$0" "$UPDATE_FILE")"
    echo "then replace this one with it:"
    echo "  mv $(printf '%q %q' "$UPDATE_FILE" "$0")"
}
