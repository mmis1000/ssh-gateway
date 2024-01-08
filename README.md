# SSH Gateway

A proxy to create reverse tunnel, port forward, authentication and domain in one command

~~basically a ngrok clone~~

Besides port forward, this also supports serving a static directory through a HTTP domain (powered by sftp),
essentially a static HTTP server without a HTTP server.

All without a dedicated client on your computer (only a script that uses `openssh-server` and `ssh`).

## Supports

1. mac: yes
2. Linux: yes
3. Windows: use WSL instead (I don't know how to write a proper PowerShell or cmd file)

## Setup

1. Forward a whole domain or subdomain and its subdomain to your app
2. Properly config the config.json
3. Generate the `ssh_host_rsa_key` and `ssh_host_rsa_key.pub` properly
4. Generate the `ssh_host_ecdsa_key` and `ssh_host_ecdsa_key.pub` properly
5. Generate the `ssh_host_ed25519_key` and `ssh_host_ed25519_key.pub` properly

    ```sh
    ssh-keygen -q -N "" -t rsa -b 4096 -f ./ssh_host_rsa_key
    ssh-keygen -q -N "" -t ecdsa -f ./ssh_host_ecdsa_key
    ssh-keygen -q -N "" -t ed25519 -f ./ssh_host_ed25519_key
    ```

6. Start the server

## Usage

```sh
curl -X POST https://<your domain>/setup > run.sh
chmod 755 run.sh
./run.sh
```

And then... *Magic*  
It created everything required to enable port forwarding and authentication for you
