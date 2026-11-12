# The shell of NEXUS Terminal (usr/lib/nexus/nexus-terminal-shell). What it adds to a bare zsh: a history shared
# between tabs, suggestions from it while typing (→ accepts), colours for the command being written, completion with
# a menu, Ctrl+R to search the history, and NEXUS's prompt. The person's ~/.zshrc is read near the end and wins.

# ---- history: long, shared between the tabs, without repeats
[ -d "$HOME/.cache/nexus" ] || mkdir -p "$HOME/.cache/nexus"
HISTFILE="$HOME/.zsh_history"
HISTSIZE=50000
SAVEHIST=50000
setopt share_history hist_ignore_all_dups hist_ignore_space hist_reduce_blanks hist_verify
setopt auto_cd interactive_comments no_beep prompt_subst auto_pushd pushd_ignore_dups
# the first time: what was typed in bash is not lost (suggestions work from day one)
if [ ! -s "$HISTFILE" ] && [ -r "$HOME/.bash_history" ]; then
  grep -v '^#' "$HOME/.bash_history" 2>/dev/null | tail -n 5000 >"$HISTFILE" && fc -R "$HISTFILE"
fi

# ---- keys: the usual ones of a desktop (Home, End, Delete, Ctrl+arrows by words; ↑ ↓ search what starts the same)
bindkey -e
autoload -U up-line-or-beginning-search down-line-or-beginning-search
zle -N up-line-or-beginning-search
zle -N down-line-or-beginning-search
for k in '^[[A' '^[OA'; do bindkey "$k" up-line-or-beginning-search; done
for k in '^[[B' '^[OB'; do bindkey "$k" down-line-or-beginning-search; done
for k in '^[[H' '^[OH' '^[[1~'; do bindkey "$k" beginning-of-line; done
for k in '^[[F' '^[OF' '^[[4~'; do bindkey "$k" end-of-line; done
bindkey '^[[3~' delete-char
bindkey '^[[1;5C' forward-word
bindkey '^[[1;5D' backward-word
bindkey '^[[3;5~' kill-word
bindkey '^[[Z' reverse-menu-complete
WORDCHARS='*?_-.[]~=&;!#$%^(){}<>'

# ---- completion: a menu to move in with the arrows, upper and lower case alike
autoload -Uz compinit
compinit -d "$HOME/.cache/nexus/zcompdump"
zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}' 'r:|[._-]=* r:|=*'
zstyle ':completion:*' list-colors 'di=38;5;111' 'ln=38;5;80' 'ex=38;5;114'
zstyle ':completion:*:descriptions' format '%F{245}%d%f'
zstyle ':completion:*' group-name ''

# ---- colours and short names, as in bash
alias ls='ls --color=auto' ll='ls -lh --color=auto' la='ls -lAh --color=auto' grep='grep --color=auto' diff='diff --color=auto'
export LESS="${LESS:--FRX}"

# ---- the prompt: ◆ folder branch ❯ (the ❯ goes red when the last command failed)
autoload -Uz vcs_info
zstyle ':vcs_info:*' enable git
zstyle ':vcs_info:git:*' check-for-changes true
zstyle ':vcs_info:git:*' unstagedstr '*'
zstyle ':vcs_info:git:*' stagedstr '+'
zstyle ':vcs_info:git:*' formats ' %F{#3ddc97}%b%u%c%f'
zstyle ':vcs_info:git:*' actionformats ' %F{#3ddc97}%b%u%c%f %F{#ffb84d}%a%f'
__nexus_precmd() { vcs_info; }
autoload -Uz add-zsh-hook
add-zsh-hook precmd __nexus_precmd
__nexus_accent="${NEXUS_T_ACCENT:-#7c6cff}"
PROMPT='%F{$__nexus_accent}◆%f %~${vcs_info_msg_0_} %(?.%F{$__nexus_accent}.%F{#ff5c7a})❯%f '

# ---- Ctrl+R: search the history in a list (fzf)
if [ -r /usr/share/doc/fzf/examples/key-bindings.zsh ]; then
  source /usr/share/doc/fzf/examples/key-bindings.zsh
  export FZF_DEFAULT_OPTS="${FZF_DEFAULT_OPTS:---height=40% --layout=reverse --border=rounded --info=inline --color=pointer:${__nexus_accent},hl:${__nexus_accent},hl+:${__nexus_accent},prompt:${__nexus_accent}}"
fi

# ---- suggestions from the history while typing (Ajustes → Terminal turns them off); → or End accepts
if [ "$NEXUS_TERM_SUGGEST" != false ] && [ -r /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh ]; then
  ZSH_AUTOSUGGEST_STRATEGY=(history completion)
  ZSH_AUTOSUGGEST_BUFFER_MAX_SIZE=120
  ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE="fg=${NEXUS_T_DIM:-#7d859f}"
  source /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh
fi

# ---- the person's own settings
[ -r "$HOME/.zshrc" ] && source "$HOME/.zshrc"

# ---- colours for the command being written: green when it exists, red when it does not (must be loaded last)
if [ -r /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh ]; then
  source /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
  ZSH_HIGHLIGHT_STYLES[command]='fg=#3ddc97'
  ZSH_HIGHLIGHT_STYLES[builtin]='fg=#3ddc97'
  ZSH_HIGHLIGHT_STYLES[alias]='fg=#3ddc97'
  ZSH_HIGHLIGHT_STYLES[function]='fg=#3ddc97'
  ZSH_HIGHLIGHT_STYLES[unknown-token]='fg=#ff5c7a'
  ZSH_HIGHLIGHT_STYLES[path]='underline'
fi

# ---- the greeting, once per window
[ -x /usr/bin/nexus-terminal-welcome ] && /usr/bin/nexus-terminal-welcome
