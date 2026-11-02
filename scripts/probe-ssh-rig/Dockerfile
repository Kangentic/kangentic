# The sshd host the #913 Phase 0 probes connect to. Not shipped and not used by CI.
#
#   docker build -t kangentic-ssh-rig scripts/probe-ssh-rig
#   docker run -d --name kangentic-ssh-rig --cap-add NET_ADMIN -p 127.0.0.1:2222:22 \
#     -e AUTHORIZED_KEY="<public key>" kangentic-ssh-rig
#
# The key and the known_hosts file stay in a scratch folder, so nothing here touches a
# developer's own ssh config. `--cap-add NET_ADMIN` lets `tc netem` shape eth0.
FROM ubuntu:24.04

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    openssh-server iproute2 procps ca-certificates curl xz-utils python3 tmux \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash dev \
  && mkdir -p /run/sshd /home/dev/.ssh \
  && chmod 700 /home/dev/.ssh \
  && chown -R dev:dev /home/dev/.ssh

COPY rig-entry.sh /usr/local/bin/rig-entry.sh
RUN chmod +x /usr/local/bin/rig-entry.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/rig-entry.sh"]
