function usage {
    cat <<USAGE
Usage: $(basename "$0") [options]

Opens a tunnel from $TARGET_HOST to this computer. Without options it asks what to share
and whether visitors need a password, or offers to use the answers from last time.

  -p, --port PORT   share the web server on local PORT
  -d, --dir DIR     share the directory DIR as a static site
  -l, --list        with --dir, always show the file list of folders, also when they have
                    an index.html, which is shown instead otherwise
      --dotfiles    with --dir, also share names starting with a dot, like .git and .env,
                    which are hidden and refused otherwise
  -a, --auth USER:PASSWORD
                    ask visitors for this user name and password. Other users of this
                    computer can see options in ps, set GATEWAY_AUTH=USER:PASSWORD instead
                    to keep it from them
  -r, --last        share what the previous run shared, with the same settings, without
                    asking. --auth and GATEWAY_AUTH replace its password
  -y, --yes         accept the notice below without asking
      --update      get the current version of this script from the gateway and save it
                    next to this one, with .new added to the name, to compare and replace
                    it yourself. Works while the tunnel is up, takes no other options
  -h, --help        show this help and exit

Without a terminal (cron, services) --last, or --yes and one of --port or --dir, are required.
USAGE
}

# the user name can not contain a colon, the password can, neither can be empty
function valid_auth {
    [[ "$1" =~ ^[^:[:cntrl:]]+:[^[:cntrl:]]+$ ]]
}

# sets FORWARD_PORT, STATIC_DIRECTORY, PUBLIC_AUTH, SHOW_LIST, SHARE_DOTFILES, USE_LAST,
# ASSUME_YES and UPDATE from the options, exits on a wrong one
function parse_options {
    local option_count=$#
    FORWARD_PORT=""
    STATIC_DIRECTORY=""
    PUBLIC_AUTH="${GATEWAY_AUTH:-}"
    SHOW_LIST=0
    SHARE_DOTFILES=0
    USE_LAST=0
    ASSUME_YES=0
    UPDATE=0
    while [ $# -gt 0 ]
    do
        case "$1" in
            -h|--help) usage; exit 0;;
            -y|--yes) ASSUME_YES=1;;
            -p|--port)
                [ $# -ge 2 ] || { echo "$1 needs a port, see --help" >&2; exit 2; }
                FORWARD_PORT="$2"; shift;;
            -d|--dir)
                [ $# -ge 2 ] || { echo "$1 needs a directory, see --help" >&2; exit 2; }
                STATIC_DIRECTORY="$2"; shift;;
            -l|--list) SHOW_LIST=1;;
            --dotfiles) SHARE_DOTFILES=1;;
            -r|--last) USE_LAST=1;;
            --update) UPDATE=1;;
            -a|--auth)
                [ $# -ge 2 ] || { echo "$1 needs USER:PASSWORD, see --help" >&2; exit 2; }
                PUBLIC_AUTH="$2"; shift;;
            *) echo "Unknown option $1, see --help" >&2; exit 2;;
        esac
        shift
    done
    if [ $UPDATE == 1 ] && [ $option_count != 1 ]
    then
        echo "--update only gets the new version of this script, it takes no other options" >&2
        exit 2
    fi
    # GATEWAY_AUTH may still be set, it does not matter for an update
    [ $UPDATE == 1 ] && return
    if [ -n "$FORWARD_PORT" ] && [ -n "$STATIC_DIRECTORY" ]
    then
        echo "Use either --port or --dir, not both" >&2
        exit 2
    fi
    if [ $USE_LAST == 1 ] && [ -n "$FORWARD_PORT$STATIC_DIRECTORY" ]
    then
        echo "--last shares what the previous run shared, it can not be used with --port or --dir" >&2
        exit 2
    fi
    if [ -n "$PUBLIC_AUTH" ] && ! valid_auth "$PUBLIC_AUTH"
    then
        echo "--auth needs USER:PASSWORD, the user name without a colon" >&2
        exit 2
    fi
}
