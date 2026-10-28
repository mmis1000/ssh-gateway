function valid_port {
    [[ "$1" =~ ^[0-9]+$ ]] && [ "$((10#$1))" -le 65535 ]
}

# prints the absolute path of the directory $1, ~ expanded
function resolve_dir {
    local dir="${1/#\~/$HOME}"
    [ -d "$dir" ] && (cd "$dir" && pwd)
}

# questions need a terminal, a closed stdin would make them loop forever
function need_terminal {
    if [ ! -t 0 ]
    then
        echo "No terminal to ask $1, use $2 (see --help)" >&2
        exit 2
    fi
}

function ask {
    # ask <variable> <question> <default>, bash on macOS (3.2) can not prefill the answer
    if [ $machine == "Mac" ]
    then
        read -p "$2 (default: $3): " -e "$1" || exit 2
        [ -z "${!1}" ] && eval "$1=\$3"
    else
        read -p "$2: " -i "$3" -e "$1" || exit 2
    fi
}

# what the previous run shared, saved next to the keys, so only this user can read its password
ANSWERS_FILE="$WORKDIR/answers"

# sets the SAVED_ variables from ANSWERS_FILE, SAVED_PORT is empty when there is nothing saved
function load_saved_answers {
    SAVED_PORT=""
    SAVED_DIR=""
    SAVED_LIST=0
    SAVED_DOTFILES=0
    SAVED_AUTH=""
    [ -f "$ANSWERS_FILE" ] && source "$ANSWERS_FILE"
    valid_port "$SAVED_PORT" || SAVED_PORT=""
}

# as if the saved answers were given as options, so they are checked like options
function use_saved_answers {
    if [ "$((10#$SAVED_PORT))" == 0 ]
    then
        STATIC_DIRECTORY="$SAVED_DIR"
    else
        FORWARD_PORT="$SAVED_PORT"
    fi
    [ "$SAVED_LIST" == 1 ] && SHOW_LIST=1
    [ "$SAVED_DOTFILES" == 1 ] && SHARE_DOTFILES=1
    [ -z "$PUBLIC_AUTH" ] && PUBLIC_AUTH="$SAVED_AUTH"
    # the notice was accepted by the run that saved them
    ASSUME_YES=1
}

function describe_saved_answers {
    if [ "$((10#$SAVED_PORT))" == 0 ]
    then
        printf 'share folder %s' "$SAVED_DIR"
        [ "$SAVED_LIST" == 1 ] && printf ', file lists'
        [ "$SAVED_DOTFILES" == 1 ] && printf ', hidden files too'
    else
        printf 'share port %s' "$SAVED_PORT"
    fi
    if [ -n "$SAVED_AUTH" ]
    then
        printf ', visitors sign in as %s' "${SAVED_AUTH%%:*}"
    fi
}

# use the saved answers with --last, offer them when nothing to share was given
function offer_saved_answers {
    if [ $USE_LAST == 1 ]
    then
        [ -n "$SAVED_PORT" ] || { echo "No answers from an earlier run yet, run once without --last" >&2; exit 2; }
        use_saved_answers
    elif [ -z "$FORWARD_PORT$STATIC_DIRECTORY" ] && [ -n "$SAVED_PORT" ] && [ -t 0 ]
    then
        read -p "Use the answers from last time ($(describe_saved_answers))? [Y/n]: " ANSWER || exit 2
        [[ "$ANSWER" =~ ^[nN] ]] || use_saved_answers
    fi
}

function accept_notice {
    if [ $ASSUME_YES == 0 ]
    then
        need_terminal "to accept the notice" "--yes"
        echo "===EULA===
Use of this software means you ALLOW us to setup a ssh daemon and establish connection tunnel on your computer.
If you do not agree about this, please enter ^C to exit right now!
=========="
        read -p "press any key to continue..." -n 1
        echo
    fi
}

# asks for what was not given as options. Afterwards FORWARD_PORT is the port to share, or 0 and
# STATIC_DIRECTORY the absolute path of the folder to share
function choose_what_to_share {
    ASKED_WHAT_TO_SHARE=0
    if [ -n "$STATIC_DIRECTORY" ]
    then
        FORWARD_PORT=0
    elif [ -n "$FORWARD_PORT" ]
    then
        valid_port "$FORWARD_PORT" || { echo "--port needs a port number between 1 and 65535" >&2; exit 2; }
        [ "$((10#$FORWARD_PORT))" == 0 ] && { echo "Use --dir to share a directory" >&2; exit 2; }
    else
        need_terminal "what to share" "--port or --dir"
        ASKED_WHAT_TO_SHARE=1
        while true
        do
            ask FORWARD_PORT "Forward which port as the http entry (0 to use static directory instead)?" 8080
            valid_port "$FORWARD_PORT" && break
            echo "Please enter a port number between 1 and 65535, or 0."
        done
    fi
    FORWARD_PORT=$((10#$FORWARD_PORT))

    if [ "$FORWARD_PORT" != 0 ]
    then
        STATIC_DIRECTORY="null"
    elif [ -n "$STATIC_DIRECTORY" ]
    then
        RESOLVED="$(resolve_dir "$STATIC_DIRECTORY")" || { echo "$STATIC_DIRECTORY is not a directory" >&2; exit 2; }
        STATIC_DIRECTORY="$RESOLVED"
    else
        while true
        do
            ask STATIC_DIRECTORY "use which static directory?" "$(pwd)"
            RESOLVED="$(resolve_dir "$STATIC_DIRECTORY")" && break
            echo "$STATIC_DIRECTORY is not a directory."
        done
        STATIC_DIRECTORY="$RESOLVED"
        if [ $SHOW_LIST == 0 ]
        then
            read -p "Show index.html of folders that have one, instead of the file list? [Y/n]: " ANSWER || exit 2
            [[ "$ANSWER" =~ ^[nN] ]] && SHOW_LIST=1
        fi
    fi
}

# only asked together with what to share, runs with --port or --dir stay as they are
function ask_visitor_auth {
    if [ "$ASKED_WHAT_TO_SHARE" == 1 ] && [ -z "$PUBLIC_AUTH" ]
    then
        while true
        do
            read -p "Ask visitors for a user name and password? Enter the user name, empty for no: " -e AUTH_USER || exit 2
            [ -z "$AUTH_USER" ] && break
            # checked on its own, a colon in it would move part of the user name into the password
            if [[ "$AUTH_USER" == *:* ]] || ! valid_auth "$AUTH_USER:x"
            then
                echo "Try again, the user name can not contain a colon."
                continue
            fi
            read -s -p "Password for $AUTH_USER: " AUTH_PASSWORD || exit 2
            echo
            if valid_auth "$AUTH_USER:$AUTH_PASSWORD"
            then
                PUBLIC_AUTH="$AUTH_USER:$AUTH_PASSWORD"
                break
            fi
            echo "Try again, the password can not be empty."
        done
        unset AUTH_USER AUTH_PASSWORD
    fi
}

# for the next run, see ANSWERS_FILE
function save_answers {
    (
        umask 077
        {
            printf 'SAVED_PORT=%q\n' "$FORWARD_PORT"
            if [ "$FORWARD_PORT" == 0 ]
            then
                printf 'SAVED_DIR=%q\n' "$STATIC_DIRECTORY"
                printf 'SAVED_LIST=%q\n' "$SHOW_LIST"
                printf 'SAVED_DOTFILES=%q\n' "$SHARE_DOTFILES"
            fi
            if [ -n "$PUBLIC_AUTH" ]
            then
                printf 'SAVED_AUTH=%q\n' "$PUBLIC_AUTH"
            fi
        } > "$ANSWERS_FILE.tmp"
    ) && mv "$ANSWERS_FILE.tmp" "$ANSWERS_FILE"
}
