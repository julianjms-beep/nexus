# NEXUS Terminal starts zsh with this folder as ZDOTDIR (usr/lib/nexus/nexus-terminal-shell), so zsh would not look
# at the person's own files: read theirs here.
[ -r "$HOME/.zshenv" ] && source "$HOME/.zshenv"
