# sent before every command, CLIENT_SCRIPT_VERSION of the gateway is the version it hands out
SCRIPT_VERSION=9

function register {
    local command="v$SCRIPT_VERSION: register $CURRENT_USER $FORWARD_PORT $(printf '%q' "$STATIC_DIRECTORY")"
    [ $SHOW_LIST == 1 ] && command="$command --list"
    [ $SHARE_DOTFILES == 1 ] && command="$command --dotfiles"
    if [ -n "$PUBLIC_AUTH" ]
    then
        # on stdin, a command line would show the password in ps and in the gateway log
        printf '%s\n' "$PUBLIC_AUTH" | ssh "${SSH_OPTS[@]}" $TARGET_USER@$TARGET_HOST "$command --auth"
    else
        # the gateway never reads it, do not let ssh take what is typed in the terminal
        ssh "${SSH_OPTS[@]}" $TARGET_USER@$TARGET_HOST "$command" < /dev/null
    fi
}

# In folder mode the gateway logs in to the local sshd through the tunnel. sshd can refuse it
# for reasons only it knows, like a home directory under /tmp, so ask the gateway whether it got
# in and can read the folder. Sets CHECK_FAILURE to the gateway's answer when it could not.
CHECK_FAILURE=""
function check_folder {
    CHECK_FAILURE=""
    [ "$FORWARD_PORT" != 0 ] && return 0
    local output status
    output="$(ssh "${SSH_OPTS[@]}" $TARGET_USER@$TARGET_HOST "v$SCRIPT_VERSION: check" < /dev/null 2>&1)"
    status=$?
    # 3 is the gateway's answer, anything else is ssh failing to ask
    [ $status == 3 ] && CHECK_FAILURE="$output"
    return $status
}

# what the gateway and the local sshd said about a failed check_folder
function explain_check_failure {
    echo "The gateway can not reach the shared folder: $CHECK_FAILURE" >&2
    # sshd logs through a separate process, its line may land just after the gateway's answer
    sleep 1
    local new_lines="$(tail -n +$((SSHD_ERR_LINES + 1)) "$WORKDIR/sshd.err" 2>/dev/null | grep -v '^Server listening' | tail -n 5)"
    if [ -n "$new_lines" ]
    then
        echo "The local sshd says ($WORKDIR/sshd.err):" >&2
        printf '%s\n' "$new_lines" | sed 's/^/  /' >&2
    fi
}

# open the connection, register, add the reverse forward of TUNNEL_PORT and make sure the gateway
# gets through
function connect {
    ssh -N -M "${SSH_OPTS[@]}" -o "ClearAllForwardings yes" $TARGET_USER@$TARGET_HOST &
    sleep 5
    register || return 1
    sleep 1
    ssh -N -O forward "${SSH_OPTS[@]}" -R 22:localhost:$TUNNEL_PORT $TARGET_USER@$TARGET_HOST || return 1
    if ! check_folder
    then
        # a connection the gateway can not use is not up, the reconnect loop tries again
        close_master
        return 1
    fi
}

function tunnel_alive {
    ssh -O check -N "${SSH_OPTS[@]}" $TARGET_USER@$TARGET_HOST >/dev/null 2>&1
}

RECONNECT_LOG="$WORKDIR/reconnect.log"

EVER_UP=0
# say the tunnel is up, with since when and, after an outage, for how long it was down
function report_up {
    if [ $EVER_UP == 0 ]
    then
        echo "Tunnel is up since $(date +%H:%M). Press Ctrl+C to stop."
        EVER_UP=1
    else
        local down=$((SECONDS - DOWN_SINCE))
        echo "Tunnel is up again since $(date +%H:%M), it was down for $((down / 60))m $((down % 60))s."
    fi
}

# the first attempt, in front of the user. Exits when the shared folder can not be reached, a
# retry would not help then
function open_tunnel {
    echo "Connecting to $TARGET_HOST..."
    if connect && tunnel_alive
    then
        report_up
        CONNECTION_LOST=0
    elif [ -n "$CHECK_FAILURE" ]
    then
        # trying again would not help, the setup on this computer has to change
        explain_check_failure
        exit 1
    else
        echo "Could not open the tunnel, retrying... (details in $RECONNECT_LOG)"
        CONNECTION_LOST=1
    fi
}

# stay quiet while the connection is fine, say something only when it breaks and comes back
function stay_connected {
    while true
    do
        if ! tunnel_alive
        then
            if [ $CONNECTION_LOST == 0 ]
            then
                echo "Connection lost at $(date +%H:%M), reconnecting... (details in $RECONNECT_LOG)"
                CONNECTION_LOST=1
                DOWN_SINCE=$SECONDS
            fi
            # keep the local sshd, only the connection to the gateway is replaced
            close_master
            {
                echo "--- $(date)"
                connect
            } >> "$RECONNECT_LOG" 2>&1
            # say it once, the loop keeps trying in case it is passing, like sshd restarting
            if [ -n "$CHECK_FAILURE" ] && [ "$CHECK_FAILURE" != "$REPORTED_FAILURE" ]
            then
                explain_check_failure
                REPORTED_FAILURE="$CHECK_FAILURE"
            fi
        elif [ $CONNECTION_LOST == 1 ]
        then
            report_up
            CONNECTION_LOST=0
            REPORTED_FAILURE=""
        fi

        sleep 1
    done
}
