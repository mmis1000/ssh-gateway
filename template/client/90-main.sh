function main {
    parse_options "$@"
    detect_system
    prepare_workdir
    if [ $UPDATE == 1 ]
    then
        update_script
        exit
    fi

    take_lock
    trim_logs
    write_known_hosts
    find_ssh_programs

    stop_tunnel
    # ctrl+c, ctrl+\, closing the terminal and kill all end up in finish
    trap "exit" INT TERM HUP QUIT
    trap finish EXIT
    watch_script &

    load_saved_answers
    offer_saved_answers
    accept_notice
    choose_what_to_share
    ask_visitor_auth
    save_answers

    cd "$WORKDIR" || exit 1
    write_client_key
    write_sshd_files
    if [ "$FORWARD_PORT" == 0 ]
    then
        start_sshd || exit 1
        TUNNEL_PORT=$LISTEN_PORT
    else
        TUNNEL_PORT=$FORWARD_PORT
    fi

    open_tunnel
    stay_connected
}

# on one line, so bash has read the whole script before main starts
main "$@"; exit
