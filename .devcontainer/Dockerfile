FROM debian:bullseye

RUN adduser --home /home/devboy --shell /usr/bin/zsh --no-create-home devboy \
    && usermod -aG sudo devboy \
    && mkdir /home/devboy \
    && chown devboy /home/devboy \
    && chgrp devboy /home/devboy

# Had to update certificates--git https clone was failing
RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
        bash                                      \
        file                                      \
        zsh                                       \
        zip                                       \
        unzip                                     \
        less                                      \
        httpie                                    \
        curl                                      \
        cloc                                      \
        patch                                     \
        git-all                                   \
        jq                                        \
        htop                                      \
        man-db                                    \
        gnupg2                                    \
        ssh                                       \
        make                                      \
        groff                                     \
        python3                                   \
        python3-pip                               \
        python3-setuptools                        \
        # needed (temporarily) to install node-canvas from source (no ARM binary)
        # only used locally--lambda layer used by lambda function
        build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
        # need these additional to compile git
        libssl-dev libghc-zlib-dev libcurl4-gnutls-dev libexpat1-dev gettext \
        openssh-client ca-certificates \
    && update-ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Need to build recent version of git to support SSH signed commits
# Make sure you have a SSH signing key on GitHub
# Outside the container:
#     pbcopy < ~/.ssh/id_ed25519.pub
# In the container:
#    git config --global commit.gpgsign true
#    git config --global gpg.format ssh
#    git config --global user.signingkey '<PASTE from pbcopy>'
# https://mcgillij.dev/git-sign-commits-with-ssh.html says you need an
# allowedSignersFile but I didn't find it necessary.
# https://calebhearth.com/sign-git-with-ssh is also helpful.
RUN cd /tmp \
    && curl -LksS https://github.com/git/git/archive/v2.40.0.zip -o git.zip \
    && unzip git.zip \
    && cd git-2.40.0 \
    && make prefix=/usr/local all \
    && make prefix=/usr/local install \
    && cd /tmp \
    && rm -rf git-2.40.0

RUN curl -fsSL https://deb.nodesource.com/setup_16.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g aws-cdk

RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o awscliv2.zip \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf aws awscliv2.zip

RUN npm install -g aws-cdk@next

RUN /bin/sh -c "$(curl -fsSL https://raw.githubusercontent.com/turbot/steampipe/main/install.sh)"

RUN pip3 install cfn-lint

USER devboy
WORKDIR /home/devboy
RUN zsh -c "$(curl -fsSL https://raw.githubusercontent.com/robbyrussell/oh-my-zsh/master/tools/install.sh)" || true
RUN git clone --depth=1 https://github.com/romkatv/powerlevel10k.git ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/themes/powerlevel10k

RUN steampipe plugin install steampipe
RUN steampipe plugin install aws
RUN steampipe plugin install github

# Oh My ZSH installs a .zshrc. Remove so we can overwrite it when cloning dotfiles.
RUN rm ~/.zshrc

#ENV SHELL /bin/zsh    THIS IS WRONG
