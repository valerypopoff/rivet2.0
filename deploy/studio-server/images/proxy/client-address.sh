#!/bin/sh

# Deployment-owned forwarding peers, never browser-editable bypass clients.
# Nginx validates actual address/prefix semantics when loading this include.
write_client_address_include() {
  output_file="$1"
  mkdir -p "$(dirname "$output_file")"
  peer_directives=''
  peer_ranges=''
  for peer in $(printf '%s' "${RIVET_TRUSTED_FORWARDING_PROXIES:-}" | tr ',' ' '); do
    case "$peer" in
      ''|*[!0-9a-fA-F:./]*)
        >&2 printf 'Invalid trusted forwarding proxy IP/network: %s\n' "$peer"
        return 1 ;;
    esac
    case "$peer" in
      */*)
        case "${peer##*/}" in
          *[1-9]*) ;;
          *) >&2 printf 'Universal forwarding proxy networks are forbidden: %s\n' "$peer"; return 1 ;;
        esac ;;
    esac
    peer_directives="${peer_directives}set_real_ip_from ${peer};
"
    peer_ranges="${peer_ranges}${peer} 1;
"
  done
  cat > "$output_file" <<EOF
real_ip_header X-Forwarded-For;
real_ip_recursive on;
${peer_directives}
geo \$remote_addr \$rivet_resolved_forwarding_peer {
    default 0;
    ${peer_ranges}
}
# An all-trusted chain can rewrite the address to another forwarding peer.
# Only a resolved non-forwarder is an end client. Direct untrusted peers
# retain their transport address because real-IP ignores their headers.
map \$rivet_resolved_forwarding_peer \$rivet_client_ip {
    default "";
    0 \$remote_addr;
}
EOF
}
