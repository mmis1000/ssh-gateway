export SSHD_PID_FILE="$WORKDIR/sshd.pid"

# sets SSHD_PATH, exits when ssh or sshd is missing
function find_ssh_programs {
    if ! command -v ssh >/dev/null 2>&1
    then
        echo "Sorry, this script requires ssh in your environment, but I can't find it "
        exit -1
    fi

    SSHD_PATH="$(command -v sshd)"

    # prefer homebrew sshd on mac
    if [ $machine == "Mac" ]
    then
        for i in /opt/homebrew/Cellar/openssh/*/sbin/sshd; do
            if [ -f "$i" ]
            then
                SSHD_PATH="$i"
            fi
        done
    fi

    if [ ! "${SSHD_PATH}" ]
    then
        echo "Sorry, this script requires sshd in your environment, but I can't find it "
        exit -1
    fi
}

# the port is given with -p, so another one can be tried when it is taken
function write_sshd_config {
    echo "
#AddressFamily any
ListenAddress 127.0.0.1
#ListenAddress ::

HostKey \"$WORKDIR/ssh_host_rsa_key\"
HostKey \"$WORKDIR/ssh_host_ecdsa_key\"
HostKey \"$WORKDIR/ssh_host_ed25519_key\"

AllowUsers $CURRENT_USER

PermitRootLogin no
AuthorizedKeysFile     \"$WORKDIR/authorized_keys\"
PidFile                \"$WORKDIR/sshd.daemon.pid\"
PasswordAuthentication no
ChallengeResponseAuthentication no
UsePAM no
PrintMotd no
AcceptEnv LANG LC_*
ClientAliveInterval 120

# the gateway only needs to read files and to reach local ports for socks
ForceCommand internal-sftp -R
Subsystem sftp internal-sftp -R
AllowTcpForwarding local
PermitOpen localhost:* 127.0.0.1:*
AllowAgentForwarding no
AllowStreamLocalForwarding no
X11Forwarding no
PermitTTY no
PermitTunnel no
GatewayPorts no
PermitUserRC no
" > "$WORKDIR/sshd_config"
}

# the key this script logs in to the gateway with
function write_client_key {
    echo "$CLIENT_PRIVATE_KEY" > "$WORKDIR/id_rsa"
    chmod 600 "$WORKDIR/id_rsa"
}

# the key the gateway logs in to the local sshd with, its config and its host keys
function write_sshd_files {
    echo "$CLIENT_SERVER_KEY" > "$WORKDIR/authorized_keys"
    write_sshd_config

    chmod 600 "$WORKDIR/authorized_keys"

    if [ ! -f "$WORKDIR/ssh_host_rsa_key" ]
    then
        echo "Generating host keys for the local sshd..."
        ssh-keygen -q -N '' -t rsa -f "$WORKDIR/ssh_host_rsa_key"
        ssh-keygen -q -N '' -t ecdsa -f "$WORKDIR/ssh_host_ecdsa_key"
        ssh-keygen -q -N '' -t ed25519 -f "$WORKDIR/ssh_host_ed25519_key"
    fi
}

# stop the sshd of this script, checking the pid still belongs to it
function stop_sshd {
  if [ -f "$SSHD_PID_FILE" ]
  then
    local pid="$(cat "$SSHD_PID_FILE")"
    if [ -n "$pid" ] && ps -p "$pid" -o args= 2>/dev/null | grep -qF "$WORKDIR/sshd_config"
    then
      kill "$pid" >/dev/null 2>&1
    fi
    rm -f "$SSHD_PID_FILE"
  fi
}

# a random port for the local sshd, start_sshd tries another one when it is taken
function pick_port {
    echo $(( LISTEN_PORT_LOW + RANDOM % (LISTEN_PORT_HIGH - LISTEN_PORT_LOW + 1) ))
}

# start the local sshd on a random port and set LISTEN_PORT. sshd exits right away when the port
# is taken, so if it is still running a second later it is listening, otherwise try another port
function start_sshd {
    local attempt pid
    SSHD_ERR_LINES=$(cat "$WORKDIR/sshd.err" 2>/dev/null | wc -l)
    for attempt in 1 2 3 4 5
    do
        LISTEN_PORT="$(pick_port)"
        "${SSHD_PATH}" -D -f "$WORKDIR/sshd_config" -p "$LISTEN_PORT" -e >> "$WORKDIR/sshd.log" 2>> "$WORKDIR/sshd.err" &
        pid=$!
        echo $pid > "$SSHD_PID_FILE"
        sleep 1
        if kill -0 $pid 2>/dev/null
        then
            return 0
        fi
        rm -f "$SSHD_PID_FILE"
    done
    echo "Could not start sshd, see $WORKDIR/sshd.err"
    return 1
}
