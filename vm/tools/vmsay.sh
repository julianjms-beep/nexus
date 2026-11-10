#!/bin/zsh
# vmsay.sh <vmdir> <wait-seconds> <line> [tail-lines]: type a line on the VM console, print the new output.
L=$(wc -c < "$1/console.log"); printf '%s\n' "$3" > "$1/console.in"; sleep "$2"
tail -c +$((L+1)) "$1/console.log" | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g; s/\x1b\][^\x07]*\x07//g' | tail -"${4:-25}"
