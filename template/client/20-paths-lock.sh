# sets CURRENT_USER, and machine to Linux, Mac, Cygwin, MinGw, Git or UNKNOWN:<uname>
function detect_system {
    export CURRENT_USER="$(id -un)"

    local unameOut="$(uname -s)"
    case "${unameOut}" in
        Linux*)     machine=Linux;;
        Darwin*)    machine=Mac;;
        CYGWIN*)    machine=Cygwin;;
        MINGW*)     machine=MinGw;;
        MSYS_NT*)   machine=Git;;
        *)          machine="UNKNOWN:${unameOut}"
    esac
}

export WORKDIR="$HOME/.ssh-gateway/$TARGET_HOST/$TARGET_USER"
# unix socket paths are limited to about 104 bytes (macOS) and ssh appends 17 characters while
# creating it, so the socket lives higher up than the rest of the files
export CONTROL_SOCK="$HOME/.ssh-gateway/$TARGET_USER.sock"
# scripts before version 5 kept their files here
OLD_WORKDIR="$HOME/.gateway-mmis1000/$TARGET_USER"

function prepare_workdir {
    if [ $(( ${#CONTROL_SOCK} + 17 )) -gt 100 ]
    then
        echo "The path of the control socket, $CONTROL_SOCK, is too long for a unix socket." >&2
        echo "Run this script with a shorter HOME, for example: HOME=/tmp/\$USER $0" >&2
        exit 1
    fi

    # move the files of a script before version 5 over. Other tunnels may still use older
    # scripts, so the parent goes only once it is empty
    if [ -d "$OLD_WORKDIR" ] && [ ! -e "$WORKDIR" ]
    then
        mkdir -p "$(dirname "$WORKDIR")"
        mv "$OLD_WORKDIR" "$WORKDIR"
        rmdir "$HOME/.gateway-mmis1000" 2>/dev/null
    fi

    mkdir -p "$WORKDIR"
    # keys live here, keep it to ourselves
    chmod 700 "$HOME/.ssh-gateway" "$WORKDIR"
}

# a second copy would share the control socket and tear down the tunnel of the first one
LOCK_DIR="$WORKDIR/run.lock"
function lock_owner_alive {
    local pid="$(cat "$LOCK_DIR/pid" 2>/dev/null)"
    [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1 && ! ps -o stat= -p "$pid" 2>/dev/null | grep -q Z
}
function take_lock {
    if ! mkdir "$LOCK_DIR" 2>/dev/null
    then
        if lock_owner_alive
        then
            echo "This script is already running (pid $(cat "$LOCK_DIR/pid")), stop that one first."
            exit 1
        fi
        # left by a run that was killed
        rm -rf "$LOCK_DIR"
        mkdir "$LOCK_DIR" || exit 1
    fi
    echo $$ > "$LOCK_DIR/pid"
}
function release_lock {
    [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" == "$$" ] && rm -rf "$LOCK_DIR"
}

# keep the logs of earlier runs short
function trim_log {
    [ -f "$1" ] && tail -n 200 "$1" > "$1.tmp" 2>/dev/null && mv "$1.tmp" "$1"
}
function trim_logs {
    local log
    for log in sshd.log sshd.err reconnect.log
    do
        trim_log "$WORKDIR/$log"
    done
}

function write_known_hosts {
    printf '%s\n' "$KNOWN_HOSTS" > "$WORKDIR/known_hosts"
}

# options for every connection to the gateway:
# -a -x       never forward the ssh agent or X11 to the gateway, whatever ~/.ssh/config says
# IdentitiesOnly  offer only the key made for this script, not every key in the agent
# known_hosts     only talk to the gateway whose host keys came with this script
# ControlPersist 60  if this script and its watchdog are both killed, the tunnel still closes a
#                    minute after the last connection through it ended
SSH_OPTS=(
    -i "$WORKDIR/id_rsa" -p "$TARGET_PORT"
    -S "$CONTROL_SOCK" -o "ControlPersist 60" -o "ControlMaster auto"
    -a -x -o "IdentitiesOnly yes"
    -o "UserKnownHostsFile \"$WORKDIR/known_hosts\"" -o "StrictHostKeyChecking yes"
    -o "ServerAliveInterval 15"
)
