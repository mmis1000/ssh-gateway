#! /bin/bash
#
# Opens a tunnel from *TARGET_HOST* to this computer, see --help for the options.
#
# The gateway joins this script from the parts in template/client/, each part after this one
# starts with a "# =====" line naming it. Only main, in the last part, runs anything, the other
# parts define functions and constants, so start reading at main.
#
#   00-header.sh       the values made for this user
#   10-options.sh      --help and the command line options
#   20-paths-lock.sh   the work directory, the lock against a second copy, the ssh options
#   30-sshd.sh         the keys, and the local sshd the gateway reads a shared folder through
#   40-cleanup.sh      closing the tunnel on exit, also when this script is killed
#   50-prompts.sh      the questions, and the answers saved for the next run
#   60-tunnel.sh       connecting to the gateway and staying connected
#   90-main.sh         main

# the local sshd listens on a random port in this range
LISTEN_PORT_LOW=*LISTEN_PORT_LOW*
LISTEN_PORT_HIGH=*LISTEN_PORT_HIGH*

export TARGET_PORT="*TARGET_PORT*"
export TARGET_USER="*TARGET_USER*"
export TARGET_HOST="*TARGET_HOST*"

export CLIENT_PRIVATE_KEY="*CLIENT_PRIVATE_KEY*"
export CLIENT_SERVER_KEY="*CLIENT_SERVER_KEY*"
# host keys of the gateway, so nobody else can pretend to be it
export KNOWN_HOSTS="*KNOWN_HOSTS*"
