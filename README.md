# SSH Gateway

A proxy to create reverse tunnel, port forward, authentication and domain in one command

~~basically a ngrok clone~~

Besides port forward, this also supports serving a static directory through a http domain (powered by sftp),
essentially a static http server without http server.

All without a dedicated client on your computer (only a script that use `openssh-server` and `ssh`).

## Supports

1. mac: yes
2. linux: yes
3. windows: use wsl instead (I don't know how to write a proper powershell or cmd file)

## Setup

1. Forward a whole domain or sub domain and its sub domain to your app
2. Properly config the config.json
3. Generate the `ssh_host_rsa_key` and `ssh_host_rsa_key.pub` properly
4. Generate the `ssh_host_ecdsa_key` and `ssh_host_ecdsa_key.pub` properly
5. Generate the `ssh_host_ed25519_key` and `ssh_host_ed25519_key.pub` properly
6. Start the server

## Usage

    curl -X POST https://<your domain>/setup > run.sh
    chmod 755 run.sh
    ./run.sh

And then... *Magics*  
It create everything required to enable port forwarding and authentication for you
