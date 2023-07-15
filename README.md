# SSH Gateway

a proxy to create reverse tunnel, port forward, authentication and domain in one command

~~basically a ngrok clone~~

## Supports

1. mac: yes
2. linux: yes
3. windows: use wsl instead

## Setup

1. Forward a whole domain or sub domain and its sub domain to your app
2. Properly config the config.json
3. Generate the `ssh_host_rsa_key` and `ssh_host_rsa_key.pub` properly
4. Generate the `ssh_host_ecdsa_key` and `ssh_host_ecdsa_key.pub` properly
5. Generate the `ssh_host_ed25519_key` and `ssh_host_ed25519_key.pub` properly
6. Start the server

## Usage

    curl https://<your domain>/setup > run.sh
    chmod 755 run.sh
    ./run.sh

And then... *Magics*  
It create everything required to enable port forwarding and authentication for you
