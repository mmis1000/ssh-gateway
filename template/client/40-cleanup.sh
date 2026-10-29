function close_master {
  ssh -N -O exit "${SSH_OPTS[@]}" "${MUX_OPTS[@]}" $TARGET_USER@$TARGET_HOST >/dev/null 2>&1
  rm -f "$CONTROL_SOCK" >/dev/null 2>&1
}

# close the tunnel and stop the local sshd, also left overs of a run that was killed with -9
function stop_tunnel {
  close_master
  stop_sshd
}

# the EXIT trap, see main
function finish {
  trap - INT TERM HUP QUIT
  stop_tunnel
  # only processes started by this script, never the whole process group,
  # which includes the parent when run.sh is started from another script
  local jobs="$(jobs -p)"
  [ -n "$jobs" ] && kill $jobs >/dev/null 2>&1
  release_lock
  echo Exited!
  exit
}

# a script killed with -9 can not run its traps, a watchdog cleans up for it then
function script_alive {
  # a killed script stays a zombie until its parent reaps it, kill -0 still succeeds on those
  kill -0 $$ >/dev/null 2>&1 && ! ps -o stat= -p $$ 2>/dev/null | grep -q Z
}
function watch_script {
  # the terminal may close together with the script, the hangup must not stop the watchdog,
  # on a plain hangup the script cleans up itself and stops the watchdog
  trap '' HUP
  while script_alive
  do
    sleep 2
  done
  stop_tunnel
  release_lock
}
